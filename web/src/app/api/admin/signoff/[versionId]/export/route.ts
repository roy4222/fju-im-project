import type { SignoffExportFormat } from '@/application/signoff'
import { contentDisposition } from '@/composition/files'
import { exportSignoffVersion } from '@/composition/signoff-export'
import { isSameOriginRequest } from '@/shared/same-origin'

/**
 * `POST /api/admin/signoff/<versionId>/export`：匯出某個簽核版本（票 26／S11-09；產品 07 §4「同意紀錄內容與匯出」）。
 *
 * 表單欄位 `format`：`printable`（可列印頁，新分頁直接開）或 `csv`（下載明細）。每次都重新認人、重新授權：
 * 未登入 401、不是管理員 403、版本不存在 400。每按一次就存一份檔並留一筆 `signoff_exports`。
 *
 * 用 POST 而不是 GET：匯出會寫紀錄，不能讓別站一個連結就替管理員按下去（和帳號、組別匯出同一套同源檢查）。
 * 可列印頁是 `inline` 的 HTML，另加 CSP 讓它不能跑任何腳本、不能載外部資源（全文是清洗過的受限 HTML，其他欄位都逸出）。
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }

export async function POST(request: Request, { params }: { params: Promise<{ versionId: string }> }): Promise<Response> {
  if (!isSameOriginRequest(request.headers, [process.env.BETTER_AUTH_URL ?? ''])) {
    return Response.json({ ok: false, code: 'FORBIDDEN', message: '請從本站頁面匯出。' }, { status: 403, headers: NO_STORE })
  }
  const { versionId } = await params
  let format = ''
  try {
    format = String((await request.formData()).get('format') ?? '')
  } catch {
    format = ''
  }

  // 格式由用例驗（不是兩種之一 → 400），這裡照送來的樣子交過去。
  const result = await exportSignoffVersion(request.headers, versionId, format as SignoffExportFormat)
  if (!result.ok) {
    const status = result.code === 'UNAUTHENTICATED' ? 401 : result.code === 'VALIDATION_FAILED' ? 400 : 403
    return Response.json({ ok: false, code: result.code, message: result.message }, { status, headers: NO_STORE })
  }

  const printable = result.receipt.mime.startsWith('text/html')
  const disposition = contentDisposition(result.receipt.fileName)
  return new Response(result.receipt.body, {
    status: 200,
    headers: {
      ...NO_STORE,
      'content-type': result.receipt.mime,
      'content-disposition': printable ? disposition.replace(/^attachment/, 'inline') : disposition,
      'content-security-policy': printable ? "default-src 'none'; style-src 'unsafe-inline'; sandbox allow-modals" : "default-src 'none'; sandbox",
      'x-export-id': result.receipt.exportId,
    },
  })
}
