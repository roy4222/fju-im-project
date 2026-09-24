import { describe, expect, it } from 'vitest'
import { parseCsv, toCsvCell, toCsvLine } from '@/shared/csv'

const opts = { maxCellLength: 50, maxRows: 100 }

function cells(text: string) {
  const parsed = parseCsv(text, opts)
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.reason}@${parsed.line}`)
  return parsed.rows.map((r) => r.cells)
}

describe('parseCsv（RFC 4180）', () => {
  it('一般逗號分隔、CRLF 與 LF 都認得', () => {
    expect(cells('a,b\r\n1,2\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('拿掉檔頭的 UTF-8 BOM（Excel 存的 CSV 會帶）', () => {
    expect(cells('﻿student_no,name\n1,王')[0]).toEqual(['student_no', 'name'])
  })

  it('引號包起來的欄位可以含逗號、換行與成對的雙引號', () => {
    expect(cells('"王,小明","第一行\n第二行","他說""好"""')).toEqual([['王,小明', '第一行\n第二行', '他說"好"']])
  })

  it('跳過完全空白的列，行號照實體行算', () => {
    const parsed = parseCsv('h\n\n1\n"a\nb"\n2\n', opts)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.rows.map((r) => [r.line, r.cells[0]])).toEqual([
      [1, 'h'],
      [3, '1'],
      [4, 'a\nb'],
      [6, '2'],
    ])
  })

  it('學號的前導零照原樣保留（全部當文字）', () => {
    expect(cells('student_no\n00123')[1]).toEqual(['00123'])
  })

  it('引號沒收尾、引號後面還有字、欄位太長、列數太多都回錯誤', () => {
    expect(parseCsv('a,"b', opts)).toMatchObject({ ok: false, reason: 'unterminated_quote' })
    expect(parseCsv('a,"b"x', opts)).toMatchObject({ ok: false, reason: 'stray_quote' })
    expect(parseCsv('a,b"c', opts)).toMatchObject({ ok: false, reason: 'stray_quote' })
    expect(parseCsv(`a,${'x'.repeat(51)}`, opts)).toMatchObject({ ok: false, reason: 'cell_too_long' })
    expect(parseCsv('a\n'.repeat(101), opts)).toMatchObject({ ok: false, reason: 'too_many_rows' })
  })
})

describe('toCsvCell（匯出的公式注入防護，契約 03 §5）', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])('以 %j 開頭的儲存格加上 \' 前綴', (value) => {
    expect(toCsvCell(value)).toBe(`"'${value.replaceAll('"', '""')}"`)
  })

  it('一律加引號、內部雙引號加倍、中文與前導零照原樣', () => {
    expect(toCsvCell('他說"好"')).toBe('"他說""好"""')
    expect(toCsvCell('00123')).toBe('"00123"')
    expect(toCsvCell(null)).toBe('""')
    expect(toCsvLine(['a,b', 1, '=cmd|x'])).toBe(`"a,b","1","'=cmd|x"`)
  })

  it('匯出後再讀回來內容一致（逗號、換行、引號）', () => {
    const values = ['王,小明', '第一行\n第二行', '他說"好"', '00123']
    const parsed = parseCsv(toCsvLine(values), opts)
    expect(parsed.ok && parsed.rows[0]!.cells).toEqual(values)
  })
})
