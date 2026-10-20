/**
 * 寄信（B 階段 VB-1）的公開入口（母 spec §4.3）。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的 `Mailer` 由 composition 注入。
 */
export type { Mailer, MailContent, MailErrorCode, MailMessage, MailSendResult, MailTemplate } from '@/application/mail/ports'
export type { RegistrationOutcome } from '@/application/mail/templates'
export {
  EMAIL_OTP_MINUTES,
  emailOtpMail,
  PASSWORD_RESET_MINUTES,
  passwordResetMail,
  registrationResultMail,
  reminderMail,
} from '@/application/mail/templates'
