import type { AccountStatus, ResolvedActor, Role } from '@/application/accounts/actor'
import { STUDENT_NO_PATTERN } from '@/application/accounts/roster'
import { REASON_MAX_LENGTH } from '@/application/accounts/registration'
import { toCsvLine } from '@/shared/csv'
import { err, type Err, type Result } from '@/shared/result'

/**
 * 帳號列表、停用／恢復、批次停用與匯出的規則（產品模組 01 §2.5、§2.6、2026-09-15 名單與系級；
 * 工程模組 01 §3 active⇄disabled、§5 `AccountCommand`／`UserDirectoryQuery`；票 9）。
 *
 * 這個檔是純邏輯：網址上的篩選怎麼收成合法值、CSV 長什麼樣、TXT 怎麼拆、
 * 批次預覽怎麼分類、誰能做。查表與交易在 `infrastructure/accounts/account-command.ts`。
 */

// ── 顯示用標籤 ──────────────────────────────────────────────────────────────

export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  pending: '待審核',
  active: '已核准',
  disabled: '已停用',
  deidentified: '已去識別化',
}

export const ROLE_LABEL: Record<Role, string> = {
  student: '學生',
  teacher: '老師',
  admin: '管理員',
}

// ── 篩選與排序 ──────────────────────────────────────────────────────────────

export type DirectoryStatusFilter = 'pending' | 'active' | 'disabled' | 'deidentified'
export type DirectorySort = 'createdAt' | 'studentNo' | 'cohort' | 'status'
export type SortDirection = 'asc' | 'desc'

export const DIRECTORY_SORTS: readonly DirectorySort[] = ['createdAt', 'studentNo', 'cohort', 'status']
export const DIRECTORY_SORT_LABEL: Record<DirectorySort, string> = {
  createdAt: '建立時間',
  studentNo: '學號',
  cohort: '屆別',
  status: '狀態',
}
export const DIRECTORY_STATUSES: readonly DirectoryStatusFilter[] = ['pending', 'active', 'disabled', 'deidentified']
export const DIRECTORY_ROLES: readonly Role[] = ['student', 'teacher', 'admin']

/** 一頁幾筆。一屆幾百人，50 筆一頁剛好一屏半。 */
export const DIRECTORY_PAGE_SIZE = 50
export const SEARCH_MAX_LENGTH = 100

export type DirectoryFilter = {
  /** 搜尋姓名、學號、Email（登入與聯絡）；空字串＝不搜尋。 */
  readonly q: string
  readonly role: Role | null
  readonly cohortId: string | null
  readonly status: DirectoryStatusFilter | null
  readonly sort: DirectorySort
  readonly dir: SortDirection
  /** 從 1 起算。 */
  readonly page: number
  /** 只看孤兒帳號（票 10b；定義見 `roles.ts` 的 `isOrphan`）。網址上是 `?orphan=1`。 */
  readonly orphan: boolean
}

export const DEFAULT_DIRECTORY_FILTER: DirectoryFilter = {
  q: '',
  role: null,
  cohortId: null,
  status: null,
  sort: 'createdAt',
  dir: 'desc',
  page: 1,
  orphan: false,
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUserId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function first(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : ''
  return typeof value === 'string' ? value : ''
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | null {
  return (allowed as readonly string[]).includes(value) ? (value as T) : null
}

/**
 * 把網址上的篩選（`?q=&role=&cohort=&status=&sort=&dir=&page=`）收成合法值。
 *
 * 認不得的值一律當作「沒指定」，不回錯誤：這是列表頁，打錯網址的人應該看到全部，而不是錯誤頁。
 * 排序欄與方向只能是白名單裡的值——它們最後會變成 SQL 的 ORDER BY，不能讓外面帶字串進去。
 */
export function normalizeDirectoryFilter(raw: Record<string, unknown>): DirectoryFilter {
  const q = first(raw.q).replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX_LENGTH)
  const cohort = first(raw.cohort)
  const page = Number.parseInt(first(raw.page), 10)
  return {
    q,
    role: oneOf(first(raw.role), DIRECTORY_ROLES),
    cohortId: UUID_PATTERN.test(cohort) ? cohort : null,
    status: oneOf(first(raw.status), DIRECTORY_STATUSES),
    sort: oneOf(first(raw.sort), DIRECTORY_SORTS) ?? DEFAULT_DIRECTORY_FILTER.sort,
    dir: oneOf(first(raw.dir), ['asc', 'desc'] as const) ?? DEFAULT_DIRECTORY_FILTER.dir,
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
    orphan: first(raw.orphan) === '1',
  }
}

/** 篩選轉回網址參數（預設值不寫，網址短一點）。`overrides` 給分頁與排序連結用。 */
export function directoryQueryString(filter: DirectoryFilter, overrides: Partial<DirectoryFilter> = {}): string {
  const f = { ...filter, ...overrides }
  const params = new URLSearchParams()
  if (f.q) params.set('q', f.q)
  if (f.role) params.set('role', f.role)
  if (f.cohortId) params.set('cohort', f.cohortId)
  if (f.status) params.set('status', f.status)
  if (f.orphan) params.set('orphan', '1')
  if (f.sort !== DEFAULT_DIRECTORY_FILTER.sort || f.dir !== DEFAULT_DIRECTORY_FILTER.dir) {
    params.set('sort', f.sort)
    params.set('dir', f.dir)
  }
  if (f.page > 1) params.set('page', String(f.page))
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** `ILIKE` 的樣式：使用者輸入的 `%`、`_`、`\` 當一般字元（搭配 `escape '\'`）。 */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

// ── 列 ──────────────────────────────────────────────────────────────────────

/**
 * 帳號列表的一列。
 *
 * 待審的人還沒有 `user_profiles`（核准時才建），姓名、學號、系級、手機、聯絡 Email
 * 從他最新一筆註冊申請讀；核准後一律以個人資料為準。屆別只有核准後才有。
 */
export type AccountRow = {
  readonly userId: string
  readonly name: string
  readonly studentNo: string | null
  readonly departmentClass: string | null
  readonly cohortId: string | null
  readonly cohortCode: string | null
  readonly cohortName: string | null
  readonly phone: string | null
  readonly loginEmail: string
  readonly contactEmail: string | null
  readonly roles: readonly Role[]
  readonly status: AccountStatus
  /** 待審的人最新一筆申請的狀態（被退回的人仍是待審帳號）。 */
  readonly applicationState: 'pending' | 'rejected' | null
  readonly createdAt: string
  /**
   * 孤兒帳號（票 10b）：登入身分在，但我方沒有角色、申請、個人資料（定義見 `roles.ts` 的 `isOrphan`）。
   * 列表上可以補建角色或停用。
   */
  readonly orphan: boolean
}

export type CohortFilterOption = { readonly id: string; readonly code: string; readonly name: string }

export type DirectoryPage = {
  readonly rows: readonly AccountRow[]
  /** 符合篩選的總筆數（不限目前分頁）。 */
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly cohorts: readonly CohortFilterOption[]
}

export type AccountSummary = {
  /** 等系辦審的註冊申請（與待審清單同一個條件）。 */
  readonly pendingApplications: number
  /** 狀態是待審的帳號（含被退回、還沒重送的人）。 */
  readonly pending: number
  readonly active: number
  readonly disabled: number
  /** 已核准且有學生角色的人。 */
  readonly activeStudents: number
  /** 孤兒帳號（票 10b）。 */
  readonly orphans: number
}

// ── 匯出 ────────────────────────────────────────────────────────────────────

/** 一次最多匯出幾筆；超過就請系辦先篩選。 */
export const EXPORT_MAX_ROWS = 5000

/** 位元組是 EF BB BF；寫成跳脫字元，原始碼裡不放看不見的字。 */
const UTF8_BOM = String.fromCharCode(0xfeff)

export const EXPORT_COLUMNS =['姓名', '學號', '系級', '屆別', '手機', '登入 Email', '聯絡 Email', '角色', '狀態'] as const

export type ExportSelection =
  | { readonly kind: 'ids'; readonly userIds: readonly string[] }
  | { readonly kind: 'filter'; readonly filter: DirectoryFilter }

/**
 * 匯出請求的形狀：勾選的帳號 ID，或「目前篩選的全部結果」（不限分頁）。
 * 伺服器只信這兩種說法，不收瀏覽器算好的列。
 */
export function normalizeExportSelection(input: unknown): { ok: true; value: ExportSelection } | Err {
  const body = (input ?? {}) as { kind?: unknown; userIds?: unknown; filter?: unknown }
  if (body.kind === 'ids') {
    if (!Array.isArray(body.userIds) || body.userIds.length === 0) {
      return err('VALIDATION_FAILED', '請先勾選要匯出的帳號。')
    }
    if (body.userIds.length > EXPORT_MAX_ROWS || !body.userIds.every(isUserId)) {
      return err('VALIDATION_FAILED', '勾選的帳號不正確，請重新整理頁面再試。')
    }
    return { ok: true, value: { kind: 'ids', userIds: [...new Set(body.userIds as string[])] } }
  }
  if (body.kind === 'filter') {
    const raw = typeof body.filter === 'object' && body.filter !== null ? (body.filter as Record<string, unknown>) : {}
    return { ok: true, value: { kind: 'filter', filter: { ...normalizeDirectoryFilter(raw), page: 1 } } }
  }
  return err('VALIDATION_FAILED', '請選擇要匯出的範圍。')
}

/**
 * 匯出的 CSV 全文（2026-09-15 定案：姓名、學號、系級、屆別、手機、Email、角色、狀態）。
 *
 * - 開頭帶 UTF-8 BOM：Windows 的 Excel 沒有它會把中文當 Big5 讀成亂碼。
 * - 每一格經 `toCsvLine`（契約 03 §5）：一律加引號、`= + - @ \t \r` 開頭加 `'`，
 *   Excel 不會把 `=HYPERLINK(...)` 當公式。學號以文字寫出，檔案內容保留前導零。
 * - 行尾 CRLF（RFC 4180，Excel 最穩）。
 */
export function buildAccountsCsv(rows: readonly AccountRow[]): string {
  const lines = [toCsvLine(EXPORT_COLUMNS)]
  for (const row of rows) {
    lines.push(
      toCsvLine([
        row.name,
        row.studentNo,
        row.departmentClass,
        row.cohortCode,
        row.phone,
        row.loginEmail,
        row.contactEmail,
        row.roles.map((r) => ROLE_LABEL[r]).join('、'),
        ACCOUNT_STATUS_LABEL[row.status],
      ]),
    )
  }
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`
}

// ── 停用與恢復 ──────────────────────────────────────────────────────────────

export type StatusChange = { readonly userId: string; readonly reason: string; readonly requestId: string }

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code === 0x0a || code === 0x0d || code === 0x09) continue
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** 停用、恢復、批次停用的理由：必填（工程模組 01 §3 狀態表的前置條件），會進稽核。 */
export function normalizeStatusReason(raw: unknown): { ok: true; value: string } | Err {
  const reason = typeof raw === 'string' ? raw.trim() : ''
  if (!reason) return err('VALIDATION_FAILED', '請寫理由，例如「休學」「復學」。', { details: { field: 'reason' } })
  if (reason.length > REASON_MAX_LENGTH || hasControlChars(reason)) {
    return err('VALIDATION_FAILED', `理由最多 ${REASON_MAX_LENGTH} 個字。`, { details: { field: 'reason' } })
  }
  return { ok: true, value: reason }
}

// ── 批次停用 ────────────────────────────────────────────────────────────────

/** TXT 最多幾行（含空白行）；一屆幾百人，2000 行綽綽有餘。 */
export const BULK_MAX_LINES = 2000
/** 貼上或上傳的 TXT 最大字元數。 */
export const BULK_MAX_CHARS = 64 * 1024

export type BulkLine = { readonly line: number; readonly studentNo: string }

/**
 * 拆批次停用的 TXT（產品模組 01 §2.6）：**一行一個學號**，允許空白行，不接受其他自由格式。
 *
 * 有任何一行不是學號（逗號分隔、姓名、多個學號擠一行……）就整份退件並指出第幾行，
 * 不猜使用者的意思——猜錯的代價是停用錯人。重複的學號留第一次出現的那行，其餘列為「重複」。
 */
export function parseBulkStudentNos(
  text: string,
): { ok: true; entries: readonly BulkLine[]; duplicates: readonly (BulkLine & { firstLine: number })[] } | Err {
  if (text.length > BULK_MAX_CHARS) {
    return err('VALIDATION_FAILED', `檔案太大了（上限 ${BULK_MAX_CHARS / 1024} KB），請分批處理。`)
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = body.split(/\r\n|\n|\r/)
  if (lines.length > BULK_MAX_LINES) return err('VALIDATION_FAILED', `一次最多 ${BULK_MAX_LINES} 行，請分批處理。`)

  const bad: number[] = []
  const entries: BulkLine[] = []
  const duplicates: (BulkLine & { firstLine: number })[] = []
  const seen = new Map<string, number>()
  lines.forEach((raw, index) => {
    const value = raw.trim()
    if (!value) return
    const line = index + 1
    if (!STUDENT_NO_PATTERN.test(value)) {
      bad.push(line)
      return
    }
    const key = value.toUpperCase()
    const firstLine = seen.get(key)
    if (firstLine !== undefined) {
      duplicates.push({ line, studentNo: value, firstLine })
      return
    }
    seen.set(key, line)
    entries.push({ line, studentNo: value })
  })

  if (bad.length > 0) {
    const listed = bad.slice(0, 5).join('、')
    return err(
      'VALIDATION_FAILED',
      `第 ${listed}${bad.length > 5 ? ' 等' : ''} 行不是學號。格式是一行一個學號（英數字），不要加逗號、姓名或其他文字。`,
    )
  }
  if (entries.length === 0) return err('VALIDATION_FAILED', '檔案裡沒有任何學號。')
  return { ok: true, entries, duplicates }
}

/** 有學號的帳號（核准過的學生；停用後也還在）。 */
export type BulkCandidate = {
  readonly userId: string
  readonly name: string
  readonly studentNo: string
  readonly cohortCode: string | null
  readonly status: AccountStatus
}

export type BulkTarget = BulkCandidate & { readonly line: number }

export type BulkPreview = {
  /** 將停用（目前是已核准）。 */
  readonly hits: readonly BulkTarget[]
  readonly alreadyDisabled: readonly BulkTarget[]
  /** 找不到已核准或已停用的帳號（待審中的人不在這裡停用，請到待審清單退回）。 */
  readonly notFound: readonly BulkLine[]
  readonly duplicates: readonly (BulkLine & { firstLine: number })[]
  /** 不自動處理、要人工看的：同一個學號對到多個帳號、或是自己。 */
  readonly skipped: readonly { readonly line: number; readonly studentNo: string; readonly reason: string; readonly accounts: readonly BulkCandidate[] }[]
}

/**
 * 批次停用的預覽分類（產品模組 01 §2.6「將命中／找不到／重複／已停用」）。
 *
 * 比對用學號（忽略大小寫）對核准過的學生資料。同一個學號對到兩個以上的帳號（例如跨屆重複）
 * 時不替系辦選，整列放進「要人工處理」；自己也不能停用自己。
 */
export function classifyBulk(
  parsed: { entries: readonly BulkLine[]; duplicates: readonly (BulkLine & { firstLine: number })[] },
  candidates: readonly BulkCandidate[],
  actorUserId: string,
): BulkPreview {
  const byNo = new Map<string, BulkCandidate[]>()
  for (const c of candidates) {
    if (c.status !== 'active' && c.status !== 'disabled') continue
    const key = c.studentNo.toUpperCase()
    byNo.set(key, [...(byNo.get(key) ?? []), c])
  }

  const hits: BulkTarget[] = []
  const alreadyDisabled: BulkTarget[] = []
  const notFound: BulkLine[] = []
  const skipped: BulkPreview['skipped'][number][] = []
  for (const entry of parsed.entries) {
    const found = byNo.get(entry.studentNo.toUpperCase()) ?? []
    if (found.length === 0) {
      notFound.push(entry)
      continue
    }
    if (found.length > 1) {
      skipped.push({ ...entry, reason: `這個學號對到 ${found.length} 個帳號，請到列表逐一處理`, accounts: found })
      continue
    }
    const account = found[0]!
    if (account.userId === actorUserId) {
      skipped.push({ ...entry, reason: '不能停用自己', accounts: found })
      continue
    }
    if (account.status === 'disabled') alreadyDisabled.push({ ...account, line: entry.line })
    else hits.push({ ...account, line: entry.line })
  }
  return { hits, alreadyDisabled, notFound, duplicates: parsed.duplicates, skipped }
}

/** 兩次預覽要停用的是不是同一群人（執行前再算一次，名單變了就請系辦重新預覽）。 */
export function sameTargets(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) return false
  const set = new Set(expected)
  return actual.every((id) => set.has(id))
}

// ── port ────────────────────────────────────────────────────────────────────

/**
 * 停用／恢復之後撤 session 的結果（`session_revocations` 主工作）。
 *
 * 不論哪一種，**停用都已經生效**：入口層與 ActorResolver 每次都重讀 `users.status`
 * （工程模組 01 附錄 A 規則 6）；Better Auth 那一層只是第二道，失敗由收斂工作補。
 */
export type RevocationOutcome = 'done' | 'failed' | 'pending'

export type StatusChangeReceipt = {
  readonly userId: string
  readonly name: string
  /** 變更後的狀態。恢復＝回到停用前的狀態：一般是 active；待審的孤兒帳號停用後恢復回 pending（票 10b 審查建議）。 */
  readonly status: 'active' | 'disabled' | 'pending'
  readonly changedAt: string
  readonly revocation: RevocationOutcome
}

export type BulkDisableReceipt = {
  readonly disabled: number
  readonly names: readonly string[]
  readonly changedAt: string
  readonly revocationFailed: number
}

/**
 * 發動這個動作的管理員的請求標頭。Better Auth admin plugin 呼叫 `banUser`／`unbanUser`
 * 時要看到一個管理員 session（見 `infrastructure/auth/wrapper.ts` 的說明），所以一路帶進去；
 * 用例本身不讀它。
 */
export type AdminRequestContext = { readonly headers: Headers }

/** 帳號列表、停用／恢復、批次停用、匯出（票 9）。授權用 `teachers.ts` 的 `accountAdminDenied`。 */
export type AccountDirectoryCommand = {
  list(actor: ResolvedActor, filter: DirectoryFilter): Promise<Result<DirectoryPage>>
  summary(actor: ResolvedActor): Promise<Result<AccountSummary>>
  /** 匯出（每次重新授權、寫稽核）。回 CSV 全文。 */
  exportCsv(actor: ResolvedActor, selection: ExportSelection): Promise<Result<{ csv: string; count: number }>>
  disable(actor: ResolvedActor, input: StatusChange, context: AdminRequestContext): Promise<Result<StatusChangeReceipt>>
  restore(actor: ResolvedActor, input: StatusChange, context: AdminRequestContext): Promise<Result<StatusChangeReceipt>>
  previewBulkDisable(actor: ResolvedActor, text: string): Promise<Result<BulkPreview>>
  bulkDisable(
    actor: ResolvedActor,
    input: { text: string; expectedUserIds: readonly string[]; reason: string; requestId: string },
    context: AdminRequestContext,
  ): Promise<Result<BulkDisableReceipt>>
  /** 去識別化的影響預覽（票 40）：對象、會清掉什麼、保留多少紀錄、擋住的原因。 */
  previewDeidentify(actor: ResolvedActor, userId: string): Promise<Result<DeidentifyPreview>>
  /** 去識別化（不可逆；理由＋照打登入 Email）。同一個交易撤 session、寫狀態事件與稽核。 */
  deidentify(actor: ResolvedActor, input: DeidentifyInput, context: AdminRequestContext): Promise<Result<DeidentifyReceipt>>
}

// ── 去識別化（票 40；ACC-14） ────────────────────────────────────────────────
//
// 規則來源：工程模組 01 §3「active → deidentified」（管理員；影響預覽＋二次確認；profile 清空、Email 置換、
// `deidentified_at`；保留業務關聯與稽核；有未完成簽核參與→先成員異動）；產品模組 01 §2.5「永久刪除改為去識別化，
// 不 cascade 刪繳交、成績、簽核與稽核，不破壞稽核鏈」、§2.6「高風險動作需再次輸入確認文字並產生稽核」。

/** 去識別化後的代稱。只由系統 ID 推得（ID 本來就是各處引用的鍵，不是個資），同一個人永遠同一個代稱。 */
export function deidentifiedPseudonym(userId: string): string {
  return `已去識別化使用者 ${userId.replace(/-/g, '').slice(-6).toUpperCase()}`
}

/**
 * 去識別化後的登入 Email。`users.email` 唯一且不可為空，所以放一個含系統 ID、保證收不到信的位址
 * （`.invalid` 是 RFC 2606 保留的頂級網域）。原 Email 從此不在帳號上。
 */
export function deidentifiedEmail(userId: string): string {
  return `deidentified-${userId.toLowerCase()}@deidentified.invalid`
}

/** 二次確認：系辦要照打這個帳號目前的登入 Email（不分大小寫、忽略頭尾空白）。伺服器用鎖住的那一列比對。 */
export function deidentifyConfirmationMatches(typed: unknown, loginEmail: string): boolean {
  if (typeof typed !== 'string') return false
  const value = typed.trim().toLowerCase()
  return value !== '' && value === loginEmail.trim().toLowerCase()
}

/** 會被清掉或置換的資料（預覽照這份清單講）。 */
export const DEIDENTIFY_CLEARS: readonly string[] = [
  '姓名改成代稱（帳號、個人資料、註冊申請）',
  '登入 Email 與聯絡 Email 換成收不到信的位址',
  '學號、系級、手機清空，釋出本屆學號',
  '密碼與 Google 權杖清除，之後不能用任何方式登入',
  '登入中的裝置立刻登出',
]

/** 保留下來的紀錄（只列數字，不列內容）。 */
export type DeidentifyRetained = {
  readonly groupMemberships: number
  readonly submissions: number
  readonly evaluatorAssignments: number
  readonly advisorAssignments: number
  readonly approvals: number
  readonly auditEvents: number
}

export const DEIDENTIFY_RETAINED_LABEL: Record<keyof DeidentifyRetained, string> = {
  groupMemberships: '組別成員紀錄',
  submissions: '繳交版本',
  evaluatorAssignments: '評分指派',
  advisorAssignments: '指導紀錄',
  approvals: '簽核表態',
  auditEvents: '操作紀錄',
}

export type DeidentifyPreview = {
  readonly userId: string
  /** 目前的姓名與登入 Email（只給系辦確認對象；操作後就不在帳號上了）。 */
  readonly name: string
  readonly loginEmail: string
  readonly studentNo: string | null
  readonly status: AccountStatus
  /** 操作後各處顯示的代稱。 */
  readonly pseudonym: string
  /** 擋住這次操作的原因；空陣列才可以執行。 */
  readonly blockers: readonly string[]
  readonly clears: readonly string[]
  /** 保留的紀錄（標籤＋筆數；畫面照順序列）。 */
  readonly retained: readonly { readonly label: string; readonly count: number }[]
}

/** 保留筆數 → 預覽的清單（固定順序）。 */
export function retainedList(retained: DeidentifyRetained): DeidentifyPreview['retained'] {
  return (Object.keys(DEIDENTIFY_RETAINED_LABEL) as (keyof DeidentifyRetained)[]).map((key) => ({
    label: DEIDENTIFY_RETAINED_LABEL[key],
    count: retained[key],
  }))
}

export type DeidentifyInput = {
  readonly userId: string
  readonly reason: string
  /** 系辦照打的登入 Email。 */
  readonly confirmText: string
  readonly requestId: string
}

export type DeidentifyReceipt = {
  readonly userId: string
  /** 回執只放代稱，不放原姓名（回執會存進帳本）。 */
  readonly pseudonym: string
  readonly deidentifiedAt: string
  readonly revocation: RevocationOutcome
}

/**
 * 狀態上的前置條件（其他條件——自己、最後一位管理員、未完成簽核——要查資料庫，在 infrastructure）。
 * 已核准或已停用可以去識別化；待審的人請走退回或停用；已去識別化的不能再做一次（不可逆）。
 */
export function deidentifyStatusBlocker(status: AccountStatus, isOrphan = false): string | null {
  if (status === 'active' || status === 'disabled') return null
  if (status === 'pending') {
    return isOrphan ? '孤兒帳號請先停用，再去識別化。' : '待審核的帳號不能去識別化，只處理已核准或已停用的帳號。'
  }
  return '這個帳號已經去識別化了。'
}
