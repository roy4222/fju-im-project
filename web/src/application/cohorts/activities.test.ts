import { describe, expect, it } from 'vitest'
import {
  activityDeleteBlocker,
  activityFormValues,
  formatActivityWhen,
  normalizeActivityInput,
  planActivityMove,
  type ActivityInput,
} from '@/application/cohorts/activities'

const base: ActivityInput = {
  title: '期中發表會',
  description: '',
  startDate: '2026-12-20',
  endDate: '',
  allDay: false,
  startTime: '14:00',
  endTime: '16:00',
  audience: 'cohort_students',
}

const IDS = { id: '00000000-0000-4000-8000-000000000000', cohortId: '00000000-0000-4000-8000-000000000001' }

describe('normalizeActivityInput', () => {
  it('有時間的活動：日期與時間當臺灣時間換成 UTC；結束日空白＝同一天', () => {
    const result = normalizeActivityInput(base)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.startsAt.toISOString()).toBe('2026-12-20T06:00:00.000Z')
    expect(result.value.endsAt?.toISOString()).toBe('2026-12-20T08:00:00.000Z')
    expect(result.value.description).toBeNull()
    expect(formatActivityWhen(result.value)).toBe('2026-12-20 14:00–16:00')
  })

  it('全天單日：從臺灣 00:00 開始、ends_at＝次日 00:00，時間欄忽略', () => {
    const result = normalizeActivityInput({ ...base, allDay: true, startTime: 'xx', endTime: '' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.startsAt.toISOString()).toBe('2026-12-19T16:00:00.000Z')
    expect(result.value.endsAt?.toISOString()).toBe('2026-12-20T16:00:00.000Z')
    expect(formatActivityWhen(result.value)).toBe('2026-12-20（全天）')
  })

  it('AC-C3-32：全天跨日 3/10–3/12 → ends_at＝3/13 00:00（臺灣）；畫面「3/10–3/12」', () => {
    const result = normalizeActivityInput({ ...base, allDay: true, startDate: '2027-03-10', endDate: '2027-03-12' })
    if (!result.ok) throw new Error(result.message)
    expect(result.value.startsAt.toISOString()).toBe('2027-03-09T16:00:00.000Z')
    expect(result.value.endsAt?.toISOString()).toBe('2027-03-12T16:00:00.000Z')
    expect(formatActivityWhen(result.value)).toBe('3/10–3/12')
  })

  it('AC-C3-32：有時間跨日 4/1 09:00–4/2 17:00；畫面帶星期', () => {
    const result = normalizeActivityInput({ ...base, startDate: '2027-04-01', endDate: '2027-04-02', startTime: '09:00', endTime: '17:00' })
    if (!result.ok) throw new Error(result.message)
    expect(result.value.startsAt.toISOString()).toBe('2027-04-01T01:00:00.000Z')
    expect(result.value.endsAt?.toISOString()).toBe('2027-04-02T09:00:00.000Z')
    expect(formatActivityWhen(result.value)).toBe('4/1（四）09:00–4/2（五）17:00')
  })

  it('AC-C3-48(a)：非全天跨日沒填結束時間 → 拒「跨日的活動要填結束時間」；單日留空 → ends_at NULL', () => {
    const crossDay = normalizeActivityInput({ ...base, startDate: '2027-04-01', endDate: '2027-04-02', startTime: '09:00', endTime: '' })
    expect(crossDay).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'endTime' } })
    expect(crossDay.ok ? '' : crossDay.message).toContain('跨日的活動要填結束時間')

    const singleDay = normalizeActivityInput({ ...base, startDate: '2027-04-01', endDate: '2027-04-01', startTime: '09:00', endTime: '' })
    if (!singleDay.ok) throw new Error(singleDay.message)
    expect(singleDay.value.endsAt).toBeNull()
    expect(formatActivityWhen(singleDay.value)).toBe('2027-04-01 09:00')
  })

  it('拒絕：沒名稱、日期不存在、結束日早於開始日、不是全天又沒開始時間、同一天結束不晚於開始、受眾不認得', () => {
    expect(normalizeActivityInput({ ...base, title: ' ' })).toMatchObject({ ok: false, details: { field: 'title' } })
    expect(normalizeActivityInput({ ...base, startDate: '2026-02-30' })).toMatchObject({ ok: false, details: { field: 'startDate' } })
    expect(normalizeActivityInput({ ...base, endDate: '2026-02-30' })).toMatchObject({ ok: false, details: { field: 'endDate' } })
    expect(normalizeActivityInput({ ...base, endDate: '2026-12-19' })).toMatchObject({
      ok: false,
      message: '結束日不能早於開始日。',
      details: { field: 'endDate' },
    })
    expect(normalizeActivityInput({ ...base, startTime: '' })).toMatchObject({ ok: false, details: { field: 'startTime' } })
    expect(normalizeActivityInput({ ...base, endTime: '13:00' })).toMatchObject({ ok: false, details: { field: 'endTime' } })
    expect(normalizeActivityInput({ ...base, endTime: '14:00' })).toMatchObject({ ok: false, details: { field: 'endTime' } })
    expect(normalizeActivityInput({ ...base, audience: 'everyone' })).toMatchObject({ ok: false, details: { field: 'audience' } })
  })

  it('編輯表單的預填值與原本輸入一致（來回一趟不走樣；單日結束日帶開始日）', () => {
    for (const input of [
      { ...base, endDate: '2026-12-20' },
      { ...base, allDay: true, startTime: '', endTime: '', endDate: '2026-12-20' },
      { ...base, allDay: true, startTime: '', endTime: '', endDate: '2026-12-23' },
      { ...base, endDate: '2026-12-21', endTime: '10:00' },
      { ...base, endDate: '2026-12-20', endTime: '' },
    ]) {
      const result = normalizeActivityInput(input)
      if (!result.ok) throw new Error(result.message)
      expect(activityFormValues({ ...IDS, status: 'scheduled', revision: 1, ...result.value })).toEqual(input)
    }
  })
})

describe('planActivityMove（拖拉只改起訖日）', () => {
  const timed = (endTime: string) => {
    const r = normalizeActivityInput({ ...base, startDate: '2027-04-01', startTime: '09:00', endTime })
    if (!r.ok) throw new Error(r.message)
    return r.value
  }

  it('AC-C3-48(c)：非全天、沒有結束時間的拉成跨日 → VALIDATION_FAILED 同一句', () => {
    const result = planActivityMove(timed(''), { startDate: '2027-04-01', endDate: '2027-04-02' })
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(result.ok ? '' : result.message).toContain('跨日的活動要填結束時間')
  })

  it('AC-C3-48(d)：整段平移到 4/3 → 09:00 照舊、ends_at 仍 NULL', () => {
    const result = planActivityMove(timed(''), { startDate: '2027-04-03', endDate: '2027-04-03' })
    if (!result.ok) throw new Error(result.message)
    expect(result.value.startsAt.toISOString()).toBe('2027-04-03T01:00:00.000Z')
    expect(result.value.endsAt).toBeNull()
  })

  it('有結束時間的可以拉成跨日：時刻沿用', () => {
    const result = planActivityMove(timed('17:00'), { startDate: '2027-04-01', endDate: '2027-04-02' })
    if (!result.ok) throw new Error(result.message)
    expect(result.value.endsAt?.toISOString()).toBe('2027-04-02T09:00:00.000Z')
  })

  it('全天：照新起訖重算（結束日的次日 00:00）；結束日早於開始日被擋', () => {
    const r = normalizeActivityInput({ ...base, allDay: true })
    if (!r.ok) throw new Error(r.message)
    const result = planActivityMove(r.value, { startDate: '2027-03-10', endDate: '2027-03-12' })
    if (!result.ok) throw new Error(result.message)
    expect(result.value.startsAt.toISOString()).toBe('2027-03-09T16:00:00.000Z')
    expect(result.value.endsAt?.toISOString()).toBe('2027-03-12T16:00:00.000Z')
    expect(planActivityMove(r.value, { startDate: '2027-03-10', endDate: '2027-03-09' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })
})

describe('activityDeleteBlocker（AC-C3-37）', () => {
  it('排定中、已取消都能刪；只擋已刪除的', () => {
    expect(activityDeleteBlocker({ deleted: false })).toBeNull()
    expect(activityDeleteBlocker({ deleted: true })).toContain('找不到這個活動')
  })
})
