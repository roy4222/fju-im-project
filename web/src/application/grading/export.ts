import type { ResolvedActor } from '@/application/accounts'
import { adoptedFinal, describeOverride, describeStageStatus } from '@/application/grading/gradebook'
import type { Gradebook, GradebookGroup, MissingEvaluation } from '@/application/grading/ports'
import { toCsvLine } from '@/shared/csv'
import { err, type Err, type Result } from '@/shared/result'

/**
 * 整屆成績匯出（票 24；產品模組 06 §4「7.6」、2026-09-15 定案補充／成績匯出；案例 GRD-10）。
 *
 * - 只有管理員；每次重新授權、重新查詢、重新算（伺服器只收「屆別＋篩選」，不收瀏覽器算好的列）。
 * - 篩選：階段、組別、完成狀態（選了階段＝看那一階段完成沒；沒選＝看最終完成沒）。
 * - 各階段依序是份數、每位採計中老師的姓名與分數（S10-11「各階段每位老師 counted 值」）、平均、狀態。
 * - 每位組員一列（學號是文字：XLSX 用文字儲存格保留前導零；CSV 內容照原樣寫出前導零）。
 * - 數字與畫面同一份計算（`computeGroupResult`）與同一種捨入（兩位小數）；另外帶「原始精度」可追查。
 * - 解散的組別也列出（組別狀態「已解散」、解散當下的組員、解散當下的方案版本；產品模組 03 §4）。
 * - 更正後結果、更正註記（原值、理由；待復核）、缺評待處理（老師停用時「老師已停用，缺評待處理」）都寫進去。
 *
 * 純函式：篩選、表頭、資料列、CSV 全文；XLSX 由 `@/shared/xlsx` 寫。
 */

export type GradeExportFormat = 'csv' | 'xlsx'
export type GradeExportStatus = 'all' | 'complete' | 'incomplete'

export type GradeExportFilter = {
  /** `all` 或方案裡的階段 key。 */
  readonly stageKey: string
  /** `all` 或組別 id。 */
  readonly groupId: string
  readonly status: GradeExportStatus
}

export type GradeExportRequest = {
  readonly cohortId: string
  readonly format: GradeExportFormat
  readonly filter: GradeExportFilter
}

export type GradeExportResult = {
  readonly format: GradeExportFormat
  readonly cohortCode: string
  readonly groupCount: number
  readonly rowCount: number
  readonly body: string | Uint8Array
}

export interface GradeExporter {
  exportGrades(actor: ResolvedActor, request: GradeExportRequest): Promise<Result<GradeExportResult>>
}

export const DEFAULT_GRADE_EXPORT_FILTER: GradeExportFilter = { stageKey: 'all', groupId: 'all', status: 'all' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STAGE_KEY = /^[a-z][a-z0-9_-]{0,39}$/

const one = (value: unknown): string => (typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '')

/** 網址參數或匯出 body 的篩選 → 可信的篩選（不認得的值回預設）。 */
export function normalizeGradeExportFilter(raw: Record<string, unknown>): GradeExportFilter {
  const stageKey = one(raw.stage ?? raw.stageKey)
  const groupId = one(raw.group ?? raw.groupId)
  const status = one(raw.status)
  return {
    stageKey: STAGE_KEY.test(stageKey) ? stageKey : 'all',
    groupId: UUID.test(groupId) ? groupId : 'all',
    status: status === 'complete' || status === 'incomplete' ? status : 'all',
  }
}

export function normalizeGradeExportRequest(input: unknown): { ok: true; value: GradeExportRequest } | Err {
  const body = (input ?? {}) as { cohortId?: unknown; format?: unknown; filter?: unknown }
  const cohortId = typeof body.cohortId === 'string' ? body.cohortId : ''
  if (!UUID.test(cohortId)) return err('VALIDATION_FAILED', '請先選屆別。')
  if (body.format !== 'csv' && body.format !== 'xlsx') return err('VALIDATION_FAILED', '請選匯出格式（CSV 或 XLSX）。')
  const raw = typeof body.filter === 'object' && body.filter !== null ? (body.filter as Record<string, unknown>) : {}
  return { ok: true, value: { cohortId, format: body.format, filter: normalizeGradeExportFilter(raw) } }
}

/** 套篩選（畫面的成績表與匯出同一份）。 */
export function selectExportGroups(book: Gradebook, filter: GradeExportFilter): GradebookGroup[] {
  return book.groups.filter((g) => {
    if (filter.groupId !== 'all' && g.id !== filter.groupId) return false
    if (filter.status === 'all') return true
    const complete = filter.stageKey === 'all' ? g.result.complete : (g.result.stages.find((s) => s.key === filter.stageKey)?.complete ?? false)
    return filter.status === 'complete' ? complete : !complete
  })
}

/** 缺評的一句話（成績表與匯出同一句）。 */
export function describeMissing(m: MissingEvaluation): string {
  return m.teacherInactive ? `${m.stageName}：${m.teacherName}（老師已停用，缺評待處理）` : `${m.stageName}：${m.teacherName}（未送出）`
}

/** 要求份數比「已採計＋有效指派」還多：還缺幾位評分老師（替換後還沒指派新老師）。`stageKey` 給了就只看那一階段。 */
export function unassignedSlots(g: GradebookGroup, stageKey = 'all'): string[] {
  // 解散的組評分工作已停止（產品模組 03 §4）：不再列待指派。
  if (g.dissolved) return []
  return g.result.stages.flatMap((s) => {
    if (stageKey !== 'all' && s.key !== stageKey) return []
    if (s.required === null || s.required <= 0) return []
    const pending = g.missing.filter((m) => m.stageKey === s.key).length
    const short = s.required - s.counted.length - pending
    return short > 0 ? [`${s.name}：尚缺 ${short} 位評分老師（待指派）`] : []
  })
}

function stagesOf(book: Gradebook, filter: GradeExportFilter) {
  const stages = book.version?.stages ?? []
  return filter.stageKey === 'all' ? stages : stages.filter((s) => s.key === filter.stageKey)
}

/**
 * 每個階段要幾組「老師／分數」欄：整屆（不看組別與完成狀態篩選）該階段採計中評分最多的份數，至少一組。
 * 欄位只跟屆別與階段有關，篩選換了欄位也一樣；老師依正式送出的先後排（和計算明細同一個順序）。
 */
function teacherSlots(groups: readonly GradebookGroup[], stageKey: string): number {
  let most = 1
  for (const g of groups) most = Math.max(most, g.result.stages.find((s) => s.key === stageKey)?.counted.length ?? 0)
  return most
}

export function gradeExportHeader(book: Gradebook, filter: GradeExportFilter): string[] {
  return [
    '屆別',
    '組別',
    '學號',
    '姓名',
    ...stagesOf(book, filter).flatMap((s) => [
      `${s.name} 份數`,
      ...Array.from({ length: teacherSlots(book.groups, s.key) }, (_, i) => [`${s.name} 老師${i + 1}`, `${s.name} 老師${i + 1} 分數`]).flat(),
      `${s.name} 平均`,
      `${s.name} 狀態`,
    ]),
    '最終成績（計算）',
    '最終成績（原始精度）',
    '最終成績（採用）',
    '更正註記',
    '缺評待處理',
    '方案版本',
    '組別狀態',
  ]
}

/**
 * 每位組員一列；沒有組員的組別也留一列（學號、姓名空白）。
 * 各階段在份數後面依序是每位採計中老師的姓名與分數（兩位小數，同計算明細）；改派時保留的舊分數標「已改派保留」。
 */
export function gradeExportRows(book: Gradebook, groups: readonly GradebookGroup[], filter: GradeExportFilter): string[][] {
  const stages = stagesOf(book, filter)
  const slots = new Map(stages.map((s) => [s.key, teacherSlots(book.groups, s.key)]))
  const rows: string[][] = []
  for (const g of groups) {
    const stageCells = stages.flatMap((stage) => {
      const s = g.result.stages.find((x) => x.key === stage.key)
      const teachers = Array.from({ length: slots.get(stage.key)! }, (_, i) => {
        const c = s?.counted[i]
        return c ? [c.assignmentEnded ? `${c.teacherName}（已改派保留）` : c.teacherName, c.display] : ['', '']
      }).flat()
      if (!s) return ['', ...teachers, '', '']
      return [
        // 全形斜線：半形的「1/2」在 Excel 會被當成日期。
        `${s.counted.length}／${s.required ?? '未設定'}`,
        ...teachers,
        s.averageDisplay ?? '',
        describeStageStatus(s),
      ]
    })
    const adopted = adoptedFinal(g.result, g.override)
    const missing = [
      ...g.missing.filter((m) => filter.stageKey === 'all' || m.stageKey === filter.stageKey).map(describeMissing),
      ...unassignedSlots(g, filter.stageKey),
    ].join('；')
    const tail = [
      g.result.finalDisplay ?? '尚未完成',
      g.result.finalExact ?? '',
      adopted.value ?? '尚未完成',
      describeOverride(g.override),
      missing,
      g.versionNo === null ? '' : `v${g.versionNo}`,
      g.dissolved ? '已解散' : '進行中',
    ]
    const members = g.members.length > 0 ? g.members : [{ name: '', studentNo: null }]
    for (const m of members) rows.push([book.cohort.code, g.code, m.studentNo ?? '', m.name, ...stageCells, ...tail])
  }
  return rows
}

/** 位元組是 EF BB BF；寫成跳脫字元，原始碼裡不放看不見的字。 */
const UTF8_BOM = String.fromCharCode(0xfeff)

/** CSV 全文：UTF-8 BOM、每格經 `toCsvLine`（一律加引號、公式字首加 `'`）、行尾 CRLF。 */
export function buildGradeCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [toCsvLine(header), ...rows.map((row) => toCsvLine(row))]
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`
}
