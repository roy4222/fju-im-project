import 'server-only'
import { uuidv7 } from 'uuidv7'
import {
  checkNewOwnPassword,
  normalizeContactFields,
  type ChangePasswordInput,
  type ChangePasswordOutcome,
  type ContactInput,
  type MyAccount,
  type SelfAccountCommand,
  type SelfAccountOutcome,
  type SetPasswordInput,
} from '@/application/accounts'
import type { ErrorCode } from '@/shared/errors'
import { isFullyActive, readAccountState, type AccountState } from '@/infrastructure/auth/account-state'
import { isFreshSession, readLoginMethods } from '@/infrastructure/auth/login-methods'
import {
  changeOwnPassword,
  getSessionFromHeaders,
  setOwnPassword,
  startGoogleLink,
} from '@/infrastructure/auth/wrapper'
import { getPool } from '@/infrastructure/db/client'

/**
 * 本人帳號（S01-05 改密碼；票 10 看自己的帳號、改聯絡資料、連結 Google、設定密碼）。
 *
 * **改密碼的業務規則不在這裡**：長度、不可與舊密碼相同、限速、撤其他裝置、清 must-change 旗標
 * 與稽核，全部在 Better Auth 的 hook 裡（`change-password-rules.ts`）——持有效 session 直接
 * `POST /api/auth/change-password` 也繞不過去（2026-09-16 review）。
 *
 * 連結 Google 的 active＋fresh 也由 hook 管（`/link-social` 在路由矩陣）；這裡先判一次
 * 只是為了給畫面一句看得懂的話。設定密碼的 `/set-password` 對外封鎖、只能從這裡進，
 * 所以它的 active、fresh、長度、「還沒有密碼」**只在這裡判**。
 */

type Session = NonNullable<Awaited<ReturnType<typeof getSessionFromHeaders>>>

type Signed =
  | { ok: true; session: Session; userId: string; state: AccountState }
  | { ok: false; code: ErrorCode; message: string }

const NOT_SIGNED_IN = { ok: false as const, code: 'UNAUTHENTICATED' as const, message: '請先登入。' }

async function signedIn(headers: Headers): Promise<Signed> {
  let session: Awaited<ReturnType<typeof getSessionFromHeaders>> = null
  try {
    session = await getSessionFromHeaders(headers)
  } catch {
    // `/get-session` 被狀態矩陣擋下（停用、去識別化）＝沒有有效登入。
    return NOT_SIGNED_IN
  }
  if (!session?.user?.id) return NOT_SIGNED_IN
  const userId = String(session.user.id)
  const state = await readAccountState(userId)
  if (!state || (state.status !== 'active' && state.status !== 'pending')) return NOT_SIGNED_IN
  return { ok: true, session, userId, state }
}

/** 只給「已開通、不在強制改密」的人（連結、設密碼、改聯絡資料）。 */
function activeOnly(state: AccountState): { ok: false; code: ErrorCode; message: string } | null {
  if (isFullyActive(state)) return null
  if (state.mustChangePassword) return { ok: false, code: 'PASSWORD_CHANGE_REQUIRED', message: '請先更改密碼。' }
  return { ok: false, code: 'ACCOUNT_PENDING', message: '帳號還在等待審核。' }
}

const FRESH_REQUIRED = {
  ok: false as const,
  code: 'FRESH_SESSION_REQUIRED' as const,
  message: '為了確認是你本人，請先重新登入，再回來做這一步。',
}

function apiErrorCode(error: unknown): string | undefined {
  const body = (error as { body?: { code?: unknown } })?.body
  return typeof body?.code === 'string' ? body.code : undefined
}

export class BetterAuthSelfAccountCommand implements SelfAccountCommand {
  async changePassword(headers: Headers, input: ChangePasswordInput): Promise<ChangePasswordOutcome> {
    const me = await signedIn(headers)
    if (!me.ok) return me

    try {
      await changeOwnPassword(headers, input)
      return { ok: true }
    } catch (error) {
      return translateChangePassword(error)
    }
  }

  async viewMine(headers: Headers): Promise<MyAccount | null> {
    const me = await signedIn(headers)
    if (!me.ok) return null

    const db = getPool()
    const user = await db.query<{ email: string; name: string }>('select email, name from users where id = $1', [me.userId])
    const profile = await db.query<{
      display_name: string
      student_no: string | null
      department_class: string | null
      cohort_name: string | null
      phone: string | null
      contact_email: string
      revision: number
    }>(
      `select p.display_name, p.student_no, p.department_class, c.name as cohort_name,
              p.phone, p.contact_email, p.revision
         from user_profiles p
         left join cohorts c on c.id = p.cohort_id
        where p.user_id = $1`,
      [me.userId],
    )
    const row = profile.rows[0]
    return {
      userId: me.userId,
      status: me.state.status,
      loginEmail: user.rows[0]?.email ?? '',
      name: user.rows[0]?.name ?? '',
      profile: row
        ? {
            displayName: row.display_name,
            studentNo: row.student_no,
            departmentClass: row.department_class,
            cohortName: row.cohort_name,
            phone: row.phone,
            contactEmail: row.contact_email,
            revision: row.revision,
          }
        : null,
      loginMethods: await readLoginMethods(me.userId),
      sessionFresh: isFreshSession(me.session.session.createdAt),
    }
  }

  async updateContact(headers: Headers, input: ContactInput): Promise<SelfAccountOutcome<{ revision: number }>> {
    const me = await signedIn(headers)
    if (!me.ok) return me
    const blocked = activeOnly(me.state)
    if (blocked) return blocked
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return { ok: false, code: 'VALIDATION_FAILED', message: '頁面資料不完整，請重新整理後再試。' }
    }
    const normalized = normalizeContactFields(input)
    if (!normalized.ok) {
      const field = typeof normalized.details?.field === 'string' ? normalized.details.field : undefined
      return { ok: false, code: 'VALIDATION_FAILED', message: normalized.message, ...(field ? { field } : {}) }
    }
    const { phone, contactEmail } = normalized.value

    const tx = await getPool().connect()
    try {
      await tx.query('begin')
      const before = await tx.query<{ phone: string | null; contact_email: string; revision: number }>(
        'select phone, contact_email, revision from user_profiles where user_id = $1 for update',
        [me.userId],
      )
      const current = before.rows[0]
      if (!current) {
        await tx.query('rollback')
        return { ok: false, code: 'FORBIDDEN', message: '你的基本資料還沒建立，請聯絡系辦。' }
      }
      if (current.revision !== input.expectedRevision) {
        await tx.query('rollback')
        return { ok: false, code: 'CONFLICT', message: '資料在別的地方改過了，請重新整理後再改一次。' }
      }
      const changed = [
        ...(current.phone !== phone ? ['phone'] : []),
        ...(current.contact_email !== contactEmail ? ['contactEmail'] : []),
      ]
      if (changed.length === 0) {
        await tx.query('rollback')
        return { ok: true, revision: current.revision }
      }
      const updated = await tx.query<{ revision: number }>(
        `update user_profiles
            set phone = $2, contact_email = $3, revision = revision + 1, updated_at = now(), updated_by_user_id = $1
          where user_id = $1
        returning revision`,
        [me.userId, phone, contactEmail],
      )
      const revision = updated.rows[0]!.revision
      // 稽核只記「改了哪幾欄」與版本，不記手機與 Email 本身（個資最小化，契約 03 §4）。
      await tx.query(
        `insert into audit_events
           (id, actor_kind, actor_user_id, action, target_type, target_id, scope, real_at, business_at, payload)
         values ($1, 'user', $2, 'account.update_contact', 'user', $2, 'global', now(), now(), $3::jsonb)`,
        [uuidv7(), me.userId, JSON.stringify({ changed, revision })],
      )
      await tx.query('commit')
      return { ok: true, revision }
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }

  async startGoogleLink(headers: Headers): Promise<SelfAccountOutcome<{ url: string }>> {
    const me = await signedIn(headers)
    if (!me.ok) return me
    const blocked = activeOnly(me.state)
    if (blocked) return blocked
    if ((await readLoginMethods(me.userId)).google) {
      return { ok: false, code: 'VALIDATION_FAILED', message: '這個帳號已經連結 Google 了。' }
    }
    if (!isFreshSession(me.session.session.createdAt)) return FRESH_REQUIRED

    try {
      const started = await startGoogleLink(headers, {
        callbackURL: '/account?linked=google',
        errorCallbackURL: '/account',
      })
      if (!started.url) return { ok: false, code: 'INTERNAL', message: 'Google 連結暫時無法使用，請稍後再試。' }
      return { ok: true, url: started.url }
    } catch (error) {
      // hook 在這之間又判一次（例如剛好跨過 10 分鐘）。
      if (apiErrorCode(error) === 'FRESH_SESSION_REQUIRED') return FRESH_REQUIRED
      console.error('[account] 開始連結 Google 失敗', error)
      return { ok: false, code: 'INTERNAL', message: 'Google 連結暫時無法使用，請稍後再試。' }
    }
  }

  async setPassword(headers: Headers, input: SetPasswordInput): Promise<SelfAccountOutcome> {
    const me = await signedIn(headers)
    if (!me.ok) return me
    const blocked = activeOnly(me.state)
    if (blocked) return blocked
    if ((await readLoginMethods(me.userId)).password) {
      return { ok: false, code: 'VALIDATION_FAILED', message: '這個帳號已經有密碼了；要換密碼請用「更改密碼」。' }
    }
    if (!isFreshSession(me.session.session.createdAt)) return FRESH_REQUIRED
    const problem = checkNewOwnPassword(input)
    if (problem) return { ok: false, code: 'VALIDATION_FAILED', message: problem.message, field: problem.field }

    try {
      await setOwnPassword(headers, { newPassword: input.newPassword })
      return { ok: true }
    } catch (error) {
      if (apiErrorCode(error) === 'PASSWORD_ALREADY_SET') {
        return { ok: false, code: 'VALIDATION_FAILED', message: '這個帳號已經有密碼了；要換密碼請用「更改密碼」。' }
      }
      console.error('[account] 設定密碼失敗', error)
      return { ok: false, code: 'INTERNAL', message: '設定密碼沒有成功，請稍後再試。' }
    }
  }
}

/** 把 hook 或套件丟出來的改密錯誤翻成畫面看得懂的結果。 */
function translateChangePassword(error: unknown): ChangePasswordOutcome {
  const status = (error as { status?: string; statusCode?: number })?.status
  const message = (error as { body?: { message?: string } })?.body?.message

  if (status === 'TOO_MANY_REQUESTS') {
    return { ok: false, code: 'VALIDATION_FAILED', message: message ?? '改密碼的次數太多，請稍後再試。' }
  }
  if (status === 'BAD_REQUEST' && message) {
    // 規則類的訊息（長度、與舊密碼相同）由 hook 給，直接照用。
    return { ok: false, code: 'VALIDATION_FAILED', message }
  }
  if (status === 'UNAUTHORIZED') {
    return { ok: false, code: 'UNAUTHENTICATED', message: '請重新登入。' }
  }
  // 其餘（含舊密碼錯）一律同一句：分辨得太細就變成一個可以拿來試密碼的通道。
  return { ok: false, code: 'VALIDATION_FAILED', message: '目前的密碼不正確。' }
}
