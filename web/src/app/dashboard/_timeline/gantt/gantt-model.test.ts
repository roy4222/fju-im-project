import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_KEY_STEP,
  DAY_PX,
  MAX_DAY_PX,
  MIN_DAY_PX,
  activityAriaLabel,
  activityKeyMove,
  addDays,
  chartRange,
  clampStageStart,
  clampYearEnd,
  dateAtX,
  dayDelta,
  diffDays,
  formatMD,
  handleAriaLabel,
  handleKeyStep,
  initialScrollLeft,
  labelWidthPx,
  layoutActivities,
  monthTicks,
  movedMessage,
  moveActivityDates,
  needsEndTimePrompt,
  parseZoom,
  rowOfDate,
  scheduleInput,
  stageChangeMessage,
  stageLastDates,
  weekTicks,
  wheelZoom,
  xOfDate,
  type GanttActivity,
} from './gantt-model'

const STAGES = [
  { seq: 1, startDate: '2026-10-01' },
  { seq: 2, startDate: '2026-11-19' },
  { seq: 3, startDate: '2027-03-01' },
  { seq: 4, startDate: '2027-05-01' },
]
const YEAR_END = '2027-06-30'

function act(id: string, startDate: string, endDate = startDate, extra: Partial<GanttActivity> = {}): GanttActivity {
  return {
    id,
    title: id,
    startDate,
    endDate,
    allDay: true,
    startTime: null,
    endTime: null,
    timeText: null,
    audienceKind: 'cohort_students',
    status: 'scheduled',
    revision: 1,
    ...extra,
  }
}

describe('日期運算', () => {
  it('addDays／diffDays 跨月、跨年、閏年都對', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-03-08', -7)).toBe('2026-03-01')
    expect(diffDays('2026-10-01', '2026-11-19')).toBe(49)
    expect(diffDays('2026-11-19', '2026-10-01')).toBe(-49)
  })

  it('formatMD 去掉前導零', () => {
    expect(formatMD('2027-03-08')).toBe('3/8')
    expect(formatMD('2026-11-19')).toBe('11/19')
  })
})

describe('日期↔像素', () => {
  const start = '2026-10-01'

  it('xOfDate：第 n 天在 n × 每天寬度', () => {
    expect(xOfDate(start, start, DAY_PX.week)).toBe(0)
    expect(xOfDate('2026-10-11', start, DAY_PX.week)).toBe(260)
    expect(xOfDate('2026-10-11', start, DAY_PX.month)).toBe(80)
  })

  it('dateAtX：像素落在哪一天（向下取整），超出範圍夾到兩端', () => {
    expect(dateAtX(0, start, 26, 100)).toBe('2026-10-01')
    expect(dateAtX(25.9, start, 26, 100)).toBe('2026-10-01')
    expect(dateAtX(26, start, 26, 100)).toBe('2026-10-02')
    expect(dateAtX(-50, start, 26, 100)).toBe('2026-10-01')
    expect(dateAtX(99_999, start, 26, 100)).toBe(addDays(start, 99))
  })

  it('xOfDate 與 dateAtX 互為反函數', () => {
    for (const d of ['2026-10-01', '2026-12-25', '2027-02-28', '2027-06-30']) {
      expect(dateAtX(xOfDate(d, start, 8), start, 8, 400)).toBe(d)
    }
  })

  it('dayDelta：拖拉位移四捨五入成天數（未滿半天不動）', () => {
    expect(dayDelta(78, 26)).toBe(3)
    expect(dayDelta(12, 26)).toBe(0)
    expect(dayDelta(14, 26)).toBe(1)
    expect(dayDelta(-27, 26)).toBe(-1)
    expect(dayDelta(-0.4, 26)).toBe(0)
  })
})

describe('畫面範圍與刻度', () => {
  it('chartRange：從最早日期那個月 1 號，到最晚日期那個月最後一天', () => {
    const range = chartRange({
      stages: STAGES,
      yearEndDate: YEAR_END,
      activities: [act('a', '2026-09-20')],
      deadlines: [{ date: '2027-07-03' }],
      today: '2026-12-01',
    })
    expect(range.startDate).toBe('2026-09-01')
    expect(range.endDate).toBe('2027-07-31')
    expect(range.days).toBe(diffDays('2026-09-01', '2027-07-31') + 1)
  })

  it('chartRange：沒有任何資料時以今天那個月為範圍', () => {
    const range = chartRange({ stages: [], yearEndDate: null, activities: [], deadlines: [], today: '2026-02-10' })
    expect(range).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28', days: 28 })
  })

  it('monthTicks：每月一格，位置與寬度照天數', () => {
    const ticks = monthTicks({ startDate: '2026-10-01', endDate: '2026-12-31', days: 92 }, 8)
    expect(ticks.map((t) => t.label)).toEqual(['2026 年 10 月', '11 月', '12 月'])
    expect(ticks.map((t) => t.x)).toEqual([0, 31 * 8, 61 * 8])
    expect(ticks.map((t) => t.width)).toEqual([31 * 8, 30 * 8, 31 * 8])
  })

  it('monthTicks：跨年那個月再標年份', () => {
    const ticks = monthTicks({ startDate: '2026-12-01', endDate: '2027-01-31', days: 62 }, 8)
    expect(ticks.map((t) => t.label)).toEqual(['2026 年 12 月', '2027 年 1 月'])
  })

  it('weekTicks：週檢視每個星期一一條刻度', () => {
    // 2026-10-01 是星期四，第一個星期一是 10/5
    const ticks = weekTicks({ startDate: '2026-10-01', endDate: '2026-10-31', days: 31 }, 26)
    expect(ticks.map((t) => t.label)).toEqual(['10/5', '10/12', '10/19', '10/26'])
    expect(ticks[0]?.x).toBe(4 * 26)
  })

  it('initialScrollLeft：捲到今天前兩週，不小於 0', () => {
    expect(initialScrollLeft('2026-11-15', '2026-10-01', 26)).toBe(diffDays('2026-10-01', '2026-11-01') * 26)
    expect(initialScrollLeft('2026-10-03', '2026-10-01', 26)).toBe(0)
  })
})

describe('縮放', () => {
  it('兩級：週＝每天 26px、月＝每天 8px', () => {
    expect(DAY_PX).toEqual({ week: 26, month: 8 })
  })

  it('parseZoom：localStorage 只收 week／month，其他回預設 month', () => {
    expect(parseZoom('week')).toBe('week')
    expect(parseZoom('month')).toBe('month')
    expect(parseZoom(null)).toBe('month')
    expect(parseZoom('day')).toBe('month')
  })

  it('wheelZoom：Ctrl+滾輪往上放大、往下縮小，夾在上下限', () => {
    expect(wheelZoom(8, -100)).toBeGreaterThan(8)
    expect(wheelZoom(26, 100)).toBeLessThan(26)
    expect(wheelZoom(MAX_DAY_PX, -100)).toBe(MAX_DAY_PX)
    expect(wheelZoom(MIN_DAY_PX, 100)).toBe(MIN_DAY_PX)
    expect(wheelZoom(10, 0)).toBe(10)
  })
})

describe('階段', () => {
  it('stageLastDates：每段最後一天＝下一段開始日前一天，最後一段到年度結束日', () => {
    expect(stageLastDates(STAGES, YEAR_END)).toEqual(['2026-11-18', '2027-02-28', '2027-04-30', '2027-06-30'])
  })

  it('stageLastDates：沒有年度結束日時最後一段是 null', () => {
    expect(stageLastDates(STAGES, null).at(-1)).toBeNull()
  })

  it('rowOfDate：日期落在哪一段（0 起算）；第一段之前算第一段，年度結束後算最後一段', () => {
    expect(rowOfDate('2026-10-01', STAGES)).toBe(0)
    expect(rowOfDate('2026-11-18', STAGES)).toBe(0)
    expect(rowOfDate('2026-11-19', STAGES)).toBe(1)
    expect(rowOfDate('2027-05-10', STAGES)).toBe(3)
    expect(rowOfDate('2026-09-01', STAGES)).toBe(0)
    expect(rowOfDate('2027-08-01', STAGES)).toBe(3)
  })

  it('clampStageStart：嚴格遞增，夾在上一段開始日 +1 與下一段開始日 −1 之間', () => {
    expect(clampStageStart(STAGES, YEAR_END, 2, '2026-11-12')).toBe('2026-11-12')
    // 拖到第 1 段開始日之前 → 夾到第 1 段開始日 +1 天
    expect(clampStageStart(STAGES, YEAR_END, 2, '2026-09-01')).toBe('2026-10-02')
    expect(clampStageStart(STAGES, YEAR_END, 2, '2027-04-01')).toBe('2027-02-28')
  })

  it('clampStageStart：最後一段的開始日不晚於年度結束日（可同一天）', () => {
    expect(clampStageStart(STAGES, YEAR_END, 4, '2027-08-01')).toBe(YEAR_END)
  })

  it('clampStageStart：沒有年度結束日時最後一段只夾下限', () => {
    expect(clampStageStart(STAGES, null, 4, '2027-08-01')).toBe('2027-08-01')
  })

  it('clampYearEnd：不早於最後一段開始日', () => {
    expect(clampYearEnd(STAGES, '2027-04-01')).toBe('2027-05-01')
    expect(clampYearEnd(STAGES, '2027-07-07')).toBe('2027-07-07')
  })

  it('scheduleInput：只換被拖的那一段，其餘原封送出', () => {
    expect(scheduleInput(STAGES, YEAR_END, 7, { seq: 2, startDate: '2026-11-12' })).toEqual({
      stages: [
        { seq: 1, startDate: '2026-10-01' },
        { seq: 2, startDate: '2026-11-12' },
        { seq: 3, startDate: '2027-03-01' },
        { seq: 4, startDate: '2027-05-01' },
      ],
      yearEndDate: YEAR_END,
      revision: 7,
    })
    expect(scheduleInput(STAGES, YEAR_END, 7, { yearEndDate: '2027-07-07' }).yearEndDate).toBe('2027-07-07')
  })

  it('stageChangeMessage：往前拖＝上一段變短，有作業時提醒', () => {
    expect(
      stageChangeMessage({ seq: 2, name: '題目與計畫書', from: '2026-11-19', to: '2026-11-12', groupItemCount: 1 }),
    ).toBe('第 2 階段『題目與計畫書』開始日 11/19 → 11/12（第 1 階段跟著變短）。有 1 個整組作業在這兩段裡，會重新提醒相關的組。')
  })

  it('stageChangeMessage：往後拖＝上一段變長；沒有作業就不提醒', () => {
    expect(stageChangeMessage({ seq: 3, name: '實作', from: '2027-03-01', to: '2027-03-08', groupItemCount: 0 })).toBe(
      '第 3 階段『實作』開始日 3/1 → 3/8（第 2 階段跟著變長）。',
    )
  })

  it('stageChangeMessage：年度結束日', () => {
    expect(stageChangeMessage({ seq: 'yearEnd', from: '2027-06-30', to: '2027-07-07', groupItemCount: 2 })).toBe(
      '年度結束日 6/30 → 7/7（第 4 階段跟著變長）。有 2 個整組作業在這段裡，會重新提醒相關的組。',
    )
  })
})

describe('車道配置', () => {
  it('同一段裡重疊的活動往下排，不重疊的共用車道', () => {
    const layout = layoutActivities(
      [
        act('a', '2026-10-05', '2026-10-07'),
        act('b', '2026-10-06'),
        act('c', '2026-10-08'),
        act('d', '2026-10-07', '2026-10-09'),
      ],
      STAGES,
    )
    expect(layout.place.get('a')).toEqual({ row: 0, lane: 0 })
    expect(layout.place.get('b')).toEqual({ row: 0, lane: 1 })
    expect(layout.place.get('c')).toEqual({ row: 0, lane: 0 })
    // b 只佔 10/6，10/7 開始的 d 可以放進 b 那條
    expect(layout.place.get('d')).toEqual({ row: 0, lane: 1 })
    expect(layout.laneCounts).toEqual([2, 1, 1, 1])
  })

  it('照開始日落在哪段決定列；跨段的活動仍在開始那段', () => {
    const layout = layoutActivities([act('x', '2026-11-15', '2026-11-25'), act('y', '2026-11-20')], STAGES)
    expect(layout.place.get('x')).toEqual({ row: 0, lane: 0 })
    expect(layout.place.get('y')).toEqual({ row: 1, lane: 0 })
  })

  it('minDays：短橫條的名字畫在右邊時，佔的天數也算進車道', () => {
    const layout = layoutActivities([act('a', '2026-10-05'), act('b', '2026-10-07')], STAGES, (x) => (x.id === 'a' ? 4 : 1))
    expect(layout.place.get('b')).toEqual({ row: 0, lane: 1 })
    const plain = layoutActivities([act('a', '2026-10-05'), act('b', '2026-10-07')], STAGES)
    expect(plain.place.get('b')).toEqual({ row: 0, lane: 0 })
  })

  it('labelWidthPx：中文字比英數寬', () => {
    expect(labelWidthPx('說明會')).toBe(16 + 3 * 12)
    expect(labelWidthPx('AI 展')).toBe(16 + 7 * 3 + 12)
  })

  it('已取消的活動不畫', () => {
    const layout = layoutActivities([act('a', '2026-10-05', '2026-10-05', { status: 'cancelled' })], STAGES)
    expect(layout.place.has('a')).toBe(false)
  })

  it('沒有階段時全部放一列', () => {
    const layout = layoutActivities([act('a', '2026-10-05'), act('b', '2026-10-05')], [])
    expect(layout.laneCounts).toEqual([2])
  })
})

describe('拖拉與鍵盤位移', () => {
  const a = act('說明會', '2027-03-05', '2027-03-07')

  it('整段平移保留天數', () => {
    expect(moveActivityDates(a, 'move', 3)).toEqual({ startDate: '2027-03-08', endDate: '2027-03-10' })
  })

  it('拉右端只改結束日、拉左端只改開始日', () => {
    expect(moveActivityDates(a, 'end', 2)).toEqual({ startDate: '2027-03-05', endDate: '2027-03-09' })
    expect(moveActivityDates(a, 'start', -1)).toEqual({ startDate: '2027-03-04', endDate: '2027-03-07' })
  })

  it('拉把手不能讓結束日早於開始日（夾成同一天）', () => {
    expect(moveActivityDates(a, 'end', -10)).toEqual({ startDate: '2027-03-05', endDate: '2027-03-05' })
    expect(moveActivityDates(a, 'start', 10)).toEqual({ startDate: '2027-03-07', endDate: '2027-03-07' })
  })

  it('activityKeyMove：→ 平移 1 天、Shift+→ 7 天、Alt+→ 結束日、Alt+Shift+← 開始日', () => {
    const k = (key: string, shiftKey = false, altKey = false) => activityKeyMove({ key, shiftKey, altKey })
    expect(k('ArrowRight')).toEqual({ mode: 'move', days: 1 })
    expect(k('ArrowLeft')).toEqual({ mode: 'move', days: -1 })
    expect(k('ArrowRight', true)).toEqual({ mode: 'move', days: ACTIVITY_KEY_STEP.week })
    expect(k('ArrowRight', false, true)).toEqual({ mode: 'end', days: 1 })
    expect(k('ArrowLeft', true, true)).toEqual({ mode: 'start', days: -1 })
    expect(k('Enter')).toBeNull()
    expect(ACTIVITY_KEY_STEP.week).toBe(7)
  })

  it('handleKeyStep：階段把手 ←→ 一天、Shift 一週、其他鍵不動', () => {
    expect(handleKeyStep({ key: 'ArrowLeft', shiftKey: false })).toBe(-1)
    expect(handleKeyStep({ key: 'ArrowRight', shiftKey: true })).toBe(7)
    expect(handleKeyStep({ key: 'Tab', shiftKey: false })).toBe(0)
  })

  it('needsEndTimePrompt：非全天、沒寫結束時間的活動拉成跨日 → 要改開編輯視窗', () => {
    const interview = act('面談', '2027-04-01', '2027-04-01', { allDay: false, startTime: '09:00', endTime: null })
    expect(needsEndTimePrompt(interview, moveActivityDates(interview, 'end', 1))).toBe(true)
    // 整段平移仍是單日：可以直接存
    expect(needsEndTimePrompt(interview, moveActivityDates(interview, 'move', 2))).toBe(false)
    // 有結束時間、或全天的活動跨日沒問題
    expect(needsEndTimePrompt({ ...interview, endTime: '17:00' }, { startDate: '2027-04-01', endDate: '2027-04-02' })).toBe(false)
    expect(needsEndTimePrompt(act('展', '2027-04-01'), { startDate: '2027-04-01', endDate: '2027-04-02' })).toBe(false)
  })

  it('movedMessage：單日寫一天、跨日寫起訖', () => {
    expect(movedMessage('說明會', { startDate: '2027-03-08', endDate: '2027-03-08' })).toBe('已把「說明會」改到 3/8')
    expect(movedMessage('期中展', { startDate: '2027-03-10', endDate: '2027-03-12' })).toBe('已把「期中展」改到 3/10–3/12')
  })
})

describe('aria-label', () => {
  it('活動橫條含名稱與日期範圍', () => {
    expect(activityAriaLabel(act('期中展', '2027-03-10', '2027-03-12'))).toBe('期中展，3/10–3/12')
    expect(activityAriaLabel(act('說明會', '2027-03-05', '2027-03-05', { timeText: '14:00–16:00' }))).toBe(
      '說明會，3/5 14:00–16:00',
    )
  })

  it('把手含現值', () => {
    expect(handleAriaLabel({ seq: 2, name: '題目與計畫書', date: '2026-11-19' })).toBe(
      '第 2 階段「題目與計畫書」開始日 11/19（左右鍵調整、Enter 儲存）',
    )
    expect(handleAriaLabel({ seq: 'yearEnd', date: '2027-06-30' })).toBe('年度結束日 6/30（左右鍵調整、Enter 儲存）')
  })
})
