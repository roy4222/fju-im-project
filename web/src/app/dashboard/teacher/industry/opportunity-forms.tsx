'use client'
import { startTransition, useActionState, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { IconLock, IconPlus, IconX } from '@tabler/icons-react'
import { changeOpportunityStatusAction, saveOpportunityAction, unlinkOpportunityAction } from '@/app/dashboard/_industry/actions'
import type { IndustryActionState, OpportunityFormLabels } from '@/app/dashboard/_industry/opportunity-forms'
import { DIALOG, GHOST_BUTTON, INPUT, OUTLINE_BUTTON_SM, PRIMARY_BUTTON, TEXTAREA } from '@/app/dashboard/teacher/_ui/dash'
import type { NormalizedOpportunity, OpportunityField } from '@/application/groups'
import { cn } from '@/shared/cn'

/**
 * 老師「我的合作案」會動的部分（票 20；票 37 照原型 `IndustryFormDialog` 的樣子）：新增／編輯對話框、發布／下架／重新發布、解除連結。
 *
 * 動作跟系辦共用 `_industry/actions.ts` 同一支 Server Action，規則全在用例裡判；這裡只換外觀（系辦頁由票 36 各自處理）。
 * 欄位出錯時伺服器回是哪一欄，對話框把焦點移過去並標紅。
 * 原型的「學生可見／網際網路公開（含聯絡資訊）」勾選不做：產品 6.1 定案合作案一律登入後可見，
 * 聯絡資訊只有負責老師與系辦看得到，所以只有「儲存草稿」與「儲存並發布」。
 */

const LABEL = 'text-sm font-semibold text-foreground'
const WIDE_DIALOG = cn(DIALOG, 'w-[min(42rem,calc(100vw-2rem))]')

function Feedback({ state }: { state: IndustryActionState }) {
  if (!state) return null
  return (
    <p
      role={state.ok ? 'status' : 'alert'}
      className={cn(
        'rounded-lg px-3 py-2 text-sm',
        state.ok ? 'bg-success-subtle text-success-on-subtle' : 'bg-destructive-subtle text-destructive-on-subtle',
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

function CloseX({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="關閉對話框" className={cn(GHOST_BUTTON, 'absolute top-2 right-2 size-7 px-0')}>
      <IconX />
    </button>
  )
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

type Initial = { opportunityId: string; revision: number; values: NormalizedOpportunity; name: string }

/** 新增或編輯合作案。`initial` 沒給就是新增：可以「儲存草稿」或「儲存並發布」。私有欄位區塊標「只有你與系辦看得到」。 */
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
      className: cn(options.textarea ? cn(TEXTAREA, 'resize-y') : cn(INPUT, 'h-11'), invalid && 'border-destructive'),
    }
    return (
      <div className={cn('flex flex-col gap-1.5', options.span && 'sm:col-span-2')}>
        <label htmlFor={id} className={LABEL}>
          {labels.fields[name]}
          {options.required ? <span className="ml-0.5 text-destructive">＊</span> : null}
        </label>
        {options.textarea ? <textarea rows={options.rows ?? 3} {...common} /> : <input type={options.type ?? 'text'} {...common} />}
      </div>
    )
  }

  return (
    <>
      {editing ? (
        <button type="button" className={OUTLINE_BUTTON_SM} onClick={dialog.open} aria-label={`編輯：${initial!.name}`}>
          編輯
        </button>
      ) : (
        <button type="button" className="btn-fju h-10 px-4 text-sm" onClick={dialog.open}>
          <IconPlus className="size-4" /> 新增合作案
        </button>
      )}
      {state?.ok ? (
        <span className="sr-only" role="status">
          {state.message}
        </span>
      ) : null}
      <dialog ref={dialog.ref} aria-label={editing ? `編輯合作案：${initial!.name}` : '新增合作案'} className={WIDE_DIALOG}>
        <form ref={formRef} key={`${initial?.revision ?? 0}-${version}`} onSubmit={submitWithoutReset(action)} className="relative flex flex-col">
          <CloseX onClick={dialog.close} />
          <div className="border-b border-border px-6 py-4 pr-12">
            <h2 className="text-lg font-extrabold text-foreground">{editing ? '編輯合作案' : '新增合作案'}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              負責老師與發布日由系統帶入。<span className="text-destructive">＊</span> 為必填。內容可以分段落，直接換行即可。
            </p>
          </div>
          <input type="hidden" name="requestId" value={requestId} />
          {initial ? (
            <>
              <input type="hidden" name="opportunityId" value={initial.opportunityId} />
              <input type="hidden" name="revision" value={initial.revision} />
            </>
          ) : null}
          <div className="grid max-h-[60vh] gap-4 overflow-y-auto px-6 py-5 sm:grid-cols-2">
            {field('companyName', { required: true })}
            {field('department', { required: true })}
            {field('content', { required: true, textarea: true, rows: 4, span: true })}
            {field('requirements', { textarea: true, rows: 3, span: true })}
            {field('notes', { textarea: true, rows: 2, span: true })}
            <fieldset className="sm:col-span-2">
              <legend className={LABEL}>備註給誰看</legend>
              <div className="mt-1.5 flex flex-wrap gap-4 text-sm text-foreground">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="notesVisibility"
                    value="internal"
                    defaultChecked={(initial?.values.notesVisibility ?? 'internal') === 'internal'}
                    className="accent-primary"
                  />
                  只有我與系辦
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="notesVisibility" value="signed_in" defaultChecked={initial?.values.notesVisibility === 'signed_in'} className="accent-primary" />
                  登入的學生與老師
                </label>
              </div>
            </fieldset>
            <p className="mt-1 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground sm:col-span-2">
              <IconLock className="size-3.5" /> 以下只有你（負責老師）與系辦看得到，不會因為發布而公開。
            </p>
            {field('address', { span: true })}
            {field('contactName')}
            {field('contactPhone', { type: 'tel' })}
            {field('contactEmail', { type: 'email', span: true })}
          </div>
          <div className="flex flex-col gap-3 border-t border-border px-6 py-4">
            <Feedback state={state?.ok ? undefined : state} />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">發布後登入的學生與老師看得到；聯絡資訊仍只有你與系辦看得到。</span>
              {editing ? (
                <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
                  {pending ? '處理中…' : '儲存修改'}
                </button>
              ) : (
                <>
                  <button type="submit" name="publish" value="false" disabled={pending} className={cn(OUTLINE_BUTTON_SM, 'h-11 px-4 text-sm')}>
                    儲存草稿
                  </button>
                  <button type="submit" name="publish" value="true" disabled={pending} className={PRIMARY_BUTTON}>
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

/** 「發布」「下架」「重新發布」：先開確認對話框說清楚會發生什麼，再送出。 */
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
      <button
        type="button"
        className={cn(GHOST_BUTTON, 'h-7 px-2.5 text-[0.8rem]')}
        onClick={dialog.open}
        aria-label={`${label}：${name}`}
      >
        {label}
      </button>
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label={`${label}「${name}」`} className={DIALOG}>
        <form action={action} className="relative flex flex-col gap-4 p-6">
          <CloseX onClick={dialog.close} />
          <div className="pr-8">
            <h2 className="text-lg font-extrabold text-foreground">
              {label}「{name}」？
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{explain}</p>
          </div>
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <input type="hidden" name="revision" value={revision} />
          <input type="hidden" name="kind" value={kind === 'withdraw' ? 'withdraw' : 'publish'} />
          <input type="hidden" name="requestId" value={requestId} />
          <Feedback state={state?.ok ? undefined : state} />
          <button type="submit" disabled={pending} className={cn(PRIMARY_BUTTON, 'w-full')}>
            {pending ? '處理中…' : `確認${label}`}
          </button>
        </form>
      </dialog>
    </>
  )
}

/**
 * 一案的「連結的組別」格：每組一顆「解除」；案主解除時理由必填，該組組員與案主會收到通知。
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
    <div className="min-w-0 text-xs text-muted-foreground">
      {links.length === 0 ? (
        <span>尚無組別連結</span>
      ) : (
        <ul className="flex flex-col gap-1">
          {links.map((l) => (
            <li key={l.linkId} className="flex flex-wrap items-center gap-2">
              <span className="tabular truncate font-semibold text-foreground">
                {l.cohortCode}・{l.groupCode}
              </span>
              <button
                type="button"
                className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
      {state?.ok ? (
        <div className="mt-2">
          <Feedback state={state} />
        </div>
      ) : null}
      <dialog ref={dialog.ref} aria-label={`解除 ${target?.groupCode ?? ''} 的連結`} className={DIALOG}>
        <form onSubmit={submitWithoutReset(action)} className="relative flex flex-col gap-4 p-6">
          <CloseX onClick={dialog.close} />
          <div className="pr-8">
            <h2 className="text-lg font-extrabold text-foreground">
              解除 {target?.groupCode} 與「{opportunityName}」的連結
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">解除後該組組員與案主會收到通知；歷程保留解除原因。</p>
          </div>
          <input type="hidden" name="linkId" value={target?.linkId ?? ''} />
          <input type="hidden" name="requestId" value={`${requestId}`} />
          <div className="flex flex-col gap-1.5">
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
              className={TEXTAREA}
            />
          </div>
          <Feedback state={state?.ok ? undefined : state} />
          <button type="submit" disabled={pending || !target} className={cn(PRIMARY_BUTTON, 'w-full')}>
            {pending ? '處理中…' : '確認解除'}
          </button>
        </form>
      </dialog>
    </div>
  )
}
