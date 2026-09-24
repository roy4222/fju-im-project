import { describe, expect, it } from 'vitest'
import { businessNowFrom, normalizeClockInput } from '@/application/cohorts/business-clock'

describe('businessNowFrom：設定後業務鐘繼續走', () => {
  it('沒有任何設定：等於真實時間', () => {
    const realNow = new Date('2026-09-24T01:00:00Z')
    expect(businessNowFrom(null, realNow)).toEqual(realNow)
  })

  it('設定時刻＋自那時起的真實經過時間（可以往前也可以往後）', () => {
    const latest = { businessAt: new Date('2027-03-01T02:00:00Z'), realAt: new Date('2026-09-24T01:00:00Z') }
    expect(businessNowFrom(latest, new Date('2026-09-24T01:00:05Z')).toISOString()).toBe('2027-03-01T02:00:05.000Z')

    const backwards = { businessAt: new Date('2025-01-01T00:00:00Z'), realAt: new Date('2026-09-24T01:00:00Z') }
    expect(businessNowFrom(backwards, new Date('2026-09-24T02:00:00Z')).toISOString()).toBe('2025-01-01T01:00:00.000Z')
  })
})

describe('normalizeClockInput', () => {
  it('精確到秒、當臺灣時間解讀', () => {
    const result = normalizeClockInput({ businessAt: '2027-03-01T10:00:01', reason: ' 驗截止後一秒 ' })
    expect(result).toMatchObject({ ok: true, value: { reason: '驗截止後一秒' } })
    if (result.ok) expect(result.value.businessAt.toISOString()).toBe('2027-03-01T02:00:01.000Z')
  })

  it('原因必填', () => {
    expect(normalizeClockInput({ businessAt: '2027-03-01T10:00:00', reason: '  ' })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      details: { field: 'reason' },
    })
  })

  it('時間格式不對或日期不存在：拒絕', () => {
    expect(normalizeClockInput({ businessAt: '2027/03/01 10:00', reason: 'x' })).toMatchObject({ ok: false, details: { field: 'businessAt' } })
    expect(normalizeClockInput({ businessAt: '2027-02-30T10:00:00', reason: 'x' })).toMatchObject({ ok: false })
    expect(normalizeClockInput({ businessAt: '2027-03-01T24:00:00', reason: 'x' })).toMatchObject({ ok: false })
  })
})
