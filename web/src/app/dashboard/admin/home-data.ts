import type { AccountSummary, ResolvedActor } from '@/application/accounts'
import type { GradingQuery, PendingReview } from '@/application/grading'
import type { GroupQuery } from '@/application/groups'
import type { ItemListRow, ItemQuery } from '@/application/items'
import type { LastReminded, ReminderQuery } from '@/application/reminders'
import type { SignoffPurpose, SignoffQuery } from '@/application/signoff'
import type { Completion, RosterQuery } from '@/application/submissions'
import type { StageContext } from '@/app/dashboard/_stage'
import type { Tone } from '@/app/_ui/dashboard/cards'
import { remainingCount, teacherProgress, type TeacherProgress } from '@/app/dashboard/admin/grading/progress'
import { loadAdminSummary } from '@/app/_ui/workload'
import { getGradingQuery } from '@/composition/grading'
import { getGroupQuery } from '@/composition/groups'
import { getItemQuery } from '@/composition/items'
import { describeCooldown, getReminderQuery } from '@/composition/reminders'
import { getSignoffQuery, SIGNOFF_PURPOSES } from '@/composition/signoff'
import { completionOf, getRosterQuery, overdueReceiverIds } from '@/composition/submissions'

const BASE = '/dashboard/admin'
/** 首頁的完成率列表最多列幾份作業；更多的到「專題事務」看。逾期卡不受這個限制（掃全部發布中的作業）。 */
export const INTAKE_LIMIT = 6
/** 「我發的公告」列幾則。 */
export const NEWS_LIMIT = 3
const DAY_MS = 86_400_000

/**
 * 系辦首頁讀資料用的 port（AD-02；AC-AD-04 用假物件計數）。
 *
 * 只有這六個：主機儲存（`storageTile`）只在開發者後台看，型別上就沒有，首頁不可能呼叫它。
 * - 待審帳號數與最早送出時間：讀共用 SH-P2 的 `loadAdminSummary(actor.userId)`，跟側欄徽章同一次請求共用，不多讀一次（AD-13）。讀不到是 null。
 * - 成績更正待復核：讀 `grading.pendingReviews`（1 句），不再讀整張成績表（AD-21）。
 * - 分組：首頁只要計數，讀 `groups.homeCounts`（1 句，口徑同 `overview()`；AD-21），不讀整份總覽。
 * - 同意書：只要「等老師」與「已完成」的數字，讀 `signoff.homeCounts`（1 句，口徑同 `adminBoard`；AD-21）。
 * - 完成率與逾期：一次讀完全屆發布中作業的名單事實（`completionFacts()`，AD-19／AD-13），不再逐份讀 `roster()`；型別上只拿得到它。
 * - 催繳冷卻（C1-15、AC-34）：評分卡讀一次 `lastReminded('grading', 屆別)`；逾期卡**每份有人逾期的作業**各讀一次
 *   `lastReminded('item', 作業)`（1 句／份），判斷是不是全部在 24 小時冷卻內。沒有逾期的作業不讀。
 */
export type AdminHomePorts = {
  readonly accounts: { readonly summary: (userId: string) => Promise<AccountSummary | null> }
  readonly groups: Pick<GroupQuery, 'homeCounts'>
  readonly grading: Pick<GradingQuery, 'adminBoard' | 'pendingReviews'>
  readonly signoff: Pick<SignoffQuery, 'homeCounts'>
  readonly items: Pick<ItemQuery, 'list'>
  readonly roster: Pick<RosterQuery, 'completionFacts'>
  readonly reminders: Pick<ReminderQuery, 'lastReminded'>
}

export function adminHomePorts(): AdminHomePorts {
  return {
    accounts: { summary: loadAdminSummary },
    groups: getGroupQuery(),
    grading: getGradingQuery(),
    signoff: getSignoffQuery(),
    items: getItemQuery(),
    roster: getRosterQuery(),
    reminders: getReminderQuery(),
  }
}

export type IntakeRow = { readonly id: string; readonly title: string; readonly unit: '人' | '組'; readonly completion: Completion }

export type AdminHome = {
  /** null＝讀不到帳號統計。 */
  readonly summary: AccountSummary | null
  /** 最早一筆待審申請送出到現在（業務時間）幾整天；沒有待審或讀不到是 null。 */
  readonly oldestPendingDays: number | null
  readonly groups: {
    readonly total: number
    readonly students: number
    readonly ungrouped: number
    readonly industry: number
    readonly noAdvisorIndustry: number
    readonly openProposals: number
  }
  /** 發布中的作業數（逾期卡的母數）。 */
  readonly published: number
  /** 完成率列表：前 INTAKE_LIMIT 份。 */
  readonly intake: readonly IntakeRow[]
  readonly overdue: {
    /** 全部發布中作業上「截止了還沒正式送出」的收件者（人或組），同一位只算一次。 */
    readonly total: number
    readonly people: number
    readonly groups: number
  }
  /** 老師評分進度：全部階段、排除解散組（AC-AD-03，與成績頁同一個 `teacherProgress`）。 */
  readonly teachers: readonly TeacherProgress[]
  /** 評分還差幾份＝Σ（分母 − 分子）。 */
  readonly remaining: number
  readonly signoff: {
    /** 停在「等指導老師」的同意書份數（每組每個用途一份）。 */
    readonly waiting: number
    readonly complete: number
    /** 等老師最多的用途；沒有就是 null。 */
    readonly purpose: SignoffPurpose | null
  }
  readonly pendingReviews: readonly Pick<PendingReview, 'groupId' | 'groupCode'>[]
  readonly newsCount: number
  readonly news: readonly ItemListRow[]
  /** 催繳紀錄（C1-15）：逾期卡是每份有人逾期的作業各一筆（順序同作業清單），評分卡是本屆一筆；沒有屆別是空的。 */
  readonly reminded: { readonly overdue: readonly LastReminded[]; readonly grading: LastReminded | null }
  /** 屆別已封存：不能催繳。 */
  readonly archived: boolean
}

/**
 * 系辦首頁的全部資料。每個 port 呼叫一次、不隨作業數增加（AC-AD-04），讀取全部是管理員才讀得到的查詢
 * （頁面守門，用例與查詢自己再判一次）。沒有屆別時只讀帳號統計，其餘是 0 或空的。
 */
export async function loadAdminHome(
  ports: AdminHomePorts,
  actor: Extract<ResolvedActor, { kind: 'authenticated' }>,
  ctx: Pick<StageContext, 'cohort' | 'businessNow'>,
): Promise<AdminHome> {
  const cohortId = ctx.cohort?.id ?? null
  const [summary, groupCounts, gradingResult, signoffResult, items, reviewsResult, rosters, gradingReminded] = await Promise.all([
    ports.accounts.summary(actor.userId),
    cohortId ? ports.groups.homeCounts(cohortId) : Promise.resolve(null),
    cohortId ? ports.grading.adminBoard(actor, cohortId) : Promise.resolve(null),
    cohortId ? ports.signoff.homeCounts(actor, cohortId) : Promise.resolve(null),
    cohortId ? ports.items.list(cohortId) : Promise.resolve([]),
    // 只拿「待復核的更正」做首頁提示（N-61）；成績表本身在「成績」頁。
    cohortId ? ports.grading.pendingReviews(actor, cohortId) : Promise.resolve(null),
    // 發布中的作業全部讀名單事實：逾期卡要看全部（Codex P2：只掃前 6 份會漏算），完成率列表只列前 INTAKE_LIMIT 份。
    // 一次讀完（固定 2 句 SQL），順序同作業清單；算法照舊用名單頁同一個 `completionOf`／`overdueReceiverIds`（分母不含免填與移出）。
    cohortId ? ports.roster.completionFacts(actor, cohortId) : Promise.resolve([]),
    cohortId ? ports.reminders.lastReminded(actor, 'grading', cohortId) : Promise.resolve(null),
  ])
  // 逾期卡的冷卻：有人逾期的作業各查一次上次催繳（口徑同逾期卡的 `overdueReceiverIds`）。讀不到當作沒催過，按鈕照樣可按，冷卻由用例再判。
  const overdueItems = rosters.filter((r) => overdueReceiverIds([r], ctx.businessNow).size > 0)
  const overdueReminded = await Promise.all(overdueItems.map((r) => ports.reminders.lastReminded(actor, 'item', r.item.itemId)))
  const allIntake: IntakeRow[] = rosters.map((r) => ({
    id: r.item.itemId,
    title: r.item.title,
    unit: r.item.receiverUnit === 'individual' ? '人' : '組',
    completion: completionOf(r.item, r.entries, ctx.businessNow),
  }))
  const overdueTotal = overdueReceiverIds(rosters, ctx.businessNow).size
  const overduePeople = overdueReceiverIds(
    rosters.filter((r) => r.item.receiverUnit === 'individual'),
    ctx.businessNow,
  ).size

  const grading = gradingResult?.ok ? gradingResult.receipt : null

  const sign = signoffResult?.ok ? signoffResult.receipt : null
  const waitingBy = SIGNOFF_PURPOSES.map((p) => ({ purpose: p, n: sign?.teacherPending[p] ?? 0 }))
  const waiting = waitingBy.reduce((a, w) => a + w.n, 0)
  const mostWaiting = [...waitingBy].sort((a, b) => b.n - a.n)[0]

  const news = items.filter((i) => i.placement === 'news')

  const oldest = summary && summary.pendingApplications > 0 ? summary.oldestPendingAppliedAt : null

  return {
    summary,
    oldestPendingDays: oldest ? Math.max(0, Math.floor((ctx.businessNow.getTime() - oldest.getTime()) / DAY_MS)) : null,
    groups: groupCounts ?? { total: 0, students: 0, ungrouped: 0, industry: 0, noAdvisorIndustry: 0, openProposals: 0 },
    published: allIntake.length,
    intake: allIntake.slice(0, INTAKE_LIMIT),
    overdue: {
      total: overdueTotal,
      people: overduePeople,
      groups: overdueTotal - overduePeople,
    },
    teachers: grading ? teacherProgress(grading, { excludeDissolved: true }) : [],
    remaining: grading ? remainingCount(grading) : 0,
    signoff: {
      waiting,
      complete: sign?.completeGroups ?? 0,
      purpose: mostWaiting && mostWaiting.n > 0 ? mostWaiting.purpose : null,
    },
    pendingReviews: reviewsResult?.ok ? [...reviewsResult.receipt] : [],
    newsCount: news.length,
    news: news.slice(0, NEWS_LIMIT),
    reminded: {
      overdue: overdueReminded.map(remindedOf),
      grading: gradingReminded ? remindedOf(gradingReminded) : null,
    },
    archived: ctx.cohort?.status === 'archived',
  }
}

const NEVER: LastReminded = { at: null, nextAllowedAt: null }

function remindedOf(result: Awaited<ReturnType<ReminderQuery['lastReminded']>>): LastReminded {
  return result.ok ? { at: result.receipt.at, nextAllowedAt: result.receipt.nextAllowedAt } : NEVER
}

/** 待辦卡上的「催繳」鈕；`blocked` 是停用時寫在旁邊的原因（冷卻中），可以按是 null。 */
export type RemindButtonState = { readonly blocked: string | null }

/**
 * 逾期卡與評分卡的「催繳」鈕（C 階段規格① §8、AC-34）。沒有要催的（逾期 0、評分送齊）或屆別封存就不放鈕，卡片照舊。
 * - 逾期卡：有人逾期的作業**全部**在 24 小時冷卻內才停用，寫最早能再催的那份「上次催繳 N 小時前，{時間} 後可再催」；
 *   有一份能催就能按（被冷卻的那幾份由用例略過，toast 會說）。
 * - 評分卡：本屆 24 小時內催過就停用。
 * `now` 是真實時間（冷卻照真實時間算，同用例）。
 */
export function remindButtons(home: AdminHome, now: Date): { overdue: RemindButtonState | null; grading: RemindButtonState | null } {
  if (home.archived) return { overdue: null, grading: null }
  const cooling = (r: LastReminded): r is { at: Date; nextAllowedAt: Date } =>
    r.at !== null && r.nextAllowedAt !== null && r.nextAllowedAt.getTime() > now.getTime()
  const items = home.reminded.overdue
  let overdue: RemindButtonState | null = null
  if (home.overdue.total > 0) {
    const first = items.every(cooling) && items.length > 0 ? [...items].sort((a, b) => a.nextAllowedAt!.getTime() - b.nextAllowedAt!.getTime())[0] : null
    overdue = { blocked: first ? describeCooldown(first.at!, first.nextAllowedAt!, now) : null }
  }
  const g = home.reminded.grading
  const grading = home.remaining > 0 ? { blocked: g && cooling(g) ? describeCooldown(g.at, g.nextAllowedAt, now) : null } : null
  return { overdue, grading }
}

/** 橫幅第二行：只講本屆分組，不再有「今天 N 件待處理」（AC-AD-01）。沒有屆別時是空的（橫幅自己叫人去設屆別）。 */
export function heroLine(home: AdminHome, hasCohort: boolean): string {
  if (!hasCohort) return ''
  return `本屆 ${home.groups.total} 組、${home.groups.students} 位學生已分組、${home.groups.ungrouped} 位未分組。`
}

export type TodoCardKind = 'accounts' | 'overdue' | 'grading' | 'signoff'

export type AdminTodoCard = {
  readonly kind: TodoCardKind
  readonly tone: Tone
  readonly title: string
  readonly meta?: string
  readonly href: string
  readonly pill?: { readonly tone: Tone; readonly label: string }
}

const NONE = { tone: 'done', label: '沒有待辦' } as const
const OPEN = (tone: Tone) => ({ tone, label: '待處理' })

function pendingMeta(pending: number, oldestDays: number | null): string | undefined {
  if (pending === 0 || oldestDays === null) return undefined
  return `${pending} 位待審・${oldestDays === 0 ? '今天送出' : `最早 ${oldestDays} 天前送出`}`
}

/**
 * 「待辦」區的四張卡（AC-AD-01、02；設計方案 §3.1）。數字是 0 也照樣有這張卡，膠囊寫「沒有待辦」；不算「今天 N 件」總數。
 * 顏色照共用 SH-3 的 tone 規則：待審 `alert`、逾期 `overdue`、評分進行中 `open`、同意書 `violet`。
 */
export function adminTodoCards(home: AdminHome): readonly AdminTodoCard[] {
  const { summary, overdue, signoff } = home
  const pendingApps = summary?.pendingApplications ?? 0
  const overdueWho = [overdue.people ? `${overdue.people} 人` : '', overdue.groups ? `${overdue.groups} 組` : ''].filter(Boolean).join('、')
  const behind = home.teachers.filter((t) => t.counted < t.assigned).length
  return [
    {
      kind: 'accounts',
      tone: 'alert',
      title: `待審帳號 ${summary ? pendingApps : '—'}`,
      // 有待審才寫「N 位待審・最早 X 天前送出」（AD-21）；沒有待審不放小字。
      meta: summary ? pendingMeta(pendingApps, home.oldestPendingDays) : '讀不到帳號統計',
      href: `${BASE}/accounts?status=pending`,
      pill: summary ? (pendingApps > 0 ? OPEN('alert') : NONE) : undefined,
    },
    {
      kind: 'overdue',
      tone: 'overdue',
      title: `逾期未繳 ${overdue.total}`,
      meta: [overdue.total > 0 ? `欠繳 ${overdueWho}` : '', `發布中 ${home.published} 個作業`].filter(Boolean).join('・'),
      // 有逾期就連「公告與作業」的「逾期」篩選（AD-B7）。
      href: overdue.total > 0 ? `${BASE}/affairs?placement=overdue` : `${BASE}/affairs`,
      pill: overdue.total > 0 ? OPEN('overdue') : NONE,
    },
    {
      kind: 'grading',
      tone: 'open',
      title: `評分還差 ${home.remaining} 份`,
      meta: home.teachers.length === 0 ? '還沒有指派評分' : `${behind} 位老師未完成`,
      href: `${BASE}/grading`,
      pill: home.remaining > 0 ? OPEN('open') : NONE,
    },
    {
      kind: 'signoff',
      tone: 'violet',
      title: `等老師同意 ${signoff.waiting}`,
      meta: signoff.waiting > 0 ? '學生已全部同意' : `完成 ${signoff.complete} 組`,
      href: signoff.purpose ? `${BASE}/signoff?purpose=${signoff.purpose}` : `${BASE}/signoff`,
      pill: signoff.waiting > 0 ? OPEN('violet') : NONE,
    },
  ]
}
