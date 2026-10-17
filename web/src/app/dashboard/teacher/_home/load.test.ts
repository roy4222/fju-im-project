import { describe, expect, it, vi } from 'vitest'
import type { Activity } from '@/application/cohorts'

// 只測純函式 `upcomingActivities`；讀資料庫的組裝層不載入。
vi.mock('@/app/_ui/workload', () => ({}))
vi.mock('@/app/dashboard/_stage', () => ({}))
vi.mock('@/composition/cohorts', () => ({}))
vi.mock('@/composition/items', () => ({}))
vi.mock('@/composition/submissions', () => ({}))

const { upcomingActivities } = await import('@/app/dashboard/teacher/_home/load')

const WORKING = 'c-working'
const ADVISED = 'c-advised'
const TODAY = '2026-10-17'

let created = 0
function activity(id: string, cohortId: string, startsAt: string, patch: Partial<Activity> = {}): Activity & { createdAt: number } {
  return {
    id,
    cohortId,
    title: id,
    description: null,
    startsAt: new Date(startsAt),
    endsAt: null,
    allDay: false,
    audienceKind: 'signed_in',
    status: 'scheduled',
    revision: 1,
    createdAt: (created += 1),
    ...patch,
  }
}

/** 改前的做法：逐屆查（每屆依開始時間、建立時間）、依 `cohortIds` 順序攤平，再穩定排序開始時間。 */
function before(all: readonly (Activity & { createdAt: number })[], cohortIds: string[], advisedCohorts: string[]) {
  const perCohort = (id: string) =>
    all.filter((a) => a.cohortId === id).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.createdAt - b.createdAt)
  return cohortIds
    .flatMap(perCohort)
    .filter((a) => a.status === 'scheduled' && a.startsAt.toISOString().slice(0, 10) >= TODAY)
    .filter((a) => a.audienceKind !== 'cohort_students' || advisedCohorts.includes(a.cohortId))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, 5)
}

/** 改後的查詢 `activitiesFor`：所有屆別一起，依開始時間、建立時間。 */
function together(all: readonly (Activity & { createdAt: number })[]) {
  return [...all].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.createdAt - b.createdAt)
}

describe('老師首頁本屆活動排序（TE-07b）', () => {
  it('同一開始時間、不同屆別：工作屆別排前面，跟改前一樣（即使指導屆別的活動先建立）', () => {
    const all = [
      activity('advised-noon', ADVISED, '2026-12-01T04:00:00Z'),
      activity('working-noon', WORKING, '2026-12-01T04:00:00Z'),
    ]
    const cohortIds = [WORKING, ADVISED]
    const after = upcomingActivities(together(all), { cohortIds, advisedCohorts: [ADVISED], today: TODAY })
    expect(after.map((a) => a.id)).toEqual(['working-noon', 'advised-noon'])
    expect(after.map((a) => a.id)).toEqual(before(all, cohortIds, [ADVISED]).map((a) => a.id))
  })

  it('卡在第 5 筆邊界、混著取消與「本屆學生」的：結果跟改前相同', () => {
    const all = [
      activity('a1', ADVISED, '2026-11-01T02:00:00Z'),
      activity('a2', ADVISED, '2026-11-02T02:00:00Z', { audienceKind: 'cohort_students' }),
      activity('w1', WORKING, '2026-11-01T02:00:00Z'),
      activity('w-students', WORKING, '2026-11-01T01:00:00Z', { audienceKind: 'cohort_students' }),
      activity('w-cancelled', WORKING, '2026-10-30T02:00:00Z', { status: 'cancelled' }),
      activity('w-past', WORKING, '2026-10-01T02:00:00Z'),
      activity('a3', ADVISED, '2026-11-05T02:00:00Z'),
      activity('w2', WORKING, '2026-11-05T02:00:00Z'),
      activity('w3', WORKING, '2026-11-05T02:00:00Z'),
      activity('a4', ADVISED, '2026-11-05T02:00:00Z'),
    ]
    const cohortIds = [WORKING, ADVISED]
    const after = upcomingActivities(together(all), { cohortIds, advisedCohorts: [ADVISED], today: TODAY })
    expect(after.map((a) => a.id)).toEqual(before(all, cohortIds, [ADVISED]).map((a) => a.id))
    expect(after.map((a) => a.id)).toEqual(['w1', 'a1', 'a2', 'w2', 'w3'])
  })
})
