import 'server-only'
import type { ResolvedActor } from '@/application/accounts'
import { formatGiB, type FileDownload, type FileListRow, type StoredFileReceipt } from '@/application/ops'
import { createRateLimiter } from '@/shared/rate-limit'
import type { Result } from '@/shared/result'
import { checkStatus, resolveActor } from '@/composition/accounts'
import { getFileStorage, getOpsStatusQuery } from '@/composition/ops'
import { getPool } from '@/infrastructure/db/client'
import { listStoredFiles } from '@/infrastructure/ops/file-list'

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
    /** 頁首「用量 X／Y」：最新一筆磁碟量測（票 28）；還沒量過回 null。 */
    async usage(actor: ResolvedActor): Promise<{ used: string; total: string; measuredAt: Date } | null> {
      const m = await getOpsStatusQuery().storage(actor)
      if (!m) return null
      return { used: formatGiB(m.usedBytes), total: formatGiB(m.usedBytes + m.freeBytes), measuredAt: m.measuredRealAt }
    },
  }
}

export { FILE_LIST_LIMIT } from '@/infrastructure/ops/file-list'

/**
 * 檔案上傳與下載兩條 Route Handler 的門面（契約 02 §6）。
 *
 * 路由只管 HTTP（標頭、狀態碼、串流），「這個人是誰、能不能做」都在這裡與共用檔案能力裡判。
 */

/** 上傳限速（契約 03 §6：20 次／10 分鐘／使用者）。 */
const uploadLimiter = createRateLimiter({ max: 20, windowMs: 10 * 60 * 1000 })

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

/** `/api/files/[id]`：每次下載都重新認人、重新授權。 */
export async function downloadFile(headers: Headers, fileId: string): Promise<Result<FileDownload>> {
  const actor = await resolveActor(headers)
  return getFileStorage().authorizeDownload(actor, fileId)
}
