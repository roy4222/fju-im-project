import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import {
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
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import { defaultNextStep, type ErrorCode } from '@/shared/errors'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { signUpWithPassword } from '@/infrastructure/auth/wrapper'

/**
 * 學生註冊與審核（工程模組 01 §3 狀態表、§5 `RegistrationCommand`、§6 核准交易；票 7）。
 *
 * 每個方法第一件事都是授權（`reviewAccessDenied`／`ownApplicationDenied`，規則在 application 層），
 * 第二件事是驗證輸入；之後才碰資料庫。全程用 `fju_app` 的權限就做得完（整合測試以 `fju_app` 跑）。
 *
 * **註冊為什麼分兩步**：帳號（`users`＋密碼）由 Better Auth 建，它只存自己宣告過的欄位，
 * 學號、手機、系級放不進去；而本票不能加 migration。所以先請套件建帳號（受限 session），
 * 再用自己的交易寫申請單＋第 1 版快照＋稽核。第二步萬一失敗，帳號是一個「待審、沒有申請單」的人——
 * 他登入後在等待審核頁看到「還沒送出申請資料」的表單，補送一次就回到正軌（`reviseMine` 的 `none` 分支）。
 * 直接打 `POST /api/auth/sign-up/email` 註冊的人也走同一條補送路。
 */

export type AccountCreation =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: 'rate_limited' | 'email_taken' | 'invalid'; readonly message?: string }

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
    if (e?.status === 'TOO_MANY_REQUESTS') return { ok: false, reason: 'rate_limited' }
    if (e?.body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' || e?.body?.code === 'USER_ALREADY_EXISTS') {
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
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 待審清單一次最多列幾筆（一屆幾百人，不需要分頁）。 */
const PENDING_LIST_LIMIT = 500

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
    // 已經登入的人再註冊一次會變成第二個帳號；請他先登出。
    if (actor.kind === 'authenticated') return err('FORBIDDEN', '你已經登入了；要註冊另一個帳號請先登出。')

    const normalized = normalizeRegistrationInput(input)
    if (!normalized.ok) return normalized
    const fields = normalized.value

    const created = await this.#createAccount(
      { email: fields.loginEmail, password: fields.password, name: fields.appliedName },
      clientIp,
    )
    if (!created.ok) {
      if (created.reason === 'rate_limited') {
        return { ok: false, code: 'RATE_LIMITED', message: '這個網路一小時內的註冊次數已達上限，請稍後再試。' }
      }
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
    const user = await db.query<{ email: string }>('select email from users where id = $1', [actor.userId])
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

  async reviseMine(
    actor: ResolvedActor,
    input: ApplicationFields,
    expectedRevision: number | null,
  ): Promise<Result<RevisionReceipt>> {
    const blocked = ownApplicationDenied(actor, 'registration.reviseOwn')
    if (blocked || actor.kind !== 'authenticated') {
      return denied(blocked ?? 'UNAUTHENTICATED', '帳號已經開通；學號與屆別要更正請聯絡系辦。')
    }
    if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
      return err('VALIDATION_FAILED', '頁面資料不完整，請重新整理後再試。')
    }
    const normalized = normalizeApplicationFields(input)
    if (!normalized.ok) return normalized
    const fields = normalized.value

    const now = this.#clock.now()
    const tx = await this.#deps.db().connect()
    try {
      await tx.query('begin')
      // 先鎖這個人（同一個人兩個分頁同時送出時排隊），再看最新一筆申請。
      const user = await tx.query<{ email: string; status: string }>(
        'select email, status from users where id = $1 for update',
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
      const applicationId = await this.#insertApplication(
        tx,
        actor.userId,
        fields,
        loginEmail,
        now,
        latest ? 'registration.resubmit' : 'registration.apply',
      )
      await tx.query('commit')
      return ok({ applicationId, revision: 1 }, meta(now))
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
      }
    })

    return ok({ applications, cohorts, registrationOpenCohort: registrationOpen }, meta(this.#clock.now()))
  }

  async approve(
    actor: ResolvedActor,
    input: {
      applicationId: string
      revision: number
      verificationMethod: string
      verificationNote: string
      reason: string
      cohortId: string | null
      requestId: string
    },
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
      const cohort = resolveApprovalCohort(match, input.cohortId, cohorts)
      if (!cohort.ok) {
        await tx.query('rollback')
        return cohort
      }
      const cohortChoice = cohorts.find((c) => c.id === cohort.cohortId)!

      // 占用有效學號：同屆同學號只能有一個有效學生（唯一違反 → STUDENT_NO_TAKEN，整體回滾）。
      try {
        await tx.query(
          `insert into student_identities (cohort_id, student_no, user_id, created_at) values ($1, $2, $3, $4)`,
          [cohort.cohortId, row.student_no, row.user_id, now],
        )
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        await tx.query('rollback')
        return err(
          'STUDENT_NO_TAKEN',
          `學號 ${row.student_no} 在 ${cohortChoice.name} 已經有一個有效的帳號，不能再核准一個。請先確認是不是同一個人重複註冊。`,
        )
      }

      await tx.query(`update users set status = 'active', name = $2, updated_at = $3 where id = $1`, [
        row.user_id,
        row.applied_name,
        now,
      ])
      await tx.query(
        `insert into user_profiles
           (user_id, display_name, name_normalized, student_no, department_class, cohort_id, phone, contact_email,
            login_method_last, created_at, updated_at, updated_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'password', $9, $9, $10)
         on conflict (user_id) do update set
           display_name = excluded.display_name,
           name_normalized = excluded.name_normalized,
           student_no = excluded.student_no,
           department_class = excluded.department_class,
           cohort_id = excluded.cohort_id,
           phone = excluded.phone,
           contact_email = excluded.contact_email,
           revision = user_profiles.revision + 1,
           updated_at = excluded.updated_at,
           updated_by_user_id = excluded.updated_by_user_id`,
        [
          row.user_id,
          row.applied_name,
          normalizeName(row.applied_name),
          row.student_no,
          row.department_class,
          cohort.cohortId,
          row.phone,
          row.contact_email,
          now,
          actor.userId,
        ],
      )
      await tx.query(
        `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
         select $1, $2, 'student', $3, $4, $5
          where not exists (
            select 1 from role_assignments where user_id = $2 and role = 'student' and revoked_real_at is null
          )`,
        [uuidv7(), row.user_id, actor.userId, now, '註冊審核核准'],
      )
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
      return ok(receipt, meta(now, input.requestId))
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }

  async reject(
    actor: ResolvedActor,
    input: { applicationId: string; revision: number; reason: string; requestId: string },
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
      return ok(receipt, meta(now, input.requestId))
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }

  // ── 內部 ──────────────────────────────────────────────────────────────────

  /** 建一筆新的待審申請（第 1 版）＋快照＋稽核。回申請 ID。 */
  async #insertApplication(
    tx: PoolClient,
    userId: string,
    fields: ApplicationFields,
    loginEmail: string,
    now: Date,
    action: 'registration.apply' | 'registration.resubmit',
  ): Promise<string> {
    const id = uuidv7()
    const { match, rosterVersionId } = await this.#match(tx, fields, loginEmail)
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
    return id
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
    const rows = await tx.query<ApplicationRow & { user_status: string }>(
      `select ${APPLICATION_COLUMNS}, u.status as user_status
         from registration_applications ra
         join users u on u.id = ra.user_id
        where ra.id = $1
        for update of ra, u`,
      [applicationId],
    )
    const row = rows.rows[0]
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
