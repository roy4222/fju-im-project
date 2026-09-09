"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  IconBell,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconBuildingFactory2,
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

/** 後台側欄：240px、可收合成 icon；品牌 logo、分組導覽、右下角回前台。 */
export function AppSidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const base = `/dashboard/${role}`;
  const groups = navForRole(role);

  return (
    <Sidebar collapsible="icon" className="dash-sidebar border-r-0">
      <SidebarHeader className="px-3 pt-3">
        <Link href={base} className="flex flex-col gap-1.5 rounded-md p-1.5 transition-colors hover:bg-sidebar-accent group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:p-1">
          <Image src="/brand/fju-im-logo.png" alt="輔仁大學資訊管理學系" width={763} height={187} sizes="200px" className="dash-logo w-[196px] group-data-[collapsible=icon]:hidden dark:[filter:brightness(0)_invert(1)]" style={{ height: "auto" }} />
          <span className="hidden size-8 items-center justify-center rounded-md bg-brand text-[11px] font-bold text-brand-foreground group-data-[collapsible=icon]:flex" aria-hidden>資</span>
          <span className="dash-brand-sub truncate text-[12px] font-semibold text-muted-foreground group-data-[collapsible=icon]:hidden">專題管理平台</span>
        </Link>
      </SidebarHeader>

      <SidebarContent className="px-1.5">
        {groups.map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel className="dash-nav-label text-[11px] tracking-wider">{group.title}</SidebarGroupLabel>
            <SidebarMenu>
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
                      className={`dash-nav-item h-9 rounded-lg transition-colors duration-150 ${isActive ? "dash-nav-active bg-brand-subtle font-bold text-primary shadow-[inset_3px_0_0_var(--brand)] hover:bg-brand-subtle [&_svg]:text-brand" : ""}`}
                      render={
                        <Link href={href}>
                          <Icon className="size-4.5" />
                          <span className="text-[14px] font-medium">{item.label}</span>
                        </Link>
                      }
                    />
                    {badge ? <SidebarMenuBadge className="tabular rounded-full bg-brand px-1.5 text-[11px] font-bold text-brand-foreground">{badge}</SidebarMenuBadge> : null}
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

/** 側欄底部的收合／展開鈕（Roy 2026-09-08：左邊要可折疊） */
function CollapseButton() {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <button type="button" onClick={toggleSidebar} className="dash-collapse flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0" aria-label={collapsed ? "展開選單" : "收合選單"}>
      {collapsed ? <IconLayoutSidebarLeftExpand className="size-4.5 shrink-0" /> : <IconLayoutSidebarLeftCollapse className="size-4.5 shrink-0" />}
      <span className="group-data-[collapsible=icon]:hidden">收合選單</span>
    </button>
  );
}
