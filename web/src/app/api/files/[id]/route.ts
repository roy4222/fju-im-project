import { contentDisposition, downloadFile } from '@/composition/files'

/**
 * `GET /api/files/[id]`：每次下載都重新授權（契約 02 §6、契約 03 §4；模組 10 FIL-03）。
 *
 * 別人拿到這個網址也沒用——網址裡的 ID 猜不到，但**不靠猜不到保密**：
 * 沒登入 401、沒權限 403，而且「沒有這個檔」跟「不是你的」回一模一樣的 403。
 */
export const dynamic = 'force-dynamic'

const PRIVATE = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params
  const result = await downloadFile(request.headers, id)
  if (!result.ok) {
    const status = result.code === 'UNAUTHENTICATED' ? 401 : result.code === 'INTERNAL' ? 500 : 403
    return Response.json({ ok: false, code: result.code, message: result.message }, { status, headers: PRIVATE })
  }

  const file = result.receipt
  return new Response(file.body, {
    status: 200,
    headers: {
      ...PRIVATE,
      // 一律下載、不在瀏覽器裡開：就算內容被判讀成 HTML 也不會在本站網域執行。
      'content-type': file.mime,
      'content-disposition': contentDisposition(file.originalName),
      'content-length': String(file.sizeBytes),
      'content-security-policy': "default-src 'none'; sandbox",
      'x-file-checksum-sha256': file.checksum,
    },
  })
}
