"use client"

import * as React from "react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function NavSecondary({
  label,
  items,
  ...props
}: {
  label?: string
  items: {
    title: string
    /** 工具名底下的一行小字（這個工具拿來看什麼）。 */
    subtitle?: string
    url: string
    icon: React.ReactNode
  }[]
} & React.ComponentPropsWithoutRef<typeof SidebarGroup>) {
  return (
    <SidebarGroup {...props}>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                tooltip={item.subtitle ? `${item.title}・${item.subtitle}` : item.title}
                className={item.subtitle ? "h-auto" : undefined}
                render={<a href={item.url} target="_blank" rel="noreferrer" />}
              >
                {item.icon}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{item.title}</span>
                  {item.subtitle ? <span className="truncate text-xs text-muted-foreground">{item.subtitle}</span> : null}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
