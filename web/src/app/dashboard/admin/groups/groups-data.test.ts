import { describe, expect, it, vi } from 'vitest'
import type { ResolvedActor } from '@/application/accounts'
import type { AdminAssignmentView, AdminGradingBoard, EvaluationState } from '@/application/grading'
import type { AdvisorGradingLookup, GradingAssignmentSummary } from '@/application/groups'
import { loadAdvisorGrading, type GroupsGradingPorts } from './groups-data'

// 系辦分組頁的評分指派讀取（AD-14）：AC-AD-13 的 port 計數（接線），以及分組後的結果和逐組 `assignmentsFor()` 相同。
// 測資只填這裡用得到的欄位，其餘用型別斷言帶過。

const NOW = new Date('2026-10-17T10:00:00+08:00')
const actor = { kind: 'authenticated', userId: 'u-admin', roles: ['admin'], status: 'active' } as unknown as ResolvedActor

function ok<R>(receipt: R) {
  return { ok: true as const, receipt: { ...receipt, requestId: 'r', serverTime: NOW.toISOString() } }
}

/** 一筆指派（資料庫裡的一列）：照 `created_at, id` 的順序排好。 */
type Row = { id: string; groupId: string; teacherUserId: string; stageKey: string; state: EvaluationState }

const STAGES = [
  { key: 'mid', name: '期中' },
  { key: 'final', name: '期末' },
]

/**
 * 組數 n 的一屆：每組一位指導老師（第一組沒有）。指導老師在本組有期中、期末兩份；
 * 另一位老師（t-other）在每組也有一份（不是指導老師的指派，不該列出）；
 * 第二組多一份方案已經沒有的階段（顯示 stage key）。狀態輪流 empty／draft／counted。
 */
function cohort(n: number) {
  const states: EvaluationState[] = ['empty', 'draft', 'counted']
  const groups = Array.from({ length: n }, (_, i) => ({ id: `g${i}`, advisor: i === 0 ? null : { teacherUserId: `t${i % 4}` } }))
  const rows: Row[] = []
  groups.forEach((g, i) => {
    const t = g.advisor?.teacherUserId ?? 't-none'
    rows.push({ id: `a${i}-final`, groupId: g.id, teacherUserId: t, stageKey: 'final', state: states[i % 3]! })
    rows.push({ id: `a${i}-other`, groupId: g.id, teacherUserId: 't-other', stageKey: 'mid', state: 'counted' })
    rows.push({ id: `a${i}-mid`, groupId: g.id, teacherUserId: t, stageKey: 'mid', state: states[(i + 1) % 3]! })
    if (i === 1) rows.push({ id: `a${i}-gone`, groupId: g.id, teacherUserId: t, stageKey: 'retired', state: 'draft' })
  })
  return { groups, rows }
}

function board(rows: readonly Row[]): AdminGradingBoard {
  return {
    current: { stages: STAGES },
    assignments: rows.map((r) => ({ ...r, teacherName: r.teacherUserId }) as unknown as AdminAssignmentView),
  } as unknown as AdminGradingBoard
}

/** 舊做法的參考實作：照 `listForGroup` 的 SQL（同組、同老師、照原順序；counted 顯示成 submitted；階段名照目前方案）。 */
function legacyLookup(rows: readonly Row[]): AdvisorGradingLookup {
  return {
    async assignmentsFor(groupId, teacherUserId): Promise<readonly GradingAssignmentSummary[]> {
      return rows
        .filter((r) => r.groupId === groupId && r.teacherUserId === teacherUserId)
        .map((r) => ({
          id: r.id,
          stageName: STAGES.find((s) => s.key === r.stageKey)?.name ?? r.stageKey,
          state: r.state === 'counted' ? 'submitted' : r.state,
        }))
    },
  }
}

/** 計數假物件：同一個物件同時有 `adminBoard` 與 `assignmentsFor`，證明頁面只走前者。 */
function counting(rows: readonly Row[]) {
  const legacy = legacyLookup(rows)
  const fake = {
    adminBoard: vi.fn(async () => ok(board(rows))),
    assignmentsFor: vi.fn(legacy.assignmentsFor),
  }
  const ports: GroupsGradingPorts = { grading: fake }
  return { fake, ports, legacy }
}

describe('loadAdvisorGrading（AC-AD-13）', () => {
  it.each([3, 12])('%i 組：adminBoard 1 次、assignmentsFor 0 次，結果與逐組讀相同', async (n) => {
    const { groups, rows } = cohort(n)
    const { fake, ports, legacy } = counting(rows)

    const got = await loadAdvisorGrading(ports, actor, 'c43', groups)

    expect(fake.adminBoard).toHaveBeenCalledTimes(1)
    expect(fake.adminBoard).toHaveBeenCalledWith(actor, 'c43')
    expect(fake.assignmentsFor).toHaveBeenCalledTimes(0)

    const expected = new Map(
      await Promise.all(
        groups
          .filter((g) => g.advisor)
          .map(async (g) => [g.id, [...(await legacy.assignmentsFor(g.id, g.advisor!.teacherUserId))]] as const),
      ),
    )
    expect(got).toEqual(expected)
  })

  it('只列指導老師自己的指派，順序照讀到的順序；方案沒有的階段顯示 key', async () => {
    const { groups, rows } = cohort(3)
    const got = await loadAdvisorGrading(counting(rows).ports, actor, 'c43', groups)
    expect(got.has('g0')).toBe(false)
    expect(got.get('g1')).toEqual([
      { id: 'a1-final', stageName: '期末', state: 'draft' },
      { id: 'a1-mid', stageName: '期中', state: 'submitted' },
      { id: 'a1-gone', stageName: 'retired', state: 'draft' },
    ])
    expect(got.get('g2')).toEqual([
      { id: 'a2-final', stageName: '期末', state: 'submitted' },
      { id: 'a2-mid', stageName: '期中', state: 'empty' },
    ])
  })

  it('有指導老師但沒有指派的組是空陣列（和逐組讀一樣）', async () => {
    const groups = [{ id: 'g1', advisor: { teacherUserId: 't1' } }]
    const got = await loadAdvisorGrading(counting([]).ports, actor, 'c43', groups)
    expect(got.get('g1')).toEqual([])
  })

  it('還沒有評分方案：階段名顯示 key', async () => {
    const rows: Row[] = [{ id: 'a', groupId: 'g1', teacherUserId: 't1', stageKey: 'mid', state: 'empty' }]
    const grading = { adminBoard: vi.fn(async () => ok({ ...board(rows), current: null })) }
    const got = await loadAdvisorGrading({ grading }, actor, 'c43', [{ id: 'g1', advisor: { teacherUserId: 't1' } }])
    expect(got.get('g1')).toEqual([{ id: 'a', stageName: 'mid', state: 'empty' }])
  })

  it('沒有一組有指導老師：不讀評分', async () => {
    const { fake, ports } = counting([])
    const got = await loadAdvisorGrading(ports, actor, 'c43', [{ id: 'g0', advisor: null }])
    expect(fake.adminBoard).not.toHaveBeenCalled()
    expect(got.size).toBe(0)
  })

  it('評分讀取失敗就丟錯（不把指派當成沒有）', async () => {
    const grading = { adminBoard: vi.fn(async () => ({ ok: false as const, code: 'FORBIDDEN' as const, message: '不行' })) }
    await expect(
      loadAdvisorGrading({ grading }, actor, 'c43', [{ id: 'g1', advisor: { teacherUserId: 't1' } }]),
    ).rejects.toThrow()
  })
})
