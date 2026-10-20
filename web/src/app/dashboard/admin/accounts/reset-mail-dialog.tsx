'use client'
import { IconMail } from '@tabler/icons-react'
import { useState } from 'react'
import type { AccountLookup } from '@/application/accounts'
import { cn } from '@/shared/cn'
import { sendResetMailAction } from './reset-mail-actions'
import { BUTTON, DIALOG, ErrorNote, PRIMARY, SECONDARY, TemporaryPasswordDialog, useDialog, type FieldError } from './temporary-password-dialog'

/**
 * 帳號列「寄重設密碼信」（C2-11；A15）。
 *
 * 系辦確認後，系統寄一封跟「忘記密碼」同一封的重設密碼信給本人，連結 30 分鐘內有效；
 * 系辦看不到連結、也不知道新密碼。信收不到時，視窗裡「收不到信？」改發臨時密碼（不問核實方式）。
 *
 * 只用 Google 登入的帳號沒有密碼，按鈕 disabled、旁邊寫原因（呼叫端用 `hasPassword` 判斷，這裡也再擋一次）。
 */
export function ResetMailDialog({ target, hasPassword }: { target: AccountLookup; hasPassword: boolean }) {
  const dialog = useDialog()
  const [error, setError] = useState<FieldError>(null)
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<{ email: string; validMinutes: number } | null>(null)

  function open() {
    setError(null)
    setSentTo(null)
    dialog.show()
  }

  async function send() {
    setBusy(true)
    setError(null)
    try {
      const result = await sendResetMailAction({ userId: target.userId })
      if (result.ok) setSentTo(result.data)
      else setError({ message: result.message })
    } catch {
      setError({ message: '寄送失敗，請再試一次；或改發臨時密碼。' })
    } finally {
      setBusy(false)
    }
  }

  if (!hasPassword) {
    return (
      <span className="flex items-center gap-2">
        <button
          type="button"
          disabled
          aria-label={`寄重設密碼信給 ${target.name}`}
          className={cn(BUTTON, SECONDARY, 'h-7 border-transparent bg-transparent px-2.5 text-[0.8rem] font-medium')}
        >
          <IconMail aria-hidden />
          寄重設密碼信
        </button>
        <span className="text-xs text-muted-foreground">這個帳號用 Google 登入，沒有密碼</span>
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-label={`寄重設密碼信給 ${target.name}`}
        className={cn(BUTTON, SECONDARY, 'h-7 border-transparent bg-transparent px-2.5 text-[0.8rem] font-medium hover:bg-muted')}
      >
        <IconMail aria-hidden />
        寄重設密碼信
      </button>
      <dialog ref={dialog.ref} onClose={dialog.onClosed} aria-label="寄重設密碼信" className={DIALOG}>
        <div className="max-h-[85vh] overflow-y-auto p-5">
          {!dialog.isOpen ? null : (
            <div className="space-y-4">
              {sentTo ? (
                <div className="space-y-3" role="status">
                  <p className="inline-block rounded-full bg-primary-subtle px-3 py-1 text-sm font-medium text-primary-on-subtle">已寄出</p>
                  <h2 className="text-lg font-extrabold text-foreground">已寄到 {sentTo.email}</h2>
                  <p className="text-sm text-muted-foreground">
                    信裡的連結 {sentTo.validMinutes} 分鐘內有效、只能用一次；本人設好新密碼後，舊的登入會被登出。操作者與時間已寫入紀錄。
                  </p>
                </div>
              ) : (
                <div>
                  <h2 className="text-lg font-extrabold text-foreground">寄重設密碼信給 {target.name}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    系統會寄一封重設密碼的信到 <strong className="break-all text-foreground">{target.email}</strong>，連結 30 分鐘內有效。
                    系辦看不到連結，也不會知道新密碼。
                  </p>
                </div>
              )}
              <ErrorNote error={error} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  收不到信？
                  <TemporaryPasswordDialog target={target} triggerLabel="改發臨時密碼" />
                </span>
                <span className="flex gap-2">
                  <button type="button" onClick={dialog.close} className={cn(BUTTON, SECONDARY)} disabled={busy}>
                    {sentTo ? '關閉' : '取消'}
                  </button>
                  {sentTo ? null : (
                    <button type="button" onClick={() => void send()} className={cn(BUTTON, PRIMARY)} disabled={busy}>
                      {busy ? '寄送中…' : '寄出'}
                    </button>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      </dialog>
    </>
  )
}
