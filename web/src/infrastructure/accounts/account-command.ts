import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import {
  accountAdminDenied,
  normalizeTeacherAccountInput,
  normalizeTemporaryPasswordRequest,
  type AccountCommand,
  type AccountLookup,
  type ResolvedActor,
  type Role,
  type TeacherAccountInput,
  type TeacherAccountReceipt,
  type TeacherCreatedWithSecret,
  type TemporaryPasswordReceipt,
} from '@/application/accounts'
import { isRequestId } from '@/application/cohorts'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import { defaultNextStep, type ErrorCode } from '@/shared/errors'
import { err, ok, type Err, type Result, type SecretOnce } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { internalAuth } from '@/infrastructure/auth/wrapper'
import { generateTemporaryPassword } from '@/infrastructure/accounts/temporary-password'

/**
 * 老師帳號與臨時密碼（工程模組 01 §3「臨時密碼」「老師建立／預授權」、§5 `AccountCommand`；
 * 契約 03 §2、§3；票 8）。
 *
 * 每個方法第一件事是授權（`accountAdminDenied`，規則在 application 層），第二件事是驗證輸入。
 * 全程用 `fju_app` 的權限（整合測試以 `fju_app` 跑）。
 *
 * **Better Auth 的呼叫與我們的交易怎麼排**（兩邊是不同的連線，沒辦法同一個交易）：
 *
 * - 新增老師：交易開著的時候呼叫 `createUser`（套件用自己的連線 insert `users` 並 commit），
 *   再在同一個交易裡把狀態改成 active、給老師角色、寫狀態事件與稽核、寫帳本，最後 commit。
 *   套件那一步成功、我們這一步失敗的話，會留下一個「待審、沒有角色、沒人知道密碼」的帳號，
 *   Email 被占住但沒有人登得進去；系辦重試會看到「這個 Email 已經有帳號」。跟學生註冊的
 *   兩步一樣（`registration-command.ts` 檔頭），不做自動認領——自動認領就等於讓別人
 *   先註冊一個同 Email 的帳號、再等系辦把它變成老師。
 * - 核發臨時密碼：**先 commit**（帳本、`must_change_password=true`、稽核），**再**呼叫
 *   `setUserPassword` 與 `revokeUserSessions`。反過來排的話，套件那一步成功、我們 commit 失敗，
 *   就會留下一組「有效、沒有強制改密、沒有稽核」的臨時密碼。現在的排法萬一套件失敗，
 *   只是「舊密碼還能用＋下次登入要改密碼」，再補一筆失敗稽核、把帳本標成 failed（同一個請求
 *   重送不會回「已核發」，票 10b），系辦重新核發即可。
 *
 * **秘密只在回應本體**：帳本的 receipt、fingerprint、稽核的 payload 都不含臨時密碼；
 * 同一個請求重送（帳本重播）只回「已核發」的回執，密碼無法取回（契約 03 §3）。
 */

/** 這支用例會碰到的 Better Auth 管理員能力（預設走 `internalAuth`；測試可以換掉來模擬失敗）。 */
export type AccountAuthCalls = {
  createUser(headers: Headers, input: { email: string; name: string; password?: string }): Promise<{ userId: string }>
  setUserPassword(headers: Headers, input: { userId: string; newPassword: string }): Promise<void>
  revokeUserSessions(headers: Headers, input: { userId: string }): Promise<void>
}

export const betterAuthAccountCalls: AccountAuthCalls = {
  async createUser(headers, input) {
    const created = await internalAuth.createUser(headers, input)
    return { userId: String(created.user.id) }
  },
  async setUserPassword(headers, input) {
    await internalAuth.setUserPassword(headers, input)
  },
  async revokeUserSessions(headers, input) {
    await internalAuth.revokeUserSessions(headers, input)
  },
}

export type AccountCommandDeps = {
  readonly audit: AuditWriter<PoolClient>
  readonly ledger: OperationLedger<PoolClient>
  readonly db: () => Pool
  readonly auth?: AccountAuthCalls
  readonly generatePassword?: () => string
  readonly clock?: Clock
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function meta(now: Date, requestId = uuidv7()) {
  return { requestId, serverTime: now.toISOString() }
}

function denied(code: ErrorCode): Err {
  const messages: Partial<Record<ErrorCode, string>> = {
    UNAUTHENTICATED: '請先登入。',
    FORBIDDEN: '只有系辦可以管理帳號。',
    PASSWORD_CHANGE_REQUIRED: '請先修改密碼。',
    ACCOUNT_PENDING: '帳號還在審核中。',
  }
  return err(code, messages[code] ?? '無法執行這個動作。', { next: defaultNextStep(code) })
}

const EMAIL_TAKEN_MESSAGE = '這個 Email 已經有帳號了，不能再新增一個。'

const TEMP_PASSWORD_FAILED_MESSAGE = '密碼沒有設定成功，這個人的舊密碼仍然有效。請關閉後重新核發一次。'

function isEmailTaken(error: unknown): boolean {
  const e = error as { body?: { code?: string }; code?: string }
  return (
    e?.body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' ||
    e?.body?.code === 'USER_ALREADY_EXISTS' ||
    e?.code === '23505'
  )
}

export class PgAccountCommand implements AccountCommand {
  readonly #deps: AccountCommandDeps
  readonly #clock: Clock
  readonly #auth: AccountAuthCalls
  readonly #generatePassword: () => string

  constructor(deps: AccountCommandDeps) {
    this.#deps = deps
    this.#clock = deps.clock ?? new RealClock()
    this.#auth = deps.auth ?? betterAuthAccountCalls
    this.#generatePassword = deps.generatePassword ?? (() => generateTemporaryPassword())
  }

  // ── 新增老師 ──────────────────────────────────────────────────────────────

  async createTeacher(
    actor: ResolvedActor,
    authHeaders: Headers,
    input: TeacherAccountInput & { requestId: string },
  ): Promise<Result<TeacherAccountReceipt> | TeacherCreatedWithSecret> {
    const blocked = accountAdminDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    if (!isRequestId(input.requestId)) return err('VALIDATION_FAILED', '這次送出缺少請求編號，請重新打開對話框再試。')
    const normalized = normalizeTeacherAccountInput(input)
    if (!normalized.ok) return normalized
    const account = normalized.value

    const now = this.#clock.now()
    const fingerprint = sha256(
      canonicalJson({ mode: account.mode, email: account.email, name: account.name, verification: account.verification }),
    )
    const operationKind = account.mode === 'direct' ? 'account.create_teacher' : 'account.preauthorize_teacher'

    const tx = await this.#deps.db().connect()
    try {
      await tx.query('begin')
      const begun = await this.#deps.ledger.begin(
        tx,
        { actorUserId: actor.userId, operationKind, requestId: input.requestId, fingerprint, scope: 'global' },
        now,
      )
      if (begun.outcome === 'mismatch') {
        await tx.query('rollback')
        return err('REQUEST_MISMATCH', '這個請求編號已經用在別的操作上，請重新打開對話框再試。')
      }
      if (begun.outcome === 'replay') {
        await tx.query('commit')
        if (begun.receiptExpired) return err('RECEIPT_EXPIRED', '這個老師帳號已經建好了，回執已過期。')
        // 重播沒有秘密：直接新增的臨時密碼無法取回，畫面會請系辦重新核發。
        return ok(begun.receipt as TeacherAccountReceipt, meta(now, input.requestId))
      }

      const existing = await tx.query('select 1 from users where lower(email) = $1', [account.email])
      if (existing.rowCount) {
        await tx.query('rollback')
        return err('VALIDATION_FAILED', EMAIL_TAKEN_MESSAGE, { details: { field: 'email' } })
      }

      const password = account.mode === 'direct' ? this.#generatePassword() : undefined
      let userId: string
      try {
        // 預授權沒填姓名時，先用 Email 當 `users.name`（欄位不能空）；老師第一次登入會補正式姓名。
        const created = await this.#auth.createUser(authHeaders, {
          email: account.email,
          name: account.name ?? account.email,
          ...(password ? { password } : {}),
        })
        userId = created.userId
      } catch (error) {
        await tx.query('rollback').catch(() => undefined)
        if (isEmailTaken(error)) return err('VALIDATION_FAILED', EMAIL_TAKEN_MESSAGE, { details: { field: 'email' } })
        throw error
      }

      // 套件的 `user.create.before` 一律把新帳號壓成 pending（契約 03 §2）；老師由系辦建立，直接開通。
      await tx.query(
        `update users set status = 'active', must_change_password = $2, updated_at = $3 where id = $1`,
        [userId, account.mode === 'direct', now],
      )
      await tx.query(
        `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
         values ($1, $2, 'teacher', $3, $4, $5)`,
        [uuidv7(), userId, actor.userId, now, account.mode === 'direct' ? '系辦新增老師' : '系辦預授權老師'],
      )
      await tx.query(
        `insert into user_status_events
           (id, user_id, from_status, to_status, reason, verification_method, actor_kind, actor_user_id, real_at)
         values ($1, $2, 'pending', 'active', $3, $4, 'user', $5, $6)`,
        [
          uuidv7(),
          userId,
          account.mode === 'direct' ? '系辦新增老師' : '系辦預授權老師',
          account.verification?.verificationMethod ?? null,
          actor.userId,
          now,
        ],
      )
      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: operationKind,
        targetType: 'user',
        targetId: userId,
        scope: 'global',
        verificationMethod: account.verification?.verificationMethod ?? null,
        realAt: now,
        businessAt: now,
        // 不含臨時密碼（契約 03 §3）；只記「有沒有發」。
        payload: {
          email: account.email,
          mode: account.mode,
          temporaryPasswordIssued: account.mode === 'direct',
          verificationNote: account.verification?.verificationNote ?? null,
        },
      })

      const receipt: TeacherAccountReceipt = {
        userId,
        email: account.email,
        name: account.name,
        mode: account.mode,
        createdAt: now.toISOString(),
        temporaryPasswordIssued: account.mode === 'direct',
      }
      await this.#deps.ledger.commit(tx, begun.recordId, { receipt, resultRef: { userId } })
      await tx.query('commit')

      if (!password) return ok(receipt, meta(now, input.requestId))
      return { ...secretOnce(password, now, input.requestId, actor.userId), account: receipt }
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }

  // ── 查帳號 ────────────────────────────────────────────────────────────────

  async lookupByEmail(actor: ResolvedActor, email: string): Promise<Result<AccountLookup>> {
    const blocked = accountAdminDenied(actor)
    if (blocked) return denied(blocked)
    const wanted = email.trim().toLowerCase()
    if (!wanted || wanted.length > 254) {
      return err('VALIDATION_FAILED', '請輸入要發臨時密碼的登入 Email。', { details: { field: 'email' } })
    }
    const found = await this.#deps.db().query<{
      id: string
      name: string
      email: string
      status: AccountLookup['status']
      deidentified_at: Date | null
      roles: Role[] | null
    }>(
      `select u.id, u.name, u.email, u.status, u.deidentified_at,
              array_remove(array_agg(ra.role order by ra.role), null) as roles
         from users u
         left join role_assignments ra on ra.user_id = u.id and ra.revoked_real_at is null
        where lower(u.email) = $1
        group by u.id`,
      [wanted],
    )
    const row = found.rows[0]
    if (!row) return err('VALIDATION_FAILED', '找不到這個 Email 的帳號。', { details: { field: 'email' } })
    return ok(
      {
        userId: row.id,
        name: row.name,
        email: row.email,
        roles: row.roles ?? [],
        status: row.deidentified_at ? 'deidentified' : row.status,
      },
      meta(this.#clock.now()),
    )
  }

  // ── 臨時密碼 ──────────────────────────────────────────────────────────────

  async issueTemporaryPassword(
    actor: ResolvedActor,
    authHeaders: Headers,
    input: { userId: string; verificationMethod: string; verificationNote: string; reason: string; requestId: string },
  ): Promise<Result<TemporaryPasswordReceipt> | SecretOnce> {
    const blocked = accountAdminDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    if (!UUID_PATTERN.test(input.userId)) return err('VALIDATION_FAILED', '找不到這個帳號，請重新查詢。')
    if (!isRequestId(input.requestId)) return err('VALIDATION_FAILED', '這次送出缺少請求編號，請重新打開對話框再試。')
    if (input.userId === actor.userId) {
      // 替自己發會把自己目前的登入撤掉；要改自己的密碼走「更改密碼」。
      return err('VALIDATION_FAILED', '不能替自己發臨時密碼；要換自己的密碼請到「更改密碼」。')
    }
    const decision = normalizeTemporaryPasswordRequest(input)
    if (!decision.ok) return decision

    const now = this.#clock.now()
    // 指紋只含「對誰、依什麼核實」；臨時密碼是之後才產生的，本來就不在裡面。
    const fingerprint = sha256(canonicalJson({ userId: input.userId, ...decision.value }))

    const tx = await this.#deps.db().connect()
    let receipt: TemporaryPasswordReceipt
    let recordId: string
    try {
      await tx.query('begin')
      const begun = await this.#deps.ledger.begin(
        tx,
        {
          actorUserId: actor.userId,
          operationKind: 'account.issue_temporary_password',
          requestId: input.requestId,
          fingerprint,
          scope: 'global',
        },
        now,
      )
      if (begun.outcome === 'mismatch') {
        await tx.query('rollback')
        return err('REQUEST_MISMATCH', '這個請求編號已經用在別的操作上，請重新打開對話框再試。')
      }
      if (begun.outcome === 'replay') {
        await tx.query('commit')
        // 上次 commit 之後 `setUserPassword` 失敗、帳本已標 failed（票 10b）：不能回「已核發」，
        // 那組密碼根本沒生效。請系辦重新核發（對話框會換一個新的請求編號）。
        if (begun.state === 'failed') return err('INTERNAL', TEMP_PASSWORD_FAILED_MESSAGE)
        if (begun.receiptExpired) return err('RECEIPT_EXPIRED', '這組臨時密碼已經核發過了，回執已過期。')
        return ok(begun.receipt as TemporaryPasswordReceipt, meta(now, input.requestId))
      }
      recordId = begun.recordId

      // `for no key update`：之後套件補建 credential 帳號時，`accounts` 的外鍵檢查要對這一列拿
      // key share 鎖；用 `for update` 的話兩邊會互等（雖然我們先 commit 才呼叫，仍不留這個坑）。
      const target = await tx.query<{ id: string; status: string; deidentified_at: Date | null }>(
        'select id, status, deidentified_at from users where id = $1 for no key update',
        [input.userId],
      )
      const row = target.rows[0]
      if (!row) {
        await tx.query('rollback')
        return err('VALIDATION_FAILED', '找不到這個帳號，請重新查詢。')
      }
      if (row.deidentified_at || row.status === 'disabled') {
        await tx.query('rollback')
        return err('VALIDATION_FAILED', '這個帳號已停用，登不進來；要發臨時密碼請先還原帳號。')
      }

      await tx.query('update users set must_change_password = true, updated_at = $2 where id = $1', [row.id, now])
      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: 'account.issue_temporary_password',
        targetType: 'user',
        targetId: row.id,
        scope: 'global',
        reason: decision.value.reason,
        verificationMethod: decision.value.verificationMethod,
        realAt: now,
        businessAt: now,
        // 不含臨時密碼（契約 03 §3）。
        payload: { verificationNote: decision.value.verificationNote },
      })
      receipt = { userId: row.id, verificationMethod: decision.value.verificationMethod, issuedAt: now.toISOString() }
      await this.#deps.ledger.commit(tx, begun.recordId, { receipt, resultRef: { userId: row.id } })
      await tx.query('commit')
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }

    const password = this.#generatePassword()
    try {
      await this.#auth.setUserPassword(authHeaders, { userId: input.userId, newPassword: password })
    } catch (error) {
      console.error('[account] 臨時密碼寫入失敗（稽核已記核發，舊密碼仍有效、下次登入要改密碼）', errorName(error))
      await this.#recordFailure(actor.userId, input.userId, recordId, now).catch((failure: unknown) =>
        console.error('[account] 臨時密碼失敗的稽核／帳本標記寫入失敗', errorName(failure)),
      )
      return err('INTERNAL', TEMP_PASSWORD_FAILED_MESSAGE)
    }
    try {
      await this.#auth.revokeUserSessions(authHeaders, { userId: input.userId })
    } catch (error) {
      // 不回錯：舊登入已經被 must-change 限制成只能改密碼，而改密碼要知道這組新的臨時密碼。
      console.error('[account] 撤銷舊登入失敗（已被 must-change 限制）', errorName(error))
    }
    return secretOnce(password, now, input.requestId, actor.userId)
  }

  /**
   * 套件那一步失敗時補一筆稽核，並把帳本那一列標成 failed（票 10b），免得稽核與重播只看得到「已核發」。
   * 兩件事同一個交易：要嘛都寫進去，要嘛都沒有。
   */
  async #recordFailure(actorUserId: string, userId: string, recordId: string, now: Date): Promise<void> {
    const tx = await this.#deps.db().connect()
    try {
      await tx.query('begin')
      await this.#deps.ledger.markFailed(tx, recordId)
      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId,
        role: 'admin',
        action: 'account.issue_temporary_password_failed',
        targetType: 'user',
        targetId: userId,
        scope: 'global',
        realAt: now,
        businessAt: now,
        payload: {},
      })
      await tx.query('commit')
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }
}

function secretOnce(secret: string, now: Date, requestId: string, issuedBy: string): SecretOnce {
  return {
    ok: true,
    secret,
    issuedAt: now.toISOString(),
    expiresAt: null,
    receipt: { requestId, kind: 'temp_password', issuedBy },
  }
}

/** log 只記錯誤的名字，不記內容：套件的錯誤物件可能帶著請求內容（含新密碼）。 */
function errorName(error: unknown): string {
  const e = error as { name?: string; status?: string; body?: { code?: string } }
  return [e?.name, e?.status, e?.body?.code].filter(Boolean).join(' ') || 'unknown error'
}
