'use client'
import { useActionState, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  cancelActivityAction,
  createActivityAction,
  saveScheduleAction,
  updateActivityAction,
} from './actions'
import { cn } from '@/shared/cn'

/**
 * 時間軸頁會動的部分（票 11）：編輯階段與日期、新增活動、改期、取消活動。
 *
 * 回饋一律是**伺服器**回的句子；瀏覽器端不判斷任何規則（開始日要不要遞增是用例說了算）。
 * 欄位用受控元件：送出失敗時剛填的值還在，不用整份重打。
 */

export type TimelineActionState = { ok: boolean; message: string } | undefined

const INPUT = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
const LABEL = 'block text-sm font-medium text-ink'
const PRIMARY =
  'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium ' +
  'text-primary-foreground hover:bg-primary/90 disabled:opacity-60'
const SECONDARY =
  'inline-flex items-center justify-center whitespace-nowrap rounded-md border border-border px-3 py-1.5 ' +
  'text-sm font-medium text-ink hover:bg-muted disabled:opacity-60'

export function Feedback({ state }: { state: TimelineActionState }) {
  if (!state) return null
  return (
    <p
      role={state.ok ? 'status' : 'alert'}
      className={cn(
        'rounded-md px-3 py-2 text-sm',
        state.ok ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-danger-subtle text-danger-on-subtle',
      )}
    >
      {state.message}
    </p>
  )
}

/** 原生 `<dialog>`：自帶 modal、Esc 關閉與焦點鎖。成功時由呼叫端關掉。 */
function useDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  // 開關函式要穩定：下面「成功就關」的 effect 只該在回饋換新時跑，不能每次重畫都跑
  // （否則成功過一次之後，再打開對話框打字就會被關掉）。
  const open = useCallback(() => ref.current?.showModal(), [])
  const close = useCallback(() => ref.current?.close(), [])
  return { ref, open, close }
}

function Dialog({
  dialog,
  title,
  description,
  children,
}: {
  dialog: ReturnType<typeof useDialog>
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <dialog
      ref={dialog.ref}
      aria-label={title}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40"
    >
      <div className="p-5">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        <div className="mt-4">{children}</div>
      </div>
    </dialog>
  )
}

/** 成功時關掉對話框（失敗時留著讓人改）。 */
function useCloseOnSuccess(state: TimelineActionState, close: () => void) {
  useEffect(() => {
    if (state?.ok) close()
  }, [state, close])
}

// ── 階段與日期 ──────────────────────────────────────────────────────────────

export type StageDraft = { name: string; startDate: string }

export function ScheduleEditor({
  cohortId,
  cohortCode,
  revision,
  requestId,
  stages,
  yearEndDate,
  nameMaxLength,
}: {
  cohortId: string
  cohortCode: string
  revision: number
  requestId: string
  stages: StageDraft[]
  yearEndDate: string
  nameMaxLength: number
}) {
  const [state, formAction, pending] = useActionState(saveScheduleAction, undefined)
  const dialog = useDialog()
  const [draft, setDraft] = useState({ stages, yearEndDate })
  const [seenRevision, setSeenRevision] = useState(revision)
  useCloseOnSuccess(state, dialog.close)

  // 資料換版（自己存成功、或別人改過）時，對話框的初始值跟著最新資料走。
  // 在渲染中依 prop 調整 state，是 React 建議的做法（不用 effect 多繞一圈）。
  if (seenRevision !== revision) {
    setSeenRevision(revision)
    setDraft({ stages, yearEndDate })
  }

  const setStage = (index: number, patch: Partial<StageDraft>) =>
    setDraft((d) => ({ ...d, stages: d.stages.map((s, i) => (i === index ? { ...s, ...patch } : s)) }))

  return (
    <div className="space-y-3">
      <button type="button" className={PRIMARY} onClick={dialog.open}>
        編輯階段與日期
      </button>
      <Feedback state={state?.ok ? state : undefined} />
      <Dialog
        dialog={dialog}
        title={`編輯 ${cohortCode} 的階段與日期`}
        description="每個階段只填開始日，要一段比一段晚；下一段開始那天 00:00 起就換段。年度結束日當天仍算在年度內。"
      >
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="cohortId" value={cohortId} />
          <input type="hidden" name="revision" value={revision} />
          <input type="hidden" name="requestId" value={requestId} />
          <ol className="space-y-3">
            {draft.stages.map((stage, index) => {
              const seq = index + 1
              return (
                <li key={seq} className="grid gap-3 sm:grid-cols-[1fr_11rem]">
                  <div>
                    <label htmlFor={`stage${seq}-name`} className={LABEL}>
                      第 {seq} 階段名稱
                    </label>
                    <input
                      id={`stage${seq}-name`}
                      name={`stage${seq}.name`}
                      value={stage.name}
                      onChange={(e) => setStage(index, { name: e.target.value })}
                      maxLength={nameMaxLength}
                      required
                      autoComplete="off"
                      className={INPUT}
                    />
                  </div>
                  <div>
                    <label htmlFor={`stage${seq}-start`} className={LABEL}>
                      第 {seq} 階段開始日
                    </label>
                    <input
                      id={`stage${seq}-start`}
                      name={`stage${seq}.startDate`}
                      type="date"
                      value={stage.startDate}
                      onChange={(e) => setStage(index, { startDate: e.target.value })}
                      required
                      className={INPUT}
                    />
                  </div>
                </li>
              )
            })}
          </ol>
          <div className="sm:w-44">
            <label htmlFor="year-end-date" className={LABEL}>
              年度結束日
            </label>
            <input
              id="year-end-date"
              name="yearEndDate"
              type="date"
              value={draft.yearEndDate}
              onChange={(e) => setDraft((d) => ({ ...d, yearEndDate: e.target.value }))}
              required
              className={INPUT}
            />
          </div>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不改
            </button>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? '處理中…' : '儲存'}
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}

// ── 活動 ────────────────────────────────────────────────────────────────────

export type ActivityDraft = {
  title: string
  description: string
  date: string
  allDay: boolean
  startTime: string
  endTime: string
  audience: string
}

export type AudienceOption = { value: string; label: string }

const EMPTY_ACTIVITY: ActivityDraft = {
  title: '',
  description: '',
  date: '',
  allDay: false,
  startTime: '',
  endTime: '',
  audience: 'cohort_students',
}

function ActivityFields({
  idPrefix,
  draft,
  onChange,
  audiences,
  titleMaxLength,
  descriptionMaxLength,
}: {
  idPrefix: string
  draft: ActivityDraft
  onChange: (patch: Partial<ActivityDraft>) => void
  audiences: AudienceOption[]
  titleMaxLength: number
  descriptionMaxLength: number
}) {
  const id = (name: string) => `${idPrefix}-${name}`
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={id('title')} className={LABEL}>
          活動名稱
        </label>
        <input
          id={id('title')}
          name="title"
          value={draft.title}
          onChange={(e) => onChange({ title: e.target.value })}
          maxLength={titleMaxLength}
          required
          autoComplete="off"
          placeholder="例：期中發表會"
          className={INPUT}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-[11rem_auto_1fr_1fr] sm:items-end">
        <div>
          <label htmlFor={id('date')} className={LABEL}>
            日期
          </label>
          <input
            id={id('date')}
            name="date"
            type="date"
            value={draft.date}
            onChange={(e) => onChange({ date: e.target.value })}
            required
            className={INPUT}
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-ink">
          <input
            type="checkbox"
            name="allDay"
            checked={draft.allDay}
            onChange={(e) => onChange({ allDay: e.target.checked })}
          />
          全天
        </label>
        <div>
          <label htmlFor={id('start')} className={LABEL}>
            開始時間
          </label>
          <input
            id={id('start')}
            name="startTime"
            type="time"
            value={draft.startTime}
            onChange={(e) => onChange({ startTime: e.target.value })}
            disabled={draft.allDay}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor={id('end')} className={LABEL}>
            結束時間（可不填）
          </label>
          <input
            id={id('end')}
            name="endTime"
            type="time"
            value={draft.endTime}
            onChange={(e) => onChange({ endTime: e.target.value })}
            disabled={draft.allDay}
            className={INPUT}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
        <div>
          <label htmlFor={id('audience')} className={LABEL}>
            誰看得到
          </label>
          <select
            id={id('audience')}
            name="audience"
            value={draft.audience}
            onChange={(e) => onChange({ audience: e.target.value })}
            className={INPUT}
          >
            {audiences.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id('description')} className={LABEL}>
            說明（可不填）
          </label>
          <input
            id={id('description')}
            name="description"
            value={draft.description}
            onChange={(e) => onChange({ description: e.target.value })}
            maxLength={descriptionMaxLength}
            autoComplete="off"
            className={INPUT}
          />
        </div>
      </div>
    </div>
  )
}

type ActivityLimits = { audiences: AudienceOption[]; titleMaxLength: number; descriptionMaxLength: number }

export function CreateActivityForm({ cohortId, requestId, ...limits }: { cohortId: string; requestId: string } & ActivityLimits) {
  const [state, formAction, pending] = useActionState(createActivityAction, undefined)
  const [draft, setDraft] = useState(EMPTY_ACTIVITY)
  const [seenState, setSeenState] = useState(state)

  // 新增成功就清空表單，準備加下一個。
  if (seenState !== state) {
    setSeenState(state)
    if (state?.ok) setDraft(EMPTY_ACTIVITY)
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="cohortId" value={cohortId} />
      <input type="hidden" name="requestId" value={requestId} />
      <ActivityFields idPrefix="new-activity" draft={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} {...limits} />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? '處理中…' : '新增活動'}
        </button>
        <p className="text-xs text-muted-foreground">作業截止不用在這裡加，會從收件項目自動帶進日曆。</p>
      </div>
      <Feedback state={state} />
    </form>
  )
}

export function ActivityActions({
  activityId,
  title,
  revision,
  requestIds,
  values,
  ...limits
}: {
  activityId: string
  title: string
  revision: number
  requestIds: { update: string; cancel: string }
  values: ActivityDraft
} & ActivityLimits) {
  const [updated, updateAction, updating] = useActionState(updateActivityAction, undefined)
  const [cancelled, cancelAction, cancelling] = useActionState(cancelActivityAction, undefined)
  const edit = useDialog()
  const confirm = useDialog()
  const [draft, setDraft] = useState(values)
  const [seenRevision, setSeenRevision] = useState(revision)
  useCloseOnSuccess(updated, edit.close)
  useCloseOnSuccess(cancelled, confirm.close)

  if (seenRevision !== revision) {
    setSeenRevision(revision)
    setDraft(values)
  }

  const done = updated?.ok ? updated : cancelled?.ok ? cancelled : undefined

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={SECONDARY} onClick={edit.open} aria-label={`改期：${title}`}>
          改期
        </button>
        <button type="button" className={SECONDARY} onClick={confirm.open} aria-label={`取消活動：${title}`}>
          取消活動
        </button>
      </div>
      <Feedback state={done} />

      <Dialog dialog={edit} title={`改期：${title}`} description="同一個活動換日期或內容，不是刪掉重建；異動會留紀錄。">
        <form action={updateAction} className="space-y-4">
          <input type="hidden" name="activityId" value={activityId} />
          <input type="hidden" name="revision" value={revision} />
          <input type="hidden" name="requestId" value={requestIds.update} />
          <ActivityFields idPrefix={`edit-${activityId}`} draft={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} {...limits} />
          <Feedback state={updated?.ok ? undefined : updated} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={edit.close}>
              先不改
            </button>
            <button type="submit" disabled={updating} className={PRIMARY}>
              {updating ? '處理中…' : '儲存改期'}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog dialog={confirm} title={`取消「${title}」？`} description="取消後活動會標「已取消」，不會刪除，也不能再改期。">
        <form action={cancelAction} className="space-y-4">
          <input type="hidden" name="activityId" value={activityId} />
          <input type="hidden" name="revision" value={revision} />
          <input type="hidden" name="requestId" value={requestIds.cancel} />
          <Feedback state={cancelled?.ok ? undefined : cancelled} />
          <div className="flex justify-end gap-2">
            <button type="button" className={SECONDARY} onClick={confirm.close}>
              不取消
            </button>
            <button type="submit" disabled={cancelling} className={PRIMARY}>
              {cancelling ? '處理中…' : '確定取消'}
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}
