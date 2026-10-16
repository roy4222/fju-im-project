import { stat } from "node:fs/promises"
import path from "node:path"
import type { Metadata } from "next"

import "@/components/globals.css"
import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { toolEntries } from "@/lib/data/hosts"
import { dataDir } from "@/lib/data/read"

// 每次請求都重讀 /data 與 /acceptance（collector 每 10 分鐘更新），不做靜態預先產生。
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: { default: "開發者後台", template: "%s｜開發者後台" },
  // 只給 Roy 自己用、在 Access 後面；不讓任何搜尋引擎收錄。
  robots: { index: false, follow: false },
}

/** 使用報表要等正式站開通才有 usage.json；沒有就不放進側欄（Q96）。只 stat 不讀內容。 */
async function hasUsageReport(): Promise<boolean> {
  try {
    return (await stat(path.join(dataDir(), "usage.json"))).isFile()
  } catch {
    return false
  }
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const showUsage = await hasUsageReport()
  return (
    // 淺色／深色跟著系統（globals.css 的 prefers-color-scheme）；color-scheme 讓表單控件與捲軸也跟著變。
    <html lang="zh-Hant" className="antialiased" style={{ colorScheme: "light dark" }}>
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
            <AppSidebar variant="inset" nav={{ showUsage }} tools={toolEntries()} />
            <SidebarInset>{children}</SidebarInset>
          </SidebarProvider>
        </TooltipProvider>
      </body>
    </html>
  )
}
