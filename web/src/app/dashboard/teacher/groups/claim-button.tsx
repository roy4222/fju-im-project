'use client'
import { useActionState, useState } from 'react'
import { claimGroupAction } from './actions'
import { DataTable } from '@/app/_ui/primitives'
import { cn } from '@/shared/cn'

/**
 * 老師「產學組認領」（票 19；原型 `ClaimPanel`＋`ClaimDialog`）。
 *
 * 一張表列本屆所有產學組：可認領、你指導中、已被認領（誰）。可認領的按「指定為我的組別」打開**一個**共用對話框：
 * 認領成功或撞到別的老師先認領，頁面都會重新整理、那一列會換成新狀態——對話框與回饋放在表格外面，
 * 才不會跟著那一列一起不見。衝突訊息是伺服器回的句子（點名是誰先認領）。
 */

export type ClaimActionState = { ok: boolean; conflict: boolean; message: string } | undefined

export type ClaimRow = {
  groupId: string
  code: string
  memberCount: number
  leaderName: string | null
  state: 'open' | 'mine' | 'taken'
  advisorName: string | null
}

const BUTTON =
  'inline-flex items-center justify-center whitespace-nowrap rounded-md border border-border px-3 py-1.5 ' +
  'text-sm font-medium text-ink hover:bg-muted disabled:opacity-60'
const PRIMARY =
  'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium ' +
  'text-primary-foreground hover:bg-primary/90 disabled:opacity-60'

function StatePill({ row }: { row: ClaimRow }) {
  const tone =
    row.state === 'open'
      ? 'bg-primary-subtle text-primary-on-subtle'
      : row.state === 'mine'
        ? 'bg-primary text-primary-foreground'
        : 'bg-muted text-muted-foreground'
  const text = row.state === 'open' ? '可認領' : row.state === 'mine' ? '你指導中' : `已被認領・${row.advisorName ?? ''}`
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', tone)}>{text}</span>
}

export function ClaimPanel({ rows, requestId }: { rows: ClaimRow[]; requestId: string }) {
  const [state, formAction, pending] = useActionState(claimGroupAction, undefined)
  const [picked, setPicked] = useState<ClaimRow | null>(null)
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null)

  const open = (row: ClaimRow) => {
    setPicked(row)
    dialog?.showModal()
  }

  return (
    <div className="space-y-2">
      <DataTable
        columns={['組別', '組員', '狀態', '']}
        rows={rows.map((r) => [
          <span key="code" className="font-semibold tabular-nums">
            {r.code}
          </span>,
          <span key="members" className="text-sm">
            {r.memberCount} 人{r.leaderName ? `・組長 ${r.leaderName}` : ''}
          </span>,
          <StatePill key="state" row={r} />,
          r.state === 'open' ? (
            <button key="claim" type="button" className={BUTTON} aria-label={`認領 ${r.code}`} onClick={() => open(r)}>
              認領
            </button>
          ) : (
            <span key="none" className="text-xs text-muted-foreground">
              —
            </span>
          ),
        ])}
        empty="本屆還沒有產學組。"
      />
      <dialog
        ref={setDialog}
        aria-label={picked ? `認領 ${picked.code}` : '認領組別'}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40"
      >
        {picked ? (
          // 換一組就重新掛表單：上一組的結果不會留在下一組的對話框裡。key 不含請求編號——
          // 認領後頁面重新整理會換新的編號，表單不能因此重掛、把剛拿到的結果洗掉。
          <ClaimForm
            key={picked.groupId}
            row={picked}
            requestId={requestId}
            state={state}
            formAction={formAction}
            pending={pending}
            onClose={() => dialog?.close()}
          />
        ) : null}
      </dialog>
    </div>
  )
}

function ClaimForm({
  row,
  requestId,
  state,
  formAction,
  pending,
  onClose,
}: {
  row: ClaimRow
  requestId: string
  state: ClaimActionState
  formAction: (formData: FormData) => void
  pending: boolean
  onClose: () => void
}) {
  // 只顯示「這一組」按下去之後的結果：共用的 action 狀態在打開這一組時可能還是上一組的，記下當時那一份當基準。
  const [baseline] = useState(state)
  const result = state !== baseline && !pending ? state : undefined

  if (result?.ok) {
    return (
      <div className="space-y-3 p-5 text-center">
        <span className="inline-flex -rotate-2 rounded-md border-2 border-primary px-3 py-1 text-sm font-bold tracking-widest text-primary">
          已認領
        </span>
        <h2 className="text-base font-semibold text-ink">{row.code} 已指定為你的組別</h2>
        <p role="status" className="text-sm text-muted-foreground">
          {result.message}
        </p>
        <button type="button" className={BUTTON} onClick={onClose}>
          關閉
        </button>
      </div>
    )
  }
  if (result && !result.ok) {
    return (
      <div className="space-y-3 p-5 text-center">
        <h2 className="text-base font-semibold text-ink">{result.conflict ? '已被其他老師認領' : '沒有認領成功'}</h2>
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          {result.message}
        </p>
        <button type="button" className={BUTTON} onClick={onClose}>
          關閉
        </button>
      </div>
    )
  }
  return (
    <form action={formAction} className="space-y-4 p-5">
      <div>
        <h2 className="text-base font-semibold text-ink">認領 {row.code}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {row.memberCount} 人{row.leaderName ? `・組長 ${row.leaderName}` : ''}。先按先得；同時操作只有一位會成功。
          認領後全組會收到通知；之後要換老師請洽系辦重派。
        </p>
      </div>
      <input type="hidden" name="groupId" value={row.groupId} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <button type="button" className={BUTTON} onClick={onClose}>
          先不要
        </button>
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? '處理中…' : '指定為我的組別'}
        </button>
      </div>
    </form>
  )
}
