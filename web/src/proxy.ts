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
/**
 * 前台編輯模式（C2-16；規格② 設計方案 §6.2）。
 *
 * `fju_office` cookie 由登入時的 Better Auth `hooks.after` 設給系辦（`auth-instance.ts`），登出清掉。
 * 它**只是提示、不是授權**：帶著它的 GET／HEAD 打五條前台路徑時，改寫到 `/office-edit/*`（網址列不變），
 * 那組路由自己再判一次是不是系辦，不是就只回原頁。沒有這個 cookie 的人（訪客、學生、老師）完全不經過這段，
 * 拿到的模組圖跟以前一樣，編輯層一個位元組都不多。
 */
export const OFFICE_COOKIE = 'fju_office'

/**
 * 改寫時加在**請求**上的標頭：`/office-edit/*` 看不到它＝有人直接打那組網址，導回公開路徑（同一頁不留兩個網址）。
 * 用戶端自己送的同名標頭一律先刪掉，只有這裡加的才算。
 */
export const OFFICE_REWRITE_HEADER = 'x-fju-office-rewrite'

const OFFICE_REWRITES: Readonly<Record<string, string>> = {
  '/': '/office-edit',
  '/files': '/office-edit/files',
  '/rules': '/office-edit/rules',
  '/industry': '/office-edit/industry',
  '/privacy': '/office-edit/privacy',
}

/** 這個請求要不要改寫到編輯路由；要的話回目標路徑，不要回 `null`（純函式，`front-edit-rewrite.test.ts`）。 */
export function officeRewritePath(method: string, pathname: string, officeCookie: string | undefined): string | null {
  if (officeCookie !== '1') return null
  if (method !== 'GET' && method !== 'HEAD') return null
  return Object.hasOwn(OFFICE_REWRITES, pathname) ? OFFICE_REWRITES[pathname]! : null
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce()
  const development = process.env.NODE_ENV === 'development'
  const csp = buildContentSecurityPolicy({ nonce, development })

  // TODO(S01-05, S01-09)：限速中介層掛在這裡，依路由套契約 03 §6 的門檻。

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', csp)
  requestHeaders.delete(OFFICE_REWRITE_HEADER)

  const rewriteTo = officeRewritePath(request.method, request.nextUrl.pathname, request.cookies.get(OFFICE_COOKIE)?.value)
  let response: NextResponse
  if (rewriteTo) {
    requestHeaders.set(OFFICE_REWRITE_HEADER, '1')
    // 目標用 `request.url` 的來源組（不用 `nextUrl.clone()`）：`next start --hostname 127.0.0.1` 時 nextUrl 的 host 會是
    // localhost，跟請求的來源不同，Next 就把它當外部代理去 fetch，改寫標頭跟著丟掉（實測整頁 307 無限迴圈）。
    const target = new URL(`${rewriteTo}${request.nextUrl.search}`, request.url)
    response = NextResponse.rewrite(target, { request: { headers: requestHeaders } })
    // 系辦看到的頁面不能被 Cloudflare 或瀏覽器共用快取（§9；AC-C2-42）。
    response.headers.set('cache-control', 'private, no-store')
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } })
  }
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
  // `api/files/<id>/preview`（A-06）也排除：它要讓本站頁面嵌入（`frame-ancestors 'self'`＋`SAMEORIGIN`），
  // 經過這裡會被蓋成全站的 `frame-ancestors 'none'`＋`DENY`。標頭由路由自己給齊；只排除剛好這個路徑（`$`），
  // `/api/files/<id>/preview/…` 之類的其他路徑照樣拿到全站標頭。
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/files/upload|api/files/[^/]+/preview$).*)'],
}
