import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedActor } from '@/application/accounts'

// SEC-2：甘特拖拉的兩個動作要先過系辦＋business 狀態守門，才去讀目前存的階段（`schedule()`）。
// 擋掉 composition，單元測試不碰資料庫；只看 action 有沒有在守門前讀資料、有沒有進用例。
const state = vi.hoisted(() => ({ actor: { kind: 'anonymous' } as ResolvedActor }))
const schedule = vi.hoisted(() => vi.fn())
const previewSchedule = vi.hoisted(() => vi.fn())
const saveSchedule = vi.hoisted(() => vi.fn())
vi.mock('next/cache', () => ({ refresh: vi.fn() }))
vi.mock('@/app/_ui/guard', () => ({ currentActor: async () => state.actor }))
vi.mock('@/composition/cohorts', () => ({
  STAGE_COUNT: 4,
  cohortLabel: () => '',
  getTimelineQuery: () => ({ schedule }),
  getSchedulePreview: () => ({ previewSchedule }),
  getTimelineCommand: () => ({ saveSchedule }),
}))

import { previewScheduleAction, saveStageDatesAction } from '@/app/dashboard/admin/timeline/actions'

const COHORT = '00000000-0000-4000-8000-000000000001'
const INPUT = { stages: [{ seq: 1, startDate: '2026-09-01' }], yearEndDate: '2027-06-30', revision: 3 }
function actor(over: Partial<Extract<ResolvedActor, { kind: 'authenticated' }>>): ResolvedActor {
  return { kind: 'authenticated', userId: 'u1', roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [], ...over }
}

const denied: [string, ResolvedActor][] = [
  ['未登入', { kind: 'anonymous' }],
  ['非系辦（老師）', actor({ roles: ['teacher'] })],
  ['必須改密的系辦', actor({ mustChangePassword: true })],
  ['待審的系辦', actor({ status: 'pending' })],
  ['停用的系辦', actor({ status: 'disabled' })],
]

beforeEach(() => {
  vi.clearAllMocks()
  schedule.mockResolvedValue({ stages: [], yearEndDate: null, revision: 3 })
  previewSchedule.mockResolvedValue({ ok: true, preview: { message: '好', groupItemCount: 0, changedStages: [] } })
  saveSchedule.mockResolvedValue({ ok: true, receipt: {} })
})

describe.each([
  ['previewScheduleAction', previewScheduleAction, previewSchedule],
  ['saveStageDatesAction', saveStageDatesAction, saveSchedule],
] as const)('%s 守門', (_name, action, useCase) => {
  it.each(denied)('%s：直接拒絕，不讀 schedule、不進用例', async (_who, who) => {
    state.actor = who
    const result = await action(COHORT, INPUT)
    expect(result.ok).toBe(false)
    expect(schedule).not.toHaveBeenCalled()
    expect(useCase).not.toHaveBeenCalled()
  })

  it('有效系辦：照常讀 schedule 再交給用例', async () => {
    state.actor = actor({})
    const result = await action(COHORT, INPUT)
    expect(result.ok).toBe(true)
    expect(schedule).toHaveBeenCalledWith(COHORT)
    expect(useCase).toHaveBeenCalledTimes(1)
  })
})
