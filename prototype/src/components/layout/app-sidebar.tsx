"use client";

import Link from "next/link";
import Image from "next/image";
import { useRef } from "react";
import { usePathname } from "next/navigation";
import {
  IconBell,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconBuildingFactory2,
  IconCalendarTime,
  IconChecklist,
  IconClipboardText,
  IconFolders,
  IconHistory,
  IconLayoutDashboard,
  IconLogout,
  IconPencilPlus,
  IconSettings,
  IconSignature,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { navForRole, type NavIcon } from "@/lib/nav-config";
import type { Role } from "@/lib/fixtures";

const ICONS: Record<NavIcon, typeof IconLayoutDashboard> = {
  dashboard: IconLayoutDashboard,
  timeline: IconCalendarTime,
  inbox: IconBell,
  affairs: IconClipboardText,
  editor: IconPencilPlus,
  groups: IconUsersGroup,
  industry: IconBuildingFactory2,
  grading: IconChecklist,
  signoff: IconSignature,
  accounts: IconUsers,
  audit: IconHistory,
  files: IconFolders,
};

/**
 * 後台側欄（2026-09-09 第三輪）：白底圓角面板，選中＝淡藍圓角塊＋深藍字；底部固定「個人設定」「登出」（Roy 喜歡參考站這個位置）。
 * 收合只剩 logo 最左邊的圖形（同一張圖靠左裁）。
 */
export function AppSidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const base = `/dashboard/${role}`;
  const groups = navForRole(role);
  const logoutForm = useRef<HTMLFormElement>(null);

  return (
    <Sidebar collapsible="icon" variant="inset" className="dash-sidebar">
      <SidebarHeader className="px-4 pt-4 pb-1">
        <Link href={base} className="flex h-11 items-center group-data-[collapsible=icon]:justify-center" aria-label="回首頁">
          <span className="relative block h-10 w-[172px] overflow-hidden group-data-[collapsible=icon]:hidden">
            <Image src="/brand/fju-im-logo.png" alt="輔仁大學資訊管理學系" fill sizes="172px" className="object-contain object-left" priority />
          </span>
          <span className="relative hidden size-9 overflow-hidden group-data-[collapsible=icon]:block">
            <Image src="/brand/fju-im-logo.png" alt="" fill sizes="160px" className="object-cover object-left" />
          </span>
        </Link>
        <span className="dash-brand-sub truncate pl-0.5 text-[12px] font-semibold text-muted-foreground group-data-[collapsible=icon]:hidden">專題管理平台</span>
      </SidebarHeader>

      <SidebarContent className="px-3 pt-2">
        {groups.map((group) => (
          <SidebarGroup key={group.title} className="py-0.5">
            <SidebarGroupLabel className="dash-nav-label h-6 px-3 text-[11px] tracking-[0.08em] text-muted-foreground">{group.title}</SidebarGroupLabel>
            <SidebarMenu className="gap-0.5">
              {group.items.map((item) => {
                const href = base + item.href;
                const Icon = ICONS[item.icon];
                const isActive = item.href === "" ? pathname === base : pathname.startsWith(href);
                const badge = item.badge?.[role];
                return (
                  <SidebarMenuItem key={item.label + item.href}>
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={item.label}
                      className={`dash-nav-item h-9 rounded-xl px-3 transition-colors duration-150 ${isActive ? "dash-nav-active font-bold" : "font-medium"}`}
                      render={
                        <Link href={href}>
                          <Icon className="size-[19px]" strokeWidth={isActive ? 2.2 : 1.8} />
                          <span className="text-[14.5px]">{item.label}</span>
                        </Link>
                      }
                    />
                    {badge ? <SidebarMenuBadge className="tabular top-2.5 rounded-full bg-brand px-1.5 text-[11px] font-bold text-brand-foreground">{badge}</SidebarMenuBadge> : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="px-3 pb-3">
        <form ref={logoutForm} method="post" action="/api/proto-role" className="hidden">
          <input type="hidden" name="role" value="guest" />
          <input type="hidden" name="returnTo" value="/" />
        </form>
        <SidebarMenu className="gap-1">
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="個人設定" className="dash-nav-item h-9 rounded-xl px-3 font-medium" render={<Link href="/account"><IconSettings className="size-[19px]" strokeWidth={1.8} /><span className="text-[14.5px]">個人設定</span></Link>} />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="登出" className="dash-nav-item h-9 rounded-xl px-3 font-medium" onClick={() => logoutForm.current?.requestSubmit()}>
              <IconLogout className="size-[19px]" strokeWidth={1.8} /><span className="text-[14.5px]">登出</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <CollapseButton />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function CollapseButton() {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <button type="button" onClick={toggleSidebar} className="dash-collapse flex h-8 w-full items-center gap-2 rounded-xl px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0" aria-label={collapsed ? "展開選單" : "收合選單"}>
      {collapsed ? <IconLayoutSidebarLeftExpand className="size-[18px] shrink-0" /> : <IconLayoutSidebarLeftCollapse className="size-[18px] shrink-0" />}
      <span className="group-data-[collapsible=icon]:hidden">收合選單</span>
    </button>
  );
}
