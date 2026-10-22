import { describe, expect, it } from 'vitest'
import { atTaiwan, daysFromNow } from '../../e2e/clock'

describe('e2e/clock', () => {
  it('daysFromNow：臺灣當天加 n 天的日期字串', () => {
    expect(daysFromNow(3, new Date('2026-10-20T03:00:00Z'))).toBe('2026-10-23')
    expect(daysFromNow(0, new Date('2026-10-20T03:00:00Z'))).toBe('2026-10-20')
    expect(daysFromNow(-1, new Date('2026-10-20T03:00:00Z'))).toBe('2026-10-19')
  })

  it('daysFromNow：UTC 還是前一天、臺灣已經跨日時，以臺灣為準', () => {
    // UTC 10/19 16:30 ＝ 臺灣 10/20 00:30。
    expect(daysFromNow(3, new Date('2026-10-19T16:30:00Z'))).toBe('2026-10-23')
    // UTC 10/19 15:59 ＝ 臺灣 10/19 23:59。
    expect(daysFromNow(3, new Date('2026-10-19T15:59:00Z'))).toBe('2026-10-22')
  })

  it('daysFromNow：跨月、跨年', () => {
    expect(daysFromNow(3, new Date('2026-12-30T00:00:00Z'))).toBe('2027-01-02')
  })

  it('atTaiwan：臺灣牆上時間換成 UTC 瞬間', () => {
    expect(atTaiwan('2026-10-23').toISOString()).toBe('2026-10-22T16:00:00.000Z')
    expect(atTaiwan('2026-10-23', '09:30').toISOString()).toBe('2026-10-23T01:30:00.000Z')
  })

  it('atTaiwan 與 daysFromNow 對得起來：daysFromNow(n) 那天的 00:00', () => {
    const now = new Date('2026-10-20T03:00:00Z')
    expect(atTaiwan(daysFromNow(3, now)).getTime() - atTaiwan(daysFromNow(0, now)).getTime()).toBe(3 * 86_400_000)
  })

  it('atTaiwan：格式不對就丟錯', () => {
    expect(() => atTaiwan('2026/10/23')).toThrow()
    expect(() => atTaiwan('2026-10-23', '9:30')).toThrow()
  })
})
