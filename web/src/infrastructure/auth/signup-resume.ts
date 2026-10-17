import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'

/**
 * 續辦未完成的註冊（B 階段 VB-2；visitor-r3 設計方案 §3.2「續辦」）。
 *
 * 情境：有人用某個 Email 註冊了、卻沒完成 Email 驗證（關掉分頁、Email 打錯回上一步、或根本是別人亂填的）。
 * 之後真正的信箱主人用同一個 Email 再註冊，不能回「這個 Email 無法用來註冊」把他擋在門外，
 * 也**不能刪掉那個帳號重建**（使用者列永不硬刪，`users`／`accounts` 沒有 DELETE 權限）。所以：
 *
 * 1. 第 1 步的註冊照舊回 `EMAIL_UNAVAILABLE`；wrapper 接著看那個帳號**可不可以續辦**（`isResumableSignup`）。
 * 2. 可以 → 對該 Email 寄一封驗證碼（內部入口，同一次註冊已驗過 Turnstile），新密碼的雜湊連同這封信的碼、
 *    一張續辦票（給發起的瀏覽器）暫存在 `verifications` 一列（10 分鐘），**不換密碼、不動 session**。
 * 3. 填對驗證碼 → 一筆交易內：`email_verified = true`、credential 密碼換成暫存的新雜湊、刪掉這個人全部舊 session
 *    （先前不知道是誰建的帳號，之前的登入一律作廢），之後才發新 session。
 *
 * 不可以續辦的（老師、已核准學生、停用、已送申請、有 Google 登入方式、有任何業務紀錄）一律照舊回既有句、不寄信。
 * 「可續辦」只有一個謂詞，VB-14（半成品帳號 7 天清密碼）也用同一個。
 */

type Queryable = Pick<Pool, 'query'> | PoolClient

/** 暫存新密碼雜湊的有效秒數（跟驗證碼同樣 10 分鐘）。 */
export const SIGNUP_RESUME_TTL_SECONDS = 600

/**
 * 這個帳號可不可以續辦（全部成立才算）：
 * - `pending`、`email_verified = false`、沒有去識別化；
 * - 沒有任何 `role_assignments`（含已撤銷的；排除系辦預授權的老師）；
 * - 沒有 credential 以外的登入方式（Google 來的人 Email 已由 Google 證明）；
 * - 沒有 `registration_applications`、`user_profiles`、`student_identities`、`user_status_events`、
 *   `group_memberships`（送過申請、被系辦處理過、或有任何業務紀錄的都不是「半成品」）。
 *
 * 傳 `PoolClient` 時在呼叫端的交易裡讀（VB-14 先 `for update` 鎖列再重驗）。
 */
export async function isResumableSignup(db: Queryable, userId: string): Promise<boolean> {
  const result = await db.query<{ ok: boolean }>(
    `select exists (
       select 1 from users u
        where u.id = $1
          and u.status = 'pending'
          and u.email_verified = false
          and u.deidentified_at is null
          and not exists (select 1 from role_assignments r where r.user_id = u.id)
          and not exists (select 1 from accounts a where a.user_id = u.id and a.provider_id <> 'credential')
          and not exists (select 1 from registration_applications ra where ra.user_id = u.id)
          and not exists (select 1 from user_profiles p where p.user_id = u.id)
          and not exists (select 1 from student_identities si where si.user_id = u.id)
          and not exists (select 1 from user_status_events e where e.user_id = u.id)
          and not exists (select 1 from group_memberships gm where gm.user_id = u.id)
     ) as ok`,
    [userId],
  )
  return result.rows[0]?.ok === true
}

/** 登入 Email 的比對形式（Better Auth 存的就是小寫）。 */
export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** 用登入 Email 找帳號 id；找不到回 null。 */
export async function findUserIdByEmail(db: Queryable, email: string): Promise<string | null> {
  const result = await db.query<{ id: string }>('select id from users where email = $1', [normalizeEmail(email)])
  return result.rows[0]?.id ?? null
}

/** `verifications` 裡暫存新密碼雜湊那一列的 identifier。 */
export function signupResumeIdentifier(email: string): string {
  return `signup-resume:${normalizeEmail(email)}`
}

/** 套件 email-otp 外掛存 Email 驗證碼的 identifier（`plugins/email-otp/utils.mjs` 的 `toOTPIdentifier`）。 */
export function emailOtpIdentifier(email: string): string {
  return `email-verification-otp-${normalizeEmail(email)}`
}

/**
 * 跟套件 email-otp 外掛 `storeOTP: 'hashed'` 同一個雜湊（`plugins/email-otp/utils.mjs` 的 `defaultKeyHasher`：
 * SHA-256、base64url 不補 `=`）。續辦完成時在自己的交易裡重算提交的碼，跟那一列比對（套件升版改格式時
 * `signup-resume.integration.test.ts` 會紅）。續辦票（ticket）也用同一個雜湊存，不存明文。
 */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

/** 現在這個 Email 的驗證碼那一列存的雜湊（`<hash>:<錯誤次數>` 的前半）；沒有回 null。 */
async function currentOtpHash(db: Queryable, email: string, lock = false): Promise<string | null> {
  const row = await db.query<{ value: string }>(
    // 套件換碼是「再插一列」，同一個 identifier 可能有好幾列；它自己讀的是最新那一列，這裡也一樣。
    `select value from verifications where identifier = $1 order by created_at desc, id desc limit 1${lock ? ' for update' : ''}`,
    [emailOtpIdentifier(email)],
  )
  const value = row.rows[0]?.value
  if (!value) return null
  const at = value.lastIndexOf(':')
  return at === -1 ? value : value.slice(0, at)
}

/** 同一個 Email 的「續辦綁定」與「續辦完成」排隊（交易級 advisory lock；鍵是 `signup-resume:<email>`）。 */
function lockKey(email: string): string {
  return `signup-resume:${normalizeEmail(email)}`
}

/**
 * 續辦開始。順序固定：**先寄碼、再綁定**，而且寄碼期間不持有任何資料庫連線。
 *
 * - `send` 由 wrapper 傳進來，走套件的寄碼端點：套件在端點**裡面**產碼、寫 `verifications`（經它自己的 adapter 向
 *   `getPool()` 借連線），再呼叫寄信回呼（寄信轉接器寫 `mail_outbox`，也向同一個池借）。所以這一步不能在自己
 *   占著一條連線時做：`DB_POOL_MAX=1`（worker 容器是 2）時唯一那條被自己占著，套件借不到就死等到
 *   `connectionTimeoutMillis`（Review 第 2 輪反例；`signup-resume.integration.test.ts` 的 `DB_POOL_MAX=1` 案例守住）。
 *   寄不出去（`MAIL_FAILED`）或被冷卻／限速擋下就在這裡丟出去，什麼都不留。
 * - 寄出去之後才開一筆**短交易**：拿跟 `finishSignupResume` 同一把交易級 advisory lock（同一個 Email 的綁定與完成
 *   排隊）、重驗這個帳號還能續辦、鎖並讀**此刻最新那封**驗證碼的雜湊，連同新密碼雜湊、續辦票寫成一列（10 分鐘）。
 *   交易裡只用這一條連線，不再向池借任何東西。
 *
 * 兩個人同時對同一個 Email 開始續辦：兩封都寄、綁定排隊，各自讀到的都是當時最新那封的碼，後寫的那一列留下來；
 * 先寫的那個人完成時票對不上，拿到 `SIGNUP_RESUME_EXPIRED`。保證跟「寄碼也在鎖裡」的舊版一樣：完成仍要求
 * 提交的碼＝最新那列＝暫存列綁的碼、票要對，而且暫存列的密碼與票永遠來自同一個請求（同一列、同一次寫入）。
 *
 * 帳號在寄碼之後、綁定之前變得不能續辦（例如信箱主人剛好完成了另一次續辦）→ 不留暫存、回 `not_resumable`，
 * 呼叫端照舊丟 `EMAIL_UNAVAILABLE`。
 */
export async function startSignupResume(
  db: Pool,
  input: {
    userId: string
    email: string
    send: () => Promise<unknown>
    passwordHash: () => Promise<string>
    now?: () => Date
  },
): Promise<{ ok: true; ticket: string } | { ok: false; reason: 'not_resumable' }> {
  const email = normalizeEmail(input.email)
  // 1) 寄碼：這時手上沒有任何連線（套件與寄信轉接器各自向池借、自己還）。
  await input.send()
  // 密碼雜湊（scrypt）不碰資料庫；放在寄碼之後，被冷卻／限速擋下的請求不白算一次。
  const passwordHash = await input.passwordHash()
  const ticket = randomBytes(32).toString('base64url')
  const now = input.now?.() ?? new Date()

  // 2) 綁定：一筆短交易，只用 `tx` 這一條連線。
  const tx = await db.connect()
  try {
    await tx.query('begin')
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [lockKey(email)])
    if (!(await isResumableSignup(tx, input.userId))) {
      await tx.query('rollback')
      return { ok: false, reason: 'not_resumable' }
    }
    const otpHash = await currentOtpHash(tx, email, true)
    if (!otpHash) throw new Error('續辦寄碼之後讀不到驗證碼')
    const identifier = signupResumeIdentifier(email)
    const value = JSON.stringify({ userId: input.userId, passwordHash, otpHash, ticketHash: hashSecret(ticket) })
    await tx.query('delete from verifications where identifier = $1', [identifier])
    await tx.query(
      `insert into verifications (id, identifier, value, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $5)`,
      [uuidv7(), identifier, value, new Date(now.getTime() + SIGNUP_RESUME_TTL_SECONDS * 1000), now],
    )
    await tx.query('commit')
    return { ok: true, ticket }
  } catch (error) {
    await tx.query('rollback').catch(() => undefined)
    throw error
  } finally {
    tx.release()
  }
}

export type SignupResumeFailure = 'not_resumable' | 'expired'

/**
 * 續辦完成的那一筆交易（呼叫端：auth-instance 的 `hooks.after`，內部 `check-verification-otp` 成功時）。
 *
 * check 端點只負責「算錯誤次數、擋限速」；**真正的判斷在這筆交易裡重做一次**：
 * 拿同一個 Email 的鎖、鎖使用者列重驗謂詞、鎖驗證碼那一列並用提交的碼重算雜湊比對，
 * 再要求暫存列綁的是**同一個**碼（`otpHash`）與**同一張**續辦票（`ticketHash`）。
 * 所以 check 通過之後才被另一個續辦換掉的碼與密碼（Review 反例）、或別人開始的續辦，都套用不到。
 * 全部成立才消耗兩列、標已驗證、換密碼、刪掉這個人全部 session；任何一步不成立整筆 rollback。
 */
export async function finishSignupResume(
  db: Pool,
  input: { email: string; otp: string; ticket: string },
  now: Date = new Date(),
): Promise<{ ok: true; userId: string; sessionsDeleted: number } | { ok: false; reason: SignupResumeFailure }> {
  const normalized = normalizeEmail(input.email)
  const tx = await db.connect()
  try {
    await tx.query('begin')
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [lockKey(normalized)])
    const user = await tx.query<{ id: string }>('select id from users where email = $1 for update', [normalized])
    const userId = user.rows[0]?.id
    if (!userId || !(await isResumableSignup(tx, userId))) {
      await tx.query('rollback')
      return { ok: false, reason: 'not_resumable' }
    }

    const otpHash = await currentOtpHash(tx, normalized, true)
    const pending = await tx.query<{ value: string; expires_at: Date }>(
      'select value, expires_at from verifications where identifier = $1 for update',
      [signupResumeIdentifier(normalized)],
    )
    const row = pending.rows[0]
    const parsed = row && new Date(row.expires_at).getTime() > now.getTime() ? parsePending(row.value) : null
    if (
      !otpHash ||
      !parsed ||
      parsed.userId !== userId ||
      hashSecret(input.otp) !== otpHash ||
      parsed.otpHash !== otpHash ||
      parsed.ticketHash !== hashSecret(input.ticket)
    ) {
      await tx.query('rollback')
      return { ok: false, reason: 'expired' }
    }

    await tx.query('delete from verifications where identifier in ($1, $2)', [
      emailOtpIdentifier(normalized),
      signupResumeIdentifier(normalized),
    ])
    await tx.query('update users set email_verified = true, updated_at = $2 where id = $1', [userId, now])
    const updated = await tx.query(
      `update accounts set password = $2, updated_at = $3 where user_id = $1 and provider_id = 'credential'`,
      [userId, parsed.passwordHash, now],
    )
    if (updated.rowCount !== 1) {
      await tx.query('rollback')
      return { ok: false, reason: 'not_resumable' }
    }
    const sessions = await tx.query('delete from sessions where user_id = $1', [userId])
    await tx.query('commit')
    return { ok: true, userId, sessionsDeleted: sessions.rowCount ?? 0 }
  } catch (error) {
    await tx.query('rollback').catch(() => undefined)
    throw error
  } finally {
    tx.release()
  }
}

type PendingResume = { userId: string; passwordHash: string; otpHash: string; ticketHash: string }

function parsePending(value: string): PendingResume | null {
  try {
    const parsed = JSON.parse(value) as Partial<Record<keyof PendingResume, unknown>>
    const { userId, passwordHash, otpHash, ticketHash } = parsed
    if (typeof userId !== 'string' || typeof passwordHash !== 'string' || !passwordHash) return null
    if (typeof otpHash !== 'string' || !otpHash || typeof ticketHash !== 'string' || !ticketHash) return null
    return { userId, passwordHash, otpHash, ticketHash }
  } catch {
    return null
  }
}

// ── 這一次寄碼／驗碼是哪一種內部用途（給 `hooks.before`／`hooks.after` 辨識） ──────────────

/**
 * 內部入口的用途。跟 `internal-call.ts` 的 marker 同一個道理用 AsyncLocalStorage：HTTP 請求帶不進來、偽造不了。
 * hook 一定要**同時**看到 `isInternalCall()` 才採信這裡的內容。
 *
 * - `signup-first`：註冊成功後伺服器自己寄的第一封（auth-instance 的 `hooks.after`）。Turnstile 與額度都已在註冊那一步處理。
 * - `signup-resume-start`：續辦的寄碼。同一次 wrapper 呼叫裡的註冊已經過 Turnstile、也已扣過寄碼額度，
 *   不要第二個 token、不重扣額度（仍檢查冷卻與 IP 上限）。
 * - `signup-resume-finish`：續辦的驗碼；驗過之後由 `hooks.after` 做 `finishSignupResume` 並發新 session。
 * - `account-verify`：已登入的人在「我的帳號」驗證自己的 Email（VB-5）。hook 要求本人 fresh session、
 *   Email 必須是 session 本人的登入 Email，不掛 Turnstile（限速照扣）。
 */
export type OtpCallPurpose = 'signup-first' | 'signup-resume-start' | 'signup-resume-finish' | 'account-verify'

type OtpCallContext = { readonly purpose: OtpCallPurpose; readonly email: string; readonly ticket?: string }

const purposeStorage = new AsyncLocalStorage<OtpCallContext>()

/** `ticket` 只有 `signup-resume-finish` 用：續辦開始時發給呼叫端的票，完成時要原樣帶回來。 */
export function runWithOtpPurpose<T>(
  purpose: OtpCallPurpose,
  email: string,
  fn: () => Promise<T>,
  ticket?: string,
): Promise<T> {
  return purposeStorage.run({ purpose, email: normalizeEmail(email), ...(ticket ? { ticket } : {}) }, fn)
}

export function currentOtpPurpose(): OtpCallContext | undefined {
  return purposeStorage.getStore()
}
