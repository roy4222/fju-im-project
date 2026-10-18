import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import {
  APPLY_EMAIL_UNVERIFIED_MESSAGE,
  applyDenial,
  autoApprovalEligible,
  BULK_APPROVAL_MAX,
  BULK_APPROVAL_SKIP_LABEL,
  bulkApprovalSkip,
  evidenceFlags,
  matchRoster,
  normalizeApplicationFields,
  normalizeApproval,
  normalizeName,
  normalizeRegistrationInput,
  normalizeRejection,
  ownApplicationDenied,
  resolveApprovalCohort,
  reviewAccessDenied,
  suggestedApprovalCohort,
  type ApplicationFields,
  type BulkApprovalPreview,
  type BulkApprovalReceipt,
  type BulkApprovalSkip,
  type CohortChoice,
  type DecisionReceipt,
  type DuplicateInfo,
  type MyApplication,
  type PendingApplication,
  type PendingList,
  type RateLimited,
  type RegistrationCommand,
  type RegistrationInput,
  type RegistrationReceipt,
  type ResolvedActor,
  type RevisionReceipt,
  type RosterCandidate,
  type RosterMatch,
} from '@/application/accounts'
import { isRequestId, type CohortStatusQuery } from '@/application/cohorts'
import { registrationResultMail, type Mailer, type RegistrationOutcome } from '@/application/mail'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import { defaultNextStep, type ErrorCode } from '@/shared/errors'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RATE_LIMITS, sharedRateLimiter } from '@/shared/rate-limit'
import { RealClock, type Clock } from '@/shared/time'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { bustIdentity } from '@/infrastructure/auth/identity-cache'
import { signUpWithPassword } from '@/infrastructure/auth/wrapper'
import { occupyStudentNo, studentNoHolder } from '@/infrastructure/accounts/student-identities'
import { EMAIL_UNAVAILABLE_CODE } from '@/infrastructure/auth/login-methods'

/**
 * 學生註冊與審核（工程模組 01 §3 狀態表、§5 `RegistrationCommand`、§6 核准交易；票 7）。
 *
 * 每個方法第一件事都是授權（`reviewAccessDenied`／`ownApplicationDenied`，規則在 application 層），
 * 第二件事是驗證輸入；之後才碰資料庫。全程用 `fju_app` 的權限就做得完（整合測試以 `fju_app` 跑）。
 *
 * **註冊為什麼分兩步**：帳號（`users`＋密碼）由 Better Auth 建，它只存自己宣告過的欄位，
 * 學號、手機、系級放不進去；而本票不能加 migration。所以先請套件建帳號（受限 session），
 * 再用自己的交易寫申請單＋第 1 版快照＋稽核。第二步萬一失敗，帳號是一個「待審、沒有申請單」的人——
 * 他登入後被帶到第 3 步「填學生資料」，補送一次就回到正軌（`reviseMine` 的 `none` 分支）。
 * 直接打 `POST /api/auth/sign-up/email` 註冊的人也走同一條補送路。
 *
 * **Q42 自動開通**（VB-6）：Google 來的人第一次送申請、Email＋學號＋姓名命中開放註冊屆別名單的同一列、
 * 學號沒人用時，同一筆交易直接核准（`#autoApprove`）。操作者是系統，不寄「帳號已開通」信（畫面直接告訴他）。
 */

export type AccountCreation =
  | { readonly ok: true; readonly userId: string }
  | {
      readonly ok: false
      readonly reason: 'rate_limited' | 'email_taken' | 'invalid' | 'turnstile' | 'turnstile_unavailable' | 'mail_failed'
      readonly message?: string
    }

/** 建帳號的那一步（預設是 Better Auth；測試可以換掉）。 */
export type AccountCreator = (
  input: { email: string; password: string; name: string },
  clientIp: string,
) => Promise<AccountCreation>

export const betterAuthAccountCreator: AccountCreator = async (input, clientIp) => {
  try {
    const created = await signUpWithPassword(input, new Headers({ 'x-real-ip': clientIp }))
    return { ok: true, userId: String(created.user.id) }
  } catch (error) {
    const e = error as { status?: string; body?: { code?: string; message?: string } }
    if (e?.status === 'TOO_MANY_REQUESTS') return { ok: false, reason: 'rate_limited', message: e.body?.message }
    // VB-2：Turnstile 與註冊後的第一封驗證碼（hook 與 email-otp 外掛丟的）。
    if (e?.body?.code === 'TURNSTILE_REQUIRED') return { ok: false, reason: 'turnstile', message: e.body.message }
    if (e?.body?.code === 'TURNSTILE_UNAVAILABLE') return { ok: false, reason: 'turnstile_unavailable', message: e.body.message }
    if (e?.body?.code === 'MAIL_FAILED') return { ok: false, reason: 'mail_failed', message: e.body.message }
    // Better Auth 的 hook（after）已經把「Email 已被用過／格式不對」統一成 EMAIL_UNAVAILABLE（票 10）；
    // 套件原本的兩個代碼留著當保險。
    if (
      e?.body?.code === EMAIL_UNAVAILABLE_CODE ||
      e?.body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' ||
      e?.body?.code === 'USER_ALREADY_EXISTS'
    ) {
      return { ok: false, reason: 'email_taken' }
    }
    if (e?.status === 'BAD_REQUEST' || e?.status === 'UNPROCESSABLE_ENTITY') {
      return { ok: false, reason: 'invalid', message: e.body?.message }
    }
    throw error
  }
}

export type RegistrationCommandDeps = {
  readonly audit: AuditWriter<PoolClient>
  readonly ledger: OperationLedger<PoolClient>
  readonly db: () => Pool
  /** 模組 02 的屆別查詢（開放註冊屆別、屆別存在）。 */
  readonly cohorts: CohortStatusQuery
  readonly createAccount?: AccountCreator
  readonly clock?: Clock
  /**
   * 審核結果通知信（B 階段 VB-1，Q68）：核准／退回 commit 之後寄給申請人的登入 Email。
   * `siteUrl` 是信裡連結的根網址（同 `BETTER_AUTH_URL`）。沒注入就不寄（只有不在乎寄信的測試會這樣）。
   */
  readonly mail?: { readonly mailer: Mailer; readonly siteUrl: string }
}

/** Q42 自動開通寫進狀態流水、稽核與角色授予的理由。 */
const AUTO_APPROVE_REASON = 'Google Email 與名單相同，自動開通'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 待審清單一次最多列幾筆（一屆幾百人，不需要分頁）。 */
const PENDING_LIST_LIMIT = 500

/** 待審修改的限速（每人；頁面與直接呼叫用同一份，見 `sharedRateLimiter`）。 */
const reviseLimiter = sharedRateLimiter('registration-revise', RATE_LIMITS.reviseApplication)

/** 測試用：清掉修改申請的限速計數。 */
export function resetReviseLimiter(): void {
  reviseLimiter.clear()
}

function meta(now: Date, requestId = uuidv7()) {
  return { requestId, serverTime: now.toISOString() }
}

function denied(code: ErrorCode, forbidden = '只有系辦可以審核註冊。'): Err {
  const messages: Partial<Record<ErrorCode, string>> = {
    UNAUTHENTICATED: '請先登入。',
    FORBIDDEN: forbidden,
    PASSWORD_CHANGE_REQUIRED: '請先修改密碼。',
    ACCOUNT_PENDING: '帳號還在審核中。',
  }
  return err(code, messages[code] ?? '無法執行這個動作。', { next: defaultNextStep(code) })
}

type ApplicationRow = {
  id: string
  user_id: string
  revision: number
  applied_name: string
  student_no: string
  department_class: string | null
  phone: string
  contact_email: string
  login_email: string
  state: 'pending' | 'approved' | 'rejected'
  reason: string | null
  decided_real_at: Date | null
  created_at: Date
  updated_at: Date
}

const APPLICATION_COLUMNS = `ra.id, ra.user_id, ra.revision, ra.applied_name, ra.student_no, ra.department_class,
  ra.phone, ra.contact_email, ra.login_email, ra.state, ra.reason, ra.decided_real_at, ra.created_at, ra.updated_at`

function fieldsOf(row: ApplicationRow): ApplicationFields {
  return {
    appliedName: row.applied_name,
    studentNo: row.student_no,
    departmentClass: row.department_class ?? '',
    phone: row.phone,
    contactEmail: row.contact_email,
  }
}

/** 快照（`application_revisions.snapshot`）：當時的申請資料與比對結果。 */
function snapshotOf(fields: ApplicationFields, loginEmail: string, match: RosterMatch) {
  return { ...fields, loginEmail, rosterMatch: match }
}

type Queryable = Pick<Pool, 'query'> | PoolClient

type ApproveInput = Parameters<RegistrationCommand['approve']>[1]

export class PgRegistrationCommand implements RegistrationCommand {
  readonly #deps: RegistrationCommandDeps
  readonly #clock: Clock
  readonly #createAccount: AccountCreator

  constructor(deps: RegistrationCommandDeps) {
    this.#deps = deps
    this.#clock = deps.clock ?? new RealClock()
    this.#createAccount = deps.createAccount ?? betterAuthAccountCreator
  }

  // ── 註冊 ──────────────────────────────────────────────────────────────────

  async apply(
    actor: ResolvedActor,
    input: RegistrationInput,
    clientIp: string,
  ): Promise<Result<RegistrationReceipt> | RateLimited> {
    if (actor.kind === 'authenticated') {
      // VB-2：用密碼註冊、還沒完成 Email 驗證的人不能送申請（AC-VI-50）。驗證狀態回資料庫讀，不信 session 快照。
      const user = await this.#deps.db().query<{ email_verified: boolean }>(
        'select email_verified from users where id = $1',
        [actor.userId],
      )
      const denial = applyDenial({ emailVerified: user.rows[0]?.email_verified === true, loginMethod: actor.loginMethod })
      if (denial) return err('FORBIDDEN', denial)
      // 已經登入的人再註冊一次會變成第二個帳號；請他先登出。
      return err('FORBIDDEN', '你已經登入了；要註冊另一個帳號請先登出。')
    }

    const normalized = normalizeRegistrationInput(input)
    if (!normalized.ok) return normalized
    const fields = normalized.value

    const created = await this.#createAccount(
      { email: fields.loginEmail, password: fields.password, name: fields.appliedName },
      clientIp,
    )
    if (!created.ok) {
      if (created.reason === 'rate_limited') {
        const wait = waitAtMost(RATE_LIMITS.register.windowMs)
        return {
          ok: false,
          code: 'RATE_LIMITED',
          // hook 的訊息會說是哪一個桶（註冊次數或寄驗證碼次數）；沒有訊息時退回註冊那一句。
          message: created.message ?? `這個網路 ${wait}內的註冊次數已達上限，最晚 ${wait}後可以再試；仍無法註冊請聯絡系辦。`,
        }
      }
      if (created.reason === 'turnstile') return err('TURNSTILE_REQUIRED', created.message ?? '請完成人機驗證。')
      if (created.reason === 'turnstile_unavailable') {
        return err('TURNSTILE_UNAVAILABLE', created.message ?? '人機驗證暫時無法使用，請稍後再試。')
      }
      // 帳號已經建好、只是驗證信沒寄出去：同一個 Email 之後再註冊會進續辦（VB-2），所以只請他稍後再試。
      if (created.reason === 'mail_failed') return err('INTERNAL', created.message ?? '驗證信寄不出去，請稍後再試。')
      if (created.reason === 'email_taken') {
        // 統一訊息（工程模組 01 §3 `USER_EXISTS`）：不說這個 Email 是停用、待審還是正常帳號。
        return err('VALIDATION_FAILED', '這個 Email 無法用來註冊。如果你已經有帳號，請直接登入。', {
          details: { field: 'loginEmail' },
        })
      }
      return err('VALIDATION_FAILED', created.message ?? '註冊資料不正確，請檢查後再送出。')
    }

    const now = this.#clock.now()
    const application: ApplicationFields = {
      appliedName: fields.appliedName,
      studentNo: fields.studentNo,
      departmentClass: fields.departmentClass,
      phone: fields.phone,
      contactEmail: fields.contactEmail,
    }
    const tx = await this.#deps.db().connect()
    try {
      await tx.query('begin')
      await this.#insertApplication(tx, created.userId, application, fields.loginEmail, now, 'registration.apply')
      await tx.query('commit')
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      // 帳號已經建好（而且已經登入），只是申請單沒寫進去：不回錯誤，等待審核頁會請他補送一次。
      console.error('[registration] 申請單寫入失敗，帳號已建立、等本人補送', error)
    } finally {
      tx.release()
    }
    return ok({ userId: created.userId }, meta(now))
  }

  // ── 本人 ──────────────────────────────────────────────────────────────────

  async viewMine(actor: ResolvedActor): Promise<Result<MyApplication>> {
    const blocked = ownApplicationDenied(actor, 'registration.viewOwn')
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED', '帳號已經開通，沒有待審的申請。')

    const db = this.#deps.db()
    const user = await db.query<{ email: string; name: string }>('select email, name from users where id = $1', [actor.userId])
    const loginEmail = user.rows[0]?.email ?? ''
    const latest = await this.#latestApplication(db, actor.userId)

    let history: { revision: number; at: string }[] = []
    if (latest) {
      const revisions = await db.query<{ revision: number; created_at: Date }>(
        `select revision, created_at from application_revisions where application_id = $1 order by revision desc`,
        [latest.id],
      )
      history = revisions.rows.map((r) => ({ revision: r.revision, at: new Date(r.created_at).toISOString() }))
    }

    const state: MyApplication['state'] = !latest ? 'none' : latest.state === 'rejected' ? 'rejected' : 'pending'
    return ok(
      {
        loginEmail,
        accountName: user.rows[0]?.name ?? '',
        state,
        current: latest
          ? {
              ...fieldsOf(latest),
              applicationId: latest.id,
              revision: latest.revision,
              submittedAt: new Date(latest.created_at).toISOString(),
              updatedAt: new Date(latest.updated_at).toISOString(),
            }
          : null,
        rejection:
          latest?.state === 'rejected' && latest.reason
            ? { reason: latest.reason, decidedAt: new Date(latest.decided_real_at ?? latest.updated_at).toISOString() }
            : null,
        history,
      },
      meta(this.#clock.now()),
    )
  }

  async autoApprovedMine(actor: ResolvedActor): Promise<boolean> {
    if (actor.kind !== 'authenticated') return false
    // 讀資料庫（不信網址或畫面帶來的值）；看最近一筆，之後被系辦更正過的不算。
    const latest = await this.#deps.db().query<{ state: string; verification_method: string | null }>(
      `select state, verification_method from registration_applications
        where user_id = $1 order by created_at desc, id desc limit 1`,
      [actor.userId],
    )
    const row = latest.rows[0]
    return row?.state === 'approved' && row.verification_method === 'google_email_match'
  }

  async reviseMine(
    actor: ResolvedActor,
    input: ApplicationFields,
    expectedRevision: number | null,
  ): Promise<Result<RevisionReceipt> | RateLimited> {
    const blocked = ownApplicationDenied(actor, 'registration.reviseOwn')
    if (blocked || actor.kind !== 'authenticated') {
      return denied(blocked ?? 'UNAUTHENTICATED', '帳號已經開通；學號與屆別要更正請聯絡系辦。')
    }
    // 未驗證 Email 的人不能送、也不能改申請（VB-2／VB-6；AC-VI-50）：所有路徑都在這裡先擋。
    // 驗證狀態回資料庫讀，不信 session 快照；有 Google 登入方式的人 Email 已由 Google 證明（同 `homeForUser`）。
    const self = await this.#deps.db().query<{ email_verified: boolean; has_google: boolean }>(
      `select u.email_verified,
              exists (select 1 from accounts a where a.user_id = u.id and a.provider_id = 'google') as has_google
         from users u where u.id = $1`,
      [actor.userId],
    )
    const unverified = applyDenial({
      emailVerified: self.rows[0]?.email_verified === true || self.rows[0]?.has_google === true,
      loginMethod: actor.loginMethod,
    })
    if (unverified) return err('FORBIDDEN', unverified)
    if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
      return err('VALIDATION_FAILED', '頁面資料不完整，請重新整理後再試。')
    }
    const normalized = normalizeApplicationFields(input)
    if (!normalized.ok) return normalized
    const fields = normalized.value
    if (!reviseLimiter.hit(`revise:${actor.userId}`).allowed) {
      return { ok: false, code: 'RATE_LIMITED', message: '一小時內修改太多次了，請稍後再試。' }
    }

    const now = this.#clock.now()
    const tx = await this.#deps.db().connect()
    try {
      await tx.query('begin')
      // Google 來的人第一次送出可能自動開通（Q42）：開放註冊屆別先 FOR SHARE（鎖序 cohorts → users →
      // registration_applications → student_identities，同契約 01 §6），交易內「哪一屆開放」不會被換掉。
      const openCohort =
        actor.loginMethod === 'google'
          ? ((
              await tx.query<CohortChoice>(
                `select id, code, name from cohorts where is_registration_open and status <> 'archived' for share`,
              )
            ).rows[0] ?? null)
          : null
      // 先鎖這個人（同一個人兩個分頁同時送出時排隊），再看最新一筆申請。
      const user = await tx.query<{ email: string; status: string; email_verified: boolean; has_google: boolean }>(
        `select u.email, u.status, u.email_verified,
                exists (select 1 from accounts a where a.user_id = u.id and a.provider_id = 'google') as has_google
           from users u where u.id = $1 for update of u`,
        [actor.userId],
      )
      const loginEmail = user.rows[0]?.email
      if (!loginEmail || user.rows[0]?.status !== 'pending') {
        await tx.query('rollback')
        return err('CONFLICT', '帳號狀態已經改變，請重新整理頁面。')
      }
      const latest = await this.#latestApplication(tx, actor.userId, true)

      if (latest?.state === 'pending') {
        if (expectedRevision !== latest.revision) {
          await tx.query('rollback')
          return err('CONFLICT', '申請資料在別的地方改過了，請重新整理後再改一次。', {
            details: { currentRevision: latest.revision },
          })
        }
        const revision = latest.revision + 1
        const { match, rosterVersionId } = await this.#match(tx, fields, loginEmail)
        await tx.query(
          `update registration_applications
              set applied_name = $2, student_no = $3, department_class = $4, phone = $5, contact_email = $6,
                  roster_version_id = $7, roster_match = $8::jsonb, revision = $9,
                  updated_at = $10, updated_by_user_id = $11
            where id = $1`,
          [
            latest.id,
            fields.appliedName,
            fields.studentNo,
            fields.departmentClass,
            fields.phone,
            fields.contactEmail,
            rosterVersionId,
            JSON.stringify(match),
            revision,
            now,
            actor.userId,
          ],
        )
        await tx.query(
          `insert into application_revisions (id, application_id, revision, snapshot, created_at)
           values ($1, $2, $3, $4::jsonb, $5)`,
          [uuidv7(), latest.id, revision, JSON.stringify(snapshotOf(fields, loginEmail, match)), now],
        )
        await this.#deps.audit.append(tx, {
          actorKind: 'user',
          actorUserId: actor.userId,
          action: 'registration.revise',
          targetType: 'registration_application',
          targetId: latest.id,
          scope: 'global',
          realAt: now,
          businessAt: now,
          payload: { applicationId: latest.id, revision },
        })
        await tx.query('commit')
        return ok({ applicationId: latest.id, revision }, meta(now))
      }

      // 沒有待審申請（第一次補送，或被退回後重送）：畫面上以為還是待審的話，代表系辦剛剛處理了。
      if (expectedRevision !== null) {
        await tx.query('rollback')
        return err('CONFLICT', '系辦剛剛處理了你的申請，請重新整理看最新狀態。')
      }
      // 第一次送申請：用密碼註冊、還沒驗證 Email（也沒有 Google 登入方式）的人不能送（VB-3 Review；AC-VI-50）。
      // 驗證狀態讀剛鎖住的那一列，不信 session 快照；跟 `homeForUser` 導去驗證頁的判斷同一個條件。
      if (!latest && user.rows[0]?.email_verified !== true && user.rows[0]?.has_google !== true) {
        await tx.query('rollback')
        return err('FORBIDDEN', APPLY_EMAIL_UNVERIFIED_MESSAGE)
      }
      const inserted = await this.#insertApplication(
        tx,
        actor.userId,
        fields,
        loginEmail,
        now,
        latest ? 'registration.resubmit' : 'registration.apply',
        // 只有 Google 來的人要用鎖住的開放屆別比對；其他人照舊讓 `#match` 自己查。
        actor.loginMethod === 'google' ? (openCohort?.id ?? null) : undefined,
      )
      // Q42 只看第一次送出：被退回後重送不自動開通（系辦的決定不由系統推翻）。
      const autoApproved =
        !latest &&
        openCohort !== null &&
        (await this.#autoApprove(tx, {
          userId: actor.userId,
          applicationId: inserted.id,
          fields,
          match: inserted.match,
          rosterVersionId: inserted.rosterVersionId,
          openCohort,
          loginMethod: actor.loginMethod,
          emailVerified: user.rows[0]?.email_verified === true,
          now,
        }))
      await tx.query('commit')
      // 自動開通：commit 之後丟本人的身分快取，下一次請求就是已開通（同 `#approveInTx`）。
      if (autoApproved) bustIdentity(actor.userId)
      return ok({ applicationId: inserted.id, revision: 1, ...(autoApproved ? { autoApproved: true } : {}) }, meta(now))
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      if (isUniqueViolation(error)) return err('CONFLICT', '申請剛剛已經送出了，請重新整理頁面。')
      throw error
    } finally {
      tx.release()
    }
  }

  // ── 系辦 ──────────────────────────────────────────────────────────────────

  async listPending(actor: ResolvedActor): Promise<Result<PendingList>> {
    const blocked = reviewAccessDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')

    const db = this.#deps.db()
    const rows = await db.query<ApplicationRow>(
      `select ${APPLICATION_COLUMNS}
         from registration_applications ra
         join users u on u.id = ra.user_id
        where ra.state = 'pending' and u.status = 'pending'
        order by ra.created_at asc, ra.id asc
        limit ${PENDING_LIST_LIMIT}`,
    )
    const { cohorts, registrationOpen } = await this.#cohortChoices()
    const studentNos = rows.rows.map((r) => r.student_no)
    const candidates = await this.#candidates(db, studentNos)
    const holders = await this.#activeHolders(db, studentNos)
    const pendingCounts = await this.#pendingCounts(db, studentNos)
    // 先前被退回過（現在這筆是退回後重新送的；新申請的 revision 從 1 開始，不能靠版本判斷）。
    const rejectedBefore = new Set<string>()
    if (rows.rows.length > 0) {
      const rejected = await db.query<{ user_id: string }>(
        `select distinct user_id from registration_applications
          where state = 'rejected' and user_id = any($1::uuid[])`,
        [rows.rows.map((r) => r.user_id)],
      )
      for (const r of rejected.rows) rejectedBefore.add(r.user_id)
    }

    const applications: PendingApplication[] = rows.rows.map((row) => {
      const fields = fieldsOf(row)
      const match = matchRoster({ ...fields, loginEmail: row.login_email }, candidates, registrationOpen?.id ?? null)
      const key = row.student_no.toUpperCase()
      const duplicates: DuplicateInfo = {
        activeHolders: (holders.get(key) ?? []).filter((h) => h.userId !== row.user_id).map(({ name, cohortCode }) => ({ name, cohortCode })),
        otherPending: Math.max(0, (pendingCounts.get(key) ?? 0) - 1),
      }
      const hitCohorts = new Set(match.hits.map((h) => h.cohortId))
      return {
        ...fields,
        applicationId: row.id,
        userId: row.user_id,
        revision: row.revision,
        loginEmail: row.login_email,
        submittedAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        match,
        duplicates,
        flags: evidenceFlags(match, duplicates),
        suggestedCohortId: suggestedApprovalCohort(match, registrationOpen?.id ?? null),
        cohortLocked: hitCohorts.size === 1,
        previouslyRejected: rejectedBefore.has(row.user_id),
      }
    })

    return ok({ applications, cohorts, registrationOpenCohort: registrationOpen }, meta(this.#clock.now()))
  }

  async approve(actor: ResolvedActor, input: ApproveInput): Promise<Result<DecisionReceipt>> {
    return this.#approve(actor, input, false)
  }

  /**
   * 單筆核准的交易。`batch` 是批次核准（第三波 W6）呼叫的：鎖住申請、以**這個交易看得到的**名單比對之後，
   * 再查一次批次資格（`bulkApprovalSkip`），不符就整筆回滾、回 `CONFLICT` 並在 details 帶略過原因——
   * 預覽與核准之間名單、占用都可能變了，交易外先分類擋不住。單筆審核（`batch=false`）完全不走這一段。
   */
  async #approve(actor: ResolvedActor, input: ApproveInput, batch: boolean): Promise<Result<DecisionReceipt>> {
    // 審核結果信在交易連線還回池子**之後**才寄：寄信也要向同一個池子拿連線，抓著不放的話池子滿載時全部卡死。
    let mailTo: string | null = null
    const result = await this.#approveInTx(actor, input, batch, (to) => (mailTo = to))
    if (result.ok && mailTo !== null) await this.#notifyResult(mailTo, { decision: 'approved' })
    return result
  }

  /** 核准的交易本體；commit 成功才呼叫 `committed`（回放、失敗都不呼叫，所以不會重寄）。 */
  async #approveInTx(
    actor: ResolvedActor,
    input: ApproveInput,
    batch: boolean,
    committed: (to: string) => void,
  ): Promise<Result<DecisionReceipt>> {
    const blocked = reviewAccessDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    const shape = checkDecisionShape(input)
    if (shape) return shape
    if (input.cohortId !== null && !UUID_PATTERN.test(input.cohortId)) {
      return err('VALIDATION_FAILED', '請選一個既有的屆別。', { details: { field: 'cohortId' } })
    }
    const decision = normalizeApproval(input)
    if (!decision.ok) return decision

    const now = this.#clock.now()
    const fingerprint = sha256(
      canonicalJson({
        applicationId: input.applicationId,
        revision: input.revision,
        cohortId: input.cohortId,
        ...decision.value,
      }),
    )
    const { cohorts, registrationOpen } = await this.#cohortChoices()

    const tx = await this.#deps.db().connect()
    try {
      await tx.query('begin')
      const begun = await this.#deps.ledger.begin(
        tx,
        { actorUserId: actor.userId, operationKind: 'account.approve', requestId: input.requestId, fingerprint, scope: 'global' },
        now,
      )
      if (begun.outcome === 'mismatch') {
        await tx.query('rollback')
        return err('REQUEST_MISMATCH', '這個請求編號已經用在別的審核上，請重新整理後再試。')
      }
      if (begun.outcome === 'replay') {
        await tx.query('commit')
        if (begun.receiptExpired) return err('RECEIPT_EXPIRED', '這次核准已經完成，回執已過期；請看帳號列表。')
        return ok(begun.receipt as DecisionReceipt, meta(now, input.requestId))
      }

      const locked = await this.#lockForDecision(tx, input.applicationId, input.revision)
      if (!locked.ok) {
        await tx.query('rollback')
        return locked
      }
      const row = locked.row
      const fields = fieldsOf(row)

      // 比對以**核准當下**的名單為準（名單可能在學生送出後才匯入），並寫進紀錄當作比對依據。
      const { match, rosterVersionId } = await this.#match(tx, fields, row.login_email, registrationOpen?.id ?? null)
      if (batch) {
        const key = row.student_no.toUpperCase()
        const holders = (await this.#activeHolders(tx, [row.student_no])).get(key) ?? []
        const duplicates: DuplicateInfo = {
          activeHolders: holders.filter((h) => h.userId !== row.user_id).map(({ name, cohortCode }) => ({ name, cohortCode })),
          otherPending: Math.max(0, ((await this.#pendingCounts(tx, [row.student_no])).get(key) ?? 0) - 1),
        }
        const why = bulkApprovalSkip({ match, duplicates }, cohorts)
        if (why) {
          await tx.query('rollback')
          return err('CONFLICT', BULK_APPROVAL_SKIP_LABEL[why], { details: { bulkSkip: why, appliedName: row.applied_name } })
        }
      }
      const cohort = resolveApprovalCohort(match, input.cohortId, cohorts)
      if (!cohort.ok) {
        await tx.query('rollback')
        return cohort
      }
      const cohortChoice = cohorts.find((c) => c.id === cohort.cohortId)!

      // 占用有效學號：同屆同學號只能有一個有效學生（唯一違反 → STUDENT_NO_TAKEN，整體回滾）。
      // 占用表一律存大寫、寫入前以 upper() 再查一次（票 9；說明見 student-identities.ts）。
      const takenMessage = `學號 ${row.student_no} 在 ${cohortChoice.name} 已經有一個有效的帳號，不能再核准一個。請先確認是不是同一個人重複註冊。`
      if (await studentNoHolder(tx, cohort.cohortId, row.student_no, row.user_id)) {
        await tx.query('rollback')
        return err('STUDENT_NO_TAKEN', takenMessage)
      }
      try {
        await occupyStudentNo(tx, cohort.cohortId, row.student_no, row.user_id, now)
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        await tx.query('rollback')
        return err('STUDENT_NO_TAKEN', takenMessage)
      }

      await this.#activateStudent(tx, row, cohort.cohortId, now, { byUserId: actor.userId, roleReason: '註冊審核核准' })
      await tx.query(
        `insert into user_status_events
           (id, user_id, from_status, to_status, reason, verification_method, actor_kind, actor_user_id, real_at)
         values ($1, $2, 'pending', 'active', $3, $4, 'user', $5, $6)`,
        [uuidv7(), row.user_id, decision.value.reason, decision.value.verificationMethod, actor.userId, now],
      )
      await tx.query(
        `update registration_applications
            set state = 'approved', decided_by_user_id = $2, decided_real_at = $3,
                verification_method = $4, verification_note = $5, reason = $6, assigned_cohort_id = $7,
                roster_version_id = $8, roster_match = $9::jsonb, updated_at = $3, updated_by_user_id = $2
          where id = $1`,
        [
          row.id,
          actor.userId,
          now,
          decision.value.verificationMethod,
          decision.value.verificationNote,
          decision.value.reason,
          cohort.cohortId,
          rosterVersionId,
          JSON.stringify(match),
        ],
      )
      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: 'account.approve',
        targetType: 'registration_application',
        targetId: row.id,
        scope: 'cohort',
        cohortId: cohort.cohortId,
        reason: decision.value.reason,
        verificationMethod: decision.value.verificationMethod,
        realAt: now,
        businessAt: now,
        payload: {
          userId: row.user_id,
          revision: row.revision,
          rosterVersionId,
          rosterMatch: match.status,
          emailComparison: match.emailComparison,
          verificationNote: decision.value.verificationNote,
        },
      })

      const receipt: DecisionReceipt = {
        applicationId: row.id,
        decision: 'approved',
        appliedName: row.applied_name,
        revision: row.revision,
        cohortName: cohortChoice.name,
        verificationMethod: decision.value.verificationMethod,
        decidedAt: now.toISOString(),
      }
      await this.#deps.ledger.commit(tx, begun.recordId, { receipt, resultRef: { applicationId: row.id } })
      await tx.query('commit')
      // commit 之後才丟當事人的身分快取：commit 前丟的話，同時進來的請求會把舊的「待審」再存回去（B 設計方案 §4.1）。
      // 批次核准（`approveMany`）每一筆都經 `#approve` 走到這裡，不另外丟。
      bustIdentity(row.user_id)
      committed(row.login_email)
      return ok(receipt, meta(now, input.requestId))
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }

  // ── 批次核准（第三波 W6） ──────────────────────────────────────────────────

  async previewApproveMany(actor: ResolvedActor, applicationIds: readonly string[]): Promise<Result<BulkApprovalPreview>> {
    const blocked = reviewAccessDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    const ids = bulkIds(applicationIds)
    if (!ids.ok) return ids
    const listed = await this.listPending(actor)
    if (!listed.ok) return listed
    const byId = new Map(listed.receipt.applications.map((a) => [a.applicationId, a]))
    const cohorts = listed.receipt.cohorts
    const rows = ids.ids.flatMap((id) => {
      const a = byId.get(id)
      if (!a) return []
      const skip = bulkApprovalSkip(a, cohorts)
      const cohortId = skip ? null : resolveApprovalCohort(a.match, null, cohorts)
      return [
        {
          applicationId: a.applicationId,
          revision: a.revision,
          appliedName: a.appliedName,
          studentNo: a.studentNo,
          rosterMatch: a.match.status,
          cohortName: cohortId?.ok ? (cohorts.find((c) => c.id === cohortId.cohortId)?.name ?? null) : null,
          skip,
          skipLabel: skip ? BULK_APPROVAL_SKIP_LABEL[skip] : null,
        },
      ]
    })
    return ok({ rows, missing: ids.ids.length - rows.length }, meta(this.#clock.now()))
  }

  async approveMany(
    actor: ResolvedActor,
    input: {
      items: readonly { applicationId: string; revision: number; requestId: string }[]
      previewSkipped: readonly string[]
      verificationMethod: string
      verificationNote: string
      reason: string
    },
  ): Promise<Result<BulkApprovalReceipt>> {
    const blocked = reviewAccessDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    // 核實欄位整批共用：不對就整批不做，畫面停在原地讓系辦改（規則同單筆）。
    const decision = normalizeApproval(input)
    if (!decision.ok) return decision
    const previewSkipped = Array.isArray(input.previewSkipped) ? input.previewSkipped : []
    // 兩邊合起來檢查：同一位不能同時「要核准」又「預覽略過」。
    const ids = bulkIds([...input.items.map((i) => i.applicationId), ...previewSkipped])
    if (!ids.ok) return ids
    if (input.items.length === 0) return err('VALIDATION_FAILED', '勾選的人都需要個別審核，沒有可以一起核准的。')

    const approved: BulkApprovalReceipt['approved'][number][] = []
    const skipped: BulkApprovalReceipt['skipped'][number][] = []
    const skip = (applicationId: string, appliedName: string, why: BulkApprovalSkip) =>
      skipped.push({ applicationId, appliedName, reason: BULK_APPROVAL_SKIP_LABEL[why] })

    // 只核准 `items` 裡的人；資格在每一筆自己的交易裡重查（見 `#approve`）。
    // 一位一位做（各自的交易），不並行：同一批裡兩位搶同一個學號時，後面那位會拿到「學號已被使用」。
    // 不在待審清單的（例如這一批重送、上次已經核准了）一樣呼叫：同一個請求編號會回放回執。
    for (const item of input.items) {
      const result = await this.#approve(
        actor,
        {
          applicationId: item.applicationId,
          revision: item.revision,
          verificationMethod: input.verificationMethod,
          verificationNote: input.verificationNote,
          reason: input.reason,
          cohortId: null,
          requestId: item.requestId,
        },
        true,
      )
      if (result.ok) {
        approved.push({
          applicationId: result.receipt.applicationId,
          appliedName: result.receipt.appliedName,
          cohortName: result.receipt.cohortName,
        })
        continue
      }
      const details = result.details ?? {}
      const name = typeof details.appliedName === 'string' ? details.appliedName : ''
      const why: BulkApprovalSkip =
        typeof details.bulkSkip === 'string' && details.bulkSkip in BULK_APPROVAL_SKIP_LABEL
          ? (details.bulkSkip as BulkApprovalSkip)
          : result.code === 'STUDENT_NO_TAKEN'
            ? 'student_no_taken'
            : result.code === 'CONFLICT'
              ? 'changed'
              : 'failed'
      skip(item.applicationId, name, why)
    }

    // 預覽就略過的人：只回報（以現在的待審清單說原因），絕不核准。
    if (previewSkipped.length > 0) {
      const listed = await this.listPending(actor)
      if (!listed.ok) return listed
      const byId = new Map(listed.receipt.applications.map((a) => [a.applicationId, a]))
      for (const id of previewSkipped) {
        const pending = byId.get(id)
        if (!pending) skip(id, '', 'not_pending')
        else skip(id, pending.appliedName, bulkApprovalSkip(pending, listed.receipt.cohorts) ?? 'not_in_preview')
      }
    }
    return ok({ approved, skipped }, meta(this.#clock.now()))
  }

  async reject(
    actor: ResolvedActor,
    input: { applicationId: string; revision: number; reason: string; requestId: string },
  ): Promise<Result<DecisionReceipt>> {
    // 同 `#approve`：交易連線還回池子之後才寄信。
    let mail: { to: string; reason: string } | null = null
    const result = await this.#rejectInTx(actor, input, (to, reason) => (mail = { to, reason }))
    if (result.ok && mail !== null) {
      const { to, reason } = mail
      await this.#notifyResult(to, { decision: 'rejected', reason })
    }
    return result
  }

  /** 退回的交易本體；commit 成功才呼叫 `committed`。 */
  async #rejectInTx(
    actor: ResolvedActor,
    input: { applicationId: string; revision: number; reason: string; requestId: string },
    committed: (to: string, reason: string) => void,
  ): Promise<Result<DecisionReceipt>> {
    const blocked = reviewAccessDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    const shape = checkDecisionShape(input)
    if (shape) return shape
    const decision = normalizeRejection(input)
    if (!decision.ok) return decision

    const now = this.#clock.now()
    const fingerprint = sha256(
      canonicalJson({ applicationId: input.applicationId, revision: input.revision, reason: decision.value.reason }),
    )
    const tx = await this.#deps.db().connect()
    try {
      await tx.query('begin')
      const begun = await this.#deps.ledger.begin(
        tx,
        { actorUserId: actor.userId, operationKind: 'account.reject', requestId: input.requestId, fingerprint, scope: 'global' },
        now,
      )
      if (begun.outcome === 'mismatch') {
        await tx.query('rollback')
        return err('REQUEST_MISMATCH', '這個請求編號已經用在別的審核上，請重新整理後再試。')
      }
      if (begun.outcome === 'replay') {
        await tx.query('commit')
        if (begun.receiptExpired) return err('RECEIPT_EXPIRED', '這次退回已經完成，回執已過期。')
        return ok(begun.receipt as DecisionReceipt, meta(now, input.requestId))
      }

      const locked = await this.#lockForDecision(tx, input.applicationId, input.revision)
      if (!locked.ok) {
        await tx.query('rollback')
        return locked
      }
      const row = locked.row

      // 退回只關這一筆申請；帳號留著（仍是待審），本人可以修改後重新送出（工程模組 01 §3）。
      await tx.query(
        `update registration_applications
            set state = 'rejected', decided_by_user_id = $2, decided_real_at = $3, reason = $4,
                updated_at = $3, updated_by_user_id = $2
          where id = $1`,
        [row.id, actor.userId, now, decision.value.reason],
      )
      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: 'account.reject',
        targetType: 'registration_application',
        targetId: row.id,
        scope: 'global',
        reason: decision.value.reason,
        realAt: now,
        businessAt: now,
        payload: { userId: row.user_id, revision: row.revision },
      })

      const receipt: DecisionReceipt = {
        applicationId: row.id,
        decision: 'rejected',
        appliedName: row.applied_name,
        revision: row.revision,
        cohortName: null,
        verificationMethod: null,
        decidedAt: now.toISOString(),
      }
      await this.#deps.ledger.commit(tx, begun.recordId, { receipt, resultRef: { applicationId: row.id } })
      await tx.query('commit')
      // 身分快照不含申請狀態（退回後帳號仍是待審），這裡是預防性地跟失效點清單一致（契約 03 §2）。
      bustIdentity(row.user_id)
      committed(row.login_email, decision.value.reason)
      return ok(receipt, meta(now, input.requestId))
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }

  // ── 內部 ──────────────────────────────────────────────────────────────────

  /**
   * 審核結果信（設計方案 §3.1）：一定在交易 commit、而且交易連線還回池子之後呼叫。寄失敗只留 `mail_outbox.status = 'failed'`，
   * 不回滾、不回錯給系辦（R6：不重試）；連寫 `mail_outbox` 都失敗也只記 log。回放（同請求編號重送）不會走到這裡。
   */
  async #notifyResult(to: string, outcome: RegistrationOutcome): Promise<void> {
    const mail = this.#deps.mail
    if (!mail) return
    try {
      await mail.mailer.send({ to, ...registrationResultMail(outcome, mail.siteUrl) })
    } catch (error) {
      console.error('[registration] 審核結果信寫入失敗（審核已完成）', error instanceof Error ? error.name : 'unknown error')
    }
  }

  /** 建一筆新的待審申請（第 1 版）＋快照＋稽核。回申請 ID 與這次的名單比對。 */
  async #insertApplication(
    tx: PoolClient,
    userId: string,
    fields: ApplicationFields,
    loginEmail: string,
    now: Date,
    action: 'registration.apply' | 'registration.resubmit',
    registrationOpenId?: string | null,
  ): Promise<{ id: string; match: RosterMatch; rosterVersionId: string | null }> {
    const id = uuidv7()
    const { match, rosterVersionId } = await this.#match(tx, fields, loginEmail, registrationOpenId)
    await tx.query(
      `insert into registration_applications
         (id, user_id, revision, applied_name, student_no, department_class, phone, contact_email, login_email,
          roster_version_id, roster_match, state, created_at, created_by_kind, created_by_user_id,
          updated_at, updated_by_user_id)
       values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending', $11, 'user', $2, $11, $2)`,
      [
        id,
        userId,
        fields.appliedName,
        fields.studentNo,
        fields.departmentClass,
        fields.phone,
        fields.contactEmail,
        loginEmail,
        rosterVersionId,
        JSON.stringify(match),
        now,
      ],
    )
    await tx.query(
      `insert into application_revisions (id, application_id, revision, snapshot, created_at)
       values ($1, $2, 1, $3::jsonb, $4)`,
      [uuidv7(), id, JSON.stringify(snapshotOf(fields, loginEmail, match)), now],
    )
    await this.#deps.audit.append(tx, {
      actorKind: 'user',
      actorUserId: userId,
      action,
      targetType: 'registration_application',
      targetId: id,
      scope: 'global',
      realAt: now,
      businessAt: now,
      payload: { applicationId: id, revision: 1 },
    })
    return { id, match, rosterVersionId }
  }

  async #latestApplication(db: Queryable, userId: string, forUpdate = false): Promise<ApplicationRow | null> {
    const rows = await db.query<ApplicationRow>(
      `select ${APPLICATION_COLUMNS}
         from registration_applications ra
        where ra.user_id = $1
        order by ra.created_at desc, ra.id desc
        limit 1${forUpdate ? ' for update' : ''}`,
      [userId],
    )
    return rows.rows[0] ?? null
  }

  /** 鎖住要審的那一筆，並確認它還是待審、而且是畫面上看到的那一版。 */
  async #lockForDecision(
    tx: PoolClient,
    applicationId: string,
    revision: number,
  ): Promise<{ ok: true; row: ApplicationRow } | Err> {
    // 鎖的順序固定是「先 users、再 registration_applications」，跟 `reviseMine` 一樣。
    // 原本一句 `for update of ra, u` 鎖兩張表，實際先鎖哪一張看執行計畫；學生同時送出修改時
    // 兩邊可能各拿一半互等（死鎖；票 7 審查建議）。`user_id` 建立後不會變，先不鎖地讀出來沒問題。
    const owner = await tx.query<{ user_id: string }>('select user_id from registration_applications where id = $1', [
      applicationId,
    ])
    const userId = owner.rows[0]?.user_id
    if (!userId) return err('CONFLICT', '找不到這筆申請，請重新整理頁面。')
    const user = await tx.query<{ status: string }>('select status from users where id = $1 for update', [userId])
    const rows = await tx.query<ApplicationRow>(
      `select ${APPLICATION_COLUMNS}
         from registration_applications ra
        where ra.id = $1
        for update`,
      [applicationId],
    )
    const found = rows.rows[0]
    const row = found && user.rows[0] ? { ...found, user_status: user.rows[0].status } : undefined
    if (!row) return err('CONFLICT', '找不到這筆申請，請重新整理頁面。')
    if (row.state !== 'pending' || row.user_status !== 'pending') {
      return err('CONFLICT', '這筆申請剛剛已經被處理過了，請重新整理頁面。')
    }
    if (row.revision !== revision) {
      // 核准與退回都依當時的申請資料版本（§5）：學生改過資料，舊畫面上的決定一律不算。
      return err(
        'CONFLICT',
        `學生剛修改過申請資料（現在是第 ${row.revision} 版，你看到的是第 ${revision} 版）。請重新載入，核對新資料後再決定。`,
        { details: { currentRevision: row.revision } },
      )
    }
    return { ok: true, row }
  }

  /**
   * 核准的共同步驟（系辦核准與 Q42 自動開通共用）：帳號轉正常、寫個人資料、給學生角色。
   * 學號占用由呼叫端先做（各自決定撞到時怎麼辦）。`byUserId` 寫進個人資料的修改者與角色的授予者。
   */
  async #activateStudent(
    tx: PoolClient,
    row: Pick<ApplicationRow, 'user_id' | 'applied_name' | 'student_no' | 'department_class' | 'phone' | 'contact_email'>,
    cohortId: string,
    now: Date,
    by: { byUserId: string; roleReason: string },
  ): Promise<void> {
    await tx.query(`update users set status = 'active', name = $2, updated_at = $3 where id = $1`, [
      row.user_id,
      row.applied_name,
      now,
    ])
    await tx.query(
      `insert into user_profiles
         (user_id, display_name, name_normalized, student_no, department_class, cohort_id, phone, contact_email,
          login_method_last, created_at, updated_at, updated_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8,
               -- 申請人最近一次的登入方式（票 10；顯示用）：最近一個 session 的 login_method；
               -- session 都過期被清掉了，就看帳號上有沒有密碼。
               coalesce(
                 (select s.login_method from sessions s where s.user_id = $1 order by s.created_at desc limit 1),
                 case when exists (select 1 from accounts a where a.user_id = $1 and a.provider_id = 'credential')
                      then 'password' else 'google' end
               ),
               $9, $9, $10)
       on conflict (user_id) do update set
         display_name = excluded.display_name,
         name_normalized = excluded.name_normalized,
         student_no = excluded.student_no,
         department_class = excluded.department_class,
         cohort_id = excluded.cohort_id,
         phone = excluded.phone,
         contact_email = excluded.contact_email,
         login_method_last = excluded.login_method_last,
         revision = user_profiles.revision + 1,
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id`,
      [
        row.user_id,
        row.applied_name,
        normalizeName(row.applied_name),
        row.student_no,
        row.department_class,
        cohortId,
        row.phone,
        row.contact_email,
        now,
        by.byUserId,
      ],
    )
    await tx.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
       select $1, $2, 'student', $3, $4, $5
        where not exists (
          select 1 from role_assignments where user_id = $2 and role = 'student' and revoked_real_at is null
        )`,
      [uuidv7(), row.user_id, by.byUserId, now, by.roleReason],
    )
  }

  /**
   * Q42 自動開通（VB-6；visitor-r3 §3.6、R1／R2）：剛建好的第 1 版申請，在同一筆交易裡判斷能不能直接核准。
   *
   * 呼叫端已經鎖住開放註冊屆別（FOR SHARE）、本人 users 列，申請也是這個交易建的。學號占用在交易內重查
   * （`bulkApprovalSkip` 的占用、同學號待審），再以 `student_identities` 主鍵收尾：兩個人同時用同一個學號，
   * 後到的撞主鍵 → 回到 savepoint、安靜留在待審（不報錯，R1「任一不符走系辦核實」）。
   *
   * 操作者是系統：申請的核准者留空、狀態流水與稽核 `actor_kind = 'system'`；`role_assignments` 的授予者
   * 欄不能空，記申請人自己、理由寫明是自動開通。不寄「帳號已開通」信（畫面直接說）。回 true 代表已開通。
   */
  async #autoApprove(
    tx: PoolClient,
    input: {
      userId: string
      applicationId: string
      fields: ApplicationFields
      match: RosterMatch
      rosterVersionId: string | null
      openCohort: CohortChoice
      loginMethod: 'google' | 'password' | undefined
      emailVerified: boolean
      now: Date
    },
  ): Promise<boolean> {
    const { userId, fields, match, openCohort, now } = input
    const key = fields.studentNo.toUpperCase()
    const holders = (await this.#activeHolders(tx, [fields.studentNo])).get(key) ?? []
    const duplicates: DuplicateInfo = {
      activeHolders: holders.filter((h) => h.userId !== userId).map(({ name, cohortCode }) => ({ name, cohortCode })),
      otherPending: Math.max(0, ((await this.#pendingCounts(tx, [fields.studentNo])).get(key) ?? 0) - 1),
    }
    const eligible = autoApprovalEligible({
      loginMethod: input.loginMethod,
      emailVerified: input.emailVerified,
      match,
      registrationOpenCohortId: openCohort.id,
      bulkApprovalSkip: bulkApprovalSkip({ match, duplicates }, [openCohort]),
    })
    if (!eligible) return false

    await tx.query('savepoint auto_approve')
    try {
      await occupyStudentNo(tx, openCohort.id, fields.studentNo, userId, now)
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      await tx.query('rollback to savepoint auto_approve')
      return false
    }
    await tx.query('release savepoint auto_approve')

    await this.#activateStudent(
      tx,
      {
        user_id: userId,
        applied_name: fields.appliedName,
        student_no: fields.studentNo,
        department_class: fields.departmentClass,
        phone: fields.phone,
        contact_email: fields.contactEmail,
      },
      openCohort.id,
      now,
      { byUserId: userId, roleReason: '自動開通（Google Email 與名單相同）' },
    )
    await tx.query(
      `insert into user_status_events
         (id, user_id, from_status, to_status, reason, verification_method, actor_kind, actor_user_id, real_at)
       values ($1, $2, 'pending', 'active', $3, 'google_email_match', 'system', null, $4)`,
      [uuidv7(), userId, AUTO_APPROVE_REASON, now],
    )
    await tx.query(
      `update registration_applications
          set state = 'approved', decided_by_user_id = null, decided_real_at = $2,
              verification_method = 'google_email_match', verification_note = null, reason = null,
              assigned_cohort_id = $3, updated_at = $2
        where id = $1`,
      [input.applicationId, now, openCohort.id],
    )
    await this.#deps.audit.append(tx, {
      actorKind: 'system',
      action: 'registration.auto_approve',
      targetType: 'registration_application',
      targetId: input.applicationId,
      scope: 'cohort',
      cohortId: openCohort.id,
      reason: AUTO_APPROVE_REASON,
      verificationMethod: 'google_email_match',
      realAt: now,
      businessAt: now,
      payload: {
        userId,
        revision: 1,
        rosterVersionId: input.rosterVersionId,
        rosterMatch: match.status,
        emailComparison: match.emailComparison,
      },
    })
    return true
  }

  /** 對這份申請做一次名單比對（用這個交易看得到的名單）。 */
  async #match(
    db: Queryable,
    fields: ApplicationFields,
    loginEmail: string,
    registrationOpenId?: string | null,
  ): Promise<{ match: RosterMatch; rosterVersionId: string | null }> {
    const openId = registrationOpenId === undefined ? ((await this.#deps.cohorts.registrationOpen())?.id ?? null) : registrationOpenId
    const candidates = await this.#candidates(db, [fields.studentNo])
    const match = matchRoster({ ...fields, loginEmail }, candidates, openId)
    return { match, rosterVersionId: match.hit?.rosterVersionId ?? null }
  }

  /**
   * 每一個未封存屆別**最新一版**名單裡，學號在這批裡的列。
   *
   * 只看最新版：舊版名單是歷史，被新版取代的人不該再算「在名單上」。
   * 新的屆別排前面（`matchRoster` 在沒有其他依據時取第一個）。
   */
  async #candidates(db: Queryable, studentNos: readonly string[]): Promise<RosterCandidate[]> {
    if (studentNos.length === 0) return []
    const rows = await db.query<{
      roster_version_id: string
      cohort_id: string
      cohort_code: string
      cohort_name: string
      student_no: string
      name_raw: string
      name_normalized: string
      email: string | null
      department_class: string | null
    }>(
      `with latest as (
         select distinct on (rv.cohort_id) rv.id, rv.cohort_id
           from roster_versions rv
           join cohorts c on c.id = rv.cohort_id
          where c.status <> 'archived'
          order by rv.cohort_id, rv.imported_real_at desc, rv.id desc
       )
       select re.roster_version_id, l.cohort_id, c.code as cohort_code, c.name as cohort_name,
              re.student_no, re.name_raw, re.name_normalized, re.email, re.department_class
         from roster_entries re
         join latest l on l.id = re.roster_version_id
         join cohorts c on c.id = l.cohort_id
        where upper(re.student_no) = any($1::text[])
        order by c.created_at desc, c.code desc`,
      [[...new Set(studentNos.map((s) => s.toUpperCase()))]],
    )
    return rows.rows.map((r) => ({
      rosterVersionId: r.roster_version_id,
      cohortId: r.cohort_id,
      cohortCode: r.cohort_code,
      cohortName: r.cohort_name,
      studentNo: r.student_no,
      nameRaw: r.name_raw,
      nameNormalized: r.name_normalized,
      email: r.email,
      departmentClass: r.department_class,
    }))
  }

  /** 已核准、占用這些學號的人（任何一屆）。 */
  async #activeHolders(
    db: Queryable,
    studentNos: readonly string[],
  ): Promise<Map<string, { userId: string; name: string; cohortCode: string }[]>> {
    const result = new Map<string, { userId: string; name: string; cohortCode: string }[]>()
    if (studentNos.length === 0) return result
    const rows = await db.query<{ student_no: string; user_id: string; name: string; cohort_code: string }>(
      `select si.student_no, si.user_id, coalesce(up.display_name, u.name) as name, c.code as cohort_code
         from student_identities si
         join users u on u.id = si.user_id
         join cohorts c on c.id = si.cohort_id
         left join user_profiles up on up.user_id = si.user_id
        where upper(si.student_no) = any($1::text[])`,
      [[...new Set(studentNos.map((s) => s.toUpperCase()))]],
    )
    for (const r of rows.rows) {
      const key = r.student_no.toUpperCase()
      result.set(key, [...(result.get(key) ?? []), { userId: r.user_id, name: r.name, cohortCode: r.cohort_code }])
    }
    return result
  }

  /** 每個學號目前有幾筆待審申請（含自己那筆）。 */
  async #pendingCounts(db: Queryable, studentNos: readonly string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    if (studentNos.length === 0) return result
    const rows = await db.query<{ key: string; n: number }>(
      `select upper(student_no) as key, count(*)::int as n
         from registration_applications
        where state = 'pending' and upper(student_no) = any($1::text[])
        group by upper(student_no)`,
      [[...new Set(studentNos.map((s) => s.toUpperCase()))]],
    )
    for (const r of rows.rows) result.set(r.key, r.n)
    return result
  }

  /** 可以指派的屆別（未封存）與開放註冊屆別。經模組 02 的 `CohortStatusQuery`（票 5）。 */
  async #cohortChoices(): Promise<{ cohorts: CohortChoice[]; registrationOpen: CohortChoice | null }> {
    const all = await this.#deps.cohorts.list()
    const cohorts = all.filter((c) => c.status !== 'archived').map((c) => ({ id: c.id, code: c.code, name: c.name }))
    const open = all.find((c) => c.isRegistrationOpen && c.status !== 'archived')
    return { cohorts, registrationOpen: open ? { id: open.id, code: open.code, name: open.name } : null }
  }
}

/** 批次的申請 ID：至少一筆、不超過上限、不重複、格式要對。 */
function bulkIds(values: readonly string[]): { ok: true; ids: string[] } | Err {
  if (!Array.isArray(values) || values.length === 0) return err('VALIDATION_FAILED', '請先勾選要核准的人。')
  if (values.length > BULK_APPROVAL_MAX) {
    return err('VALIDATION_FAILED', `一次最多核准 ${BULK_APPROVAL_MAX} 位，請分批。`)
  }
  const ids = [...new Set(values)]
  if (ids.length !== values.length || !ids.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) {
    return err('VALIDATION_FAILED', '勾選的名單不正確，請重新整理頁面再試。')
  }
  return { ok: true, ids }
}

/** 審核請求的形狀：申請 ID、版本、請求編號都要是合法值，不丟給資料庫報型別錯。 */
function checkDecisionShape(input: { applicationId: string; revision: number; requestId: string }): Err | null {
  if (!UUID_PATTERN.test(input.applicationId) || !Number.isInteger(input.revision) || input.revision < 1) {
    return err('VALIDATION_FAILED', '找不到這筆申請，請重新整理頁面。')
  }
  if (!isRequestId(input.requestId)) return err('VALIDATION_FAILED', '這次送出缺少請求編號，請重新整理頁面再試。')
  return null
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505'
}

/**
 * 被限速時最晚要等多久（N-21）。限速是固定視窗：被擋之後最晚一個視窗長度就重算，
 * 所以照 `RATE_LIMITS` 的視窗長度說「最晚」，不寫死數字。
 */
function waitAtMost(windowMs: number): string {
  const minutes = Math.ceil(windowMs / 60_000)
  return minutes % 60 === 0 ? `${minutes / 60} 小時` : `${minutes} 分鐘`
}
