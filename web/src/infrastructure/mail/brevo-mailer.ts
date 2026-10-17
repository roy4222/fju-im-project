import 'server-only'
import type { Pool } from 'pg'
import type { Mailer, MailMessage, MailSendResult } from '@/application/mail'
import { insertOutbox, markFailed, markSent } from '@/infrastructure/mail/outbox'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 正式寄信：Brevo transactional email API（設計方案 §3.1）。
 *
 * 先插 `mail_outbox`（`queued`、`body_text` NULL）→ `POST /v3/smtp/email`（逾時 10 秒）→ 成功 `sent` 並記
 * Brevo 的 messageId；失敗 `failed`，`error` 只記 `brevo_<HTTP 狀態>_<code>` 或 `timeout`。
 * 少了 `BREVO_API_KEY` 或 `MAIL_FROM` 直接記 `failed`／`not_configured`，**不降級為擷取**。
 *
 * 金鑰、收件內文、Brevo 回應全文一律不進 `error` 與 log（#418 Review 的遮金鑰原則）。
 */

export const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email'
const TIMEOUT_MS = 10_000

export type BrevoConfig = {
  readonly apiKey: string | undefined
  /** `專題管理平台 <noreply@roy422.dev>` 或單純的 Email。 */
  readonly from: string | undefined
  readonly replyTo?: string | undefined
}

type Sender = { name?: string; email: string }

/** `名稱 <email>` 拆成 Brevo 的 sender；格式不對回 null（當作沒設定）。 */
export function parseSender(from: string): Sender | null {
  const trimmed = from.trim()
  const named = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(trimmed)
  if (named) {
    const name = named[1]!.trim().replace(/^"(.*)"$/, '$1')
    return name ? { name, email: named[2]! } : { email: named[2]! }
  }
  return /^[^<>\s]+@[^<>\s]+$/.test(trimmed) ? { email: trimmed } : null
}

/** Brevo 錯誤碼只留英數與底線，避免把回應裡的其他東西帶進 `error`。 */
function brevoErrorCode(body: unknown): string {
  const code = (body as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return 'unknown'
  const safe = code.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)
  return safe || 'unknown'
}

export class BrevoMailer implements Mailer {
  readonly #db: () => Pool
  readonly #config: BrevoConfig
  readonly #fetch: typeof fetch
  readonly #clock: Clock
  readonly #timeoutMs: number

  constructor(deps: { db: () => Pool; config: BrevoConfig; fetch?: typeof fetch; clock?: Clock; timeoutMs?: number }) {
    this.#db = deps.db
    this.#config = deps.config
    this.#fetch = deps.fetch ?? fetch
    this.#clock = deps.clock ?? new RealClock()
    this.#timeoutMs = deps.timeoutMs ?? TIMEOUT_MS
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const db = this.#db()
    const apiKey = this.#config.apiKey?.trim()
    const sender = this.#config.from ? parseSender(this.#config.from) : null
    if (!apiKey || !sender) {
      const outboxId = await insertOutbox(db, message, {
        status: 'failed',
        bodyText: null,
        error: 'not_configured',
        now: this.#clock.now(),
      })
      return { ok: false, code: 'MAIL_NOT_CONFIGURED', outboxId }
    }

    const outboxId = await insertOutbox(db, message, { status: 'queued', bodyText: null, now: this.#clock.now() })
    const replyTo = this.#config.replyTo?.trim()
    const payload = {
      sender,
      to: [{ email: message.to }],
      subject: message.subject,
      textContent: message.text,
      ...(message.html ? { htmlContent: message.html } : {}),
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
    }

    let error: string
    try {
      const response = await this.#fetch(BREVO_ENDPOINT, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
      const body: unknown = await response.json().catch(() => null)
      if (response.ok) {
        const messageId = (body as { messageId?: unknown } | null)?.messageId
        await markSent(db, outboxId, typeof messageId === 'string' ? messageId : null, this.#clock.now())
        return { ok: true, outboxId, status: 'sent' }
      }
      error = `brevo_${response.status}_${brevoErrorCode(body)}`
    } catch (cause) {
      const name = (cause as { name?: unknown } | null)?.name
      error = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'brevo_0_network'
    }
    await markFailed(db, outboxId, error)
    console.error('[mail] Brevo 寄信失敗', { outboxId, template: message.template, error })
    return { ok: false, code: 'MAIL_FAILED', outboxId }
  }
}
