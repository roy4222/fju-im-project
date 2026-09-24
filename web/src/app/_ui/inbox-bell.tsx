import Link from 'next/link'
import { currentActor } from '@/app/_ui/guard'
import { getInboxQuery } from '@/composition/inbox'

/**
 * 頂列的通知鈴鐺（票 12；原型 `dashboard-header.tsx` 的鈴鐺）。徽章＝本人未讀數，點下去到通知匣。
 *
 * 是 server component：每次換頁重新算一次，沒有 client JS，也就不必為了它放寬 CSP。
 * 讀不到（資料庫暫時有問題）就只顯示鈴鐺、不顯示數字，不要讓整個後台跟著壞。
 */
export async function InboxBell({ href }: { href: string }) {
  let unread = 0
  try {
    unread = await getInboxQuery().unreadCount(await currentActor())
  } catch (error) {
    console.error('[inbox-bell] 讀不到未讀數', error)
  }
  const label = unread > 0 ? `通知，${unread} 則未讀` : '通知，沒有未讀'

  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      data-testid="inbox-bell"
      className="relative inline-flex size-8 items-center justify-center rounded-md hover:bg-white/10"
    >
      <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="size-4.5">
        <path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6" />
        <path d="M9 17v1a3 3 0 0 0 6 0v-1" />
      </svg>
      {unread > 0 ? (
        <span
          data-testid="inbox-bell-count"
          className="absolute -top-1 -right-1 min-w-4.5 rounded-full bg-primary px-1 text-center text-[11px] leading-4.5 font-semibold text-primary-foreground tabular-nums"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </Link>
  )
}
