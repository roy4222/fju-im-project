'use client'
import dynamic from 'next/dynamic'
import { useCallback, useMemo, useRef, useState } from 'react'
import { deleteActivityAction, moveActivityAction, previewScheduleAction, saveStageDatesAction } from './actions'
import {
  ActivityForm,
  CREATE_ACTIVITY_DESCRIPTION,
  EDIT_ACTIVITY_DESCRIPTION,
  Feedback,
  newActivityDraft,
  StageEditDialog,
  type ActivityDraft,
  type ActivityLimits,
  type StageEditorProps,
  type TimelineActionState,
} from './timeline-forms'
import type { ActionResult, GanttEditor, GanttProps } from '@/app/dashboard/_timeline/gantt/gantt-model'

/**
 * 系辦時程頁的甘特掛載點（③ §9.3、§9.4；C3-08）：把 server action 接成 `GanttProps.editor`。
 *
 * - 甘特本體 `next/dynamic` `ssr:false`：位置寬度都靠瀏覽器端 CSSOM，SSR 不能輸出 `style=`（CSP）；SSR 與載入前是同高度骨架。
 * - `openCreate`／`openEdit` → 活動視窗（`gantt-dialogs` 的 `ActivityDialog` 殼＋`ActivityForm`）；點空白處預填那天、全天；
 *   沒結束時間的活動被拉成跨日時帶拖後起訖（AC-C3-48），結束時間欄跟著標必填。
 * - `openStage` → `StageEditDialog`（名稱、說明、開始日、第 4 段年度結束日；整組送出）。
 * - `saveSchedule`（拖階段分界／年度結束日放開，C3-13）：先 `previewScheduleAction`（不寫入，回確認框的句子與「有 N 個整組作業」）
 *   → `StageConfirmDialog` →「確定」才 `saveStageDatesAction`；「取消」／Esc resolve `{ ok:false, cancelled:true }`（gantt 只回彈）。
 *   儲存失敗關掉確認框、把錯誤句交回 gantt（回彈＋`role="alert"`）。
 * - `moveActivity`、`remove` 直通 action；成功後 action 自己 `refresh()`，甘特等新資料進來再換掉樂觀位置。
 */

const Gantt = dynamic(() => import('@/app/dashboard/_timeline/gantt/gantt'), {
  ssr: false,
  // 跟甘特差不多高（工具列＋月份、階段、四段、學生截止各一列），載入時版面不跳。
  loading: () => <div data-testid="gantt-skeleton" aria-hidden className="dash-card h-[23rem] animate-pulse bg-muted/40" />,
})
// 視窗殼跟右鍵選單同一支（`gantt.tsx` 在 edit 模式已在背景先載）；打開時才掛上。
const ActivityDialog = dynamic(() => import('@/app/dashboard/_timeline/gantt/gantt-dialogs').then((m) => m.ActivityDialog), { ssr: false })
const StageConfirmDialog = dynamic(() => import('@/app/dashboard/_timeline/gantt/gantt-dialogs').then((m) => m.StageConfirmDialog), { ssr: false })

type ScheduleInput = Parameters<GanttEditor['saveSchedule']>[0]
type ScheduleOutcome = Awaited<ReturnType<GanttEditor['saveSchedule']>>
type StageConfirmState = { summary: string; input: ScheduleInput }

type ActivityDialogState =
  | { mode: 'create'; prefill: { startDate: string; endDate: string } }
  | { mode: 'edit'; id: string; prefill?: { startDate: string; endDate: string } }

export type GanttActivityValues = Record<string, { title: string; revision: number; values: ActivityDraft }>

export function GanttMount({
  gantt,
  cohortRevision,
  activityValues,
  limits,
  stageEditor,
}: {
  gantt: Omit<GanttProps, 'mode' | 'editor'>
  cohortRevision: number
  /** 每個活動的表單初值（伺服器算好臺灣日期與時間）。 */
  activityValues: GanttActivityValues
  limits: ActivityLimits
  stageEditor: StageEditorProps
}) {
  const [dialog, setDialog] = useState<ActivityDialogState | null>(null)
  const [stageSeq, setStageSeq] = useState<number | null>(null)
  const [opened, setOpened] = useState(0)
  const [notice, setNotice] = useState<TimelineActionState>(undefined)
  const [confirm, setConfirm] = useState<StageConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  // 等確認框結果的那個 `saveSchedule` promise。
  const settle = useRef<((outcome: ScheduleOutcome) => void) | null>(null)
  const cohortId = gantt.cohortId

  const editor = useMemo<GanttEditor>(
    () => ({
      cohortRevision,
      saveSchedule: async (input): Promise<ScheduleOutcome> => {
        const preview = await previewScheduleAction(cohortId, input)
        if (!preview.ok) return preview
        if (!preview.changed) return saveStageDatesAction(cohortId, input)
        settle.current?.({ ok: false, cancelled: true })
        setNotice(undefined)
        setConfirmBusy(false)
        setConfirm({ summary: preview.message, input })
        return new Promise<ScheduleOutcome>((resolve) => {
          settle.current = resolve
        })
      },
      openStage: (seq) => {
        setNotice(undefined)
        setStageSeq(seq)
        setOpened((n) => n + 1)
      },
      moveActivity: (id, revision, startDate, endDate) => moveActivityAction(id, revision, startDate, endDate),
      openCreate: (prefill) => {
        setNotice(undefined)
        setDialog({ mode: 'create', prefill })
        setOpened((n) => n + 1)
      },
      openEdit: (id, prefill) => {
        setNotice(undefined)
        setDialog({ mode: 'edit', id, prefill })
        setOpened((n) => n + 1)
      },
      remove: async (id, revision): Promise<ActionResult> => {
        const formData = new FormData()
        formData.set('activityId', id)
        formData.set('revision', String(revision))
        formData.set('requestId', crypto.randomUUID())
        const result = await deleteActivityAction(undefined, formData)
        if (!result) return { ok: false, message: '沒有收到伺服器回應，請重新整理頁面看看。' }
        return result.ok ? { ok: true, message: result.message } : { ok: false, message: result.message }
      },
    }),
    [cohortId, cohortRevision],
  )

  const finishConfirm = useCallback((outcome: ScheduleOutcome) => {
    setConfirm(null)
    setConfirmBusy(false)
    settle.current?.(outcome)
    settle.current = null
  }, [])
  const cancelConfirm = useCallback(() => finishConfirm({ ok: false, cancelled: true }), [finishConfirm])
  const acceptConfirm = useCallback(async () => {
    if (!confirm) return
    setConfirmBusy(true)
    finishConfirm(await saveStageDatesAction(cohortId, confirm.input))
  }, [cohortId, confirm, finishConfirm])

  const closeDialog = useCallback(() => setDialog(null), [])
  const closeStage = useCallback(() => setStageSeq(null), [])
  const saved = useCallback((state: TimelineActionState) => {
    setNotice(state)
    setDialog(null)
  }, [])

  const editing = dialog?.mode === 'edit' ? activityValues[dialog.id] : undefined
  // 編輯的那一筆不在了（剛被刪掉）就不開。
  const showDialog = dialog !== null && (dialog.mode === 'create' || editing !== undefined)

  return (
    <div className="flex flex-col gap-3">
      <Feedback state={notice} />
      <Gantt {...gantt} mode="edit" editor={editor} />
      {showDialog ? (
        <ActivityDialog
          open
          mode={dialog.mode}
          title={dialog.mode === 'create' ? '新增活動' : `編輯：${editing!.title}`}
          prefill={dialog.prefill}
          onClose={closeDialog}
          renderForm={() => (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{dialog.mode === 'create' ? CREATE_ACTIVITY_DESCRIPTION : EDIT_ACTIVITY_DESCRIPTION}</p>
              {dialog.mode === 'create' ? (
                <ActivityForm
                  key={opened}
                  target={{ kind: 'create', cohortId }}
                  // 點空白處：起訖同一天、全天（§9.3）；使用者可以自己改結束日。
                  initial={{ ...newActivityDraft(dialog.prefill.startDate, true), endDate: dialog.prefill.endDate }}
                  idPrefix="gantt-new-activity"
                  submitLabel="建立活動"
                  onSuccess={saved}
                  onCancel={closeDialog}
                  limits={limits}
                />
              ) : (
                <ActivityForm
                  key={opened}
                  target={{ kind: 'edit', activityId: dialog.id, revision: editing!.revision }}
                  initial={dialog.prefill ? { ...editing!.values, ...dialog.prefill } : editing!.values}
                  idPrefix={`gantt-edit-${dialog.id}`}
                  submitLabel="儲存"
                  onSuccess={saved}
                  onCancel={closeDialog}
                  limits={limits}
                />
              )}
            </div>
          )}
        />
      ) : null}
      {confirm ? (
        <StageConfirmDialog open summary={confirm.summary} busy={confirmBusy} onConfirm={acceptConfirm} onCancel={cancelConfirm} />
      ) : null}
      {stageSeq !== null ? (
        <StageEditDialog key={opened} seq={stageSeq} onClose={closeStage} onSaved={setNotice} {...stageEditor} />
      ) : null}
    </div>
  )
}
