'use client'
import { useEffect, useState, useTransition } from 'react'
import { IconBellRinging } from '@tabler/icons-react'
import { remindItemAction } from './actions'
import { BTN_OUTLINE } from '@/app/_ui/dashboard-kit'
import { cn } from '@/shared/cn'

export type RemindActionState = { ok: boolean; message: string } | undefined

/**
 * 繳交狀況頁頂部的「催繳未繳（N 人）」（C 階段規格① §8、AC-12）。
 *
 * 按一下就送（日常動作，不另跳確認框）：名單上還沒完成的人各收一則站內通知與一封信。成功在右下角提示「已通知 N 人」；
 * 伺服器刷新後按鈕換成冷卻中——停用，旁邊寫「上次催繳剛剛，{時間} 後可再催」（24 小時一次，`describeCooldown`）。
 * 沒有要催的人（都交了）也停用。請求編號由伺服器每次 render 給一個新的：同一畫面連點只算一次。
 */
export function RemindButton({
  itemId,
  count,
  unknownCount,
  blocked,
  requestId,
}: {
  itemId: string
  /** 會收到通知的人數（整組展開組員）。 */
  count: number
  /** 站內同意書：人數看簽核包，這裡算不到，按鈕不寫人數。 */
  unknownCount?: boolean
  /** 停用時寫在旁邊的原因（冷卻中、沒有要催的人）；可以催是 null。 */
  blocked: string | null
  requestId: string
}) {
  const [pending, start] = useTransition()
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const remind = () =>
    start(async () => {
      try {
        const result = await remindItemAction(itemId, requestId)
        if (result) setToast({ ok: result.ok, text: result.message })
      } catch {
        setToast({ ok: false, text: '連線中斷；結果尚未確認，請重新整理頁面看「上次催繳」再決定要不要再按一次。' })
      }
    })

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={cn(BTN_OUTLINE, 'pointer-coarse:min-h-11')}
        disabled={pending || blocked !== null}
        onClick={remind}
        data-testid="remind-button"
      >
        <IconBellRinging aria-hidden />
        {pending ? '催繳中…' : unknownCount ? '催繳未完成' : `催繳未繳（${count} 人）`}
      </button>
      {blocked ? (
        <span className="text-xs text-muted-foreground" data-testid="remind-cooldown">
          {blocked}
        </span>
      ) : null}
      {toast ? (
        <p
          role="status"
          data-testid="remind-toast"
          className={cn(
            'fixed right-4 bottom-4 z-50 max-w-[calc(100vw-2rem)] rounded-lg px-4 py-2.5 text-sm font-semibold shadow-lg',
            toast.ok ? 'bg-ink text-ink-foreground' : 'bg-destructive text-white',
          )}
        >
          {toast.text}
        </p>
      ) : null}
    </span>
  )
}
