"use client"

import * as React from "react"
import Link from "next/link"
import { ActivityIcon, DatabaseIcon, LayoutDashboardIcon, MapIcon, RocketIcon, ScrollTextIcon, ServerIcon, ListChecksIcon } from "lucide-react"

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
import type { PageEntry, ToolEntry } from "@/lib/data/hosts"

const PAGE_ICONS: Record<string, React.ReactNode> = {
  "/": <LayoutDashboardIcon />,
  "/map": <MapIcon />,
  "/progress": <ListChecksIcon />,
  "/go-live": <RocketIcon />,
}

const TOOL_ICONS: Record<ToolEntry["key"], React.ReactNode> = {
  vm: <ServerIcon />,
  logs: <ScrollTextIcon />,
  db: <DatabaseIcon />,
}

export function AppSidebar({
  pages,
  tools,
  ...props
}: { pages: PageEntry[]; tools: ToolEntry[] } & React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="data-[slot=sidebar-menu-button]:p-1.5!" render={<Link href="/" />}>
              <ActivityIcon className="size-5!" />
              <span className="text-base font-semibold">開發者後台</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain
          items={[{ href: "/", title: "總覽" }, ...pages].map((p) => ({ title: p.title, url: p.href, icon: PAGE_ICONS[p.href] }))}
        />
        <NavSecondary
          label="工具"
          items={tools.map((t) => ({ title: `${t.tool}・${t.title}`, url: t.url, icon: TOOL_ICONS[t.key] }))}
          className="mt-auto"
        />
      </SidebarContent>
    </Sidebar>
  )
}
