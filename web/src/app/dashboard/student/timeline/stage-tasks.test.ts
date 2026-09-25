import { describe, expect, it } from 'vitest'
import { tasksOfStage } from '@/app/dashboard/student/timeline/stage-tasks'

const ITEMS = [
  { title: '第一段的收件', cohortId: 'c1', stageSeq: 1, stageName: '成組期' },
  { title: '第二段的收件', cohortId: 'c1', stageSeq: 2, stageName: '成組期' },
  { title: '沒指定階段', cohortId: 'c1', stageSeq: null, stageName: null },
  { title: '別屆同序號', cohortId: 'c2', stageSeq: 1, stageName: '成組期' },
]

describe('tasksOfStage：用階段身分（屆別＋序號）分收件', () => {
  it('兩段同名：各段只列自己的收件，不重複', () => {
    expect(tasksOfStage(ITEMS, 'c1', 1).map((i) => i.title)).toEqual(['第一段的收件'])
    expect(tasksOfStage(ITEMS, 'c1', 2).map((i) => i.title)).toEqual(['第二段的收件'])
  })

  it('別屆的收件、沒指定階段的收件都不列', () => {
    const all = [1, 2, 3].flatMap((seq) => tasksOfStage(ITEMS, 'c1', seq)).map((i) => i.title)
    expect(all).not.toContain('別屆同序號')
    expect(all).not.toContain('沒指定階段')
  })
})
