'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { StatusChangeReceipt, SuccessionOption } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { disableAccountAction, restoreAccountAction, successionOptionsAction } from './actions'

/**
 * 停用／恢復一個帳號（票 9；原型 `/dashboard/admin/accounts` 的 ToggleStatusDialog）。
 *
 * 先講影響、理由必填，送出後顯示回執；關掉對話框才刷新列表（同審核對話框的作法）。
 * 規則都在伺服器：這裡只把輸入送過去、把結果照實顯示。
 *
 * 票 42：停用時先問伺服器「他是不是組長」。是組長就要在同一個對話框指定接任的組長
 * （產品模組 03「組長」；GRP-18：沒指定接任不能停用），停用與接任在伺服器同一筆交易完成。
 */

const BUTTON =
  // 外觀照原型（票 36）：h-10、圓角、粗一點的字；主要動作系網橘、次要白底細框、危險淡紅。
  'press inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'
const PRIMARY = 'btn-fju rounded-[4px]'
const SECONDARY = 'border border-border bg-background text-foreground hover:bg-muted'
const DANGER = 'bg-destructive/10 text-destructive hover:bg-destructive/20'

export type StatusTarget = {
  readonly userId: string
  readonly name: string
  readonly loginEmail: string
  readonly studentNo: string | null
  /** `pending` 只會是孤兒帳號（票 10b）：沒有申請可以退回，停用是唯一的收尾。 */
  readonly status: 'active' | 'disabled' | 'pending'
}

export function StatusDialog({ account: a }: { account: StatusTarget }) {
  const router = useRouter()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const disabling = a.status !== 'disabled'
  const verb = disabling ? '停用' : '恢復'
  const [isOpen, setIsOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<StatusChangeReceipt | null>(null)
  const [requestId, setRequestId] = useState('')
  /** 停用時：null＝還在查；陣列＝他擔任組長的組（空＝不是組長）。 */
  const [leaderships, setLeaderships] = useState<readonly SuccessionOption[] | null>(null)
  const [successors, setSuccessors] = useState<Record<string, string>>({})

  async function loadLeaderships() {
    setLeaderships(null)
    try {
      const result = await successionOptionsAction({ userId: a.userId })
      if (result.ok) setLeaderships(result.data.leaderships)
      else setError(result.message)
    } catch {
      setError('查不到這個帳號的組長資料，請關閉後重新整理再試。')
    }
  }

  function open() {
    setReason('')
    setError(null)
    setReceipt(null)
    setSuccessors({})
    setRequestId(crypto.randomUUID())
    setIsOpen(true)
    dialogRef.current?.showModal()
    if (disabling) void loadLeaderships()
  }

  const stuck = leaderships?.filter((l) => l.candidates.length === 0) ?? []
  const ready = !disabling || (leaderships !== null && stuck.length === 0)

  function onClosed() {
    setIsOpen(false)
    if (receipt) router.refresh()
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!reason.trim()) {
      setError(`請寫${verb}的理由。`)
      return
    }
    const missing = disabling ? (leaderships ?? []).find((l) => !successors[l.groupId]) : undefined
    if (missing) {
      setError(`請選接任 ${missing.groupCode} 組長的同學。`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = disabling
        ? await disableAccountAction({
            userId: a.userId,
            reason,
            requestId,
            ...(leaderships && leaderships.length > 0
              ? { successorLeaders: leaderships.map((l) => ({ groupId: l.groupId, userId: successors[l.groupId]! })) }
              : {}),
          })
        : await restoreAccountAction({ userId: a.userId, reason, requestId })
      if (result.ok) setReceipt(result.data)
      else setError(result.message)
    } catch {
      setError(`結果未知：可能已經${verb}。請再按一次確認（不會重複${verb}），或關閉後重新整理。`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        className={cn(BUTTON, SECONDARY, 'h-7 border-transparent bg-transparent px-2.5 text-[0.8rem] font-medium hover:bg-muted')}
        aria-label={`${verb} ${a.name}`}
      >
        {verb}
      </button>
      <dialog
        ref={dialogRef}
        onClose={onClosed}
        aria-label={`${verb} ${a.name}`}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border-0 bg-popover p-0 ring-1 ring-foreground/10 backdrop:bg-black/10 backdrop:backdrop-blur-xs"
      >
        <div className="p-5">
          {!isOpen ? null : receipt ? (
            <div className="space-y-3 text-center" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                {receipt.status === 'disabled' ? '已停用' : '已恢復'}
              </p>
              <h2 className="text-lg font-extrabold text-foreground">{receipt.name}</h2>
              <p className="text-sm text-muted-foreground">
                {receipt.status === 'disabled'
                  ? '他在任何分頁做下一個動作就會被登出，也不能再登入；資料與紀錄都保留，可以隨時恢復。'
                  : receipt.status === 'pending'
                    ? '停用前就是待審，所以回到待審：本人可以重新登入、補送註冊申請。'
                    : '本人現在可以重新登入，角色與學籍資料不變。'}
                理由、操作者與時間已寫入紀錄。
              </p>
              {receipt.successions?.map((s) => (
                <p key={s.groupCode} className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
                  {s.groupCode} 的組長已改由 {s.leaderName} 接任，全組已收到通知。
                </p>
              ))}
              {receipt.revocation === 'failed' ? (
                <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {receipt.status === 'disabled'
                    ? '封鎖同步沒有完成（已留紀錄）；停用已經生效，本人已經進不來。'
                    : '解除封鎖沒有完成（已留紀錄）；本人可能暫時登入不了，請通知維運。'}
                </p>
              ) : null}
              <button type="button" onClick={() => dialogRef.current?.close()} className={cn(BUTTON, SECONDARY)}>
                關閉
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <h2 className="text-lg font-extrabold text-foreground">
                  {verb} {a.name}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {disabling
                    ? '停用不是刪除：本人會立刻被登出、不能再登入，但繳交、成績與紀錄都保留，可以隨時恢復。'
                    : '恢復後本人可以重新登入，角色與學籍資料不變。'}
                </p>
              </div>
              <dl className="grid grid-cols-[5rem_1fr] gap-y-1.5 rounded-lg bg-muted px-4 py-3 text-sm">
                <dt className="text-muted-foreground">帳號</dt>
                <dd className="break-all font-medium text-foreground">{a.loginEmail}</dd>
                <dt className="text-muted-foreground">學號</dt>
                <dd className="font-medium tabular-nums text-foreground">{a.studentNo ?? '—'}</dd>
              </dl>
              {disabling && leaderships === null && !error ? (
                <p className="text-sm text-muted-foreground" role="status">
                  正在確認他是不是組長…
                </p>
              ) : null}
              {disabling
                ? leaderships?.map((l) =>
                    l.candidates.length === 0 ? (
                      <p key={l.groupId} role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                        他是 {l.groupCode} 的組長，但這組沒有其他可以接任的成員。請先到「分組總覽」處理這組（加入組員或解散）再停用。
                      </p>
                    ) : (
                      <label key={l.groupId} className="block text-sm font-medium text-foreground">
                        接任 {l.groupCode} 組長 <span className="font-normal text-muted-foreground">・必填，他是這組的組長</span>
                        <select
                          value={successors[l.groupId] ?? ''}
                          onChange={(e) => {
                            setSuccessors((prev) => ({ ...prev, [l.groupId]: e.target.value }))
                            setError(null)
                          }}
                          className="mt-1.5 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
                        >
                          <option value="" disabled>
                            請選一位留在組裡的成員
                          </option>
                          {l.candidates.map((c) => (
                            <option key={c.userId} value={c.userId}>
                              {c.name}
                              {c.studentNo ? `（${c.studentNo}）` : ''}
                            </option>
                          ))}
                        </select>
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          停用與換組長一起完成；組員不變，不需要重簽。
                        </span>
                      </label>
                    ),
                  )
                : null}
              <label className="block text-sm font-medium text-foreground">
                理由 <span className="font-normal text-muted-foreground">・必填，會寫入紀錄</span>
                <textarea
                  rows={2}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value)
                    setError(null)
                  }}
                  placeholder={disabling ? '例：休學' : '例：復學'}
                  aria-invalid={error ? true : undefined}
                  className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 text-sm font-normal"
                />
              </label>
              {error ? (
                <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => dialogRef.current?.close()} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  取消
                </button>
                <button type="submit" className={cn(BUTTON, disabling ? DANGER : PRIMARY)} disabled={busy || !ready}>
                  {busy ? '處理中…' : `確認${verb}`}
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>
    </>
  )
}
