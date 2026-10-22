import { BrokenPage } from '@/app/_ui/broken-page'

export const metadata = { title: '找不到這個頁面｜資管系專題平台' }

/**
 * 統一的 404 頁：打錯網址、或頁面裡 `notFound()`（草稿、不存在的 id）都到這裡。外觀同 403 頁（「壞掉」頁，規格④ §6）。
 *
 * 根層 `not-found` 渲染在根 layout 裡；串流回應時狀態碼會變 200，所以這裡不要加 `loading.tsx`
 * 或 Suspense 邊界（e2e 有三處斷言 404 狀態碼守著）。不用實驗性的 `global-not-found`。
 * async 是因為 SiteShell 要讀這次請求是誰（頁首頭像、頁尾連結）。
 * `staticFooter`：根層 not-found 每次請求都會渲染，頁尾聯絡資料用程式內預設、不讀 `site_texts`，
 * 否則全站每條路由都多一句查詢（C2-17 Review，主腦 10/19 放行）。
 */
export default async function NotFound() {
  return <BrokenPage staticFooter action={{ href: '/', label: '回首頁' }} />
}
