/**
 * 三頁與三個工具的入口（設計方案 §2、Q30）。
 *
 * 網址只放這裡：四個網址都是 `roy422.dev` 底下一層子網域（Cloudflare 免費憑證涵蓋），
 * 與 `ops/status/cloudflared.yml` 的 ingress 對應（S-4 由 STATUS_HOSTS 產生）；兩邊要一起改。
 */
export const DEFAULT_BASE_DOMAIN = 'roy422.dev'

export type PageEntry = { href: string; title: string; description: string }

export const PAGES: PageEntry[] = [
  { href: '/map', title: '測試地圖', description: '哪個角色的哪個功能真的被點過、有沒有截圖；前台每一區對應哪個管理後台' },
  { href: '/progress', title: '開發進度', description: '每張票做到哪、PR 狀態、票清單跟 GitHub 有沒有對上' },
  { href: '/go-live', title: '能不能上線', description: '五條上線條件各自綠、紅、灰，與原因' },
]

export type ToolEntry = { key: 'vm' | 'logs' | 'db'; title: string; tool: string; description: string; url: string }

export function toolEntries(baseDomain: string = DEFAULT_BASE_DOMAIN): ToolEntry[] {
  const url = (sub: string) => `https://fju-status-${sub}.${baseDomain}`
  return [
    { key: 'vm', title: 'VM 與容器資源', tool: 'Beszel', description: 'CPU、記憶體、根磁碟容量，各容器用量', url: url('vm') },
    { key: 'logs', title: '容器 log', tool: 'Dozzle', description: '即時看每個容器的 log（唯讀）', url: url('logs') },
    { key: 'db', title: '測試站資料庫', tool: 'PgHero', description: '連線數、表大小、索引（只有 pg_monitor 權限）', url: url('db') },
  ]
}
