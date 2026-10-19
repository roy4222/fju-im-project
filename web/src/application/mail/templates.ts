import type { MailContent } from '@/application/mail/ports'
import { formatTaipeiMinute } from '@/shared/time'

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

/**
 * 重設密碼信。`variant: 'setup'` 是系辦新增成員後寄的「請設定密碼」信（C2-09）：
 * 同一個樣板（`password_reset`）、同一種連結，只有主旨與開頭不同——收信的人還沒有密碼，不是「重設」。
 */
export function passwordResetMail(url: string, variant?: 'setup'): MailContent {
  if (variant === 'setup') {
    return {
      template: 'password_reset',
      subject: `${BRAND}請設定密碼`,
      text: `系辦已經為你建立帳號。請在 ${PASSWORD_RESET_MINUTES} 分鐘內打開這個連結設定密碼：${url}。如果你不認識這個網站，請忽略這封信。`,
    }
  }
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

/**
 * 催繳信（C 階段規格① §1.5、§8，A9）：站內通知同文、每位收件人一封，交易 commit 後才寄（Email 盡力，失敗只留 outbox）。
 *
 * - `item`：`title` 是作業標題，`dueAt` 是截止（站內同意書可以沒有截止）。內文＝站內通知的「{標題} 尚未繳交，截止 {時間}」＋連結。
 * - `grading`：`title` 就是那位老師的「您還有 N 份評分未送出」，沒有截止。
 *
 * 主旨不放作業標題（標題由系辦自由輸入，主旨會原文存進 `mail_outbox.subject`）；網址由呼叫端組好帶進來。
 */
export function reminderMail(
  kind: 'item' | 'grading',
  input: { readonly title: string; readonly dueAt: Date | null; readonly url: string },
): MailContent {
  if (kind === 'grading') {
    return {
      template: 'reminder',
      subject: `${BRAND}評分催繳`,
      text: `${input.title}。請到 ${input.url} 完成評分並送出。`,
    }
  }
  const due = input.dueAt ? `，截止 ${formatTaipeiMinute(input.dueAt)}` : ''
  return {
    template: 'reminder',
    subject: `${BRAND}作業催繳`,
    text: `${input.title} 尚未繳交${due}。請到 ${input.url} 查看並完成。`,
  }
}
