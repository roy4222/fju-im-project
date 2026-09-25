'use client'
import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  IconAward,
  IconBell,
  IconBuildingFactory2,
  IconCalendarTime,
  IconChecklist,
  IconClipboardText,
  IconClock,
  IconFolders,
  IconHistory,
  IconLayoutDashboard,
  IconPencilPlus,
  IconSchool,
  IconSignature,
  IconUsers,
  IconUsersGroup,
  IconWorld,
  type Icon,
} from '@tabler/icons-react'
import { AccountMenu, type AccountLink } from '@/app/_ui/account-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/app/_ui/ui/sidebar'
import { TooltipProvider } from '@/app/_ui/ui/tooltip'
import { DashThemeToggle } from '@/app/_ui/dash-theme'

type Item = { href: string; label: string }

/**
 * 側欄分組與圖示（原型 `lib/nav-config.ts` 的五組）。
 *
 * 用網址最後一段對應，不改 `_nav.ts` 的清單格式：之後的票在清單加一列，
 * 這裡對得到就自動有圖示與分組；對不到的落在最後一組、用預設圖示。
 */
const GROUPS = ['總覽', '專題事務', '分組與產學', '評分與簽核', '系統管理'] as const
type Group = (typeof GROUPS)[number]

const SEGMENTS: Record<string, { group: Group; icon: Icon }> = {
  '': { group: '總覽', icon: IconLayoutDashboard },
  timeline: { group: '總覽', icon: IconCalendarTime },
  inbox: { group: '總覽', icon: IconBell },
  affairs: { group: '專題事務', icon: IconClipboardText },
  editor: { group: '專題事務', icon: IconPencilPlus },
  files: { group: '專題事務', icon: IconFolders },
  // 公開精選（票 25）：成果發布，放在專題事務。
  showcase: { group: '專題事務', icon: IconAward },
  groups: { group: '分組與產學', icon: IconUsersGroup },
  industry: { group: '分組與產學', icon: IconBuildingFactory2 },
  grading: { group: '評分與簽核', icon: IconChecklist },
  signoff: { group: '評分與簽核', icon: IconSignature },
  accounts: { group: '系統管理', icon: IconUsers },
  cohorts: { group: '系統管理', icon: IconSchool },
  clock: { group: '系統管理', icon: IconClock },
  audit: { group: '系統管理', icon: IconHistory },
}

function segmentOf(href: string): string {
  // /dashboard/<角色>/<段> → <段>；角色首頁 → ''
  return href.split('/').slice(3, 4)[0] ?? ''
}

function grouped(items: readonly Item[]): { title: Group; items: (Item & { icon: Icon })[] }[] {
  const byGroup = new Map<Group, (Item & { icon: Icon })[]>()
  for (const item of items) {
    const meta = SEGMENTS[segmentOf(item.href)] ?? { group: '系統管理' as const, icon: IconLayoutDashboard }
    const list = byGroup.get(meta.group) ?? []
    list.push({ ...item, icon: meta.icon })
    byGroup.set(meta.group, list)
  }
  return GROUPS.filter((g) => byGroup.has(g)).map((g) => ({ title: g, items: byGroup.get(g)! }))
}

/**
 * 後台外框（原型 `dashboard/[role]/layout.tsx`＋`app-sidebar`＋`dashboard-header`）：
 * 淡藍底、白色圓角側欄、內容是另一塊圓角面板；頂列左邊側欄開關與頁名，右邊通知鈴鐺與帳號選單。
 * 手機寬度側欄收成抽屜，由頂列的「側欄選單」打開。
 *
 * 通知鈴鐺是伺服器元件（每次換頁重算未讀數），從外面當 `bell` 傳進來。
 */
export function DashboardFrame({
  roleLabel,
  userName,
  sidebarOpen = true,
  badges = {},
  items,
  current,
  homeHref,
  switchLinks = [],
  bell,
  signOutFormId,
  children,
}: {
  roleLabel: string
  /** 本人姓名（頂列頭像）；取不到就顯示角色。 */
  userName?: string
  /** 側欄初始是否展開（伺服器從 cookie 讀）。 */
  sidebarOpen?: boolean
  /** 側欄數字徽章：href → 數字（伺服器算好；沒有就不顯示）。 */
  badges?: Readonly<Record<string, number>>
  items: readonly Item[]
  current: string
  homeHref: string
  /** 兼任角色的「切換到另一個後台」（票 41；伺服器依本人角色算好，單一角色是空的）。 */
  switchLinks?: readonly AccountLink[]
  bell: ReactNode
  signOutFormId: string
  children: ReactNode
}) {
  const groups = grouped(items)
  const title = items.find((item) => item.href === current)?.label ?? roleLabel
  const accountLinks: AccountLink[] = [
    { href: '/account', label: '我的帳號', icon: 'account' },
    ...switchLinks,
    { href: '/', label: '回到前台', icon: 'site' },
  ]

  return (
    // 側欄收合成圖示時，每一項 hover 會出現名稱提示（原型在根 layout 包 TooltipProvider）。
    <TooltipProvider>
    <SidebarProvider className="dash-frame" defaultOpen={sidebarOpen}>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader className="px-4 pt-4 pb-1">
          <Link href={homeHref} className="flex h-11 items-center group-data-[collapsible=icon]:justify-center" aria-label="回後台首頁">
            {/* 系網 logo 是靜態 PNG；不走 next/image（它會輸出 style 屬性，被正式站 CSP 擋）。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/fju-im-logo.png" alt="輔仁大學資訊管理學系" width={172} height={42} className="h-10 w-auto group-data-[collapsible=icon]:hidden" />
            <span className="hidden size-9 overflow-hidden group-data-[collapsible=icon]:block" aria-hidden>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/fju-im-logo.png" alt="" className="h-9 w-auto max-w-none" />
            </span>
          </Link>
          <span className="truncate pl-0.5 text-[12px] font-semibold text-muted-foreground group-data-[collapsible=icon]:hidden">
            專題管理平台
          </span>
        </SidebarHeader>

        <SidebarContent className="px-3 pt-2">
          <nav aria-label="後台導覽">
            {groups.map((group) => (
              <SidebarGroup key={group.title} className="py-0.5">
                <SidebarGroupLabel className="h-6 px-3 text-[11px] tracking-[0.08em] text-muted-foreground">{group.title}</SidebarGroupLabel>
                <SidebarMenu className="gap-0.5">
                  {group.items.map((item) => {
                    const active = item.href === current
                    const ItemIcon = item.icon
                    const badge = badges[item.href]
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          isActive={active}
                          tooltip={item.label}
                          className={`dash-nav-item h-9 rounded-xl px-3 transition-colors duration-150 ${active ? 'dash-nav-active font-bold' : 'font-medium'}`}
                          render={
                            <Link href={item.href} aria-current={active ? 'page' : undefined}>
                              <ItemIcon className="size-[19px]" strokeWidth={active ? 2.2 : 1.8} aria-hidden />
                              <span className="text-[14.5px]">{item.label}</span>
                            </Link>
                          }
                        />
                        {/* 原型 app-sidebar：橘底白字圓 pill；收合成圖示時隱藏（shadcn 預設）。 */}
                        {badge ? (
                          // 連結名稱不改（測試與螢幕報讀都用原本的項目名），數字是旁邊的一段字。
                          <SidebarMenuBadge
                            title={`${item.label}：${badge}`}
                            data-testid={`nav-badge-${item.href}`}
                            className="top-2 rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-active/menu-button:text-primary-foreground"
                          >
                            {badge > 99 ? '99+' : badge}
                          </SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroup>
            ))}
          </nav>
        </SidebarContent>

        <SidebarFooter className="px-3 pb-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="回到前台"
                className="dash-nav-item h-9 rounded-xl px-3 font-medium"
                render={
                  <Link href="/">
                    <IconWorld className="size-[19px]" strokeWidth={1.8} aria-hidden />
                    <span className="text-[14.5px]">回到前台</span>
                  </Link>
                }
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="dash-surface min-w-0">
        <header className="dash-header sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 px-3 md:px-5">
          <SidebarTrigger className="size-9 rounded-lg" />
          <p className="ml-1 truncate text-[15px] font-bold">{title}</p>
          <div className="ml-auto flex items-center gap-1.5">
            {/* 深淺色切換（票 35；原型頂列在鈴鐺左邊）。 */}
            <DashThemeToggle />
            {bell}
            <AccountMenu roleLabel={roleLabel} name={userName} links={accountLinks} signOutFormId={signOutFormId} compact />
          </div>
        </header>
        <div className="mx-auto w-full max-w-[1320px] min-w-0 flex-1 p-4 md:p-6 lg:px-8 lg:py-7">{children}</div>
      </SidebarInset>
    </SidebarProvider>
    </TooltipProvider>
  )
}
