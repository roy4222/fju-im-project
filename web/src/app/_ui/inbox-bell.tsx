import Link from 'next/link'
import { IconBell } from '@tabler/icons-react'
import { unreadCount } from '@/app/_ui/nav-badges'

/**
 * 頂列的通知鈴鐺（票 12；原型 `dashboard-header.tsx` 的鈴鐺，位置與樣式照原型）。徽章＝本人未讀數，點下去到通知匣。
 *
 * 是 server component：每次換頁重新算一次，沒有 client JS，也就不必為了它放寬 CSP。
 * 讀不到（資料庫暫時有問題）就只顯示鈴鐺、不顯示數字，不要讓整個後台跟著壞。
 */
export async function InboxBell({ href }: { href: string }) {
  // 跟側欄「通知」的徽章共用同一次查詢（nav-badges.ts）；讀不到是 undefined，當作 0。
  const unread = (await unreadCount()) ?? 0
  const label = unread > 0 ? `通知，${unread} 則未讀` : '通知，沒有未讀'

  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      data-testid="inbox-bell"
      className="relative inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <IconBell aria-hidden className="size-4.5" />
      {unread > 0 ? (
        <span
          data-testid="inbox-bell-count"
          className="notif-dot absolute top-0.5 right-0.5 min-w-4.5 rounded-full bg-primary px-1 text-center text-[11px] leading-4.5 font-semibold text-primary-foreground tabular-nums"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </Link>
  )
}
