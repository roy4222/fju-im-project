import type { MailContent } from '@/application/mail/ports'

/**
 * 三種信的文案（設計方案 §3.9，R8 已定）。純函式，不讀環境變數：網址由呼叫端帶進來。
 *
 * 主旨會原文存進 `mail_outbox.subject`，所以驗證碼與重設連結只放內文。
 * 不放姓名、學號；退回理由本來就是給申請人看的。
 */

const BRAND = '【專題管理平台】'

/** 驗證碼的有效分鐘數（跟 Better Auth `emailOTP` 的 `expiresIn` 一致）。 */
export const EMAIL_OTP_MINUTES = 10
/** 重設連結的有效分鐘數（跟 `resetPasswordTokenExpiresIn` 一致）。 */
export const PASSWORD_RESET_MINUTES = 30

/** 網站根網址去掉結尾的斜線，接路徑時不會變成 `//login`。 */
const origin = (siteUrl: string) => siteUrl.replace(/\/+$/, '')

export function emailOtpMail(otp: string): MailContent {
  return {
    template: 'email_otp',
    subject: `${BRAND}Email 驗證碼`,
    text: `你的驗證碼是 ${otp}，${EMAIL_OTP_MINUTES} 分鐘內有效。如果這不是你本人的操作，請忽略這封信。`,
  }
}

export function passwordResetMail(url: string): MailContent {
  return {
    template: 'password_reset',
    subject: `${BRAND}重設密碼`,
    text: `請在 ${PASSWORD_RESET_MINUTES} 分鐘內打開這個連結重設密碼：${url}。如果你沒有申請重設，請忽略這封信，密碼不會改變。`,
  }
}

export type RegistrationOutcome = { readonly decision: 'approved' } | { readonly decision: 'rejected'; readonly reason: string }

export function registrationResultMail(outcome: RegistrationOutcome, siteUrl: string): MailContent {
  if (outcome.decision === 'approved') {
    return {
      template: 'registration_result',
      subject: `${BRAND}帳號已開通`,
      text: `你的帳號已開通，請到 ${origin(siteUrl)}/login 登入。`,
    }
  }
  return {
    template: 'registration_result',
    subject: `${BRAND}註冊申請被退回`,
    text: `你的註冊申請被退回。理由：${outcome.reason}。請到 ${origin(siteUrl)}/register/pending 修改後重新送出。`,
  }
}
