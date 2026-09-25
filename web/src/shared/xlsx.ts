import { strToU8, zipSync } from 'fflate'

/**
 * 最小的 XLSX 寫出（票 20 組別名單匯出；契約 03 §5「XLSX 文字儲存格」）。純函式，沒有框架。
 *
 * 一個工作表、每一格都是**內嵌文字**（`t="inlineStr"`）：
 * - 學號以文字寫出，Excel 不會吃掉前導零、也不會變成科學記號。
 * - `=`、`+`、`-`、`@` 開頭的內容仍然是文字，Excel 不會當公式執行（所以不像 CSV 那樣加 `'` 前綴，
 *   加了反而會在儲存格裡看到一個多出來的 `'`）。
 * - XML 特殊字元逃逸；XML 1.0 不允許的控制字元直接拿掉（否則 Excel 會說檔案損毀）。
 *
 * 壓縮用 fflate（MIT、零依賴）的 `zipSync`；不拉整套試算表套件（SheetJS 的 npm 版有未修的漏洞、exceljs 太重）。
 */

/** XML 1.0 不允許的字元：除了 \t \n \r 以外的 C0 控制字元，以及 U+FFFE、U+FFFF、落單的代理字元。 */
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function escapeXmlText(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** 0 起算的欄號 → Excel 欄名（0→A、25→Z、26→AA）。 */
export function columnName(index: number): string {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

function sheetXml(rows: readonly (readonly string[])[]): string {
  const body = rows
    .map((cells, r) => {
      const row = r + 1
      const xml = cells
        .map((value, c) => {
          const ref = `${columnName(c)}${row}`
          // xml:space="preserve"：前後空白（例如學號前的空格）照原樣保留。
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(value)}</t></is></c>`
        })
        .join('')
      return `<row r="${row}">${xml}</row>`
    })
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`
  )
}

/** 工作表名稱：最多 31 字、不能有 `: \ / ? * [ ]`。 */
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31)
  return cleaned || 'Sheet1'
}

/** 表頭＋資料列 → 一個 XLSX 檔的位元組。 */
export function buildXlsx(sheetName: string, header: readonly string[], rows: readonly (readonly string[])[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${escapeXmlText(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml([header, ...rows])),
  }
  return zipSync(files, { level: 6 })
}
