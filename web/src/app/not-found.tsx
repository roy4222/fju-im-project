import Link from 'next/link'
import { IconMapPinOff } from '@tabler/icons-react'
import { CodeNotice } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'

export const metadata = { title: '找不到這個頁面｜資管系專題平台' }

/**
 * 統一的 404 頁：打錯網址、或頁面裡 `notFound()`（草稿、不存在的 id）都到這裡。外觀同 403 頁。
 *
 * 根層 `not-found` 渲染在根 layout 裡；串流回應時狀態碼會變 200，所以這裡不要加 `loading.tsx`
 * 或 Suspense 邊界（e2e 有三處斷言 404 狀態碼守著）。不用實驗性的 `global-not-found`。
 * async 是因為 SiteShell 要讀這次請求是誰（頁首頭像、頁尾連結）。
 */
export default async function NotFound() {
  return (
    <SiteShell>
      <CodeNotice
        code="404"
        icon={<IconMapPinOff className="size-7" aria-hidden />}
        title="找不到這個頁面"
        data-testid="not-found"
        actions={
          <Link href="/" className="btn-fju h-11.5 px-7 text-[15px]">
            回首頁
          </Link>
        }
      >
        網址可能打錯了，或這個內容已經下架。
      </CodeNotice>
    </SiteShell>
  )
}
