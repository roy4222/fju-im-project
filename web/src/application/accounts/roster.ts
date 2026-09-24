import { hasRole, statusGate, type ResolvedActor } from '@/application/accounts/actor'
import { parseCsv } from '@/shared/csv'
import type { ErrorCode } from '@/shared/errors'
import type { Result } from '@/shared/result'

/**
 * 名單匯入的規則（模組 01 §2.4「本屆名單 CSV 固定格式」、2026-09-15 名單與系級；
 * 工程模組 01 §5 `RosterCommand`、§6 整批一交易）。
 *
 * 這個檔是純邏輯：CSV 怎麼拆、姓名怎麼正規化、哪一列算重複／缺欄／衝突、屆別欄怎麼對。
 * 預覽與匯入用**同一個函式**分析同一份已存的原檔，所以「看到的」就是「匯入的」。
 */

// ── 格式 ────────────────────────────────────────────────────────────────────

/** 欄位固定：`student_no,name,cohort,email`，可多一欄系級。欄位順序不拘，靠表頭對。 */
export const ROSTER_COLUMNS = ['student_no', 'name', 'cohort', 'email', 'department_class'] as const
export type RosterColumn = (typeof ROSTER_COLUMNS)[number]

/** 表頭的別名（系辦用 Excel 做的檔常常直接寫中文）。 */
const HEADER_ALIASES: Record<string, RosterColumn> = {
  student_no: 'student_no',
  name: 'name',
  cohort: 'cohort',
  email: 'email',
  department_class: 'department_class',
  系級: 'department_class',
}

/** 名單 CSV 的大小上限。一屆幾百人、每列不到 100 字元，2 MiB 綽綽有餘。 */
export const ROSTER_MAX_BYTES = 2 * 1024 * 1024
/** 資料列上限（不含表頭）；契約 03 §5「每列長度上限」一併在這裡擋。 */
export const ROSTER_MAX_ROWS = 5000
export const ROSTER_MAX_CELL_LENGTH = 200

const STUDENT_NO_PATTERN = /^[0-9A-Za-z]{1,20}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ── 姓名正規化 ──────────────────────────────────────────────────────────────

/**
 * 比對用的正規化姓名（模組 01 §2.4）：保守處理——
 * 去頭尾空白、中間連續空白縮成一個（不刪光，避免外籍姓名被錯誤合併）、
 * 全形英數與全形空白轉半形、英文忽略大小寫。**不**替換台／臺等異體字、不做模糊比對。
 * 原始內容另外保存，這個版本只用於比對。
 */
export function normalizeName(raw: string): string {
  return raw
    .replace(/[\uff01-\uff5e]/g, (ch) => {
      const code = ch.charCodeAt(0)
      const half = String.fromCharCode(code - 0xfee0)
      // 只轉英數，全形標點（例如「．」）保留原樣。
      return /[0-9A-Za-z]/.test(half) ? half : ch
    })
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// ── 分析 ────────────────────────────────────────────────────────────────────

export type RosterIssueKind =
  | 'missing_student_no'
  | 'invalid_student_no'
  | 'missing_name'
  | 'column_count'
  | 'duplicate'
  | 'name_mismatch'
  | 'invalid_email'

export type RosterIssue = {
  /** 檔案裡的實體行號（表頭是第 1 行）。 */
  readonly line: number
  readonly studentNo: string | null
  readonly kind: RosterIssueKind
  readonly message: string
  /** `skipped`＝這一列不匯入；`warning`＝照樣匯入，只是提醒。 */
  readonly action: 'skipped' | 'warning'
}

export type RosterEntryDraft = {
  readonly line: number
  readonly studentNo: string
  readonly nameRaw: string
  readonly nameNormalized: string
  readonly departmentClass: string | null
  readonly email: string | null
  readonly cohortRaw: string | null
}

export type RosterCounts = {
  /** 資料列總數（不含表頭與空白列）。total = valid + duplicate + missing + conflict。 */
  readonly total: number
  readonly valid: number
  /** 同學號、同姓名的多出來那幾列。 */
  readonly duplicate: number
  /** 缺學號、缺姓名、學號格式不對、欄位數不對。 */
  readonly missing: number
  /** 同學號但姓名不同：整組都不匯入，交人工處理。 */
  readonly conflict: number
  /** 提醒：屆別欄跟這次選的屆別不同（仍匯入到所選屆別）。 */
  readonly cohortMismatch: number
  /** 提醒：Email 格式不對，已留白。 */
  readonly invalidEmail: number
}

export type CohortOption = {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly isRegistrationOpen: boolean
  readonly isDefaultWorking: boolean
}

/** CSV 屆別欄裡出現過的每個值，以及它對到哪個既有屆別。 */
export type CohortValueMatch = {
  readonly value: string
  readonly rows: number
  readonly cohortId: string | null
}

export type RosterAnalysis = {
  readonly columns: { readonly cohort: boolean; readonly email: boolean; readonly departmentClass: boolean }
  readonly counts: RosterCounts
  readonly issues: readonly RosterIssue[]
  readonly entries: readonly RosterEntryDraft[]
  readonly cohortValues: readonly CohortValueMatch[]
  /** CSV 屆別欄剛好全部對到同一個既有屆別時的建議值。 */
  readonly suggestedCohortId: string | null
}

export type RosterFormatError = { readonly ok: false; readonly message: string }

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function matchCohort(value: string, cohorts: readonly CohortOption[]): CohortOption | null {
  return cohorts.find((c) => sameText(c.code, value) || sameText(c.name, value)) ?? null
}

/**
 * 分析一份名單。`selectedCohortId` 是這次要匯入的屆別（可以還沒選）；
 * 它只影響「屆別欄與所選不同」的提醒，不影響哪些列匯入。
 */
export function analyzeRoster(
  text: string,
  cohorts: readonly CohortOption[],
  selectedCohortId: string | null,
): { ok: true; analysis: RosterAnalysis } | RosterFormatError {
  const parsed = parseCsv(text, { maxCellLength: ROSTER_MAX_CELL_LENGTH, maxRows: ROSTER_MAX_ROWS + 1 })
  if (!parsed.ok) {
    const reasons: Record<typeof parsed.reason, string> = {
      unterminated_quote: `第 ${parsed.line} 行的引號沒有收尾。`,
      stray_quote: `第 ${parsed.line} 行有多餘的引號。`,
      cell_too_long: `第 ${parsed.line} 行有欄位超過 ${ROSTER_MAX_CELL_LENGTH} 個字。`,
      too_many_rows: `名單超過 ${ROSTER_MAX_ROWS} 列，請分批匯入。`,
    }
    return { ok: false, message: reasons[parsed.reason] }
  }

  const [header, ...dataRows] = parsed.rows
  if (!header) return { ok: false, message: '檔案是空的，第一行要是表頭 student_no,name,cohort,email。' }

  // 表頭：欄位名對到固定欄位；不認得的欄位不猜，直接退件。
  const positions = new Map<RosterColumn, number>()
  for (const [index, rawName] of header.cells.entries()) {
    const key = rawName.trim().toLowerCase()
    const column = HEADER_ALIASES[key]
    if (!column) {
      return {
        ok: false,
        message: `表頭有不認得的欄位「${rawName.trim()}」。欄位固定為 student_no,name,cohort,email，可多一欄 department_class（系級）。`,
      }
    }
    if (positions.has(column)) return { ok: false, message: `表頭的「${column}」出現了兩次。` }
    positions.set(column, index)
  }
  for (const required of ['student_no', 'name'] as const) {
    if (!positions.has(required)) {
      return { ok: false, message: `表頭少了必填欄位「${required}」。欄位固定為 student_no,name,cohort,email。` }
    }
  }
  if (dataRows.length === 0) return { ok: false, message: '名單只有表頭，沒有任何學生。' }

  const cell = (cells: readonly string[], column: RosterColumn): string => {
    const index = positions.get(column)
    return index === undefined ? '' : (cells[index] ?? '').trim()
  }

  const issues: RosterIssue[] = []
  let missing = 0
  let invalidEmail = 0
  const candidates: RosterEntryDraft[] = []

  for (const row of dataRows) {
    const studentNo = cell(row.cells, 'student_no')
    if (row.cells.length > header.cells.length) {
      missing += 1
      issues.push({ line: row.line, studentNo: studentNo || null, kind: 'column_count', message: '欄位比表頭多（可能是姓名裡有逗號卻沒加引號）', action: 'skipped' })
      continue
    }
    if (!studentNo) {
      missing += 1
      issues.push({ line: row.line, studentNo: null, kind: 'missing_student_no', message: '缺學號', action: 'skipped' })
      continue
    }
    if (!STUDENT_NO_PATTERN.test(studentNo)) {
      missing += 1
      issues.push({ line: row.line, studentNo, kind: 'invalid_student_no', message: '學號只能是英數字', action: 'skipped' })
      continue
    }
    const nameRaw = cell(row.cells, 'name')
    if (!nameRaw) {
      missing += 1
      issues.push({ line: row.line, studentNo, kind: 'missing_name', message: '缺姓名', action: 'skipped' })
      continue
    }

    let email: string | null = cell(row.cells, 'email') || null
    if (email && (email.length > 254 || !EMAIL_PATTERN.test(email))) {
      invalidEmail += 1
      issues.push({ line: row.line, studentNo, kind: 'invalid_email', message: `Email「${email}」格式不對，已留白`, action: 'warning' })
      email = null
    }

    candidates.push({
      line: row.line,
      studentNo,
      nameRaw,
      nameNormalized: normalizeName(nameRaw),
      departmentClass: cell(row.cells, 'department_class').replace(/\s+/g, ' ') || null,
      email,
      cohortRaw: cell(row.cells, 'cohort') || null,
    })
  }

  // 去重依學號（模組 01 §2.4）：同學號同姓名＝重複，留第一列；同學號不同姓名＝衝突，整組不匯入。
  // 不因正規化後姓名相同就合併兩個學生——比的是學號，姓名只用來判斷是不是衝突。
  const groups = new Map<string, RosterEntryDraft[]>()
  for (const candidate of candidates) {
    const key = candidate.studentNo.toUpperCase()
    const group = groups.get(key)
    if (group) group.push(candidate)
    else groups.set(key, [candidate])
  }

  const entries: RosterEntryDraft[] = []
  let duplicate = 0
  let conflict = 0
  for (const group of groups.values()) {
    const names = new Set(group.map((g) => g.nameNormalized))
    if (names.size > 1) {
      conflict += group.length
      const listed = [...new Set(group.map((g) => g.nameRaw))].join('／')
      for (const g of group) {
        issues.push({ line: g.line, studentNo: g.studentNo, kind: 'name_mismatch', message: `同學號但姓名不同（${listed}），整組不匯入`, action: 'skipped' })
      }
      continue
    }
    const [first, ...rest] = group
    entries.push(first!)
    for (const g of rest) {
      duplicate += 1
      issues.push({ line: g.line, studentNo: g.studentNo, kind: 'duplicate', message: `學號重複（第 ${first!.line} 行已有）`, action: 'skipped' })
    }
  }
  entries.sort((a, b) => a.line - b.line)

  // 屆別欄：列出每個出現過的值與它對到的既有屆別。
  const valueCounts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.cohortRaw) valueCounts.set(entry.cohortRaw, (valueCounts.get(entry.cohortRaw) ?? 0) + 1)
  }
  const cohortValues: CohortValueMatch[] = [...valueCounts.entries()].map(([value, rows]) => ({
    value,
    rows,
    cohortId: matchCohort(value, cohorts)?.id ?? null,
  }))
  const matchedIds = new Set(cohortValues.map((v) => v.cohortId))
  const suggestedCohortId =
    cohortValues.length > 0 && matchedIds.size === 1 && !matchedIds.has(null) ? [...matchedIds][0]! : null

  // 屆別欄與所選屆別不同的列：照樣匯入到所選屆別，只算數量。
  // 不逐列列出——整份名單屆別欄都是同一個對不到的值時，逐列提醒只會把真正要看的問題淹掉；
  // 畫面用 `cohortValues` 按「值」彙總顯示。
  const cohortMismatch = selectedCohortId
    ? cohortValues.filter((v) => v.cohortId !== selectedCohortId).reduce((sum, v) => sum + v.rows, 0)
    : 0

  issues.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind))

  return {
    ok: true,
    analysis: {
      columns: {
        cohort: positions.has('cohort'),
        email: positions.has('email'),
        departmentClass: positions.has('department_class'),
      },
      counts: {
        total: dataRows.length,
        valid: entries.length,
        duplicate,
        missing,
        conflict,
        cohortMismatch,
        invalidEmail,
      },
      issues,
      entries,
      cohortValues,
      suggestedCohortId,
    },
  }
}

/**
 * 預覽時預設選哪一屆：CSV 屆別欄的建議 → 開放註冊中的屆別 → 預設工作屆別 → 不預選。
 * 指定的屆別不存在時當作沒指定。
 */
export function pickCohort(
  requested: string | null,
  suggested: string | null,
  cohorts: readonly CohortOption[],
): string | null {
  if (requested && cohorts.some((c) => c.id === requested)) return requested
  if (suggested) return suggested
  return cohorts.find((c) => c.isRegistrationOpen)?.id ?? cohorts.find((c) => c.isDefaultWorking)?.id ?? null
}

// ── 授權 ────────────────────────────────────────────────────────────────────

/** 名單匯入、預覽、版本列表與原檔下載：只有狀態正常的管理員（契約 03 §1「帳號」列）。 */
export function rosterAccessDenied(actor: ResolvedActor): ErrorCode | null {
  const blocked = statusGate(actor, 'business')
  if (blocked) return blocked
  return hasRole(actor, 'admin') ? null : 'FORBIDDEN'
}

// ── port ────────────────────────────────────────────────────────────────────

export type RosterUploadTicket = {
  readonly ticket: string
  readonly fileId: string
  readonly maxBytes: number
  readonly expiresAt: string
}

/** 預覽畫面要的東西。完整的列只在伺服器端，畫面只拿前幾列看樣子。 */
export type RosterPreview = {
  readonly fileId: string
  readonly fileName: string
  readonly checksum: string
  readonly columns: RosterAnalysis['columns']
  readonly counts: RosterCounts
  readonly issues: readonly RosterIssue[]
  readonly issuesTruncated: boolean
  readonly sample: readonly Omit<RosterEntryDraft, 'nameNormalized'>[]
  readonly cohorts: readonly CohortOption[]
  readonly cohortValues: readonly CohortValueMatch[]
  readonly selectedCohortId: string | null
}

export type RosterImportReceipt = {
  readonly rosterVersionId: string
  readonly cohortId: string
  readonly cohortName: string
  readonly counts: RosterCounts
  readonly importedAt: string
}

export type RosterVersionRow = {
  readonly id: string
  readonly cohortCode: string
  readonly cohortName: string
  readonly importedBy: string
  readonly importedAt: string
  readonly counts: RosterCounts
  readonly fileId: string | null
  readonly fileName: string | null
}

export type RosterCommand = {
  /** 管理員要上傳一份名單：先拿 ticket（建 `uploading` 檔案列）。 */
  startUpload(
    actor: ResolvedActor,
    input: { fileName: string; declaredMime: string; declaredSize: number },
  ): Promise<Result<RosterUploadTicket>>
  /** 讀自己剛上傳的原檔做預覽；不寫任何名單資料。 */
  preview(actor: ResolvedActor, input: { fileId: string; cohortId: string | null }): Promise<Result<RosterPreview>>
  /** 確認後一次匯入（整批一交易；同一個 requestId 重送回同一個版本）。 */
  importRoster(
    actor: ResolvedActor,
    input: { fileId: string; cohortId: string; requestId: string },
  ): Promise<Result<RosterImportReceipt>>
  /** 名單版本列表（誰、何時、哪一屆、幾筆、原檔）。 */
  listVersions(actor: ResolvedActor): Promise<Result<{ versions: readonly RosterVersionRow[] }>>
}
