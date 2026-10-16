import { describe, expect, it } from 'vitest'
import { blockReason, itemErrors, missingCount, missingText, myStatusOf, type ItemSpec } from './rules'

// AC-TE-12 的方案：數字項「1. 功能完整度」滿分 100、等第項「2. 文件」、通過制項「3. 展示」。
const ITEMS: readonly ItemSpec[] = [
  { key: 'func', name: '功能完整度', type: 'number', max: 100, weight: 70 },
  { key: 'doc', name: '文件', type: 'letter', max: null, weight: 30 },
  { key: 'demo', name: '展示', type: 'passfail', max: null, weight: 0 },
]

describe('itemErrors', () => {
  it('超出滿分是「第 N 項要填 0–{滿分} 的數字（最多兩位小數）」', () => {
    expect(itemErrors(ITEMS, { func: '101' }).get('func')).toBe('第 1 項要填 0–100 的數字（最多兩位小數）')
    expect(itemErrors(ITEMS, { func: '80.123' }).get('func')).toBe('第 1 項要填 0–100 的數字（最多兩位小數）')
  })

  it('合法值、沒填都不算錯', () => {
    expect(itemErrors(ITEMS, { func: '80', doc: 'A', demo: 'pass' }).size).toBe(0)
    expect(itemErrors(ITEMS, {}).size).toBe(0)
  })

  it('等第與通過制選項不對', () => {
    const errors = itemErrors(ITEMS, { doc: 'Z', demo: 'maybe' })
    expect(errors.get('doc')).toBe('第 2 項選項不對')
    expect(errors.get('demo')).toBe('第 3 項選項不對')
  })
})

describe('missingCount／blockReason', () => {
  it('「還有 N 項沒填」隨填寫遞減到 0', () => {
    expect(missingCount(ITEMS, {})).toBe(3)
    expect(missingCount(ITEMS, { func: '80' })).toBe(2)
    expect(missingCount(ITEMS, { func: '80', doc: 'B' })).toBe(1)
    expect(missingCount(ITEMS, { func: '80', doc: 'B', demo: 'fail' })).toBe(0)
    expect(missingText(1)).toBe('還有 1 項沒填')
  })

  it('有錯先講錯、再講沒填、都好了說可以送', () => {
    expect(blockReason(itemErrors(ITEMS, { func: '101' }), 2)).toBe('第 1 項要填 0–100 的數字（最多兩位小數），修正後才能正式送出。')
    expect(blockReason(new Map(), 1)).toBe('還有 1 項沒填，填齊後才能正式送出。')
    expect(blockReason(new Map(), 0)).toBe('每一項都有效，可以正式送出。')
  })
})

describe('myStatusOf', () => {
  const base = { state: 'empty' as const, returned: false, filled: 0, total: 2 }
  it('待評、草稿 k／n、已送出', () => {
    expect(myStatusOf(base).text).toBe('待評')
    expect(myStatusOf({ ...base, state: 'draft', filled: 1 }).text).toBe('草稿 1／2')
    expect(myStatusOf({ ...base, state: 'counted', filled: 2 })).toEqual({ text: '已送出', tone: 'success' })
  })

  it('被系辦退回、還沒重新送出：標「被退回」，有新草稿時一併寫進度', () => {
    expect(myStatusOf({ ...base, returned: true }).text).toBe('被退回')
    expect(myStatusOf({ ...base, returned: true, state: 'draft', filled: 1 })).toEqual({ text: '被退回・草稿 1／2', tone: 'danger' })
  })
})
