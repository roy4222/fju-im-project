import { uploadFile } from '@/composition/files'
import type { ErrorCode } from '@/shared/errors'
import { isSameOriginRequest } from '@/shared/same-origin'

/**
 * `POST /api/files/upload?ticket=…`（契約 02 §6）。
 *
 * body 是檔案本身的位元組（`application/octet-stream`），不是 multipart：
 * 串流寫進暫存、邊算 sha256、邊檢查內容，整個檔案不會一次進記憶體。
 * 這條路徑刻意不經過 `proxy.ts`（見那裡的 matcher 說明），不然 Next 會先把 body 整個緩衝起來、
 * 超過 10MB 還會**靜靜截斷**。
 */
export const dynamic = 'force-dynamic'

const STATUS: Partial<Record<ErrorCode | 'RATE_LIMITED', number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  ACCOUNT_PENDING: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  FILE_TOO_LARGE: 413,
  FILE_TYPE_REJECTED: 415,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
}

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers, [process.env.BETTER_AUTH_URL ?? ''])) {
    return Response.json({ ok: false, code: 'FORBIDDEN', message: '請從本站頁面上傳。' }, { status: 403, headers: NO_STORE })
  }

  const ticket = new URL(request.url).searchParams.get('ticket') ?? ''
  const lengthHeader = request.headers.get('content-length')
  const declaredLength = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null
  if (!request.body) {
    return Response.json({ ok: false, code: 'VALIDATION_FAILED', message: '沒有收到檔案。' }, { status: 400, headers: NO_STORE })
  }

  const result = await uploadFile(request.headers, ticket, request.body, declaredLength)
  if (!result.ok) {
    return Response.json(
      { ok: false, code: result.code, message: result.message },
      { status: STATUS[result.code] ?? 500, headers: NO_STORE },
    )
  }
  const { fileId, originalName, sizeBytes, checksum } = result.receipt
  return Response.json({ ok: true, fileId, originalName, sizeBytes, checksum }, { status: 201, headers: NO_STORE })
}
