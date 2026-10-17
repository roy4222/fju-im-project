/**
 * 整合測試一律用擷取模式寄信（B 階段 VB-1；設計方案 §3.1）：只寫進 `mail_outbox`，不打 Brevo。
 *
 * 會啟動 Better Auth 的整合測試都把 `BETTER_AUTH_URL` 設成 `http://127.0.0.1:3000`，過得了 `composition/mail.ts`
 * 的本機守門。沒有這個檔，之後 VB-2 開了 `sendVerificationOnSignUp`，每一次 HTTP 註冊都會因 `MAIL_NOT_CONFIGURED` 失敗。
 * 測試自己要驗 Brevo 路徑時直接建 `BrevoMailer`，不經 composition。
 */
process.env.MAIL_CAPTURE ??= '1'
