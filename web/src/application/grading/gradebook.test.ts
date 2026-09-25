import { describe, expect, it } from 'vitest'
import {
  adoptedFinal,
  applyRemovalChoice,
  computeGroupResult,
  computeStage,
  describeFinalFormula,
  describeOverride,
  describeStageFormula,
  describeStageStatus,
  type CountedEvaluation,
} from '@/application/grading/gradebook'
import type { SchemeStage } from '@/application/grading/scheme'

/**
 * 票 24：成績表的算術與完成判定（產品模組 06 §4「7.3」「7.4」；案例 GRD-05、GRD-06、GRD-13、GRD-14）。
 */

const midterm: SchemeStage = {
  key: 'mid',
  name: '期中',
  weight: 60,
  letterMap: null,
  items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }],
}
const final: SchemeStage = {
  key: 'fin',
  name: '期末',
  weight: 40,
  letterMap: null,
  items: [
    { key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 },
    { key: 'gate', name: '展示可運作', type: 'passfail', max: null, weight: 0 },
  ],
}

let seq = 0
function counted(stageKey: string, teacher: string, scores: Record<string, string>, extra: Partial<CountedEvaluation> = {}): CountedEvaluation {
  seq += 1
  return {
    evaluationId: `e${seq}`,
    assignmentId: `a-${teacher}-${stageKey}`,
    stageKey,
    teacherUserId: teacher,
    teacherName: `${teacher} 老師`,
    scores,
    submittedAt: new Date(Date.UTC(2026, 11, 1, 0, seq)),
    assignmentEnded: false,
    ...extra,
  }
}

describe('多老師平均（GRD-05）', () => {
  it('T1＝80、T3＝84.29：平均完整精度 82.145，顯示 82.15（不是先四捨五入各份）', () => {
    const stage = computeStage(midterm, 2, [counted('mid', 'T1', { i1: '80' }), counted('mid', 'T3', { i1: '84.29' })])
    expect(stage.averageExact).toBe('82.145')
    expect(stage.averageDisplay).toBe('82.15')
    expect(stage.complete).toBe(true)
    expect(describeStageFormula(stage)).toBe('(80 ＋ 84.29) ÷ 2 ＝ 82.145 → 82.15')
  })

  it('只送出一份、要求兩份：部分平均照算，但標「尚未完成（1／2）」；沒送的不當零分', () => {
    const stage = computeStage(midterm, 2, [counted('mid', 'T1', { i1: '80' })])
    expect(stage.averageDisplay).toBe('80.00')
    expect(stage.complete).toBe(false)
    expect(describeStageStatus(stage)).toBe('尚未完成（1／2）')
  })

  it('沒設定份數或設 0：不算完成（不能顯示 100%）', () => {
    expect(computeStage(midterm, null, [counted('mid', 'T1', { i1: '80' })]).status).toBe('no_requirement')
    expect(computeStage(midterm, 0, [counted('mid', 'T1', { i1: '80' })]).complete).toBe(false)
    expect(describeStageStatus(computeStage(midterm, null, []))).toBe('尚未設定份數')
  })

  it('別的階段的評分不混進來；通過／不通過另外顯示、不進數字', () => {
    const stage = computeStage(final, 2, [
      counted('fin', 'T1', { i1: '90', gate: 'pass' }),
      counted('fin', 'T3', { i1: '90', gate: 'fail' }),
      counted('mid', 'T1', { i1: '10' }),
    ])
    expect(stage.counted).toHaveLength(2)
    expect(stage.averageExact).toBe('90')
    expect(stage.gate).toBe('fail')
  })
})

describe('最終加權與捨入（GRD-06）', () => {
  const requirements = new Map([
    ['mid', 2],
    ['fin', 1],
  ])
  it('期中 82.145 × 60% ＋ 期末 90 × 40% ＝ 85.287 → 85.29', () => {
    const result = computeGroupResult([midterm, final], requirements, [
      counted('mid', 'T1', { i1: '80' }),
      counted('mid', 'T3', { i1: '84.29' }),
      counted('fin', 'T2', { i1: '90', gate: 'pass' }),
    ])
    expect(result.complete).toBe(true)
    expect(result.finalExact).toBe('85.287')
    expect(result.finalDisplay).toBe('85.29')
    expect(describeFinalFormula(result)).toBe('82.145 × 60% ＋ 90 × 40% ＝ 85.287 → 85.29')
  })

  it('三位老師平均除不盡：原始精度顯示到小數四位（83.0967），最終仍從完整精度算', () => {
    const result = computeGroupResult([midterm, final], requirements, [
      counted('mid', 'T1', { i1: '80' }),
      counted('mid', 'T2', { i1: '84.29' }),
      counted('mid', 'T3', { i1: '85' }),
      counted('fin', 'T4', { i1: '90' }),
    ])
    // 期中要兩份、給了三份：完成。(80 + 84.29 + 85) / 3 = 83.09666…
    expect(result.stages[0]).toMatchObject({ averageExact: '83.0967', averageDisplay: '83.10' })
    // 最終 = 83.09666… × 0.6 + 36 = 85.858 整（完整精度算）；若用 83.0967 算會是 85.85802。
    expect(result.finalExact).toBe('85.858')
    expect(describeStageFormula(result.stages[0]!)).toBe('(80 ＋ 84.29 ＋ 85) ÷ 3 ≈ 83.0967 → 83.10')
    expect(describeFinalFormula(result)).toBe('83.0967 × 60% ＋ 90 × 40% ≈ 85.858 → 85.86')
  })

  it('任一階段沒完成：最終是 null（尚未完成），不拿部分平均湊', () => {
    const result = computeGroupResult([midterm, final], requirements, [counted('mid', 'T1', { i1: '80' }), counted('fin', 'T2', { i1: '90' })])
    expect(result.complete).toBe(false)
    expect(result.finalExact).toBeNull()
    expect(describeFinalFormula(result)).toBeNull()
  })

  it('用目前版本的權重重算舊分數（方案套用新版本後）', () => {
    const reweighted: SchemeStage = { ...midterm, items: [{ ...midterm.items[0]!, max: 80 }] }
    const stage = computeStage(reweighted, 1, [counted('mid', 'T1', { i1: '60' })])
    expect(stage.averageExact).toBe('75')
  })
})

describe('改派三選一（GRD-13）：T1＝80、T3＝90，要求兩份，平均 85', () => {
  const t1 = counted('mid', 'T1', { i1: '80' })
  const t3 = counted('mid', 'T3', { i1: '90' })
  const base = { stageKey: 'mid', assignmentId: t1.assignmentId, requirements: new Map([['mid', 2]]), counted: [t1, t3] }
  const after = (choice: 'keep' | 'replace' | 'add') => {
    const next = applyRemovalChoice(choice, base)
    return computeStage(midterm, next.requirements.get('mid') ?? null, next.counted)
  }

  it('改派前：2／2、平均 85', () => {
    const stage = computeStage(midterm, 2, [t1, t3])
    expect([stage.counted.length, stage.required, stage.averageDisplay, stage.complete]).toEqual([2, 2, '85.00', true])
  })

  it('（a）保留：仍兩票、平均 85、完成 2／2；舊分掛在已結束的指派上', () => {
    const stage = after('keep')
    expect([stage.counted.length, stage.required, stage.averageDisplay, stage.complete]).toEqual([2, 2, '85.00', true])
    expect(stage.counted.find((c) => c.teacherUserId === 'T1')?.assignmentEnded).toBe(true)
  })

  it('（b）替換：舊 80 退出採計，完成 1／2、平均標尚未完成', () => {
    const stage = after('replace')
    expect([stage.counted.length, stage.required, stage.averageDisplay, stage.complete]).toEqual([1, 2, '90.00', false])
    expect(describeStageStatus(stage)).toBe('尚未完成（1／2）')
  })

  it('（c）新增：舊 80 繼續採計，要求份數變 3，完成 2／3', () => {
    const stage = after('add')
    expect([stage.counted.length, stage.required, stage.averageDisplay, stage.complete]).toEqual([2, 3, '85.00', false])
  })

  it('原本的事實不被改掉（預覽三種選擇用同一份輸入）', () => {
    after('replace')
    after('add')
    expect(base.counted).toHaveLength(2)
    expect(base.requirements.get('mid')).toBe(2)
  })
})

describe('採用的最終成績與更正註記（GRD-08、GRD-15）', () => {
  const override = { id: 'o1', originalValue: '85.287', newValue: '88', reason: '口試補考', state: 'effective' as const }

  it('生效中的更正：採用更正值，原值另外列', () => {
    expect(adoptedFinal({ finalDisplay: '85.29' }, override)).toEqual({ value: '88.00', source: 'override', pendingReview: false })
    expect(describeOverride(override)).toBe('已更正：原 85.29 → 88.00（口試補考）')
  })

  it('待復核：不套用更正，照算出來的值並標註', () => {
    const pending = { ...override, state: 'pending_review' as const }
    expect(adoptedFinal({ finalDisplay: '86.10' }, pending)).toEqual({ value: '86.10', source: 'computed', pendingReview: true })
    expect(adoptedFinal({ finalDisplay: null }, pending).value).toBeNull()
    expect(describeOverride(pending)).toContain('更正待復核')
  })

  it('沒有更正或已被取代：照算出來的值、沒有註記', () => {
    expect(adoptedFinal({ finalDisplay: '85.29' }, null)).toEqual({ value: '85.29', source: 'computed', pendingReview: false })
    expect(describeOverride({ ...override, state: 'superseded' })).toBe('')
  })
})
