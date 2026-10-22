import type { ItemListRow, ItemStatus, Placement, ReceiverUnit } from '@/application/items'
import type { AffairRow } from '@/app/dashboard/admin/affairs/affairs-list'
import { AUDIENCE_LABEL, collectsResponses, ITEM_STATUS_LABEL, PLACEMENT_LABEL, RECEIVER_UNIT_LABEL } from '@/composition/items'
import { formatTaipeiDate, formatTaipeiMinute, isDeadlinePassed, taipeiDateOf } from '@/shared/time'

/**
 * 公告與作業列表要顯示哪一屆、哪個篩選（純函式；第三波 W1b）。
 *
 * - 一般篩選只列未封存的屆別；「榮譽」篩選連已封存的也列（榮譽是跨屆的公開紀錄）。
 * - 一個屆別都沒有 → `none`（「還沒有屆別」）。
 * - 屆別全部封存、又不是榮譽篩選 → `only-archived`：不能新增一般項目，但要留「歷屆榮譽」入口，不能變成死路。
 * - 「逾期」不是種類（AD-B7）：發布中、已截止、還有人沒正式送出的文件繳交；頁面另讀名單事實才篩得出來。
 * - 資源、文件繳交、專題規則改成自己的分頁（C 階段規格② §2.2，見 `AFFAIRS_TAB_PLACEMENTS`），不在公告頁的「種類」篩選；
 *   舊的 `?placement=` 網址由 `admin/legacy-redirects.ts` 轉到分頁。
 */

export const AFFAIRS_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'news', label: '公告' },
  { key: 'honor', label: '榮譽' },
  { key: 'overdue', label: '逾期' },
] as const

export type AffairsFilter = (typeof AFFAIRS_FILTERS)[number]['key']

type CohortLike = { readonly id: string; readonly status: string; readonly isDefaultWorking: boolean }

export type AffairsView<C extends CohortLike> =
  | { readonly state: 'none'; readonly filter: AffairsFilter }
  | { readonly state: 'only-archived'; readonly filter: AffairsFilter }
  | { readonly state: 'ok'; readonly filter: AffairsFilter; readonly cohorts: readonly C[]; readonly cohort: C }

export function affairsView<C extends CohortLike>(
  all: readonly C[],
  params: { readonly cohort?: string | string[]; readonly placement?: string | string[] },
): AffairsView<C> {
  const filter = AFFAIRS_FILTERS.find((f) => f.key === params.placement)?.key ?? 'all'
  if (all.length === 0) return { state: 'none', filter }
  const cohorts = filter === 'honor' ? all : all.filter((c) => c.status !== 'archived')
  if (cohorts.length === 0) return { state: 'only-archived', filter }
  const cohort =
    cohorts.find((c) => c.id === params.cohort) ??
    cohorts.find((c) => c.isDefaultWorking) ??
    cohorts.find((c) => c.status !== 'archived') ??
    cohorts[0]!
  return { state: 'ok', filter, cohorts, cohort }
}

/**
 * 公告與作業的三個固定種類分頁（C 階段規格② §2.2）：每頁只列這些 placement，不再有「種類」篩選。
 * 作業含文件繳交與專題需求；專題規則依章節位置排、每列有上移下移。
 */
export const AFFAIRS_TAB_PLACEMENTS = {
  assignments: ['submission', 'requirement'],
  resources: ['resource'],
  rules: ['rules'],
} as const satisfies Record<string, readonly Placement[]>

/** 規則章節的順序：`rules_position asc nulls last, actual_opened_at asc nulls last, id asc`（同前台與 `moveRule`）。 */
export function byRulesPosition(a: ItemListRow, b: ItemListRow): number {
  const last = Number.MAX_SAFE_INTEGER
  return (
    (a.rulesPosition ?? last) - (b.rulesPosition ?? last) ||
    (a.actualOpenedAt?.getTime() ?? last) - (b.actualOpenedAt?.getTime() ?? last) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/**
 * 一筆項目 → 清單的一列（公告頁與三個種類分頁共用）。
 * `overdueText`：「逾期」篩選才給；`move`：專題規則才給（首尾停用由呼叫端用排好的整份清單算）。
 */
export function toAffairRow(
  r: ItemListRow,
  businessNow: Date,
  extra: { readonly overdueText?: string | null; readonly move?: { up: boolean; down: boolean } | null } = {},
): AffairRow {
  const collects = collectsResponses(r.placement)
  return {
    id: r.id,
    kind: PLACEMENT_LABEL[r.placement],
    title: r.title,
    status: r.status,
    statusLabel: ITEM_STATUS_LABEL[r.status],
    visibility: r.audienceKind === 'public' ? '網際網路公開' : '登入後可見',
    audience: audienceText(r),
    // 原型這一欄只寫日期；截止多寫到分鐘（23:59 截止跟 00:00 截止差一天）。
    date: r.dueAt ? formatTaipeiMinute(r.dueAt) : r.actualOpenedAt ? formatTaipeiDate(taipeiDateOf(r.actualOpenedAt)) : '—',
    isDue: r.dueAt !== null,
    // 截止含當分鐘（Vault 04 §4）：跟收件判定用同一個 helper。
    overdue: r.dueAt !== null && isDeadlinePassed(businessNow, r.dueAt),
    overdueText: extra.overdueText ?? null,
    // 收件名單頁（票 18）：數字＝應交數（不含免填），跟名單頁完成率的分母同一個口徑。
    roster: collects
      ? r.status === 'draft'
        ? { text: RECEIVER_UNIT_LABEL[r.receiverUnit], href: null }
        : { text: `需要繳交 ${r.rosterCount} ${r.receiverUnit === 'group' ? '組' : '位'}`, href: `/dashboard/admin/affairs/${r.id}` }
      : null,
    // 前台頁面：發布中的公告才有自己的內容頁（資源、規則是整頁列表）；發布中的榮譽連到前台榮譽榜。
    publicHref: r.status !== 'published' ? null : r.placement === 'news' ? `/news/${r.id}` : r.placement === 'honor' ? '/honors' : null,
    editHref: `/dashboard/admin/editor/${r.id}`,
    // 置頂（第 1 批 V1）：只有發布中的公告有按鈕（規則同 `pinDenial`；撤回、下架時已自動取消置頂）。
    pinned: r.pinnedAt !== null,
    canPin: r.placement === 'news' && r.status === 'published',
    move: extra.move ?? null,
  }
}

/** 「對象」欄：指定組別列出組代號，其他用對象名稱。 */
export function audienceText(r: Pick<ItemListRow, 'audienceKind' | 'audienceGroupCodes'>): string {
  return r.audienceKind === 'groups' ? `指定組別：${r.audienceGroupCodes.join('、') || '（還沒選）'}` : AUDIENCE_LABEL[r.audienceKind]
}

/** 個人一份數人、整組一份數組。 */
export function unitWord(unit: ReceiverUnit): '人' | '組' {
  return unit === 'group' ? '組' : '人'
}

/** 一份收件的回答事實（名單上任何一列：含免繳、已移出）：幾位／組正式送出過、有沒有人存過草稿。 */
export type ResponseFacts = { readonly submitted: number; readonly started: boolean }

export function responseFactsOf(entries: readonly { readonly latestVersionNo: number | null; readonly hasDraft: boolean }[]): ResponseFacts {
  return {
    submitted: entries.filter((e) => e.latestVersionNo !== null).length,
    started: entries.some((e) => e.hasDraft || e.latestVersionNo !== null),
  }
}

/** 發布中不能刪（C1-07 AC-9：畫面自己的字；伺服器的 `deleteCheck` 訊息不改）。 */
export const DELETE_PUBLISHED_TEXT = '發布中，先下架才能刪'

/**
 * 清單「刪除」鈕上的原因（AC-9；規則同 `deleteCheck`：發布中不行、有任何回答不行）。可以刪回 null。
 * `responses`：收件才給（草稿沒有名單、不是收件都給 null）。
 */
export function deleteBlockedText(status: ItemStatus, responses: ResponseFacts | null, unit: ReceiverUnit): string | null {
  if (status === 'published') return DELETE_PUBLISHED_TEXT
  if (!responses) return null
  if (responses.submitted > 0) return `已有 ${responses.submitted} ${unitWord(unit)}交件，不能刪`
  if (responses.started) return '已有人開始填寫，不能刪'
  return null
}

/** 作業清單的繳交進度字（AC-9「3／8 組已交」）。 */
export function progressText(done: number, required: number, unit: ReceiverUnit): string {
  return `${done}／${required} ${unitWord(unit)}已交`
}
