import {
  contentDisposition,
  downloadFile,
  downloadFileName,
  fileCacheHeaders,
  fileFailureResponse,
  notModifiedResponse,
} from '@/composition/files'

/**
 * `GET /api/files/[id]`：每次下載都重新授權（契約 02 §6、契約 03 §4；模組 10 FIL-03）。
 *
 * 別人拿到這個網址也沒用——網址裡的 ID 猜不到，但**不靠猜不到保密**：
 * 沒登入 401、沒權限 403，而且「沒有這個檔」跟「不是你的」回一模一樣的 403。
 * 瀏覽器直接開網址時，同樣的結果改成導去登入頁或 `/403`。
 * 唯一的例外是換掉或清掉的頭像（`FILE_GONE`，SH-9）：一律 404，瀏覽器直接開也是，不導 `/403`。
 * 拒絕回應、快取標頭（公開圖片 V4、頭像 SH-9）與 304 判斷跟預覽路由（`./preview`）共用，見 `composition/files`。
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params
  const result = await downloadFile(request.headers, id)
  if (!result.ok) return fileFailureResponse(request, result, `/api/files/${id}`)

  const file = result.receipt
  // 先授權、再看 If-None-Match：下架或換圖後帶舊 ETag 重打，拿到的是上面的 401／403／303／404，不是 304。
  const cache = fileCacheHeaders(file)
  const notModified = await notModifiedResponse(request, file, cache)
  if (notModified) return notModified
  // 沒有另外寫 HEAD：Next 拿 GET 來回 HEAD、只送標頭，不會替我們關掉串流；同 304，先取消再回。
  const head = request.method === 'HEAD'
  if (head) await file.body.cancel()
  return new Response(head ? null : file.body, {
    status: 200,
    headers: {
      ...cache.headers,
      // 一律下載、不在瀏覽器裡開：就算內容被判讀成 HTML 也不會在本站網域執行。
      'content-type': file.mime,
      'content-disposition': contentDisposition(downloadFileName(file)),
      'content-length': String(file.sizeBytes),
      'content-security-policy': "default-src 'none'; sandbox",
      'x-file-checksum-sha256': file.checksum,
    },
  })
}
