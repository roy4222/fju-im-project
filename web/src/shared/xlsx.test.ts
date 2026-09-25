import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildXlsx, columnName, escapeXmlText } from '@/shared/xlsx'

describe('XLSX 寫出', () => {
  it('欄名：A、Z、AA、AZ、BA', () => {
    expect([0, 25, 26, 51, 52].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA'])
  })

  it('XML 逃逸並拿掉 XML 不允許的控制字元', () => {
    expect(escapeXmlText('a<b>&"c"\u0001\u0008\t')).toBe('a&lt;b&gt;&amp;&quot;c&quot;\t')
    // U+FFFE、U+FFFF 與落單的代理字元也不是合法的 XML 字元；成對的代理字元（emoji）要留著。
    expect(escapeXmlText('a\uFFFEb\uFFFFc\uD800d\uDC00e😀')).toBe('abcde😀')
  })

  it('五個檔案、每格都是內嵌文字（不是公式、不是數字）', () => {
    const bytes = buildXlsx('114 組別名單', ['學號', '姓名'], [['0412001', '=SUM(A1:A2)'], ['00', '@x']])
    const files = unzipSync(bytes)
    expect(Object.keys(files)).toHaveLength(5)
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!)
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">0412001</t></is></c>')
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">=SUM(A1:A2)</t></is></c>')
    expect(sheet).not.toMatch(/<f>|<v>/)
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('name="114 組別名單"')
  })

  it('工作表名稱去掉不允許的字元、最多 31 字', () => {
    const files = unzipSync(buildXlsx('a/b:c*'.repeat(10), ['x'], []))
    const match = /name="([^"]*)"/.exec(strFromU8(files['xl/workbook.xml']!))
    expect(match?.[1]).not.toMatch(/[/:*]/)
    expect(match?.[1]?.length).toBeLessThanOrEqual(31)
  })
})
