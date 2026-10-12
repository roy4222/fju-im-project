'use client'
import { useActionState, useRef, useState } from 'react'
import { IconAlertTriangle } from '@tabler/icons-react'
import { activateCohortAction, createCohortAction, setCohortFlagAction } from './actions'
import { DataTableFrame, DT, EmptyRow } from '@/app/_ui/data-table'
import { Pill } from '@/app/_ui/dashboard/primitives'
import { ALERT, BTN_ROW, DIALOG, DIALOG_TITLE, INPUT as INPUT_BASE, NOTE } from '@/app/_ui/dashboard/look'
import { buttonVariants } from '@/app/_ui/ui/button'

/**
 * 屆別頁會動的兩塊：新增表單與屆別表格（票 5）。
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

const INPUT = `mt-1.5 ${INPUT_BASE}`
const SUBMIT = 'btn-fju h-10 px-5 text-sm disabled:opacity-60'

export function CreateCohortForm({
  requestId,
  codeMaxLength,
  nameMaxLength,
}: {
  requestId: string
  codeMaxLength: number
  nameMaxLength: number
}) {
  const [state, formAction, pending] = useActionState(createCohortAction, undefined)

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
        <div>
          <label htmlFor="cohort-code" className="block text-sm font-semibold text-foreground">
            代碼
          </label>
          <input
            id="cohort-code"
            name="code"
            required
            maxLength={codeMaxLength}
            placeholder="115"
            autoComplete="off"
            defaultValue={state?.values?.code}
            key={`code-${state?.values?.code ?? ''}`}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="cohort-name" className="block text-sm font-semibold text-foreground">
            名稱
          </label>
          <input
            id="cohort-name"
            name="name"
            required
            maxLength={nameMaxLength}
            placeholder="115 學年度資管系專題"
            autoComplete="off"
            defaultValue={state?.values?.name}
            key={`name-${state?.values?.name ?? ''}`}
            className={INPUT}
          />
        </div>
        <button type="submit" disabled={pending} className={SUBMIT}>
          {pending ? '處理中…' : '新增屆別'}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        代碼用英數與連字號，例如 115 或 115-TEST。新屆別一開始是「尚未開始（設定中）」。
      </p>
      <Feedback state={state} />
    </form>
  )
}

export type CohortRow = {
  id: string
  code: string
  name: string
  statusLabel: string
  /** 籌備中的屆別才有「轉為進行中」按鈕（票 11；第三波起在表格下方的危險操作區）。 */
  canActivate: boolean
  isDefaultWorking: boolean
  isRegistrationOpen: boolean
  /** 每顆按鈕各自一個請求編號；成功後頁面重整會換新的。 */
  requestIds: { defaultWorking: string; registrationOpen: string; activate: string }
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

export function CohortTable({
  rows,
  flagLabels,
}: {
  rows: readonly CohortRow[]
  flagLabels: Record<Flag, string>
}) {
  const [flagState, formAction, pending] = useActionState(setCohortFlagAction, undefined)
  const [activateState, activateAction, activating] = useActionState(activateCohortAction, undefined)
  // 兩種動作共用表格上方那一句回饋：顯示最近一次的。
  const [latest, setLatest] = useState<'flag' | 'activate' | null>(null)
  const [seen, setSeen] = useState({ flagState, activateState })
  if (seen.flagState !== flagState || seen.activateState !== activateState) {
    setSeen({ flagState, activateState })
    setLatest(seen.activateState !== activateState ? 'activate' : 'flag')
  }
  const state = latest === 'activate' ? activateState : flagState

  const preparing = rows.filter((row) => row.canActivate)

  function flagCell(row: CohortRow, flag: Flag) {
    const held = flag === 'defaultWorking' ? row.isDefaultWorking : row.isRegistrationOpen
    if (held) {
      return (
        <Pill tone="brand">{HELD_LABEL[flag]}</Pill>
      )
    }
    return (
      <form action={formAction}>
        <input type="hidden" name="cohortId" value={row.id} />
        <input type="hidden" name="flag" value={flag} />
        <input type="hidden" name="requestId" value={row.requestIds[flag]} />
        <button
          type="submit"
          disabled={pending}
          aria-label={`把 ${row.code} 設為${flagLabels[flag]}`}
          className={BTN_ROW}
        >
          {BUTTON_LABEL[flag]}
        </button>
      </form>
    )
  }

  return (
    <div className="space-y-3">
      <Feedback state={state} />
      <DataTableFrame maxHeight={false}>
        <table className={`${DT.table} min-w-[40rem]`}>
          <thead className={DT.thead}>
            <tr>
              {['代碼', '名稱', '狀態', flagLabels.defaultWorking, flagLabels.registrationOpen].map((h) => (
                <th key={h} scope="col" className={DT.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={5} title="還沒有屆別" hint="先在上面新增第一屆。" />
            ) : (
              rows.map((row) => (
                <tr key={row.id} className={DT.tr}>
                  <td className={`${DT.td} tabular font-bold whitespace-nowrap`}>{row.code}</td>
                  <td className={DT.td}>{row.name}</td>
                  <td className={DT.td}>
                    <Pill>{row.statusLabel}</Pill>
                  </td>
                  <td className={DT.td}>{flagCell(row, 'defaultWorking')}</td>
                  <td className={DT.td}>{flagCell(row, 'registrationOpen')}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </DataTableFrame>

      {/* 危險操作（第三波 §9 規則 1、AC-37、N-48）：「轉為進行中」不能回頭、整屆都看得到，跟日常的旗標按鈕拉開，先確認再送。 */}
      {preparing.length > 0 ? (
        <section aria-labelledby="cohort-danger" className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <h3 id="cohort-danger" className="flex items-center gap-1.5 text-sm font-bold text-destructive">
            <IconAlertTriangle aria-hidden className="size-4" /> 危險操作
          </h3>
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">轉為進行中</span>：尚未開始（設定中）的屆別正式開始，不能改回尚未開始。要先到「時間軸」設好四個階段與年度結束日。
          </p>
          <ul className="flex flex-col gap-2">
            {preparing.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 text-sm">
                <span>
                  <span className="tabular font-bold">{row.code}</span> <span className="text-muted-foreground">{row.name}</span>
                </span>
                <ActivateCohortButton row={row} action={activateAction} pending={activating} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

const DANGER = buttonVariants({ variant: 'destructive', size: 'sm', className: 'press rounded-lg' })
const DANGER_SUBMIT = buttonVariants({ variant: 'destructive', size: 'lg', className: 'press rounded-lg px-4 disabled:opacity-60' })
const CANCEL = buttonVariants({ variant: 'outline', size: 'lg', className: 'press rounded-lg px-4' })

/**
 * 「轉為進行中」的確認視窗（第三波 §9 規則 1）：寫對象、範圍、後果、能不能恢復，確認鈕寫動作。
 * 送出就關掉視窗，結果照舊顯示在表格上方那一句回饋（被擋下的原因也在那裡）。
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
    ['對象', `${row.code}（${row.name}）`],
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
          <h2 className={DIALOG_TITLE}>把 {row.code} 轉為進行中？</h2>
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
