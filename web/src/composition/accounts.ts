import 'server-only'
import type { ActorResolver, ResolvedActor, SelfAccountCommand } from '@/application/accounts'
import { DbActorResolver } from '@/infrastructure/auth/actor-resolver'
import { BetterAuthSelfAccountCommand } from '@/infrastructure/auth/self-account'
import { signInWithPassword, signOutCurrent } from '@/infrastructure/auth/wrapper'
import { createRateLimiter, RATE_LIMITS } from '@/shared/rate-limit'
import { getPool } from '@/infrastructure/db/client'

/**
 * 模組 01 的實例組裝（母 spec §4.3：執行期的實作一律由 composition 注入）。
 */
let actorResolver: ActorResolver | undefined

export function getActorResolver(): ActorResolver {
  actorResolver ??= new DbActorResolver()
  return actorResolver
}

/**
 * 給 app 層用的薄門面。
 *
 * app（頁面）對 application 只能帶型別（母 spec §4.3），執行期一律經這裡；
 * 這幾個函式刻意不碰 Next 的 API（不做 redirect、不讀 headers），
 * 那是頁面自己的事，這裡只回答「是誰」與「這個狀態能不能做」。
 */
export function resolveActor(headers: Headers): Promise<ResolvedActor> {
  return getActorResolver().resolve(headers)
}

export { hasRole as actorHasRole, statusGate as checkStatus } from '@/application/accounts'

/** 本人帳號用例（S01-05 只做改密碼）。 */
let selfAccountCommand: SelfAccountCommand | undefined

export function getSelfAccountCommand(): SelfAccountCommand {
  selfAccountCommand ??= new BetterAuthSelfAccountCommand()
  return selfAccountCommand
}

/**
 * 登入（契約 03 §6 的限速就掛在這裡）。
 *
 * 鍵是「IP ＋ 帳號」：同一個 IP 對**同一個帳號** 10 分鐘內 10 次。
 * 用 IP＋帳號而不是只用 IP，是因為系上都在同一個對外 IP 後面，只看 IP 會擋到無辜的人；
 * 只看帳號則擋不住從很多 IP 打同一個帳號。達到上限之後**連正確的密碼也先擋**，
 * 不然攻擊者可以用「有沒有被擋」當作密碼對不對的訊號。
 */
const signInLimiter = createRateLimiter(RATE_LIMITS.signIn)

export type SignInOutcome =
  | {
      readonly ok: true
      /** 真的登入成功之後該去哪：被要求改密的人先去改密頁，其他人去自己的後台。 */
      readonly destination: string
      readonly mustChangePassword: boolean
    }
  | { readonly ok: false; readonly code: 'RATE_LIMITED' | 'INVALID_CREDENTIALS'; readonly message: string }

export async function signIn(input: {
  email: string
  password: string
  ip: string
}): Promise<SignInOutcome> {
  const key = `sign-in:${input.ip}:${input.email.toLowerCase()}`
  if (!signInLimiter.hit(key).allowed) {
    return { ok: false, code: 'RATE_LIMITED', message: '嘗試過多，請稍後再試。' }
  }

  let signedIn: Awaited<ReturnType<typeof signInWithPassword>>
  try {
    signedIn = await signInWithPassword({ email: input.email, password: input.password })
  } catch {
    // 不分辨「沒有這個帳號」與「密碼錯」——分辨了就等於提供一個查帳號存不存在的通道
    //（模組 01 §3 的統一訊息）。
    return { ok: false, code: 'INVALID_CREDENTIALS', message: 'Email 或密碼不正確。' }
  }

  signInLimiter.reset(key)

  const userId = signedIn.user.id
  const mustChangePassword = Boolean(
    (signedIn.user as { mustChangePassword?: boolean }).mustChangePassword,
  )

  // 被要求改密的人先去改密頁；其他人直接進自己的後台（票 #48 第 3 節）。
  const destination = mustChangePassword ? '/account/change-password' : await homeForUser(userId)
  return { ok: true, destination, mustChangePassword }
}

/** 這個人登入後預設看哪一個後台。角色來自 `role_assignments`（不是套件的 `users.role`）。 */
async function homeForUser(userId: string): Promise<string> {
  const rows = await getPool().query<{ role: string }>(
    `select role from role_assignments where user_id = $1 and revoked_real_at is null`,
    [userId],
  )
  const roles = rows.rows.map((r) => r.role)
  if (roles.includes('admin')) return '/dashboard/admin'
  if (roles.includes('teacher')) return '/dashboard/teacher'
  if (roles.includes('student')) return '/dashboard/student'
  // 登入了但還沒有角色＝還在等審核。
  return '/register/pending'
}

/** 登出目前這一台。 */
export async function signOut(headers: Headers): Promise<void> {
  await signOutCurrent(headers)
}

/** 測試用：清掉登入的限速計數。 */
export function resetSignInLimiter(): void {
  signInLimiter.clear()
}

/** 新密碼的長度下限（規則在 application 層；app 只能經 composition 拿執行期的值）。 */
export { MIN_PASSWORD_LENGTH } from '@/application/accounts'
