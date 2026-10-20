import { describe, expect, it } from 'vitest'
import type { Activity } from '@/application/cohorts'
import {
  entriesByMonth,
  ganttActivity,
  ganttDeadlines,
  staffDeadlines,
  timelineEntries,
  visibleActivities,
  type DeadlineSource,
  type EntryFormat,
  type StaffDeadlineRow,
} from '@/app/timeline/activity-visibility'

const COHORT = '11111111-1111-4111-8111-111111111111'

/** 頁面傳的是 composition 的 `formatActivityWhen`／`ACTIVITY_AUDIENCE_LABEL`；這裡只驗有照它填。 */
const FORMAT: EntryFormat = { when: (a) => `when:${a.id}`, audience: (kind) => `aud:${kind}` }

function activity(patch: Partial<Activity>): Activity {
  return {
    id: 'a1',
    cohortId: COHORT,
    title: '活動 A',
    description: null,
    startsAt: new Date('2026-08-12T14:00:00+08:00'),
    endsAt: null,
    allDay: false,
    audienceKind: 'signed_in',
    status: 'scheduled',
    revision: 1,
    ...patch,
  }
}

function deadline(patch: Partial<DeadlineSource>): DeadlineSource {
  return {
    id: 'i1',
    title: '期中報告',
    due: new Date('2026-08-26T23:59:00+08:00'),
    status: 'open',
    href: '/dashboard/student/affairs/i1',
    ...patch,
  }
}

describe('visibleActivities', () => {
  it('改期：同一個 id 只留 revision 最新的一版（NTF-03 同一來源不重複）', () => {
    const list = visibleActivities(
      [activity({ startsAt: new Date('2026-08-19T14:00:00+08:00'), revision: 2 }), activity({ revision: 1 })],
      'student',
    )
    expect(list).toHaveLength(1)
    expect(list[0]!.revision).toBe(2)
  })

  it('學生看不到對象「只給老師」的活動；老師／系辦看得到（NTF-13、Q125）', () => {
    const list = [activity({ id: 'a', title: 'A' }), activity({ id: 'b', title: 'B', audienceKind: 'teachers' })]
    expect(visibleActivities(list, 'student').map((a) => a.title)).toEqual(['A'])
    expect(visibleActivities(list, 'staff').map((a) => a.title)).toEqual(['A', 'B'])
  })

  it('照開始時間排；已取消的也留著（甘特自己不畫，清單劃掉）', () => {
    const list = visibleActivities(
      [activity({ id: 'late', startsAt: new Date('2026-09-01T10:00:00+08:00') }), activity({ id: 'early', status: 'cancelled' })],
      'student',
    )
    expect(list.map((a) => [a.id, a.status])).toEqual([
      ['early', 'cancelled'],
      ['late', 'scheduled'],
    ])
  })
})

describe('ganttActivity／ganttDeadlines', () => {
  it('全天跨日：結束日含當天（endsAt 是次日 00:00），沒有時間字', () => {
    const g = ganttActivity(
      activity({ allDay: true, startsAt: new Date('2027-03-10T00:00:00+08:00'), endsAt: new Date('2027-03-13T00:00:00+08:00') }),
    )
    expect(g).toMatchObject({ startDate: '2027-03-10', endDate: '2027-03-12', allDay: true, startTime: null, endTime: null, timeText: null })
  })

  it('有時間：沒寫結束時間是單日「14:00」；有結束時間是「09:00–17:00」', () => {
    expect(ganttActivity(activity({}))).toMatchObject({ startDate: '2026-08-12', endDate: '2026-08-12', startTime: '14:00', endTime: null, timeText: '14:00' })
    const g = ganttActivity(activity({ startsAt: new Date('2027-03-10T09:00:00+08:00'), endsAt: new Date('2027-03-11T17:00:00+08:00') }))
    expect(g).toMatchObject({ startDate: '2027-03-10', endDate: '2027-03-11', timeText: '09:00–17:00', status: 'scheduled', revision: 1 })
  })

  it('日期用臺灣日曆日：臺灣 8/13 00:30 在 UTC 是 8/12', () => {
    expect(ganttActivity(activity({ startsAt: new Date('2026-08-12T16:30:00Z') })).startDate).toBe('2026-08-13')
    expect(ganttDeadlines([deadline({ due: new Date('2026-08-25T16:30:00Z') })])).toEqual([
      { id: 'i1', title: '期中報告', date: '2026-08-26', href: '/dashboard/student/affairs/i1' },
    ])
  })

  it('沒有截止日的不畫', () => {
    expect(ganttDeadlines([deadline({ due: null })])).toEqual([])
  })
})

describe('timelineEntries', () => {
  it('活動列：時間、對象、說明；取消的標「已取消」、canceled', () => {
    const [a, d] = timelineEntries(
      [
        activity({ description: '在 LM503' }),
        activity({ id: 'd', title: '活動 D', startsAt: new Date('2026-08-20T10:00:00+08:00'), status: 'cancelled', audienceKind: 'cohort_students' }),
      ],
      [],
      'student',
      FORMAT,
    )
    expect(a).toMatchObject({ anchor: 'activity-a1', kind: 'activity', date: '2026-08-12', when: 'when:a1', audience: 'aud:signed_in', description: '在 LM503', label: '活動', canceled: false, href: null })
    expect(d).toMatchObject({ anchor: 'activity-d', label: '已取消', canceled: true, audience: 'aud:cohort_students' })
  })

  it('截止依 ST-1 的狀態給標籤：逾期／已交（含免繳）／其餘「截止」；連到作業那一份', () => {
    const entries = timelineEntries(
      [],
      [
        deadline({ id: 'o', title: 'O', status: 'overdue' }),
        deadline({ id: 'd', title: 'D', status: 'done' }),
        deadline({ id: 'x', title: 'X', status: 'exempt' }),
        deadline({ id: 's', title: 'S', status: 'soon' }),
      ],
      'student',
      FORMAT,
    )
    expect(Object.fromEntries(entries.map((e) => [e.title, e.label]))).toEqual({ O: '逾期', D: '已交', X: '已交', S: '截止' })
    expect(entries[0]).toMatchObject({ kind: 'deadline', when: '2026-08-26 23:59', href: '/dashboard/student/affairs/i1', audience: null })
  })

  it('老師／系辦視角的截止標「學生截止」；學生視角不會出現', () => {
    expect(timelineEntries([], [deadline({ href: '/dashboard/teacher/affairs' })], 'staff', FORMAT)[0]).toMatchObject({ label: '學生截止', href: '/dashboard/teacher/affairs' })
    expect(timelineEntries([], [deadline({})], 'student', FORMAT).map((e) => e.label)).toEqual(['截止'])
  })

  it('照時間排；同一天全天的排最前', () => {
    const entries = timelineEntries(
      [
        activity({ id: 'late', title: '下午', startsAt: new Date('2026-08-26T15:00:00+08:00') }),
        activity({ id: 'all', title: '全天', allDay: true, startsAt: new Date('2026-08-26T00:00:00+08:00'), endsAt: new Date('2026-08-27T00:00:00+08:00') }),
      ],
      [deadline({})],
      'student',
      FORMAT,
    )
    expect(entries.map((e) => e.title)).toEqual(['全天', '下午', '期中報告'])
  })
})

describe('entriesByMonth', () => {
  it('依月份分組，標「8 月」「9 月」', () => {
    const entries = timelineEntries([activity({}), activity({ id: 'b', startsAt: new Date('2026-09-02T10:00:00+08:00') })], [deadline({})], 'student', FORMAT)
    expect(entriesByMonth(entries).map((g) => [g.label, g.entries.length])).toEqual([
      ['8 月', 2],
      ['9 月', 1],
    ])
  })

  it('跨年但月份不重複只寫月；同一個月份出現在兩年才帶年份', () => {
    const dec = activity({ id: 'dec', startsAt: new Date('2026-12-02T10:00:00+08:00') })
    const jan = activity({ id: 'jan', startsAt: new Date('2027-01-05T10:00:00+08:00') })
    expect(entriesByMonth(timelineEntries([dec, jan], [], 'student', FORMAT)).map((g) => g.label)).toEqual(['12 月', '1 月'])
    const nextDec = activity({ id: 'dec2', startsAt: new Date('2027-12-02T10:00:00+08:00') })
    expect(entriesByMonth(timelineEntries([dec, jan, nextDec], [], 'student', FORMAT)).map((g) => g.label)).toEqual(['2026 年 12 月', '2027 年 1 月', '2027 年 12 月'])
  })
})

describe('staffDeadlines：老師／系辦看的學生截止來源', () => {
  const row = (patch: Partial<StaffDeadlineRow>): StaffDeadlineRow => ({
    id: 'i1',
    title: '期中報告',
    status: 'published',
    dueAt: new Date('2026-08-26T23:59:00+08:00'),
    ...patch,
  })

  it('只取已發布且有截止日的；草稿、已封存、沒有截止日的都不列', () => {
    const list = staffDeadlines(
      [row({}), row({ id: 'd', status: 'draft' }), row({ id: 'u', status: 'archived' }), row({ id: 'n', dueAt: null })],
      '/dashboard/teacher/affairs',
    )
    expect(list).toEqual([{ id: 'i1', title: '期中報告', due: new Date('2026-08-26T23:59:00+08:00'), status: 'open', href: '/dashboard/teacher/affairs' }])
  })
})
