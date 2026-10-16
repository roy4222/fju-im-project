"use client"

import * as React from "react"
import Link from "next/link"
import { ActivityIcon } from "lucide-react"

import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import type { ToolEntry } from "@/lib/data/hosts"
import { toolNavItems, visibleNavItems, type NavContext } from "@/lib/data/nav"

export function AppSidebar({
  nav,
  tools,
  ...props
}: { nav: NavContext; tools: ToolEntry[] } & React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="開發者後台"
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link href="/" />}
            >
              <ActivityIcon className="size-5!" />
              <span className="text-base font-semibold group-data-[collapsible=icon]:hidden">開發者後台</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={visibleNavItems(nav).map((p) => ({ title: p.title, url: p.href, icon: <p.icon /> }))} />
        <NavSecondary
          label="外部工具"
          items={toolNavItems(tools).map(({ icon: Icon, ...t }) => ({ ...t, icon: <Icon /> }))}
          className="mt-auto"
        />
      </SidebarContent>
    </Sidebar>
  )
}
