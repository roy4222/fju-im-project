import type { ApplicationFormState, ApplicationFormValues } from '../application-form'

/**
 * 註冊各步的 Server Action 共用的小工具（`'use server'` 檔只能匯出 async 函式，所以放這裡）。
 */

/** 跟用例層 `APPLY_EMAIL_UNVERIFIED_MESSAGE` 同一句（app 不能從 application 帶值）。 */
export const EMAIL_UNVERIFIED_MESSAGE = '請先完成 Email 驗證。'

/** 表單欄位一律當字串讀；不是字串或長得離譜就當沒填（用例會回「請填…」）。 */
export function field(formData: FormData, name: string, max = 300): string {
  const value = formData.get(name)
  return typeof value === 'string' && value.length <= max ? value : ''
}

export function valuesOf(formData: FormData): ApplicationFormValues {
  return {
    appliedName: field(formData, 'appliedName'),
    studentNo: field(formData, 'studentNo'),
    departmentClass: field(formData, 'departmentClass'),
    phone: field(formData, 'phone'),
    contactEmail: field(formData, 'contactEmail'),
  }
}

export function failed(
  state: ApplicationFormState,
  message: string,
  values: ApplicationFormValues,
  details?: Record<string, unknown>,
): ApplicationFormState {
  const fieldName = typeof details?.field === 'string' ? details.field : undefined
  const attempt = state && 'attempt' in state ? state.attempt : 0
  return { error: message, field: fieldName, values, attempt: attempt + 1 }
}

/**
 * Better Auth 丟回來的錯誤（`APIError`）翻成畫面的一句話。hook 的訊息本來就是給人看的中文
 * （限速、人機驗證、寄信失敗、Email 無法註冊、驗證碼不正確），而且都不透露帳號存不存在；
 * 沒有訊息或不是預期的錯誤時用 `fallback`，並記 log（不含任何輸入內容）。
 */
export function authErrorMessage(error: unknown, fallback: string): { code: string; message: string } {
  const body = (error as { body?: { code?: unknown; message?: unknown } } | null)?.body
  const code = typeof body?.code === 'string' ? body.code : ''
  const message = typeof body?.message === 'string' && body.message ? body.message : ''
  if (code && message && KNOWN_CODES.has(code)) return { code, message }
  console.error('[register] 認證服務回了預期以外的錯誤', code || (error as { status?: unknown } | null)?.status)
  return { code: code || 'INTERNAL', message: fallback }
}

const KNOWN_CODES = new Set([
  'EMAIL_UNAVAILABLE',
  'RATE_LIMITED',
  'TURNSTILE_REQUIRED',
  'TURNSTILE_UNAVAILABLE',
  'MAIL_FAILED',
  'VALIDATION_FAILED',
  'REGISTRATION_CLOSED',
  'INVALID_OTP',
  'SIGNUP_RESUME_EXPIRED',
  'UNAUTHENTICATED',
])

/**
 * 續辦票的 cookie：只存在發起續辦的那個瀏覽器（HttpOnly）。壽命跟伺服器的暫存列一樣（絕對截止再多 10 分鐘；
 * `SIGNUP_RESUME_COOKIE_SECONDS`，由 `register/actions.ts` 在續辦開始時設一次，重寄不延）：視窗過了、截止內還能重寄復活，
 * 而 cookie 還帶得回票的期間，過了截止的重寄一定看得到「續辦已逾時」。
 */
export const RESUME_COOKIE = 'fju_signup_resume'

/** 票是 base64url（沒有 `.`），Email 也編成 base64url，用 `.` 接起來。 */
export function encodeResume(input: { ticket: string; email: string }): string {
  return `${input.ticket}.${Buffer.from(input.email, 'utf8').toString('base64url')}`
}

export function decodeResume(value: string | undefined): { ticket: string; email: string } | null {
  if (!value) return null
  const [ticket, encoded, ...rest] = value.split('.')
  if (!ticket || !encoded || rest.length) return null
  const email = Buffer.from(encoded, 'base64url').toString('utf8')
  return email.includes('@') ? { ticket, email } : null
}

/** 第 1 步表單的狀態（`actions.ts` 只能匯出 async 函式，型別放這裡）。 */
export type SignupFormState =
  | { error: string; field?: 'email' | 'password' | 'passwordConfirm'; email: string; attempt: number }
  | undefined

/** 第 2 步填碼、重寄兩個表單的狀態。 */
export type VerifyFormState = { error: string; attempt: number } | undefined
/** `restartHref`：續辦已過絕對截止時給「重新開始」連結（回第 1 步、Email 帶著）。 */
export type ResendFormState = { error?: string; restartHref?: string; sentAt?: number; attempt: number } | undefined
