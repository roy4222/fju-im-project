'use client'
import { useActionState } from 'react'
import { createCohortAction, setCohortFlagAction } from './actions'
import { DataTable } from '@/app/_ui/primitives'
import { cn } from '@/shared/cn'

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

const INPUT = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
const SUBMIT =
  'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium ' +
  'text-primary-foreground hover:bg-primary/90 disabled:opacity-60'

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
          <label htmlFor="cohort-code" className="block text-sm font-medium text-ink">
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
          <label htmlFor="cohort-name" className="block text-sm font-medium text-ink">
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
  isDefaultWorking: boolean
  isRegistrationOpen: boolean
  /** 每顆按鈕各自一個請求編號；成功後頁面重整會換新的。 */
  requestIds: { defaultWorking: string; registrationOpen: string }
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
  const [state, formAction, pending] = useActionState(setCohortFlagAction, undefined)

  function flagCell(row: CohortRow, flag: Flag) {
    const held = flag === 'defaultWorking' ? row.isDefaultWorking : row.isRegistrationOpen
    if (held) {
      return (
        <span className="inline-block whitespace-nowrap rounded-full bg-primary-subtle px-2.5 py-0.5 text-xs font-medium text-primary-on-subtle">
          {HELD_LABEL[flag]}
        </span>
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
          className="whitespace-nowrap rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink hover:bg-muted disabled:opacity-60"
        >
          {BUTTON_LABEL[flag]}
        </button>
      </form>
    )
  }

  return (
    <div className="space-y-3">
      <Feedback state={state} />
      <DataTable
        columns={['代碼', '名稱', '狀態', flagLabels.defaultWorking, flagLabels.registrationOpen]}
        rows={rows.map((row) => [
          <span key="code" className="whitespace-nowrap font-medium text-ink">
            {row.code}
          </span>,
          row.name,
          <span key="status" className="whitespace-nowrap">
            {row.statusLabel}
          </span>,
          flagCell(row, 'defaultWorking'),
          flagCell(row, 'registrationOpen'),
        ])}
        empty="還沒有屆別。先在上面新增第一屆。"
      />
    </div>
  )
}
