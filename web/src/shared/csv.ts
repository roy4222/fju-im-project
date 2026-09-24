/**
 * CSV 的讀與寫（契約 03 §5）。純函式，沒有框架。
 *
 * - **讀**：照 RFC 4180 拆欄——引號包起來的欄位可以含逗號、換行與成對的雙引號。
 *   每一格都有長度上限，避免一個超長欄位把記憶體或畫面撐爆。
 * - **寫**：匯出時對 `= + - @ \t \r` 開頭的儲存格加 `'` 前綴並一律用雙引號包起來，
 *   內部雙引號加倍。Excel 開啟時看到的是文字，不會把 `=HYPERLINK(...)` 當公式執行。
 *   前綴會讓儲存格多一個 `'`（Excel 會把它當「強制文字」隱藏掉），這是刻意的取捨。
 */

export type CsvParseError = {
  readonly ok: false
  readonly reason: 'unterminated_quote' | 'cell_too_long' | 'too_many_rows' | 'too_many_cells' | 'stray_quote'
  /** 從 1 起算的行號（實體行，不是資料列）。 */
  readonly line: number
}

export type CsvParsed = {
  readonly ok: true
  /** 每一列：欄位字串陣列，以及這一列開始的實體行號（從 1 起算）。 */
  readonly rows: readonly { readonly line: number; readonly cells: readonly string[] }[]
}

export type CsvParseOptions = {
  /** 單一儲存格的字元上限。 */
  readonly maxCellLength: number
  /** 資料列（含表頭）上限。 */
  readonly maxRows: number
  /**
   * 每列最多幾格。不設的話，一份 2 MiB 全是逗號的檔案會在一列裡堆出約 200 萬個空字串
   * （票 6 審查建議）；超過就整份退件，不繼續往下拆。
   */
  readonly maxCellsPerRow: number
}

/**
 * 把整份 CSV 文字拆成列。
 *
 * 行尾接受 `\r\n`、`\n` 與單獨的 `\r`；檔頭的 UTF-8 BOM 會被拿掉（Excel 存 UTF-8 CSV 會帶）。
 * 完全空白的列（只有換行）直接略過，不算資料列。
 */
export function parseCsv(text: string, options: CsvParseOptions): CsvParsed | CsvParseError {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: { line: number; cells: string[] }[] = []

  let cells: string[] = []
  let cell = ''
  let inQuotes = false
  /** 這一格是否以引號開頭（引號只能出現在格子開頭，其他位置當成格式錯誤）。 */
  let quotedCell = false
  let afterClosingQuote = false
  let line = 1
  let rowStartLine = 1

  const pushCell = (): CsvParseError | null => {
    if (cell.length > options.maxCellLength) return { ok: false, reason: 'cell_too_long', line: rowStartLine }
    if (cells.length >= options.maxCellsPerRow) return { ok: false, reason: 'too_many_cells', line: rowStartLine }
    cells.push(cell)
    cell = ''
    quotedCell = false
    afterClosingQuote = false
    return null
  }

  const pushRow = (): CsvParseError | null => {
    const error = pushCell()
    if (error) return error
    const blank = cells.length === 1 && cells[0] === ''
    if (!blank) {
      if (rows.length >= options.maxRows) return { ok: false, reason: 'too_many_rows', line: rowStartLine }
      rows.push({ line: rowStartLine, cells })
    }
    cells = []
    return null
  }

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          inQuotes = false
          afterClosingQuote = true
        }
      } else {
        if (ch === '\n' || (ch === '\r' && input[i + 1] !== '\n')) line += 1
        cell += ch
        if (cell.length > options.maxCellLength) return { ok: false, reason: 'cell_too_long', line: rowStartLine }
      }
      continue
    }

    if (ch === ',') {
      const error = pushCell()
      if (error) return error
      continue
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1
      const error = pushRow()
      if (error) return error
      line += 1
      rowStartLine = line
      continue
    }

    if (ch === '"') {
      if (cell === '' && !quotedCell) {
        inQuotes = true
        quotedCell = true
        continue
      }
      return { ok: false, reason: 'stray_quote', line }
    }

    // 收尾引號之後只能接逗號或換行，`"abc"x` 這種寫法不猜意思，直接當格式錯。
    if (afterClosingQuote) return { ok: false, reason: 'stray_quote', line }

    cell += ch
    if (cell.length > options.maxCellLength) return { ok: false, reason: 'cell_too_long', line: rowStartLine }
  }

  if (inQuotes) return { ok: false, reason: 'unterminated_quote', line: rowStartLine }
  const error = pushRow()
  if (error) return error

  return { ok: true, rows }
}

/** 匯出時需要加前綴的字首（契約 03 §5）。 */
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r'])

/** 一格匯出用的 CSV 儲存格：防公式注入、一律加引號、內部引號加倍。 */
export function toCsvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value)
  const guarded = text.length > 0 && FORMULA_PREFIXES.has(text[0]!) ? `'${text}` : text
  return `"${guarded.replaceAll('"', '""')}"`
}

/** 一列匯出用的 CSV（不含行尾）。 */
export function toCsvLine(values: readonly (string | number | null | undefined)[]): string {
  return values.map(toCsvCell).join(',')
}
