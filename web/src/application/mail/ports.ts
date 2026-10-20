/**
 * 寄信 port（B 階段 VB-1；設計方案 §3.1）。
 *
 * 三種信（Email 驗證碼、重設密碼、審核結果）都同步寄（使用者或系辦在等），不走 worker。
 * 每封信先寫一列 `mail_outbox` 再寄；正式寄出的列不存內文，只有擷取模式（限本機與 CI）存全文。
 * 選哪一個轉接器只在 `composition/mail.ts` 決定。
 */

export type MailTemplate = 'email_otp' | 'password_reset' | 'registration_result' | 'reminder'

export type MailMessage = {
  readonly to: string
  readonly template: MailTemplate
  /** 主旨原文會存進 `mail_outbox.subject`，所以不得含驗證碼與重設 token。 */
  readonly subject: string
  readonly text: string
  readonly html?: string
}

/** 範本產生的內容；收件人由呼叫端補。 */
export type MailContent = Omit<MailMessage, 'to'>

/**
 * 寄信結果。刻意不是契約 02 的 `Result`：這兩個錯誤碼只在伺服器內部流動（呼叫端轉成自己的錯誤或吞掉），
 * 不進畫面的錯誤碼表。失敗時那一列 `mail_outbox` 已經記成 `failed`。
 */
export type MailSendResult =
  | { readonly ok: true; readonly outboxId: string; readonly status: 'sent' | 'captured' }
  | { readonly ok: false; readonly code: MailErrorCode; readonly outboxId: string }

/** `MAIL_NOT_CONFIGURED`：少了 `BREVO_API_KEY` 或 `MAIL_FROM`（不降級為擷取）；`MAIL_FAILED`：Brevo 拒收或逾時。 */
export type MailErrorCode = 'MAIL_FAILED' | 'MAIL_NOT_CONFIGURED'

export interface Mailer {
  send(message: MailMessage): Promise<MailSendResult>
}
