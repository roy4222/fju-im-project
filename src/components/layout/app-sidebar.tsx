"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
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
} from "@/components/ui/sidebar";
import { navForRole, ROLE_LABEL, type NavIcon } from "@/lib/nav-config";
import { COHORT, CURRENT_USERS, type Role } from "@/lib/fixtures";

const ICONS: Record<NavIcon, typeof IconLayoutDashboard> = {
  dashboard: IconLayoutDashboard,
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

export function AppSidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const base = `/dashboard/${role}`;
  const groups = navForRole(role);
  const user = CURRENT_USERS[role];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-md p-1.5 transition-colors hover:bg-sidebar-accent"
        >
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-[9px] font-bold leading-tight text-primary-foreground"
          >
            FJU
            <br />
            IM
          </span>
          <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold">資管系專題</span>
            <span className="truncate text-xs text-muted-foreground">
              {COHORT.label}
            </span>
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const href = base + item.href;
                const Icon = ICONS[item.icon];
                const isActive =
                  item.href === ""
                    ? pathname === base
                    : pathname.startsWith(href);
                return (
                  <SidebarMenuItem key={item.label + item.href}>
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={item.label}
                      render={
                        <Link href={href}>
                          <Icon />
                          <span>{item.label}</span>
                        </Link>
                      }
                    />
                    {item.badge ? (
                      <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-2.5 rounded-md p-1.5">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground"
          >
            {user.name.slice(0, 1)}
          </span>
          <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-medium">{user.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {ROLE_LABEL[role]}
              {user.studentNo ? `・${user.studentNo}` : ""}
            </span>
          </span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
