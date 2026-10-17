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
 *    一張續辦票（給發起的瀏覽器）、這封碼的 10 分鐘視窗、絕對截止（票建立起 30 分鐘）暫存在 `verifications` 一列，
 *    **不換密碼、不動 session**。視窗過了但還沒到截止，續辦頁的重寄照常寄新碼並把視窗重開（不超過截止；主腦裁定）；
 *    過了截止一律「續辦已逾時，請重新開始」。
 * 3. 填對驗證碼 → 一筆交易內：`email_verified = true`、credential 密碼換成暫存的新雜湊、刪掉這個人全部舊 session
 *    （先前不知道是誰建的帳號，之前的登入一律作廢），之後才發新 session。
 *
 * 不可以續辦的（老師、已核准學生、停用、已送申請、有 Google 登入方式、有任何業務紀錄）一律照舊回既有句、不寄信。
 * 「可續辦」只有一個謂詞，VB-14（半成品帳號 7 天清密碼）也用同一個。
 */

type Queryable = Pick<Pool, 'query'> | PoolClient

/**
 * 一封驗證碼的視窗秒數（跟套件的 `expiresIn` 同樣 10 分鐘）：暫存列的 `windowEndAt`。續辦開始與每次重寄改綁都設成
 * 「現在＋10 分鐘」，但不超過絕對截止；完成要在視窗內。
 */
export const SIGNUP_RESUME_TTL_SECONDS = 600

/**
 * 續辦的絕對上限（VB-3 Review 第 2 輪；主腦裁定）：從續辦開始（票建立）起 30 分鐘，不可延長。
 * 存在暫存列的 `deadlineAt`（不由 client 帶）；每次重寄的視窗取 `min(現在＋10 分鐘, 截止)`，重寄與完成都檢查截止。
 * 沒有這一條時，同一張票每 181 秒重寄一次（固定視窗額度一直重開）就能無限延長暫存（Review 第 2 輪反例）。
 */
export const SIGNUP_RESUME_MAX_SECONDS = 1800

/** 這一輪的視窗：現在＋10 分鐘，但不超過絕對截止（epoch 毫秒）。 */
function windowEndAt(now: Date, deadlineAt: number): number {
  return Math.min(now.getTime() + SIGNUP_RESUME_TTL_SECONDS * 1000, deadlineAt)
}

/**
 * 暫存列的 `expires_at`：**不是**視窗，只是列的壽命——截止再多 10 分鐘。
 * 套件的 `findVerificationValue`（`better-auth/dist/db/internal-adapter.mjs`）每次都順手刪掉**所有** `expires_at < now`
 * 的列，不分 identifier，任何人查碼都會觸發；視窗若存在 `expires_at`，視窗一過列就可能被別人的查碼刪掉，截止內的
 * 重寄復活就不確定了。多留 10 分鐘是因為續辦票的 cookie（`RESUME_MAX_AGE`）最多在最後一次寄出後 10 分鐘內還帶得回來，
 * 列要撐到那時候，持票的人才一定看到「續辦已逾時」而不是靜默的「已寄出」。壽命內每條路都另外看 `windowEndAt` 與 `deadlineAt`。
 */
function rowExpiresAt(deadlineAt: number): Date {
  return new Date(deadlineAt + SIGNUP_RESUME_TTL_SECONDS * 1000)
}

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
 *   排隊）、重驗這個帳號還能續辦、鎖並讀**此刻最新那封**驗證碼的雜湊，連同新密碼雜湊、續辦票、這封碼的視窗
 *   （此刻＋10 分鐘）、絕對截止（此刻＋30 分鐘）寫成一列（列活到截止再多 10 分鐘，見 `rowExpiresAt`）。
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
    const deadlineAt = now.getTime() + SIGNUP_RESUME_MAX_SECONDS * 1000
    const pending: PendingResume = {
      userId: input.userId,
      passwordHash,
      otpHash,
      ticketHash: hashSecret(ticket),
      deadlineAt,
      windowEndAt: windowEndAt(now, deadlineAt),
    }
    await tx.query('delete from verifications where identifier = $1', [identifier])
    await tx.query(
      `insert into verifications (id, identifier, value, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $5)`,
      [uuidv7(), identifier, JSON.stringify(pending), rowExpiresAt(deadlineAt), now],
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

export type SignupResumeTicketStatus = 'valid' | 'timed_out' | 'invalid'

/**
 * 續辦票的狀態（續辦頁的重寄驗證碼用，寄信**之前**先看；VB-3 Review 第 1 輪 P3、第 2 輪、主腦裁定）。只讀、不鎖：
 * 寄出之後的 `rebindSignupResumeOtp` 會在鎖裡再驗一次。
 * - `valid`：票對、截止內、帳號還能續辦 → 寄。**不看 10 分鐘視窗**：視窗過了但截止內，重寄就是把視窗重開（主腦裁定）。
 * - `invalid`：票錯、帳號已不能續辦、列已過壽命 → 呼叫端不寄信，回應跟寄出一樣（不透露原因）。
 * - `timed_out`：票對、但已過絕對截止（票建立起 30 分鐘）→ 不寄信，回「續辦已逾時，請重新開始」。只有持票的人看得到
 *   這一句，而他本來就知道這個帳號在續辦；票不對的人一律 `invalid`，所以多這一句不會多洩漏帳號狀態。
 */
export async function checkSignupResumeTicket(
  db: Queryable,
  input: { email: string; ticket: string },
  now: Date = new Date(),
): Promise<SignupResumeTicketStatus> {
  const email = normalizeEmail(input.email)
  const userId = await findUserIdByEmail(db, email)
  if (!userId || !input.ticket) return 'invalid'
  const row = await db.query<{ value: string; expires_at: Date }>(
    'select value, expires_at from verifications where identifier = $1',
    [signupResumeIdentifier(email)],
  )
  const pending = row.rows[0]
  const parsed = pending ? parsePending(pending.value) : null
  if (!pending || !parsed || parsed.userId !== userId || parsed.ticketHash !== hashSecret(input.ticket)) return 'invalid'
  if (now.getTime() >= parsed.deadlineAt) return 'timed_out'
  // 列的壽命（截止＋10 分鐘）照理不會比截止早過；萬一列被改過就 fail closed。
  if (new Date(pending.expires_at).getTime() <= now.getTime()) return 'invalid'
  return (await isResumableSignup(db, userId)) ? 'valid' : 'invalid'
}

/**
 * 續辦重寄的改綁（VB-3 Review 第 1 輪 P3）：新的驗證碼**已經寄出**之後，把暫存列綁的碼換成此刻最新那封。
 *
 * 跟 `startSignupResume` 的綁定、`finishSignupResume` 同一把交易級 advisory lock；交易裡重驗：帳號還能續辦、
 * 列還在壽命內、userId 與續辦票都對、還沒過絕對截止。全部成立才改 `otpHash`（密碼雜湊、票不動），舊碼從此對不上
 * （完成時要求提交的碼＝最新那列＝暫存綁的碼）。視窗重設成「現在＋10 分鐘」但**不超過列上的絕對截止**（票建立起
 * 30 分鐘；Review 第 2 輪：限速是固定視窗，光靠它每 181 秒一次就能無限延長）。**不看舊視窗有沒有過**：視窗過了、
 * 截止內的重寄就是要把它重開（主腦裁定）。已過截止回 `timed_out`、不改任何東西。
 * 寄信失敗時呼叫端不會走到這裡（改走 `restoreSignupResumeOtp`）。
 */
export async function rebindSignupResumeOtp(
  db: Pool,
  input: { email: string; ticket: string },
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; reason: SignupResumeFailure }> {
  const email = normalizeEmail(input.email)
  const tx = await db.connect()
  try {
    await tx.query('begin')
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [lockKey(email)])
    const user = await tx.query<{ id: string }>('select id from users where email = $1 for update', [email])
    const userId = user.rows[0]?.id
    if (!userId || !(await isResumableSignup(tx, userId))) {
      await tx.query('rollback')
      return { ok: false, reason: 'not_resumable' }
    }
    const pending = await tx.query<{ value: string; expires_at: Date }>(
      'select value, expires_at from verifications where identifier = $1 for update',
      [signupResumeIdentifier(email)],
    )
    const row = pending.rows[0]
    const parsed = row ? parsePending(row.value) : null
    const otpHash = await currentOtpHash(tx, email, true)
    if (!row || !parsed || parsed.userId !== userId || parsed.ticketHash !== hashSecret(input.ticket) || !otpHash) {
      await tx.query('rollback')
      return { ok: false, reason: 'expired' }
    }
    if (now.getTime() >= parsed.deadlineAt) {
      await tx.query('rollback')
      return { ok: false, reason: 'timed_out' }
    }
    if (new Date(row.expires_at).getTime() <= now.getTime()) {
      await tx.query('rollback')
      return { ok: false, reason: 'expired' }
    }
    const rebound: PendingResume = { ...parsed, otpHash, windowEndAt: windowEndAt(now, parsed.deadlineAt) }
    await tx.query('update verifications set value = $2, expires_at = $3, updated_at = $4 where identifier = $1', [
      signupResumeIdentifier(email),
      JSON.stringify(rebound),
      rowExpiresAt(parsed.deadlineAt),
      now,
    ])
    await tx.query('commit')
    return { ok: true }
  } catch (error) {
    await tx.query('rollback').catch(() => undefined)
    throw error
  } finally {
    tx.release()
  }
}

/**
 * `timed_out` 只有改綁與票檢查會回（已過絕對截止）；完成交易逾時仍回 `expired`——auth-instance 的 `hooks.after`
 * 只把 `expired` 翻成 `SIGNUP_RESUME_EXPIRED`（訊息已含「逾時…請回第 1 步」），其他都翻成 `EMAIL_UNAVAILABLE`。
 */
export type SignupResumeFailure = 'not_resumable' | 'expired' | 'timed_out'

/**
 * 續辦重寄**寄失敗**後的還原（VB-3 Review 第 2 輪）。
 *
 * 套件的寄碼端點在呼叫寄信回呼**之前**就插了一列新碼（`plugins/email-otp/routes.mjs` 的 `resolveOTP`：再插一列、不刪舊列），
 * 而 check 端點只認最新那列——信沒寄出卻把那列留著，使用者手上那封的碼在套件那一層就會被當成不是最新
 * （r2 反例的「舊碼失效、新碼沒送到」）。所以在同一把鎖裡：暫存列還是這張票的 → 刪掉比暫存綁的那列**更新**的驗證碼列
 * （就是沒寄出的那封），綁定列的密碼、票、碼、期限都不動。暫存列已不是這張票的（別人剛改綁）或綁的那列已不在
 * （錯太多次被套件刪掉）→ 什麼都不做。
 * 綁的那列已被套件順手清掉（視窗過了才重寄、又剛好寄失敗）→ 子查詢是 NULL、一列都不刪：沒寄出的那列留著也沒人有它的碼，
 * 下一次重寄成功會改綁到更新的那列。
 * 兩個人同時對同一個 Email 操作而剛好一邊寄失敗：可能把另一邊剛寄出、還沒綁定的那列一起撤掉，對方完成時會拿到
 * 「已失效」重新開始；不會讓任何人用自己沒有的碼完成。
 */
export async function restoreSignupResumeOtp(db: Pool, input: { email: string; ticket: string }): Promise<{ removed: number }> {
  const email = normalizeEmail(input.email)
  const tx = await db.connect()
  try {
    await tx.query('begin')
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [lockKey(email)])
    const pending = await tx.query<{ value: string }>('select value from verifications where identifier = $1 for update', [
      signupResumeIdentifier(email),
    ])
    const parsed = pending.rows[0] ? parsePending(pending.rows[0].value) : null
    if (!parsed || parsed.ticketHash !== hashSecret(input.ticket)) {
      await tx.query('rollback')
      return { removed: 0 }
    }
    // 驗證碼列的 value 是 `<雜湊>:<錯誤次數>`，雜湊是 base64url（沒有冒號）。
    const removed = await tx.query(
      `delete from verifications
        where identifier = $1
          and split_part(value, ':', 1) <> $2
          and created_at >= (select min(created_at) from verifications where identifier = $1 and split_part(value, ':', 1) = $2)`,
      [emailOtpIdentifier(email), parsed.otpHash],
    )
    await tx.query('commit')
    return { removed: removed.rowCount ?? 0 }
  } catch (error) {
    await tx.query('rollback').catch(() => undefined)
    throw error
  } finally {
    tx.release()
  }
}

/**
 * 續辦完成的那一筆交易（呼叫端：auth-instance 的 `hooks.after`，內部 `check-verification-otp` 成功時）。
 *
 * check 端點只負責「算錯誤次數、擋限速」；**真正的判斷在這筆交易裡重做一次**：
 * 拿同一個 Email 的鎖、鎖使用者列重驗謂詞、鎖驗證碼那一列並用提交的碼重算雜湊比對，
 * 再要求暫存列綁的是**同一個**碼（`otpHash`）與**同一張**續辦票（`ticketHash`），而且還在這封碼的視窗內
 * （`windowEndAt`）、還沒過列上的絕對截止（`deadlineAt`）；`expires_at` 只是列的壽命，過了也擋（fail closed）。
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
      now.getTime() >= parsed.windowEndAt ||
      now.getTime() >= parsed.deadlineAt ||
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

/**
 * 暫存列的內容。`deadlineAt`：絕對截止（epoch 毫秒），票建立時寫入、之後不動；`windowEndAt`：目前這封碼的視窗
 * （epoch 毫秒），開始與每次重寄改綁時重設、不超過截止。少任一欄或不是正數的列一律當無效（fail closed）。
 */
type PendingResume = {
  userId: string
  passwordHash: string
  otpHash: string
  ticketHash: string
  deadlineAt: number
  windowEndAt: number
}

function parsePending(value: string): PendingResume | null {
  try {
    const parsed = JSON.parse(value) as Partial<Record<keyof PendingResume, unknown>>
    const { userId, passwordHash, otpHash, ticketHash, deadlineAt, windowEndAt } = parsed
    if (typeof userId !== 'string' || typeof passwordHash !== 'string' || !passwordHash) return null
    if (typeof otpHash !== 'string' || !otpHash || typeof ticketHash !== 'string' || !ticketHash) return null
    if (typeof deadlineAt !== 'number' || !Number.isFinite(deadlineAt) || deadlineAt <= 0) return null
    if (typeof windowEndAt !== 'number' || !Number.isFinite(windowEndAt) || windowEndAt <= 0) return null
    return { userId, passwordHash, otpHash, ticketHash, deadlineAt, windowEndAt }
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
 * - `signup-resume-resend`：續辦頁的重寄（VB-3 Review 第 2 輪）。hook **不認得這個用途，就照公開重寄處理**：要這一次的
 *   Turnstile token、冷卻、每 Email 與每 IP 桶都照扣（沒有旁路、不重設計數）；而寄信回呼看到「內部呼叫＋有用途」就會
 *   **等寄送結果**並回報失敗（`hooks.after` 翻成 `MAIL_FAILED`），wrapper 才能在寄失敗時不改綁。公開路徑刻意不等結果
 *   （防帳號列舉），續辦重寄不需要：走得到這裡的人持有這個帳號的續辦票。
 * - `account-verify`：已登入的人在「我的帳號」驗證自己的 Email（VB-5）。hook 要求本人 fresh session、
 *   Email 必須是 session 本人的登入 Email，不掛 Turnstile（限速照扣）。
 */
export type OtpCallPurpose =
  | 'signup-first'
  | 'signup-resume-start'
  | 'signup-resume-finish'
  | 'signup-resume-resend'
  | 'account-verify'

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
