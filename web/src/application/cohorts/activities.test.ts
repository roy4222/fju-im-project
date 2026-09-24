import { describe, expect, it } from 'vitest'
import {
  activityFormValues,
  formatActivityWhen,
  normalizeActivityInput,
  type ActivityInput,
} from '@/application/cohorts/activities'

const base: ActivityInput = {
  title: '期中發表會',
  description: '',
  date: '2026-12-20',
  allDay: false,
  startTime: '14:00',
  endTime: '16:00',
  audience: 'cohort_students',
}

describe('normalizeActivityInput', () => {
  it('有時間的活動：日期與時間當臺灣時間換成 UTC', () => {
    const result = normalizeActivityInput(base)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.startsAt.toISOString()).toBe('2026-12-20T06:00:00.000Z')
    expect(result.value.endsAt?.toISOString()).toBe('2026-12-20T08:00:00.000Z')
    expect(result.value.description).toBeNull()
    expect(formatActivityWhen(result.value)).toBe('2026/12/20 14:00–16:00')
  })

  it('全天：從臺灣 00:00 開始、沒有結束時間，時間欄忽略', () => {
    const result = normalizeActivityInput({ ...base, allDay: true, startTime: 'xx', endTime: '' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.startsAt.toISOString()).toBe('2026-12-19T16:00:00.000Z')
    expect(result.value.endsAt).toBeNull()
    expect(formatActivityWhen(result.value)).toBe('2026/12/20（全天）')
  })

  it('拒絕：沒名稱、日期不存在、不是全天又沒開始時間、結束早於開始、受眾不認得', () => {
    expect(normalizeActivityInput({ ...base, title: ' ' })).toMatchObject({ ok: false, details: { field: 'title' } })
    expect(normalizeActivityInput({ ...base, date: '2026-02-30' })).toMatchObject({ ok: false, details: { field: 'date' } })
    expect(normalizeActivityInput({ ...base, startTime: '' })).toMatchObject({ ok: false, details: { field: 'startTime' } })
    expect(normalizeActivityInput({ ...base, endTime: '13:00' })).toMatchObject({ ok: false, details: { field: 'endTime' } })
    expect(normalizeActivityInput({ ...base, audience: 'everyone' })).toMatchObject({ ok: false, details: { field: 'audience' } })
  })

  it('改期表單的預填值與原本輸入一致（來回一趟不走樣）', () => {
    const result = normalizeActivityInput(base)
    if (!result.ok) throw new Error(result.message)
    const values = activityFormValues({
      id: '00000000-0000-4000-8000-000000000000',
      cohortId: '00000000-0000-4000-8000-000000000001',
      status: 'scheduled',
      revision: 1,
      ...result.value,
    })
    expect(values).toEqual(base)
  })
})
