import { describe, expect, it } from 'vitest'
import {
  BusinessClock,
  FixedClock,
  RealClock,
  TAIPEI_UTC_OFFSET_MINUTES,
  addTaipeiDays,
  formatTaipeiDate,
  formatTaipeiMinute,
  formatTaipeiSecond,
  isValidTaipeiDate,
  parseTaipeiDateTime,
  toTaipeiDateTimeInput,
  isDeadlinePassed,
  isOnTime,
  isWithinDateRange,
  taipeiDateOf,
  taipeiDayEndExclusive,
  taipeiDayStart,
  taipeiMinuteStart,
  taipeiParts,
  toUtcIsoString,
} from '@/shared/time'

describe('臺灣日界', () => {
  it('偏移固定 +08:00', () => {
    expect(TAIPEI_UTC_OFFSET_MINUTES).toBe(480)
  })

  it('某天 00:00 對應前一天 16:00 UTC', () => {
    expect(toUtcIsoString(taipeiDayStart('2026-11-15'))).toBe('2026-11-14T16:00:00.000Z')
  })

  it('日界前一毫秒仍算前一天，日界當下換日', () => {
    const start = taipeiDayStart('2026-11-15')
    expect(taipeiDateOf(new Date(start.getTime() - 1))).toBe('2026-11-14')
    expect(taipeiDateOf(start)).toBe('2026-11-15')
  })

  it('跨年與閏日都用同一條換算', () => {
    expect(taipeiDateOf(new Date('2026-12-31T15:59:59.999Z'))).toBe('2026-12-31')
    expect(taipeiDateOf(new Date('2026-12-31T16:00:00.000Z'))).toBe('2027-01-01')
    expect(toUtcIsoString(taipeiDayStart('2028-02-29'))).toBe('2028-02-28T16:00:00.000Z')
  })

  it('日末是隔天 00:00（半開區間）', () => {
    expect(taipeiDayEndExclusive('2026-11-15').getTime()).toBe(taipeiDayStart('2026-11-16').getTime())
  })

  it('拆出的年月日時分是臺灣時間', () => {
    expect(taipeiParts(new Date('2026-11-15T15:59:30.000Z'))).toEqual({
      year: 2026,
      month: 11,
      day: 15,
      hour: 23,
      minute: 59,
      second: 30,
    })
  })

  it('格式不對就丟錯，不默默當成別的日期', () => {
    expect(() => taipeiDayStart('2026/11/15')).toThrow(RangeError)
    expect(() => taipeiMinuteStart('2026-11-15', '24:00')).toThrow(RangeError)
  })
})

describe('截止分鐘：到下一分鐘開始前都算準時', () => {
  const deadline = taipeiMinuteStart('2026-11-15', '23:59')

  it('截止分鐘的起點對應 UTC 15:59', () => {
    expect(toUtcIsoString(deadline)).toBe('2026-11-15T15:59:00.000Z')
  })

  it('截止分鐘內（含 59.999 秒）算準時', () => {
    expect(isOnTime(deadline, deadline)).toBe(true)
    expect(isOnTime(new Date(deadline.getTime() + 59_999), deadline)).toBe(true)
  })

  it('下一分鐘的第一毫秒就遲了', () => {
    const justLate = new Date(deadline.getTime() + 60_000)
    expect(isOnTime(justLate, deadline)).toBe(false)
    expect(isDeadlinePassed(justLate, deadline)).toBe(true)
  })

  it('截止前一毫秒當然準時', () => {
    expect(isOnTime(new Date(deadline.getTime() - 1), deadline)).toBe(true)
  })
})

describe('階段與年度：結束日含當天', () => {
  const range = { startDate: '2026-09-01', endDate: '2027-06-30' }

  it('開始日 00:00 就算在期間內，前一毫秒不算', () => {
    expect(isWithinDateRange(taipeiDayStart('2026-09-01'), range)).toBe(true)
    expect(isWithinDateRange(new Date(taipeiDayStart('2026-09-01').getTime() - 1), range)).toBe(false)
  })

  it('結束日整天都算在內', () => {
    expect(isWithinDateRange(taipeiMinuteStart('2027-06-30', '00:00'), range)).toBe(true)
    expect(isWithinDateRange(new Date(taipeiDayEndExclusive('2027-06-30').getTime() - 1), range)).toBe(true)
  })

  it('結束日隔天 00:00 就出界', () => {
    expect(isWithinDateRange(taipeiDayStart('2027-07-01'), range)).toBe(false)
  })

  it('沒有結束日就永遠不會出界', () => {
    expect(isWithinDateRange(taipeiDayStart('2099-01-01'), { startDate: '2026-09-01' })).toBe(true)
  })
})

describe('時鐘', () => {
  it('業務鐘預設等於基準時鐘', () => {
    const base = new FixedClock(new Date('2026-11-15T15:59:00.000Z'))
    expect(new BusinessClock(base).now().toISOString()).toBe('2026-11-15T15:59:00.000Z')
  })

  it('業務鐘可以被推動，真實時鐘不受影響', () => {
    const real = new FixedClock(new Date('2026-11-15T15:59:00.000Z'))
    const business = new BusinessClock(real)
    business.advance(24 * 60 * 60 * 1000)
    expect(taipeiDateOf(business.now())).toBe('2026-11-16')
    expect(taipeiDateOf(real.now())).toBe('2026-11-15')
  })

  it('業務鐘可以直接設到某個瞬間', () => {
    const business = new BusinessClock(new FixedClock(new Date('2026-11-15T00:00:00.000Z')))
    business.setTo(new Date('2027-06-30T16:00:00.000Z'))
    expect(business.now().toISOString()).toBe('2027-06-30T16:00:00.000Z')
  })

  it('真實時鐘回的是現在', () => {
    const before = Date.now()
    const now = new RealClock().now().getTime()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })
})

describe('畫面格式', () => {
  it('截止顯示用臺灣時間到分鐘', () => {
    expect(formatTaipeiMinute(taipeiMinuteStart('2026-11-15', '23:59'))).toBe('2026/11/15 23:59')
  })
})

describe('票 11 補的日期工具', () => {
  it('isValidTaipeiDate 擋掉不存在的日期', () => {
    expect(isValidTaipeiDate('2028-02-29')).toBe(true)
    expect(isValidTaipeiDate('2027-02-29')).toBe(false)
    expect(isValidTaipeiDate('2026-13-01')).toBe(false)
    expect(isValidTaipeiDate('2026-9-1')).toBe(false)
  })

  it('addTaipeiDays 跨月、跨年都對', () => {
    expect(addTaipeiDays('2026-11-01', -1)).toBe('2026-10-31')
    expect(addTaipeiDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('parseTaipeiDateTime 當臺灣時間解讀、可帶秒；toTaipeiDateTimeInput 是它的反向', () => {
    const instant = parseTaipeiDateTime('2027-03-01T10:00:59')!
    expect(instant.toISOString()).toBe('2027-03-01T02:00:59.000Z')
    expect(toTaipeiDateTimeInput(instant)).toBe('2027-03-01T10:00:59')
    expect(parseTaipeiDateTime('2027-03-01T10:00')!.toISOString()).toBe('2027-03-01T02:00:00.000Z')
    expect(parseTaipeiDateTime('2027-03-01 10:00')).toBeNull()
    expect(parseTaipeiDateTime('2027-03-01T10:60')).toBeNull()
  })

  it('畫面格式到秒、日期', () => {
    expect(formatTaipeiSecond(new Date('2027-03-01T02:00:59Z'))).toBe('2027/03/01 10:00:59')
    expect(formatTaipeiDate('2026-09-15')).toBe('2026-09-15')
  })
})
