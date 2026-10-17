import { contentDisposition, downloadFile, isCacheableDownload, PUBLIC_IMAGE_MAX_AGE_SECONDS } from '@/composition/files'

/**
 * `GET /api/files/[id]`：每次下載都重新授權（契約 02 §6、契約 03 §4；模組 10 FIL-03）。
 *
 * 別人拿到這個網址也沒用——網址裡的 ID 猜不到，但**不靠猜不到保密**：
 * 沒登入 401、沒權限 403，而且「沒有這個檔」跟「不是你的」回一模一樣的 403。
 * 瀏覽器直接開網址時，同樣的結果改成導去登入頁或 `/403`（見 `isDocumentNavigation`）。
 * 唯一的例外是換掉或清掉的頭像（`FILE_GONE`，SH-9）：一律 404，瀏覽器直接開也是，不導 `/403`。
 */
export const dynamic = 'force-dynamic'

const PRIVATE = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }

/**
 * 瀏覽器直接開（網址列、點連結）才導頁；程式抓取與 `<img>` 維持 JSON，e2e 與封面預覽不受影響。
 * 只認 `sec-fetch-dest: document`，不看 `accept`：程式請求也可能帶 `Accept: text/html`，
 * 它們的回應要維持原本的 JSON。沒有這個標頭的舊瀏覽器同樣拿到 JSON。
 */
function isDocumentNavigation(headers: Headers): boolean {
  return headers.get('sec-fetch-dest') === 'document'
}

/**
 * 公開圖片（訪客也拿得到的 PNG／JPEG，判斷在 `isCacheableDownload`）讓瀏覽器短時間快取（V4）。
 * 可見性會變（下架、撤回、換圖、刪除），授權結果永不跨請求快取（契約 02 §8），所以只給瀏覽器
 * `PUBLIC_IMAGE_MAX_AGE_SECONDS`（5 分鐘），而且 `must-revalidate`：過期後一定回來重新授權。
 * 不加 `vary: cookie`：公開回應對任何人都一樣；私有回應是 `no-store`，不會被存。
 */
const PUBLIC_IMAGE = {
  'cache-control': `public, max-age=${PUBLIC_IMAGE_MAX_AGE_SECONDS}, must-revalidate`,
  'x-content-type-options': 'nosniff',
}

/**
 * 上傳的頭像（SH-9，B 設計方案 §2.2.3 ▶R-6）：瀏覽器可以存，但**每次用之前都要回來問**（`no-cache`），
 * 所以換圖或重設後舊網址立刻 404（Q109）；沒換就是 304，不必重傳。只給登入者看，所以是 `private`。
 */
const AVATAR = { 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' }

/**
 * `If-None-Match` 裡有沒有這個 ETag（逗號分隔、弱比較：去掉 `W/` 再比）。
 * `*` 不當命中：只有明確帶著這張圖的 ETag 才回 304，多回一次 200 不會錯。
 */
function matchesETag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false
  return ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params
  const result = await downloadFile(request.headers, id)
  if (!result.ok) {
    if (result.code === 'FILE_GONE') {
      return Response.json({ ok: false, code: result.code, message: result.message }, { status: 404, headers: PRIVATE })
    }
    // 沒登入去登入頁（登入後直接下載）；不是你的、已下架、不存在一律 /403，三者導向相同。
    // 導向也帶 no-store：快取住匿名時的導向，登入後會被彈回登入頁。INTERNAL 不導，維持 500 JSON。
    if (result.code !== 'INTERNAL' && isDocumentNavigation(request.headers)) {
      const location = result.code === 'UNAUTHENTICATED' ? `/login?next=${encodeURIComponent(`/api/files/${id}`)}` : '/403'
      return new Response(null, { status: 303, headers: { ...PRIVATE, location } })
    }
    const status = result.code === 'UNAUTHENTICATED' ? 401 : result.code === 'INTERNAL' ? 500 : 403
    return Response.json({ ok: false, code: result.code, message: result.message }, { status, headers: PRIVATE })
  }

  const file = result.receipt
  // 先授權、再看 If-None-Match：下架或換圖後帶舊 ETag 重打，拿到的是上面的 401／403／303／404，不是 304。
  const cacheable = isCacheableDownload(file)
  const avatar = file.purpose === 'avatar'
  const cacheHeaders = cacheable ? PUBLIC_IMAGE : avatar ? AVATAR : PRIVATE
  const etag = (cacheable || avatar) && file.checksum ? `"${file.checksum}"` : null
  if (etag && matchesETag(request.headers.get('if-none-match'), etag)) {
    // 授權時已經開了檔（串流），不讀就要取消，否則檔案描述子要等 GC 才關，大量 304 會把 fd 用完。
    await file.body.cancel()
    return new Response(null, { status: 304, headers: { ...cacheHeaders, etag } })
  }
  // 沒有另外寫 HEAD：Next 拿 GET 來回 HEAD、只送標頭，不會替我們關掉串流；同 304，先取消再回。
  const head = request.method === 'HEAD'
  if (head) await file.body.cancel()
  return new Response(head ? null : file.body, {
    status: 200,
    headers: {
      ...cacheHeaders,
      ...(etag ? { etag } : {}),
      // 一律下載、不在瀏覽器裡開：就算內容被判讀成 HTML 也不會在本站網域執行。
      'content-type': file.mime,
      // 頭像所有登入者都拿得到：不帶原始檔名（可能是「身分證.jpg」之類），內容也已經轉成 WebP。
      'content-disposition': contentDisposition(avatar ? 'avatar.webp' : file.originalName),
      'content-length': String(file.sizeBytes),
      'content-security-policy': "default-src 'none'; sandbox",
      'x-file-checksum-sha256': file.checksum,
    },
  })
}
