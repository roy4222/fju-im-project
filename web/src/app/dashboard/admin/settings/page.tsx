import Link from 'next/link'
import { IconCalendarEvent, IconChevronRight, IconHistory, IconPhoto, IconUsersGroup } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { PageTitle } from '@/app/_ui/dashboard/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'

export const metadata = { title: '設定｜資管系專題平台' }

const BASE = '/dashboard/admin/settings'

/**
 * 系辦「設定」總頁（AD-20；設計方案 §7、Q104）：四張卡各連到既有的設定頁，沒有別的內容、沒有分頁列
 * （四個子頁自己的分頁列在 AD-12、AD-15）。側欄「設定」改連這頁由共用 SH-1-AD 做；在那之前這頁只是多一頁。
 *
 * 不讀任何資料（只有守衛的身分）。守衛在頁面自己（`_nav.ts` 的 `PROTECTED_ROUTES` 有這一列，pages.spec 逐條驗三種回應；
 * 指紋是時間軸卡的說明句「四個階段與活動日期」，不在 `metadata.title`）。
 */
const CARDS: { href: string; title: string; hint: string; icon: ReactNode }[] = [
  { href: '/dashboard/admin/cohorts', title: '屆別', hint: '一屆的開始、旗標與轉為進行中', icon: <IconUsersGroup aria-hidden /> },
  { href: '/dashboard/admin/timeline', title: '時間軸', hint: '四個階段與活動日期', icon: <IconCalendarEvent aria-hidden /> },
  { href: '/dashboard/admin/home-settings', title: '首頁設定', hint: '前台首頁大圖與標語', icon: <IconPhoto aria-hidden /> },
  { href: '/dashboard/admin/audit', title: '操作紀錄', hint: '誰在什麼時候做了什麼', icon: <IconHistory aria-hidden /> },
]

export default async function AdminSettingsPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole(BASE, 'admin')

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current={BASE}>
      <div className="flex flex-col gap-5">
        <PageTitle title="設定" />
        <ul className="grid gap-4 sm:grid-cols-2" aria-label="設定項目">
          {CARDS.map((card) => (
            <li key={card.href}>
              <Link href={card.href} className="dash-card dash-card-hover flex items-center gap-4 p-5" data-testid="settings-card">
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-muted text-foreground [&_svg]:size-5">
                  {card.icon}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-base font-semibold text-foreground">{card.title}</span>
                  <span className="text-sm text-muted-foreground">{card.hint}</span>
                </span>
                <IconChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </DashboardShell>
  )
}
