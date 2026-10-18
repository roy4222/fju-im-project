import type { ActivityAudience } from '@/application/cohorts'

/**
 * 專題時程甘特的純函式與凍結介面（規格③《設計方案》§9.3；C3-03）。
 *
 * 從原型 `proto-timeline` 的 `proto-model.ts` 重寫：日期↔像素、階段最後一天、夾限、車道、縮放刻度、
 * 鍵盤位移與畫面上的句子都在這裡，`gantt.tsx` 只管畫與事件。不 import 任何 server 模組，
 * 日期一律是臺灣日期字串 `YYYY-MM-DD`（伺服器算好傳進來），這裡用 UTC 午夜做天數運算，不碰時區。
 */

// ── 凍結介面（§9.3；C3-08、C3-13、C3-14 共用，不另加方法） ─────────────────────────────

export type GanttStage = { seq: number; name: string; startDate: string; lastDate: string; deadlineVersion: number }

/** startTime／endTime：'HH:mm'；全天都是 null。非全天且 endTime 為 null ＝「單日、沒寫結束時間」。 */
export type GanttActivity = {
  id: string
  title: string
  startDate: string
  endDate: string
  allDay: boolean
  startTime: string | null
  endTime: string | null
  timeText: string | null
  audienceKind: ActivityAudience
  status: 'scheduled' | 'cancelled'
  revision: number
}

/** 作業截止，鎖住（不能拖）；`href` 連到①的作業頁。 */
export type GanttDeadline = { id: string; title: string; date: string; href: string | null }

/** server action 包裝回來的結果；`message` 是伺服器句子，失敗時 gantt 原樣放進 `role="alert"`。 */
export type ActionResult = { ok: true; message?: string } | { ok: false; message: string }

export type ScheduleInput = { stages: { seq: number; startDate: string }[]; yearEndDate: string; revision: number }

export type GanttEditor = {
  /**
   * 階段分界／年度結束日放開（或把手上按 Enter）時呼叫。gantt 不管「要不要確認」：由 `gantt-mount` adapter 完成
   * preview → 確認框 → 真正儲存；resolve `{ ok:true }` 停在新位置、`{ ok:false, cancelled:true }` 只回彈不顯示 alert、
   * 其他 `{ ok:false, message }` 回彈＋ `role="alert"`。
   */
  saveSchedule(input: ScheduleInput): Promise<ActionResult | { ok: false; cancelled: true }>
  /** 點階段色塊、或色塊聚焦時按 Enter：開「編輯第 n 階段」視窗。 */
  openStage(seq: number): void
  moveActivity(id: string, revision: number, startDate: string, endDate: string): Promise<ActionResult>
  openCreate(prefill: { startDate: string; endDate: string }): void
  /** 一般點擊不傳；無結束時間的活動拉把手跨日時傳拖後起訖（AC-C3-48）。 */
  openEdit(id: string, prefill?: { startDate: string; endDate: string }): void
  remove(id: string, revision: number): Promise<ActionResult>
  cohortRevision: number
}

export type GanttProps = {
  cohortId: string
  stages: GanttStage[]
  yearEndDate: string | null
  activities: GanttActivity[]
  deadlines: GanttDeadline[]
  today: string
  /** 前台一律 view。 */
  mode: 'edit' | 'view'
  /** mode='edit' 才有；全部是 server action 的包裝。 */
  editor?: GanttEditor
}

// ── 日期 ──────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

function toDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / DAY_MS
}

function fromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
  return fromDay(toDay(date) + days)
}

/** `to − from` 的天數。 */
export function diffDays(from: string, to: string): number {
  return toDay(to) - toDay(from)
}

const minDate = (a: string, b: string) => (a < b ? a : b)
const maxDate = (a: string, b: string) => (a > b ? a : b)

/** `2027-03-08` → `3/8`。 */
export function formatMD(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${m}/${d}`
}

/** 單日 `3/8`、跨日 `3/10–3/12`。 */
export function rangeText(startDate: string, endDate: string): string {
  return startDate === endDate ? formatMD(startDate) : `${formatMD(startDate)}–${formatMD(endDate)}`
}

// ── 日期↔像素、縮放 ───────────────────────────────────────────────────────────────

export type ZoomLevel = 'week' | 'month'

/** 縮放兩級（原型四級收成兩級）：週＝每天 26px、月＝每天 8px。 */
export const DAY_PX: Record<ZoomLevel, number> = { week: 26, month: 8 }
/** `Ctrl+滾輪` 微調的上下限。 */
export const MIN_DAY_PX = 4
export const MAX_DAY_PX = 40
export const ZOOM_STORAGE_KEY = 'gantt-zoom'
/** 長按開右鍵選單的時間（毫秒）。 */
export const LONG_PRESS_MS = 600
/** 指標移動超過這個像素才算拖拉，否則是點擊。 */
export const DRAG_THRESHOLD_PX = 4

export function parseZoom(value: string | null | undefined): ZoomLevel {
  return value === 'week' || value === 'month' ? value : 'month'
}

/** `Ctrl+滾輪`：往上（deltaY < 0）放大、往下縮小，夾在上下限，取到 0.1px。 */
export function wheelZoom(dayPx: number, deltaY: number): number {
  const next = dayPx * Math.exp(-deltaY * 0.002)
  return Math.round(Math.min(MAX_DAY_PX, Math.max(MIN_DAY_PX, next)) * 10) / 10
}

export function xOfDate(date: string, rangeStart: string, dayPx: number): number {
  return diffDays(rangeStart, date) * dayPx
}

/** 像素落在哪一天（向下取整），超出範圍夾到第一天／最後一天。 */
export function dateAtX(x: number, rangeStart: string, dayPx: number, days: number): string {
  const index = Math.min(days - 1, Math.max(0, Math.floor(x / dayPx)))
  return addDays(rangeStart, index)
}

/** 拖拉位移換成天數（四捨五入：過半天才動）。 */
export function dayDelta(dx: number, dayPx: number): number {
  const days = Math.round(dx / dayPx)
  return days === 0 ? 0 : days // 不回 -0（`toEqual` 與畫面判斷都當它是「沒動」）
}

export type ChartRange = { startDate: string; endDate: string; days: number }

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

function monthEnd(date: string): string {
  const [y, m] = date.split('-').map(Number)
  return fromDay(Date.UTC(y ?? 1970, m ?? 1, 1) / DAY_MS - 1)
}

/** 畫面範圍：最早日期那個月的 1 號到最晚日期那個月的最後一天（含今天、階段、年度結束日、活動、截止）。 */
export function chartRange(input: {
  stages: { startDate: string }[]
  yearEndDate: string | null
  activities: { startDate: string; endDate: string }[]
  deadlines: { date: string }[]
  today: string
}): ChartRange {
  let lo = input.today
  let hi = input.today
  const see = (d: string) => {
    lo = minDate(lo, d)
    hi = maxDate(hi, d)
  }
  input.stages.forEach((s) => see(s.startDate))
  if (input.yearEndDate) see(input.yearEndDate)
  input.activities.forEach((a) => {
    see(a.startDate)
    see(a.endDate)
  })
  input.deadlines.forEach((d) => see(d.date))
  const startDate = monthStart(lo)
  const endDate = monthEnd(hi)
  return { startDate, endDate, days: diffDays(startDate, endDate) + 1 }
}

export type Tick = { date: string; x: number; width: number; label: string }

/** 月份刻度：第一格與每年 1 月標年份。 */
export function monthTicks(range: ChartRange, dayPx: number): Tick[] {
  const ticks: Tick[] = []
  for (let d = range.startDate; d <= range.endDate; d = addDays(monthEnd(d), 1)) {
    const [y, m] = d.split('-').map(Number)
    const end = minDate(monthEnd(d), range.endDate)
    ticks.push({
      date: d,
      x: xOfDate(d, range.startDate, dayPx),
      width: (diffDays(d, end) + 1) * dayPx,
      label: ticks.length === 0 || m === 1 ? `${y} 年 ${m} 月` : `${m} 月`,
    })
  }
  return ticks
}

/** 週檢視的細刻度：每個星期一。 */
export function weekTicks(range: ChartRange, dayPx: number): Tick[] {
  const weekday = new Date(toDay(range.startDate) * DAY_MS).getUTCDay()
  const ticks: Tick[] = []
  for (let d = addDays(range.startDate, (8 - weekday) % 7); d <= range.endDate; d = addDays(d, 7)) {
    ticks.push({ date: d, x: xOfDate(d, range.startDate, dayPx), width: 7 * dayPx, label: formatMD(d) })
  }
  return ticks
}

/** 第一次畫捲到今天前兩週。 */
export function initialScrollLeft(today: string, rangeStart: string, dayPx: number): number {
  return Math.max(0, xOfDate(addDays(today, -14), rangeStart, dayPx))
}

// ── 階段 ──────────────────────────────────────────────────────────────────────────

type StageStart = { seq: number; startDate: string }

/** 一屆固定四段（`composition/cohorts.ts` 的 `STAGE_COUNT`；那是 server 模組，這裡不 import）。 */
const STAGE_COUNT = 4

/** 每段最後一天（含）：下一段開始日前一天；最後一段到年度結束日（沒設就是 null）。 */
export function stageLastDates(stages: StageStart[], yearEndDate: string | null): (string | null)[] {
  return stages.map((s, i) => {
    const next = stages[i + 1]
    return next ? addDays(next.startDate, -1) : yearEndDate
  })
}

/** 日期落在哪一段（0 起算）。第一段之前算第一段、最後一段之後算最後一段；沒有階段回 0。 */
export function rowOfDate(date: string, stages: StageStart[]): number {
  let row = 0
  stages.forEach((s, i) => {
    if (date >= s.startDate) row = i
  })
  return row
}

/**
 * 拖第 `seq` 段的開始日（它跟上一段的分界）：嚴格遞增，夾在上一段開始日 +1 天與下一段開始日 −1 天之間；
 * 最後一段不晚於年度結束日（可同一天，`stages.ts` 的規則）。
 */
export function clampStageStart(stages: StageStart[], yearEndDate: string | null, seq: number, date: string): string {
  const i = stages.findIndex((s) => s.seq === seq)
  const prev = stages[i - 1]
  const next = stages[i + 1]
  let d = date
  if (prev) d = maxDate(d, addDays(prev.startDate, 1))
  if (next) d = minDate(d, addDays(next.startDate, -1))
  else if (yearEndDate) d = minDate(d, yearEndDate)
  return d
}

/** 年度結束日不早於最後一段開始日。 */
export function clampYearEnd(stages: StageStart[], date: string): string {
  const last = stages.at(-1)
  return last ? maxDate(date, last.startDate) : date
}

/** 組 `saveSchedule` 的輸入：只換被拖的那一段（或年度結束日），其餘原封送出。 */
export function scheduleInput(
  stages: StageStart[],
  yearEndDate: string | null,
  revision: number,
  change: { seq: number; startDate: string } | { yearEndDate: string },
): ScheduleInput {
  return {
    stages: stages.map((s) => ({
      seq: s.seq,
      startDate: 'seq' in change && change.seq === s.seq ? change.startDate : s.startDate,
    })),
    yearEndDate: 'yearEndDate' in change ? change.yearEndDate : (yearEndDate ?? ''),
    revision,
  }
}

/**
 * 階段確認框的句子（§9.2；確認框在 `gantt-mount` adapter，句子共用這裡）。
 * 「第 2 階段『題目與計畫書』開始日 11/19 → 11/12（第 1 階段跟著變短）。有 N 個整組作業在這兩段裡，會重新提醒相關的組。」
 */
export function stageChangeMessage(
  change:
    | { seq: number; name: string; from: string; to: string; groupItemCount: number }
    | { seq: 'yearEnd'; from: string; to: string; groupItemCount: number },
): string {
  const longer = change.to > change.from
  const reminder = (where: string) =>
    change.groupItemCount > 0 ? `有 ${change.groupItemCount} 個整組作業在${where}裡，會重新提醒相關的組。` : ''
  if (change.seq === 'yearEnd') {
    return `年度結束日 ${formatMD(change.from)} → ${formatMD(change.to)}（第 ${STAGE_COUNT} 階段跟著變${longer ? '長' : '短'}）。${reminder('這段')}`
  }
  return `第 ${change.seq} 階段『${change.name}』開始日 ${formatMD(change.from)} → ${formatMD(change.to)}（第 ${change.seq - 1} 階段跟著變${longer ? '長' : '短'}）。${reminder('這兩段')}`
}

// ── 車道 ──────────────────────────────────────────────────────────────────────────

export type Placement = { row: number; lane: number }

/**
 * 每段一列：活動放在開始日落在的那段（跨段的橫條照實畫長）；同列重疊的往下排車道（貪婪：放進第一條空的）。
 * 已取消的不畫（§9.4：清單有、甘特沒有）。
 */
export function layoutActivities(
  activities: GanttActivity[],
  stages: StageStart[],
  /** 畫面上至少佔幾天（短橫條的名字畫在右邊時也要算進去，避免跟同車道的下一條疊在一起）；預設照起訖。 */
  minDays: (a: GanttActivity) => number = () => 1,
): { place: Map<string, Placement>; laneCounts: number[] } {
  const rows = Math.max(1, stages.length)
  const laneEnds: string[][] = Array.from({ length: rows }, () => [])
  const place = new Map<string, Placement>()
  const sorted = activities
    .filter((a) => a.status === 'scheduled')
    .toSorted((a, b) => a.startDate.localeCompare(b.startDate) || b.endDate.localeCompare(a.endDate) || a.id.localeCompare(b.id))
  for (const a of sorted) {
    const row = rowOfDate(a.startDate, stages)
    const ends = laneEnds[row] ?? []
    let lane = ends.findIndex((end) => end < a.startDate)
    if (lane === -1) lane = ends.length
    ends[lane] = maxDate(a.endDate, addDays(a.startDate, minDays(a) - 1))
    laneEnds[row] = ends
    place.set(a.id, { row, lane })
  }
  return { place, laneCounts: laneEnds.map((ends) => Math.max(1, ends.length)) }
}

/** 橫條上名字的估計寬度（px，0.75rem 粗體：中日韓字約 12px、其他約 7px，左右留白 16px）。 */
export function labelWidthPx(text: string): number {
  let width = 16
  for (const ch of text) width += /[\u2E80-\uFFFF]/.test(ch) ? 12 : 7
  return width
}

// ── 拖拉與鍵盤 ────────────────────────────────────────────────────────────────────

export type DragMode = 'move' | 'start' | 'end'
export type DateSpan = { startDate: string; endDate: string }

/** 平移保留天數；拉左端只改開始日、拉右端只改結束日，不讓兩端交叉（夾成同一天）。 */
export function moveActivityDates(a: DateSpan, mode: DragMode, days: number): DateSpan {
  if (mode === 'move') return { startDate: addDays(a.startDate, days), endDate: addDays(a.endDate, days) }
  if (mode === 'start') return { startDate: minDate(addDays(a.startDate, days), a.endDate), endDate: a.endDate }
  return { startDate: a.startDate, endDate: maxDate(addDays(a.endDate, days), a.startDate) }
}

export const ACTIVITY_KEY_STEP = { day: 1, week: 7 } as const

type KeyLike = { key: string; shiftKey: boolean; altKey?: boolean }

const arrowSign = (key: string) => (key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0)

/** 橫條的鍵盤：`←→` 平移一天、`Shift+←→` 一週、`Alt+←→` 改結束日、`Alt+Shift+←→` 改開始日。 */
export function activityKeyMove(e: KeyLike): { mode: DragMode; days: number } | null {
  const sign = arrowSign(e.key)
  if (!sign) return null
  if (e.altKey) return { mode: e.shiftKey ? 'start' : 'end', days: sign }
  return { mode: 'move', days: sign * (e.shiftKey ? ACTIVITY_KEY_STEP.week : ACTIVITY_KEY_STEP.day) }
}

/** 階段把手的鍵盤：`←→` 一天、`Shift+←→` 一週；其他鍵 0。 */
export function handleKeyStep(e: KeyLike): number {
  return arrowSign(e.key) * (e.shiftKey ? ACTIVITY_KEY_STEP.week : ACTIVITY_KEY_STEP.day)
}

/**
 * 非全天、沒寫結束時間的活動（單日）被拉成跨日：不能直接存（伺服器會擋「跨日的活動要填結束時間」），
 * gantt 改呼叫 `openEdit(id, 拖後起訖)` 讓人補結束時間（§9.3；AC-C3-48）。
 */
export function needsEndTimePrompt(a: Pick<GanttActivity, 'allDay' | 'endTime'>, next: DateSpan): boolean {
  return !a.allDay && a.endTime === null && next.startDate !== next.endDate
}

// ── 畫面上的句子 ──────────────────────────────────────────────────────────────────

export function movedMessage(title: string, span: DateSpan): string {
  return `已把「${title}」改到 ${rangeText(span.startDate, span.endDate)}`
}

export function activityAriaLabel(a: Pick<GanttActivity, 'title' | 'startDate' | 'endDate' | 'timeText'>): string {
  return `${a.title}，${rangeText(a.startDate, a.endDate)}${a.timeText ? ` ${a.timeText}` : ''}`
}

export function stageAriaLabel(s: { seq: number; name: string; startDate: string; lastDate: string | null }): string {
  return `第 ${s.seq} 階段「${s.name}」${formatMD(s.startDate)}${s.lastDate ? `–${formatMD(s.lastDate)}` : ' 起'}（按 Enter 編輯）`
}

export function handleAriaLabel(h: { seq: number; name: string; date: string } | { seq: 'yearEnd'; date: string }): string {
  const what = h.seq === 'yearEnd' ? '年度結束日' : `第 ${h.seq} 階段「${h.name}」開始日`
  return `${what} ${formatMD(h.date)}（左右鍵調整、Enter 儲存）`
}
