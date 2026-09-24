import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import {
  accountAdminDenied,
  adminGrantProblem,
  isOrphan,
  normalizeOrphanRepair,
  normalizeRoleChange,
  normalizeTeacherAccountInput,
  normalizeTemporaryPasswordRequest,
  remainingEffectiveAdmins,
  type AccountCommand,
  type AccountLookup,
  type AccountStatus,
  type OrphanRepairInput,
  type OrphanRepairReceipt,
  type ResolvedActor,
  type Role,
  type RoleChangeInput,
  type RoleChangeReceipt,
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
import { isEffectiveAdmin, lockAdmins } from '@/infrastructure/accounts/admin-guard'

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

  // ── 管理員角色（票 10b） ────────────────────────────────────────────────

  async grantRole(actor: ResolvedActor, input: RoleChangeInput): Promise<Result<RoleChangeReceipt>> {
    return this.#changeAdminRole(actor, input, 'grant')
  }

  async revokeRole(actor: ResolvedActor, input: RoleChangeInput): Promise<Result<RoleChangeReceipt>> {
    return this.#changeAdminRole(actor, input, 'revoke')
  }

  /**
   * 授予／取消管理員。
   *
   * 一個交易裡：鎖住全部有效的管理員角色列（`lockAdmins`）→ 確認操作者此刻仍是有效管理員 →
   * 鎖目標帳號 → 寫 `role_assignments` 與 `users.role` → 稽核 → 帳本。
   *
   * **為什麼要先鎖全部管理員列**：兩位管理員同時互相取消時，各自只看目標的話兩邊都會成功，
   * 系統就一位管理員都不剩。先鎖同一組列，後到的那一個會等前一個 commit，醒來時重讀
   * （READ COMMITTED 的 `for update` 會重新評估條件），就看得到自己已經不是管理員，然後被擋下。
   *
   * 不撤對方的 session：`ActorResolver` 每次請求重讀 `role_assignments`，而 cookie 快取關著
   * （`auth-instance.ts`），套件每次也是重讀 `users.role`——取消的下一個請求就沒有管理員權限了。
   */
  async #changeAdminRole(
    actor: ResolvedActor,
    input: RoleChangeInput,
    action: 'grant' | 'revoke',
  ): Promise<Result<RoleChangeReceipt>> {
    const blocked = accountAdminDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    if (!UUID_PATTERN.test(input.userId)) return err('VALIDATION_FAILED', '找不到這個帳號，請重新整理頁面。')
    if (!isRequestId(input.requestId)) return err('VALIDATION_FAILED', '這次送出缺少請求編號，請重新整理頁面再試。')
    const change = normalizeRoleChange(input)
    if (!change.ok) return change
    if (input.userId === actor.userId) {
      return err(
        'FORBIDDEN',
        action === 'grant' ? '不能替自己設定角色。' : '不能取消自己的管理員角色；請另一位管理員操作。',
      )
    }

    const now = this.#clock.now()
    const operationKind = action === 'grant' ? 'account.grant_role' : 'account.revoke_role'
    const fingerprint = sha256(canonicalJson({ userId: input.userId, role: change.value.role, reason: change.value.reason }))

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
        return err('REQUEST_MISMATCH', '這個請求編號已經用在別的操作上，請重新整理後再試。')
      }
      if (begun.outcome === 'replay') {
        await tx.query('commit')
        if (begun.receiptExpired) return err('RECEIPT_EXPIRED', '這次操作已經完成，回執已過期；請看帳號列表。')
        return ok(begun.receipt as RoleChangeReceipt, meta(now, input.requestId))
      }

      const admins = await lockAdmins(tx)
      if (!isEffectiveAdmin(admins, actor.userId)) {
        await tx.query('rollback')
        return denied('FORBIDDEN')
      }

      const target = await lockRoleTarget(tx, input.userId)
      if (!target) {
        await tx.query('rollback')
        return err('CONFLICT', '找不到這個帳號，請重新整理頁面。')
      }

      if (action === 'grant') {
        const problem = adminGrantProblem(target)
        if (problem) {
          await tx.query('rollback')
          return problem
        }
        await tx.query(
          `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
           values ($1, $2, 'admin', $3, $4, $5)`,
          [uuidv7(), target.userId, actor.userId, now, change.value.reason],
        )
        // Better Auth admin plugin 的套件欄：套件自己的管理員能力（停用撤 session、發臨時密碼、新增老師）看這一欄。
        await tx.query(`update users set role = 'admin', updated_at = $2 where id = $1`, [target.userId, now])
      } else {
        if (!target.roles.includes('admin')) {
          await tx.query('rollback')
          return err('CONFLICT', '這個帳號已經不是管理員了，請重新整理頁面。')
        }
        if (remainingEffectiveAdmins(admins, target.userId) < 1) {
          await tx.query('rollback')
          return err('CONFLICT', '這是最後一位管理員，不能取消；請先把另一個帳號設為管理員。')
        }
        await tx.query(
          `update role_assignments
              set revoked_by_user_id = $2, revoked_real_at = $3, reason = $4
            where user_id = $1 and role = 'admin' and revoked_real_at is null`,
          [target.userId, actor.userId, now, change.value.reason],
        )
        // 套件欄改回預設值（跟新增老師時套件給的一樣）。
        await tx.query(`update users set role = 'user', updated_at = $2 where id = $1`, [target.userId, now])
      }

      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: operationKind,
        targetType: 'user',
        targetId: target.userId,
        scope: 'global',
        reason: change.value.reason,
        realAt: now,
        businessAt: now,
        payload: { role: change.value.role },
      })
      const receipt: RoleChangeReceipt = {
        userId: target.userId,
        name: target.name,
        role: change.value.role,
        granted: action === 'grant',
        changedAt: now.toISOString(),
      }
      await this.#deps.ledger.commit(tx, begun.recordId, { receipt, resultRef: { userId: target.userId } })
      await tx.query('commit')
      return ok(receipt, meta(now, input.requestId))
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
  }

  // ── 孤兒帳號（票 10b） ──────────────────────────────────────────────────

  /**
   * 孤兒帳號補建角色。
   *
   * 等於把「新增老師」交易的後半段補做完（`createTeacher` 檔頭講的那種套件成功、我方失敗）：
   * 待審的一併開通（狀態事件）、補角色、稽核、帳本。補成管理員時跟 `grantRole` 一樣先鎖管理員列、
   * 同時寫 `users.role`。
   *
   * 不發密碼：系辦直接新增失敗留下的帳號有一組沒人知道的密碼，要用的話接著按「發臨時密碼」；
   * 預授權或用 Google 註冊的，本人用 Google 登入即可。
   */
  async repairOrphan(actor: ResolvedActor, input: OrphanRepairInput): Promise<Result<OrphanRepairReceipt>> {
    const blocked = accountAdminDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    if (!UUID_PATTERN.test(input.userId)) return err('VALIDATION_FAILED', '找不到這個帳號，請重新整理頁面。')
    if (!isRequestId(input.requestId)) return err('VALIDATION_FAILED', '這次送出缺少請求編號，請重新整理頁面再試。')
    const repair = normalizeOrphanRepair(input)
    if (!repair.ok) return repair
    if (input.userId === actor.userId) return err('FORBIDDEN', '不能替自己設定角色。')

    const now = this.#clock.now()
    const fingerprint = sha256(canonicalJson({ userId: input.userId, role: repair.value.role, reason: repair.value.reason }))

    const tx = await this.#deps.db().connect()
    try {
      await tx.query('begin')
      const begun = await this.#deps.ledger.begin(
        tx,
        { actorUserId: actor.userId, operationKind: 'account.repair_orphan', requestId: input.requestId, fingerprint, scope: 'global' },
        now,
      )
      if (begun.outcome === 'mismatch') {
        await tx.query('rollback')
        return err('REQUEST_MISMATCH', '這個請求編號已經用在別的操作上，請重新整理後再試。')
      }
      if (begun.outcome === 'replay') {
        await tx.query('commit')
        if (begun.receiptExpired) return err('RECEIPT_EXPIRED', '這次操作已經完成，回執已過期；請看帳號列表。')
        return ok(begun.receipt as OrphanRepairReceipt, meta(now, input.requestId))
      }

      if (repair.value.role === 'admin' && !isEffectiveAdmin(await lockAdmins(tx), actor.userId)) {
        await tx.query('rollback')
        return denied('FORBIDDEN')
      }

      const target = await lockRoleTarget(tx, input.userId)
      if (!target) {
        await tx.query('rollback')
        return err('CONFLICT', '找不到這個帳號，請重新整理頁面。')
      }
      // 鎖住之後重新判一次：本人剛好送出了申請、或別的管理員剛補好，就不是孤兒了。
      if (!isOrphan(target)) {
        await tx.query('rollback')
        return err('CONFLICT', '這個帳號已經不是孤兒帳號了（有角色、申請或個人資料），請重新整理頁面。')
      }

      const activated = target.status === 'pending'
      if (activated) {
        await tx.query(`update users set status = 'active', updated_at = $2 where id = $1`, [target.userId, now])
        await tx.query(
          `insert into user_status_events
             (id, user_id, from_status, to_status, reason, actor_kind, actor_user_id, real_at)
           values ($1, $2, 'pending', 'active', $3, 'user', $4, $5)`,
          [uuidv7(), target.userId, `孤兒帳號補建角色：${repair.value.reason}`, actor.userId, now],
        )
      }
      await tx.query(
        `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
         values ($1, $2, $3, $4, $5, $6)`,
        [uuidv7(), target.userId, repair.value.role, actor.userId, now, repair.value.reason],
      )
      if (repair.value.role === 'admin') {
        await tx.query(`update users set role = 'admin', updated_at = $2 where id = $1`, [target.userId, now])
      }
      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: 'account.repair_orphan',
        targetType: 'user',
        targetId: target.userId,
        scope: 'global',
        reason: repair.value.reason,
        realAt: now,
        businessAt: now,
        payload: { role: repair.value.role, activated },
      })
      const receipt: OrphanRepairReceipt = {
        userId: target.userId,
        name: target.name,
        role: repair.value.role,
        activated,
        changedAt: now.toISOString(),
      }
      await this.#deps.ledger.commit(tx, begun.recordId, { receipt, resultRef: { userId: target.userId } })
      await tx.query('commit')
      return ok(receipt, meta(now, input.requestId))
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
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

// ── 鎖 ──────────────────────────────────────────────────────────────────────

type RoleTargetRow = {
  readonly userId: string
  readonly name: string
  readonly status: AccountStatus
  readonly roles: Role[]
  readonly activeRoles: number
  readonly applications: number
  readonly hasProfile: boolean
}

/** 鎖目標帳號並讀出判斷授予與孤兒需要的事實。`for no key update`：跟發臨時密碼同一個理由。 */
async function lockRoleTarget(tx: PoolClient, userId: string): Promise<RoleTargetRow | null> {
  const locked = await tx.query<{ id: string; name: string; status: AccountStatus; deidentified_at: Date | null }>(
    'select id, name, status, deidentified_at from users where id = $1 for no key update',
    [userId],
  )
  const row = locked.rows[0]
  if (!row) return null
  const facts = await tx.query<{ roles: Role[] | null; applications: number; display_name: string | null; has_profile: boolean }>(
    `select (select array_agg(r.role order by r.role) from role_assignments r
              where r.user_id = $1 and r.revoked_real_at is null) as roles,
            (select count(*)::int from registration_applications a where a.user_id = $1) as applications,
            (select p.display_name from user_profiles p where p.user_id = $1) as display_name,
            exists (select 1 from user_profiles p where p.user_id = $1) as has_profile`,
    [userId],
  )
  const f = facts.rows[0]!
  const roles = f.roles ?? []
  return {
    userId: row.id,
    name: f.display_name ?? row.name,
    status: row.deidentified_at ? 'deidentified' : row.status,
    roles,
    activeRoles: roles.length,
    applications: f.applications,
    hasProfile: f.has_profile,
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
