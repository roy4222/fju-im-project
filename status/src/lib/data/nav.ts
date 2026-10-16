/**
 * 側欄導覽（DV 設計方案 §3.1）：八個頁面＋三個外部工具。
 *
 * 側欄是 client 元件，這個檔會進 client bundle：只放純資料與圖示，不能 import 讀檔的東西。
 * 「要不要顯示」需要的伺服器資訊（例如 usage.json 在不在）由 layout 算好、以 NavContext 傳進來。
 * 之後每張頁面票只改自己的路由目錄，不改這個檔。
 */
import {
  ActivityIcon,
  BarChart3Icon,
  DatabaseIcon,
  GaugeIcon,
  HardDriveIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MapIcon,
  RocketIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react'

import type { ToolEntry } from './hosts'

export type NavContext = { showUsage: boolean }

export type NavItem = { href: string; title: string; icon: LucideIcon; hidden?: (ctx: NavContext) => boolean }

export const NAV_ITEMS: NavItem[] = [
  { href: '/', title: '總覽', icon: LayoutDashboardIcon },
  { href: '/health', title: '服務健康', icon: ActivityIcon },
  { href: '/deploy', title: '部署與 CI', icon: RocketIcon },
  { href: '/errors', title: '錯誤紀錄', icon: TriangleAlertIcon },
  { href: '/backup', title: '備份與儲存', icon: HardDriveIcon },
  // 正式站開通使用報表前 usage.json 不存在：側欄不出現、路由回 404（Q96）。
  { href: '/usage', title: '使用報表', icon: BarChart3Icon, hidden: (ctx) => !ctx.showUsage },
  { href: '/progress', title: '開發進度', icon: ListChecksIcon },
  { href: '/map', title: '驗收地圖', icon: MapIcon },
]

/** 外部工具的順序與圖示；網址與說明在 `hosts.ts` 的 `toolEntries()`。 */
export const TOOL_ITEMS: { key: ToolEntry['key']; icon: LucideIcon }[] = [
  { key: 'logs', icon: ScrollTextIcon },
  { key: 'db', icon: DatabaseIcon },
  { key: 'vm', icon: GaugeIcon },
]

export const visibleNavItems = (ctx: NavContext): NavItem[] => NAV_ITEMS.filter((item) => !item.hidden?.(ctx))

/** 依 TOOL_ITEMS 的順序排好工具；標籤是工具名，副標是原本的用途說明。 */
export function toolNavItems(tools: ToolEntry[]) {
  return TOOL_ITEMS.flatMap(({ key, icon }) => {
    const tool = tools.find((t) => t.key === key)
    return tool ? [{ title: tool.tool, subtitle: tool.title, url: tool.url, icon }] : []
  })
}
