import 'server-only'
import type {
  ActorResolver,
  RegistrationCommand,
  ResolvedActor,
  RosterCommand,
  SelfAccountCommand,
} from '@/application/accounts'
import { PgRegistrationCommand } from '@/infrastructure/accounts/registration-command'
import { PgRosterCommand } from '@/infrastructure/accounts/roster-command'
import { DbActorResolver } from '@/infrastructure/auth/actor-resolver'
import { BetterAuthSelfAccountCommand } from '@/infrastructure/auth/self-account'
import { signInWithPassword, signOutCurrent } from '@/infrastructure/auth/wrapper'
import { getPool } from '@/infrastructure/db/client'
import { getCohortStatusQuery } from '@/composition/cohorts'
import { getAuditWriter, getFileStorage, getOperationLedger } from '@/composition/ops'

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

/** 名單匯入（票 6）：共用檔案能力＋稽核＋帳本由這裡注入。 */
let rosterCommand: RosterCommand | undefined

export function getRosterCommand(): RosterCommand {
  rosterCommand ??= new PgRosterCommand({
    files: getFileStorage(),
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    db: getPool,
    cohorts: getCohortStatusQuery(),
  })
  return rosterCommand
}

/** 學生註冊與審核（票 7）：稽核＋帳本＋模組 02 的屆別查詢由這裡注入。 */
let registrationCommand: RegistrationCommand | undefined

export function getRegistrationCommand(): RegistrationCommand {
  registrationCommand ??= new PgRegistrationCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    db: getPool,
    cohorts: getCohortStatusQuery(),
  })
  return registrationCommand
}

/** 註冊與審核畫面要用的標籤與上限（app 對 application 只能帶型別，執行期的值經這裡）。 */
export {
  APPLIED_NAME_MAX_LENGTH,
  DEPARTMENT_CLASS_MAX_LENGTH,
  EVIDENCE_LABEL,
  EVIDENCE_NEEDS_ATTENTION,
  PASSWORD_MIN_LENGTH,
  REASON_MAX_LENGTH,
  VERIFICATION_LABEL,
  VERIFICATION_METHODS,
  VERIFICATION_NOTE_HINT,
  VERIFICATION_NOTE_REQUIRED,
} from '@/application/accounts'

/**
 * 這次請求的來源 IP（契約 03 §6 的限速鍵）。
 *
 * 正式環境 Caddy 以 `header_up X-Real-IP {remote_host}` **覆寫** `X-Real-IP`，使用者自己帶的
 * 同名標頭到不了 app，所以優先讀它；沒有它（本機直連）才退回 `X-Forwarded-For` 的第一段。
 * 與 Better Auth hook 裡取 IP 的是同一個函式，Server Action 與直接打 API 算的是同一個人。
 */
export { clientIpFrom } from '@/infrastructure/auth/sign-in-rate-limit'

/** 測試用：清掉註冊的限速計數。 */
export { resetSignUpLimiter } from '@/infrastructure/auth/sign-up-rate-limit'

/**
 * 登入。
 *
 * **限速不在這裡**：契約 03 §6 的「同一 IP 對同一帳號 10 分鐘 10 次」放在 Better Auth 的
 * hook 裡（`sign-in-rate-limit.ts`），所以直接打 `/api/auth/sign-in/email` 也算同一個桶
 * （2026-09-16 review Spec 4）。這裡只負責把來源 IP 傳進去、把結果翻成畫面看得懂的樣子。
 */
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
  let signedIn: Awaited<ReturnType<typeof signInWithPassword>>
  try {
    signedIn = await signInWithPassword(
      { email: input.email, password: input.password },
      // hook 的限速靠這個標頭取來源；Caddy 在正式環境帶的也是 X-Real-IP。
      new Headers({ 'x-real-ip': input.ip }),
    )
  } catch (error) {
    if ((error as { status?: string })?.status === 'TOO_MANY_REQUESTS') {
      return { ok: false, code: 'RATE_LIMITED', message: '嘗試過多，請稍後再試。' }
    }
    // 不分辨「沒有這個帳號」「密碼錯」與「帳號已停用」——分辨了就等於提供一個
    // 查帳號狀態的通道（模組 01 §3 的統一訊息）。
    return { ok: false, code: 'INVALID_CREDENTIALS', message: 'Email 或密碼不正確。' }
  }

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
export { resetSignInLimiter } from '@/infrastructure/auth/sign-in-rate-limit'

/** 新密碼的長度下限（規則在 hook 層；app 只能經 composition 拿執行期的值）。 */
export { MIN_PASSWORD_LENGTH } from '@/infrastructure/auth/change-password-rules'
