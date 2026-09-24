import { parseCsv } from '@/shared/csv'

/**
 * 指導老師指派、認領與重派的型別與純規則（票 19；產品模組 03 §4「5.4 指導老師規則」「行政指派的輸入」）。
 *
 * - 產學組（`industry`）尚未指派時，老師可以按「指定為我的組別」認領；兩位同時按只有一位成功。
 * - 一般組（`general`）由管理員依抽籤／行政結果指派，老師不能自己認領。
 * - 管理員可逐組指派、重派、解除（理由必填）；也可上傳 `group_code,teacher_login_email` CSV 批次指派。
 * - 每組同時只有一位有效主指導；重派是結束舊的、插一列新的，歷史保留。
 * - 重派時先列原老師在本組的評分指派（票 23 接上評分模組的查詢）；只列、不移轉，
 *   新主指導不自動取得評分權限（勾選處理評分指派在票 24）。
 *
 * 這個檔沒有資料庫：CSV 怎麼拆、每一列分到六類的哪一類、能不能執行，都在這裡單獨測。
 */

export type AdvisorSource = 'claim' | 'admin' | 'csv'

export const ADVISOR_SOURCE_LABEL: Record<AdvisorSource, string> = {
  claim: '老師認領',
  admin: '系辦指派',
  csv: '系辦批次指派',
}

/** 組別目前的主指導（查詢用）。 */
export type AdvisorInfo = {
  readonly teacherUserId: string
  readonly teacherName: string
  readonly source: AdvisorSource
  /** 業務時間。 */
  readonly since: Date
}

/** 管理員指派對話框的老師選項：有效、目前是老師的帳號。 */
export type TeacherOption = {
  readonly userId: string
  readonly name: string
  readonly loginEmail: string
}

/**
 * 原老師在本組的評分指派（重派對話框要先列出來；模組 06 的 `AssignmentsForTeacherQuery.listForGroup`，票 23）。
 * 欄位照產品「至少顯示階段與未填／暫存／已正式送出」。
 */
export type GradingAssignmentSummary = {
  readonly id: string
  readonly stageName: string
  readonly state: 'empty' | 'draft' | 'submitted'
}

// ── 逐組指派、認領、解除的輸入與回執 ──────────────────────────────────────────

export type ClaimInput = { readonly groupId: string }

export type AssignAdvisorInput = {
  readonly groupId: string
  /** 管理員看到的組別版本（`groups.revision`）；別人先改過（含老師剛認領）就 `CONFLICT`。 */
  readonly revision: number
  readonly teacherUserId: string
  readonly reason: string
  /** 重派時勾選要一併處理的評分指派 id。處理方式（保留／替換／新增）在票 24，現在只能是空的。 */
  readonly gradingSelections: readonly string[]
}

export type UnassignAdvisorInput = {
  readonly groupId: string
  readonly revision: number
  readonly reason: string
}

export type AdvisorChangeKind = 'claimed' | 'assigned' | 'reassigned' | 'unassigned'

export type AdvisorChangeReceipt = {
  readonly groupId: string
  readonly groupCode: string
  readonly change: AdvisorChangeKind
  /** 新的主指導；解除時是 null。 */
  readonly teacherName: string | null
  /** 原本的主指導（重派、解除時）；首次指派是 null。 */
  readonly previousTeacherName: string | null
}

export function describeAdvisorChangeReceipt(receipt: AdvisorChangeReceipt): string {
  switch (receipt.change) {
    case 'claimed':
      return `${receipt.groupCode} 已指定為你的組別；全組已收到通知。`
    case 'assigned':
      return `已指派 ${receipt.teacherName} 老師指導 ${receipt.groupCode}；全組與老師已收到通知。`
    case 'reassigned':
      return `${receipt.groupCode} 的指導老師已從 ${receipt.previousTeacherName} 換成 ${receipt.teacherName}；全組、新老師與原老師都已收到通知。評分指派沒有變動。`
    case 'unassigned':
      return `已解除 ${receipt.previousTeacherName} 老師對 ${receipt.groupCode} 的指導；全組與原老師已收到通知。`
  }
}

// ── 批次指派 CSV ─────────────────────────────────────────────────────────────

/** 固定兩欄（產品「行政指派的輸入」）；順序不拘，靠表頭對。 */
export const ADVISOR_CSV_COLUMNS = ['group_code', 'teacher_login_email'] as const
type AdvisorCsvColumn = (typeof ADVISOR_CSV_COLUMNS)[number]

/** 一屆幾十組，一列不到 100 字元；256 KiB、1000 列都綽綽有餘。 */
export const ADVISOR_CSV_MAX_BYTES = 256 * 1024
export const ADVISOR_CSV_MAX_ROWS = 1000
export const ADVISOR_CSV_MAX_CELL_LENGTH = 200
/** 固定兩欄，給一點餘裕讓「欄位比表頭多」能報出行號；超過就整份退件。 */
export const ADVISOR_CSV_MAX_CELLS_PER_ROW = 10

/**
 * 預覽的六類（產品「行政指派的輸入」）。前三類可以執行，後三類是錯誤——有任何一列錯誤就不能執行，
 * 要先修正檔案重新上傳（「有錯先修正，再整批確認執行」）。
 */
export type AdvisorBatchKind = 'new' | 'unchanged' | 'reassign' | 'group_missing' | 'teacher_missing' | 'duplicate'

export const ADVISOR_BATCH_KINDS: readonly AdvisorBatchKind[] = [
  'new',
  'unchanged',
  'reassign',
  'group_missing',
  'teacher_missing',
  'duplicate',
]

export const ADVISOR_BATCH_KIND_LABEL: Record<AdvisorBatchKind, string> = {
  new: '可新增指派',
  unchanged: '不需變更',
  reassign: '屬於重派',
  group_missing: '組別不存在',
  teacher_missing: '老師不存在',
  duplicate: '重複',
}

export function isBatchError(kind: AdvisorBatchKind): boolean {
  return kind === 'group_missing' || kind === 'teacher_missing' || kind === 'duplicate'
}

/** 分析時要的組別資料（所選屆別內，依代碼）。 */
export type BatchGroupFact = {
  readonly id: string
  readonly code: string
  readonly status: 'active' | 'dissolved'
  readonly revision: number
  readonly advisor: { readonly teacherUserId: string; readonly teacherName: string } | null
}

/** 分析時要的老師資料：登入 Email（小寫）→ 帳號。停用或不再是老師的也要查得到，才能說清楚原因。 */
export type BatchTeacherFact = {
  readonly userId: string
  readonly name: string
  readonly loginEmail: string
  /** 帳號正常而且目前有老師角色。 */
  readonly eligible: boolean
}

export type BatchLookup = {
  readonly groupsByCode: ReadonlyMap<string, BatchGroupFact>
  /** key 是小寫的登入 Email。 */
  readonly teachersByLoginEmail: ReadonlyMap<string, BatchTeacherFact>
  /** key 是小寫的聯絡 Email（只拿來提醒「這是聯絡 Email，要用登入 Email」）。 */
  readonly teacherLoginByContactEmail: ReadonlyMap<string, string>
}

export type AdvisorBatchRow = {
  /** 檔案裡的實體行號（表頭是第 1 行）。 */
  readonly line: number
  readonly groupCode: string
  readonly teacherEmail: string
  readonly kind: AdvisorBatchKind
  /** 給人看的一句話（為什麼是這一類）。 */
  readonly message: string
  readonly groupId: string | null
  /** 預覽當下的組別版本；執行時用它判斷有沒有人改過（`CONFLICT`）。 */
  readonly groupRevision: number | null
  readonly teacherUserId: string | null
  readonly teacherName: string | null
  /** 目前的主指導（重派、不需變更時）。 */
  readonly currentTeacherName: string | null
}

export type AdvisorBatchCounts = Readonly<Record<AdvisorBatchKind, number>> & { readonly total: number }

export type AdvisorBatchAnalysis = {
  readonly rows: readonly AdvisorBatchRow[]
  readonly counts: AdvisorBatchCounts
}

/** 整份檔案看不懂（表頭、引號、大小）。逐列的問題不在這裡，在六類裡。 */
export type AdvisorCsvFormatError = { readonly ok: false; readonly message: string }

const HEADER_ALIASES: Record<string, AdvisorCsvColumn> = {
  group_code: 'group_code',
  teacher_login_email: 'teacher_login_email',
  組別: 'group_code',
  組別代碼: 'group_code',
  老師登入email: 'teacher_login_email',
}

/** 組別代碼比對：去空白、英文大寫（G01、g01 是同一組）。 */
export function normalizeGroupCode(raw: string): string {
  return raw.trim().toUpperCase()
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * 分析一份批次指派 CSV。預覽與執行用**同一個函式**分析伺服器上同一份原檔，「看到的」就是「執行的」；
 * 執行時另外用每列的 `groupRevision` 核對資料在預覽之後有沒有被改過。
 *
 * 判斷順序：組別不存在（或已解散）→ 同一組在檔案裡出現兩次以上（每一列都標重複）→ 老師不存在或停用
 * → 目前沒有主指導＝可新增、同一位＝不需變更、不同位＝重派。
 */
export function analyzeAdvisorCsv(text: string, lookup: BatchLookup): { ok: true; analysis: AdvisorBatchAnalysis } | AdvisorCsvFormatError {
  const parsed = parseCsv(text, {
    maxCellLength: ADVISOR_CSV_MAX_CELL_LENGTH,
    maxRows: ADVISOR_CSV_MAX_ROWS + 1,
    maxCellsPerRow: ADVISOR_CSV_MAX_CELLS_PER_ROW,
  })
  if (!parsed.ok) {
    const reasons: Record<typeof parsed.reason, string> = {
      unterminated_quote: `第 ${parsed.line} 行的引號沒有收尾。`,
      stray_quote: `第 ${parsed.line} 行有多餘的引號。`,
      cell_too_long: `第 ${parsed.line} 行有欄位超過 ${ADVISOR_CSV_MAX_CELL_LENGTH} 個字。`,
      too_many_rows: `超過 ${ADVISOR_CSV_MAX_ROWS} 列，請分批上傳。`,
      too_many_cells: `第 ${parsed.line} 行的欄位超過 ${ADVISOR_CSV_MAX_CELLS_PER_ROW} 欄，檔案格式不對。`,
    }
    return { ok: false, message: reasons[parsed.reason] }
  }

  const [header, ...dataRows] = parsed.rows
  const expected = 'group_code,teacher_login_email'
  if (!header) return { ok: false, message: `檔案是空的，第一行要是表頭 ${expected}。` }

  const positions = new Map<AdvisorCsvColumn, number>()
  for (const [index, rawName] of header.cells.entries()) {
    const key = rawName.trim().toLowerCase().replaceAll(' ', '')
    const column = HEADER_ALIASES[key]
    if (!column) return { ok: false, message: `表頭有不認得的欄位「${rawName.trim()}」。欄位固定為 ${expected}。` }
    if (positions.has(column)) return { ok: false, message: `表頭的「${column}」出現了兩次。` }
    positions.set(column, index)
  }
  for (const required of ADVISOR_CSV_COLUMNS) {
    if (!positions.has(required)) return { ok: false, message: `表頭少了「${required}」。欄位固定為 ${expected}。` }
  }
  if (dataRows.length === 0) return { ok: false, message: '檔案只有表頭，沒有任何要指派的組別。' }

  for (const row of dataRows) {
    if (row.cells.length !== header.cells.length) {
      return { ok: false, message: `第 ${row.line} 行有 ${row.cells.length} 欄，表頭是 ${header.cells.length} 欄；請檢查是不是多了逗號。` }
    }
  }

  const cell = (cells: readonly string[], column: AdvisorCsvColumn) => (cells[positions.get(column)!] ?? '').trim()
  const occurrences = new Map<string, number>()
  for (const row of dataRows) {
    const code = normalizeGroupCode(cell(row.cells, 'group_code'))
    if (code) occurrences.set(code, (occurrences.get(code) ?? 0) + 1)
  }

  const rows = dataRows.map((row): AdvisorBatchRow => {
    const groupCode = cell(row.cells, 'group_code')
    const teacherEmail = cell(row.cells, 'teacher_login_email')
    const code = normalizeGroupCode(groupCode)
    const group = code ? lookup.groupsByCode.get(code) : undefined
    const base = {
      line: row.line,
      groupCode,
      teacherEmail,
      groupId: null,
      groupRevision: null,
      teacherUserId: null,
      teacherName: null,
      currentTeacherName: null,
    }

    if (!code) return { ...base, kind: 'group_missing', message: '沒有填組別代碼。' }
    if (!group) return { ...base, kind: 'group_missing', message: `本屆沒有組別「${groupCode}」（可能還沒成立）。` }
    const withGroup = {
      ...base,
      groupId: group.id,
      groupRevision: group.revision,
      currentTeacherName: group.advisor?.teacherName ?? null,
    }
    if (group.status === 'dissolved') return { ...withGroup, kind: 'group_missing', message: `${group.code} 已解散，不能指派。` }
    if ((occurrences.get(code) ?? 0) > 1) {
      return { ...withGroup, kind: 'duplicate', message: `${group.code} 在檔案裡出現了 ${occurrences.get(code)} 次，一組只能留一列。` }
    }

    const email = normalizeEmail(teacherEmail)
    if (!email) return { ...withGroup, kind: 'teacher_missing', message: '沒有填老師的登入 Email。' }
    const teacher = lookup.teachersByLoginEmail.get(email)
    if (!teacher) {
      const login = lookup.teacherLoginByContactEmail.get(email)
      return {
        ...withGroup,
        kind: 'teacher_missing',
        message: login
          ? `「${teacherEmail}」是老師的聯絡 Email，請改用登入 Email（${login}）。`
          : `找不到登入 Email 是「${teacherEmail}」的老師。`,
      }
    }
    const withTeacher = { ...withGroup, teacherUserId: teacher.userId, teacherName: teacher.name }
    if (!teacher.eligible) {
      return { ...withTeacher, kind: 'teacher_missing', message: `${teacher.name}（${teacher.loginEmail}）的帳號已停用或不再是老師。` }
    }

    if (!group.advisor) return { ...withTeacher, kind: 'new', message: `指派 ${teacher.name} 老師。` }
    if (group.advisor.teacherUserId === teacher.userId) {
      return { ...withTeacher, kind: 'unchanged', message: `已經是 ${teacher.name} 老師，不需變更。` }
    }
    return {
      ...withTeacher,
      kind: 'reassign',
      message: `目前是 ${group.advisor.teacherName} 老師，會重派給 ${teacher.name} 老師。`,
    }
  })

  const counts = Object.fromEntries(ADVISOR_BATCH_KINDS.map((k) => [k, rows.filter((r) => r.kind === k).length])) as Record<
    AdvisorBatchKind,
    number
  >
  return { ok: true, analysis: { rows, counts: { ...counts, total: rows.length } } }
}

/** 執行時每一列要做什麼：`apply` 指派或重派、`unchanged` 不動、`conflict` 預覽後被改過（不動、要重新預覽）。 */
export type BatchStep = { readonly row: AdvisorBatchRow; readonly action: 'apply' | 'unchanged' | 'conflict' }

/**
 * 執行前的整批判斷（產品「有錯先修正，再整批確認執行；重派要明確確認並留理由；執行時若資料已被別人修改，
 * 拒絕該筆衝突並要求重新預覽，不能用舊預覽覆蓋新指派」）。
 *
 * `analysis` 是執行當下重新分析同一份原檔的結果；`revisions` 是預覽當下每組的版本。
 * 版本對不上（或預覽沒看到這組）的列一律 `conflict`——就算它現在看起來「可新增」，也可能是別人剛解除，
 * 不能用舊預覽決定。重派只要求確認「預覽時就看到的重派」；預覽後才變成重派的那一列本來就是 `conflict`。
 */
export function planBatch(
  analysis: AdvisorBatchAnalysis,
  input: { readonly reason: string; readonly confirmReassign: boolean; readonly revisions: Readonly<Record<string, number>> },
): { ok: true; steps: readonly BatchStep[] } | { ok: false; message: string } {
  const errors = analysis.rows.filter((r) => isBatchError(r.kind)).length
  if (errors > 0) {
    return { ok: false, message: `還有 ${errors} 列錯誤（組別不存在、老師不存在或重複），請修正檔案後重新上傳預覽。` }
  }
  if (!input.reason.trim()) return { ok: false, message: '批次指派一定要填理由（例如「115 學年抽籤結果」）。' }

  const steps = analysis.rows.map((row): BatchStep => {
    const expected = row.groupId ? input.revisions[row.groupId] : undefined
    if (expected === undefined || expected !== row.groupRevision) return { row, action: 'conflict' }
    return { row, action: row.kind === 'unchanged' ? 'unchanged' : 'apply' }
  })
  const reassigns = steps.filter((s) => s.action === 'apply' && s.row.kind === 'reassign').length
  if (reassigns > 0 && !input.confirmReassign) {
    return { ok: false, message: `有 ${reassigns} 組屬於重派，請勾選「確認重派」。` }
  }
  if (!steps.some((s) => s.action !== 'unchanged')) return { ok: false, message: '這份檔案沒有需要變更的組別。' }
  return { ok: true, steps }
}

export type AdvisorBatchOutcome = 'assigned' | 'reassigned' | 'unchanged' | 'conflict' | 'failed'

export const ADVISOR_BATCH_OUTCOME_LABEL: Record<AdvisorBatchOutcome, string> = {
  assigned: '已指派',
  reassigned: '已重派',
  unchanged: '不需變更',
  conflict: '預覽後被改過，未執行',
  failed: '未執行',
}

export type AdvisorBatchRowResult = {
  readonly line: number
  readonly groupCode: string
  readonly teacherName: string | null
  readonly outcome: AdvisorBatchOutcome
  readonly message: string
}

export type AdvisorBatchReceipt = {
  readonly cohortId: string
  readonly fileName: string
  readonly results: readonly AdvisorBatchRowResult[]
  readonly counts: Readonly<Record<AdvisorBatchOutcome, number>>
}

export function describeAdvisorBatchReceipt(receipt: AdvisorBatchReceipt): string {
  const { assigned, reassigned, conflict, failed } = receipt.counts
  const done = `批次指派完成：新增 ${assigned} 組、重派 ${reassigned} 組`
  const skipped = conflict + failed
  return skipped > 0
    ? `${done}；${skipped} 組在預覽後被別人改過或無法執行，沒有動，請重新上傳預覽。`
    : `${done}。有變更的組別與老師都已收到通知。`
}

export type AdvisorUploadTicket = {
  readonly ticket: string
  readonly fileId: string
  readonly maxBytes: number
  readonly expiresAt: string
}

/** 預覽畫面要的東西：每一列都回（一屆幾十組）。 */
export type AdvisorBatchPreview = {
  readonly fileId: string
  readonly fileName: string
  readonly cohortId: string
  readonly rows: readonly AdvisorBatchRow[]
  readonly counts: AdvisorBatchCounts
}

export type ExecuteBatchInput = {
  readonly fileId: string
  readonly cohortId: string
  readonly reason: string
  readonly confirmReassign: boolean
  /** 預覽當下每組的版本（groupId → revision）；執行時不符的那一列 `CONFLICT`。 */
  readonly revisions: Readonly<Record<string, number>>
}
