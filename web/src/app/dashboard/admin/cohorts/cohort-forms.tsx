'use client'
import { useActionState, useState } from 'react'
import { activateCohortAction, createCohortAction, setCohortFlagAction } from './actions'
import { DataTableFrame, DT, EmptyRow } from '@/app/_ui/data-table'
import { Pill } from '@/app/_ui/dashboard/primitives'
import { ALERT, BTN_ROW, INPUT as INPUT_BASE, NOTE } from '@/app/_ui/dashboard/look'

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
        代碼用英數與連字號，例如 115 或 115-TEST。新屆別從「籌備中」開始。
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
  /** 籌備中的屆別才有「轉為進行中」按鈕（票 11）。 */
  canActivate: boolean
  isDefaultWorking: boolean
  isRegistrationOpen: boolean
  /** 每顆按鈕各自一個請求編號；成功後頁面重整會換新的。 */
  requestIds: { defaultWorking: string; registrationOpen: string; activate: string }
}

type Flag = 'defaultWorking' | 'registrationOpen'

const HELD_LABEL: Record<Flag, string> = {
  defaultWorking: '預設工作中',
  registrationOpen: '開放註冊中',
}

const BUTTON_LABEL: Record<Flag, string> = {
  defaultWorking: '設為預設',
  registrationOpen: '開放註冊',
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

  function statusCell(row: CohortRow) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Pill>{row.statusLabel}</Pill>
        {row.canActivate ? (
          <form action={activateAction}>
            <input type="hidden" name="cohortId" value={row.id} />
            <input type="hidden" name="requestId" value={row.requestIds.activate} />
            <button
              type="submit"
              disabled={activating}
              aria-label={`把 ${row.code} 轉為進行中`}
              className={BTN_ROW}
            >
              轉為進行中
            </button>
          </form>
        ) : null}
      </div>
    )
  }

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
                  <td className={DT.td}>{statusCell(row)}</td>
                  <td className={DT.td}>{flagCell(row, 'defaultWorking')}</td>
                  <td className={DT.td}>{flagCell(row, 'registrationOpen')}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </DataTableFrame>
    </div>
  )
}
