import { describe, expect, it } from 'vitest'
import { buildGradeCsv, DEFAULT_GRADE_EXPORT_FILTER, gradeExportHeader, gradeExportRows } from '@/application/grading/export'
import { computeGroupResult, type CountedEvaluation } from '@/application/grading/gradebook'
import type { Gradebook, GradebookGroup } from '@/application/grading/ports'
import type { SchemeStage } from '@/application/grading/scheme'

/**
 * 票 24 後續：成績匯出補各老師分數欄（S10-11「各階段每位老師 counted 值」）。
 */

const stage = (key: string, name: string, weight: number): SchemeStage => ({
  key,
  name,
  weight,
  letterMap: null,
  items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }],
})
const STAGES = [stage('mid', '期中', 60), stage('fin', '期末', 40)]

let seq = 0
function counted(stageKey: string, teacherName: string, score: string, extra: Partial<CountedEvaluation> = {}): CountedEvaluation {
  seq += 1
  return {
    evaluationId: `e${seq}`,
    assignmentId: `a${seq}`,
    stageKey,
    teacherUserId: `t-${teacherName}`,
    teacherName,
    scores: { i1: score },
    submittedAt: new Date(Date.UTC(2026, 11, 1, 0, seq)),
    assignmentEnded: false,
    ...extra,
  }
}

function group(code: string, requirements: Record<string, number>, evaluations: CountedEvaluation[]): GradebookGroup {
  return {
    id: code,
    code,
    advisorName: null,
    members: [{ name: `${code} 組員`, studentNo: '0410001' }],
    result: computeGroupResult(STAGES, new Map(Object.entries(requirements)), evaluations),
    override: null,
    basisHash: '0'.repeat(64),
    missing: [],
  }
}

function book(groups: GradebookGroup[]): Gradebook {
  return { cohort: { id: 'c', code: '115', archived: false }, version: { id: 'v', versionNo: 1, stages: STAGES }, groups, pendingReviews: [] }
}

describe('匯出的各老師分數欄', () => {
  it('每階段依採計份數最多的組開欄；老師照送出先後；少的組留白；改派保留的舊分數標註', () => {
    const g1 = group('G01', { mid: 2, fin: 1 }, [
      counted('mid', '甲老師', '80'),
      counted('mid', '丙老師', '84.29', { assignmentEnded: true }),
      counted('fin', '乙老師', '90'),
    ])
    const g2 = group('G02', { mid: 1 }, [counted('mid', '丁老師', '70')])
    const b = book([g1, g2])
    const header = gradeExportHeader(b, b.groups, DEFAULT_GRADE_EXPORT_FILTER)
    expect(header.slice(4, 16)).toEqual([
      '期中 份數',
      '期中 老師1',
      '期中 老師1 分數',
      '期中 老師2',
      '期中 老師2 分數',
      '期中 平均',
      '期中 狀態',
      '期末 份數',
      '期末 老師1',
      '期末 老師1 分數',
      '期末 平均',
      '期末 狀態',
    ])
    const rows = gradeExportRows(b, b.groups, DEFAULT_GRADE_EXPORT_FILTER)
    expect(rows.every((r) => r.length === header.length)).toBe(true)
    expect(rows[0]!.slice(4, 16)).toEqual([
      '2／2',
      '甲老師',
      '80.00',
      '丙老師（已改派保留）',
      '84.29',
      '82.15',
      '已完成',
      '1／1',
      '乙老師',
      '90.00',
      '90.00',
      '已完成',
    ])
    expect(rows[1]!.slice(4, 16)).toEqual(['1／1', '丁老師', '70.00', '', '', '70.00', '已完成', '0／未設定', '', '', '', '尚未設定份數'])
  })

  it('只匯出一個階段：只有那一階段的老師欄；還沒有任何採計也留一組空欄（欄位固定）', () => {
    const b = book([group('G01', { mid: 2 }, [])])
    const filter = { ...DEFAULT_GRADE_EXPORT_FILTER, stageKey: 'fin' }
    const header = gradeExportHeader(b, b.groups, filter)
    expect(header.filter((h) => h.includes('老師'))).toEqual(['期末 老師1', '期末 老師1 分數'])
    expect(gradeExportRows(b, b.groups, filter)[0]!.length).toBe(header.length)
  })

  it('老師姓名是使用者可改的字：CSV 公式字首照樣加 \'', () => {
    const b = book([group('G01', { mid: 1 }, [counted('mid', '=1+1', '80'), counted('mid', '@SUM(A1)', '82')])])
    const csv = buildGradeCsv(gradeExportHeader(b, b.groups, DEFAULT_GRADE_EXPORT_FILTER), gradeExportRows(b, b.groups, DEFAULT_GRADE_EXPORT_FILTER))
    expect(csv).toContain(`"'=1+1","80.00"`)
    expect(csv).toContain(`"'@SUM(A1)","82.00"`)
    expect(csv).not.toContain('"=1+1"')
  })
})
