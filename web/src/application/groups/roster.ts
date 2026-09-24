import { GROUP_TYPE_LABEL, isUuid, type GroupType } from '@/application/groups/proposals'
import type { GroupSummary } from '@/application/groups/ports'
import { err, type Err } from '@/shared/result'
import { toCsvLine } from '@/shared/csv'

/**
 * 管理員「分組總覽」的組別名單：篩選、排序、組員信箱、匯出（票 20；產品 03 §5.5「分組表可搜尋、排序、
 * 依屆別／類型／老師／狀態篩選；可勾選部分或全選篩選結果，下載 CSV／Excel」；執行手冊 C18 複製信箱）。
 *
 * 純函式：頁面（伺服器端）與匯出的 Route Handler 用同一份篩選與排序，匯出的筆數才會和畫面一致。
 * 信箱一律是帳號的**登入信箱**（`users.email`，不限 gmail.com），不是個人檔案的聯絡 Email。
 */

export type RosterTypeFilter = 'all' | GroupType
/**
 * 「狀態」：目前的組別都是有效的（解散在之後的票），所以這裡的狀態是系辦處理進度：
 * 指導老師有沒有指派、產學組有沒有連結合作案。
 */
export type RosterStatusFilter = 'all' | 'advisor_missing' | 'advisor_assigned' | 'industry_unlinked'
export type RosterSort = 'code' | 'type' | 'advisor' | 'members' | 'established'
export type RosterDirection = 'asc' | 'desc'

export const ROSTER_TYPE_FILTERS: readonly RosterTypeFilter[] = ['all', 'general', 'industry']
export const ROSTER_TYPE_FILTER_LABEL: Record<RosterTypeFilter, string> = {
  all: '全部類型',
  general: GROUP_TYPE_LABEL.general,
  industry: GROUP_TYPE_LABEL.industry,
}
export const ROSTER_STATUS_FILTERS: readonly RosterStatusFilter[] = ['all', 'advisor_missing', 'advisor_assigned', 'industry_unlinked']
export const ROSTER_STATUS_FILTER_LABEL: Record<RosterStatusFilter, string> = {
  all: '全部狀態',
  advisor_missing: '尚未指派老師',
  advisor_assigned: '已指派老師',
  industry_unlinked: '產學組未連結合作案',
}
export const ROSTER_SORTS: readonly RosterSort[] = ['code', 'type', 'advisor', 'members', 'established']
export const ROSTER_SORT_LABEL: Record<RosterSort, string> = {
  code: '組別',
  type: '類型',
  advisor: '指導老師',
  members: '人數',
  established: '成立時間',
}

/** `advisor`：`all` 全部、`none` 尚未指派、其他是老師的 user id。 */
export type RosterFilter = {
  readonly type: RosterTypeFilter
  readonly status: RosterStatusFilter
  readonly advisor: string
  /** 搜尋：組別代碼、組員姓名、學號、信箱。 */
  readonly q: string
  readonly sort: RosterSort
  readonly dir: RosterDirection
}

export const DEFAULT_ROSTER_FILTER: RosterFilter = { type: 'all', status: 'all', advisor: 'all', q: '', sort: 'code', dir: 'asc' }
export const ROSTER_SEARCH_MAX_LENGTH = 100

const one = (value: unknown): string => (typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '')

/** 網址參數或匯出 body 裡的篩選 → 可信的篩選（不認得的值一律回預設）。 */
export function normalizeRosterFilter(raw: Record<string, unknown>): RosterFilter {
  const pick = <T extends string>(value: string, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly string[]).includes(value) ? (value as T) : fallback
  const advisorRaw = one(raw.advisor)
  return {
    type: pick(one(raw.type), ROSTER_TYPE_FILTERS, 'all'),
    status: pick(one(raw.status), ROSTER_STATUS_FILTERS, 'all'),
    advisor: advisorRaw === 'none' || isUuid(advisorRaw) ? advisorRaw : 'all',
    q: one(raw.q).trim().slice(0, ROSTER_SEARCH_MAX_LENGTH),
    sort: pick(one(raw.sort), ROSTER_SORTS, 'code'),
    dir: one(raw.dir) === 'desc' ? 'desc' : 'asc',
  }
}

/** 篩選 → 網址查詢字串（`overrides` 用來做排序表頭的連結）。預設值不寫進網址。 */
export function rosterQueryString(filter: RosterFilter, overrides: Partial<RosterFilter> = {}): string {
  const merged = { ...filter, ...overrides }
  const params = new URLSearchParams()
  for (const key of ['type', 'status', 'advisor', 'q', 'sort', 'dir'] as const) {
    if (merged[key] !== DEFAULT_ROSTER_FILTER[key]) params.set(key, merged[key])
  }
  return params.toString()
}

function matchesSearch(group: GroupSummary, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  const haystack = [
    group.code,
    group.advisor?.teacherName ?? '',
    group.opportunity?.name ?? '',
    ...group.members.flatMap((m) => [m.name, m.studentNo ?? '', m.loginEmail ?? '']),
  ]
  return haystack.some((text) => text.toLowerCase().includes(needle))
}

function matchesStatus(group: GroupSummary, status: RosterStatusFilter): boolean {
  switch (status) {
    case 'all':
      return true
    case 'advisor_missing':
      return group.advisor === null
    case 'advisor_assigned':
      return group.advisor !== null
    case 'industry_unlinked':
      return group.groupType === 'industry' && group.opportunity === null
  }
}

const collator = new Intl.Collator('zh-Hant', { numeric: true })

function compare(a: GroupSummary, b: GroupSummary, sort: RosterSort): number {
  switch (sort) {
    case 'code':
      return collator.compare(a.code, b.code)
    case 'type':
      return collator.compare(GROUP_TYPE_LABEL[a.groupType], GROUP_TYPE_LABEL[b.groupType])
    case 'advisor':
      // 尚未指派的排在最後（升冪時），看「還有哪幾組要處理」最直接。
      if (!a.advisor || !b.advisor) return a.advisor ? -1 : b.advisor ? 1 : 0
      return collator.compare(a.advisor.teacherName, b.advisor.teacherName)
    case 'members':
      return a.members.length - b.members.length
    case 'established':
      return a.establishedBusinessAt.getTime() - b.establishedBusinessAt.getTime()
  }
}

/** 套篩選與排序（同值時一律以組別代碼排，順序穩定）。 */
export function applyRosterFilter<G extends GroupSummary>(groups: readonly G[], filter: RosterFilter): G[] {
  const filtered = groups.filter(
    (g) =>
      (filter.type === 'all' || g.groupType === filter.type) &&
      matchesStatus(g, filter.status) &&
      (filter.advisor === 'all' ||
        (filter.advisor === 'none' ? g.advisor === null : g.advisor?.teacherUserId === filter.advisor)) &&
      matchesSearch(g, filter.q),
  )
  const sign = filter.dir === 'desc' ? -1 : 1
  return filtered.sort((a, b) => sign * compare(a, b, filter.sort) || collator.compare(a.code, b.code))
}

/** 「複製本組信箱」貼上的字：登入信箱以逗號加空白分隔（Gmail、Outlook 的收件人欄都吃）。沒有信箱的略過。 */
export function groupEmailList(group: Pick<GroupSummary, 'members'>): string {
  return group.members
    .map((m) => m.loginEmail)
    .filter((email): email is string => typeof email === 'string' && email.length > 0)
    .join(', ')
}

// ── 匯出 ────────────────────────────────────────────────────────────────────

export type RosterExportFormat = 'csv' | 'xlsx'

export type RosterExportRequest = {
  readonly cohortId: string
  readonly format: RosterExportFormat
  readonly selection: { readonly kind: 'ids'; readonly groupIds: readonly string[] } | { readonly kind: 'filter'; readonly filter: RosterFilter }
}

/** 一次最多匯出幾組（一屆通常幾十組；上限只是防呆）。 */
export const ROSTER_EXPORT_MAX_GROUPS = 1000

/**
 * 匯出請求的形狀：屆別＋格式＋「勾選的組別」或「目前篩選的全部結果」。
 * 伺服器只信這兩種說法，不收瀏覽器算好的列（同帳號名單匯出，票 9）。
 */
export function normalizeRosterExportRequest(input: unknown): { ok: true; value: RosterExportRequest } | Err {
  const body = (input ?? {}) as { cohortId?: unknown; format?: unknown; kind?: unknown; groupIds?: unknown; filter?: unknown }
  const cohortId = typeof body.cohortId === 'string' ? body.cohortId : ''
  if (!isUuid(cohortId)) return err('VALIDATION_FAILED', '請先選屆別。')
  if (body.format !== 'csv' && body.format !== 'xlsx') return err('VALIDATION_FAILED', '請選匯出格式（CSV 或 XLSX）。')
  if (body.kind === 'ids') {
    if (!Array.isArray(body.groupIds) || body.groupIds.length === 0) return err('VALIDATION_FAILED', '請先勾選要匯出的組別。')
    if (body.groupIds.length > ROSTER_EXPORT_MAX_GROUPS || !body.groupIds.every((id) => typeof id === 'string' && isUuid(id))) {
      return err('VALIDATION_FAILED', '勾選的組別不正確，請重新整理頁面再試。')
    }
    return { ok: true, value: { cohortId, format: body.format, selection: { kind: 'ids', groupIds: [...new Set(body.groupIds as string[])] } } }
  }
  if (body.kind === 'filter') {
    const raw = typeof body.filter === 'object' && body.filter !== null ? (body.filter as Record<string, unknown>) : {}
    return { ok: true, value: { cohortId, format: body.format, selection: { kind: 'filter', filter: normalizeRosterFilter(raw) } } }
  }
  return err('VALIDATION_FAILED', '請選擇要匯出的範圍。')
}

/** 匯出欄位：每位組員一列（#105「打開只有 G2 的成員列」）。學號與信箱都是文字。 */
export const ROSTER_EXPORT_COLUMNS = [
  '屆別',
  '組別',
  '類型',
  '指導老師',
  '合作案',
  '組長',
  '學號',
  '姓名',
  '登入信箱',
  '本組信箱',
] as const

/** 匯出的資料列（純文字，CSV 與 XLSX 共用）。沒有組員的組別也留一列，組員欄空白。 */
export function rosterExportRows(cohortCode: string, groups: readonly GroupSummary[]): string[][] {
  const rows: string[][] = []
  for (const g of groups) {
    const common = [
      cohortCode,
      g.code,
      GROUP_TYPE_LABEL[g.groupType],
      g.advisor?.teacherName ?? '尚未指派',
      g.opportunity ? `${g.opportunity.name}${g.opportunity.status === 'withdrawn' ? '（已下架）' : ''}` : '',
    ]
    const emails = groupEmailList(g)
    if (g.members.length === 0) rows.push([...common, '', '', '', '', emails])
    for (const m of g.members) {
      rows.push([...common, m.isLeader ? '是' : '', m.studentNo ?? '', m.name, m.loginEmail ?? '', emails])
    }
  }
  return rows
}

/** 位元組是 EF BB BF；寫成跳脫字元，原始碼裡不放看不見的字。 */
const UTF8_BOM = String.fromCharCode(0xfeff)

/**
 * 匯出的 CSV 全文：開頭 UTF-8 BOM（Windows Excel 才不會讀成亂碼）、每一格經 `toCsvLine`
 * （一律加引號、`= + - @ \t \r` 開頭加 `'`，Excel 不會當公式）、行尾 CRLF。
 */
export function buildRosterCsv(rows: readonly (readonly string[])[]): string {
  const lines = [toCsvLine(ROSTER_EXPORT_COLUMNS), ...rows.map((row) => toCsvLine(row))]
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`
}
