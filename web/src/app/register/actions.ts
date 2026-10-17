'use server'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import {
  clientIpFrom,
  EMAIL_VERIFY_PATH,
  getRegistrationCommand,
  homeForUser,
  isRegistrationOpen,
  PASSWORD_MIN_LENGTH,
  resolveActor,
  signOut,
} from '@/composition/accounts'
import { authCallHeaders, SIGNUP_RESUME_COOKIE_SECONDS, signUpOrResume } from '@/composition/signup'
import type { ApplicationFormState } from './application-form'
import {
  authErrorMessage,
  decodeResume,
  EMAIL_UNVERIFIED_MESSAGE,
  encodeResume,
  failed,
  field,
  RESUME_COOKIE,
  valuesOf,
  type SignupFormState,
} from './_components/form-data'
import { signupFieldErrors } from './_components/signup-checks'

/**
 * 註冊第 1 步（VB-3；visitor-r3 §3.3）與「修改資料」（等待審核頁用）。
 *
 * 這裡只把表單欄位取成字串、把結果翻成畫面要的樣子。**驗證、授權、限速、人機驗證都在 Better Auth 的 hook
 * 與用例**，直接呼叫這些 action 的人繞不過去。
 */

/**
 * 第 1 步：建立帳號（Email＋密碼）。
 *
 * - 新帳號：套件建帳號、登入受限 session，並在伺服器內寄出第一封驗證碼 → `/register/verify`。
 * - 這個 Email 有一筆還沒完成的註冊（VB-2 續辦）：驗證碼已寄出、新密碼暫存在伺服器；續辦票存在這個瀏覽器的
 *   HttpOnly cookie → `/register/verify?resume=1`。
 * - 其他（已有帳號、停用、老師預授權…）：一律同一句「這個 Email 無法用來註冊…」，不寄信。
 */
export async function signUpStepAction(state: SignupFormState, formData: FormData): Promise<SignupFormState> {
  if (!isRegistrationOpen()) redirect('/login')
  const email = field(formData, 'email', 254).trim()
  const password = field(formData, 'password', 200)
  const passwordConfirm = field(formData, 'passwordConfirm', 200)
  const attempt = (state?.attempt ?? 0) + 1

  const errors = signupFieldErrors({ email, password, passwordConfirm }, PASSWORD_MIN_LENGTH)
  const first = (['email', 'password', 'passwordConfirm'] as const).find((k) => errors[k])
  if (first) return { error: errors[first]!, field: first, email, attempt }

  const incoming = await headers()
  const callHeaders = authCallHeaders({
    // 來源 IP 的取法與登入、Better Auth hook 同一個函式（Caddy 覆寫 X-Real-IP，偽造不了）。
    ip: clientIpFrom(incoming),
    turnstileToken: field(formData, 'cf-turnstile-response', 4096),
  })

  let resume: { ticket: string; email: string } | null = null
  try {
    // 姓名先填 Email 前綴；第 3 步送申請時填的才是真名（系辦看的是申請上的姓名）。
    const outcome = await signUpOrResume({ email, password, name: email.split('@')[0] || email }, callHeaders)
    if (outcome.kind === 'resume') resume = { ticket: outcome.ticket, email: outcome.email }
  } catch (error) {
    const { message } = authErrorMessage(error, '註冊暫時無法完成，請稍後再試。')
    return { error: message, email, attempt }
  }

  const jar = await cookies()
  if (resume) {
    jar.set(RESUME_COOKIE, encodeResume(resume), {
      httpOnly: true,
      sameSite: 'lax',
      secure: (process.env.BETTER_AUTH_URL ?? '').startsWith('https:'),
      path: '/register',
      maxAge: SIGNUP_RESUME_COOKIE_SECONDS,
    })
    redirect('/register/verify?resume=1')
  }
  // 之前沒做完的續辦票留著也沒用了。
  jar.delete({ name: RESUME_COOKIE, path: '/register' })
  redirect('/register/verify')
}

/**
 * 第 2 步「Email 打錯了？回上一步修改」：**只登出、保留 Email**，不刪任何列（visitor-r3 §3.3）。
 * 留下的未驗證帳號之後同 Email 再來時走續辦。
 */
export async function backToSignupStep(formData: FormData): Promise<void> {
  const incoming = await headers()
  const jar = await cookies()
  const actor = await resolveActor(incoming)
  let email = decodeResume(jar.get(RESUME_COOKIE)?.value)?.email ?? ''
  if (actor.kind === 'authenticated') {
    const mine = await getRegistrationCommand().viewMine(actor)
    if (mine.ok) email = mine.receipt.loginEmail
    // 只有「還沒驗證、還沒送申請」的人會看到這顆鈕；其他人按了也只是登出，資料一列都不動。
    await signOut(incoming)
  }
  jar.delete({ name: RESUME_COOKIE, path: '/register' })
  // 表單上帶的 Email 只在上面兩種來源都沒有時才用（例如 cookie 已過期）。
  if (!email) email = field(formData, 'email', 254).trim()
  redirect(email ? `/register?email=${encodeURIComponent(email)}` : '/register')
}

/**
 * 待審期間修改申請（或被退回後重送）。
 *
 * 成功後導回等待審核頁並帶 `?updated=版本`，頁面顯示「已更新，狀態仍是待審核」。
 */
export async function reviseApplicationAction(
  state: ApplicationFormState,
  formData: FormData,
): Promise<ApplicationFormState> {
  const values = valuesOf(formData)
  const rawRevision = field(formData, 'expectedRevision', 10)
  const expectedRevision = rawRevision === '' ? null : /^\d+$/.test(rawRevision) ? Number(rawRevision) : NaN

  const actor = await resolveActor(await headers())
  // 還沒驗證 Email 的人不能經這個舊入口送出第一份申請（VB-3 Review；用例層同樣會擋）。
  if (actor.kind === 'authenticated' && (await homeForUser(actor.userId)) === EMAIL_VERIFY_PATH) {
    return failed(state, EMAIL_UNVERIFIED_MESSAGE, values)
  }
  const result = await getRegistrationCommand().reviseMine(
    actor,
    {
      appliedName: values.appliedName,
      studentNo: values.studentNo,
      departmentClass: values.departmentClass,
      phone: values.phone,
      contactEmail: values.contactEmail ?? '',
    },
    expectedRevision,
  )
  if (!result.ok) return failed(state, result.message, values, 'details' in result ? result.details : undefined)
  redirect(`/register/pending?updated=${result.receipt.revision}`)
}
