'use client'
import { useEffect, useState, useTransition } from 'react'
import { IconBellRinging } from '@tabler/icons-react'
import { remindGradingAction, remindOverdueAction } from './remind-actions'
import { BTN_OUTLINE } from '@/app/_ui/dashboard-kit'
import { cn } from '@/shared/cn'

export type HomeRemindState = { ok: boolean; message: string } | undefined

const ACTIONS = { overdue: remindOverdueAction, grading: remindGradingAction } as const

/**
 * 系辦首頁「逾期未繳」「評分還差」卡下方的「催繳」（C 階段規格① §8、AC-34）。
 *
 * 按一下就送（日常動作，不另跳確認框）；結果在右下角提示（「已通知 N 人（1 份作業 24 小時內催過，略過）」「已通知 2 位老師」）。
 * 伺服器刷新後換成冷卻中：停用，旁邊寫「上次催繳剛剛，{時間} 後可再催」；兩顆鈕各自冷卻。
 * 請求編號由伺服器每次 render 給一個新的：同一畫面連點只算一次。
 */
export function HomeRemindButton({
  kind,
  cohortId,
  blocked,
  requestId,
  label,
}: {
  kind: keyof typeof ACTIONS
  cohortId: string
  /** 停用時寫在旁邊的原因（冷卻中）；可以催是 null。 */
  blocked: string | null
  requestId: string
  /** 按鈕的無障礙名稱（兩張卡都寫「催繳」，報讀時要分得出是哪一張）。 */
  label: string
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
        const result = await ACTIONS[kind](cohortId, requestId)
        if (result) setToast({ ok: result.ok, text: result.message })
      } catch {
        setToast({ ok: false, text: '連線中斷；結果尚未確認，請重新整理頁面看「上次催繳」再決定要不要再按一次。' })
      }
    })

  return (
    <span className="flex flex-wrap items-center gap-2 px-1">
      <button
        type="button"
        className={cn(BTN_OUTLINE, 'pointer-coarse:min-h-11')}
        disabled={pending || blocked !== null}
        onClick={remind}
        aria-label={label}
        data-testid={`remind-${kind}`}
      >
        <IconBellRinging aria-hidden />
        {pending ? '催繳中…' : '催繳'}
      </button>
      {blocked ? (
        <span className="text-xs text-muted-foreground" data-testid={`remind-${kind}-cooldown`}>
          {blocked}
        </span>
      ) : null}
      {toast ? (
        <p
          role="status"
          data-testid={`remind-${kind}-toast`}
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
