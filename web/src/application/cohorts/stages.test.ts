import { describe, expect, it } from 'vitest'
import {
  describeStagePosition,
  normalizeScheduleInput,
  planStageVersions,
  stagePositionAt,
  timelineView,
  type CohortSchedule,
  type ScheduleInput,
} from '@/application/cohorts/stages'

/**
 * 階段模型（產品模組 02 §4，2026-09-12 定案 Q-PUB01）：開始日嚴格遞增、
 * 下一段開始日 00:00 起換段、年度結束日含當天。時間都以臺灣時間（+08:00）講。
 */

const input = (dates: string[], yearEndDate = '2027-06-30'): ScheduleInput => ({
  stages: dates.map((startDate, i) => ({ name: ['成組期', '期中', '期末', '成果'][i]!, startDate })),
  yearEndDate,
})

const SCHEDULE: CohortSchedule = {
  stages: [
    { seq: 1, name: '成組期', startDate: '2026-09-15', deadlineVersion: 1 },
    { seq: 2, name: '期中', startDate: '2026-11-01', deadlineVersion: 1 },
    { seq: 3, name: '期末', startDate: '2027-01-10', deadlineVersion: 1 },
    { seq: 4, name: '成果', startDate: '2027-03-01', deadlineVersion: 1 },
  ],
  yearEndDate: '2027-06-30',
}

/** 臺灣時間字串 → 瞬間。 */
const tw = (local: string) => new Date(`${local}+08:00`)

describe('normalizeScheduleInput：開始日嚴格遞增', () => {
  it('四段遞增、年度結束日不早於最後一段：通過，前後空白去掉', () => {
    const result = normalizeScheduleInput({
      stages: [
        { name: ' 成組期 ', startDate: '2026-09-15' },
        { name: '期中', startDate: '2026-11-01' },
        { name: '期末', startDate: '2027-01-10' },
        { name: '成果', startDate: '2027-03-01' },
      ],
      yearEndDate: ' 2027-06-30 ',
    })
    expect(result).toMatchObject({ ok: true, value: { yearEndDate: '2027-06-30' } })
    if (result.ok) expect(result.value.stages[0]!.name).toBe('成組期')
  })

  it('第三段早於第二段：VALIDATION_FAILED，而且說清楚是哪一段', () => {
    const result = normalizeScheduleInput(input(['2026-09-15', '2026-11-01', '2026-10-01', '2027-03-01']))
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'stage3.startDate' } })
    if (!result.ok) expect(result.message).toContain('第 3 階段')
  })

  it('兩段同一天也不行（嚴格遞增，不是非遞減）', () => {
    const result = normalizeScheduleInput(input(['2026-09-15', '2026-09-15', '2027-01-10', '2027-03-01']))
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'stage2.startDate' } })
  })

  it('年度結束日早於最後一段開始日：拒絕；等於最後一段開始日可以', () => {
    expect(normalizeScheduleInput(input(['2026-09-15', '2026-11-01', '2027-01-10', '2027-03-01'], '2027-02-28'))).toMatchObject({
      ok: false,
      details: { field: 'yearEndDate' },
    })
    expect(normalizeScheduleInput(input(['2026-09-15', '2026-11-01', '2027-01-10', '2027-03-01'], '2027-03-01')).ok).toBe(true)
  })

  it('不存在的日期、缺名稱、段數不是四：拒絕', () => {
    expect(normalizeScheduleInput(input(['2026-09-15', '2026-02-30', '2027-01-10', '2027-03-01'])).ok).toBe(false)
    expect(
      normalizeScheduleInput({ ...input(['2026-09-15', '2026-11-01', '2027-01-10', '2027-03-01']), stages: [{ name: ' ', startDate: '2026-09-15' }, ...input(['2026-11-01', '2027-01-10', '2027-03-01']).stages] }),
    ).toMatchObject({ ok: false, details: { field: 'stage1.name' } })
    expect(normalizeScheduleInput(input(['2026-09-15', '2026-11-01', '2027-01-10'])).ok).toBe(false)
  })
})

describe('stagePositionAt：今天落在哪一段', () => {
  it('第一階段開始日之前：尚未開始（前一天 23:59:59 也是）', () => {
    const position = stagePositionAt(SCHEDULE, tw('2026-09-14T23:59:59.999'))
    expect(position.kind).toBe('not_started')
    expect(describeStagePosition(position)).toBe('尚未開始')
  })

  it('開始日 00:00 整就進入那一段', () => {
    expect(describeStagePosition(stagePositionAt(SCHEDULE, tw('2026-09-15T00:00:00')))).toBe('階段 1：成組期')
  })

  it('下一段開始日 00:00 起不再屬於上一段（前一毫秒還是上一段）', () => {
    expect(describeStagePosition(stagePositionAt(SCHEDULE, tw('2026-10-31T23:59:59.999')))).toBe('階段 1：成組期')
    expect(describeStagePosition(stagePositionAt(SCHEDULE, tw('2026-11-01T00:00:00')))).toBe('階段 2：期中')
  })

  it('年度結束日當天整天都還是最後一段；隔天 00:00 起年度階段已結束', () => {
    expect(describeStagePosition(stagePositionAt(SCHEDULE, tw('2027-06-30T23:59:59.999')))).toBe('階段 4：成果')
    const ended = stagePositionAt(SCHEDULE, tw('2027-07-01T00:00:00'))
    expect(ended.kind).toBe('ended')
    expect(describeStagePosition(ended)).toBe('年度階段已結束')
  })

  it('日界用臺灣時間：UTC 前一天 16:00 就是臺灣的 00:00', () => {
    expect(describeStagePosition(stagePositionAt(SCHEDULE, new Date('2026-10-31T16:00:00Z')))).toBe('階段 2：期中')
  })

  it('in_stage 帶出這一段的最後一天（下一段開始日前一天）', () => {
    expect(stagePositionAt(SCHEDULE, tw('2026-12-01T12:00:00'))).toEqual({
      kind: 'in_stage',
      seq: 2,
      name: '期中',
      lastDate: '2027-01-09',
    })
  })

  it('沒設階段或年度結束日：尚未設定階段', () => {
    expect(describeStagePosition(stagePositionAt({ stages: [], yearEndDate: null }, new Date()))).toBe('尚未設定階段')
    expect(stagePositionAt({ ...SCHEDULE, yearEndDate: null }, new Date()).kind).toBe('unconfigured')
  })

  it('兩屆各算各的：同一個時間點，不同屆可以在不同階段', () => {
    const other: CohortSchedule = {
      stages: SCHEDULE.stages.map((s) => ({ ...s, startDate: s.startDate.replace('2026', '2027').replace(/^2027-0(1|3)/, '2028-0$1') })),
      yearEndDate: '2028-06-30',
    }
    const at = tw('2026-12-01T00:00:00')
    expect(describeStagePosition(stagePositionAt(SCHEDULE, at))).toBe('階段 2：期中')
    expect(describeStagePosition(stagePositionAt(other, at))).toBe('尚未開始')
  })
})

describe('planStageVersions：日期範圍變了才換期限版本', () => {
  const next = (dates: string[], yearEndDate = '2027-06-30') => {
    const normalized = normalizeScheduleInput(input(dates, yearEndDate))
    if (!normalized.ok) throw new Error(normalized.message)
    return normalized.value
  }

  it('第一次設定：四段都是新的、版本 1', () => {
    const plan = planStageVersions({ stages: [], yearEndDate: null }, next(['2026-09-15', '2026-11-01', '2027-01-10', '2027-03-01']))
    expect(plan.map((p) => [p.seq, p.deadlineVersion, p.isNew, p.rangeChanged])).toEqual([
      [1, 1, true, true],
      [2, 1, true, true],
      [3, 1, true, true],
      [4, 1, true, true],
    ])
  })

  it('改第 3 段開始日：第 2 段的最後一天跟著變，所以第 2、3 段都 +1', () => {
    const plan = planStageVersions(SCHEDULE, next(['2026-09-15', '2026-11-01', '2027-01-20', '2027-03-01']))
    expect(plan.map((p) => p.deadlineVersion)).toEqual([1, 2, 2, 1])
    expect(plan.filter((p) => p.rangeChanged).map((p) => p.seq)).toEqual([2, 3])
  })

  it('改年度結束日：只有最後一段換版本', () => {
    const plan = planStageVersions(SCHEDULE, next(['2026-09-15', '2026-11-01', '2027-01-10', '2027-03-01'], '2027-07-15'))
    expect(plan.map((p) => p.deadlineVersion)).toEqual([1, 1, 1, 2])
  })

  it('只改名稱不動日期：版本不變', () => {
    const renamed = next(['2026-09-15', '2026-11-01', '2027-01-10', '2027-03-01'])
    const plan = planStageVersions(SCHEDULE, { ...renamed, stages: renamed.stages.map((s) => ({ ...s, name: `${s.name}（改名）` })) })
    expect(plan.every((p) => !p.rangeChanged)).toBe(true)
    expect(plan.map((p) => p.deadlineVersion)).toEqual([1, 1, 1, 1])
  })
})

describe('timelineView：專題時間軸每一段的狀態（票 38）', () => {
  it('期中第 1 天：成組期已過、期中進行中、其後尚未開始；時間進度 0%、剩到期中最後一天的天數', () => {
    const view = timelineView(SCHEDULE, tw('2026-11-01T00:00:00'))!
    expect(view.stages.map((s) => [s.name, s.status])).toEqual([
      ['成組期', 'done'],
      ['期中', 'current'],
      ['期末', 'upcoming'],
      ['成果', 'upcoming'],
    ])
    expect(view.stages[1]!.lastDate).toBe('2027-01-09')
    expect(view.current).toEqual({ seq: 2, elapsedPercent: 0, daysLeft: 69 })
  })

  it('最後一天：時間進度 100%、剩 0 天', () => {
    const view = timelineView(SCHEDULE, tw('2027-01-09T23:59:59'))!
    expect(view.current).toEqual({ seq: 2, elapsedPercent: 100, daysLeft: 0 })
  })

  it('尚未開始全部是尚未開始、年度結束後全部已過；兩者都沒有目前這一段', () => {
    const before = timelineView(SCHEDULE, tw('2026-09-14T23:59:59'))!
    expect(before.stages.every((s) => s.status === 'upcoming')).toBe(true)
    expect(before.current).toBeNull()
    const after = timelineView(SCHEDULE, tw('2027-07-01T00:00:00'))!
    expect(after.stages.every((s) => s.status === 'done')).toBe(true)
    expect(after.current).toBeNull()
  })

  it('沒設階段或年度結束日：null（畫面顯示尚未設定）', () => {
    expect(timelineView({ stages: [], yearEndDate: null }, tw('2026-10-01T00:00:00'))).toBeNull()
    expect(timelineView({ stages: SCHEDULE.stages, yearEndDate: null }, tw('2026-10-01T00:00:00'))).toBeNull()
  })
})
