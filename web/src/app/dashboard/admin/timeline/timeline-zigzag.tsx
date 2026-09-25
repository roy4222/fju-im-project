'use client'
import { useRef, useState, type ReactNode } from 'react'
import { IconCheck, IconFocus2, IconPencil } from '@tabler/icons-react'
import { BTN_OUTLINE } from '@/app/_ui/dashboard-kit'
import { ScheduleEditor, useDialog, type StageDraft } from '@/app/dashboard/admin/timeline/timeline-forms'
import { cn } from '@/shared/cn'

/**
 * 時間軸設定的「直立蛇形」（票 35；原型 `components/dashboard/timeline-zigzag.tsx`）。
 *
 * 上方摘要一條（目前階段｜日期｜時間已過多少｜按鈕），下面各階段左右交錯貼著中線；
 * 手機（<768px）改成單側直線。只有目前階段預設展開。這裡只管畫與展開收合，
 * 階段是哪一段、日期怎麼算都由伺服器頁面算好傳進來（業務鐘、`stagePositionAt`）。
 *
 * 「編輯階段與日期」跟原型一樣在摘要列與每張卡片裡都有，打開的是同一個對話框（四段一起填，見票 11）。
 */

export type ZigzagStage = {
  seq: number
  name: string
  /** 已排好的日期範圍，例如 `2026/09/15 – 2026/10/31`。 */
  range: string
  status: 'done' | 'current' | 'upcoming'
  /** 展開後的一句說明（第幾天、剩幾天）。 */
  detail: string
}

export type ZigzagSummary = {
  eyebrow: string
  title: string
  range?: string
  progress?: string
  meta: string
}

export type ScheduleEditorProps = {
  cohortId: string
  cohortCode: string
  revision: number
  requestId: string
  stages: StageDraft[]
  yearEndDate: string
  nameMaxLength: number
}

const STATUS_WORD = { done: '已完成', current: '進行中', upcoming: '尚未開始' } as const

export function TimelineZigzag({
  stages,
  summary,
  editor,
  extraActions,
  empty,
}: {
  stages: readonly ZigzagStage[]
  summary: ZigzagSummary
  editor: ScheduleEditorProps
  extraActions?: ReactNode
  /** 還沒設階段時，卡片下半部顯示的空狀態。 */
  empty?: ReactNode
}) {
  const current = stages.find((s) => s.status === 'current')
  const [openSeq, setOpenSeq] = useState<number | null>(current?.seq ?? stages[0]?.seq ?? null)
  const currentRef = useRef<HTMLLIElement>(null)
  const dialog = useDialog()
  const done = stages.filter((s) => s.status === 'done').length
  const spinePct = stages.length === 0 ? 0 : Math.min(100, ((done + (current ? 0.5 : 0)) / stages.length) * 100)

  return (
    <div className="tl-wrap dash-card relative overflow-hidden">
      {/* 摘要一條：目前階段｜日期｜主要按鈕 */}
      <section aria-label="目前階段" className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-border px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold tracking-[0.06em] text-primary">{summary.eyebrow}</p>
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-[20px] font-extrabold tracking-tight">{summary.title}</span>
            {summary.range ? <span className="text-sm text-muted-foreground tabular-nums">{summary.range}</span> : null}
            {summary.progress ? <span className="text-sm text-muted-foreground tabular-nums">{summary.progress}</span> : null}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{summary.meta}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {current ? (
            <button
              type="button"
              onClick={() => currentRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
              className={cn(BTN_OUTLINE, 'h-11 px-3.5')}
            >
              <IconFocus2 aria-hidden /> 回到目前階段
            </button>
          ) : null}
          {extraActions}
          <ScheduleEditor {...editor} dialog={dialog} />
        </div>
      </section>

      {stages.length === 0 ? (
        <div className="px-5 py-6 sm:px-6">{empty}</div>
      ) : (
        <div className="relative px-4 py-6 sm:px-6 md:py-8">
          <svg className="tl-spine" viewBox="0 0 2 100" preserveAspectRatio="none" aria-hidden>
            <rect width="2" height={spinePct} className="fill-primary" />
          </svg>
          <ol aria-label="階段" className="flex flex-col gap-4 md:gap-5">
            {stages.map((s, i) => {
              const left = i % 2 === 0
              const isCurrent = s.status === 'current'
              const open = s.seq === openSeq
              return (
                <li
                  key={s.seq}
                  ref={isCurrent ? currentRef : undefined}
                  className={`tl-row ${left ? 'tl-left' : 'tl-right'}`}
                  data-status={s.status}
                  data-testid="timeline-stage"
                >
                  <div className="tl-connector" aria-hidden />
                  <div className="tl-dot" aria-hidden>
                    {s.status === 'done' ? <IconCheck className="size-3" strokeWidth={3} /> : null}
                  </div>
                  <article className="tl-card">
                    {isCurrent ? (
                      <span className="tl-tab" aria-hidden>
                        現在
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setOpenSeq(open ? null : s.seq)}
                      aria-expanded={open}
                      className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[16px] font-extrabold tracking-tight">
                            <span className="sr-only">第 {s.seq} 階段：</span>
                            {s.name}
                          </span>
                          <span className="text-xs text-muted-foreground tabular-nums">{s.range}</span>
                        </span>
                      </span>
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold',
                          isCurrent
                            ? 'bg-primary text-primary-foreground'
                            : s.status === 'done'
                              ? 'bg-success-subtle text-success-on-subtle'
                              : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {STATUS_WORD[s.status]}
                      </span>
                    </button>
                    <div className="tl-body" data-open={open}>
                      {/* 收合時整段 inert：看不到的按鈕不能被 Tab 到、也不在無障礙樹裡。 */}
                      <div className="min-h-0 overflow-hidden" inert={!open}>
                        <div className="border-t border-border/70 px-4 pt-3 pb-4">
                          <p className="text-sm leading-relaxed">
                            第 {s.seq} 階段・{s.detail}
                          </p>
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={dialog.open}
                              className="inline-flex h-10 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold text-primary transition-colors hover:bg-accent"
                            >
                              <IconPencil className="size-3.5" aria-hidden />
                              <span className="sr-only">第 {s.seq} 階段：</span>編輯階段與日期
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </article>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </div>
  )
}
