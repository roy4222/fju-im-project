import 'server-only'
import type { ResolvedActor } from '@/application/accounts'
import {
  isCacheableDownload,
  PUBLIC_IMAGE_MAX_AGE_SECONDS,
  type FileDownload,
  type FileListRow,
  type StoredFileReceipt,
} from '@/application/ops'
import { createRateLimiter } from '@/shared/rate-limit'
import type { Result } from '@/shared/result'
import { checkStatus, resolveActor } from '@/composition/accounts'
import { getBusinessClock } from '@/composition/cohorts'
import { getAuditWriter, getFileStorage, getOperationLedger } from '@/composition/ops'
import { getPool } from '@/infrastructure/db/client'
import { listStoredFiles } from '@/infrastructure/ops/file-list'
import { PgFileAdminCommand } from '@/infrastructure/ops/file-storage'

/**
 * 檔案管理頁（票 35）：全站已存好的檔案與引用位置。只有啟用中的系辦拿得到（其他人回 null → 頁面 404）；
 * 下載一樣走 `/api/files/<id>`，每次重新授權，這一頁不放寬任何下載權限。
 */
export function getFileListQuery() {
  return {
    async list(actor: ResolvedActor): Promise<FileListRow[] | null> {
      if (actor.kind !== 'authenticated' || actor.status !== 'active' || !actor.roles.includes('admin')) return null
      return listStoredFiles(getPool())
    },
  }
}

export { FILE_LIST_LIMIT } from '@/infrastructure/ops/file-list'

let fileAdminCommand: PgFileAdminCommand | undefined

/** 檔案分頁的「刪除」（C1-16）：只刪沒有任何有效引用的檔；授權（只有狀態正常的系辦）在命令裡判。 */
export function getFileAdminCommand(): PgFileAdminCommand {
  fileAdminCommand ??= new PgFileAdminCommand({
    db: getPool,
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    businessClock: getBusinessClock(),
  })
  return fileAdminCommand
}

/**
 * 檔案上傳與下載兩條 Route Handler 的門面（契約 02 §6）。
 *
 * 路由只管 HTTP（標頭、狀態碼、串流），「這個人是誰、能不能做」都在這裡與共用檔案能力裡判。
 */

/**
 * 上傳限速的次數上限（契約 03 §6：20 次／10 分鐘／使用者）。
 *
 * `UPLOAD_RATE_MAX` 可以蓋掉（SH-B10：e2e 同一個共用帳號跨 spec 會超過 20 次，設 1000）。
 * 沒設或不是正整數就用 20：`NaN` 會讓限速永遠放行、`0` 會全擋，打錯 env 不能變成關掉限速。
 */
export function uploadRateMax(env: Record<string, string | undefined> = process.env): number {
  const raw = env.UPLOAD_RATE_MAX?.trim()
  if (!raw || !/^\d+$/.test(raw)) return 20
  const max = Number(raw)
  return Number.isSafeInteger(max) && max > 0 ? max : 20
}

const uploadLimiter = createRateLimiter({ max: uploadRateMax(), windowMs: 10 * 60 * 1000 })

export type UploadOutcome =
  | Result<StoredFileReceipt>
  | { readonly ok: false; readonly code: 'RATE_LIMITED'; readonly message: string; readonly retryAfterMs: number }

/** `/api/files/upload`：認人、限速、交給共用檔案能力（驗 ticket、大小、內容）。 */
export async function uploadFile(
  headers: Headers,
  ticket: string,
  body: ReadableStream<Uint8Array>,
  declaredLength: number | null,
): Promise<UploadOutcome> {
  const actor = await resolveActor(headers)
  if (actor.kind === 'anonymous') return { ok: false, code: 'UNAUTHENTICATED', message: '請先登入。' }
  // 與下載端對稱：拿到 ticket 之後才被停用、被要求改密或還在待審的人，不能把檔傳成 stored（票 6 審查建議）。
  const blocked = checkStatus(actor, 'business')
  if (blocked) return { ok: false, code: blocked, message: blocked === 'UNAUTHENTICATED' ? '請先登入。' : '目前的帳號狀態不能上傳檔案。' }
  const verdict = uploadLimiter.hit(actor.userId)
  if (!verdict.allowed) {
    return { ok: false, code: 'RATE_LIMITED', message: '上傳太頻繁，請稍後再試。', retryAfterMs: verdict.retryAfterMs }
  }
  return getFileStorage().upload(actor.userId, ticket, body, declaredLength)
}

/** 下載用的 `Content-Disposition`（路由只能經 composition 拿到執行期的規則）。 */
export { contentDispositionFor as contentDisposition } from '@/application/ops'

/** 這個下載能不能快取、快取幾秒（S16：訪客也拿得到的檔一律可快取，不看檔型；路由不自己判斷）。 */
export { isCacheableDownload, PUBLIC_IMAGE_MAX_AGE_SECONDS } from '@/application/ops'

/**
 * `/api/files/[id]` 與 `/api/files/[id]/preview`：每次都重新認人、重新授權（預覽與下載同一個函式，權限不會比下載寬）。
 */
export async function downloadFile(headers: Headers, fileId: string): Promise<Result<FileDownload>> {
  const actor = await resolveActor(headers)
  return getFileStorage().authorizeDownload(actor, fileId)
}

/**
 * 可以在頁內預覽的類型（A-06，B 設計方案 §5.2）：PDF 與點陣圖。比對的是上傳收檔時驗過內容寫入的
 * `mime_detected`，不是使用者宣告的。**不含 SVG**：SVG 是可以帶 `<script>` 的文件，一律走下載。
 * 不在名單上的類型，預覽路由導回下載路由（`attachment`）。
 */
const PREVIEWABLE_MIMES: ReadonlySet<string> = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function isPreviewableMime(mime: string): boolean {
  return PREVIEWABLE_MIMES.has(mime)
}

// ── 下載與預覽兩條路由共用的 HTTP 規則 ─────────────────────────────────────────
// 兩條路由的拒絕回應與快取標頭必須一模一樣（AC-A-47：預覽不能比下載多透露或多放行），所以放在同一處。

/** 私有回應：不存、不猜類型。拒絕、導向與不可快取的檔案都用這組。 */
export const PRIVATE_FILE_HEADERS = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } as const

/**
 * 瀏覽器直接開（網址列、點連結）才導頁；程式抓取、`<img>`、`<iframe>` 維持 JSON。
 * 只認 `sec-fetch-dest: document`，不看 `accept`：程式請求也可能帶 `Accept: text/html`，
 * 它們的回應要維持原本的 JSON。沒有這個標頭的舊瀏覽器同樣拿到 JSON。
 */
function isDocumentNavigation(headers: Headers): boolean {
  return headers.get('sec-fetch-dest') === 'document'
}

/**
 * 授權失敗 → 回應。沒登入 401、沒權限 403，「沒有這個檔」跟「不是你的」回一模一樣的 403；
 * 瀏覽器直接開時改成導去登入頁（登入後回到 `returnTo`）或 `/403`。
 * 唯一的例外是換掉或清掉的頭像（`FILE_GONE`，SH-9）：一律 404，瀏覽器直接開也是，不導 `/403`。
 */
export function fileFailureResponse(
  request: Request,
  failure: { readonly code: string; readonly message: string },
  returnTo: string,
): Response {
  if (failure.code === 'FILE_GONE') {
    return Response.json({ ok: false, code: failure.code, message: failure.message }, { status: 404, headers: PRIVATE_FILE_HEADERS })
  }
  // 沒登入去登入頁；不是你的、已下架、不存在一律 /403，三者導向相同。
  // 導向也帶 no-store：快取住匿名時的導向，登入後會被彈回登入頁。INTERNAL 不導，維持 500 JSON。
  if (failure.code !== 'INTERNAL' && isDocumentNavigation(request.headers)) {
    const location = failure.code === 'UNAUTHENTICATED' ? `/login?next=${encodeURIComponent(returnTo)}` : '/403'
    return new Response(null, { status: 303, headers: { ...PRIVATE_FILE_HEADERS, location } })
  }
  const status = failure.code === 'UNAUTHENTICATED' ? 401 : failure.code === 'INTERNAL' ? 500 : 403
  return Response.json({ ok: false, code: failure.code, message: failure.message }, { status, headers: PRIVATE_FILE_HEADERS })
}

/**
 * 公開檔（訪客也拿得到的檔，不看檔型，判斷在 `isCacheableDownload`）讓瀏覽器與 Cloudflare 短時間快取（V4、S16）。
 * 可見性會變（下架、撤回、換檔、刪除），授權結果永不跨請求快取（契約 02 §8），所以只給
 * `PUBLIC_IMAGE_MAX_AGE_SECONDS`（5 分鐘），而且 `must-revalidate`：過期後一定回來重新授權。
 * 不加 `vary: cookie`：公開回應對任何人都一樣；私有回應是 `no-store`，不會被存。
 */
const PUBLIC_IMAGE_HEADERS = {
  'cache-control': `public, max-age=${PUBLIC_IMAGE_MAX_AGE_SECONDS}, must-revalidate`,
  'x-content-type-options': 'nosniff',
} as const

/**
 * 上傳的頭像（SH-9，B 設計方案 §2.2.3 ▶R-6）：瀏覽器可以存，但**每次用之前都要回來問**（`no-cache`），
 * 所以換圖或重設後舊網址立刻 404（Q109）；沒換就是 304，不必重傳。只給登入者看，所以是 `private`。
 */
const AVATAR_HEADERS = { 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' } as const

/**
 * `If-None-Match` 裡有沒有這個 ETag（逗號分隔、弱比較：去掉 `W/` 再比）。
 * `*` 不當命中：只有明確帶著這張圖的 ETag 才回 304，多回一次 200 不會錯。
 */
function matchesETag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false
  return ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)
}

/** 授權通過的檔案該帶的快取標頭與 ETag（公開檔、頭像有 ETag；其他一律 `private, no-store`）。 */
export function fileCacheHeaders(file: FileDownload): { readonly headers: Record<string, string>; readonly etag: string | null } {
  const cacheable = isCacheableDownload(file)
  const avatar = file.purpose === 'avatar'
  const headers = cacheable ? PUBLIC_IMAGE_HEADERS : avatar ? AVATAR_HEADERS : PRIVATE_FILE_HEADERS
  const etag = (cacheable || avatar) && file.checksum ? `"${file.checksum}"` : null
  return { headers: { ...headers, ...(etag ? { etag } : {}) }, etag }
}

/**
 * 帶著相符的 `If-None-Match` → 304（授權已經先做完：下架或換圖後帶舊 ETag 重打，拿到的是拒絕，不是 304）。
 * 授權時已經開了檔（串流），不讀就要取消，否則檔案描述子要等 GC 才關，大量 304 會把 fd 用完。
 */
export async function notModifiedResponse(
  request: Request,
  file: FileDownload,
  cache: { readonly headers: Record<string, string>; readonly etag: string | null },
  extraHeaders: Record<string, string> = {},
): Promise<Response | null> {
  if (!cache.etag || !matchesETag(request.headers.get('if-none-match'), cache.etag)) return null
  await file.body.cancel()
  return new Response(null, { status: 304, headers: { ...cache.headers, ...extraHeaders } })
}

/** 回應裡的檔名：頭像所有登入者都拿得到，不帶原始檔名（可能是「身分證.jpg」之類），內容也已經轉成 WebP。 */
export function downloadFileName(file: FileDownload): string {
  return file.purpose === 'avatar' ? 'avatar.webp' : file.originalName
}
