'use client'
import './timeline-zigzag.css'
import Link from 'next/link'
import { useRef, useState, type ReactNode } from 'react'
import { IconArrowRight, IconCheck, IconFocus2 } from '@tabler/icons-react'

/**
 * 專題時間軸 B「直立蛇形」（原型 `components/dashboard/timeline-zigzag.tsx`，Roy 2026-09-10 從畫布挑的；票 38 搬進正式碼）。
 *
 * - 上方一條摘要：目前階段｜日期｜「時間已過 N%・剩 N 天」（講的是時間流逝，不是個人完成度）｜回到目前階段｜一顆主要按鈕。
 * - 卡片貼近中線；過去／未來只顯示名稱、日期、狀態一行，點開才看內容；只有目前階段預設展開。
 * - 目前階段用手冊書籤：卡片左上一小塊橘色頁籤寫「現在」，細線脊椎。手機（<768px）單側直線，標記在左。
 *
 * 這裡只畫畫面：階段狀態、日期字、每段的待辦都是伺服器算好傳進來的（業務時鐘、臺灣時間都在伺服器）。
 * 系辦的時間軸設定可以用 `headerActions`／`stageActions` 放自己的按鈕（原型的「新增階段」「編輯階段與日期」）。
 */

export type TimelineTask = {
  label: string
  href: string
  done: boolean
  /** 截止日（例如 `11/15`）；沒有截止就不給。 */
  dueText?: string
}

export type TimelineStageView = {
  id: string
  title: string
  rangeText: string
  status: 'done' | 'current' | 'upcoming'
  /** 階段說明（原型的 summary）；沒有就不顯示。 */
  summary?: string
  tasks: TimelineTask[]
  /** 目前階段展開後的主要按鈕（原型：第一件沒做完的事）。 */
  action?: { href: string; label: string }
}

export type TimelineSummary = {
  /** 摘要第一行的小標，原型是「目前」。 */
  label: string
  title: string
  rangeText?: string
  progressText?: string
}

const STATUS_WORD = { done: '已完成', current: '進行中', upcoming: '尚未開始' } as const

export function TimelineZigzag({
  stages,
  summary,
  primary,
  headerActions,
  stageActions,
  emptyTasksText = '這個階段沒有你要做的事。',
}: {
  stages: TimelineStageView[]
  summary: TimelineSummary
  /** 摘要列右邊的主要按鈕。 */
  primary?: { href: string; label: string } | null
  headerActions?: ReactNode
  stageActions?: Record<string, ReactNode>
  emptyTasksText?: string
}) {
  const cur = stages.find((s) => s.status === 'current')
  const [openId, setOpenId] = useState(cur?.id ?? '')
  const curRef = useRef<HTMLLIElement>(null)
  const doneCount = stages.filter((s) => s.status === 'done').length
  // 脊椎已過的長度：原型是 (已過段數 + 0.5) / 段數；全部已過就整條。
  const spinePct = stages.length === 0 ? 0 : Math.min(100, ((doneCount + (cur ? 0.5 : 0)) / stages.length) * 100)

  return (
    <div className="tl-wrap dash-card relative overflow-hidden">
      {/* 摘要一條：目前階段｜日期｜主要按鈕 */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-border px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold tracking-[0.06em] text-brand">{summary.label}</p>
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-[20px] font-extrabold tracking-tight" data-testid="timeline-current">
              {summary.title}
            </span>
            {summary.rangeText ? <span className="tabular text-sm text-muted-foreground">{summary.rangeText}</span> : null}
            {summary.progressText ? <span className="tabular text-sm text-muted-foreground">{summary.progressText}</span> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {cur ? (
            <button
              type="button"
              onClick={() => curRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
              className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-border px-3.5 text-sm font-semibold transition-colors hover:bg-accent"
            >
              <IconFocus2 className="size-4" /> 回到目前階段
            </button>
          ) : null}
          {primary ? (
            <Link href={primary.href} className="btn-fju h-11 rounded-lg px-5 text-sm">
              {primary.label}
              <IconArrowRight className="size-4" />
            </Link>
          ) : null}
          {headerActions}
        </div>
      </div>

      <div className="relative px-4 py-6 sm:px-6 md:py-8">
        <div className="tl-spine" aria-hidden>
          <svg viewBox="0 0 2 100" preserveAspectRatio="none">
            <rect x="0" y="0" width="2" height={spinePct} fill="var(--ink)" />
          </svg>
        </div>
        <ol className="flex flex-col gap-4 md:gap-5" aria-label="本屆階段">
          {stages.map((s, i) => {
            const isCur = s.status === 'current'
            const open = s.id === openId
            return (
              <li
                key={s.id}
                ref={isCur ? curRef : undefined}
                className={`tl-row ${i % 2 === 0 ? 'tl-left' : 'tl-right'}`}
                data-status={s.status}
                aria-current={isCur ? 'step' : undefined}
              >
                <div className="tl-connector" aria-hidden />
                <div className="tl-dot" aria-hidden>
                  {s.status === 'done' ? <IconCheck className="size-3" strokeWidth={3} /> : null}
                </div>
                <article className={`tl-card ${open ? 'tl-open' : ''}`}>
                  {isCur ? (
                    <span className="tl-tab" aria-hidden>
                      現在
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? '' : s.id)}
                    aria-expanded={open}
                    className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[16px] font-extrabold tracking-tight">{s.title}</span>
                        <span className="tabular text-xs text-muted-foreground">{s.rangeText}</span>
                      </span>
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        isCur
                          ? 'bg-brand text-brand-foreground'
                          : s.status === 'done'
                            ? 'bg-success-subtle text-success-on-subtle'
                            : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {STATUS_WORD[s.status]}
                    </span>
                  </button>
                  <div className="tl-body" data-open={open}>
                    {/* 收起來的內容不進 Tab 順序（inert）；展開有 180ms 過渡。 */}
                    <div className="min-h-0 overflow-hidden" inert={!open}>
                      <div className="border-t border-border/70 px-4 pt-3 pb-4">
                        {s.summary ? <p className="text-sm leading-relaxed">{s.summary}</p> : null}
                        {s.tasks.length ? (
                          <ul className={`${s.summary ? 'mt-3 ' : ''}flex flex-col gap-1.5`}>
                            {s.tasks.map((t) => (
                              <li key={t.href} className="flex items-center gap-2.5 text-sm">
                                <span
                                  className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full ${
                                    t.done ? 'bg-success text-success-foreground' : 'border-2 border-border'
                                  }`}
                                >
                                  {t.done ? <IconCheck className="size-2.5" strokeWidth={3} /> : null}
                                </span>
                                <Link
                                  href={t.href}
                                  className={`min-w-0 flex-1 truncate hover:underline ${
                                    t.done ? 'text-muted-foreground line-through decoration-border' : 'font-medium'
                                  }`}
                                >
                                  {t.label}
                                </Link>
                                {t.dueText ? <span className="tabular shrink-0 text-xs text-muted-foreground">{t.dueText}</span> : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className={`${s.summary ? 'mt-2 ' : ''}text-xs text-muted-foreground`}>{emptyTasksText}</p>
                        )}
                        {(isCur && s.action) || stageActions?.[s.id] ? (
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            {isCur && s.action ? (
                              <Link href={s.action.href} className="btn-fju h-10 rounded-lg px-4 text-sm">
                                {s.action.label}
                              </Link>
                            ) : null}
                            {stageActions?.[s.id]}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </article>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
