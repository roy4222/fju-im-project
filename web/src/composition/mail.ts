import 'server-only'
import type { Mailer } from '@/application/mail'
import { getPool } from '@/infrastructure/db/client'
import { BrevoMailer } from '@/infrastructure/mail/brevo-mailer'
import { CaptureMailer } from '@/infrastructure/mail/capture-mailer'

/**
 * 寄信的實例組裝（B 階段 VB-1；設計方案 §3.1）：選 Brevo 還是擷取，**只在這裡決定**。
 *
 * `MAIL_CAPTURE=1` 而且 `BETTER_AUTH_URL` 的主機是 `localhost`／`127.0.0.1` 才擷取（只存進 `mail_outbox`、不寄出）。
 * 旗標開著但主機是別的（例如測試站被誤設）→ 拒絕擷取、照常走 Brevo，並 log 一次警告；Brevo 缺金鑰就回
 * `MAIL_NOT_CONFIGURED`，不會偷偷把驗證碼存進資料庫。`MAIL_CAPTURE` 只寫在 CI 的 e2e job、本機 `.env`
 * 與整合測試的 setup 檔；Doppler stg／prd 與 `docker-compose.vm.yml` 都不設。
 */

export type MailerKind = 'brevo' | 'capture'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/** 純函式：依環境決定轉接器；`refusedCapture` 是「旗標開著卻被拒絕」，給呼叫端 log 警告。 */
export function chooseMailer(env: { MAIL_CAPTURE?: string; BETTER_AUTH_URL?: string }): {
  kind: MailerKind
  refusedCapture: boolean
} {
  if (env.MAIL_CAPTURE !== '1') return { kind: 'brevo', refusedCapture: false }
  if (isLocalUrl(env.BETTER_AUTH_URL)) return { kind: 'capture', refusedCapture: false }
  return { kind: 'brevo', refusedCapture: true }
}

/** 寄信網址的根（審核結果信的 `/login`、`/register/pending` 連結）；同 Better Auth 的 `baseURL`。 */
export function mailSiteUrl(): string {
  return process.env.BETTER_AUTH_URL ?? ''
}

let mailer: Mailer | undefined

export function getMailer(): Mailer {
  if (mailer) return mailer
  const { kind, refusedCapture } = chooseMailer({
    MAIL_CAPTURE: process.env.MAIL_CAPTURE,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  })
  if (refusedCapture) {
    console.warn('[mail] MAIL_CAPTURE=1 只限本機與 CI（BETTER_AUTH_URL 要是 localhost／127.0.0.1）；這裡改走 Brevo')
  }
  mailer =
    kind === 'capture'
      ? new CaptureMailer({ db: getPool })
      : new BrevoMailer({
          db: getPool,
          config: {
            apiKey: process.env.BREVO_API_KEY,
            from: process.env.MAIL_FROM,
            replyTo: process.env.MAIL_REPLY_TO,
          },
        })
  return mailer
}
