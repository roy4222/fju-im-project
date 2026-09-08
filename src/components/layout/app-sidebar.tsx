"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  IconArrowLeft,
  IconBell,
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
} from "@/components/ui/sidebar";
import { navForRole, ROLE_LABEL, type NavIcon } from "@/lib/nav-config";
import { COHORT, CURRENT_USERS, type Role } from "@/lib/fixtures";

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
  const user = CURRENT_USERS[role];

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="px-3 pt-3">
        <Link href={base} className="flex flex-col gap-1.5 rounded-md p-1.5 transition-colors hover:bg-sidebar-accent group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:p-1">
          <Image src="/brand/fju-im-logo.png" alt="輔仁大學資訊管理學系" width={763} height={187} className="h-7 w-auto group-data-[collapsible=icon]:hidden" />
          <span className="hidden size-8 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground group-data-[collapsible=icon]:flex" aria-hidden>資</span>
          <span className="truncate text-[12px] font-semibold text-muted-foreground group-data-[collapsible=icon]:hidden">專題管理平台・{COHORT.code} 學年度</span>
        </Link>
      </SidebarHeader>

      <SidebarContent className="px-1.5">
        {groups.map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel className="text-[11px] tracking-wider">{group.title}</SidebarGroupLabel>
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
                      className="h-9 rounded-lg transition-colors duration-150 data-[active=true]:bg-primary data-[active=true]:text-primary-foreground"
                      render={
                        <Link href={href}>
                          <Icon className="size-4.5" />
                          <span className="text-[14px] font-medium">{item.label}</span>
                        </Link>
                      }
                    />
                    {badge ? <SidebarMenuBadge className={`tabular text-[11px] font-semibold ${isActive ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{badge}</SidebarMenuBadge> : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="px-3 pb-3">
        <Link href="/" className="flex items-center gap-2 rounded-lg border border-sidebar-border px-2.5 py-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <IconArrowLeft className="size-4 shrink-0" />
          <span className="group-data-[collapsible=icon]:hidden">回到前台網站</span>
        </Link>
        <div className="flex items-center gap-2.5 px-1 pt-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-xs font-bold text-brand-on-subtle">{user.name.slice(0, 1)}</span>
          <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold">{user.name}</span>
            <span className="truncate text-[11px] text-muted-foreground">{ROLE_LABEL[role]}{user.studentNo ? `・${user.studentNo}` : ""}</span>
          </span>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
