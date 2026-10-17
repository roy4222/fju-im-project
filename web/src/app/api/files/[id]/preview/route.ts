import {
  contentDisposition,
  downloadFile,
  downloadFileName,
  fileCacheHeaders,
  fileFailureResponse,
  isPreviewableMime,
  notModifiedResponse,
  PRIVATE_FILE_HEADERS,
} from '@/composition/files'

/**
 * `GET /api/files/[id]/preview`：在頁內（同站 `<iframe>`）顯示 PDF 與圖片（A-06，B 設計方案 §5.2；評分頁 A-07 用）。
 *
 * **權限與下載路由完全相同**：同一個 `downloadFile`，每次請求重新認人、重新授權，不快取授權結果；
 * 拒絕回應、快取標頭與 304 判斷也跟下載共用（`composition/files`），所以預覽不會比下載多放行或多透露。
 * 跟下載只差在：
 * - 只收 PDF 與點陣圖（`isPreviewableMime`，比對驗過內容的 `mime_detected`；**不含 SVG**）。其他類型 302 回下載路由，
 *   最後是 `attachment` 下載，不在本站網域打開。
 * - `content-disposition: inline`；`frame-ancestors 'self'`＋`x-frame-options: SAMEORIGIN`：只有本站頁面嵌得進來。
 *   這條路由在 `proxy.ts` 的 matcher 裡排除，標頭全部自己管；全站其他回應仍是 `frame-ancestors 'none'`＋`DENY`。
 *
 * CSP 的 `sandbox`（spike 結論，2026-10-18，Chromium 153 實測，截圖見 PR）：
 * - 回應 CSP 帶 `sandbox`：Chrome 的 PDF 檢視器照樣顯示；iframe 加 `sandbox` **屬性**：PDF 被擋成錯誤頁。
 *   Safari 的 PDF 是外掛類內容，沙箱文件裡不給外掛（無法在 Linux 實測，A-07 的 AC-A-16 人工截圖確認）。
 * - 所以 **PDF 不加 sandbox**（回應與 iframe 兩邊都不加），只靠 `default-src 'none'`、`nosniff` 與類型白名單；
 *   **圖片保留 `sandbox`**（兩種情況 Chrome 都正常顯示）。
 */
export const dynamic = 'force-dynamic'

const FRAME_SAME_ORIGIN = "default-src 'none'; frame-ancestors 'self'"

/** 預覽回應固定帶的標頭（200 與 304 都帶，瀏覽器用 304 更新快取裡的標頭時不會掉）。 */
function previewHeaders(mime: string): Record<string, string> {
  return {
    'content-security-policy': mime === 'application/pdf' ? FRAME_SAME_ORIGIN : `${FRAME_SAME_ORIGIN}; sandbox`,
    'x-frame-options': 'SAMEORIGIN',
    'x-content-type-options': 'nosniff',
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params
  const result = await downloadFile(request.headers, id)
  // 沒登入在瀏覽器直接開：登入後回到預覽。其餘拒絕與下載路由逐位元相同。
  if (!result.ok) return fileFailureResponse(request, result, `/api/files/${id}/preview`)

  const file = result.receipt
  if (!isPreviewableMime(file.mime)) {
    // 授權時已經開了檔（串流），不讀就要取消。導向帶 no-store：類型不會變，但這個人之後可能被拒，不能被快取住。
    await file.body.cancel()
    return new Response(null, { status: 302, headers: { ...PRIVATE_FILE_HEADERS, location: `/api/files/${encodeURIComponent(id)}` } })
  }

  const cache = fileCacheHeaders(file)
  const notModified = await notModifiedResponse(request, file, cache, previewHeaders(file.mime))
  if (notModified) return notModified
  const head = request.method === 'HEAD'
  if (head) await file.body.cancel()
  return new Response(head ? null : file.body, {
    status: 200,
    headers: {
      ...cache.headers,
      ...previewHeaders(file.mime),
      'content-type': file.mime,
      'content-disposition': contentDisposition(downloadFileName(file), 'inline'),
      'content-length': String(file.sizeBytes),
      'x-file-checksum-sha256': file.checksum,
    },
  })
}
