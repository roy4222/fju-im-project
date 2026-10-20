'use client'
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react'
import type { FeFormModule, FeFormProps } from '@/app/_ui/front-edit/forms'
import type { NormalizedOpportunity, OpportunityField } from '@/application/groups'
import type { opportunityFeContextAction, removeOpportunityFeAction, saveOpportunityFeAction } from './actions'

/**
 * 合作案表單本體＋前台直接編輯模組（C3-10；規格③ §8、§14.4；②§6.3.1 `FeFormModule`）。
 *
 * - `OpportunityFormBody`：欄位格（負責老師選單、公開欄位、備註給誰看、私有欄位），後台 `OpportunityFormDialog` 與
 *   前台編輯的 `default` 表單共用同一份；不含 `<form>`、標題與按鈕，外層自己放。
 * - `default`：前台「編輯」「＋新增」開的表單。開窗先呼叫 `opportunityFeContextAction` 讀欄位名稱、負責老師選項與
 *   （編輯時）那一案的原始欄位與 revision——前台卡片只標了公司名稱、沒帶 revision；載完之前只顯示「載入中…」。
 *   成功只呼叫 `onDone({ id, status })`；不 `router.refresh`、不 toast、不碰 URL（框架負責）。
 * - `remove`：既有刪除用例；不能刪時回 `{ ok:false, message }`，框架顯示在確認框裡。
 *
 * 這個檔是按下才載入的延遲 chunk：**不 import Server Function、不 import `_ui/dashboard/look` 等共用模組**
 * （延遲 chunk 一靜態碰到它們，Turbopack 就重切每頁都載的共用 chunk，全站變大；同 `forms/registry.ts`、
 * `affairs/front-edit/resource-category.tsx`）。樣式字串照 `look.ts` 同字；Server Function 由 `forms.ts` 的登錄行
 * 在載入時用 `provideOpportunityFeActions` 交進來。
 */

type Actions = {
  context: typeof opportunityFeContextAction
  save: typeof saveOpportunityFeAction
  remove: typeof removeOpportunityFeAction
}
let actions: Actions | null = null

/** `forms.ts` 載入這個模組時呼叫一次。 */
export function provideOpportunityFeActions(provided: Actions): void {
  actions = provided
}

function feActions(): Actions {
  if (!actions) throw new Error('合作案的 Server Function 還沒登錄（forms.ts 要先載入）。')
  return actions
}

export type OpportunityFormLabels = {
  readonly fields: Record<OpportunityField, string>
  readonly limits: Record<OpportunityField, number>
}

/** 系辦新增時的負責老師選項（帳號正常、目前是老師）。 */
export type OwnerTeacherOption = { readonly userId: string; readonly name: string; readonly loginEmail: string }

// 樣式照 `_ui/dashboard/look.ts`（INPUT／TEXTAREA）同字；h-11 與 mt-1.5 是後台對話框原本的寫法。
const INPUT =
  'mt-1.5 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal text-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 aria-invalid:border-destructive disabled:opacity-60'
const AREA =
  'mt-1.5 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal text-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 aria-invalid:border-destructive disabled:opacity-60'
const LABEL = 'block text-sm font-semibold text-foreground'
const INVALID = ' border-destructive'

/**
 * 合作案的欄位格。`values` 是編輯的初值（新增給 null）；給 `teachers` 就是系辦新增：第一欄是負責老師選單（必填）。
 * 欄位 `name` 跟 Server Function 讀的鍵一樣；`invalidField` 是伺服器回來的出錯欄位，那一欄標紅。
 * 用 `defaultValue`（非受控）：外層用 `key` 重設表單。
 */
export function OpportunityFormBody({
  labels,
  values,
  teachers,
  invalidField,
  idPrefix,
}: {
  labels: OpportunityFormLabels
  values: NormalizedOpportunity | null
  teachers?: readonly OwnerTeacherOption[]
  invalidField: string | null | undefined
  idPrefix: string
}) {
  const ownerInvalid = invalidField === 'ownerTeacherUserId'
  const field = (name: OpportunityField, options: { required?: boolean; textarea?: boolean; rows?: number; type?: string; span?: boolean } = {}) => {
    const id = `${idPrefix}-${name}`
    const invalid = invalidField === name
    const common = {
      id,
      name,
      defaultValue: values?.[name] ?? '',
      maxLength: labels.limits[name],
      'aria-invalid': invalid || undefined,
      className: (options.textarea ? AREA : INPUT) + (invalid ? INVALID : ''),
    }
    return (
      <div className={options.span ? 'sm:col-span-2' : undefined}>
        <label htmlFor={id} className={LABEL}>
          {labels.fields[name]}
          {options.required ? <span className="ml-0.5 text-destructive">*</span> : null}
        </label>
        {options.textarea ? <textarea rows={options.rows ?? 3} {...common} /> : <input type={options.type ?? 'text'} {...common} />}
      </div>
    )
  }

  return (
    <>
      {teachers ? (
        <div className="sm:col-span-2">
          <label htmlFor={`${idPrefix}-ownerTeacherUserId`} className={LABEL}>
            負責老師<span className="ml-0.5 text-destructive">*</span>
          </label>
          <select
            id={`${idPrefix}-ownerTeacherUserId`}
            name="ownerTeacherUserId"
            defaultValue=""
            aria-invalid={ownerInvalid || undefined}
            aria-describedby={`${idPrefix}-owner-hint`}
            className={INPUT + (ownerInvalid ? INVALID : '')}
          >
            <option value="" disabled>
              請選負責老師
            </option>
            {teachers.map((t) => (
              <option key={t.userId} value={t.userId}>
                {t.name}（{t.loginEmail}）
              </option>
            ))}
          </select>
          <p id={`${idPrefix}-owner-hint`} className="mt-1 text-xs text-muted-foreground">
            {teachers.length === 0
              ? '目前沒有可選的老師：請先到「帳號」建立或核准老師帳號。'
              : '這位老師會在「我的合作案」看到它，能編輯、下架，也看得到聯絡資訊。'}
          </p>
        </div>
      ) : null}
      {field('companyName', { required: true })}
      {field('department', { required: true })}
      {field('content', { required: true, textarea: true, rows: 5, span: true })}
      {field('requirements', { textarea: true, rows: 3, span: true })}
      {field('notes', { textarea: true, rows: 2, span: true })}
      <fieldset className="sm:col-span-2">
        <legend className={LABEL}>備註給誰看</legend>
        <div className="mt-1.5 flex flex-wrap gap-4 text-sm text-foreground">
          <label className="flex items-center gap-2">
            <input type="radio" className="accent-brand" name="notesVisibility" value="internal" defaultChecked={(values?.notesVisibility ?? 'internal') === 'internal'} />
            只有負責老師與系辦
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" className="accent-brand" name="notesVisibility" value="signed_in" defaultChecked={values?.notesVisibility === 'signed_in'} />
            登入的學生與老師
          </label>
        </div>
      </fieldset>
      <p className="mt-1 rounded-lg bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground sm:col-span-2">
        以下只有負責老師與系辦看得到，不會因為發布而公開。
      </p>
      {field('address', { span: true })}
      {field('contactName')}
      {field('contactPhone', { type: 'tel' })}
      {field('contactEmail', { type: 'email', span: true })}
    </>
  )
}

const BTN_SUBMIT = 'btn-fju h-11 px-5 text-sm disabled:pointer-events-none disabled:opacity-60'

type Context = Extract<Awaited<ReturnType<typeof opportunityFeContextAction>>, { ok: true }>

/** 前台編輯「合作案」的表單（系辦）：新增可「儲存草稿」或「儲存並發布」；編輯是「儲存修改」。 */
export default function OpportunityFrontEditForm({ mode, id, fields, onDone, onCancel }: FeFormProps) {
  const editing = mode === 'edit'
  const hint = typeof fields.title === 'string' ? fields.title : ''
  const [context, setContext] = useState<Context | { ok: false; message: string } | null>(null)
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [requestId] = useState(() => crypto.randomUUID())
  const [pending, startTransition] = useTransition()
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const result = await feActions().context({ id: editing ? id : null })
        if (alive) setContext(result)
      } catch {
        if (alive) setContext({ ok: false, message: '表單資料載入失敗，請關掉再開一次。' })
      }
    })()
    return () => {
      alive = false
    }
  }, [editing, id])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!context?.ok) return
    // 帶上按下的那顆按鈕（「儲存草稿」與「儲存並發布」是同一張表單的兩顆 submit）；不讓 React 重設表單，被擋時打好的字還在。
    const formData = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter)
    formData.set('requestId', requestId)
    if (editing && id && context.current) {
      formData.set('opportunityId', id)
      formData.set('revision', String(context.current.revision))
    }
    setError(null)
    startTransition(async () => {
      try {
        const result = await feActions().save(formData)
        if (result.ok) {
          onDone(editing ? { id: result.id } : { id: result.id, status: result.status === 'published' ? 'published' : 'draft' })
          return
        }
        setError({ message: result.message, field: result.field })
        if (result.field) formRef.current?.querySelector<HTMLElement>(`[name="${result.field}"]`)?.focus()
      } catch {
        setError({ message: '連線中斷；結果尚未確認，請重新整理頁面看看。' })
      }
    })
  }

  if (!context) {
    return (
      <div className="flex flex-col gap-4" data-testid="fe-opportunity-loading">
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

  const current = context.current
  return (
    <form
      ref={formRef}
      onSubmit={submit}
      className="flex flex-col gap-4"
      aria-label={editing ? `編輯合作案：${current?.name ?? hint}` : '新增合作案'}
      data-testid="fe-opportunity-form"
    >
      <p className="text-sm text-muted-foreground">
        {editing ? '負責老師與發布日由系統帶入。' : '負責老師從選單選，發布日由系統帶入。'}
        <span className="text-destructive">*</span> 為必填。內容可以分段落，直接換行即可。
      </p>
      {error ? (
        <p role="alert" className="fe-error">
          {error.message}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <OpportunityFormBody
          labels={context.labels}
          values={current?.values ?? null}
          teachers={editing ? undefined : context.teachers}
          invalidField={error?.field ?? null}
          idPrefix={`fe-opp-${id ?? 'new'}`}
        />
      </div>
      <div className="fe-actions">
        <button type="button" className="fe-btn" onClick={onCancel} disabled={pending}>
          取消
        </button>
        {editing ? (
          <button type="submit" className={BTN_SUBMIT} disabled={pending}>
            {pending ? '處理中…' : '儲存修改'}
          </button>
        ) : (
          <>
            <button type="submit" name="publish" value="false" className="fe-btn" disabled={pending}>
              儲存草稿
            </button>
            <button type="submit" name="publish" value="true" className={BTN_SUBMIT} disabled={pending}>
              {pending ? '處理中…' : '儲存並發布'}
            </button>
          </>
        )}
      </div>
    </form>
  )
}

/** 刪除：既有用例判規則；不能刪（發布中、連著組別）回原因，框架顯示在確認框、不關窗。 */
export const remove: NonNullable<FeFormModule['remove']> = (input) => feActions().remove(input)
