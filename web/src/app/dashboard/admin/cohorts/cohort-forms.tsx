'use client'
import { useActionState, useRef, useState } from 'react'
import { IconAlertTriangle } from '@tabler/icons-react'
import { activateCohortAction, createCohortAction, setCohortFlagAction } from './actions'
import { Pill } from '@/app/_ui/dashboard/primitives'
import { ALERT, BTN_ROW, DIALOG, DIALOG_TITLE, INPUT as INPUT_BASE, NOTE } from '@/app/_ui/dashboard/look'
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

const INPUT = `${INPUT_BASE} h-10`
const SUBMIT = 'btn-fju h-10 shrink-0 px-5 text-sm disabled:opacity-60'

/**
 * 新增屆別（AD-12）：整張表單放在分頁列右側，欄位常駐、不另開對話框——
 * 頁上只有一顆「新增屆別」按鈕，填完直接送。欄名用螢幕閱讀器讀得到的隱藏標籤，格式寫在 placeholder 與 title。
 */
export function CreateCohortForm({ requestId, codeMaxLength, nameMaxLength }: { requestId: string; codeMaxLength: number; nameMaxLength: number }) {
  const [state, formAction, pending] = useActionState(createCohortAction, undefined)

  return (
    <div className="flex max-w-full flex-col items-stretch gap-2 sm:items-end">
      <form action={formAction} className="flex max-w-full flex-wrap items-center gap-2">
        <input type="hidden" name="requestId" value={requestId} />
        <label htmlFor="cohort-code" className="sr-only">
          代碼
        </label>
        <input
          id="cohort-code"
          name="code"
          required
          maxLength={codeMaxLength}
          placeholder="代碼，如 115"
          title="代碼用英數與連字號，例如 115 或 115-TEST"
          autoComplete="off"
          defaultValue={state?.values?.code}
          key={`code-${state?.values?.code ?? ''}`}
          className={`${INPUT} w-36`}
        />
        <label htmlFor="cohort-name" className="sr-only">
          名稱
        </label>
        <input
          id="cohort-name"
          name="name"
          required
          maxLength={nameMaxLength}
          placeholder="名稱，如 115 學年度資管系專題"
          autoComplete="off"
          defaultValue={state?.values?.name}
          key={`name-${state?.values?.name ?? ''}`}
          className={`${INPUT} w-full min-w-0 flex-1 sm:w-64`}
        />
        <button type="submit" disabled={pending} className={SUBMIT}>
          {pending ? '處理中…' : '新增屆別'}
        </button>
      </form>
      <div className="max-w-md">
        <Feedback state={state} />
      </div>
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
  /** 已封存的屆別卡上沒有任何操作按鈕（封存／解封是 B）。 */
  archived: boolean
  /** 籌備中的屆別才有「轉為進行中」按鈕（票 11；AD-12 起在卡內的危險操作小區）。 */
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
 * 卡上：狀態膠囊、學生數、組數、兩個旗標（持有就是膠囊，沒有就是「設為」按鈕）、籌備中才有的危險操作小區。
 */
export function CohortCards({ rows, flagLabels }: { rows: readonly CohortRow[]; flagLabels: Record<Flag, string> }) {
  const [flagState, formAction, pending] = useActionState(setCohortFlagAction, undefined)
  const [activateState, activateAction, activating] = useActionState(activateCohortAction, undefined)
  // 兩種動作共用卡片列上方那一句回饋：顯示最近一次的。
  const [latest, setLatest] = useState<'flag' | 'activate' | null>(null)
  const [seen, setSeen] = useState({ flagState, activateState })
  if (seen.flagState !== flagState || seen.activateState !== activateState) {
    setSeen({ flagState, activateState })
    setLatest(seen.activateState !== activateState ? 'activate' : 'flag')
  }
  const state = latest === 'activate' ? activateState : flagState

  function flagControl(row: CohortRow, flag: Flag) {
    const held = flag === 'defaultWorking' ? row.isDefaultWorking : row.isRegistrationOpen
    // 群組名用持有時的那句（`HELD_LABEL`），每張未封存的卡都有；它也是 pages.spec 的屆別頁指紋。
    // 放在屬性上、不是可見字：可見的「新註冊加入這屆」全頁只能有持有的那一屆（cohorts.spec）。
    return (
      <div role="group" aria-label={HELD_LABEL[flag]}>
        {held ? (
          <Pill tone="brand">{HELD_LABEL[flag]}</Pill>
        ) : (
          <form action={formAction}>
            <input type="hidden" name="cohortId" value={row.id} />
            <input type="hidden" name="flag" value={flag} />
            <input type="hidden" name="requestId" value={row.requestIds[flag]} />
            <button type="submit" disabled={pending} aria-label={`把 ${row.code} 設為${flagLabels[flag]}`} className={BTN_ROW}>
              {BUTTON_LABEL[flag]}
            </button>
          </form>
        )}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="dash-card flex flex-col items-center gap-1 px-4 py-10 text-center">
        <p className="text-sm font-semibold text-foreground">還沒有屆別</p>
        <p className="text-xs text-muted-foreground">在上面分頁列右側填代碼與名稱，新增第一屆。</p>
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
                <Pill>{row.statusLabel}</Pill>
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
              {row.archived ? null : (
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  {flagControl(row, 'defaultWorking')}
                  {flagControl(row, 'registrationOpen')}
                </div>
              )}
              {/* 危險操作（第三波 §9 規則 1、AC-37、N-48）：「轉為進行中」不能回頭、整屆都看得到，跟日常的旗標按鈕拉開，先確認再送。 */}
              {row.canActivate ? (
                <div
                  role="group"
                  aria-label="危險操作"
                  className="mt-auto flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
                >
                  <span className="flex items-center gap-1.5 text-sm font-bold text-destructive">
                    <IconAlertTriangle aria-hidden className="size-4" /> 危險操作
                  </span>
                  <ActivateCohortButton row={row} action={activateAction} pending={activating} />
                </div>
              ) : null}
            </section>
          </li>
        ))}
      </ul>
    </div>
  )
}

const DANGER = buttonVariants({ variant: 'destructive', size: 'sm', className: 'press rounded-lg' })
const DANGER_SUBMIT = buttonVariants({ variant: 'destructive', size: 'lg', className: 'press rounded-lg px-4 disabled:opacity-60' })
const CANCEL = buttonVariants({ variant: 'outline', size: 'lg', className: 'press rounded-lg px-4' })

/**
 * 「轉為進行中」的確認視窗（第三波 §9 規則 1）：寫對象、範圍、後果、能不能恢復，確認鈕寫動作。
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
        className={DANGER}
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
