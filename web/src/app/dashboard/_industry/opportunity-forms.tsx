'use client'
import {
  createContext,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import type { NormalizedOpportunity, OpportunityField } from '@/application/groups'
import { IconEyeOff, IconPlus, IconTrash } from '@tabler/icons-react'
import { ALERT, BTN_OUTLINE_TALL, BTN_ROW, BTN_ROW_GHOST, BTN_SUBMIT, DIALOG, DIALOG_TITLE, INPUT as INPUT_BASE, NOTE, TEXTAREA } from '@/app/_ui/dashboard/look'
import { buttonVariants } from '@/app/_ui/ui/button'
import { cn } from '@/shared/cn'
import { changeOpportunityStatusAction, deleteOpportunityAction, saveOpportunityAction, unlinkOpportunityAction } from './actions'

/**
 * 合作案管理會動的部分（票 20；原型 `IndustryFormDialog`）：新增／編輯對話框、發布／下架／重新發布、解除連結；
 * 第三波 W11：系辦新增時從選單指定負責老師、刪除（危險操作）。
 *
 * 規則全在用例裡判；這裡只顯示伺服器回來的句子。欄位出錯時伺服器回是哪一欄，對話框把焦點移過去並標紅。
 * 原型的「網際網路公開（含聯絡資訊）」選項不做（產品 6.1：合作案一律登入後可見，聯絡資訊只有負責老師與系辦）。
 */

export type IndustryActionState = { ok: boolean; message: string; field?: string } | undefined

// 外觀照原型 `industry-form.tsx`（票 36）：h-11 輸入框、橘色主要動作、白框次要動作、原型 Dialog 的圓角與遮罩。
const PRIMARY = BTN_SUBMIT
const SECONDARY = BTN_OUTLINE_TALL
const ROW_BUTTON = BTN_ROW
const ROW_GHOST = BTN_ROW_GHOST
const INPUT = `mt-1.5 ${INPUT_BASE} h-11`
const AREA = `mt-1.5 ${TEXTAREA}`
const LABEL = 'block text-sm font-semibold text-foreground'
const DIALOG_BOX = DIALOG['2xl']
const DIALOG_SMALL = DIALOG.md
// 危險操作（第三波 §9 規則 1）：淡紅、跟日常按鈕分開。
const DANGER = buttonVariants({ variant: 'destructive', size: 'sm', className: 'press rounded-lg' })
const DANGER_SUBMIT = buttonVariants({ variant: 'destructive', size: 'lg', className: 'press h-11 rounded-lg px-5' })

export function IndustryFeedback({ state }: { state: IndustryActionState }) {
  if (!state) return null
  return (
    <p role={state.ok ? 'status' : 'alert'} className={state.ok ? NOTE : ALERT}>
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

/** 系辦新增時的負責老師選項（帳號正常、目前是老師）。 */
export type OwnerTeacherOption = { readonly userId: string; readonly name: string; readonly loginEmail: string }

/**
 * 新增（老師、系辦）或編輯（案主、系辦）合作案。`initial` 沒給就是新增：可以「儲存草稿」或「儲存並發布」。
 * 私有欄位區塊標「只有負責老師與系辦看得到」。
 * 有 `teachers`＝系辦新增：第一欄是負責老師選單（必填）；老師自己新增不給，負責老師由登入帳號帶入。
 */
export function OpportunityFormDialog({
  labels,
  requestId,
  initial,
  teachers,
}: {
  labels: OpportunityFormLabels
  requestId: string
  initial?: Initial
  teachers?: readonly OwnerTeacherOption[]
}) {
  const [state, action, pending] = useActionState(saveOpportunityAction, undefined)
  const dialog = useDialog()
  const [version, setVersion] = useState(0)
  const formRef = useRef<HTMLFormElement>(null)
  const editing = Boolean(initial)
  const pickOwner = !editing && teachers !== undefined
  const ownerInvalid = !state?.ok && state?.field === 'ownerTeacherUserId'

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
      className: cn(options.textarea ? AREA : INPUT, invalid && 'border-destructive', options.textarea && 'resize-y'),
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
      {editing ? (
        <button type="button" className={ROW_BUTTON} onClick={dialog.open} aria-label={`編輯：${initial!.name}`}>
          編輯
        </button>
      ) : (
        <button type="button" className="btn-fju h-10 px-4 text-sm" onClick={dialog.open}>
          <IconPlus className="size-4" aria-hidden />
          新增合作案
        </button>
      )}
      {state?.ok ? (
        <span className="sr-only" role="status">
          {state.message}
        </span>
      ) : null}
      <dialog ref={dialog.ref} aria-label={editing ? `編輯合作案：${initial!.name}` : '新增合作案'} className={DIALOG_BOX}>
        <form ref={formRef} key={`${initial?.revision ?? 0}-${version}`} onSubmit={submitWithoutReset(action)} className="flex flex-col">
          <div className="border-b border-border px-6 py-4">
            <h2 className={DIALOG_TITLE}>{editing ? '編輯合作案' : '新增合作案'}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {pickOwner ? '負責老師從選單選，發布日由系統帶入。' : '負責老師與發布日由系統帶入。'}
              <span className="text-destructive">*</span> 為必填。內容可以分段落，直接換行即可。
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
            {pickOwner ? (
              <div className="sm:col-span-2">
                <label htmlFor="opp-new-ownerTeacherUserId" className={LABEL}>
                  負責老師<span className="ml-0.5 text-destructive">*</span>
                </label>
                <select
                  id="opp-new-ownerTeacherUserId"
                  name="ownerTeacherUserId"
                  defaultValue=""
                  aria-invalid={ownerInvalid || undefined}
                  aria-describedby="opp-new-owner-hint"
                  className={cn(INPUT, ownerInvalid && 'border-destructive')}
                >
                  <option value="" disabled>
                    請選負責老師
                  </option>
                  {teachers!.map((t) => (
                    <option key={t.userId} value={t.userId}>
                      {t.name}（{t.loginEmail}）
                    </option>
                  ))}
                </select>
                <p id="opp-new-owner-hint" className="mt-1 text-xs text-muted-foreground">
                  {teachers!.length === 0
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
                  <input type="radio" className="accent-brand" name="notesVisibility" value="internal" defaultChecked={(initial?.values.notesVisibility ?? 'internal') === 'internal'} />
                  只有我與系辦
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" className="accent-brand" name="notesVisibility" value="signed_in" defaultChecked={initial?.values.notesVisibility === 'signed_in'} />
                  登入的學生與老師
                </label>
              </div>
            </fieldset>
            <p className="mt-1 rounded-lg bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground sm:col-span-2">
              以下只有你（負責老師）與系辦看得到，不會因為發布而公開。
            </p>
            {field('address', { span: true })}
            {field('contactName')}
            {field('contactPhone', { type: 'tel' })}
            {field('contactEmail', { type: 'email', span: true })}
          </div>
          <div className="space-y-3 border-t border-border px-6 py-4">
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
      <button type="button" className={ROW_BUTTON} onClick={dialog.open} aria-label={`${label}：${name}`}>
        {label}
      </button>
      <IndustryFeedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label={`${label}「${name}」`} className={DIALOG_SMALL}>
        <form action={action} className="space-y-4 p-5">
          <h2 className={DIALOG_TITLE}>
            {label}「{name}」？
          </h2>
          <p className="text-sm text-muted-foreground">{explain}</p>
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <input type="hidden" name="revision" value={revision} />
          <input type="hidden" name="kind" value={kind === 'withdraw' ? 'withdraw' : 'publish'} />
          <input type="hidden" name="requestId" value={requestId} />
          <IndustryFeedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 pt-1">
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
  header,
}: {
  links: readonly { linkId: string; groupCode: string; cohortCode: string }[]
  /** 格子最上面一行（系辦頁放負責老師；原型的中間欄）。 */
  header?: React.ReactNode
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
      {header}
      <p className="sr-only">連結的組別</p>
      {links.length === 0 ? (
        <span className="inline-flex items-center gap-1">
          <IconEyeOff className="size-3.5" aria-hidden />
          尚無組別連結
        </span>
      ) : (
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={l.linkId} className="flex flex-wrap items-center gap-2">
              <span className="truncate font-semibold text-foreground tabular-nums">
                {l.cohortCode}・{l.groupCode}
              </span>
              <button
                type="button"
                className={ROW_GHOST}
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
      <dialog ref={dialog.ref} aria-label={`解除 ${target?.groupCode ?? ''} 的連結`} className={DIALOG_SMALL}>
        <form onSubmit={submitWithoutReset(action)} className="space-y-4 p-5">
          <div>
            <h2 className={DIALOG_TITLE}>
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
              className={AREA}
            />
          </div>
          <IndustryFeedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 pt-1">
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

/**
 * 刪除成功後那一列會從清單消失、掛在列上的回饋跟著不見，所以成功句子放到清單外（同時間軸頁的做法）。
 */
const SetOpportunityNotice = createContext<(state: IndustryActionState) => void>(() => {})
const OpportunityNoticeValue = createContext<IndustryActionState>(undefined)

export function OpportunityNoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<IndustryActionState>(undefined)
  return (
    <SetOpportunityNotice.Provider value={setNotice}>
      <OpportunityNoticeValue.Provider value={notice}>{children}</OpportunityNoticeValue.Provider>
    </SetOpportunityNotice.Provider>
  )
}

export function OpportunityNotice() {
  return <IndustryFeedback state={useContext(OpportunityNoticeValue)} />
}

/**
 * 刪除合作案（第三波 W11；系辦）：只限草稿或已下架、沒連組別。不能刪的（`blocker`，查詢層依同一條規則算好）
 * 一樣有這顆按鈕，對話框只說明要先做什麼（§9 規則 4）；規則以伺服器為準。
 * 可以刪的走危險操作確認：寫清楚對象、後果、不能恢復，確認鈕寫動作。
 */
export function DeleteOpportunityButton({
  opportunityId,
  revision,
  name,
  ownerName,
  statusLabel,
  blocker,
  requestId,
}: {
  opportunityId: string
  revision: number
  name: string
  ownerName: string
  statusLabel: string
  blocker: string | null
  requestId: string
}) {
  const setNotice = useContext(SetOpportunityNotice)
  const [state, action, pending] = useActionState(async (prev: IndustryActionState, formData: FormData) => {
    const result = await deleteOpportunityAction(prev, formData)
    setNotice(result?.ok ? result : undefined)
    return result
  }, undefined)
  const dialog = useDialog()
  useEffect(() => {
    if (state?.ok) dialog.close()
  }, [state, dialog])

  return (
    <>
      <button type="button" className={DANGER} onClick={dialog.open} aria-label={`刪除：${name}`}>
        <IconTrash aria-hidden />
        刪除
      </button>
      <dialog ref={dialog.ref} aria-label={blocker ? `還不能刪除「${name}」` : `刪除「${name}」`} className={DIALOG_SMALL}>
        {blocker ? (
          <div className="space-y-4 p-5">
            <h2 className={DIALOG_TITLE}>還不能刪除「{name}」</h2>
            <p className="text-sm text-muted-foreground">{blocker}</p>
            <div className="flex justify-end pt-1">
              <button type="button" className={SECONDARY} onClick={dialog.close}>
                知道了
              </button>
            </div>
          </div>
        ) : (
          <form action={action} className="space-y-4 p-5">
            <h2 className={DIALOG_TITLE}>刪除「{name}」？</h2>
            <dl className="space-y-1 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
              <div>
                <dt className="inline font-semibold">對象：</dt>
                <dd className="inline">
                  {name}（{ownerName} 老師負責，{statusLabel}）
                </dd>
              </div>
              <div>
                <dt className="inline font-semibold">後果：</dt>
                <dd className="inline">從系辦「合作案」、負責老師的「我的合作案」與前台合作案頁消失。</dd>
              </div>
              <div>
                <dt className="inline font-semibold">能不能恢復：</dt>
                <dd className="inline">不能。刪除紀錄會留在操作紀錄。</dd>
              </div>
            </dl>
            <input type="hidden" name="opportunityId" value={opportunityId} />
            <input type="hidden" name="revision" value={revision} />
            <input type="hidden" name="requestId" value={requestId} />
            <IndustryFeedback state={state?.ok ? undefined : state} />
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className={SECONDARY} onClick={dialog.close}>
                先不要
              </button>
              <button type="submit" disabled={pending} className={DANGER_SUBMIT}>
                {pending ? '處理中…' : '刪除這個合作案'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  )
}
