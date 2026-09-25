'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { DeidentifyPreview, DeidentifyReceipt } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { deidentifyAccountAction, previewDeidentifyAction } from './actions'

/**
 * 去識別化一個帳號（票 40；ACC-14；原型的「永久刪除」正式版改成去識別化，工程模組 01 §7.2）。
 *
 * 三段：先看影響預覽（對象、會清掉什麼、保留多少紀錄、擋住的原因）→ 寫理由、照打登入 Email →
 * 回執只顯示代稱。規則全在伺服器：預覽是伺服器算的，送出時伺服器鎖住帳號再判一次同一套條件。
 */

const BUTTON =
  'press inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'
const SECONDARY = 'border border-border bg-background text-foreground hover:bg-muted'
const DANGER = 'bg-destructive/10 text-destructive hover:bg-destructive/20'
const FIELD =
  'mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25'

export type DeidentifyTarget = { readonly userId: string; readonly name: string }

export function DeidentifyDialog({ account: a }: { account: DeidentifyTarget }) {
  const router = useRouter()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [preview, setPreview] = useState<DeidentifyPreview | null>(null)
  const [reason, setReason] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<DeidentifyReceipt | null>(null)
  const [requestId, setRequestId] = useState('')

  async function open() {
    setPreview(null)
    setReason('')
    setConfirmText('')
    setError(null)
    setReceipt(null)
    setRequestId(crypto.randomUUID())
    setIsOpen(true)
    dialogRef.current?.showModal()
    setBusy(true)
    try {
      const result = await previewDeidentifyAction({ userId: a.userId })
      if (result.ok) setPreview(result.data)
      else setError(result.message)
    } catch {
      setError('讀不到影響預覽，請關閉後重新整理再試。')
    } finally {
      setBusy(false)
    }
  }

  function onClosed() {
    setIsOpen(false)
    if (receipt) router.refresh()
  }

  const confirmOk = preview !== null && confirmText.trim().toLowerCase() === preview.loginEmail.trim().toLowerCase()
  const blocked = preview !== null && preview.blockers.length > 0

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!preview || blocked) return
    if (!reason.trim()) {
      setError('請寫去識別化的理由。')
      return
    }
    if (!confirmOk) {
      setError('請照打這個帳號的登入 Email。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await deidentifyAccountAction({ userId: a.userId, reason, confirmText, requestId })
      if (result.ok) setReceipt(result.data)
      else setError(result.message)
    } catch {
      setError('結果未知：可能已經完成。請再按一次確認（不會重複執行），或關閉後重新整理。')
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
        aria-label={`去識別化 ${a.name}`}
      >
        去識別化
      </button>
      <dialog
        ref={dialogRef}
        onClose={onClosed}
        aria-label={`去識別化 ${a.name}`}
        className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border-0 bg-popover p-0 ring-1 ring-foreground/10 backdrop:bg-black/10 backdrop:backdrop-blur-xs"
      >
        <div className="p-5">
          {!isOpen ? null : receipt ? (
            <div className="space-y-3 text-center" role="status">
              <p className="inline-block rounded-full bg-muted px-3 py-1 text-sm font-medium text-foreground">已去識別化</p>
              <h2 className="text-lg font-extrabold text-foreground" data-testid="deidentify-pseudonym">
                {receipt.pseudonym}
              </h2>
              <p className="text-sm text-muted-foreground">
                個人資料已清除，這個帳號之後不能再登入。繳交、成績、簽核與操作紀錄都保留，改顯示上面的代稱。理由、操作者與時間已寫入紀錄。
              </p>
              {receipt.revocation === 'failed' ? (
                <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                  封鎖同步沒有完成（已留紀錄，會自動重試）；登入中的裝置已經登出。
                </p>
              ) : null}
              <button type="button" onClick={() => dialogRef.current?.close()} className={cn(BUTTON, SECONDARY)}>
                關閉
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <h2 className="text-lg font-extrabold text-foreground">去識別化 {a.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  這是永久刪除個資的正式作法，<strong className="font-semibold text-foreground">做了就不能復原</strong>。紀錄不刪，只把人換成代稱。
                </p>
              </div>

              {preview ? (
                <>
                  <dl className="grid grid-cols-[5.5rem_1fr] gap-y-1.5 rounded-lg bg-muted px-4 py-3 text-sm">
                    <dt className="text-muted-foreground">登入 Email</dt>
                    <dd className="break-all font-medium text-foreground">{preview.loginEmail}</dd>
                    <dt className="text-muted-foreground">學號</dt>
                    <dd className="font-medium tabular-nums text-foreground">{preview.studentNo ?? '—'}</dd>
                    <dt className="text-muted-foreground">之後顯示為</dt>
                    <dd className="font-medium text-foreground">{preview.pseudonym}</dd>
                  </dl>
                  <div className="grid gap-3 text-sm sm:grid-cols-2">
                    <section aria-label="會清除">
                      <h3 className="font-semibold text-foreground">會清除</h3>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                        {preview.clears.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </section>
                    <section aria-label="會保留">
                      <h3 className="font-semibold text-foreground">會保留</h3>
                      <ul className="mt-1 space-y-0.5 text-muted-foreground" data-testid="deidentify-retained">
                        {preview.retained.map((r) => (
                          <li key={r.label} className="flex justify-between gap-3">
                            <span>{r.label}</span>
                            <span className="tabular-nums text-foreground">{r.count}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  </div>
                  {blocked ? (
                    <div role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                      現在不能去識別化：
                      <ul className="mt-1 list-disc pl-5">
                        {preview.blockers.map((b) => (
                          <li key={b}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <>
                      <label className="block text-sm font-medium text-foreground">
                        理由 <span className="font-normal text-muted-foreground">・必填，會寫入紀錄</span>
                        <textarea
                          rows={2}
                          value={reason}
                          onChange={(e) => {
                            setReason(e.target.value)
                            setError(null)
                          }}
                          placeholder="例：本人申請刪除個資"
                          className={FIELD}
                        />
                      </label>
                      <label className="block text-sm font-medium text-foreground">
                        照打登入 Email 確認 <span className="font-normal text-muted-foreground">・{preview.loginEmail}</span>
                        <input
                          type="text"
                          value={confirmText}
                          onChange={(e) => {
                            setConfirmText(e.target.value)
                            setError(null)
                          }}
                          autoComplete="off"
                          spellCheck={false}
                          aria-label="照打登入 Email 確認"
                          className={FIELD}
                        />
                      </label>
                    </>
                  )}
                </>
              ) : busy ? (
                <p className="text-sm text-muted-foreground" role="status">
                  正在計算影響…
                </p>
              ) : null}

              {error ? (
                <p role="alert" className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => dialogRef.current?.close()} className={cn(BUTTON, SECONDARY)} disabled={busy && !!preview}>
                  取消
                </button>
                {preview && !blocked ? (
                  <button type="submit" className={cn(BUTTON, DANGER)} disabled={busy || !confirmOk || !reason.trim()}>
                    {busy ? '處理中…' : '確認去識別化'}
                  </button>
                ) : null}
              </div>
            </form>
          )}
        </div>
      </dialog>
    </>
  )
}
