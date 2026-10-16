import { describe, expect, it } from 'vitest'
import type { AdminAssignmentView, AdminGradingBoard, SchemeVersionView } from '@/application/grading'
import { remainingCount, teacherProgress } from './progress'

// AC-AD-03：本屆 12 組、G12 已解散；評分規則兩階段（期中、期末）已發布；
// 王老師指派 5 組×2 階段＝10 份、已送出 3 份；另在已解散的 G12 有兩份（一份已送出），不得算進任何數字。
// 李老師 2 份全送出；停用的張老師 1 份未開始。

const STAGES: SchemeVersionView['stages'] = [
  { key: 'mid', name: '期中', weight: 40, letterMap: null, items: [] },
  { key: 'final', name: '期末', weight: 60, letterMap: null, items: [] },
]

const current: SchemeVersionView = {
  id: 'v1',
  versionNo: 1,
  status: 'published',
  stages: STAGES,
  isCurrent: true,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  lockedAt: null,
}

let seq = 0
function a(groupId: string, stageKey: string, teacher: [string, string], state: AdminAssignmentView['state'], inactive = false): AdminAssignmentView {
  seq += 1
  return {
    id: `a${seq}`,
    groupId,
    stageKey,
    teacherUserId: teacher[0],
    teacherName: teacher[1],
    teacherInactive: inactive,
    state,
    score: null,
    filled: 0,
    total: 0,
    updatedAt: null,
  }
}

const WANG: [string, string] = ['t-wang', '王老師']
const LI: [string, string] = ['t-li', '李老師']
const ZHANG: [string, string] = ['t-zhang', '張老師']

// adminBoard 的 `groups` 只有進行中的組：G12 解散了，所以不在裡面（`pg-grading.ts` adminBoard）。
const activeGroups = Array.from({ length: 11 }, (_, i) => {
  const code = `G${String(i + 1).padStart(2, '0')}`
  return { id: code, code, advisorName: null }
})

const board: AdminGradingBoard = {
  cohort: { id: 'c43', code: '43', name: '第 43 屆', archived: false },
  schemeId: 's1',
  versions: [current],
  current,
  groups: activeGroups,
  requirements: [],
  assignments: [
    a('G01', 'mid', WANG, 'counted'),
    a('G01', 'final', WANG, 'counted'),
    a('G02', 'mid', WANG, 'counted'),
    a('G02', 'final', WANG, 'draft'),
    a('G03', 'mid', WANG, 'empty'),
    a('G03', 'final', WANG, 'empty'),
    a('G04', 'mid', WANG, 'draft'),
    a('G04', 'final', WANG, 'empty'),
    a('G05', 'mid', WANG, 'empty'),
    a('G05', 'final', WANG, 'empty'),
    a('G12', 'mid', WANG, 'counted'),
    a('G12', 'final', WANG, 'empty'),
    a('G06', 'mid', LI, 'counted'),
    a('G06', 'final', LI, 'counted'),
    a('G07', 'mid', ZHANG, 'empty', true),
  ],
  teachers: [],
}

describe('teacherProgress（AC-AD-03）', () => {
  it('不傳階段＝全部階段（Q115）；已解散的 G12 不算進分母也不算進分子', () => {
    const rows = teacherProgress(board, { excludeDissolved: true })
    const wang = rows.find((r) => r.userId === 't-wang')
    expect(wang).toEqual({ userId: 't-wang', name: '王老師', inactive: false, assigned: 10, counted: 3 })
    expect(rows.find((r) => r.userId === 't-li')).toMatchObject({ assigned: 2, counted: 2 })
  })

  it('停用的老師照樣列出（不自動改派）', () => {
    const zhang = teacherProgress(board, { excludeDissolved: true }).find((r) => r.userId === 't-zhang')
    expect(zhang).toEqual({ userId: 't-zhang', name: '張老師', inactive: true, assigned: 1, counted: 0 })
  })

  it('依姓名排序，同一份 board 每次結果一樣', () => {
    const names = teacherProgress(board, { excludeDissolved: true }).map((r) => r.name)
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y, 'zh-Hant')))
    expect(teacherProgress(board, { excludeDissolved: true })).toEqual(teacherProgress(board, { excludeDissolved: true }))
  })

  it('傳 stageKey 只算那一階段（仍排除解散組）', () => {
    const mid = teacherProgress(board, { stageKey: 'mid', excludeDissolved: true })
    expect(mid.find((r) => r.userId === 't-wang')).toMatchObject({ assigned: 5, counted: 2 })
    const final = teacherProgress(board, { stageKey: 'final', excludeDissolved: true })
    expect(final.find((r) => r.userId === 't-wang')).toMatchObject({ assigned: 5, counted: 1 })
    // 那階段沒有指派的老師不出現。
    expect(final.find((r) => r.userId === 't-zhang')).toBeUndefined()
  })

  it('各階段加起來等於全部階段', () => {
    const all = teacherProgress(board, { excludeDissolved: true })
    const byStage = ['mid', 'final'].flatMap((stageKey) => teacherProgress(board, { stageKey, excludeDissolved: true }))
    for (const t of all) {
      const parts = byStage.filter((r) => r.userId === t.userId)
      expect(parts.reduce((n, r) => n + r.assigned, 0)).toBe(t.assigned)
      expect(parts.reduce((n, r) => n + r.counted, 0)).toBe(t.counted)
    }
  })

  it('只算已發布評分規則的階段：目前版本沒有的階段不算', () => {
    const orphan = { ...board, assignments: [...board.assignments, a('G08', 'retired', WANG, 'empty')] }
    expect(teacherProgress(orphan, { excludeDissolved: true }).find((r) => r.userId === 't-wang')).toMatchObject({ assigned: 10, counted: 3 })
  })

  it('還沒有已發布的評分規則：沒有任何進度', () => {
    expect(teacherProgress({ ...board, current: null }, { excludeDissolved: true })).toEqual([])
    expect(remainingCount({ ...board, current: null })).toBe(0)
  })
})

describe('remainingCount（首頁「評分還差 N 份」）', () => {
  it('＝ Σ（分母 − 分子），全部階段、排除解散組', () => {
    // 王 10−3、李 2−2、張 1−0
    expect(remainingCount(board)).toBe(8)
  })

  it('首頁與成績頁用同一份 board 得同一個數字', () => {
    const fromGradingPage = teacherProgress(board, { excludeDissolved: true }).reduce((n, t) => n + (t.assigned - t.counted), 0)
    expect(remainingCount(board)).toBe(fromGradingPage)
  })

  it('全部送出時為 0', () => {
    const done = { ...board, assignments: board.assignments.map((x) => ({ ...x, state: 'counted' as const })) }
    expect(remainingCount(done)).toBe(0)
  })
})
