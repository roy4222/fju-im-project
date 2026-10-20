'use client'
import { useEffect, useState, useTransition, type FormEvent } from 'react'
import type { FeFormModule, FeFormProps } from '@/app/_ui/front-edit/forms'
import type { activityFeContextAction, removeActivityFeAction, saveActivityFeAction } from './actions'

/**
 * 活動表單本體＋前台直接編輯模組（C3-08；規格③ §9.4、§9.6、§14.4；②§6.3.1 `FeFormModule`）。
 *
 * - `ActivityFormBody`：活動的欄位格（名稱、開始日、結束日、全天、開始／結束時間、對象、說明），系辦時程頁的
 *   新增／編輯視窗、甘特點空白處與橫條開的視窗、前台編輯的 `default` 表單共用同一份；不含 `<form>`、標題與按鈕。
 * - `default`：前台首頁「近期活動」的「編輯」「＋新增」開的表單。開窗先呼叫 `activityFeContextAction` 讀對象選項、
 *   新增落在哪一屆（`cohortId` 為 null 時取預設工作屆別；沒有就顯示「還沒有工作屆別」不送出）、編輯時那一筆的欄位與
 *   revision（首頁標記只有名稱、沒帶 revision）。成功只呼叫 `onDone({ id })`；不 `router.refresh`、不 toast、不碰 URL。
 * - `remove`：刪除用例（排定中的也直接刪，不必先取消）；失敗回 `{ ok:false, message }`，框架顯示在確認框裡。
 *
 * 這個檔是按下才載入的延遲 chunk：**不 import Server Function、不 import `_ui/dashboard/look`、`dashboard-kit` 等共用模組**
 * （延遲 chunk 一靜態碰到它們，Turbopack 就重切每頁都載的共用 chunk，全站變大；同 `_industry/front-edit/opportunity.tsx`）。
 * 樣式字串照 `dashboard-kit` 同字；Server Function 由 `forms.ts` 的登錄行在載入時用 `provideActivityFeActions` 交進來。
 */

type Actions = {
  context: typeof activityFeContextAction
  save: typeof saveActivityFeAction
  remove: typeof removeActivityFeAction
}
let actions: Actions | null = null

/** `forms.ts` 載入這個模組時呼叫一次。 */
export function provideActivityFeActions(provided: Actions): void {
  actions = provided
}

function feActions(): Actions {
  if (!actions) throw new Error('活動的 Server Function 還沒登錄（forms.ts 要先載入）。')
  return actions
}

export type ActivityDraft = {
  title: string
  description: string
  startDate: string
  endDate: string
  allDay: boolean
  startTime: string
  endTime: string
  audience: string
}

export type AudienceOption = { value: string; label: string }

export type ActivityLimits = { audiences: AudienceOption[]; titleMaxLength: number; descriptionMaxLength: number }

export const EMPTY_ACTIVITY: ActivityDraft = {
  title: '',
  description: '',
  startDate: '',
  endDate: '',
  allDay: false,
  startTime: '',
  endTime: '',
  audience: 'cohort_students',
}

// 樣式照 `dashboard-kit` 的 INPUT 同字（mt-1.5 是系辦時程頁對話框原本的寫法）。
const INPUT =
  'mt-1.5 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/25 disabled:opacity-60'
const LABEL = 'block text-sm font-semibold'

/**
 * 活動的欄位格（受控）：`draft` 是目前的值，`onChange` 收部分更新。欄位 `name` 跟 Server Function 讀的鍵一樣。
 * 結束日跟開始日同一天（或還沒填）時，改開始日會帶著結束日走，維持單日。
 * 非全天又跨日時結束時間標必填（只是提示；規則以伺服器為準，③ §9.1「跨日的活動要填結束時間」）。
 */
export function ActivityFormBody({
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
} & ActivityLimits) {
  const id = (name: string) => `${idPrefix}-${name}`
  const crossDay = !draft.allDay && draft.endDate !== '' && draft.endDate !== draft.startDate
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
      <div className="grid gap-3 sm:grid-cols-[11rem_11rem_auto] sm:items-end">
        <div>
          <label htmlFor={id('start-date')} className={LABEL}>
            開始日
          </label>
          <input
            id={id('start-date')}
            name="startDate"
            type="date"
            value={draft.startDate}
            onChange={(e) =>
              onChange({
                startDate: e.target.value,
                ...(!draft.endDate || draft.endDate === draft.startDate ? { endDate: e.target.value } : {}),
              })
            }
            required
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor={id('end-date')} className={LABEL}>
            結束日
          </label>
          <input
            id={id('end-date')}
            name="endDate"
            type="date"
            value={draft.endDate}
            onChange={(e) => onChange({ endDate: e.target.value })}
            className={INPUT}
          />
        </div>
        <label className="flex h-10 items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            name="allDay"
            checked={draft.allDay}
            onChange={(e) => onChange({ allDay: e.target.checked })}
            className="size-4 accent-primary"
          />
          全天
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
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
            {crossDay ? '結束時間（跨日必填）' : '結束時間（單日可不填）'}
          </label>
          <input
            id={id('end')}
            name="endTime"
            type="time"
            value={draft.endTime}
            onChange={(e) => onChange({ endTime: e.target.value })}
            disabled={draft.allDay}
            aria-required={crossDay}
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

const BTN_SUBMIT = 'btn-fju h-11 px-5 text-sm disabled:pointer-events-none disabled:opacity-60'

type Context = Extract<Awaited<ReturnType<typeof activityFeContextAction>>, { ok: true }>

/** 前台編輯「活動」的表單（系辦）：新增是「建立活動」、編輯是「儲存」。 */
export default function ActivityFrontEditForm({ mode, id, cohortId, fields, onDone, onCancel }: FeFormProps) {
  const editing = mode === 'edit'
  const hint = typeof fields.title === 'string' ? fields.title : ''
  const [context, setContext] = useState<Context | { ok: false; message: string } | null>(null)
  const [draft, setDraft] = useState<ActivityDraft>(EMPTY_ACTIVITY)
  const [error, setError] = useState<string | null>(null)
  const [requestId] = useState(() => crypto.randomUUID())
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const result = await feActions().context({ id: editing ? id : null, cohortId: editing ? null : cohortId })
        if (!alive) return
        setContext(result)
        if (result.ok) setDraft(result.current?.values ?? { ...EMPTY_ACTIVITY, startDate: result.today, endDate: result.today })
      } catch {
        if (alive) setContext({ ok: false, message: '表單資料載入失敗，請關掉再開一次。' })
      }
    })()
    return () => {
      alive = false
    }
  }, [editing, id, cohortId])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!context?.ok) return
    const formData = new FormData(event.currentTarget)
    formData.set('requestId', requestId)
    if (editing && id && context.current) {
      formData.set('activityId', id)
      formData.set('revision', String(context.current.revision))
    } else if (context.cohort) {
      formData.set('cohortId', context.cohort.id)
    }
    setError(null)
    startTransition(async () => {
      try {
        const result = await feActions().save(formData)
        if (result.ok) {
          onDone({ id: result.id })
          return
        }
        setError(result.message)
      } catch {
        setError('連線中斷；結果尚未確認，請重新整理頁面看看。')
      }
    })
  }

  if (!context) {
    return (
      <div className="flex flex-col gap-4" data-testid="fe-activity-loading">
        {hint ? <p className="text-sm font-semibold text-foreground">{hint}</p> : null}
        <p className="fe-loading">載入中…</p>
        <div className="fe-actions">
          <button type="button" className="fe-btn" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    )
  }
  if (!context.ok) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="fe-error">
          {context.message}
        </p>
        <div className="fe-actions">
          <button type="button" className="fe-btn" onClick={onCancel}>
            關閉
          </button>
        </div>
      </div>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4"
      aria-label={editing ? `編輯活動：${context.current?.values.title ?? hint}` : '新增活動'}
      data-testid="fe-activity-form"
    >
      {context.cohort ? <p className="text-sm text-muted-foreground">屆別：{context.cohort.label}</p> : null}
      {error ? (
        <p role="alert" className="fe-error">
          {error}
        </p>
      ) : null}
      <ActivityFormBody
        idPrefix={`fe-activity-${id ?? 'new'}`}
        draft={draft}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        {...context.limits}
      />
      <div className="fe-actions">
        <button type="button" className="fe-btn" onClick={onCancel} disabled={pending}>
          取消
        </button>
        <button type="submit" className={BTN_SUBMIT} disabled={pending}>
          {pending ? '處理中…' : editing ? '儲存' : '建立活動'}
        </button>
      </div>
    </form>
  )
}

/** 刪除：排定中的也直接刪（§9.1）；失敗回伺服器句子，框架顯示在確認框、不關窗。 */
export const remove: NonNullable<FeFormModule['remove']> = (input) => feActions().remove(input)
