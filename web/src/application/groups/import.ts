import type { ResolvedActor } from '@/application/accounts'
import type { GroupType } from '@/application/groups/proposals'
import { parseCsv, toCsvLine } from '@/shared/csv'
import type { Result } from '@/shared/result'

/**
 * 系辦匯入分組（C3-16；設計方案③ §6.4、AC-C3-21、22）。
 *
 * CSV 欄位 `學號,組別代碼,類型`：同一個組別代碼多列＝多個組員；代碼不存在就建新組（第一個出現的學號是組長），
 * 存在就加人。預覽把每一列分到六類（照批次指派指導老師的做法），執行只做 `create`、`add` 兩類，其他列跳過並寫原因。
 *
 * 這個檔沒有資料庫：CSV 怎麼拆、每一列分到哪一類、執行時怎麼分組，都在這裡單獨測。
 */

export const GROUP_IMPORT_COLUMNS = ['學號', '組別代碼', '類型'] as const
type GroupImportColumn = (typeof GROUP_IMPORT_COLUMNS)[number]

/** 原檔大小上限（UTF-8，BOM 可有可無）。 */
export const GROUP_IMPORT_MAX_BYTES = 256 * 1024
export const GROUP_IMPORT_MAX_ROWS = 1000
const MAX_CELL_LENGTH = 200
const MAX_CELLS_PER_ROW = 10

/** CSV 的代碼必須像 G01（設計方案 §6.4「代碼規則」）。 */
const CODE_PATTERN = /^G\d{2}$/

/** 「類型」欄可以填的字；空白＝一般。 */
const TYPE_ALIASES: Record<string, GroupType> = { 一般: 'general', 產學: 'industry', 一般專題: 'general', 產學合作: 'industry' }

export type GroupImportKind = 'create' | 'add' | 'skip_same' | 'conflict_other_group' | 'conflict_proposal' | 'invalid'

export const GROUP_IMPORT_KINDS: readonly GroupImportKind[] = [
  'create',
  'add',
  'skip_same',
  'conflict_other_group',
  'conflict_proposal',
  'invalid',
]

export const GROUP_IMPORT_KIND_LABEL: Record<GroupImportKind, string> = {
  create: '建新組',
  add: '加入既有組',
  skip_same: '已在這組',
  conflict_other_group: '已在別組',
  conflict_proposal: '在建立中的組別',
  invalid: '無法匯入',
}

/** 本屆一位學生（已核准、帳號正常、目前是學生）。 */
export type ImportStudentFact = {
  readonly userId: string
  readonly name: string
  /** 目前所在組別的代碼；沒有組就是 null。 */
  readonly groupCode: string | null
  /** 正在某個建立中的組別裡（發起人姓名）；沒有就是 null。 */
  readonly proposerName: string | null
}

export type ImportGroupFact = {
  readonly id: string
  readonly code: string
  readonly status: 'active' | 'dissolved'
  readonly memberCount: number
}

export type GroupImportLookup = {
  readonly studentsByNo: ReadonlyMap<string, ImportStudentFact>
  readonly groupsByCode: ReadonlyMap<string, ImportGroupFact>
  /** 屆別設定的每組人數上限。 */
  readonly sizeMax: number
}

export type GroupImportRow = {
  /** 原檔的行號（從 1 起算，表頭是第 1 行）。 */
  readonly line: number
  readonly studentNo: string
  /** 正規化後的代碼（去空白、大寫）；沒填就是空字串。 */
  readonly groupCode: string
  readonly kind: GroupImportKind
  readonly message: string
  readonly studentName: string | null
  /** `create` 列：新組的類型；其他列 null。 */
  readonly groupType: GroupType | null
  /** `create` 列：這位是不是新組的組長（第一個出現的學號）。 */
  readonly leader: boolean
}

export type GroupImportCounts = Readonly<Record<GroupImportKind, number>> & { readonly total: number }

export type GroupImportAnalysis = {
  readonly rows: readonly GroupImportRow[]
  readonly counts: GroupImportCounts
}

const HEADER_ALIASES: Record<string, GroupImportColumn> = {
  學號: '學號',
  student_no: '學號',
  組別代碼: '組別代碼',
  組別: '組別代碼',
  group_code: '組別代碼',
  類型: '類型',
  group_type: '類型',
}

export function normalizeImportCode(raw: string): string {
  return raw.trim().toUpperCase()
}

/**
 * 分析一份分組匯入 CSV。預覽與執行用同一個函式分析伺服器上同一份原檔（執行時資料是當下的），
 * 「看到的」就是「執行的」。
 *
 * 每列判斷順序：沒填學號 → 代碼格式 → 類型 → 同一學號出現兩次以上 → 不在本屆名單 → 代碼是已刪除的組
 * → 已在這組（`skip_same`）→ 在別組 → 在建立中的組別 → 代碼存在＝加人、不存在＝建新組。
 * 最後同一個代碼要加進去的人數（加上既有組員）超過每組上限時，那個代碼的建組／加人列全部改成 `invalid`。
 */
export function analyzeGroupImportCsv(
  text: string,
  lookup: GroupImportLookup,
): { ok: true; analysis: GroupImportAnalysis } | { ok: false; message: string } {
  const parsed = parseCsv(text, {
    maxCellLength: MAX_CELL_LENGTH,
    maxRows: GROUP_IMPORT_MAX_ROWS + 1,
    maxCellsPerRow: MAX_CELLS_PER_ROW,
  })
  if (!parsed.ok) {
    const reasons: Record<typeof parsed.reason, string> = {
      unterminated_quote: `第 ${parsed.line} 行的引號沒有收尾。`,
      stray_quote: `第 ${parsed.line} 行有多餘的引號。`,
      cell_too_long: `第 ${parsed.line} 行有欄位超過 ${MAX_CELL_LENGTH} 個字。`,
      too_many_rows: `超過 ${GROUP_IMPORT_MAX_ROWS} 列，請分批上傳。`,
      too_many_cells: `第 ${parsed.line} 行的欄位超過 ${MAX_CELLS_PER_ROW} 欄，檔案格式不對。`,
    }
    return { ok: false, message: reasons[parsed.reason] }
  }

  const expected = GROUP_IMPORT_COLUMNS.join(',')
  const [header, ...dataRows] = parsed.rows
  if (!header) return { ok: false, message: `檔案是空的，第一行要是表頭 ${expected}。` }
  const positions = new Map<GroupImportColumn, number>()
  for (const [index, rawName] of header.cells.entries()) {
    const column = HEADER_ALIASES[rawName.trim().toLowerCase().replaceAll(' ', '')]
    if (!column) return { ok: false, message: `表頭有不認得的欄位「${rawName.trim()}」。欄位固定為 ${expected}。` }
    if (positions.has(column)) return { ok: false, message: `表頭的「${column}」出現了兩次。` }
    positions.set(column, index)
  }
  for (const required of ['學號', '組別代碼'] as const) {
    if (!positions.has(required)) return { ok: false, message: `表頭少了「${required}」。欄位固定為 ${expected}（類型可省略）。` }
  }
  if (dataRows.length === 0) return { ok: false, message: '檔案只有表頭，沒有任何要匯入的學生。' }

  const cell = (cells: readonly string[], column: GroupImportColumn) => {
    const at = positions.get(column)
    return at === undefined ? '' : (cells[at] ?? '').trim()
  }
  const occurrences = new Map<string, number>()
  for (const row of dataRows) {
    const no = cell(row.cells, '學號')
    if (no) occurrences.set(no, (occurrences.get(no) ?? 0) + 1)
  }

  // 新組的類型：同一個代碼第一個有填類型的那列決定（都沒填＝一般）。
  const typeOfNewCode = new Map<string, GroupType>()

  const first = dataRows.map((row): GroupImportRow => {
    const studentNo = cell(row.cells, '學號')
    const groupCode = normalizeImportCode(cell(row.cells, '組別代碼'))
    const rawTypeText = cell(row.cells, '類型')
    const base = { line: row.line, studentNo, groupCode, studentName: null, groupType: null, leader: false }
    const invalid = (message: string) => ({ ...base, kind: 'invalid' as const, message })

    if (!studentNo) return invalid('沒有填學號')
    if (!CODE_PATTERN.test(groupCode)) return invalid('代碼格式要像 G01')
    const rawType = rawTypeText ? (TYPE_ALIASES[rawTypeText] ?? undefined) : null
    if (rawType === undefined) return invalid('類型只能填「一般」或「產學」')
    if ((occurrences.get(studentNo) ?? 0) > 1) return invalid(`學號在檔案裡出現了 ${occurrences.get(studentNo)} 次，一人只能留一列`)
    const student = lookup.studentsByNo.get(studentNo)
    if (!student) return invalid('不在本屆名單')
    const named = { ...base, studentName: student.name }
    const group = lookup.groupsByCode.get(groupCode)
    if (group?.status === 'dissolved') return { ...named, kind: 'invalid', message: `${groupCode} 已刪除，請換一個代碼` }
    if (student.groupCode === groupCode) return { ...named, kind: 'skip_same', message: `已在 ${groupCode}` }
    if (student.groupCode) return { ...named, kind: 'conflict_other_group', message: `已在 ${student.groupCode}` }
    if (student.proposerName !== null) return { ...named, kind: 'conflict_proposal', message: '在建立中的組別裡，請先終止' }
    if (group) return { ...named, kind: 'add', message: `加入 ${groupCode}` }
    if (rawType && !typeOfNewCode.has(groupCode)) typeOfNewCode.set(groupCode, rawType)
    return { ...named, kind: 'create', message: '' }
  })

  // 人數上限：既有組員＋這份檔案要放進去的人。
  const incoming = new Map<string, number>()
  for (const row of first) {
    if (row.kind === 'create' || row.kind === 'add') incoming.set(row.groupCode, (incoming.get(row.groupCode) ?? 0) + 1)
  }
  const leaders = new Set<string>()
  const rows = first.map((row): GroupImportRow => {
    if (row.kind !== 'create' && row.kind !== 'add') return row
    const existing = lookup.groupsByCode.get(row.groupCode)?.memberCount ?? 0
    if (existing + (incoming.get(row.groupCode) ?? 0) > lookup.sizeMax) {
      return { ...row, kind: 'invalid', message: `超過每組 ${lookup.sizeMax} 人` }
    }
    if (row.kind === 'add') return row
    const groupType = typeOfNewCode.get(row.groupCode) ?? 'general'
    const leader = !leaders.has(row.groupCode)
    leaders.add(row.groupCode)
    const typeText = groupType === 'industry' ? '產學' : '一般'
    return { ...row, groupType, leader, message: `建新組 ${row.groupCode}（${typeText}）${leader ? '・組長' : ''}` }
  })

  const counts = Object.fromEntries(GROUP_IMPORT_KINDS.map((k) => [k, rows.filter((r) => r.kind === k).length])) as Record<
    GroupImportKind,
    number
  >
  return { ok: true, analysis: { rows, counts: { ...counts, total: rows.length } } }
}

/** 執行時要建的一組：組長排第一。 */
export type GroupImportCreatePlan = {
  readonly code: string
  readonly groupType: GroupType
  readonly rows: readonly GroupImportRow[]
}

/**
 * 執行計畫：要建的新組（每組一個交易，組長在前）、要加的人（每列一個交易）、其他列直接跳過。
 * 新組先建、再加人（同一份檔不會對同一個代碼既建又加：代碼存在就全是 `add`）。
 */
export function planGroupImport(analysis: GroupImportAnalysis): {
  creates: readonly GroupImportCreatePlan[]
  adds: readonly GroupImportRow[]
  skipped: readonly GroupImportRow[]
} {
  const creates = new Map<string, GroupImportRow[]>()
  const adds: GroupImportRow[] = []
  const skipped: GroupImportRow[] = []
  for (const row of analysis.rows) {
    if (row.kind === 'create') {
      const list = creates.get(row.groupCode) ?? []
      if (row.leader) list.unshift(row)
      else list.push(row)
      creates.set(row.groupCode, list)
    } else if (row.kind === 'add') adds.push(row)
    else skipped.push(row)
  }
  return {
    creates: [...creates.entries()].map(([code, rows]) => ({ code, groupType: rows[0]!.groupType ?? 'general', rows })),
    adds,
    skipped,
  }
}

// ── 執行結果 ──────────────────────────────────────────────────────────────────

export type GroupImportOutcome = 'created' | 'added' | 'skipped' | 'failed'

export const GROUP_IMPORT_OUTCOME_LABEL: Record<GroupImportOutcome, string> = {
  created: '已建組',
  added: '已加入',
  skipped: '跳過',
  failed: '沒有成功',
}

export type GroupImportRowResult = {
  readonly line: number
  readonly studentNo: string
  readonly groupCode: string
  readonly studentName: string | null
  readonly outcome: GroupImportOutcome
  readonly message: string
}

export type GroupImportReceipt = {
  readonly cohortId: string
  readonly fileName: string
  /** 依原檔行號排序。 */
  readonly results: readonly GroupImportRowResult[]
  /** 新成立的組數（不是列數）。 */
  readonly createdGroups: number
  readonly added: number
  readonly skipped: number
  readonly failed: number
}

export function describeGroupImportReceipt(receipt: GroupImportReceipt): string {
  const done = `已匯入：新組 ${receipt.createdGroups}、加入 ${receipt.added}`
  const rest = receipt.skipped + receipt.failed
  return rest > 0 ? `${done}；${rest} 列沒有匯入，原因寫在結果表。` : `${done}。`
}

/** 結果表（可下載）：每列原檔行號、學號、姓名、組別代碼、結果、說明。 */
export function groupImportResultCsv(receipt: GroupImportReceipt): string {
  const lines = [
    toCsvLine(['行號', '學號', '姓名', '組別代碼', '結果', '說明']),
    ...receipt.results.map((r) =>
      toCsvLine([r.line, r.studentNo, r.studentName ?? '', r.groupCode, GROUP_IMPORT_OUTCOME_LABEL[r.outcome], r.message]),
    ),
  ]
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/**
 * 範本：表頭＋兩組示範（第一個學號是組長、類型可省略）。對話框的「下載範本」連 `public/samples/分組匯入範例.csv`
 * （同樣的表頭，學號換成示範資料裡的未分組學生）。
 */
export function groupImportTemplate(): string {
  return [GROUP_IMPORT_COLUMNS.join(','), '410000001,G01,一般', '410000002,G01,', '410000003,G02,產學', '410000004,G02,'].join('\r\n') + '\r\n'
}

// ── 用例介面 ──────────────────────────────────────────────────────────────────

export type GroupImportUploadTicket = {
  readonly ticket: string
  readonly fileId: string
  readonly maxBytes: number
  readonly expiresAt: string
}

export type GroupImportPreview = {
  readonly fileId: string
  readonly fileName: string
  readonly cohortId: string
  readonly rows: readonly GroupImportRow[]
  readonly counts: GroupImportCounts
}

export type GroupImportInput = { readonly fileId: string; readonly cohortId: string }

/** 系辦匯入分組（只有系辦）。 */
export interface GroupImportCommand {
  /** 拿一張只能傳 CSV 的上傳 ticket（共用檔案能力，同批次指派）。 */
  startUpload(
    actor: ResolvedActor,
    input: { fileName: string; declaredMime: string; declaredSize: number },
  ): Promise<Result<GroupImportUploadTicket>>
  /** 讀伺服器上的原檔、依所選屆別分成六類；不寫任何資料。 */
  preview(actor: ResolvedActor, input: GroupImportInput): Promise<Result<GroupImportPreview>>
  /**
   * 重新分析同一份原檔後執行：新組每組一個交易（管理員直接成組、不經建立流程），加人每列走既有 `addMember`
   * （理由「名單匯入」）。一列失敗不影響別列；同一個請求編號重送回第一次的結果。
   */
  execute(actor: ResolvedActor, input: GroupImportInput, requestId: string): Promise<Result<GroupImportReceipt>>
}
