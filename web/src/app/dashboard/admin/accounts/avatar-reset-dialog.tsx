'use client'
import { useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/shared/cn'
import { resetAvatarAction } from './actions'
import type { DialogOpener } from './role-dialogs'

/**
 * 系辦重設某人的頭像（AD-B2；B 設計方案 §2.3）。
 *
 * 顯示目前頭像、寫理由（去頭尾空白後 1～200 字，空的先擋）、按「重設」。
 * 重設後對方回到依帳號 id 固定的預設圖；理由只寫進稽核，對方看不到。規則在用例，這裡的擋是為了少跑一趟。
 */

/** 同 `REASON_MAX`（app 對 application 只能帶型別，值在這裡寫一次；用例會再判）。 */
const REASON_MAX = 200

const BUTTON =
  'press inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4'
const SECONDARY = 'border border-border bg-background text-foreground hover:bg-muted'
const PRIMARY = 'bg-brand text-brand-foreground hover:bg-brand/90'
const FIELD =
  'mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none transition-[border-color,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25'

export type AvatarResetTarget = { readonly userId: string; readonly name: string }

/** `avatar` 是伺服器畫好的 `UserAvatar`（size 64）；它是 Server Component，client 對話框只能收 `ReactNode`。 */
export function AvatarResetDialog({
  account: a,
  avatar,
  opener,
}: {
  account: AvatarResetTarget
  avatar: ReactNode
  opener: Ref<DialogOpener>
}) {
  const router = useRouter()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useImperativeHandle(opener, () => ({
    open: () => {
      setReason('')
      setError(null)
      setDone(false)
      setIsOpen(true)
      dialogRef.current?.showModal()
    },
  }))

  function onClosed() {
    setIsOpen(false)
    if (done) router.refresh()
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = reason.trim()
    if (trimmed.length === 0) {
      setError('請填理由。')
      return
    }
    if (trimmed.length > REASON_MAX) {
      setError(`理由請在 ${REASON_MAX} 字以內。`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await resetAvatarAction(a.userId, trimmed)
      if (result.ok) setDone(true)
      else setError(result.message)
    } catch {
      setError('結果未知：可能已經完成。請關閉後重新整理確認。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClosed}
      aria-label={`重設 ${a.name} 的頭像`}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border-0 bg-popover p-0 whitespace-normal ring-1 ring-foreground/10 backdrop:bg-black/10 backdrop:backdrop-blur-xs"
    >
      <div className="p-5">
        {!isOpen ? null : done ? (
          <div className="space-y-3 text-center" role="status">
            <p className="inline-block rounded-full bg-muted px-3 py-1 text-sm font-medium text-foreground">已重設頭像</p>
            <p className="text-sm text-muted-foreground">{a.name} 的頭像已回到預設圖，理由、操作者與時間已寫入紀錄。</p>
            <button type="button" onClick={() => dialogRef.current?.close()} className={cn(BUTTON, SECONDARY)}>
              關閉
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <h2 className="text-lg font-extrabold text-foreground">重設 {a.name} 的頭像</h2>
            <div className="flex items-center gap-4">
              {avatar}
              <p className="text-sm text-muted-foreground">
                重設後會換回依帳號固定的預設圖；上傳的照片會刪除。對方可以自己再換。
              </p>
            </div>
            <label className="block text-sm font-medium text-foreground">
              理由（必填，對方看不到）
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value)
                  setError(null)
                }}
                className={FIELD}
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
              <button type="submit" className={cn(BUTTON, PRIMARY)} disabled={busy}>
                {busy ? '處理中…' : '重設'}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  )
}
