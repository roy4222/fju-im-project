import 'server-only'
import { cache } from 'react'
import { shellViewer } from '@/app/_ui/guard'
import { daysLeft } from '@/app/dashboard/student/_todo/due-text'
import { signoffStateLabel } from '@/app/dashboard/_signoff/state-label'
import type { StudentSignoffView, VersionDetail } from '@/application/signoff'
import type { MyItemRow } from '@/application/submissions'
import { getBusinessClock } from '@/composition/cohorts'
import { getSignoffQuery, PURPOSE_LABEL, VOTE_RESULT_LABEL } from '@/composition/signoff'
import { getSubmissionQuery, phaseOf, receiverStatus } from '@/composition/submissions'

/**
 * 學生待辦的唯一口徑（學生規格 §3.1，ST-1）：作業＋同意書合成一份清單。
 * 首頁待辦卡與「下一件要交的」、交作業三個篩選的數字、側欄「交作業」徽章全部從 `studentTodos` 算，不各自推。
 *
 * - 作業的狀態由既有 `receiverStatus`（名單頁、作業區同一個）決定，這裡只把它對到待辦的六種狀態。
 *   草稿是隱形的（C 階段規格① §5.2 拿掉「儲存草稿」鈕）：有草稿還沒交就是「待交」，首頁按鈕一律「去交」。
 * - 同意書只列簽核包目前那一版、而且不是失效／作廢（Q123）；`isCurrent` 只是指標，不代表有效。
 * - 三個讀取都用 React `cache`、以 `userId` 字串當 key：頁面的 actor 與徽章的 actor 是兩個物件，
 *   拿物件當 key 會各查一次。呼叫端一律傳 `actor.userId`。
 */

export type TodoStatus = 'overdue' | 'soon' | 'open' | 'notOpen' | 'exempt' | 'done'

export type StudentTodo = {
  kind: 'item' | 'consent'
  /** itemId 或 versionId。 */
  id: string
  title: string
  /** 截止日（補交期限優先）；同意書永遠 null。 */
  due: Date | null
  status: TodoStatus
  /** 膠囊字：逾期／快到期／待交／尚未開放／免繳／已交／補交／待你同意／已同意／不同意／（signoffStateLabel）。 */
  label: string
  href: string
  /** `group` → 卡片小字「整組」（Q128）；同意書是 null。 */
  unit: 'individual' | 'group' | null
  /** 系辦開的補交期限生效中、還沒交 → 膠囊「補交」、截止字「補交到 M/D」（Q128）。 */
  late: boolean
}

/** 幾天內（含）算「快到期」（Q118）。 */
export const SOON_DAYS = 10

const BASE = '/dashboard/student'

/** 已完成的兩種：已交（含同意書已表態、輪不到你）與免繳（Q119：放在「已交」篩選）。 */
const isFinished = (t: StudentTodo) => t.status === 'done' || t.status === 'exempt'

// ── 對應 ──────────────────────────────────────────────────────────────────────

const ITEM_LABEL: Readonly<Record<TodoStatus, string>> = {
  overdue: '逾期',
  soon: '快到期',
  open: '待交',
  notOpen: '尚未開放',
  exempt: '免繳',
  done: '已交',
}

/** 一份作業 → 一張待辦卡。狀態判斷的優先序跟 `statusOf` 一樣：免繳 → 尚未開放 → 已交 → 逾期 → 待交。 */
export function itemTodo(row: MyItemRow, now: Date): StudentTodo {
  const view = receiverStatus(row, row, now)
  const due = row.reopenUntil ?? row.dueAt
  // 補交期限只在「本來已截止、靠它開放」時算數（同 `receiverStatus`）。
  const reopened = phaseOf(row, now, row.reopenUntil) === 'open' && phaseOf(row, now) === 'closed'
  const status: TodoStatus = row.exempt
    ? 'exempt'
    : phaseOf(row, now, row.reopenUntil) === 'not_open'
      ? 'notOpen'
      : view.submitted
        ? 'done'
        : view.overdue
          ? 'overdue'
          : due && daysLeft(due, now) <= SOON_DAYS
            ? 'soon'
            : 'open'
  const late = reopened && (status === 'open' || status === 'soon')
  return {
    kind: 'item',
    id: row.itemId,
    title: row.title,
    due,
    status,
    label: late ? '補交' : ITEM_LABEL[status],
    href: `${BASE}/affairs/${row.itemId}`,
    unit: row.receiverUnit,
    late,
  }
}

/**
 * 同意書 → 待辦卡（Q123）。順序有意義：
 * 1. 只看簽核包目前那一版；2. 先排除失效（`superseded`）與作廢（`void`）——組員異動或系辦作廢後指標還指著它；
 * 3. 退回修正中不能表態 → 已完成；4. 輪到你 → 待你同意；表態過 → 已同意／不同意；其他（等老師、已完成、不在名單）→ 已完成。
 */
export function consentTodo(version: VersionDetail): StudentTodo | null {
  if (!version.isCurrent) return null
  if (version.state === 'superseded' || version.state === 'void') return null
  const base = {
    kind: 'consent' as const,
    id: version.versionId,
    title: PURPOSE_LABEL[version.purpose],
    due: null,
    href: `${BASE}/signoff?version=${version.versionId}`,
    unit: null,
    late: false,
  }
  const stateLabel = signoffStateLabel(version.state, { cause: version.cause })
  if (version.state === 'revision') return { ...base, status: 'done', label: stateLabel }
  if (version.viewer.canRespond) return { ...base, status: 'open', label: '待你同意' }
  const voted = version.viewer.voted
  if (voted) return { ...base, status: 'done', label: voted === 'agree' ? '已同意' : VOTE_RESULT_LABEL[voted] }
  return { ...base, status: 'done', label: stateLabel }
}

/**
 * 合成一份清單並排好（原型 `studentTodos()`）：未完成在前、依截止日近到遠，沒有截止日的同意書排在有日期的後面；
 * 已完成在後、最近送出（同意書是本人表態時間）的在前，免繳沒有送出時間排最後。
 */
export function buildTodos(rows: readonly MyItemRow[], now: Date, signoff: StudentSignoffView): readonly StudentTodo[] {
  const entries: { todo: StudentTodo; finishedAt: number }[] = []
  for (const row of rows) entries.push({ todo: itemTodo(row, now), finishedAt: row.latestReceivedAt?.getTime() ?? -Infinity })
  for (const version of signoff.versions) {
    const todo = consentTodo(version)
    if (!todo) continue
    const mine = version.progress.students.find((s) => s.userId === version.viewer.userId)
    entries.push({ todo, finishedAt: (mine?.at ?? version.createdAt).getTime() })
  }
  const byDue = (a: StudentTodo, b: StudentTodo) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity)
  const byTitle = (a: StudentTodo, b: StudentTodo) => a.title.localeCompare(b.title, 'zh-Hant')
  const open = entries.filter((e) => !isFinished(e.todo)).map((e) => e.todo)
  const finished = entries.filter((e) => isFinished(e.todo))
  return [
    ...open.sort((a, b) => byDue(a, b) || byTitle(a, b)),
    ...finished.sort((a, b) => b.finishedAt - a.finishedAt || byTitle(a.todo, b.todo)).map((e) => e.todo),
  ]
}

// ── 讀取（每個請求只查一次）──────────────────────────────────────────────────

/** 本人的作業列與業務鐘的現在（組別里程碑、`/timeline` 也讀這一份）。 */
export const studentItems = cache(async (userId: string) =>
  Promise.all([getSubmissionQuery().myItems(userId), getBusinessClock().now()]),
)

/**
 * 本人組別的同意書（同意書頁也讀這一份）。只讀：授權已在頁面做過，這裡用 `shellViewer()` 拿 `ResolvedActor`。
 * `userId` 是快取 key；跟這次請求的身分對不上（沒登入、換了人）就當沒有同意書，不拿別人的身分去查。
 */
export const studentSignoff = cache(async (userId: string): Promise<StudentSignoffView> => {
  const viewer = await shellViewer()
  if (viewer.kind !== 'authenticated' || viewer.userId !== userId) return { groupCode: null, versions: [] }
  return getSignoffQuery().studentView(viewer)
})

export const studentTodos = cache(async (userId: string): Promise<readonly StudentTodo[]> => {
  const [[rows, now], signoff] = await Promise.all([studentItems(userId), studentSignoff(userId)])
  return buildTodos(rows, now, signoff)
})

// ── 由清單算出來的數字 ────────────────────────────────────────────────────────

/** 交作業三個篩選的數字：待交＝待交＋快到期＋尚未開放（Q119）；已交＝已交＋免繳；逾期。 */
export function todoCounts(todos: readonly StudentTodo[]): { open: number; done: number; overdue: number } {
  const count = (statuses: readonly TodoStatus[]) => todos.filter((t) => statuses.includes(t.status)).length
  return { open: count(['open', 'soon', 'notOpen']), done: count(['done', 'exempt']), overdue: count(['overdue']) }
}

/** 側欄「交作業」徽章：待交＋快到期＋待你同意；**不含**逾期（Q117）與尚未開放（Q119）。 */
export function studentOpenCount(todos: readonly StudentTodo[]): number {
  return todos.filter((t) => t.status === 'open' || t.status === 'soon').length
}

/** 首頁「下一件要交的」：清單裡第一件有截止日、還要處理（待交、快到期、逾期）的。 */
export function nextDue(todos: readonly StudentTodo[]): StudentTodo | null {
  return todos.find((t) => t.due !== null && (t.status === 'open' || t.status === 'soon' || t.status === 'overdue')) ?? null
}

/** 首頁待辦卡：未完成的在前，不足 `limit` 張用最近已完成的補滿（Q124）。清單本來就是這個順序。 */
export function homeTodos(todos: readonly StudentTodo[], limit = 5): readonly StudentTodo[] {
  return todos.slice(0, limit)
}
