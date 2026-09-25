import { describe, expect, it } from 'vitest'
import { categoryOf, completionOf, overdueReceiverIds, pendingCount, receiverStatus, type ReceiverFacts } from '@/application/submissions'

/**
 * 票 18 的純規則：名單三類、完成率的分子分母（產品模組 05 §4「個人填報與收件名單」、SUB-02／20／22），
 * 以及學生首頁待繳數與名單頁用同一個狀態函式。
 */

const dueAt = new Date('2026-11-15T15:59:00Z') // 臺灣 11/15 23:59
const window = { opensAt: null, dueAt }
const before = new Date('2026-11-10T00:00:00Z')
const after = new Date('2026-11-16T00:00:00Z')
const removedAt = new Date('2026-11-01T00:00:00Z')

function entry(patch: Partial<ReceiverFacts> = {}): ReceiverFacts {
  return { eligibleTo: null, exempt: false, hasDraft: false, latestVersionNo: null, ...patch }
}

const submitted = entry({ latestVersionNo: 1 })
const waiting = entry()

describe('名單三類', () => {
  it('有結束時間就是已移出（即使當時是免填）；還在名單上的分免填與目前名單', () => {
    expect(categoryOf(entry())).toBe('current')
    expect(categoryOf(entry({ exempt: true }))).toBe('exempt')
    expect(categoryOf(entry({ eligibleTo: removedAt }))).toBe('removed')
    expect(categoryOf(entry({ eligibleTo: removedAt, exempt: true }))).toBe('removed')
  })
})

describe('完成率＝已正式送出／應交數', () => {
  it('10 人 8 人交：8／10', () => {
    const entries = [...Array(8).fill(submitted), ...Array(2).fill(waiting)]
    expect(completionOf(window, entries, before)).toMatchObject({ required: 10, done: 8, pending: 2, overdue: 0, percent: 80 })
  })

  it('移出一位已交者變 7／9，再移出一位未交者變 7／8；移出的人回答保留但不算分子', () => {
    const one = [
      ...Array(7).fill(submitted),
      entry({ latestVersionNo: 2, eligibleTo: removedAt }),
      ...Array(2).fill(waiting),
    ]
    expect(completionOf(window, one, before)).toMatchObject({ required: 9, done: 7, removed: 1 })
    const two = [...one.slice(0, 9), entry({ eligibleTo: removedAt })]
    expect(completionOf(window, two, before)).toMatchObject({ required: 8, done: 7, removed: 2 })
  })

  it('免填不算分母也不算已完成：13 人 12 交、未交者免填 → 12／12；免填者就算交過也不算', () => {
    const base = Array(12).fill(submitted)
    expect(completionOf(window, [...base, waiting], before)).toMatchObject({ required: 13, done: 12 })
    expect(completionOf(window, [...base, entry({ exempt: true })], before)).toMatchObject({
      required: 12,
      done: 12,
      exempt: 1,
      percent: 100,
    })
    expect(completionOf(window, [...base.slice(1), entry({ exempt: true, latestVersionNo: 1 })], before)).toMatchObject({
      required: 11,
      done: 11,
    })
  })

  it('模擬鐘倒撥到開放前：已交的仍算分子（狀態字顯示尚未開放，但完成率不看狀態字；票 18 遺留，票 21 修）', () => {
    const later = { opensAt: new Date('2026-12-01T00:00:00Z'), dueAt: new Date('2026-12-31T15:59:00Z') }
    expect(receiverStatus(later, submitted, before).headline).toBe('尚未開放')
    expect(completionOf(later, [submitted, submitted, waiting], before)).toMatchObject({ required: 3, done: 2, pending: 1, overdue: 0 })
  })

  it('整組一份：一組一列，同組誰送都只算這一組一份', () => {
    // 名單上 3 組、其中 2 組交過（每組只有一個「最後一次正式送出」），完成率 2／3。
    expect(completionOf(window, [entry({ latestVersionNo: 3 }), submitted, waiting], before)).toMatchObject({ required: 3, done: 2 })
  })

  it('截止後沒交的算逾期；草稿不算已交；分母 0 時百分比是 null', () => {
    const entries = [submitted, entry({ hasDraft: true }), waiting]
    expect(completionOf(window, entries, before)).toMatchObject({ required: 3, done: 1, pending: 2, overdue: 0, percent: 33 })
    expect(completionOf(window, entries, after)).toMatchObject({ done: 1, pending: 0, overdue: 2 })
    expect(completionOf(window, [entry({ exempt: true })], before)).toMatchObject({ required: 0, percent: null })
  })
})

describe('學生首頁待繳數與名單頁同一個口徑', () => {
  it('待繳＝還在開放、沒送出、不是免填；尚未開放與逾期不算待繳', () => {
    const later = { opensAt: new Date('2026-12-01T00:00:00Z'), dueAt: new Date('2026-12-31T15:59:00Z') }
    const rows = [
      { ...window, ...waiting },
      { ...window, ...entry({ hasDraft: true }) },
      { ...window, ...submitted },
      { ...window, ...entry({ exempt: true }) },
      { ...later, ...waiting },
    ]
    expect(pendingCount(rows, before)).toBe(2)
    expect(pendingCount(rows, after)).toBe(0)
    // 名單頁每一列的狀態也是同一個函式算的。
    expect(receiverStatus(window, waiting, before)).toMatchObject({ headline: '未繳', pending: true })
    expect(receiverStatus(window, waiting, after)).toMatchObject({ headline: '逾期未繳', overdue: true })
    expect(receiverStatus(window, submitted, after)).toMatchObject({ headline: '已繳 v1', submitted: true })
  })
})

describe('系辦首頁逾期磚：全部收件的逾期收件者，同一位只算一次', () => {
  const later = { opensAt: null, dueAt: new Date('2026-12-15T15:59:00Z') }
  const row = (receiverId: string, patch: Partial<ReceiverFacts> = {}) => ({ receiverId, ...entry(patch) })

  it('第 7 份以後的收件逾期也算得到（呼叫端傳全部，函式本身不設上限）', () => {
    const rosters = Array.from({ length: 8 }, (_, i) => ({
      item: window,
      entries: [i === 7 ? row('late') : row(`ok-${i}`, { latestVersionNo: 1 })],
    }))
    expect([...overdueReceiverIds(rosters, after)]).toEqual(['late'])
  })

  it('同一位在兩份收件都逾期只算一次；已送出、免填、已移出、還沒截止的都不算', () => {
    const rosters = [
      { item: window, entries: [row('a'), row('b', { latestVersionNo: 1 }), row('c', { exempt: true }), row('d', { eligibleTo: removedAt })] },
      { item: window, entries: [row('a'), row('e')] },
      { item: later, entries: [row('f')] },
    ]
    expect([...overdueReceiverIds(rosters, after)].sort()).toEqual(['a', 'e'])
  })

  it('跟 completionOf 的逾期數同口徑（單份收件時兩者相等）', () => {
    const entries = [row('a'), row('b'), row('c', { latestVersionNo: 2 }), row('d', { exempt: true })]
    expect(overdueReceiverIds([{ item: window, entries }], after).size).toBe(completionOf(window, entries, after).overdue)
  })
})
