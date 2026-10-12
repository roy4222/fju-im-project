/**
 * Next 16 的 proxy（舊名 middleware，Node.js runtime）：每個請求先過 Access JWT 檢查（§3.2）。
 *
 * 刻意**不設 matcher**：官方文件說沒有 matcher 時 proxy 跑在每一個請求上，含 `/_next/static`、
 * `/_next/image` 與 public 檔，所以 `/shots/*`、`/_next/*` 都擋得到。唯一放行的 `/healthz`
 * 在 decideAccess 裡比對完整路徑。
 */
import { NextResponse, type NextRequest } from 'next/server'

import { ACCESS_JWT_HEADER, decideAccess } from '@/lib/access'

export async function proxy(request: NextRequest) {
  const decision = await decideAccess({
    pathname: request.nextUrl.pathname,
    token: request.headers.get(ACCESS_JWT_HEADER),
    env: process.env,
  })
  if (decision.allow) return NextResponse.next()
  // 內文固定、不帶任何資料或原因（原因只在伺服器端看得到）。
  return new NextResponse('Forbidden', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}
