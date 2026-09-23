import { describe, expect, it } from 'vitest'
import { canonicalJson, RECEIPT_TTL_DAYS, receiptExpiryFrom } from '@/application/ops'

/**
 * S01-03：帳本 fingerprint 的「穩定字串」規則（契約 01 §4.4）。
 *
 * 這件事直接影響使用者：fingerprint 不穩定的話，同一次送出重試會被誤判成
 * `REQUEST_MISMATCH`，畫面就會跳「這個請求和先前不同」而不是回原本的回執。
 */

describe('canonicalJson', () => {
  it('欄位順序不影響結果', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })

  it('巢狀物件也照樣排序', () => {
    expect(canonicalJson({ x: { d: 1, c: 2 } })).toBe(canonicalJson({ x: { c: 2, d: 1 } }))
  })

  it('陣列順序**有**意義，不會被排掉', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('undefined 的欄位等於不存在', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('null 不等於不存在（送出「清空這個欄位」和「沒有動這個欄位」是兩回事）', () => {
    expect(canonicalJson({ a: 1, b: null })).not.toBe(canonicalJson({ a: 1 }))
  })

  it('Date 轉成 ISO 字串，兩個相同時刻得到同一串', () => {
    const t = new Date('2026-09-15T12:00:00.000Z')
    expect(canonicalJson({ at: t })).toBe(canonicalJson({ at: new Date(t.getTime()) }))
    expect(canonicalJson({ at: t })).toContain('2026-09-15T12:00:00.000Z')
  })

  it('內容真的不同就得到不同的字串', () => {
    expect(canonicalJson({ studentNo: '410000001' })).not.toBe(canonicalJson({ studentNo: '410000002' }))
  })

  it('字串的前導零保留（學號不可以被當成數字）', () => {
    expect(canonicalJson({ studentNo: '0410' })).toContain('"0410"')
  })
})

describe('回執保留期', () => {
  it('30 天（契約 01 §4.4）', () => {
    expect(RECEIPT_TTL_DAYS).toBe(30)
  })

  it('到期時間是 committed + 30 天', () => {
    const committed = new Date('2026-09-15T00:00:00.000Z')
    expect(receiptExpiryFrom(committed).toISOString()).toBe('2026-10-15T00:00:00.000Z')
  })
})
