'use client'
import type { ReactNode } from 'react'
import { IconPencil } from '@tabler/icons-react'
import { TimelineZigzag, type TimelineStageView, type TimelineSummary } from '@/app/dashboard/_timeline/timeline-zigzag'
import { ScheduleEditor, useDialog, type StageDraft } from '@/app/dashboard/admin/timeline/timeline-forms'

/**
 * 系辦的時間軸設定（票 35；原型 `timeline-zigzag` 的 `canEdit` 版）。
 *
 * 版型用票 38 搬進來的共用元件 `dashboard/_timeline/timeline-zigzag`；這裡只把系辦的按鈕放進它的插槽：
 * 摘要列右邊「調整模擬業務鐘」「編輯階段與日期」，每張卡片展開後也有「編輯階段與日期」。
 * 原型每段各自編輯；正式碼四段一起填（Vault 02 階段模型），所以每個按鈕打開的都是同一個對話框。
 */

export type AdminStage = { seq: number; name: string; range: string; status: 'done' | 'current' | 'upcoming'; detail: string }

export type ScheduleEditorProps = {
  cohortId: string
  cohortCode: string
  revision: number
  requestId: string
  stages: StageDraft[]
  yearEndDate: string
  nameMaxLength: number
}

export function AdminTimeline({
  stages,
  summary,
  editor,
  extraActions,
  empty,
}: {
  stages: readonly AdminStage[]
  summary: TimelineSummary
  editor: ScheduleEditorProps
  extraActions?: ReactNode
  /** 還沒設階段時顯示的空狀態（共用元件沒有空狀態，這裡放在卡片下面）。 */
  empty?: ReactNode
}) {
  const dialog = useDialog()
  const views: TimelineStageView[] = stages.map((s) => ({
    id: String(s.seq),
    title: s.name,
    rangeText: s.range,
    status: s.status,
    summary: `第 ${s.seq} 階段・${s.detail}`,
    tasks: [],
  }))
  const stageActions = Object.fromEntries(
    stages.map((s) => [
      String(s.seq),
      <button
        key={s.seq}
        type="button"
        onClick={dialog.open}
        className="inline-flex h-10 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold text-ink transition-colors hover:bg-accent"
      >
        <IconPencil className="size-3.5" aria-hidden />
        <span className="sr-only">第 {s.seq} 階段：</span>編輯階段與日期
      </button>,
    ]),
  )

  return (
    <section aria-label="時間軸" className="flex flex-col gap-5">
      <TimelineZigzag
        stages={views}
        summary={summary}
        emptyTasksText="這個階段的收件與截止在專題事務設定。"
        headerActions={
          <>
            {extraActions}
            <ScheduleEditor {...editor} dialog={dialog} />
          </>
        }
        stageActions={stageActions}
      />
      {stages.length === 0 ? empty : null}
    </section>
  )
}
