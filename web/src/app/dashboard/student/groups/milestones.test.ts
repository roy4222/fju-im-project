import { describe, expect, it, vi } from 'vitest'
import type { MyItemRow } from '@/application/submissions'

// `todos.ts` 的讀取端不在這裡用；擋掉 composition，單元測試不碰資料庫（同 `todos.test.ts`）。
vi.mock('@/app/_ui/guard', () => ({ shellViewer: async () => ({ kind: 'anonymous' }) }))
vi.mock('@/composition/submissions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSubmissionQuery: () => ({ myItems: vi.fn() }),
}))
vi.mock('@/composition/signoff', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSignoffQuery: () => ({ studentView: vi.fn() }),
}))
vi.mock('@/composition/cohorts', () => ({ getBusinessClock: () => ({ now: async () => NOW }) }))

import { groupMilestones } from '@/app/dashboard/student/groups/milestones'

// 固定業務鐘：臺灣 2026-10-17 10:00。
const NOW = new Date('2026-10-17T10:00:00+08:00')

function item(over: Partial<MyItemRow> & { itemId: string }): MyItemRow {
  return {
    title: over.itemId,
    stageName: null,
    cohortId: 'c1',
    stageSeq: null,
    opensAt: null,
    dueAt: new Date('2026-11-30T23:59:00+08:00'),
    attachmentCount: 0,
    exempt: false,
    hasDraft: false,
    latestVersionNo: null,
    latestReceivedAt: null,
    receiverUnit: 'group',
    groupCode: 'G07',
    reopenUntil: null,
    ...over,
  }
}

const proposedAt = new Date('2026-09-12T09:00:00+08:00')
const establishedAt = new Date('2026-09-20T15:30:00+08:00')

describe('groupMilestones（Q120）', () => {
  it('發起提案、成組，再接整組一份的作業依截止日排：已送出打勾寫日期，還沒送出上鎖寫月份', () => {
    const rows = [
      item({ itemId: '期末報告', dueAt: new Date('2027-01-10T23:59:00+08:00') }),
      item({
        itemId: '提案書',
        dueAt: new Date('2026-10-05T23:59:00+08:00'),
        latestVersionNo: 1,
        latestReceivedAt: new Date('2026-10-03T21:00:00+08:00'),
      }),
    ]
    expect(groupMilestones({ proposedAt, establishedAt, rows, now: NOW })).toEqual([
      { key: 'proposed', label: '發起提案', done: true, when: '9/12' },
      { key: 'established', label: '成組', done: true, when: '9/20' },
      { key: '提案書', label: '提案書', done: true, when: '10/3' },
      { key: '期末報告', label: '期末報告', done: false, when: '1 月' },
    ])
  })

  it('個人一份與免繳的作業不列；沒有截止日的排最後、寫「未定」', () => {
    const rows = [
      item({ itemId: '個人心得', receiverUnit: 'individual' }),
      item({ itemId: '免繳的', exempt: true }),
      item({ itemId: '沒日期', dueAt: null }),
      item({ itemId: '期中', dueAt: new Date('2026-12-01T23:59:00+08:00') }),
    ]
    expect(groupMilestones({ proposedAt, establishedAt, rows, now: NOW }).map((m) => [m.label, m.done, m.when])).toEqual([
      ['發起提案', true, '9/12'],
      ['成組', true, '9/20'],
      ['期中', false, '12 月'],
      ['沒日期', false, '未定'],
    ])
  })

  it('逾期沒交仍是上鎖（沒送出）；臺灣跨日用臺灣日期', () => {
    const rows = [item({ itemId: '逾期', dueAt: new Date('2026-09-30T23:59:00+08:00') })]
    const lines = groupMilestones({ proposedAt: null, establishedAt: new Date('2026-09-19T16:30:00Z'), rows, now: NOW })
    expect(lines).toEqual([
      { key: 'established', label: '成組', done: true, when: '9/20' },
      { key: '逾期', label: '逾期', done: false, when: '9 月' },
    ])
  })

  it('沒有成組提案（系辦建的組、後來才被加進組）時不列「發起提案」', () => {
    expect(groupMilestones({ proposedAt: null, establishedAt, rows: [], now: NOW }).map((m) => m.label)).toEqual(['成組'])
  })
})
