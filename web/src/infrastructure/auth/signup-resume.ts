import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
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
 * 2. 可以 → 對該 Email 寄一封驗證碼（內部入口，同一次註冊已驗過 Turnstile），新密碼的雜湊暫存在
 *    `verifications` 一列（10 分鐘），**不換密碼、不動 session**。
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

/** 暫存新密碼雜湊（同一個 Email 只留最新一列；10 分鐘到期）。 */
export async function savePendingPassword(
  db: Pool,
  input: { userId: string; email: string; passwordHash: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date()
  const identifier = signupResumeIdentifier(input.email)
  const value = JSON.stringify({ userId: input.userId, passwordHash: input.passwordHash })
  const tx = await db.connect()
  try {
    await tx.query('begin')
    await tx.query('delete from verifications where identifier = $1', [identifier])
    await tx.query(
      `insert into verifications (id, identifier, value, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $5)`,
      [uuidv7(), identifier, value, new Date(now.getTime() + SIGNUP_RESUME_TTL_SECONDS * 1000), now],
    )
    await tx.query('commit')
  } catch (error) {
    await tx.query('rollback').catch(() => undefined)
    throw error
  } finally {
    tx.release()
  }
}

export type SignupResumeFailure = 'not_resumable' | 'expired'

/**
 * 驗證碼已經對過之後的那一筆交易（呼叫端：auth-instance 的 `hooks.after`，`check-verification-otp` 成功時）。
 *
 * 鎖住使用者列、重驗謂詞，**刪掉**驗證碼那一列（`returning` 確保同一個碼只成功一次；兩個分頁同時送，第二個拿不到列就失敗）、
 * 刪掉暫存列並取出新密碼雜湊（過期的不算），再換密碼、標已驗證、刪掉這個人全部 session。
 * 任何一步不成立就整筆 rollback：不會出現「已驗證但還是舊密碼」的半套狀態。
 */
export async function finishSignupResume(
  db: Pool,
  email: string,
  now: Date = new Date(),
): Promise<{ ok: true; userId: string; sessionsDeleted: number } | { ok: false; reason: SignupResumeFailure }> {
  const normalized = normalizeEmail(email)
  const tx = await db.connect()
  try {
    await tx.query('begin')
    const user = await tx.query<{ id: string }>('select id from users where email = $1 for update', [normalized])
    const userId = user.rows[0]?.id
    if (!userId || !(await isResumableSignup(tx, userId))) {
      await tx.query('rollback')
      return { ok: false, reason: 'not_resumable' }
    }

    const otp = await tx.query('delete from verifications where identifier = $1 returning id', [emailOtpIdentifier(normalized)])
    const pending = await tx.query<{ value: string; expires_at: Date }>(
      'delete from verifications where identifier = $1 returning value, expires_at',
      [signupResumeIdentifier(normalized)],
    )
    const row = pending.rows[0]
    const parsed = row && new Date(row.expires_at).getTime() > now.getTime() ? parsePending(row.value) : null
    if (otp.rowCount === 0 || !parsed || parsed.userId !== userId) {
      await tx.query('rollback')
      return { ok: false, reason: 'expired' }
    }

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

function parsePending(value: string): { userId: string; passwordHash: string } | null {
  try {
    const parsed = JSON.parse(value) as { userId?: unknown; passwordHash?: unknown }
    if (typeof parsed.userId !== 'string' || typeof parsed.passwordHash !== 'string' || !parsed.passwordHash) return null
    return { userId: parsed.userId, passwordHash: parsed.passwordHash }
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
 * - `signup-resume-start`：續辦的寄碼。同一次 wrapper 呼叫裡的註冊已經過 Turnstile，不要第二個 token（限速照扣）。
 * - `signup-resume-finish`：續辦的驗碼；驗過之後由 `hooks.after` 做 `finishSignupResume` 並發新 session。
 * - `account-verify`：已登入的人在「我的帳號」驗證自己的 Email（VB-5）。hook 要求本人 fresh session、
 *   Email 必須是 session 本人的登入 Email，不掛 Turnstile（限速照扣）。
 */
export type OtpCallPurpose = 'signup-first' | 'signup-resume-start' | 'signup-resume-finish' | 'account-verify'

const purposeStorage = new AsyncLocalStorage<{ readonly purpose: OtpCallPurpose; readonly email: string }>()

export function runWithOtpPurpose<T>(purpose: OtpCallPurpose, email: string, fn: () => Promise<T>): Promise<T> {
  return purposeStorage.run({ purpose, email: normalizeEmail(email) }, fn)
}

export function currentOtpPurpose(): { readonly purpose: OtpCallPurpose; readonly email: string } | undefined {
  return purposeStorage.getStore()
}
