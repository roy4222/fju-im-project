import { NextResponse, type NextRequest } from 'next/server'
import {
  buildContentSecurityPolicy,
  createNonce,
  staticSecurityHeaders,
} from '@/shared/security-headers'

/**
 * 全站安全標頭（契約 03 §6；T2 方案 A）。
 *
 * Next 16 把 middleware 改名成 proxy，行為不變。這裡做兩件事：
 * 1. 每個請求產生一次性 nonce，放進**請求**標頭讓 Next 蓋到自己產生的 script／style 上，
 *    同時放進**回應**的 CSP。
 * 2. 補上 CSP 以外的靜態安全標頭。
 *
 * 限速（契約 03 §6 的登入 10 次／10 分鐘這類規則）之後也掛在這一層；
 * 實際規則由 S01-05／S01-09 填，這裡先把位置留好。
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce()
  const development = process.env.NODE_ENV === 'development'
  const csp = buildContentSecurityPolicy({ nonce, development })

  // TODO(S01-05, S01-09)：限速中介層掛在這裡，依路由套契約 03 §6 的門檻。

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('content-security-policy', csp)
  for (const [name, value] of staticSecurityHeaders({
    https: request.nextUrl.protocol === 'https:',
  })) {
    response.headers.set(name, value)
  }
  return response
}

export const config = {
  // 靜態資源與圖片最佳化不需要 CSP（它們不是 HTML 文件）。
  // `api/files/upload` 也排除：只要經過 proxy，Next 就會先把請求 body 緩衝進記憶體，
  // 超過 `proxyClientMaxBodySize`（預設 10MB）的部分**靜靜截斷**而不報錯——大檔案會被存成半截。
  // 那條路由回的是 JSON，自己帶 nosniff 與 no-store，不需要這裡的 CSP。
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/files/upload).*)'],
}
