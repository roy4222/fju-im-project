import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedActor } from '@/application/accounts'

// CL-3（#819）：即時查學號加節流——同一個人一分鐘內查太多次就先擋，不再進查詢（防拿來掃同屆名單）。
// 擋掉 composition，單元測試不碰資料庫；只看第幾次開始被擋、被擋時有沒有進查詢、換人或過了一分鐘會不會恢復。
const state = vi.hoisted(() => ({ actor: { kind: 'anonymous' } as ResolvedActor }))
const lookupStudent = vi.hoisted(() => vi.fn())
vi.mock('next/cache', () => ({ refresh: vi.fn() }))
vi.mock('@/app/_ui/guard', () => ({ currentActor: async () => state.actor }))
vi.mock('@/composition/groups', () => ({
  describeConfirmReceipt: () => '',
  describeLinkReceipt: () => '',
  describeTerminateReceipt: () => '',
  getGroupCommand: () => ({}),
  getOpportunityCommand: () => ({}),
  getGroupQuery: () => ({ lookupStudent }),
  studentCohortOf: (actor: ResolvedActor) => (actor.kind === 'authenticated' ? 'cohort-1' : null),
}))

import { lookupStudentAction } from '@/app/dashboard/student/groups/actions'

function student(userId: string): ResolvedActor {
  return { kind: 'authenticated', userId, roles: ['student'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

beforeEach(() => {
  vi.clearAllMocks()
  lookupStudent.mockResolvedValue(null)
})

describe('lookupStudentAction 節流', () => {
  it('同一人一分鐘內第 31 次起被擋、不進查詢；別人不受影響；過了一分鐘恢復', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-21T08:00:00Z'))
      state.actor = student('u-throttle-1')
      for (let i = 0; i < 30; i += 1) {
        expect(await lookupStudentAction('414000001')).toMatchObject({ found: false, message: '找不到這個學號，或他已經有組別' })
      }
      expect(lookupStudent).toHaveBeenCalledTimes(30)

      expect(await lookupStudentAction('414000001')).toEqual({ found: false, message: '查得太頻繁，請稍後再試。' })
      expect(lookupStudent).toHaveBeenCalledTimes(30)

      state.actor = student('u-throttle-2')
      expect(await lookupStudentAction('414000001')).toMatchObject({ message: '找不到這個學號，或他已經有組別' })
      expect(lookupStudent).toHaveBeenCalledTimes(31)

      vi.setSystemTime(new Date('2026-10-21T08:01:01Z'))
      state.actor = student('u-throttle-1')
      expect(await lookupStudentAction('414000001')).toMatchObject({ message: '找不到這個學號，或他已經有組別' })
      expect(lookupStudent).toHaveBeenCalledTimes(32)
    } finally {
      vi.useRealTimers()
    }
  })
})
