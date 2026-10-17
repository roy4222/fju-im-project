import 'server-only'
import type { Pool } from 'pg'
import type { Mailer, MailMessage, MailSendResult } from '@/application/mail'
import { insertOutbox } from '@/infrastructure/mail/outbox'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 擷取模式（設計方案 §3.1）：不打外部，把整封信存進 `mail_outbox`（`status = 'captured'`、`body_text` 全文），
 * e2e 與整合測試從這裡讀驗證碼與連結。只限隔離測試環境——由 `composition/mail.ts` 決定要不要用。
 */
export class CaptureMailer implements Mailer {
  readonly #db: () => Pool
  readonly #clock: Clock

  constructor(deps: { db: () => Pool; clock?: Clock }) {
    this.#db = deps.db
    this.#clock = deps.clock ?? new RealClock()
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const outboxId = await insertOutbox(this.#db(), message, {
      status: 'captured',
      bodyText: message.text,
      now: this.#clock.now(),
    })
    return { ok: true, outboxId, status: 'captured' }
  }
}
