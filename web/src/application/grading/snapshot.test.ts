import { describe, expect, it } from 'vitest'
import { computeGroupResult, type CountedEvaluation } from '@/application/grading/gradebook'
import type { AdminGradingBoard, Gradebook, GradebookGroup } from '@/application/grading/ports'
import type { SchemeStage } from '@/application/grading/scheme'
import { deriveStageRows } from '@/application/grading/snapshot'

/**
 * A-05（設計方案 §4.2）：系辦成績管理頁的階段完成率，從屆別評分快照推導（原本在頁面裡算）。
 */

const mid: SchemeStage = {
  key: 'mid',
  name: '期中',
  weight: 60,
  letterMap: null,
  items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }],
}
const fin: SchemeStage = { ...mid, key: 'fin', name: '期末', weight: 40 }

let seq = 0
function counted(stageKey: string, teacher: string): CountedEvaluation {
  seq += 1
  return {
    evaluationId: `e${seq}`,
    assignmentId: `a${seq}`,
    stageKey,
    teacherUserId: teacher,
    teacherName: teacher,
    scores: { i1: '80' },
    submittedAt: new Date(Date.UTC(2026, 11, 1, 0, seq)),
    assignmentEnded: false,
  }
}

function group(
  code: string,
  stages: readonly SchemeStage[],
  requirements: Record<string, number>,
  evaluations: readonly CountedEvaluation[],
  dissolved = false,
): GradebookGroup {
  return {
    id: `g-${code}`,
    code,
    advisorName: null,
    dissolved,
    versionNo: 1,
    members: [],
    result: computeGroupResult(stages, new Map(Object.entries(requirements)), evaluations),
    override: null,
    basisHash: '',
    missing: [],
  }
}

function snapshot(groups: readonly GradebookGroup[], stages: readonly SchemeStage[] = [mid, fin]) {
  const board = {
    current: { id: 'v1', versionNo: 1, status: 'locked', stages, isCurrent: true, createdAt: new Date(), lockedAt: new Date() },
  } as unknown as AdminGradingBoard
  const gradebook = { groups } as unknown as Gradebook
  return { board, gradebook }
}

describe('deriveStageRows：各階段完成率', () => {
  const book = [
    // 期中要 2 份、送了 3 份（改派「新增」後多一份）：完成數以要求份數為上限。
    group('A01', [mid, fin], { mid: 2, fin: 1 }, [counted('mid', 'T1'), counted('mid', 'T2'), counted('mid', 'T3')]),
    // 期末沒設要求份數：這一組的期末不算進分母。
    group('A02', [mid, fin], { mid: 2 }, [counted('mid', 'T1'), counted('fin', 'T1')]),
    // 解散的組評分已停止，不算。
    group('A03', [mid, fin], { mid: 2, fin: 2 }, [counted('mid', 'T1')], true),
    // 用舊版本算、沒有期末這個階段的組：期末跳過。
    group('A04', [mid], { mid: 1 }, []),
  ]

  it('全部階段（null）：每個階段一列，順序照目前版本', () => {
    expect(deriveStageRows(snapshot(book), null)).toEqual([
      { key: 'mid', name: '期中', done: 3, total: 5 },
      { key: 'fin', name: '期末', done: 0, total: 1 },
    ])
  })

  it('選了某階段：只回那一列', () => {
    expect(deriveStageRows(snapshot(book), 'fin')).toEqual([{ key: 'fin', name: '期末', done: 0, total: 1 }])
  })

  it('不存在的階段代號當成全部階段（跟頁面的階段膠囊一樣）', () => {
    expect(deriveStageRows(snapshot(book), 'nope').map((r) => r.key)).toEqual(['mid', 'fin'])
  })

  it('還沒有發布的評分規則：沒有任何列', () => {
    expect(deriveStageRows({ board: { current: null } as unknown as AdminGradingBoard, gradebook: { groups: book } as unknown as Gradebook }, null)).toEqual([])
  })
})
