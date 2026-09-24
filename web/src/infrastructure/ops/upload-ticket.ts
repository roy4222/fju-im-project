import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FileTypeId } from '@/application/ops'

/**
 * 上傳 ticket（契約 02 §6：先取 `uploadTicket`，再把位元組 POST 到 `/api/files/upload?ticket=`）。
 *
 * ticket 是一段有簽章的短字串，帶著「誰、哪一個檔案列、什麼類型、最多幾個位元組、幾點過期」。
 * 規則由發 ticket 的用例決定（它才知道是哪個項目、上限多少），上傳端點只驗簽章、不必懂業務。
 *
 * 簽章用 HMAC-SHA256，金鑰從 `BETTER_AUTH_SECRET` 以固定標籤導出——同一把秘密不同用途，
 * 拿到 session 簽章也偽造不了 ticket，反之亦然。
 *
 * ticket **不是**授權的全部：上傳端點另外要求「現在登入的人就是 ticket 上的人」，
 * 而且檔案列還是 `uploading`（用過一次就變 `stored`，同一張 ticket 不能再傳第二次）。
 */

export type UploadTicketClaims = {
  readonly fileId: string
  readonly userId: string
  readonly type: FileTypeId
  readonly maxBytes: number
  /** 過期時間（epoch 毫秒）。 */
  readonly expiresAt: number
}

const LABEL = 'fju:file-upload-ticket:v1'

function derivedKey(secret: string): Buffer {
  if (!secret || secret.length < 16) throw new Error('上傳 ticket 需要至少 16 字元的秘密（BETTER_AUTH_SECRET）')
  return createHmac('sha256', secret).update(LABEL).digest()
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', derivedKey(secret)).update(payload).digest('base64url')
}

export function issueTicket(claims: UploadTicketClaims, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ f: claims.fileId, u: claims.userId, t: claims.type, m: claims.maxBytes, e: claims.expiresAt }),
    'utf8',
  ).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

/** 驗簽章與時效。任何不對（格式、簽章、過期）都回 null，不分辨原因。 */
export function verifyTicket(ticket: string, secret: string, now: Date): UploadTicketClaims | null {
  if (typeof ticket !== 'string' || ticket.length > 1024) return null
  const [payload, signature, extra] = ticket.split('.')
  if (!payload || !signature || extra !== undefined) return null

  const expected = Buffer.from(sign(payload, secret), 'base64url')
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const r = raw as { f?: unknown; u?: unknown; t?: unknown; m?: unknown; e?: unknown }
  if (
    typeof r.f !== 'string' ||
    typeof r.u !== 'string' ||
    typeof r.t !== 'string' ||
    typeof r.m !== 'number' ||
    typeof r.e !== 'number'
  ) {
    return null
  }
  if (r.e <= now.getTime()) return null
  return { fileId: r.f, userId: r.u, type: r.t as FileTypeId, maxBytes: r.m, expiresAt: r.e }
}
