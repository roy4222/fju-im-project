import { describe, expect, it } from 'vitest'
import {
  describeStagePosition,
  normalizeScheduleInput,
  planStageVersions,
  STAGE_DESCRIPTION_MAX_LENGTH,
  stageChangeSummary,
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
    { seq: 1, name: '成組期', description: '', startDate: '2026-09-15', deadlineVersion: 1 },
    { seq: 2, name: '期中', description: '', startDate: '2026-11-01', deadlineVersion: 1 },
    { seq: 3, name: '期末', description: '', startDate: '2027-01-10', deadlineVersion: 1 },
    { seq: 4, name: '成果', description: '', startDate: '2027-03-01', deadlineVersion: 1 },
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

  it('只改一句話說明（票 39）：說明帶進計畫、版本不變', () => {
    const described = next(['2026-09-15', '2026-11-01', '2027-01-10', '2027-03-01'])
    const plan = planStageVersions(SCHEDULE, {
      ...described,
      stages: described.stages.map((s, i) => ({ ...s, description: i === 0 ? '五人一組報名。' : '' })),
    })
    expect(plan.map((p) => p.description)).toEqual(['五人一組報名。', '', '', ''])
    expect(plan.every((p) => !p.rangeChanged)).toBe(true)
    expect(plan.map((p) => p.deadlineVersion)).toEqual([1, 1, 1, 1])
  })
})

describe('normalizeScheduleInput：一句話說明（票 39）', () => {
  const dates = ['2026-09-15', '2026-11-01', '2027-01-10', '2027-03-01']
  const withDescription = (description: string | undefined): ScheduleInput => ({
    stages: dates.map((startDate, i) => ({ name: `第${i + 1}段`, startDate, ...(i === 0 ? { description } : {}) })),
    yearEndDate: '2027-06-30',
  })

  it('選填：沒給是空字串；換行與連續空白收成一個空格', () => {
    const none = normalizeScheduleInput(withDescription(undefined))
    expect(none.ok && none.value.stages.map((s) => s.description)).toEqual(['', '', '', ''])
    const messy = normalizeScheduleInput(withDescription('  五人一組\n報名，   各自確認。 '))
    expect(messy.ok && messy.value.stages[0]!.description).toBe('五人一組 報名， 各自確認。')
  })

  it(`超過 ${STAGE_DESCRIPTION_MAX_LENGTH} 字：擋下並指出是哪一段`, () => {
    const long = normalizeScheduleInput(withDescription('字'.repeat(STAGE_DESCRIPTION_MAX_LENGTH + 1)))
    expect(long.ok ? null : long.details?.field).toBe('stage1.description')
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

  it('只有一天的段（下一段隔天開始）：當天就是最後一天，100%、剩 0 天', () => {
    const oneDay: CohortSchedule = {
      stages: [
        { seq: 1, name: '報名', description: '', startDate: '2026-09-15', deadlineVersion: 1 },
        { seq: 2, name: '期中', description: '', startDate: '2026-09-16', deadlineVersion: 1 },
      ],
      yearEndDate: '2027-06-30',
    }
    const view = timelineView(oneDay, tw('2026-09-15T10:00:00'))!
    expect(view.stages[0]).toMatchObject({ startDate: '2026-09-15', lastDate: '2026-09-15', status: 'current' })
    expect(view.current).toEqual({ seq: 1, elapsedPercent: 100, daysLeft: 0 })
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

describe('stageChangeSummary：階段確認框與通知的句子（③ §9.2、AC-C3-38、39）', () => {
  // AC-C3-38：10/1、11/19、3/1、5/1，年度結束 6/30。
  const BEFORE: CohortSchedule = {
    stages: [
      { seq: 1, name: '分組', description: '', startDate: '2026-10-01', deadlineVersion: 1 },
      { seq: 2, name: '題目與計畫書', description: '', startDate: '2026-11-19', deadlineVersion: 1 },
      { seq: 3, name: '系統開發', description: '', startDate: '2027-03-01', deadlineVersion: 1 },
      { seq: 4, name: '成果', description: '', startDate: '2027-05-01', deadlineVersion: 1 },
    ],
    yearEndDate: '2027-06-30',
  }
  const after = (patch: { seq?: number; startDate?: string; name?: string; yearEndDate?: string }) => ({
    stages: BEFORE.stages.map((s) => ({
      name: s.seq === patch.seq && patch.name ? patch.name : s.name,
      description: s.description,
      startDate: s.seq === patch.seq && patch.startDate ? patch.startDate : s.startDate,
    })),
    yearEndDate: patch.yearEndDate ?? BEFORE.yearEndDate!,
  })

  it('第 1／2 段分界往左 7 天：兩段都變、確認句與通知標題（最後一天＝下一段開始日前一天）', () => {
    const summary = stageChangeSummary(BEFORE, after({ seq: 2, startDate: '2026-11-12' }), 1)
    expect(summary).toEqual({
      changedStages: [1, 2],
      windows: [
        { seq: 1, startDate: '2026-10-01', lastDate: '2026-11-11' },
        { seq: 2, startDate: '2026-11-12', lastDate: '2027-02-28' },
      ],
      message: '第 2 階段『題目與計畫書』開始日 11/19 → 11/12（第 1 階段跟著變短）。有 1 個整組作業在這兩段裡，會重新提醒相關的組。',
      notificationTitle: '專題時程更新：第 2 階段『題目與計畫書』改為 11/12–2/28',
    })
  })

  it('往右拖＝上一段變長；沒有整組作業就不提醒', () => {
    const summary = stageChangeSummary(BEFORE, after({ seq: 3, startDate: '2027-03-08' }), 0)
    expect(summary?.message).toBe('第 3 階段『系統開發』開始日 3/1 → 3/8（第 2 階段跟著變長）。')
    expect(summary?.notificationTitle).toBe('專題時程更新：第 3 階段『系統開發』改為 3/8–4/30')
  })

  it('年度結束日：只有第 4 段變', () => {
    const summary = stageChangeSummary(BEFORE, after({ yearEndDate: '2027-07-07' }), 2)
    expect(summary?.changedStages).toEqual([4])
    expect(summary?.message).toBe('年度結束日 6/30 → 7/7（第 4 階段跟著變長）。有 2 個整組作業在這段裡，會重新提醒相關的組。')
    expect(summary?.notificationTitle).toBe('專題時程更新：第 4 階段『成果』改為 5/1–7/7')
  })

  it('只改名稱、日期沒變：null（不確認、不通知）', () => {
    expect(stageChangeSummary(BEFORE, after({ seq: 2, name: '題目' }), 3)).toBeNull()
  })

  it('一次改兩個分界（視窗路徑）：句子逐一列出', () => {
    const next = after({ seq: 2, startDate: '2026-11-12' })
    const two = { ...next, stages: next.stages.map((s, i) => (i === 3 ? { ...s, startDate: '2027-05-08' } : s)) }
    const summary = stageChangeSummary(BEFORE, two, 0)
    expect(summary?.changedStages).toEqual([1, 2, 3, 4])
    expect(summary?.message).toBe('第 2 階段『題目與計畫書』開始日 11/19 → 11/12；第 4 階段『成果』開始日 5/1 → 5/8。')
    expect(summary?.notificationTitle).toBe('專題時程更新：第 2 階段『題目與計畫書』改為 11/12–2/28、第 4 階段『成果』改為 5/8–6/30')
  })
})
