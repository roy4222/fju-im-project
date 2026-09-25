import { describe, expect, it } from 'vitest'
import { describeGroupSize, groupingDeadline, normalizeGroupingSettings } from '@/application/cohorts'

describe('分組設定（票 13）', () => {
  it('合法範圍通過；最少大於最多、0 人、超過上限、非整數天數都被擋並指出欄位', () => {
    expect(normalizeGroupingSettings({ groupSizeMin: 3, groupSizeMax: 5, proposalDefaultDays: 7 })).toEqual({
      ok: true,
      value: { groupSizeMin: 3, groupSizeMax: 5, proposalDefaultDays: 7 },
    })
    expect(normalizeGroupingSettings({ groupSizeMin: 6, groupSizeMax: 5, proposalDefaultDays: 7 })).toMatchObject({
      ok: false,
      details: { field: 'groupSizeMin' },
    })
    expect(normalizeGroupingSettings({ groupSizeMin: 0, groupSizeMax: 5, proposalDefaultDays: 7 }).ok).toBe(false)
    expect(normalizeGroupingSettings({ groupSizeMin: 5, groupSizeMax: 11, proposalDefaultDays: 7 }).ok).toBe(false)
    expect(normalizeGroupingSettings({ groupSizeMin: 5, groupSizeMax: 5, proposalDefaultDays: 0 })).toMatchObject({
      ok: false,
      details: { field: 'proposalDefaultDays' },
    })
    expect(normalizeGroupingSettings({ groupSizeMin: 5, groupSizeMax: 5, proposalDefaultDays: 1.5 }).ok).toBe(false)
  })

  it('人數文字：一樣時說「每組 5 人」，不一樣時說範圍', () => {
    expect(describeGroupSize(5, 5)).toBe('每組 5 人')
    expect(describeGroupSize(3, 5)).toBe('每組 3–5 人')
  })
})

describe('成組截止＝第 2 階段開始日 00:00（臺灣）', () => {
  const stage = (seq: number, startDate: string) => ({ seq, name: `s${seq}`, description: '', startDate, deadlineVersion: 1 })

  it('四段都設好：第 2 段開始那天 00:00（UTC 前一天 16:00）', () => {
    const schedule = {
      stages: [stage(1, '2026-09-15'), stage(2, '2026-11-01'), stage(3, '2027-01-10'), stage(4, '2027-03-01')],
      yearEndDate: '2027-06-30',
    }
    expect(groupingDeadline(schedule)?.toISOString()).toBe('2026-10-31T16:00:00.000Z')
  })

  it('只有一段：到年度結束日（含當天）', () => {
    expect(groupingDeadline({ stages: [stage(1, '2026-09-15')], yearEndDate: '2027-06-30' })?.toISOString()).toBe(
      '2027-06-30T16:00:00.000Z',
    )
  })

  it('還沒設階段或年度結束日：null', () => {
    expect(groupingDeadline({ stages: [], yearEndDate: '2027-06-30' })).toBeNull()
    expect(groupingDeadline({ stages: [stage(1, '2026-09-15')], yearEndDate: null })).toBeNull()
  })
})
