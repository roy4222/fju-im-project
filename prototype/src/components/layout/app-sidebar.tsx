"use client";

import Link from "next/link";
import Image from "next/image";
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
  IconPencilPlus,
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
 * 後台側欄（2026-09-09 V4 定案：深藍底）。
 * - 展開：橫式 logo 反白，下一行「專題管理平台」；收合：只剩 logo 左邊的圖形（同一張圖靠左裁切）。
 * - 選中＝白色 13% 圓角塊＋橘 icon；不畫左線（Roy：「首頁旁邊有一根線很怪」）。
 * - 使用者與「回到前台」只在頂列帳號選單。
 */
export function AppSidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const base = `/dashboard/${role}`;
  const groups = navForRole(role);

  return (
    <Sidebar collapsible="icon" className="dash-sidebar border-r-0">
      <SidebarHeader className="px-3 pt-4 pb-1">
        <Link href={base} className="flex h-12 items-center rounded-md group-data-[collapsible=icon]:justify-center" aria-label="回首頁">
          <span className="relative block h-11 w-[184px] overflow-hidden group-data-[collapsible=icon]:hidden">
            <Image src="/brand/fju-im-logo.png" alt="輔仁大學資訊管理學系" fill sizes="184px" className="dash-logo object-contain object-left" priority />
          </span>
          {/* 收合時只露出 logo 最左邊的圖形：同一張圖用 object-cover 靠左裁，不會壓扁 */}
          <span className="relative hidden size-9 overflow-hidden group-data-[collapsible=icon]:block">
            <Image src="/brand/fju-im-logo.png" alt="" fill sizes="160px" className="dash-logo object-cover object-left" />
          </span>
        </Link>
        <span className="dash-brand-sub truncate pl-0.5 text-[12px] font-semibold group-data-[collapsible=icon]:hidden">專題管理平台</span>
      </SidebarHeader>

      <SidebarContent className="px-2 pt-2">
        {groups.map((group) => (
          <SidebarGroup key={group.title} className="py-1.5">
            <SidebarGroupLabel className="dash-nav-label h-7 text-[11px] tracking-[0.08em]">{group.title}</SidebarGroupLabel>
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
                      className={`dash-nav-item h-9 rounded-lg px-2.5 transition-colors duration-150 ${isActive ? "dash-nav-active font-bold" : ""}`}
                      render={
                        <Link href={href}>
                          <Icon className="size-[18px]" strokeWidth={isActive ? 2.2 : 1.8} />
                          <span className="text-[14px]">{item.label}</span>
                        </Link>
                      }
                    />
                    {badge ? <SidebarMenuBadge className="tabular top-2 rounded-full bg-brand px-1.5 text-[11px] font-bold text-brand-foreground">{badge}</SidebarMenuBadge> : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="px-3 pb-3">
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
    <button type="button" onClick={toggleSidebar} className="dash-collapse flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium transition-colors group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0" aria-label={collapsed ? "展開選單" : "收合選單"}>
      {collapsed ? <IconLayoutSidebarLeftExpand className="size-[18px] shrink-0" /> : <IconLayoutSidebarLeftCollapse className="size-[18px] shrink-0" />}
      <span className="group-data-[collapsible=icon]:hidden">收合選單</span>
    </button>
  );
}
