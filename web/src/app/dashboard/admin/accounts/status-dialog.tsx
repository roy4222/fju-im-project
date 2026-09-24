'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { StatusChangeReceipt } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { disableAccountAction, restoreAccountAction } from './actions'

/**
 * 停用／恢復一個帳號（票 9；原型 `/dashboard/admin/accounts` 的 ToggleStatusDialog）。
 *
 * 先講影響、理由必填，送出後顯示回執；關掉對話框才刷新列表（同審核對話框的作法）。
 * 規則都在伺服器：這裡只把輸入送過去、把結果照實顯示。
 */

const BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50'
const PRIMARY = 'bg-primary text-primary-foreground hover:bg-primary/90'
const SECONDARY = 'bg-muted text-foreground hover:bg-border'
const DANGER = 'bg-danger text-white hover:bg-danger/90'

export type StatusTarget = {
  readonly userId: string
  readonly name: string
  readonly loginEmail: string
  readonly studentNo: string | null
  readonly status: 'active' | 'disabled'
}

export function StatusDialog({ account: a }: { account: StatusTarget }) {
  const router = useRouter()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const disabling = a.status === 'active'
  const verb = disabling ? '停用' : '恢復'
  const [isOpen, setIsOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<StatusChangeReceipt | null>(null)
  const [requestId, setRequestId] = useState('')

  function open() {
    setReason('')
    setError(null)
    setReceipt(null)
    setRequestId(crypto.randomUUID())
    setIsOpen(true)
    dialogRef.current?.showModal()
  }

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
    setBusy(true)
    setError(null)
    try {
      const action = disabling ? disableAccountAction : restoreAccountAction
      const result = await action({ userId: a.userId, reason, requestId })
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
        className={cn(BUTTON, SECONDARY, 'whitespace-nowrap px-3 py-1.5')}
        aria-label={`${verb} ${a.name}`}
      >
        {verb}
      </button>
      <dialog
        ref={dialogRef}
        onClose={onClosed}
        aria-label={`${verb} ${a.name}`}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40"
      >
        <div className="p-5">
          {!isOpen ? null : receipt ? (
            <div className="space-y-3 text-center" role="status">
              <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">
                {receipt.status === 'disabled' ? '已停用' : '已恢復'}
              </p>
              <h2 className="text-lg font-semibold text-ink">{receipt.name}</h2>
              <p className="text-sm text-muted-foreground">
                {receipt.status === 'disabled'
                  ? '他在任何分頁做下一個動作就會被登出，也不能再登入；資料與紀錄都保留，可以隨時恢復。'
                  : '本人現在可以重新登入，角色與學籍資料不變。'}
                理由、操作者與時間已寫入紀錄。
              </p>
              {receipt.revocation === 'failed' ? (
                <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
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
                <h2 className="text-lg font-semibold text-ink">
                  {verb} {a.name}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {disabling
                    ? '停用不是刪除：本人會立刻被登出、不能再登入，但繳交、成績與紀錄都保留，可以隨時恢復。'
                    : '恢復後本人可以重新登入，角色與學籍資料不變。'}
                </p>
              </div>
              <dl className="grid grid-cols-[5rem_1fr] gap-y-1.5 rounded-md bg-muted px-4 py-3 text-sm">
                <dt className="text-muted-foreground">帳號</dt>
                <dd className="break-all font-medium text-ink">{a.loginEmail}</dd>
                <dt className="text-muted-foreground">學號</dt>
                <dd className="font-medium tabular-nums text-ink">{a.studentNo ?? '—'}</dd>
              </dl>
              <label className="block text-sm font-medium text-ink">
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
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-normal"
                />
              </label>
              {error ? (
                <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => dialogRef.current?.close()} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                  取消
                </button>
                <button type="submit" className={cn(BUTTON, disabling ? DANGER : PRIMARY)} disabled={busy}>
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
