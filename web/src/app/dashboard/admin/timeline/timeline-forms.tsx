'use client'
import { createContext, useActionState, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react'
import {
  createActivityAction,
  deleteActivityAction,
  saveScheduleAction,
  updateActivityAction,
} from './actions'
import { ActivityFormBody, EMPTY_ACTIVITY, type ActivityDraft, type ActivityLimits } from './front-edit/activity'
import { BTN_OUTLINE, BTN_PRIMARY, DIALOG, INPUT as KIT_INPUT, TEXTAREA as KIT_TEXTAREA } from '@/app/_ui/dashboard-kit'
import { buttonVariants } from '@/app/_ui/ui/button'
import { cn } from '@/shared/cn'

/**
 * 時間軸頁會動的部分（票 11）：階段、新增活動、編輯活動、刪除活動。
 * ③ C3-06：活動有「開始日」「結束日」可以跨日；畫面不再提供「取消活動」，每列直接「刪除」。
 * ③ C3-08：階段改成點甘特色塊開 `StageEditDialog`（一次改一段，整組送出）；「編輯階段與日期」整份對話框拿掉，
 * 只在這一屆還沒設階段時留 `ScheduleSetup`（「設定階段與日期」，四段一起填）——一段都沒有就沒有色塊可點。
 * 活動表單本體 `ActivityFormBody` 在 `front-edit/activity.tsx`（前台直接編輯共用），這裡的 `ActivityForm` 包上送出。
 *
 * 回饋一律是**伺服器**回的句子；瀏覽器端不判斷任何規則（開始日要不要遞增是用例說了算）。
 * 欄位用受控元件：送出失敗時剛填的值還在，不用整份重打。
 */

export type TimelineActionState = { ok: boolean; message: string } | undefined
export type { ActivityDraft, ActivityLimits, AudienceOption } from './front-edit/activity'

// 外觀照原型（票 35）：輸入框、按鈕與對話框跟原型 `stage-edit-dialog` 一樣。
const INPUT = cn(KIT_INPUT, 'mt-1.5')
const TEXTAREA = cn(KIT_TEXTAREA, 'mt-1.5')
const LABEL = 'block text-sm font-semibold'
const PRIMARY = BTN_PRIMARY
const SECONDARY = BTN_OUTLINE
// 危險操作（第三波 §9 規則 1）：淡紅、跟日常按鈕分開。
const DANGER = buttonVariants({ variant: 'destructive', size: 'lg', className: 'press rounded-lg px-3 font-semibold' })

export function Feedback({ state }: { state: TimelineActionState }) {
  if (!state) return null
  return (
    <p
      role={state.ok ? 'status' : 'alert'}
      className={cn(
        'rounded-lg px-3 py-2 text-sm font-semibold',
        state.ok ? 'bg-success-subtle text-success-on-subtle' : 'bg-destructive-subtle text-destructive-on-subtle',
      )}
    >
      {state.message}
    </p>
  )
}

/** 原生 `<dialog>`：自帶 modal、Esc 關閉與焦點鎖。成功時由呼叫端關掉。 */
export function useDialog() {
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
  wide = false,
  onClose,
}: {
  dialog: ReturnType<typeof useDialog>
  title: string
  description?: string
  children: ReactNode
  wide?: boolean
  onClose?: () => void
}) {
  return (
    <dialog
      ref={dialog.ref}
      aria-label={title}
      onClose={onClose}
      className={cn(DIALOG, wide ? 'w-[min(48rem,calc(100vw-2rem))]' : 'w-[min(36rem,calc(100vw-2rem))]')}
    >
      <div className="px-6 py-5">
        <h2 className="text-lg font-extrabold">{title}</h2>
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

/**
 * 每次打開都換一份新表單：`openKey` 當表單的 `key`（初值重新從最新資料帶、請求編號重新產生）。
 * 表單只在打開過之後才掛上：請求編號在瀏覽器端產生，不進 SSR（伺服器與瀏覽器各產一個會對不上）。
 */
function useFreshDialog() {
  const dialog = useDialog()
  const show = dialog.open
  const [openKey, setOpenKey] = useState(0)
  const open = useCallback(() => {
    setOpenKey((k) => k + 1)
    show()
  }, [show])
  return { ref: dialog.ref, close: dialog.close, open, openKey }
}

// ── 階段與日期 ──────────────────────────────────────────────────────────────

/** 第 1 階段（分組期）在做什麼（Q40）：階段清單與編輯視窗都固定顯示；不改資料庫裡的階段名稱。 */
export const GROUPING_PERIOD_HINT = '分組期：組隊、選指導老師、交提案的期間'

export type StageDraft = { name: string; startDate: string; description: string }

export type StageEditorProps = {
  cohortId: string
  cohortLabel: string
  revision: number
  stages: StageDraft[]
  yearEndDate: string
  nameMaxLength: number
  descriptionMaxLength: number
}

/** 一段的三個欄位（名稱、開始日、一句話說明）；`draft` 受控。 */
function StageFields({
  seq,
  stage,
  onChange,
  nameMaxLength,
  descriptionMaxLength,
}: {
  seq: number
  stage: StageDraft
  onChange: (patch: Partial<StageDraft>) => void
  nameMaxLength: number
  descriptionMaxLength: number
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
      <div>
        <label htmlFor={`stage${seq}-name`} className={LABEL}>
          第 {seq} 階段名稱
        </label>
        <input
          id={`stage${seq}-name`}
          name={`stage${seq}.name`}
          value={stage.name}
          onChange={(e) => onChange({ name: e.target.value })}
          maxLength={nameMaxLength}
          required
          autoComplete="off"
          placeholder="例：系統驗收"
          className={INPUT}
        />
        {seq === 1 ? <p className="mt-1 text-xs text-muted-foreground">{GROUPING_PERIOD_HINT}</p> : null}
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
          onChange={(e) => onChange({ startDate: e.target.value })}
          required
          className={INPUT}
        />
      </div>
      {/* 原型 stage-edit-dialog 的「一句話說明」（0011，票 39）：學生的階段卡片上顯示。 */}
      <div className="sm:col-span-2">
        <label htmlFor={`stage${seq}-description`} className={LABEL}>
          第 {seq} 階段一句話說明 <span className="text-xs font-normal text-muted-foreground">選填</span>
        </label>
        <textarea
          id={`stage${seq}-description`}
          name={`stage${seq}.description`}
          rows={2}
          value={stage.description}
          onChange={(e) => onChange({ description: e.target.value })}
          maxLength={descriptionMaxLength}
          placeholder="這階段要做什麼，學生會在卡片上看到。"
          className={TEXTAREA}
        />
      </div>
    </div>
  )
}

function YearEndField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="sm:w-44">
      <label htmlFor="year-end-date" className={LABEL}>
        年度結束日
      </label>
      <input
        id="year-end-date"
        name="yearEndDate"
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className={INPUT}
      />
    </div>
  )
}

/** 整組送出時不在畫面上的那幾段：照目前存的值放隱藏欄位。 */
function HiddenStage({ seq, stage }: { seq: number; stage: StageDraft }) {
  return (
    <>
      <input type="hidden" name={`stage${seq}.name`} value={stage.name} />
      <input type="hidden" name={`stage${seq}.startDate`} value={stage.startDate} />
      <input type="hidden" name={`stage${seq}.description`} value={stage.description} />
    </>
  )
}

function StageSubmitRow({ pending, onCancel }: { pending: boolean; onCancel: () => void }) {
  return (
    <div className="flex justify-end gap-2 border-t border-border pt-4">
      <button type="button" className={SECONDARY} onClick={onCancel}>
        先不改
      </button>
      <button type="submit" disabled={pending} className={PRIMARY}>
        {pending ? '處理中…' : '儲存'}
      </button>
    </div>
  )
}

/**
 * 這一屆還沒設階段時的「設定階段與日期」：四段與年度結束日一起填（一段都沒有時甘特沒有色塊可點）。
 * 設好之後按鈕收起來，元件留在原處，儲存成功的句子不會跟著頁面換版消失。
 */
export function ScheduleSetup({ configured, ...editor }: StageEditorProps & { configured: boolean }) {
  const [state, formAction, pending] = useActionState(saveScheduleAction, undefined)
  const dialog = useFreshDialog()
  useCloseOnSuccess(state, dialog.close)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {state?.ok ? <Feedback state={state} /> : null}
      {configured ? null : (
        <button type="button" className={cn(PRIMARY, 'h-11 px-5')} onClick={dialog.open}>
          <IconPencil aria-hidden /> 設定階段與日期
        </button>
      )}
      <Dialog
        dialog={dialog}
        wide
        title={`設定 ${editor.cohortLabel} 的階段與日期`}
        description="每個階段只填開始日，要一段比一段晚；下一段開始那天 00:00 起就換段。年度結束日當天仍算在年度內。之後點甘特上的階段色塊一段一段改。"
      >
        {dialog.openKey > 0 ? (
          <ScheduleSetupForm key={dialog.openKey} {...editor} state={state} formAction={formAction} pending={pending} onCancel={dialog.close} />
        ) : null}
      </Dialog>
    </div>
  )
}

function ScheduleSetupForm({
  cohortId,
  revision,
  stages,
  yearEndDate,
  nameMaxLength,
  descriptionMaxLength,
  state,
  formAction,
  pending,
  onCancel,
}: StageEditorProps & {
  state: TimelineActionState
  formAction: (formData: FormData) => void
  pending: boolean
  onCancel: () => void
}) {
  const [draft, setDraft] = useState({ stages, yearEndDate })
  const [requestId] = useState(() => crypto.randomUUID())
  const setStage = (index: number, patch: Partial<StageDraft>) =>
    setDraft((d) => ({ ...d, stages: d.stages.map((s, i) => (i === index ? { ...s, ...patch } : s)) }))
  return (
    <form action={formAction} className="grid gap-5 md:grid-cols-[minmax(0,1fr)_240px]">
      <input type="hidden" name="cohortId" value={cohortId} />
      <input type="hidden" name="revision" value={revision} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="flex flex-col gap-4">
        <ol className="flex flex-col gap-3">
          {draft.stages.map((stage, index) => (
            <li key={index}>
              <StageFields
                seq={index + 1}
                stage={stage}
                onChange={(patch) => setStage(index, patch)}
                nameMaxLength={nameMaxLength}
                descriptionMaxLength={descriptionMaxLength}
              />
            </li>
          ))}
        </ol>
        <YearEndField value={draft.yearEndDate} onChange={(value) => setDraft((d) => ({ ...d, yearEndDate: value }))} />
        <Feedback state={state?.ok ? undefined : state} />
        <StageSubmitRow pending={pending} onCancel={onCancel} />
      </div>
      {/* 原型 stage-edit-dialog 右欄：學生看到的樣子（只看畫面上正在填的值）。 */}
      <aside className="flex flex-col gap-3 rounded-xl bg-muted/40 p-4" aria-label="學生看到的樣子">
        <p className="text-[11px] font-bold tracking-[0.06em] text-muted-foreground">學生看到的樣子</p>
        <ol className="flex flex-col gap-2">
          {draft.stages.map((stage, index) => {
            const next = draft.stages[index + 1]
            const last = next?.startDate ? dayBefore(next.startDate) : draft.yearEndDate
            return (
              <li key={index} className="dash-card px-3.5 py-2.5">
                <p className="text-[11px] font-bold tracking-[0.06em] text-muted-foreground tabular-nums">第 {index + 1} 階段</p>
                <p className="mt-0.5 text-[15px] font-extrabold tracking-tight">
                  {stage.name.trim() || <span className="text-muted-foreground">階段名稱</span>}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {stage.startDate || '—'} – {last || '—'}
                </p>
                {stage.description.trim() ? <p className="mt-1 text-xs leading-relaxed">{stage.description.trim()}</p> : null}
              </li>
            )
          })}
        </ol>
      </aside>
    </form>
  )
}

/** 預覽用：前一天（只拿來顯示「這一段到哪天」，規則仍由伺服器判）。 */
function dayBefore(date: string) {
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * 點甘特上的階段色塊開的「編輯第 n 階段」（③ §9.4）：名稱、一句話說明、開始日，第 4 段多「年度結束日」。
 * 其他三段照目前存的值放隱藏欄位，整組送 `saveScheduleAction`（不經拖拉的確認框）；開始日不遞增等錯誤句由用例回。
 * 只在打開時掛上（`seq` 有值）；成功呼叫 `onSaved` 交出伺服器句子、關窗。
 */
export function StageEditDialog({
  seq,
  onClose,
  onSaved,
  ...live
}: StageEditorProps & { seq: number; onClose: () => void; onSaved: (state: TimelineActionState) => void }) {
  // 打開那一刻的四段與 revision：開著時資料換版也不跟著換，別人改過就由用例回 CONFLICT，不默默蓋掉。
  const [editor] = useState(live)
  const [state, formAction, pending] = useActionState(saveScheduleAction, undefined)
  const ref = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState({ stage: editor.stages[seq - 1] ?? { name: '', startDate: '', description: '' }, yearEndDate: editor.yearEndDate })
  const [requestId] = useState(() => crypto.randomUUID())
  const last = seq === editor.stages.length

  useEffect(() => {
    const el = ref.current
    if (el && !el.open) el.showModal()
  }, [])
  useEffect(() => {
    if (!state?.ok) return
    onSaved(state)
    ref.current?.close()
  }, [state, onSaved])

  return (
    <dialog ref={ref} aria-label={`編輯第 ${seq} 階段`} onClose={onClose} className={cn(DIALOG, 'w-[min(36rem,calc(100vw-2rem))]')}>
      <div className="px-6 py-5">
        <h2 className="text-lg font-extrabold">編輯第 {seq} 階段</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {editor.cohortLabel}・開始日要比前一段晚、比下一段早；下一段開始那天 00:00 起就換段。
        </p>
        <form action={formAction} className="mt-4 flex flex-col gap-4">
          <input type="hidden" name="cohortId" value={editor.cohortId} />
          <input type="hidden" name="revision" value={editor.revision} />
          <input type="hidden" name="requestId" value={requestId} />
          {editor.stages.map((stage, index) =>
            index + 1 === seq ? (
              <StageFields
                key={index}
                seq={seq}
                stage={draft.stage}
                onChange={(patch) => setDraft((d) => ({ ...d, stage: { ...d.stage, ...patch } }))}
                nameMaxLength={editor.nameMaxLength}
                descriptionMaxLength={editor.descriptionMaxLength}
              />
            ) : (
              <HiddenStage key={index} seq={index + 1} stage={stage} />
            ),
          )}
          {last ? (
            <YearEndField value={draft.yearEndDate} onChange={(value) => setDraft((d) => ({ ...d, yearEndDate: value }))} />
          ) : (
            <input type="hidden" name="yearEndDate" value={editor.yearEndDate} />
          )}
          <Feedback state={state?.ok ? undefined : state} />
          <StageSubmitRow pending={pending} onCancel={() => ref.current?.close()} />
        </form>
      </div>
    </dialog>
  )
}

// ── 活動 ────────────────────────────────────────────────────────────────────

/**
 * 新增或編輯一個活動的表單（欄位格＋送出）。系辦時程頁三個地方共用：分頁列「新增活動」、清單每列「編輯」、
 * 甘特點空白處與橫條開的視窗（`gantt-mount.tsx`）。每次打開都重新掛上（呼叫端給 `key`），初值與請求編號都是新的。
 * 成功呼叫 `onSuccess` 交出伺服器句子；失敗句留在表單裡。
 */
export function ActivityForm({
  target,
  initial,
  idPrefix,
  submitLabel,
  onSuccess,
  onCancel,
  limits,
}: {
  target: { kind: 'create'; cohortId: string } | { kind: 'edit'; activityId: string; revision: number }
  initial: ActivityDraft
  idPrefix: string
  submitLabel: string
  onSuccess: (state: TimelineActionState) => void
  onCancel: () => void
  limits: ActivityLimits
}) {
  // 打開那一刻的對象與 revision：開著時資料換版（refresh）也不跟著換，過期就由用例回 CONFLICT。
  const [frozen] = useState(target)
  const [state, formAction, pending] = useActionState(frozen.kind === 'create' ? createActivityAction : updateActivityAction, undefined)
  const [draft, setDraft] = useState(initial)
  const [requestId] = useState(() => crypto.randomUUID())
  useEffect(() => {
    if (state?.ok) onSuccess(state)
  }, [state, onSuccess])
  return (
    <form action={formAction} className="space-y-4">
      {frozen.kind === 'create' ? (
        <input type="hidden" name="cohortId" value={frozen.cohortId} />
      ) : (
        <>
          <input type="hidden" name="activityId" value={frozen.activityId} />
          <input type="hidden" name="revision" value={frozen.revision} />
        </>
      )}
      <input type="hidden" name="requestId" value={requestId} />
      <ActivityFormBody idPrefix={idPrefix} draft={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} {...limits} />
      <Feedback state={state?.ok ? undefined : state} />
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <button type="button" className={SECONDARY} onClick={onCancel}>
          {frozen.kind === 'create' ? '先不加' : '先不改'}
        </button>
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? '處理中…' : submitLabel}
        </button>
      </div>
    </form>
  )
}

export const CREATE_ACTIVITY_DESCRIPTION = '說明會、成果發表這類活動。作業截止不用在這裡加，會從作業自動帶進日曆。'
export const EDIT_ACTIVITY_DESCRIPTION = '同一個活動換日期或內容，不是刪掉重建；異動會留紀錄。'

/** 新增活動用的空白初值：日期預填 `date`、單日。 */
export function newActivityDraft(date: string, allDay = false): ActivityDraft {
  return { ...EMPTY_ACTIVITY, startDate: date, endDate: date, allDay }
}

/**
 * 分頁列右側「新增活動」（③ §9.4）：開對話框，日期預填今天；成功就關掉對話框，回饋留在按鈕旁邊。
 */
export function CreateActivityForm({ cohortId, today, ...limits }: { cohortId: string; today: string } & ActivityLimits) {
  const [done, setDone] = useState<TimelineActionState>(undefined)
  const dialog = useFreshDialog()
  const close = dialog.close
  const onSuccess = useCallback(
    (state: TimelineActionState) => {
      setDone(state)
      close()
    },
    [close],
  )

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Feedback state={done} />
      <button type="button" className={PRIMARY} onClick={dialog.open}>
        <IconPlus aria-hidden /> 新增活動
      </button>
      <Dialog dialog={dialog} wide title="新增活動" description={CREATE_ACTIVITY_DESCRIPTION}>
        {dialog.openKey > 0 ? (
          <ActivityForm
            key={dialog.openKey}
            target={{ kind: 'create', cohortId }}
            initial={newActivityDraft(today)}
            idPrefix="new-activity"
            submitLabel="建立活動"
            onSuccess={onSuccess}
            onCancel={close}
            limits={limits}
          />
        ) : null}
      </Dialog>
    </div>
  )
}

/**
 * 活動清單上方的回饋區：刪除成功後那一列會從清單消失，掛在列上的回饋會跟著卸載，
 * 所以刪除的成功句子放到清單外、「活動清單」卡片裡的上方。
 */
const SetActivityNotice = createContext<(state: TimelineActionState) => void>(() => {})
const ActivityNoticeValue = createContext<TimelineActionState>(undefined)

export function ActivityNoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<TimelineActionState>(undefined)
  return (
    <SetActivityNotice.Provider value={setNotice}>
      <ActivityNoticeValue.Provider value={notice}>{children}</ActivityNoticeValue.Provider>
    </SetActivityNotice.Provider>
  )
}

export function ActivityNotice() {
  const notice = useContext(ActivityNoticeValue)
  if (!notice) return null
  return <Feedback state={notice} />
}

/**
 * 活動清單每列的「編輯」「刪除」（③ §9.4；已取消的舊活動只有「刪除」）。
 * 編輯表單每次打開都從最新的 `values`／`revision` 重新掛上，打開那一刻的 revision 固定在表單裡：
 * 開著的時候甘特拖拉或別的分頁改過，送出回 CONFLICT，不會拿舊草稿蓋回去。
 */
export function ActivityActions({
  activityId,
  title,
  revision,
  removeRequestId,
  values,
  editable,
  ...limits
}: {
  activityId: string
  title: string
  revision: number
  removeRequestId: string
  values: ActivityDraft
  /** 已取消的舊活動不能再改，只留「刪除」。 */
  editable: boolean
} & ActivityLimits) {
  const [done, setDone] = useState<TimelineActionState>(undefined)
  const edit = useFreshDialog()
  const close = edit.close
  const onSuccess = useCallback(
    (state: TimelineActionState) => {
      setDone(state)
      close()
    },
    [close],
  )

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {editable ? (
          <button type="button" className={SECONDARY} onClick={edit.open} aria-label={`編輯：${title}`}>
            <IconPencil aria-hidden /> 編輯
          </button>
        ) : null}
        <DeleteActivityButton activityId={activityId} title={title} revision={revision} requestId={removeRequestId} />
      </div>
      <Feedback state={done} />

      {editable ? (
        <Dialog dialog={edit} wide title={`編輯：${title}`} description={EDIT_ACTIVITY_DESCRIPTION}>
          {edit.openKey > 0 ? (
            <ActivityForm
              key={edit.openKey}
              target={{ kind: 'edit', activityId, revision }}
              initial={values}
              idPrefix={`edit-${activityId}`}
              submitLabel="儲存"
              onSuccess={onSuccess}
              onCancel={close}
              limits={limits}
            />
          ) : null}
        </Dialog>
      ) : null}
    </div>
  )
}

/**
 * 刪除活動（③ §9.1）：排定中、已取消的都直接刪，不必先取消；確認框說清楚學生那邊會直接消失。
 * 成功後那一列會從清單消失，成功句子交給清單外的回饋區。
 */
function DeleteActivityButton({
  activityId,
  title,
  revision,
  requestId,
}: {
  activityId: string
  title: string
  revision: number
  requestId: string
}) {
  const setNotice = useContext(SetActivityNotice)
  const [state, action, pending] = useActionState(async (prev: TimelineActionState, formData: FormData) => {
    const result = await deleteActivityAction(prev, formData)
    setNotice(result?.ok ? result : undefined)
    return result
  }, undefined)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)

  return (
    <>
      <button type="button" className={DANGER} onClick={dialog.open} aria-label={`刪除：${title}`}>
        <IconTrash aria-hidden /> 刪除
      </button>
      <Dialog dialog={dialog} title={`刪除「${title}」？`}>
        <form action={action} className="space-y-4">
          <p className="text-sm">確定刪除『{title}』？學生的時程上會直接消失。刪除不能恢復，紀錄會留在操作紀錄。</p>
          <input type="hidden" name="activityId" value={activityId} />
          <input type="hidden" name="revision" value={revision} />
          <input type="hidden" name="requestId" value={requestId} />
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              取消
            </button>
            <button type="submit" disabled={pending} className={DANGER}>
              {pending ? '處理中…' : '刪除'}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
