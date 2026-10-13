import { describe, expect, it } from 'vitest'
import { homePendingLine } from '@/app/dashboard/student/home-pending'
import { pendingCount, receiverStatus } from '@/composition/submissions'

const window = { opensAt: null, dueAt: new Date('2026-10-12T08:57:00Z') } // 臺灣 10/12 16:57 截止
const afterDue = new Date('2026-10-12T09:00:00Z')
const unsent = { exempt: false, hasDraft: false, latestVersionNo: null }

describe('學生首頁的待繳（驗收第 2 章 P-08）', () => {
  it('有一筆逾期未繳：待繳不是 0，句子不說「沒有待繳」、講出逾期幾件', () => {
    const rows = [{ ...window, ...unsent }]
    const pending = pendingCount(rows, afterDue)
    const overdue = rows.filter((r) => receiverStatus(r, r, afterDue).overdue).length
    expect(pending).toBe(1)
    const line = homePendingLine(pending, overdue)
    expect(line).not.toContain('沒有待繳')
    expect(line).toBe('「我的繳交」還有 1 件沒送出，其中 1 件已逾期（要補交請聯絡系辦）。')
  })

  it('都交了才說沒有待繳；沒有逾期時照舊只講件數', () => {
    expect(homePendingLine(0, 0)).toBe('「我的繳交」沒有待繳的東西。')
    expect(homePendingLine(2, 0)).toBe('「我的繳交」還有 2 件沒送出。')
  })
})
