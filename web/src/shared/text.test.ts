import { describe, expect, it } from 'vitest'
import { charLength } from '@/shared/text'
import { commentLength } from '@/app/dashboard/teacher/grading/[groupId]/bench-types'

/** 七處統一前的三種寫法（⑤-16）：四處用 `.length`，三處手寫 `Array.from`／展開。 */
const OLD = {
  utf16: (s: string) => s.length,
  arrayFrom: (s: string) => Array.from(s).length,
  spread: (s: string) => [...s].length,
}

const BMP_SAMPLES = ['', 'abc', '中文理由', 'Hello 世界', '  前後空白  ', '第一行\n第二行', '\t全形　空白', '標點，。！？']
const ASTRAL_SAMPLES = ['👍', '👍中', '𠮷野家', '理由😀😀', '👨‍👩‍👧']

describe('charLength：以字計（code point），同 Postgres char_length（⑤-16、AC-63）', () => {
  it('emoji（代理對）算 1 字：charLength("👍中") = 2', () => {
    expect(charLength('👍中')).toBe(2)
    expect(charLength('👍')).toBe(1)
    expect(charLength('𠮷')).toBe(1)
  })

  it('中文、英文、空白、換行：每個字元算 1', () => {
    expect(charLength('')).toBe(0)
    expect(charLength('abc')).toBe(3)
    expect(charLength('中文理由')).toBe(4)
    expect(charLength(' \n\t　')).toBe(4)
  })

  it('組合 emoji 按 code point 算（跟資料庫一致，不按字形）', () => {
    expect(charLength('👨‍👩‍👧')).toBe(5)
  })

  it.each(BMP_SAMPLES)('舊結果＝新結果：純 BMP 文字三種舊寫法都相同（%j）', (s) => {
    expect(charLength(s)).toBe(OLD.utf16(s))
    expect(charLength(s)).toBe(OLD.arrayFrom(s))
    expect(charLength(s)).toBe(OLD.spread(s))
  })

  it.each(ASTRAL_SAMPLES)('舊結果＝新結果：手寫的 Array.from／展開寫法對 emoji 也相同（%j）', (s) => {
    expect(charLength(s)).toBe(OLD.arrayFrom(s))
    expect(charLength(s)).toBe(OLD.spread(s))
  })

  it('規格要求的唯一改變：原本用 .length 的四處，代理對字元從 2 變 1', () => {
    expect(OLD.utf16('👍中')).toBe(3)
    expect(charLength('👍中')).toBe(2)
  })

  it('評分頁評語計數（bench-types commentLength）改用共用函式', () => {
    for (const s of [...BMP_SAMPLES, ...ASTRAL_SAMPLES]) expect(commentLength(s)).toBe(OLD.spread(s))
    expect(commentLength).toBe(charLength)
  })
})
