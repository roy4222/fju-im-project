import type { Metadata } from "next"

import "@/components/globals.css"
import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PAGES, toolEntries } from "@/lib/data/hosts"

// 每次請求都重讀 /data 與 /acceptance（collector 每 10 分鐘更新），不做靜態預先產生。
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "開發者後台",
  // 只給 Roy 自己用、在 Access 後面；不讓任何搜尋引擎收錄。
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant" className="antialiased">
      <body>
        <TooltipProvider>
          <SidebarProvider
            style={
              {
                "--sidebar-width": "calc(var(--spacing) * 64)",
                "--header-height": "calc(var(--spacing) * 12)",
              } as React.CSSProperties
            }
          >
            <AppSidebar variant="inset" pages={PAGES} tools={toolEntries()} />
            <SidebarInset>{children}</SidebarInset>
          </SidebarProvider>
        </TooltipProvider>
      </body>
    </html>
  )
}
