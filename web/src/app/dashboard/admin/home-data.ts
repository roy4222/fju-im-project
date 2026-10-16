import type { AccountSummary, ResolvedActor } from '@/application/accounts'
import type { GradebookQuery, GradingQuery, PendingReview } from '@/application/grading'
import type { GroupQuery } from '@/application/groups'
import type { ItemListRow, ItemQuery } from '@/application/items'
import type { SignoffPurpose, SignoffQuery } from '@/application/signoff'
import type { Completion, RosterQuery } from '@/application/submissions'
import type { StageContext } from '@/app/dashboard/_stage'
import type { Tone } from '@/app/_ui/dashboard/cards'
import { remainingCount, teacherProgress, type TeacherProgress } from '@/app/dashboard/admin/grading/progress'
import { loadAdminSummary } from '@/app/_ui/workload'
import { getGradebookQuery, getGradingQuery } from '@/composition/grading'
import { getGroupQuery } from '@/composition/groups'
import { getItemQuery } from '@/composition/items'
import { getSignoffQuery, SIGNOFF_PURPOSES } from '@/composition/signoff'
import { completionOf, getRosterQuery, overdueReceiverIds } from '@/composition/submissions'

const BASE = '/dashboard/admin'
/** 首頁的完成率列表最多列幾份作業；更多的到「專題事務」看。逾期卡不受這個限制（掃全部發布中的作業）。 */
export const INTAKE_LIMIT = 6
/** 「我發的公告」列幾則。 */
export const NEWS_LIMIT = 3

/**
 * 系辦首頁讀資料用的 port（AD-02；AC-AD-04 用假物件計數）。
 *
 * 只有這七個：主機儲存（`storageTile`）只在開發者後台看，型別上就沒有，首頁不可能呼叫它。
 * - 待審帳號數：讀共用 SH-P2 的 `loadAdminSummary(actor.userId)`，跟側欄徽章同一次請求共用，不多讀一次（AD-13）。讀不到是 null。
 * - 分組：首頁只要組數與人數，傳 `{ history: false }` 不讀歷程（共用 SH-P4）；系辦分組頁維持預設（看歷程）。
 * - 完成率與逾期：一次讀完全屆發布中作業的名單事實（`completionFacts()`，AD-19／AD-13），不再逐份讀 `roster()`；型別上只拿得到它。
 */
export type AdminHomePorts = {
  readonly accounts: { readonly summary: (userId: string) => Promise<AccountSummary | null> }
  readonly groups: Pick<GroupQuery, 'overview'>
  readonly grading: Pick<GradingQuery, 'adminBoard'>
  readonly gradebook: Pick<GradebookQuery, 'gradebook'>
  readonly signoff: Pick<SignoffQuery, 'adminBoard'>
  readonly items: Pick<ItemQuery, 'list'>
  readonly roster: Pick<RosterQuery, 'completionFacts'>
}

export function adminHomePorts(): AdminHomePorts {
  return {
    accounts: { summary: loadAdminSummary },
    groups: getGroupQuery(),
    grading: getGradingQuery(),
    gradebook: getGradebookQuery(),
    signoff: getSignoffQuery(),
    items: getItemQuery(),
    roster: getRosterQuery(),
  }
}

export type IntakeRow = { readonly id: string; readonly title: string; readonly unit: '人' | '組'; readonly completion: Completion }

export type AdminHome = {
  /** null＝讀不到帳號統計。 */
  readonly summary: AccountSummary | null
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
    /** 欠繳最多那份作業；沒有逾期是 null。 */
    readonly worst: { readonly id: string; readonly title: string } | null
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
  const [summary, overview, gradingResult, signoffResult, items, gradebookResult, rosters] = await Promise.all([
    ports.accounts.summary(actor.userId),
    cohortId ? ports.groups.overview(cohortId, { history: false }) : Promise.resolve(null),
    cohortId ? ports.grading.adminBoard(actor, cohortId) : Promise.resolve(null),
    cohortId ? ports.signoff.adminBoard(actor, cohortId) : Promise.resolve(null),
    cohortId ? ports.items.list(cohortId) : Promise.resolve([]),
    // 只拿「待復核的更正」做首頁提示（N-61）；成績表本身在「成績」頁。
    cohortId ? ports.gradebook.gradebook(actor, cohortId) : Promise.resolve(null),
    // 發布中的作業全部讀名單事實：逾期卡要看全部（Codex P2：只掃前 6 份會漏算），完成率列表只列前 INTAKE_LIMIT 份。
    // 一次讀完（固定 2 句 SQL），順序同作業清單；算法照舊用名單頁同一個 `completionOf`／`overdueReceiverIds`（分母不含免填與移出）。
    cohortId ? ports.roster.completionFacts(actor, cohortId) : Promise.resolve([]),
  ])
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
  const worst = [...allIntake].sort((a, b) => b.completion.overdue - a.completion.overdue)[0]

  const groups = overview?.groups ?? []
  const grading = gradingResult?.ok ? gradingResult.receipt : null

  const signGroups = signoffResult?.ok ? signoffResult.receipt.groups : []
  const waitingBy = SIGNOFF_PURPOSES.map((p) => ({ purpose: p, n: signGroups.filter((g) => g.packages[p]?.state === 'teacher_pending').length }))
  const waiting = waitingBy.reduce((a, w) => a + w.n, 0)
  const mostWaiting = [...waitingBy].sort((a, b) => b.n - a.n)[0]

  const news = items.filter((i) => i.placement === 'news')

  return {
    summary,
    groups: {
      total: groups.length,
      students: groups.reduce((a, g) => a + g.members.length, 0),
      ungrouped: overview?.ungrouped.length ?? 0,
      industry: groups.filter((g) => g.groupType === 'industry').length,
      noAdvisorIndustry: groups.filter((g) => g.groupType === 'industry' && g.advisor === null).length,
      openProposals: overview?.openProposals.length ?? 0,
    },
    published: allIntake.length,
    intake: allIntake.slice(0, INTAKE_LIMIT),
    overdue: {
      total: overdueTotal,
      people: overduePeople,
      groups: overdueTotal - overduePeople,
      worst: worst && worst.completion.overdue > 0 ? { id: worst.id, title: worst.title } : null,
    },
    teachers: grading ? teacherProgress(grading, { excludeDissolved: true }) : [],
    remaining: grading ? remainingCount(grading) : 0,
    signoff: {
      waiting,
      complete: signGroups.filter((g) => SIGNOFF_PURPOSES.some((p) => g.packages[p]?.state === 'complete')).length,
      purpose: mostWaiting && mostWaiting.n > 0 ? mostWaiting.purpose : null,
    },
    pendingReviews: gradebookResult?.ok ? gradebookResult.receipt.pendingReviews : [],
    newsCount: news.length,
    news: news.slice(0, NEWS_LIMIT),
  }
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
      // 「最早 X 天前送出」要帳號統計多一個欄位（B 階段）；在那之前不放小字（主腦裁定）。
      meta: summary ? undefined : '讀不到帳號統計',
      href: `${BASE}/accounts?status=pending`,
      pill: summary ? (pendingApps > 0 ? OPEN('alert') : NONE) : undefined,
    },
    {
      kind: 'overdue',
      tone: 'overdue',
      title: `逾期未繳 ${overdue.total}`,
      meta: [overdue.total > 0 ? `欠繳 ${overdueWho}` : '', `發布中 ${home.published} 個作業`].filter(Boolean).join('・'),
      // Q114：A 先連既有逾期名單（欠繳最多那份作業）；「逾期」篩選是 B（AD-B7）。
      href: overdue.worst ? `${BASE}/affairs/${overdue.worst.id}` : `${BASE}/affairs`,
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
