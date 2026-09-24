import 'server-only'
import { uuidv7 } from 'uuidv7'
import { getPool } from '@/infrastructure/db/client'

/**
 * 登入方式相關的小工具（票 10；模組 01 §2.3「登入方式」）。
 *
 * 一個帳號可以同時有 Google 與密碼兩種登入方式（Better Auth 的 `accounts` 表各一列：
 * `provider_id='google'`／`'credential'`）。這個檔只放「讀／記」，規則在 hook 與用例裡。
 */

/** 契約 03 §2：fresh session＝10 分鐘內登入過。連結 Google、設定密碼都要。 */
export const FRESH_AGE_SECONDS = 10 * 60

/**
 * 這個 session 還算不算 fresh。
 *
 * 判準與 Better Auth 的 `freshSessionMiddleware` 一致：現在減 `createdAt` **小於** freshAge。
 * 讀不到時間一律當作不 fresh（寧可請人重新登入，不放行）。
 */
export function isFreshSession(createdAt: Date | string | number | null | undefined, now = Date.now()): boolean {
  if (createdAt === null || createdAt === undefined) return false
  const at = new Date(createdAt).getTime()
  return Number.isFinite(at) && now - at < FRESH_AGE_SECONDS * 1000
}

export type LoginMethods = { readonly google: boolean; readonly password: boolean }

/**
 * 這個人有哪幾種登入方式。
 *
 * 直接讀 `accounts`，**不用** `auth.api.listUserAccounts`：`/list-accounts` 在路由矩陣裡要
 * fresh session，帳號頁若靠它，登入十分鐘後整頁就讀不到了。只取 `provider_id` 與
 * 「有沒有密碼」這個布林，token 與雜湊一律不出資料庫。
 */
export async function readLoginMethods(userId: string): Promise<LoginMethods> {
  const rows = await getPool().query<{ provider_id: string; has_password: boolean }>(
    `select provider_id, password is not null as has_password from accounts where user_id = $1`,
    [userId],
  )
  return {
    google: rows.rows.some((r) => r.provider_id === 'google'),
    password: rows.rows.some((r) => r.provider_id === 'credential' && r.has_password),
  }
}

/**
 * 新增了一種登入方式之後的稽核（`accounts` 建立之後，由 `databaseHooks.account.create.after` 呼叫）。
 *
 * 只有「這個人原本已經有別種登入方式」才算連結：Google 首次註冊、密碼註冊建的第一列不記
 * （那是註冊，不是連結）。稽核不含任何 token 或密碼。
 *
 * 寫不進去只記 log、不丟例外：此刻 `accounts` 那一列已經建好（套件不在我們的交易裡），
 * 丟例外只會讓使用者看到一個莫名的錯誤頁，連結本身卻已經生效。
 */
export async function recordLoginMethodAdded(userId: string, providerId: string): Promise<void> {
  try {
    const others = await getPool().query<{ n: number }>(
      `select count(*)::int as n from accounts where user_id = $1 and provider_id <> $2`,
      [userId, providerId],
    )
    if ((others.rows[0]?.n ?? 0) === 0) return
    const action = providerId === 'google' ? 'account.link_google' : providerId === 'credential' ? 'account.set_password' : null
    if (!action) return
    await getPool().query(
      `insert into audit_events
         (id, actor_kind, actor_user_id, action, target_type, target_id, scope, real_at, business_at, payload)
       values ($1, 'user', $2, $3, 'user', $2, 'global', now(), now(), '{}'::jsonb)`,
      [uuidv7(), userId, action],
    )
  } catch (error) {
    console.error('[auth] 新增登入方式的稽核寫入失敗', error)
  }
}

/**
 * 記下「帳號最近一次登入方式」（`user_profiles.login_method_last`，列表顯示用）。
 *
 * 只是顯示欄，不作任何判定（模組 01 §2）；每個 session 的登入方式在 `sessions.login_method`。
 * 還沒有個人資料列（待審者、還沒補資料的老師）就沒有東西可更新，照樣放行。
 * 不動 `revision`／`updated_at`：這不是本人或系辦改了資料。
 */
export async function recordLastLoginMethod(userId: string, method: 'google' | 'password'): Promise<void> {
  try {
    await getPool().query(
      `update user_profiles set login_method_last = $2
        where user_id = $1 and login_method_last is distinct from $2`,
      [userId, method],
    )
  } catch (error) {
    console.error('[auth] 最近登入方式寫入失敗', error)
  }
}

/**
 * 這個 OAuth state 是不是一次「登入」（不是連結）。
 *
 * 只有讀得到一個物件、而且 `link` 是空的才算；null、undefined、不是物件一律 false（不綁）。
 */
export function isSignInState(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false
  return !(state as { link?: unknown }).link
}

// ── 預授權老師第一次用 Google 登入（票 8 × 票 10） ─────────────────────────

/**
 * 系辦「只用 Email 預授權」的老師（票 8）：`users` 列已建好、狀態 active、有有效的 teacher 角色，
 * 但**一種登入方式都沒有**（`accounts` 沒有任何一列）。
 *
 * 這種帳號第一次用同 Email 的 Google 登入時要能直接進來。平常 `disableImplicitLinking` 會把
 * 「同 Email 已有帳號」一律擋成 `account_not_linked`——那是為了不讓別人用同 Email 的 Google
 * 接管一個**已經有登入方式**的帳號。預授權帳號沒有任何登入方式，沒有東西可以被接管；
 * 系辦預授權的意思就是「這個 Email 的主人就是這位老師」，而 Google 已驗證對方擁有這個 Email。
 *
 * 所以在套件查帳號之前（Google provider 的 `mapProfileToUser`，此時 Google 身分已由授權碼換到、
 * 還沒開始找使用者），符合**全部**條件就先替這個帳號補上 Google 那一列，套件接著就把它當成
 * 「已連結的 Google」正常登入：
 * - Google 回報 `email_verified = true`；
 * - 同 Email（不分大小寫）的帳號狀態 active、沒有去識別化、有有效的 teacher 角色；
 * - 這個帳號**沒有任何** `accounts` 列（有密碼或已連過 Google 的一律不碰，照舊 account_not_linked）；
 * - 這個 Google 身分沒有綁在任何帳號上。
 *
 * 鎖 `users` 那一列再判，兩個分頁同時回來只會補一次。留一筆稽核。
 * 寫不進去只記 log：結果就是套件照舊回 account_not_linked，老師可以請系辦發臨時密碼。
 */
export async function bindPreauthorizedTeacher(profile: {
  sub?: unknown
  email?: unknown
  email_verified?: unknown
}): Promise<void> {
  const sub = typeof profile.sub === 'string' ? profile.sub : ''
  const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : ''
  if (!sub || !email || profile.email_verified !== true) return

  const client = await getPool().connect()
  try {
    await client.query('begin')
    const found = await client.query<{ id: string }>(
      `select u.id from users u
        where lower(u.email) = $1
          and u.status = 'active'
          and u.deidentified_at is null
          and exists (select 1 from role_assignments r
                       where r.user_id = u.id and r.role = 'teacher' and r.revoked_real_at is null)
        for update`,
      [email],
    )
    const userId = found.rows[0]?.id
    if (!userId) {
      await client.query('rollback')
      return
    }
    const blocked = await client.query(
      `select 1 from accounts
        where user_id = $1 or (provider_id = 'google' and account_id = $2)
        limit 1`,
      [userId, sub],
    )
    if (blocked.rowCount) {
      await client.query('rollback')
      return
    }
    await client.query(
      `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, 'google', $3, now(), now())`,
      [uuidv7(), sub, userId],
    )
    await client.query(
      `insert into audit_events
         (id, actor_kind, actor_user_id, action, target_type, target_id, scope, real_at, business_at, payload)
       values ($1, 'user', $2, 'account.bind_google_preauthorized', 'user', $2, 'global', now(), now(), '{}'::jsonb)`,
      [uuidv7(), userId],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    console.error('[auth] 預授權老師綁定 Google 失敗', error)
  } finally {
    client.release()
  }
}

// ── 註冊時 Email 已被用過（票 7 遺留） ─────────────────────────────────────

/**
 * 直接打 `POST /api/auth/sign-up/email` 時，Email 已被用過與 Email 格式不對回的是**同一個**
 * 400＋代碼＋訊息，不再是套件的 422 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`。
 * 訊息與註冊頁的統一訊息一字不差。
 */
export const EMAIL_UNAVAILABLE_CODE = 'EMAIL_UNAVAILABLE'
export const EMAIL_UNAVAILABLE_MESSAGE = '這個 Email 無法用來註冊。如果你已經有帳號，請直接登入。'

/** 套件在註冊時回的哪些代碼要統一成上面那一句。 */
export const SIGN_UP_EMAIL_ERROR_CODES: ReadonlySet<string> = new Set([
  'USER_ALREADY_EXISTS',
  'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
  'INVALID_EMAIL',
])
