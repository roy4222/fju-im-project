'use client'
import {
  createContext,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import type { NormalizedOpportunity } from '@/application/groups'
import { IconEyeOff, IconPlus, IconTrash } from '@tabler/icons-react'
import { ALERT, BTN_OUTLINE_TALL, BTN_ROW, BTN_ROW_GHOST, BTN_SUBMIT, DIALOG, DIALOG_TITLE, NOTE, TEXTAREA } from '@/app/_ui/dashboard/look'
import { buttonVariants } from '@/app/_ui/ui/button'
import { CharCount, charCountId } from '@/app/_ui/char-count'
import { changeOpportunityStatusAction, deleteOpportunityAction, saveOpportunityAction, unlinkOpportunityAction } from './actions'
import { OpportunityFormBody, type OpportunityFormLabels, type OwnerTeacherOption } from './front-edit/opportunity'

export type { OpportunityFormLabels, OwnerTeacherOption } from './front-edit/opportunity'

/**
 * 合作案管理會動的部分（票 20；原型 `IndustryFormDialog`）：新增／編輯對話框、發布／下架／重新發布、解除連結；
 * 第三波 W11：系辦新增時從選單指定負責老師、刪除。
 * C3-10：欄位格抽成 `OpportunityFormBody`（`./front-edit/opportunity.tsx`，前台直接編輯的延遲模組共用同一份）；
 * 刪除改成每列一顆，不能刪的直接 disabled 寫原因（§6.5）；解除連結理由選填。
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
const AREA = `mt-1.5 ${TEXTAREA}`
const LABEL = 'block text-sm font-semibold text-foreground'
const DIALOG_BOX = DIALOG['2xl']
const DIALOG_SMALL = DIALOG.md
// 刪除（第三波 §9 規則 1）：淡紅、跟日常按鈕分開；不能刪時 disabled、旁邊寫原因（C3-10 §6.5）。
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
  // 回傳值要穩定：每次 render 都給新物件的話，依賴它的 effect 每次都重跑（新建合作案後會無限重繪，網站問題 #1）。
  return useMemo(() => ({ ref, open, close }), [open, close])
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

  useEffect(() => {
    if (state?.ok) {
      dialog.close()
      if (!editing) setVersion((v) => v + 1)
    } else if (state?.field) {
      formRef.current?.querySelector<HTMLElement>(`[name="${state.field}"]`)?.focus()
    }
    // 只看 action 回傳：dialog、editing 從這次 render 讀就對了，放進依賴會在 setVersion 重繪後再跑一次。
  }, [state])

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
            <OpportunityFormBody
              labels={labels}
              values={initial?.values ?? null}
              teachers={pickOwner ? teachers : undefined}
              invalidField={!state?.ok ? state?.field : null}
              idPrefix={`opp-${initial?.opportunityId ?? 'new'}`}
            />
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
 * 一案的「連結的組別」格：每組一顆「解除」；案主或系辦解除時理由可不填（C3-10），該組組員與案主會收到通知。
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
  /** `cohortLabel`：屆別顯示名稱「名稱（代碼）」，由伺服器端算好。 */
  links: readonly { linkId: string; groupCode: string; cohortLabel: string }[]
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
                {l.cohortLabel}・{l.groupCode}
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
              理由（可不填）
            </label>
            <textarea
              id={`unlink-reason-${requestId}`}
              name="reason"
              rows={3}
              aria-describedby={charCountId(`unlink-reason-${requestId}`)}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例：企業暫停這個題目"
              className={AREA}
            />
            <CharCount forId={`unlink-reason-${requestId}`} max={reasonMaxLength} value={reason} />
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
 * 這顆按鈕 disabled、旁邊直接寫原因（C3-10 §6.5；不再跳「還不能刪除」對話框）；規則以伺服器為準。
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

  if (blocker) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button type="button" className={DANGER} disabled aria-label={`刪除：${name}`} aria-describedby={`${requestId}-delete-blocker`} title={blocker}>
          <IconTrash aria-hidden />
          刪除
        </button>
        <span id={`${requestId}-delete-blocker`} className="text-xs text-muted-foreground">
          {blocker}
        </span>
      </span>
    )
  }

  return (
    <>
      <button type="button" className={DANGER} onClick={dialog.open} aria-label={`刪除：${name}`}>
        <IconTrash aria-hidden />
        刪除
      </button>
      <dialog ref={dialog.ref} aria-label={`刪除「${name}」`} className={DIALOG_SMALL}>
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
      </dialog>
    </>
  )
}
