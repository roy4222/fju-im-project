"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  IconBell,
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
  IconWorld,
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
 * 後台側欄：白底圓角面板，選中＝淡藍圓角塊＋深藍字。
 * 2026-09-10 Roy：底部只放「回到前台」；個人資料與登出在右上帳號選單；收合用頂列的開關。收合只剩 logo 最左邊的圖形。
 */
export function AppSidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const base = `/dashboard/${role}`;
  const groups = navForRole(role);

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
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="回到前台" className="dash-nav-item h-9 rounded-xl px-3 font-medium" render={<Link href="/"><IconWorld className="size-[19px]" strokeWidth={1.8} /><span className="text-[14.5px]">回到前台</span></Link>} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
