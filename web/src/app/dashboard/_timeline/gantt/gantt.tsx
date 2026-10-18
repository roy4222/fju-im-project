'use client'
import './gantt.css'
import dynamic from 'next/dynamic'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { mediaQueryStore } from '@/app/_ui/fx/media-query'
import { cn } from '@/shared/cn'
import {
  DAY_PX,
  DRAG_THRESHOLD_PX,
  LONG_PRESS_MS,
  ZOOM_STORAGE_KEY,
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
  rangeText,
  scheduleInput,
  stageAriaLabel,
  stageLastDates,
  weekTicks,
  wheelZoom,
  xOfDate,
  type DateSpan,
  type DragMode,
  type GanttActivity,
  type GanttProps,
  type ScheduleInput,
  type ZoomLevel,
} from './gantt-model'

export type { GanttActivity, GanttDeadline, GanttEditor, GanttProps, GanttStage } from './gantt-model'

/**
 * 專題時程甘特（規格③《設計方案》§9.3；C3-03）。系辦頁（`mode='edit'`）與前台（`mode='view'`）共用。
 *
 * 呼叫端一律 `next/dynamic(() => import('./gantt'), { ssr: false })`：橫條位置、寬度、今天線都靠 CSSOM 設
 * （`el.style.setProperty`，見 `cssVars`），不輸出 `style=` 屬性（CSP 沒有 `unsafe-inline`）。
 *
 * 這支只管畫與事件：日期換算、夾限、車道、鍵盤位移、句子都在 `gantt-model.ts`；寫入全部走 `editor`
 * （server action 的包裝），不 import 任何 server 模組。視窗與右鍵選單在 `gantt-dialogs.tsx`，只有 edit 模式才載。
 * 介面、`data-testid` 與互動對照表見同目錄 `README.md`。
 */

const GanttContextMenu = dynamic(() => import('./gantt-dialogs').then((m) => m.GanttContextMenu), { ssr: false })
const DeleteConfirmDialog = dynamic(() => import('./gantt-dialogs').then((m) => m.DeleteConfirmDialog), { ssr: false })

/** 手機或觸控：退回「點一下編輯」，橫條不可拖、沒有把手（§9.3）。 */
const COARSE_QUERY = '(pointer: coarse), (max-width: 767px)'
const coarseStore = mediaQueryStore(COARSE_QUERY, () => (typeof window === 'undefined' ? undefined : window))

/** 把 CSS 變數寫進元素（CSSOM，不產生 `style=` 屬性）。 */
function cssVars(vars: Record<string, string | number>) {
  return (el: HTMLElement | null) => {
    if (!el) return
    for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, String(value))
  }
}

const px = (n: number) => `${n}px`
const spanOf = (a: DateSpan): DateSpan => ({ startDate: a.startDate, endDate: a.endDate })
const sameSpan = (a: DateSpan, b: DateSpan) => a.startDate === b.startDate && a.endDate === b.endDate

type StageKey = number | 'yearEnd'

type Preview =
  | { kind: 'activity'; id: string; span: DateSpan }
  | { kind: 'stage'; key: StageKey; date: string }

/** 指標按下後的追蹤：超過門檻才算拖；長按開選單。 */
type Press = {
  pointerId: number
  x0: number
  y0: number
  dragging: boolean
  longPressed: boolean
  timer: number | undefined
} & ({ kind: 'activity'; activity: GanttActivity; mode: DragMode } | { kind: 'stage'; key: StageKey; origin: string })

type Menu = { activity: GanttActivity; x: number; y: number; el: HTMLElement }

function readZoom(): ZoomLevel {
  try {
    return parseZoom(typeof window === 'undefined' ? null : window.localStorage.getItem(ZOOM_STORAGE_KEY))
  } catch {
    return 'month'
  }
}

export function Gantt({ stages, yearEndDate, activities, deadlines, today, mode, editor }: GanttProps) {
  const coarse = useSyncExternalStore(coarseStore.subscribe, coarseStore.getSnapshot, coarseStore.getServerSnapshot)
  const editable = mode === 'edit' && editor !== undefined
  const draggable = editable && !coarse

  const [zoom, setZoom] = useState<ZoomLevel>(readZoom)
  const [finePx, setFinePx] = useState<number | null>(null)
  const dayPx = finePx ?? DAY_PX[zoom]

  // 樂觀更新：存成功後停在新位置，等伺服器回新資料（revision 變了／階段日期變了）就自動作廢。
  const [moved, setMoved] = useState<Record<string, { revision: number; span: DateSpan }>>({})
  const scheduleSig = JSON.stringify([stages.map((s) => s.startDate), yearEndDate])
  const [scheduled, setScheduled] = useState<{ sig: string; input: ScheduleInput } | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [status, setStatus] = useState('')
  const [alert, setAlert] = useState('')
  const [live, setLive] = useState('')
  const [menu, setMenu] = useState<Menu | null>(null)
  const [deleting, setDeleting] = useState<GanttActivity | null>(null)

  const scroller = useRef<HTMLDivElement>(null)
  const press = useRef<Press | null>(null)
  const suppressClick = useRef(false)
  const liveTimer = useRef<number | undefined>(undefined)
  const anchor = useRef<{ day: number; offset: number } | null>(null)
  /** 鍵盤調整中的值。用 ref：keydown 與 keyup 可能在同一次重畫前連著發生。 */
  const keyPending = useRef<{ id: string; span: DateSpan } | { key: StageKey; date: string } | null>(null)
  const dayPxRef = useRef(dayPx)
  dayPxRef.current = dayPx

  // ── 畫面上的資料（伺服器資料 ＋ 樂觀更新 ＋ 拖拉預覽） ──

  const savedSchedule = scheduled && scheduled.sig === scheduleSig ? scheduled.input : null
  const baseStarts = stages.map((s) => ({
    seq: s.seq,
    startDate: savedSchedule?.stages.find((x) => x.seq === s.seq)?.startDate ?? s.startDate,
  }))
  const baseYearEnd = savedSchedule ? savedSchedule.yearEndDate || null : yearEndDate
  const starts = baseStarts.map((s) =>
    preview?.kind === 'stage' && preview.key === s.seq ? { ...s, startDate: preview.date } : s,
  )
  const yearEnd = preview?.kind === 'stage' && preview.key === 'yearEnd' ? preview.date : baseYearEnd
  const lastDates = stageLastDates(starts, yearEnd)

  // `current`：伺服器資料＋已存的樂觀位置（拖拉與鍵盤都從這裡起算）；`shown`：再套上拖拉中的預覽。
  const current = activities.map((a) => {
    const saved = moved[a.id]
    return saved && saved.revision === a.revision ? { ...a, ...saved.span } : a
  })
  const shown = current.map((a) =>
    preview?.kind === 'activity' && preview.id === a.id ? { ...a, ...preview.span } : a,
  )
  // 名字放不進橫條的（短活動、月檢視）改畫在橫條右邊；車道配置把那段寬度算進去。
  const barDays = (a: DateSpan) => diffDays(a.startDate, a.endDate) + 1
  const narrow = (a: GanttActivity) => barDays(a) * dayPx < labelWidthPx(a.title)
  const layout = layoutActivities(shown, starts, (a) =>
    narrow(a) ? barDays(a) + Math.ceil(labelWidthPx(a.title) / dayPx) : barDays(a),
  )
  // 範圍只看伺服器資料：拖拉中不換原點，橫條才不會跳。
  const range = chartRange({ stages, yearEndDate, activities, deadlines, today })
  const width = range.days * dayPx
  const x = (date: string) => xOfDate(date, range.startDate, dayPx)

  // ── 捲動與縮放 ──

  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = initialScrollLeft(today, range.startDate, dayPxRef.current)
    // 只在第一次畫時捲到今天前兩週。
  }, [])

  useLayoutEffect(() => {
    const el = scroller.current
    const a = anchor.current
    if (!el || !a) return
    el.scrollLeft = a.day * dayPx - a.offset
    anchor.current = null
  }, [dayPx])

  /** 換縮放時讓 `offset`（離軌道左緣幾 px）那一點的日期不動。 */
  const keepAnchor = (offset: number) => {
    const el = scroller.current
    if (!el) return
    anchor.current = { day: (el.scrollLeft + offset) / dayPxRef.current, offset }
  }

  const labelWidth = () => scroller.current?.querySelector<HTMLElement>('.gantt-label')?.offsetWidth ?? 0

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    // Ctrl+滾輪微調：要 `passive:false` 才能擋掉瀏覽器自己的整頁縮放。
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      keepAnchor(Math.max(0, e.clientX - el.getBoundingClientRect().left - labelWidth()))
      setFinePx(wheelZoom(dayPxRef.current, e.deltaY))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const chooseZoom = (level: ZoomLevel) => {
    const el = scroller.current
    if (el) keepAnchor(Math.max(0, (el.clientWidth - labelWidth()) / 2))
    setZoom(level)
    setFinePx(null)
    try {
      window.localStorage.setItem(ZOOM_STORAGE_KEY, level)
    } catch {
      // 無痕模式或停用 storage：只是下次不記得，不影響操作。
    }
  }

  // edit 模式先在背景載選單與刪除確認，第一次右鍵不用等。
  useEffect(() => {
    if (editable) void import('./gantt-dialogs')
  }, [editable])

  // ── 共用 ──

  /** 拖拉中的日期給螢幕報讀：停下 400ms 才讀一次，不會每一格都念。 */
  const announce = (text: string) => {
    window.clearTimeout(liveTimer.current)
    liveTimer.current = window.setTimeout(() => setLive(text), 400)
  }

  const feedback = (ok: string, error: string) => {
    setStatus(ok)
    setAlert(error)
  }

  const openMenu = (activity: GanttActivity, el: HTMLElement, at?: { x: number; y: number }) => {
    const rect = el.getBoundingClientRect()
    setMenu({ activity, el, x: at?.x ?? rect.left, y: at?.y ?? rect.bottom + 4 })
  }

  // ── 活動：拖拉、鍵盤、點擊 ──

  const commitActivity = async (a: GanttActivity, next: DateSpan) => {
    if (!editor || sameSpan(a, next)) return
    // 單日、沒寫結束時間的活動被拉成跨日：不送出，改開編輯視窗補結束時間（AC-C3-48）。
    if (needsEndTimePrompt(a, next)) {
      feedback('', '')
      editor.openEdit(a.id, next)
      return
    }
    const before = moved[a.id]
    setMoved((m) => ({ ...m, [a.id]: { revision: a.revision, span: next } }))
    feedback('', '')
    const result = await editor.moveActivity(a.id, a.revision, next.startDate, next.endDate)
    if (result.ok) {
      feedback(movedMessage(a.title, next), '')
      return
    }
    // 回彈到這次拖之前的位置。
    setMoved((m) => {
      const rest = { ...m }
      if (before) rest[a.id] = before
      else delete rest[a.id]
      return rest
    })
    feedback('', result.message)
  }

  const onBarPointerDown = (e: PointerEvent<HTMLElement>, a: GanttActivity) => {
    suppressClick.current = false
    if (!editable || e.button !== 0) return
    const edge = (e.target as HTMLElement).dataset.edge
    const p: Press = {
      kind: 'activity',
      activity: a,
      mode: edge === 'start' || edge === 'end' ? edge : 'move',
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      dragging: false,
      longPressed: false,
      timer: undefined,
    }
    const el = e.currentTarget
    p.timer = window.setTimeout(() => {
      p.longPressed = true
      suppressClick.current = true
      openMenu(a, el, { x: p.x0, y: p.y0 })
    }, LONG_PRESS_MS)
    press.current = p
    if (draggable) el.setPointerCapture(e.pointerId)
  }

  const onPressMove = (e: PointerEvent<HTMLElement>) => {
    const p = press.current
    if (!p || p.pointerId !== e.pointerId || p.longPressed) return
    const dx = e.clientX - p.x0
    if (!p.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(e.clientY - p.y0) < DRAG_THRESHOLD_PX) return
      window.clearTimeout(p.timer)
      if (!draggable) {
        press.current = null // 手機上是捲動，不是拖
        return
      }
      p.dragging = true
    }
    const days = dayDelta(dx, dayPx)
    if (p.kind === 'activity') {
      const span = moveActivityDates(p.activity, p.mode, days)
      setPreview({ kind: 'activity', id: p.activity.id, span })
      announce(rangeText(span.startDate, span.endDate))
    } else {
      const date = clampHandle(p.key, addDays(p.origin, days))
      setPreview({ kind: 'stage', key: p.key, date })
      announce(formatMD(date))
    }
  }

  const onPressEnd = (e: PointerEvent<HTMLElement>) => {
    const p = press.current
    if (!p || p.pointerId !== e.pointerId) return
    window.clearTimeout(p.timer)
    press.current = null
    if (!p.dragging) return
    suppressClick.current = true
    setPreview(null)
    const days = dayDelta(e.clientX - p.x0, dayPx)
    if (p.kind === 'activity') void commitActivity(p.activity, moveActivityDates(p.activity, p.mode, days))
    else void commitStage(p.key, clampHandle(p.key, addDays(p.origin, days)))
  }

  const onPressCancel = () => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
    setPreview(null)
  }

  const onBarClick = (a: GanttActivity) => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    editor?.openEdit(a.id)
  }

  const onBarKeyDown = (e: KeyboardEvent<HTMLElement>, a: GanttActivity) => {
    if (!editor) return
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault()
      openMenu(a, e.currentTarget)
      return
    }
    if (e.key === 'Delete') {
      e.preventDefault()
      setDeleting(a)
      return
    }
    const step = draggable ? activityKeyMove(e) : null
    if (!step) return
    e.preventDefault() // 也擋掉 Alt+← 的「上一頁」
    const pending = keyPending.current
    const from = pending && 'id' in pending && pending.id === a.id ? pending.span : spanOf(a)
    const span = moveActivityDates(from, step.mode, step.days)
    keyPending.current = { id: a.id, span }
    setPreview({ kind: 'activity', id: a.id, span })
    announce(rangeText(span.startDate, span.endDate))
  }

  /** 放開方向鍵就存（一次放開一次 status）。 */
  const onBarKeyUp = (e: KeyboardEvent<HTMLElement>, a: GanttActivity) => {
    const pending = keyPending.current
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !pending || !('id' in pending) || pending.id !== a.id) return
    keyPending.current = null
    setPreview(null)
    void commitActivity(a, pending.span)
  }

  // ── 階段分界與年度結束日 ──

  function clampHandle(key: StageKey, date: string): string {
    return key === 'yearEnd' ? clampYearEnd(baseStarts, date) : clampStageStart(baseStarts, baseYearEnd, key, date)
  }

  const handleDate = (key: StageKey) =>
    key === 'yearEnd' ? (baseYearEnd ?? range.endDate) : (baseStarts.find((s) => s.seq === key)?.startDate ?? range.startDate)

  async function commitStage(key: StageKey, date: string) {
    if (!editor || date === handleDate(key)) return
    const input = scheduleInput(
      baseStarts,
      baseYearEnd,
      editor.cohortRevision,
      key === 'yearEnd' ? { yearEndDate: date } : { seq: key, startDate: date },
    )
    const before = scheduled
    setScheduled({ sig: scheduleSig, input })
    feedback('', '')
    const result = await editor.saveSchedule(input)
    if (result.ok) {
      feedback(result.message ?? '已儲存階段日期。', '')
      return
    }
    setScheduled(before) // 回彈到這次拖之前的位置
    // 確認框按「取消」：只回彈，不顯示錯誤。
    if ('cancelled' in result) return
    feedback('', result.message)
  }

  const onHandlePointerDown = (e: PointerEvent<HTMLElement>, key: StageKey) => {
    if (e.button !== 0) return
    press.current = {
      kind: 'stage',
      key,
      origin: handleDate(key),
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      dragging: false,
      longPressed: false,
      timer: undefined,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onHandleKeyDown = (e: KeyboardEvent<HTMLElement>, key: StageKey) => {
    const held = keyPending.current
    const pending = held && 'key' in held && held.key === key ? held.date : null
    if (e.key === 'Enter') {
      e.preventDefault()
      keyPending.current = null
      setPreview(null)
      if (pending) void commitStage(key, pending)
      return
    }
    if (e.key === 'Escape') {
      keyPending.current = null
      setPreview(null)
      return
    }
    const step = handleKeyStep(e)
    if (!step) return
    e.preventDefault()
    const date = clampHandle(key, addDays(pending ?? handleDate(key), step))
    keyPending.current = { key, date }
    setPreview({ kind: 'stage', key, date })
    announce(formatMD(date))
  }

  // ── 新增：點列的空白處 ──

  const onTrackClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!editor || e.target !== e.currentTarget) return
    const date = dateAtX(e.clientX - e.currentTarget.getBoundingClientRect().left, range.startDate, dayPx, range.days)
    editor.openCreate({ startDate: date, endDate: date })
  }

  // ── 畫 ──

  const rows = starts.length
    ? starts.map((s, i) => ({ key: `stage-${s.seq}`, label: `第 ${s.seq} 段`, name: stages[i]?.name ?? '' }))
    : [{ key: 'all', label: '活動', name: '' }]
  const months = monthTicks(range, dayPx)
  const weeks = dayPx >= DAY_PX.week * 0.75 ? weekTicks(range, dayPx) : []
  const todayInRange = today >= range.startDate && today <= range.endDate
  const handles: { key: StageKey; date: string; at: string; label: string }[] = draggable
    ? [
        ...starts.slice(1).map((s, i) => ({
          key: s.seq as StageKey,
          date: s.startDate,
          at: s.startDate,
          label: handleAriaLabel({ seq: s.seq, name: stages[i + 1]?.name ?? '', date: s.startDate }),
        })),
        ...(yearEnd
          ? [{ key: 'yearEnd' as const, date: yearEnd, at: addDays(yearEnd, 1), label: handleAriaLabel({ seq: 'yearEnd', date: yearEnd }) }]
          : []),
      ]
    : []

  const pressHandlers = { onPointerMove: onPressMove, onPointerUp: onPressEnd, onPointerCancel: onPressCancel }

  return (
    <div data-testid="gantt" data-mode={mode} className="gantt" ref={cssVars({ '--gantt-day': px(dayPx), '--gantt-w': px(width) })}>
      <div className="gantt-toolbar">
        <div role="group" aria-label="縮放" data-testid="gantt-zoom" className="gantt-zoom">
          {(['week', 'month'] as const).map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={finePx === null && zoom === level}
              onClick={() => chooseZoom(level)}
              className="gantt-zoom-btn pointer-coarse:size-11"
            >
              {level === 'week' ? '週' : '月'}
            </button>
          ))}
        </div>
        {editable ? (
          <p className="gantt-hint">
            {draggable
              ? '拖橫條改日期，點空白處新增；右鍵或 Shift+F10 開選單。Ctrl+滾輪縮放。'
              : '點橫條編輯，點空白處新增；長按橫條開選單。'}
          </p>
        ) : null}
      </div>

      {status ? (
        <p role="status" className="gantt-status">
          {status}
        </p>
      ) : null}
      {alert ? (
        <p role="alert" className="gantt-alert">
          {alert}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {live}
      </p>

      <div ref={scroller} className="gantt-scroll" tabIndex={0} aria-label="專題時程（可左右捲動）">
        <div className="gantt-rows">
          <div className="gantt-row gantt-row-head">
            <div className="gantt-label">月份</div>
            <div className="gantt-track gantt-months" aria-hidden="true">
              {months.map((m) => (
                <span key={m.date} className="gantt-month" ref={cssVars({ '--x': px(m.x), '--w': px(m.width) })}>
                  {m.label}
                </span>
              ))}
              {weeks.map((w) => (
                <span key={w.date} className="gantt-week" ref={cssVars({ '--x': px(w.x) })}>
                  {w.label}
                </span>
              ))}
            </div>
          </div>

          <div className="gantt-row">
            <div className="gantt-label">階段</div>
            <div className="gantt-track gantt-stages">
              {starts.map((s, i) => {
                const last = lastDates[i] ?? null
                const end = last ?? range.endDate
                const vars = cssVars({ '--x': px(x(s.startDate)), '--w': px((diffDays(s.startDate, end) + 1) * dayPx) })
                const name = stages[i]?.name ?? ''
                const label = stageAriaLabel({ seq: s.seq, name, startDate: s.startDate, lastDate: last })
                const body = (
                  <>
                    <span className="gantt-stage-seq">{s.seq}</span>
                    <span className="gantt-stage-name">{name}</span>
                  </>
                )
                return editable ? (
                  <button
                    key={s.seq}
                    type="button"
                    data-testid="gantt-stage"
                    data-seq={s.seq}
                    aria-label={label}
                    className="gantt-stage"
                    ref={vars}
                    onClick={() => editor?.openStage(s.seq)}
                  >
                    {body}
                  </button>
                ) : (
                  <span key={s.seq} data-testid="gantt-stage" data-seq={s.seq} title={label} className="gantt-stage" ref={vars}>
                    {body}
                  </span>
                )
              })}
              {handles.map((h) => (
                <button
                  key={String(h.key)}
                  type="button"
                  data-testid="gantt-handle"
                  data-kind={h.key === 'yearEnd' ? 'year-end' : 'stage'}
                  data-seq={h.key === 'yearEnd' ? undefined : h.key}
                  aria-label={h.label}
                  className={cn('gantt-handle', preview?.kind === 'stage' && preview.key === h.key && 'is-dragging')}
                  ref={cssVars({ '--x': px(x(h.at)) })}
                  onPointerDown={(e) => onHandlePointerDown(e, h.key)}
                  {...pressHandlers}
                  onKeyDown={(e) => onHandleKeyDown(e, h.key)}
                  onBlur={() => {
                    // 沒按 Enter 就離開：放棄這次調整。
                    if (keyPending.current && 'key' in keyPending.current) keyPending.current = null
                    if (preview?.kind === 'stage' && preview.key === h.key) setPreview(null)
                  }}
                >
                  {preview?.kind === 'stage' && preview.key === h.key ? (
                    <span className="gantt-chip" aria-hidden="true">
                      {formatMD(h.date)}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          {rows.map((row, rowIndex) => {
            const bars = shown.filter((a) => layout.place.get(a.id)?.row === rowIndex)
            return (
              <div key={row.key} className="gantt-row">
                <div className="gantt-label">
                  <span className="gantt-label-seq">{row.label}</span>
                  <span className="gantt-label-name">{row.name}</span>
                </div>
                <div
                  className={cn('gantt-track gantt-lane-track min-h-11', editable && 'is-creatable')}
                  ref={cssVars({ '--lanes': layout.laneCounts[rowIndex] ?? 1 })}
                  onClick={editable ? onTrackClick : undefined}
                >
                  {bars.map((a) => {
                    const base = current.find((c) => c.id === a.id) ?? a
                    const lane = layout.place.get(a.id)?.lane ?? 0
                    const dragging = preview?.kind === 'activity' && preview.id === a.id
                    const vars = cssVars({
                      '--x': px(x(a.startDate)),
                      '--w': px(barDays(a) * dayPx),
                      '--lane': lane,
                    })
                    const text = (
                      <span className="gantt-bar-text">
                        {a.title}
                        {a.timeText ? <span className="gantt-bar-time"> {a.timeText}</span> : null}
                      </span>
                    )
                    if (!editable) {
                      return (
                        <a
                          key={a.id}
                          href={`#activity-${a.id}`}
                          data-testid="gantt-bar"
                          aria-label={activityAriaLabel(a)}
                          title={a.title}
                          className={cn('gantt-bar', narrow(a) && 'is-narrow')}
                          ref={vars}
                        >
                          {text}
                        </a>
                      )
                    }
                    return (
                      <button
                        key={a.id}
                        type="button"
                        data-testid="gantt-bar"
                        data-id={a.id}
                        aria-label={activityAriaLabel(a)}
                        aria-disabled={coarse || undefined}
                        title={a.title}
                        className={cn('gantt-bar', narrow(a) && 'is-narrow', draggable && 'is-draggable', dragging && 'is-dragging')}
                        ref={vars}
                        onPointerDown={(e) => onBarPointerDown(e, base)}
                        {...pressHandlers}
                        onClick={() => onBarClick(base)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          openMenu(base, e.currentTarget, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : undefined)
                        }}
                        onKeyDown={(e) => onBarKeyDown(e, base)}
                        onKeyUp={(e) => onBarKeyUp(e, base)}
                      >
                        {draggable ? <span data-edge="start" data-testid="gantt-handle" data-kind="activity-start" className="gantt-bar-edge is-start" aria-hidden="true" /> : null}
                        {text}
                        {draggable ? <span data-edge="end" data-testid="gantt-handle" data-kind="activity-end" className="gantt-bar-edge is-end" aria-hidden="true" /> : null}
                        {dragging ? (
                          <span className="gantt-chip" aria-hidden="true">
                            {rangeText(a.startDate, a.endDate)}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          <div className="gantt-row">
            <div className="gantt-label">學生截止</div>
            <div className="gantt-track gantt-deadlines">
              {deadlines.map((d) => {
                const vars = cssVars({ '--x': px(x(d.date) + dayPx / 2) })
                const label = `作業截止：${d.title}，${formatMD(d.date)}`
                return d.href ? (
                  <a key={d.id} href={d.href} data-testid="gantt-deadline" aria-label={label} title={label} className="gantt-deadline" ref={vars} />
                ) : (
                  <span key={d.id} role="img" tabIndex={0} data-testid="gantt-deadline" aria-label={label} title={label} className="gantt-deadline" ref={vars} />
                )
              })}
            </div>
          </div>

          {todayInRange ? (
            <span
              data-testid="gantt-today"
              role="img"
              aria-label={`今天 ${formatMD(today)}`}
              className="gantt-today"
              ref={cssVars({ '--x': px(x(today) + dayPx / 2) })}
            />
          ) : null}
        </div>
      </div>

      {menu ? (
        <GanttContextMenu
          x={menu.x}
          y={menu.y}
          label={`${menu.activity.title} 的選單`}
          returnFocus={menu.el}
          onClose={() => setMenu(null)}
          onEdit={() => editor?.openEdit(menu.activity.id)}
          onDelete={() => setDeleting(menu.activity)}
        />
      ) : null}
      {editor && deleting ? (
        <DeleteConfirmDialog
          open
          title={deleting.title}
          onConfirm={() => editor.remove(deleting.id, deleting.revision)}
          onClose={() => setDeleting(null)}
          onDeleted={() => feedback(`已刪除活動「${deleting.title}」`, '')}
        />
      ) : null}
    </div>
  )
}

export default Gantt
