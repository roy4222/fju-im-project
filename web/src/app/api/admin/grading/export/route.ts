import { contentDisposition } from '@/composition/files'
import { exportGrades } from '@/composition/grade-export'
import { isSameOriginRequest } from '@/shared/same-origin'

/**
 * `POST /api/admin/grading/export`：整屆成績匯出 CSV 或 XLSX（票 24；GRD-10）。
 *
 * body 是 JSON：`{ cohortId, format: 'csv'|'xlsx', filter: { stage, group, status } }`。每次都重新認人、重新授權：
 * 未登入 401、不是管理員 403（學生、老師都一樣）；成功回 `attachment`、`nosniff`、不快取，並寫一筆匯出稽核。
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
const MAX_BODY_CHARS = 16 * 1024
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

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

  const result = await exportGrades(request.headers, body)
  if (!result.ok) {
    const status = result.code === 'UNAUTHENTICATED' ? 401 : result.code === 'VALIDATION_FAILED' ? 400 : 403
    return Response.json({ ok: false, code: result.code, message: result.message }, { status, headers: NO_STORE })
  }

  const { receipt } = result
  const payload = typeof receipt.body === 'string' ? receipt.body : new Uint8Array(receipt.body)
  return new Response(payload, {
    status: 200,
    headers: {
      ...NO_STORE,
      'content-type': receipt.format === 'csv' ? 'text/csv; charset=utf-8' : XLSX_TYPE,
      'content-disposition': contentDisposition(receipt.fileName),
      'content-security-policy': "default-src 'none'; sandbox",
      'x-export-count': String(receipt.groupCount),
      'x-export-rows': String(receipt.rowCount),
    },
  })
}
