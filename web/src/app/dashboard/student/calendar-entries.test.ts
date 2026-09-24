import { describe, expect, it } from 'vitest'
import { calendarEntries, upcoming } from '@/app/dashboard/student/calendar-entries'
import type { Activity } from '@/application/cohorts'
import type { MyDeadline } from '@/application/items'

const COHORT = '11111111-1111-4111-8111-111111111111'

function activity(patch: Partial<Activity>): Activity {
  return {
    id: 'a1',
    cohortId: COHORT,
    title: '專題說明會',
    description: null,
    startsAt: new Date('2026-10-05T06:00:00Z'),
    endsAt: null,
    allDay: false,
    audienceKind: 'cohort_students',
    status: 'scheduled',
    revision: 1,
    ...patch,
  }
}

function deadline(patch: Partial<MyDeadline>): MyDeadline {
  return {
    itemId: 'i1',
    cohortId: COHORT,
    title: '期中報告',
    dueAt: new Date('2026-11-15T15:59:00Z'),
    receiverUnit: 'group',
    ...patch,
  }
}

describe('calendarEntries：屆別活動＋收件截止，換成臺灣日曆日', () => {
  it('截止用臺灣日期與時間：UTC 前一天的 16:30 是臺灣隔天 00:30', () => {
    const [entry] = calendarEntries([], [deadline({ dueAt: new Date('2026-11-14T16:30:00Z') })])
    expect(entry).toMatchObject({ date: '2026-11-15', time: '00:30', kind: 'deadline', title: '期中報告 截止' })
  })

  it('活動：只給老師的不列；取消的列出來標已取消；全天的寫「全天」且排在當天最前', () => {
    const entries = calendarEntries(
      [
        activity({ id: 'a1', startsAt: new Date('2026-10-05T06:00:00Z') }),
        activity({ id: 'a2', title: '老師會議', audienceKind: 'teachers' }),
        activity({ id: 'a3', title: '改期前', status: 'cancelled', startsAt: new Date('2026-10-06T02:00:00Z') }),
        activity({ id: 'a4', title: '成果展', allDay: true, startsAt: new Date('2026-10-04T16:00:00Z') }),
      ],
      [],
    )
    expect(entries.map((e) => [e.date, e.time, e.title, e.cancelled])).toEqual([
      ['2026-10-05', '全天', '成果展', false],
      ['2026-10-05', '14:00', '專題說明會', false],
      ['2026-10-06', '10:00', '改期前', true],
    ])
  })

  it('接下來：今天以後、沒取消的，照時間', () => {
    const entries = calendarEntries(
      [activity({ id: 'old', startsAt: new Date('2026-09-01T02:00:00Z') }), activity({ id: 'x', status: 'cancelled' })],
      [deadline({})],
    )
    expect(upcoming(entries, '2026-09-24').map((e) => e.id)).toEqual(['due-i1'])
  })
})
