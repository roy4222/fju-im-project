import { describe, expect, it } from 'vitest'
import { cellOf } from '@/app/dashboard/teacher/affairs/group-cards'
import type { AdvisorMatrixCell, AdvisorMatrixItem } from '@/application/submissions'

/** 截止 2026-10-15 17:00（臺灣）＝分鐘起點 09:00Z；截止分鐘含這一分鐘（母 spec §4.11）。 */
const DUE = new Date('2026-10-15T09:00:00.000Z')
const NOW = new Date('2026-10-16T04:00:00.000Z')

const item: AdvisorMatrixItem = { itemId: 'i1', title: '期中報告', cohortId: 'c1', stageName: null, opensAt: null, dueAt: DUE }

function submittedAt(receivedAt: Date): AdvisorMatrixCell {
  return {
    groupId: 'g1',
    itemId: 'i1',
    eligibleTo: null,
    exempt: false,
    latestVersionNo: 1,
    latestReceivedAt: receivedAt,
    latestSubmittedByName: '組長',
    reopenUntil: null,
  }
}

describe('cellOf：已交的格子是否「逾期補交」跟截止判定同一個規則（isDeadlinePassed）', () => {
  it('截止分鐘內送出（17:00:30）仍是準時：綠色「已繳第 1 次」', () => {
    const cell = cellOf(item, '期中', 'g1', submittedAt(new Date('2026-10-15T09:00:30.000Z')), NOW)
    expect(cell.kind).toBe('submitted')
    expect(cell.status).toBe('已繳第 1 次')
  })

  it('截止分鐘最後一刻（17:00:59.999）仍是準時', () => {
    expect(cellOf(item, '期中', 'g1', submittedAt(new Date('2026-10-15T09:00:59.999Z')), NOW).kind).toBe('submitted')
  })

  it('下一分鐘（17:01:00）送出才是琥珀色「逾期補交」', () => {
    const cell = cellOf(item, '期中', 'g1', submittedAt(new Date('2026-10-15T09:01:00.000Z')), NOW)
    expect(cell.kind).toBe('late')
    expect(cell.status).toBe('逾期補交（已繳第 1 次）')
  })
})
