'use client'
import { useActionState, useEffect, useRef, useState } from 'react'
import { activateCohortAction, createCohortAction, setCohortFlagAction, setCohortStatusAction } from './actions'
import { Pill } from '@/app/_ui/dashboard/primitives'
import { ALERT, BTN_ROW, DIALOG, DIALOG_TITLE, INPUT, LABEL, NOTE, TEXTAREA } from '@/app/_ui/dashboard/look'
import { buttonVariants } from '@/app/_ui/ui/button'

/**
 * 屆別頁會動的兩塊：新增表單與屆別卡片（票 5；AD-12 由表格改卡片）。
 *
 * 回饋一律是**伺服器**回的句子：成功說清楚改了什麼（包括哪一屆的旗標被自動取消），
 * 失敗照用例的訊息顯示。沒有 JavaScript 時表單照樣送得出去，只是看不到「處理中」。
 */

export type CohortActionState =
  | { ok: boolean; message: string; values?: { code: string; name: string } }
  | undefined

function Feedback({ state }: { state: CohortActionState }) {
  if (!state) return null
  return (
    <p role={state.ok ? 'status' : 'alert'} className={state.ok ? NOTE : ALERT}>
      {state.message}
    </p>
  )
}

const SUBMIT = 'btn-fju h-10 shrink-0 px-5 text-sm disabled:opacity-60'

/**
 * 新增屆別（C2 設計方案 §4.1）：分頁列右側一顆「新增屆別」，按了開視窗填代碼與名稱。
 * 成功就關視窗、回饋寫在按鈕旁；失敗留在視窗裡，剛填的字留著不用重打。
 */
export function CreateCohortForm({ requestId, codeMaxLength, nameMaxLength }: { requestId: string; codeMaxLength: number; nameMaxLength: number }) {
  const [state, formAction, pending] = useActionState(createCohortAction, undefined)
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (state?.ok) ref.current?.close()
  }, [state])

  return (
    <div className="flex max-w-full flex-col items-stretch gap-2 sm:items-end">
      <button type="button" className={SUBMIT} onClick={() => ref.current?.showModal()}>
        新增屆別
      </button>
      {state?.ok ? (
        <div className="max-w-md">
          <Feedback state={state} />
        </div>
      ) : null}
      <dialog ref={ref} aria-label="新增屆別" className={DIALOG.md}>
        <form action={formAction} className="space-y-4 p-5">
          <input type="hidden" name="requestId" value={requestId} />
          <h2 className={DIALOG_TITLE}>新增屆別</h2>
          <label htmlFor="cohort-code" className={LABEL}>
            代碼
            <input
              id="cohort-code"
              name="code"
              required
              maxLength={codeMaxLength}
              placeholder="如 115"
              title="代碼用英數與連字號，例如 115 或 115-TEST"
              autoComplete="off"
              defaultValue={state?.ok ? undefined : state?.values?.code}
              key={`code-${state?.ok ? '' : (state?.values?.code ?? '')}`}
              className={INPUT}
            />
          </label>
          <label htmlFor="cohort-name" className={LABEL}>
            名稱
            <input
              id="cohort-name"
              name="name"
              required
              maxLength={nameMaxLength}
              placeholder="如 115 學年度資管系專題"
              autoComplete="off"
              defaultValue={state?.ok ? undefined : state?.values?.name}
              key={`name-${state?.ok ? '' : (state?.values?.name ?? '')}`}
              className={INPUT}
            />
          </label>
          {state && !state.ok ? <Feedback state={state} /> : null}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={CANCEL} onClick={() => ref.current?.close()}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={SUBMIT}>
              {pending ? '處理中…' : '確定新增'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}

export type CohortRow = {
  id: string
  code: string
  name: string
  /** 畫面上的屆別寫法「名稱（代碼）」（系1），伺服器端用 `cohortLabel` 算好；也是卡片的 region 名。 */
  label: string
  statusLabel: string
  /** 已封存的屆別卡上沒有旗標按鈕，只剩「解除封存」（AD-B4）。 */
  archived: boolean
  /** 已封存卡上的「已封存 {時間}」，伺服器端格式化好的臺灣時間；不是已封存時為 null。 */
  archivedAtLabel: string | null
  /**
   * 「封存」能不能按（C2 設計方案 §1 A23）：不能按時 `archiveBlockedReason` 是寫在按鈕旁的那一句，
   * 照用例的封存前置（籌備中、預設工作屆別、開放註冊屆別）由伺服器端算好；能按時為 null。
   */
  canArchive: boolean
  archiveBlockedReason: string | null
  /** 籌備中的屆別才有「轉為進行中」（票 11；C2 起是狀態旁的小字鈕）。 */
  canActivate: boolean
  isDefaultWorking: boolean
  isRegistrationOpen: boolean
  /** 本屆學生數（已分組成員＋未分組）與組數。 */
  studentCount: number
  groupCount: number
  /** 每顆按鈕各自一個請求編號；成功後頁面重整會換新的。 */
  requestIds: {
    defaultWorking: string
    registrationOpen: string
    activate: string
    archive: string
    unarchive: string
  }
}

type Flag = 'defaultWorking' | 'registrationOpen'

const HELD_LABEL: Record<Flag, string> = {
  defaultWorking: '後台預設查看中',
  registrationOpen: '新註冊加入這屆',
}

const BUTTON_LABEL: Record<Flag, string> = {
  defaultWorking: '設為預設',
  registrationOpen: '設為新註冊加入的屆別',
}

/**
 * 屆別卡片（AD-12，取代原本 `min-w-[40rem]` 的表格）：每屆一張 `region`，名稱是「名稱（代碼）」。
 * 卡上（C2 設計方案 §4.1）：狀態膠囊（籌備中旁邊一顆「轉為進行中」小字）、學生數、組數、持有的旗標膠囊，
 * 按鈕只有「編輯」「封存」；已封存的卡只剩「解除封存」。換旗標在「編輯」視窗裡。
 */
export function CohortCards({
  rows,
  flagLabels,
  reasonMaxLength,
}: {
  rows: readonly CohortRow[]
  flagLabels: Record<Flag, string>
  reasonMaxLength: number
}) {
  const [flagState, formAction, pending] = useActionState(setCohortFlagAction, undefined)
  const [activateState, activateAction, activating] = useActionState(activateCohortAction, undefined)
  const [statusState, statusAction, changingStatus] = useActionState(setCohortStatusAction, undefined)
  // 三種動作共用卡片列上方那一句回饋：顯示最近一次的。
  const [latest, setLatest] = useState<'flag' | 'activate' | 'status' | null>(null)
  const [seen, setSeen] = useState({ flagState, activateState, statusState })
  if (seen.flagState !== flagState || seen.activateState !== activateState || seen.statusState !== statusState) {
    setSeen({ flagState, activateState, statusState })
    setLatest(
      seen.statusState !== statusState ? 'status' : seen.activateState !== activateState ? 'activate' : 'flag',
    )
  }
  const state = latest === 'status' ? statusState : latest === 'activate' ? activateState : flagState

  if (rows.length === 0) {
    return (
      <div className="dash-card flex flex-col items-center gap-1 px-4 py-10 text-center">
        <p className="text-sm font-semibold text-foreground">還沒有屆別</p>
        <p className="text-xs text-muted-foreground">按上面分頁列右側的「新增屆別」，新增第一屆。</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <Feedback state={state} />
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => (
          <li key={row.id} className="min-w-0">
            <section aria-label={row.label} className="dash-card flex h-full flex-col gap-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 text-[15px] font-bold break-words text-foreground">
                  {row.name}
                  <span className="tabular ml-1 font-semibold text-muted-foreground">（{row.code}）</span>
                </h3>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill>{row.statusLabel}</Pill>
                  {row.canActivate ? <ActivateCohortButton row={row} action={activateAction} pending={activating} /> : null}
                </div>
              </div>
              <dl className="flex gap-6 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">學生</dt>
                  <dd className="tabular text-lg font-bold text-ink">{row.studentCount}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">組</dt>
                  <dd className="tabular text-lg font-bold text-ink">{row.groupCount}</dd>
                </div>
              </dl>
              {/* 持有的旗標只是膠囊；可見的「新註冊加入這屆」全頁只會有持有的那一屆（cohorts.spec）。 */}
              {row.isDefaultWorking || row.isRegistrationOpen ? (
                <div className="flex flex-wrap gap-1.5">
                  {row.isDefaultWorking ? <Pill tone="brand">{HELD_LABEL.defaultWorking}</Pill> : null}
                  {row.isRegistrationOpen ? <Pill tone="brand">{HELD_LABEL.registrationOpen}</Pill> : null}
                </div>
              ) : null}
              {row.archived ? (
                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <span className="text-sm text-muted-foreground" data-testid="archived-at">
                    已封存{row.archivedAtLabel ? ` ${row.archivedAtLabel}` : ''}
                  </span>
                  <CohortStatusButton
                    row={row}
                    mode="unarchive"
                    action={statusAction}
                    pending={changingStatus}
                    reasonMaxLength={reasonMaxLength}
                  />
                </div>
              ) : (
                <div className="mt-auto flex flex-col gap-1.5 border-t border-border pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <EditCohortButton row={row} flagLabels={flagLabels} action={formAction} pending={pending} />
                    <CohortStatusButton
                      row={row}
                      mode="archive"
                      action={statusAction}
                      pending={changingStatus}
                      reasonMaxLength={reasonMaxLength}
                    />
                  </div>
                  {/* 不能封存：按鈕 disabled，旁邊同一句原因（跟按鈕的 title 相同；C2 設計方案 §1 A23）。 */}
                  {row.archiveBlockedReason ? (
                    <p className="text-xs text-muted-foreground" data-testid="archive-blocked-reason">
                      {row.archiveBlockedReason}
                    </p>
                  ) : null}
                </div>
              )}
            </section>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 「編輯」視窗：名稱與代碼（目前只能看），以及兩個全系唯一的旗標——持有就寫「目前是這一屆」，沒有就是「設為」按鈕。
 * 按了就送出並關掉視窗，結果顯示在卡片列上方那一句回饋。
 */
function EditCohortButton({
  row,
  flagLabels,
  action,
  pending,
}: {
  row: CohortRow
  flagLabels: Record<Flag, string>
  action: (formData: FormData) => void
  pending: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = () => ref.current?.close()
  return (
    <>
      <button type="button" aria-label={`編輯：${row.code}`} className={BTN_ROW} onClick={() => ref.current?.showModal()}>
        編輯
      </button>
      <dialog ref={ref} aria-label={`編輯${row.code}`} className={DIALOG.lg}>
        <div className="space-y-4 p-5">
          <h2 className={DIALOG_TITLE}>編輯{row.label}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">名稱</dt>
            <dd className="text-foreground">{row.name}</dd>
            <dt className="text-muted-foreground">代碼</dt>
            <dd className="tabular text-foreground">{row.code}</dd>
          </dl>
          <ul className="space-y-2 border-t border-border pt-4">
            {(['defaultWorking', 'registrationOpen'] as const).map((flag) => {
              const held = flag === 'defaultWorking' ? row.isDefaultWorking : row.isRegistrationOpen
              // 群組名用持有時的那句（`HELD_LABEL`），每張未封存的卡都有；它也是 pages.spec 的屆別頁指紋。
              return (
                <li key={flag} role="group" aria-label={HELD_LABEL[flag]} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{flagLabels[flag]}</span>
                  {held ? (
                    <span className="text-sm text-muted-foreground">目前是這一屆</span>
                  ) : (
                    <form action={action} onSubmit={close}>
                      <input type="hidden" name="cohortId" value={row.id} />
                      <input type="hidden" name="flag" value={flag} />
                      <input type="hidden" name="requestId" value={row.requestIds[flag]} />
                      <button type="submit" disabled={pending} aria-label={`把 ${row.code} 設為${flagLabels[flag]}`} className={BTN_ROW}>
                        {BUTTON_LABEL[flag]}
                      </button>
                    </form>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-muted-foreground">交給這一屆時，原本那一屆會自動取消。</p>
          <div className="flex justify-end border-t border-border pt-4">
            <button type="button" className={CANCEL} onClick={close}>
              關閉
            </button>
          </div>
        </div>
      </dialog>
    </>
  )
}

// 封存（C2）：列上直接一顆紅字細框，不再放進危險區；不能封存時 disabled。
const ARCHIVE = buttonVariants({
  variant: 'outline',
  size: 'sm',
  className: 'press rounded-lg border-destructive/40 text-destructive hover:bg-destructive/5 hover:text-destructive',
})
// 「轉為進行中」（C2）：狀態膠囊旁的小字鈕。
const ACTIVATE_LINK = 'press min-h-6 rounded px-1 text-xs font-semibold text-brand hover:text-ink disabled:opacity-60'
const DANGER_SUBMIT = buttonVariants({ variant: 'destructive', size: 'lg', className: 'press rounded-lg px-4 disabled:opacity-60' })
const CANCEL = buttonVariants({ variant: 'outline', size: 'lg', className: 'press rounded-lg px-4' })

/**
 * 「轉為進行中」的確認視窗（第三波 §9 規則 1）：寫對象、範圍、後果、能不能恢復，確認鈕寫動作。
 * 觸發鈕是狀態膠囊旁的小字（C2 設計方案 §4.1）。
 * 送出就關掉視窗，結果照舊顯示在卡片列上方那一句回饋（被擋下的原因也在那裡）。
 */
function ActivateCohortButton({
  row,
  action,
  pending,
}: {
  row: CohortRow
  action: (formData: FormData) => void
  pending: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const facts: [string, string][] = [
    ['對象', row.label],
    ['範圍', '這一屆的學生、老師與系辦看到的屆別狀態都會變成「進行中」（不另發通知）。'],
    ['後果', '狀態從「尚未開始（設定中）」改成「進行中」，按下就生效並留一筆狀態紀錄。還沒設好階段與年度結束日會被擋下、不會改。'],
    ['能不能恢復', '不能改回尚未開始（設定中），沒有退回的按鈕。'],
  ]
  return (
    <>
      <button
        type="button"
        disabled={pending}
        aria-label={`把 ${row.code} 轉為進行中`}
        className={ACTIVATE_LINK}
        onClick={() => ref.current?.showModal()}
      >
        轉為進行中
      </button>
      <dialog ref={ref} aria-label={`把 ${row.code} 轉為進行中？`} className={DIALOG.lg}>
        <form action={action} onSubmit={() => ref.current?.close()} className="space-y-4 p-5">
          <input type="hidden" name="cohortId" value={row.id} />
          <input type="hidden" name="requestId" value={row.requestIds.activate} />
          <h2 className={DIALOG_TITLE}>把{row.label}轉為進行中？</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm" data-testid="danger-facts">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="whitespace-nowrap text-muted-foreground">{k}</dt>
                <dd className="text-foreground">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={CANCEL} onClick={() => ref.current?.close()}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={DANGER_SUBMIT}>
              確定轉為進行中
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}

const STATUS_COPY = {
  archive: {
    button: '封存',
    title: (label: string) => `封存${label}？`,
    submit: '確定封存',
    facts: [
      ['範圍', '這一屆的組別、評分、簽核、成果都變成只能查看；老師的評分清單與「我的組別」不再列這一屆。'],
      ['後果', '按下就生效並留一筆狀態紀錄與操作紀錄。'],
      ['能不能恢復', '可以，已封存的卡上有「解除封存」。'],
    ],
  },
  unarchive: {
    button: '解除封存',
    title: (label: string) => `解除封存${label}？`,
    submit: '確定解除封存',
    facts: [
      ['範圍', '這一屆回到進行中；老師的評分清單、學生的組別頁可以再寫入。'],
      ['後果', '按下就生效並留一筆狀態紀錄與操作紀錄。'],
      ['能不能恢復', '可以再封存。'],
    ],
  },
} as const

/**
 * 「封存」「解除封存」的確認視窗（AD-B4；設計方案 §7）：寫對象、範圍、後果、能不能恢復，理由選填（C2 設計方案 X2）。
 * 送出就關掉視窗，結果顯示在卡片列上方那一句回饋。
 */
function CohortStatusButton({
  row,
  mode,
  action,
  pending,
  reasonMaxLength,
}: {
  row: CohortRow
  mode: 'archive' | 'unarchive'
  action: (formData: FormData) => void
  pending: boolean
  reasonMaxLength: number
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const copy = STATUS_COPY[mode]
  const reasonId = `cohort-${mode}-reason-${row.id}`
  const facts: readonly (readonly [string, string])[] = [['對象', row.label], ...copy.facts]
  const close = () => ref.current?.close()
  // 不能封存（籌備中、身上有旗標）：按鈕 disabled，原因寫在 title 與卡上小字（同一句）。
  const blocked = mode === 'archive' && !row.canArchive
  return (
    <>
      <button
        type="button"
        disabled={pending || blocked}
        aria-label={`${copy.button}：${row.code}`}
        title={blocked ? (row.archiveBlockedReason ?? undefined) : undefined}
        className={mode === 'archive' ? ARCHIVE : BTN_ROW}
        onClick={() => ref.current?.showModal()}
      >
        {copy.button}
      </button>
      <dialog ref={ref} aria-label={copy.title(row.code)} className={DIALOG.lg}>
        <form
          action={action}
          noValidate
          onSubmit={close}
          className="space-y-4 p-5"
        >
          <input type="hidden" name="cohortId" value={row.id} />
          <input type="hidden" name="mode" value={mode} />
          <input type="hidden" name="label" value={row.label} />
          <input type="hidden" name="requestId" value={row.requestIds[mode]} />
          <h2 className={DIALOG_TITLE}>{copy.title(row.label)}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm" data-testid="danger-facts">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="whitespace-nowrap text-muted-foreground">{k}</dt>
                <dd className="text-foreground">{v}</dd>
              </div>
            ))}
          </dl>
          <label htmlFor={reasonId} className={LABEL}>
            理由（選填，會留在操作紀錄）
            <textarea id={reasonId} name="reason" rows={3} maxLength={reasonMaxLength} className={TEXTAREA} />
          </label>
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={CANCEL} onClick={close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={mode === 'archive' ? DANGER_SUBMIT : 'btn-fju h-10 px-4 text-sm disabled:opacity-60'}>
              {copy.submit}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
