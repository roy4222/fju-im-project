import { describe, expect, it } from 'vitest'
import type { Activity } from '@/application/cohorts'
import {
  calendarEntries,
  entriesByDay,
  entriesInMonth,
  monthCells,
  shiftMonth,
  staffDeadlines,
  type DeadlineSource,
  type StaffDeadlineRow,
} from '@/app/timeline/calendar-model'

const COHORT = '11111111-1111-4111-8111-111111111111'

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

describe('calendarEntries：活動', () => {
  it('改期：同一個活動只出現在新日期，原日期沒有它（NTF-03 同一來源不重複）', () => {
    // 系辦把 A 從 8/12 改到 8/19：查詢回來的是同一筆、revision 加一。保險起見，就算來源重複給了舊版也只留最新那版。
    const entries = calendarEntries(
      [activity({ revision: 1 }), activity({ startsAt: new Date('2026-08-19T14:00:00+08:00'), revision: 2 })],
      [],
      'student',
    )
    const a = entries.filter((e) => e.title === '活動 A')
    expect(a).toHaveLength(1)
    expect(a[0]!.date).toBe('2026-08-19')
    expect(entriesByDay(entries).get('2026-08-12')).toBeUndefined()
    expect(entriesInMonth(entries, { y: 2026, m: 8 }).filter((e) => e.title === '活動 A')).toHaveLength(1)
  })

  it('取消：仍列在原日期，標「已取消」、tone 是灰的 canceled（COH-03）', () => {
    const [d] = calendarEntries([activity({ id: 'd', title: '活動 D', startsAt: new Date('2026-08-20T10:00:00+08:00'), status: 'cancelled' })], [], 'student')
    expect(d).toMatchObject({ date: '2026-08-20', kind: 'event', canceled: true, label: '已取消', tone: 'canceled' })
  })

  it('改期後再取消：只在新日期、標「已取消」', () => {
    const entries = calendarEntries(
      [activity({ startsAt: new Date('2026-08-19T14:00:00+08:00'), status: 'cancelled', revision: 3 })],
      [],
      'student',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ date: '2026-08-19', label: '已取消', canceled: true })
  })

  it('學生看不到對象「老師」的活動；老師／系辦看得到（NTF-13、Q125）', () => {
    const list = [activity({ id: 'a', title: 'A' }), activity({ id: 'b', title: 'B', audienceKind: 'teachers' })]
    expect(calendarEntries(list, [], 'student').map((e) => e.title)).toEqual(['A'])
    expect(calendarEntries(list, [], 'staff').map((e) => e.title)).toEqual(['A', 'B'])
  })

  it('日期用臺灣日曆日：臺灣 8/13 00:30 在 UTC 是 8/12，月曆要放 8/13', () => {
    const [e] = calendarEntries([activity({ startsAt: new Date('2026-08-12T16:30:00Z') })], [], 'student')
    expect(e).toMatchObject({ date: '2026-08-13', time: '00:30' })
  })

  it('全天活動的時間字是「全天」，同一天排在有時間的前面', () => {
    const entries = calendarEntries(
      [
        activity({ id: 'late', title: '下午', startsAt: new Date('2026-08-12T15:00:00+08:00') }),
        activity({ id: 'all', title: '全天', allDay: true, startsAt: new Date('2026-08-12T00:00:00+08:00') }),
      ],
      [],
      'student',
    )
    expect(entries.map((e) => [e.title, e.time])).toEqual([
      ['全天', '全天'],
      ['下午', '15:00'],
    ])
  })
})

describe('calendarEntries：截止', () => {
  it('截止依 ST-1 的狀態給標籤：逾期／已交（含免繳）／其餘「截止」', () => {
    const entries = calendarEntries(
      [],
      [
        deadline({ id: 'o', title: 'O', status: 'overdue' }),
        deadline({ id: 'd', title: 'D', status: 'done' }),
        deadline({ id: 'x', title: 'X', status: 'exempt' }),
        deadline({ id: 's', title: 'S', status: 'soon' }),
        deadline({ id: 'n', title: 'N', status: 'notOpen' }),
      ],
      'student',
    )
    expect(Object.fromEntries(entries.map((e) => [e.title, e.label]))).toEqual({ O: '逾期', D: '已交', X: '已交', S: '截止', N: '截止' })
    expect(entries.every((e) => e.kind === 'deadline' && !e.canceled)).toBe(true)
  })

  it('改截止日：只出現在新日期（來源就是作業本身，沒有第二份）', () => {
    const entries = calendarEntries([], [deadline({ due: new Date('2026-08-28T23:59:00+08:00') })], 'student')
    expect(entries.map((e) => e.date)).toEqual(['2026-08-28'])
    expect(entriesByDay(entries).get('2026-08-26')).toBeUndefined()
  })

  it('截止點下去去作業那一份', () => {
    const [e] = calendarEntries([], [deadline({})], 'student')
    expect(e).toMatchObject({ href: '/dashboard/student/affairs/i1', time: '23:59', tone: 'deadline' })
  })

  it('老師／系辦視角列學生截止，標「學生截止」、tone 同截止（Q125 B 案，AC-ST-30）', () => {
    const entries = calendarEntries([activity({})], [deadline({ href: '/dashboard/teacher/affairs' })], 'staff')
    expect(entries.map((e) => e.kind)).toEqual(['event', 'deadline'])
    expect(entries[1]).toMatchObject({ label: '學生截止', tone: 'deadline', href: '/dashboard/teacher/affairs', date: '2026-08-26' })
  })

  it('學生視角不會出現「學生截止」（AC-ST-31）', () => {
    expect(calendarEntries([], [deadline({})], 'student').map((e) => e.label)).toEqual(['截止'])
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

  it('連到給的列表頁（兩頁都沒有單篇錨點）', () => {
    const [d] = staffDeadlines([row({})], '/dashboard/admin/affairs?cohort=c1')
    expect(d!.href).toBe('/dashboard/admin/affairs?cohort=c1')
  })
})

describe('月格', () => {
  it('週一開頭：2026-08-01 是星期六，前面空 5 格，共 31 天', () => {
    const cells = monthCells({ y: 2026, m: 8 })
    expect(cells.slice(0, 6)).toEqual([null, null, null, null, null, '2026-08-01'])
    expect(cells.filter(Boolean)).toHaveLength(31)
    expect(cells.at(-1)).toBe('2026-08-31')
  })

  it('2 月（平年 28 天）與跨年翻月', () => {
    expect(monthCells({ y: 2027, m: 2 }).filter(Boolean)).toHaveLength(28)
    expect(shiftMonth({ y: 2026, m: 12 }, 1)).toEqual({ y: 2027, m: 1 })
    expect(shiftMonth({ y: 2026, m: 1 }, -1)).toEqual({ y: 2025, m: 12 })
  })

  it('entriesInMonth 只留那個月的', () => {
    const entries = calendarEntries(
      [activity({ id: 'a' }), activity({ id: 'b', title: '9 月的', startsAt: new Date('2026-09-02T10:00:00+08:00') })],
      [],
      'student',
    )
    expect(entriesInMonth(entries, { y: 2026, m: 9 }).map((e) => e.title)).toEqual(['9 月的'])
  })
})
