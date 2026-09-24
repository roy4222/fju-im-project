import { contentDisposition } from '@/composition/files'
import { exportAccounts } from '@/composition/accounts'
import { isSameOriginRequest } from '@/shared/same-origin'

/**
 * `POST /api/admin/accounts/export`：帳號名單匯出 CSV（票 9；2026-09-15 定案、ACC-15）。
 *
 * body 是 JSON：`{ kind: 'ids', userIds }`（勾選的人）或 `{ kind: 'filter', filter }`（目前篩選的全部結果，
 * 不限分頁）。每次都重新認人、重新授權：未登入 401、不是管理員 403；成功回 `attachment`、`nosniff`、
 * 不快取，並寫一筆匯出稽核。
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
const MAX_BODY_CHARS = 512 * 1024

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers, [process.env.BETTER_AUTH_URL ?? ''])) {
    return Response.json({ ok: false, code: 'FORBIDDEN', message: '請從本站頁面匯出。' }, { status: 403, headers: NO_STORE })
  }

  let body: unknown = null
  try {
    const text = await request.text()
    body = text.length > 0 && text.length <= MAX_BODY_CHARS ? JSON.parse(text) : null
  } catch {
    body = null
  }

  const result = await exportAccounts(request.headers, body)
  if (!result.ok) {
    const status = result.code === 'UNAUTHENTICATED' ? 401 : result.code === 'VALIDATION_FAILED' ? 400 : 403
    return Response.json({ ok: false, code: result.code, message: result.message }, { status, headers: NO_STORE })
  }

  return new Response(result.receipt.csv, {
    status: 200,
    headers: {
      ...NO_STORE,
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': contentDisposition(result.receipt.fileName),
      'content-security-policy': "default-src 'none'; sandbox",
      'x-export-count': String(result.receipt.count),
    },
  })
}
