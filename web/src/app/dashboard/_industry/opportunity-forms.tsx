'use client'
import { startTransition, useActionState, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { NormalizedOpportunity, OpportunityField } from '@/application/groups'
import { cn } from '@/shared/cn'
import { changeOpportunityStatusAction, saveOpportunityAction, unlinkOpportunityAction } from './actions'

/**
 * 合作案管理會動的部分（票 20；原型 `IndustryFormDialog`）：新增／編輯對話框、發布／下架／重新發布、解除連結。
 *
 * 規則全在用例裡判；這裡只顯示伺服器回來的句子。欄位出錯時伺服器回是哪一欄，對話框把焦點移過去並標紅。
 * 原型的「網際網路公開（含聯絡資訊）」選項不做（產品 6.1：合作案一律登入後可見，聯絡資訊只有負責老師與系辦）。
 */

export type IndustryActionState = { ok: boolean; message: string; field?: string } | undefined

const PRIMARY =
  'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60'
const SECONDARY =
  'inline-flex items-center justify-center whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-sm font-medium text-ink hover:bg-muted disabled:opacity-60'
const INPUT = 'mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm'
const LABEL = 'block text-sm font-medium text-ink'
const DIALOG = 'm-auto w-[min(40rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40'

export function IndustryFeedback({ state }: { state: IndustryActionState }) {
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

function useDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const open = useCallback(() => ref.current?.showModal(), [])
  const close = useCallback(() => ref.current?.close(), [])
  return { ref, open, close }
}

/** 送出但不讓 React 在 action 回來後重設表單：被伺服器拒絕時，已經打好的長段文字不能不見。 */
function submitWithoutReset(action: (formData: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // 帶上按下的那顆按鈕（「儲存草稿」與「儲存並發布」是同一張表單的兩顆 submit）。
    const formData = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter)
    startTransition(() => action(formData))
  }
}

export type OpportunityFormLabels = {
  readonly fields: Record<OpportunityField, string>
  readonly limits: Record<OpportunityField, number>
}

type Initial = { opportunityId: string; revision: number; values: NormalizedOpportunity; name: string }

/**
 * 新增（老師）或編輯（案主、系辦）合作案。`initial` 沒給就是新增：可以「儲存草稿」或「儲存並發布」。
 * 私有欄位區塊標「只有負責老師與系辦看得到」。
 */
export function OpportunityFormDialog({
  labels,
  requestId,
  initial,
}: {
  labels: OpportunityFormLabels
  requestId: string
  initial?: Initial
}) {
  const [state, action, pending] = useActionState(saveOpportunityAction, undefined)
  const dialog = useDialog()
  const [version, setVersion] = useState(0)
  const formRef = useRef<HTMLFormElement>(null)
  const editing = Boolean(initial)

  useEffect(() => {
    if (state?.ok) {
      dialog.close()
      if (!editing) setVersion((v) => v + 1)
    } else if (state?.field) {
      formRef.current?.querySelector<HTMLElement>(`[name="${state.field}"]`)?.focus()
    }
  }, [state, dialog, editing])

  const value = (field: OpportunityField) => initial?.values[field] ?? ''
  const field = (name: OpportunityField, options: { required?: boolean; textarea?: boolean; rows?: number; type?: string; span?: boolean } = {}) => {
    const id = `opp-${initial?.opportunityId ?? 'new'}-${name}`
    const invalid = !state?.ok && state?.field === name
    const common = {
      id,
      name,
      defaultValue: value(name) ?? '',
      maxLength: labels.limits[name],
      'aria-invalid': invalid || undefined,
      className: cn(INPUT, invalid ? 'border-danger' : 'border-border', options.textarea && 'resize-y'),
    }
    return (
      <div className={options.span ? 'sm:col-span-2' : undefined}>
        <label htmlFor={id} className={LABEL}>
          {labels.fields[name]}
          {options.required ? <span className="ml-0.5 text-danger">＊</span> : null}
        </label>
        {options.textarea ? <textarea rows={options.rows ?? 3} {...common} /> : <input type={options.type ?? 'text'} {...common} />}
      </div>
    )
  }

  return (
    <>
      {editing ? (
        <button type="button" className={SECONDARY} onClick={dialog.open} aria-label={`編輯：${initial!.name}`}>
          編輯
        </button>
      ) : (
        <button type="button" className={PRIMARY} onClick={dialog.open}>
          新增合作案
        </button>
      )}
      {state?.ok ? (
        <span className="sr-only" role="status">
          {state.message}
        </span>
      ) : null}
      <dialog ref={dialog.ref} aria-label={editing ? `編輯合作案：${initial!.name}` : '新增合作案'} className={DIALOG}>
        <form ref={formRef} key={`${initial?.revision ?? 0}-${version}`} onSubmit={submitWithoutReset(action)} className="flex flex-col">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-base font-semibold text-ink">{editing ? '編輯合作案' : '新增合作案'}</h2>
            <p className="mt-1 text-sm text-muted-foreground">負責老師與發布日由系統帶入。＊為必填。內容可以分段落，直接換行即可。</p>
          </div>
          <input type="hidden" name="requestId" value={requestId} />
          {initial ? (
            <>
              <input type="hidden" name="opportunityId" value={initial.opportunityId} />
              <input type="hidden" name="revision" value={initial.revision} />
            </>
          ) : null}
          <div className="grid max-h-[60vh] gap-4 overflow-y-auto px-5 py-4 sm:grid-cols-2">
            {field('companyName', { required: true })}
            {field('department', { required: true })}
            {field('content', { required: true, textarea: true, rows: 5, span: true })}
            {field('requirements', { textarea: true, rows: 3, span: true })}
            {field('notes', { textarea: true, rows: 2, span: true })}
            <fieldset className="sm:col-span-2">
              <legend className={LABEL}>備註給誰看</legend>
              <div className="mt-1 flex flex-wrap gap-4 text-sm text-ink">
                <label className="flex items-center gap-2">
                  <input type="radio" name="notesVisibility" value="internal" defaultChecked={(initial?.values.notesVisibility ?? 'internal') === 'internal'} />
                  只有我與系辦
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="notesVisibility" value="signed_in" defaultChecked={initial?.values.notesVisibility === 'signed_in'} />
                  登入的學生與老師
                </label>
              </div>
            </fieldset>
            <p className="rounded-md bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground sm:col-span-2">
              以下只有你（負責老師）與系辦看得到，不會因為發布而公開。
            </p>
            {field('address', { span: true })}
            {field('contactName')}
            {field('contactPhone', { type: 'tel' })}
            {field('contactEmail', { type: 'email', span: true })}
          </div>
          <div className="space-y-3 border-t border-border px-5 py-4">
            <IndustryFeedback state={state?.ok ? undefined : state} />
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={dialog.close}>
                先不要
              </button>
              {editing ? (
                <button type="submit" disabled={pending} className={PRIMARY}>
                  {pending ? '處理中…' : '儲存修改'}
                </button>
              ) : (
                <>
                  <button type="submit" name="publish" value="false" disabled={pending} className={SECONDARY}>
                    儲存草稿
                  </button>
                  <button type="submit" name="publish" value="true" disabled={pending} className={PRIMARY}>
                    {pending ? '處理中…' : '儲存並發布'}
                  </button>
                </>
              )}
            </div>
          </div>
        </form>
      </dialog>
    </>
  )
}

/**
 * 「發布」「下架」「重新發布」：先開確認對話框說清楚會發生什麼，再送出。
 */
export function OpportunityStatusButton({
  opportunityId,
  revision,
  name,
  kind,
  requestId,
}: {
  opportunityId: string
  revision: number
  name: string
  kind: 'publish' | 'republish' | 'withdraw'
  requestId: string
}) {
  const [state, action, pending] = useActionState(changeOpportunityStatusAction, undefined)
  const dialog = useDialog()
  useEffect(() => {
    if (state?.ok) dialog.close()
  }, [state, dialog])
  const label = kind === 'withdraw' ? '下架' : kind === 'republish' ? '重新發布' : '發布'
  const explain =
    kind === 'withdraw'
      ? '下架後列表不再顯示、不接受新的組別連結；已連結的組別保留關係，組員看到「合作案已下架」。下架中不能修改內容。'
      : kind === 'republish'
        ? '重新發布後列表恢復顯示；以前已解除的組別連結不會自動恢復。'
        : '發布後登入的學生與老師看得到公司、部門、內容與條件；聯絡資訊仍只有你與系辦看得到。'
  return (
    <>
      <button type="button" className={SECONDARY} onClick={dialog.open} aria-label={`${label}：${name}`}>
        {label}
      </button>
      <IndustryFeedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label={`${label}「${name}」`} className={DIALOG}>
        <form action={action} className="space-y-4 p-5">
          <h2 className="text-base font-semibold text-ink">
            {label}「{name}」？
          </h2>
          <p className="text-sm text-muted-foreground">{explain}</p>
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <input type="hidden" name="revision" value={revision} />
          <input type="hidden" name="kind" value={kind === 'withdraw' ? 'withdraw' : 'publish'} />
          <input type="hidden" name="requestId" value={requestId} />
          <IndustryFeedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? '處理中…' : `確認${label}`}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}

/**
 * 一案的「連結的組別」格：每組一顆「解除」；案主或系辦解除時理由必填，該組組員與案主會收到通知。
 *
 * 整格是同一個元件（同一份動作狀態）：解除成功、那一組從清單消失之後，回饋句子仍留在這一格。
 */
export function LinkedGroupsCell({
  links,
  opportunityName,
  requestId,
  reasonMaxLength,
}: {
  links: readonly { linkId: string; groupCode: string; cohortCode: string }[]
  opportunityName: string
  requestId: string
  reasonMaxLength: number
}) {
  const [state, action, pending] = useActionState(unlinkOpportunityAction, undefined)
  const dialog = useDialog()
  const [target, setTarget] = useState<{ linkId: string; groupCode: string } | null>(null)
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (state?.ok) dialog.close()
  }, [state, dialog])

  return (
    <div className="text-sm">
      <p className="text-xs font-semibold text-muted-foreground">連結的組別</p>
      {links.length === 0 ? (
        <p className="mt-1 text-muted-foreground">尚無組別連結</p>
      ) : (
        <ul className="mt-1 space-y-2">
          {links.map((l) => (
            <li key={l.linkId} className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-ink tabular-nums">
                {l.cohortCode}・{l.groupCode}
              </span>
              <button
                type="button"
                className={SECONDARY}
                aria-label={`解除連結：${l.groupCode}`}
                onClick={() => {
                  setTarget({ linkId: l.linkId, groupCode: l.groupCode })
                  setReason('')
                  dialog.open()
                }}
              >
                解除
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2">
        <IndustryFeedback state={state?.ok ? state : undefined} />
      </div>
      <dialog ref={dialog.ref} aria-label={`解除 ${target?.groupCode ?? ''} 的連結`} className={DIALOG}>
        <form onSubmit={submitWithoutReset(action)} className="space-y-4 p-5">
          <div>
            <h2 className="text-base font-semibold text-ink">
              解除 {target?.groupCode} 與「{opportunityName}」的連結
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">解除後該組組員與案主會收到通知；歷程保留解除原因。</p>
          </div>
          <input type="hidden" name="linkId" value={target?.linkId ?? ''} />
          <input type="hidden" name="requestId" value={`${requestId}`} />
          <div>
            <label htmlFor={`unlink-reason-${requestId}`} className={LABEL}>
              理由（必填）
            </label>
            <textarea
              id={`unlink-reason-${requestId}`}
              name="reason"
              rows={3}
              maxLength={reasonMaxLength}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例：企業暫停這個題目"
              className={cn(INPUT, 'border-border')}
            />
          </div>
          <IndustryFeedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不要
            </button>
            <button type="submit" disabled={pending || !target} className={PRIMARY}>
              {pending ? '處理中…' : '確認解除'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
