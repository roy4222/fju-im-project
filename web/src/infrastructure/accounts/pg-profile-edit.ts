import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import {
  accountAdminDenied,
  normalizeName,
  canChangeCohort,
  canChangeRole,
  mainRoleOf,
  membershipPhrase,
  normalizeProfileEdit,
  remainingEffectiveAdmins,
  profileEditRowBlocker,
  studentNoTakenMessage,
  type ActiveMembership,
  type MainRole,
  type ProfileEditCommand,
  type ProfileEditInput,
  type ProfileEditReceipt,
  type ProfileEditView,
  type RoleChangeFacts,
  type AccountStatus,
  type ResolvedActor,
  type Role,
} from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import { defaultNextStep, type ErrorCode } from '@/shared/errors'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'
import { bustIdentity } from '@/infrastructure/auth/identity-cache'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { betterAuthAccountCalls, type AccountAuthCalls } from '@/infrastructure/accounts/account-command'
import { isEffectiveAdmin, lockAdmins } from '@/infrastructure/accounts/admin-guard'
import { occupyStudentNo, studentNoHolder } from '@/infrastructure/accounts/student-identities'

/**
 * 帳號列「編輯」（C 階段規格② §3.2 X10、§3.8 調屆、§3.9 學生↔老師互轉；票 C2-08）。
 *
 * 一個交易裡：鎖目標帳號 → 重讀前置條件（四張表只讀：`group_memberships`、`submission_versions`、
 * `advisor_assignments`、`evaluator_assignments`）→ `user_profiles` → `student_identities` 舊列刪新列插
 * （主鍵擋同屆同學號）→ `role_assignments` 撤舊插新 → 收件名單（舊屆移出、新屆截止前的個人收件加入）→
 * 稽核 `account.profile_edit`（before/after 含 `role`）→ 帳本。
 *
 * 主角色換了：commit 後撤對方所有登入（`revokeUserSessions`）＋丟身分快取，跟發臨時密碼同一個排法
 * （`account-command.ts`）——對方下一個請求就是未登入，重登才拿到新身分。只改姓名、學號、屆別不撤登入，
 * 只丟身分快取（下一個請求照新屆別）。
 *
 * 管理員勾不在這裡：畫面沿用既有的 `grantRole`／`revokeRole`（另記 `account.grant_role`／`revoke_role`）。
 * 學生不能是管理員（`adminGrantProblem`），所以管理員要改成學生時，畫面先取消管理員；這裡再擋一次。
 */

export type ProfileEditDeps = {
  readonly audit: AuditWriter<PoolClient>
  readonly ledger: OperationLedger<PoolClient>
  readonly db: () => Pool
  readonly businessClock: BusinessClockSource
  readonly auth?: AccountAuthCalls
  readonly clock?: Clock
}

const OPERATION = 'account.profile_edit'
const REMOVED_BY_COHORT = '改屆別'
const REMOVED_BY_ROLE = '改成老師'

function meta(now: Date, requestId: string) {
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

type Target = {
  readonly userId: string
  readonly name: string
  readonly loginEmail: string
  readonly status: AccountStatus
  readonly orphan: boolean
  readonly roles: Role[]
  readonly hasProfile: boolean
  readonly studentNo: string | null
  readonly cohortId: string | null
  readonly cohortCode: string | null
  readonly facts: RoleChangeFacts
}

type Snapshot = { name: string; studentNo: string | null; cohortId: string | null; cohortCode: string | null; role: MainRole | null }

export class PgProfileEditCommand implements ProfileEditCommand {
  readonly #deps: ProfileEditDeps
  readonly #clock: Clock
  readonly #auth: AccountAuthCalls

  constructor(deps: ProfileEditDeps) {
    this.#deps = deps
    this.#clock = deps.clock ?? new RealClock()
    this.#auth = deps.auth ?? betterAuthAccountCalls
  }

  async view(actor: ResolvedActor, userId: string): Promise<Result<ProfileEditView>> {
    const blocked = accountAdminDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    if (!isUuid(userId)) return err('VALIDATION_FAILED', '找不到這個帳號，請重新整理頁面。')
    const now = this.#clock.now()
    const db = this.#deps.db()
    const target = await readTarget(db, userId, false)
    if (!target) return err('CONFLICT', '找不到這個帳號，請重新整理頁面。')
    const rowBlocked = profileEditRowBlocker(target, actor.userId)
    if (rowBlocked) return err('CONFLICT', rowBlocked)
    const cohorts = await db.query<{ id: string; code: string; name: string }>(
      `select id, code, name from cohorts where status <> 'archived' order by code desc`,
    )
    const role = mainRoleOf(target.roles)
    const lock = canChangeCohort(target.facts.memberships)
    return ok(
      {
        userId: target.userId,
        name: target.name,
        loginEmail: target.loginEmail,
        roles: target.roles,
        role,
        studentNo: target.studentNo,
        cohortId: target.cohortId,
        cohorts: cohorts.rows,
        cohortLock: lock.ok ? null : { reason: lock.reason, groupId: lock.groupId },
        toTeacherBlocked: role === 'student' ? canChangeRole(role, 'teacher', target.facts) : null,
        toTeacherGroupLink:
          role === 'student' && target.facts.memberships[0]
            ? { text: membershipPhrase(target.facts.memberships[0]), groupId: target.facts.memberships[0].groupId }
            : null,
        toStudentBlocked: role === 'teacher' ? canChangeRole(role, 'student', target.facts) : null,
      },
      meta(now, uuidv7()),
    )
  }

  async edit(actor: ResolvedActor, authHeaders: Headers, input: ProfileEditInput): Promise<Result<ProfileEditReceipt>> {
    const blocked = accountAdminDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    const normalized = normalizeProfileEdit(input)
    if (!normalized.ok) return normalized
    const edit = normalized.value

    const now = this.#clock.now()
    const businessAt = await this.#deps.businessClock.now()
    const fingerprint = sha256(
      canonicalJson({ userId: edit.userId, name: edit.name, role: edit.role, studentNo: edit.studentNo, cohortId: edit.cohortId, admin: edit.admin }),
    )

    let receipt: ProfileEditReceipt
    const tx = await this.#deps.db().connect()
    try {
      await tx.query('begin')
      const begun = await this.#deps.ledger.begin(
        tx,
        { actorUserId: actor.userId, operationKind: OPERATION, requestId: edit.requestId, fingerprint, scope: 'global' },
        now,
      )
      if (begun.outcome === 'mismatch') {
        await tx.query('rollback')
        return err('REQUEST_MISMATCH', '這個請求編號已經用在別的操作上，請重新整理後再試。')
      }
      if (begun.outcome === 'replay') {
        await tx.query('commit')
        if (begun.receiptExpired) return err('RECEIPT_EXPIRED', '這次操作已經完成，回執已過期；請看帳號列表。')
        // 重送也要把撤 session 做完（上一次可能就是撤銷失敗才重送的）。
        return this.#finish(authHeaders, begun.receipt as ProfileEditReceipt, now, edit.requestId)
      }
      const fail = async (code: ErrorCode, message: string, field?: string) => {
        await tx.query('rollback')
        return err(code, message, field ? { details: { field } } : undefined)
      }

      // 管理員勾跟個資同一個交易（Review 第 1 輪第 3 項）：要動管理員就先鎖整組管理員列，**再**鎖目標帳號
      // （跟 `account-command.ts` 的 grant／revoke 同一個鎖序，不會互相死結）。
      const admins = edit.admin === null ? null : await lockAdmins(tx)
      if (admins && !isEffectiveAdmin(admins, actor.userId)) {
        await tx.query('rollback')
        return denied('FORBIDDEN')
      }

      const target = await readTarget(tx, edit.userId, true)
      if (!target) return fail('CONFLICT', '找不到這個帳號，請重新整理頁面。')

      const rowBlocked = profileEditRowBlocker(target, actor.userId)
      if (rowBlocked) return fail('CONFLICT', rowBlocked)

      const from = mainRoleOf(target.roles)
      const roleBlocked = canChangeRole(from, edit.role, target.facts)
      if (roleBlocked) return fail('CONFLICT', roleBlocked, 'role')
      const wasAdmin = target.roles.includes('admin')
      const adminChange = edit.admin === null || edit.admin === wasAdmin ? null : edit.admin ? 'grant' : 'revoke'
      if (edit.role === 'student' && wasAdmin && adminChange !== 'revoke') {
        return fail('CONFLICT', '管理員不能改成學生；請先取消管理員。', 'role')
      }
      if (adminChange === 'revoke' && admins && remainingEffectiveAdmins(admins, target.userId) < 1) {
        return fail('CONFLICT', '這是最後一位管理員，不能取消；請先把另一個帳號設為管理員。', 'admin')
      }

      let cohortCode: string | null = null
      if (edit.role === 'student' && edit.cohortId) {
        const cohortChanged = edit.cohortId !== target.cohortId
        if (cohortChanged) {
          const lock = canChangeCohort(target.facts.memberships)
          if (!lock.ok) return fail('CONFLICT', lock.reason, 'cohortId')
        }
        const cohort = await tx.query<{ code: string; status: string }>(`select code, status from cohorts where id = $1`, [edit.cohortId])
        const row = cohort.rows[0]
        if (!row) return fail('VALIDATION_FAILED', '找不到這一屆，請重新選屆別。', 'cohortId')
        if (cohortChanged && row.status === 'archived') return fail('VALIDATION_FAILED', '這一屆已經封存，不能改到這一屆。', 'cohortId')
        cohortCode = row.code
      }

      const before: Snapshot = { name: target.name, studentNo: target.studentNo, cohortId: target.cohortId, cohortCode: target.cohortCode, role: from }
      const after: Snapshot = { name: edit.name, studentNo: edit.studentNo, cohortId: edit.cohortId, cohortCode, role: edit.role }
      // 職員沒有學號屆別；老師一律清空（§3.9）。
      if (edit.role === null) {
        after.studentNo = target.studentNo
        after.cohortId = target.cohortId
        after.cohortCode = target.cohortCode
      }

      // 學號占用先查（忽略大小寫，Review 第 1 輪第 1 項）：主鍵大小寫敏感，擋不住 `abc123` 對上已存在的 `ABC123`。
      const identityChanged = after.studentNo !== before.studentNo || after.cohortId !== before.cohortId || from !== edit.role
      if (identityChanged && edit.role === 'student' && after.cohortId && after.studentNo) {
        if (await studentNoHolder(tx, after.cohortId, after.studentNo, target.userId)) {
          return fail('CONFLICT', studentNoTakenMessage(cohortCode ?? ''), 'studentNo')
        }
      }

      // 1. 個人資料（老師還沒補資料、職員可能沒有這一列：補一列，聯絡 Email 先用登入 Email）。
      if (target.hasProfile) {
        await tx.query(
          `update user_profiles
              set display_name = $2, name_normalized = $3, student_no = $4, cohort_id = $5,
                  profile_completed_at = case when $6 then coalesce(profile_completed_at, $7) else profile_completed_at end,
                  revision = revision + 1, updated_at = $7, updated_by_user_id = $8
            where user_id = $1`,
          [target.userId, after.name, normalizeName(after.name), after.studentNo, after.cohortId, from === 'student' && edit.role === 'teacher', now, actor.userId],
        )
      } else {
        await tx.query(
          `insert into user_profiles
             (user_id, display_name, name_normalized, student_no, cohort_id, contact_email, created_at, updated_at, updated_by_user_id)
           values ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
          [target.userId, after.name, normalizeName(after.name), after.studentNo, after.cohortId, target.loginEmail, now, actor.userId],
        )
      }

      // 2. 學號占用：舊列刪、新列插（一律存大寫；主鍵再擋一次同時送出的人）。
      if (identityChanged && edit.role !== null) {
        await tx.query(`delete from student_identities where user_id = $1`, [target.userId])
        if (edit.role === 'student') {
          await tx.query('savepoint occupy')
          try {
            await occupyStudentNo(tx, after.cohortId!, after.studentNo!, target.userId, now)
          } catch (error) {
            if ((error as { code?: string }).code !== '23505') throw error
            return fail('CONFLICT', studentNoTakenMessage(cohortCode ?? ''), 'studentNo')
          }
          await tx.query('release savepoint occupy')
        }
      }

      // 3. 主角色：撤舊列、插新列。
      const roleChanged = from !== edit.role
      if (roleChanged && from && edit.role) {
        await tx.query(
          `update role_assignments set revoked_by_user_id = $3, revoked_real_at = $4
            where user_id = $1 and role = $2 and revoked_real_at is null`,
          [target.userId, from, actor.userId, now],
        )
        await tx.query(
          `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
           values ($1, $2, $3, $4, $5, '編輯帳號')`,
          [uuidv7(), target.userId, edit.role, actor.userId, now],
        )
      }

      // 3b. 管理員勾：沿用既有 grant／revoke 的寫法（含套件欄 `users.role`），另記 `account.grant_role`／`revoke_role`。
      if (adminChange === 'grant') {
        await tx.query(
          `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
           values ($1, $2, 'admin', $3, $4, '編輯帳號')`,
          [uuidv7(), target.userId, actor.userId, now],
        )
        await tx.query(`update users set role = 'admin', updated_at = $2 where id = $1`, [target.userId, now])
      } else if (adminChange === 'revoke') {
        await tx.query(
          `update role_assignments set revoked_by_user_id = $2, revoked_real_at = $3
            where user_id = $1 and role = 'admin' and revoked_real_at is null`,
          [target.userId, actor.userId, now],
        )
        await tx.query(`update users set role = 'user', updated_at = $2 where id = $1`, [target.userId, now])
      }
      if (adminChange) {
        await this.#deps.audit.append(tx, {
          actorKind: 'user',
          actorUserId: actor.userId,
          role: 'admin',
          action: adminChange === 'grant' ? 'account.grant_role' : 'account.revoke_role',
          targetType: 'user',
          targetId: target.userId,
          scope: 'global',
          realAt: now,
          businessAt,
          payload: { role: 'admin' },
        })
      }

      // 4. 收件名單：不在新屆的目前名單列移出；新屆截止前的個人收件加入。
      const rosterChanged = before.cohortId !== after.cohortId || roleChanged
      if (rosterChanged && edit.role !== null) {
        await tx.query(
          `update response_rosters
              set eligible_to_business_at = greatest($3::timestamptz, eligible_from_business_at), removed_reason = $4,
                  revision = revision + 1, updated_at = $5, updated_by_user_id = $6
            where receiver_kind = 'user' and receiver_id = $1 and eligible_to_business_at is null
              and ($2::uuid is null or cohort_id <> $2::uuid)`,
          [target.userId, after.cohortId, businessAt, roleChanged ? REMOVED_BY_ROLE : REMOVED_BY_COHORT, now, actor.userId],
        )
        if (edit.role === 'student' && after.cohortId && target.status === 'active') {
          await tx.query(
            `insert into response_rosters
               (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source,
                created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
             select gen_random_uuid(), m.id, m.cohort_id, 'user', $2, $3, 'auto', $4, 'user', $5, $4, $5
               from managed_items m
              where m.cohort_id = $1 and m.status = 'published' and m.placement in ('submission', 'requirement')
                and m.receiver_unit = 'individual' and m.audience_kind <> 'groups' and m.deleted_at is null
                and (m.due_at is null or m.due_at > $3)
                and not exists (select 1 from response_rosters r
                                 where r.item_id = m.id and r.receiver_kind = 'user' and r.receiver_id = $2
                                   and r.eligible_to_business_at is null)
              order by m.id`,
            [after.cohortId, target.userId, businessAt, now, actor.userId],
          )
        }
      }

      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: OPERATION,
        targetType: 'user',
        targetId: target.userId,
        scope: 'global',
        realAt: now,
        businessAt,
        payload: { before, after },
      })
      receipt = {
        userId: target.userId,
        name: after.name,
        role: edit.role,
        cohortCode: after.cohortCode,
        roleChanged,
        admin: adminChange ? adminChange === 'grant' : wasAdmin,
        changedAt: now.toISOString(),
      }
      await this.#deps.ledger.commit(tx, begun.recordId, { receipt, resultRef: { userId: target.userId } })
      await tx.query('commit')
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }

    return this.#finish(authHeaders, receipt, now, edit.requestId)
  }

  /**
   * commit（或重送）之後：主角色換了就撤對方所有登入，再丟身分快取。
   * 撤銷失敗回可重試的錯誤（Review 第 1 輪第 4 項）：同一個請求編號再送一次會走重送、補撤，不會重做寫入。
   */
  async #finish(authHeaders: Headers, receipt: ProfileEditReceipt, now: Date, requestId: string): Promise<Result<ProfileEditReceipt>> {
    if (receipt.roleChanged) {
      try {
        await this.#auth.revokeUserSessions(authHeaders, { userId: receipt.userId })
      } catch (error) {
        console.error('[account] 編輯帳號後撤銷登入失敗', (error as { name?: string })?.name ?? 'unknown error')
        bustIdentity(receipt.userId)
        return err('INTERNAL', '資料已經存好，但沒能登出他原本的登入。請再按一次「儲存」（不會重複做）。')
      }
    }
    bustIdentity(receipt.userId)
    return ok(receipt, meta(now, requestId))
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/** 讀目標帳號與四張前置表的計數；`lock` 時先鎖帳號列（跟發臨時密碼、改角色同一個鎖法）。 */
async function readTarget(db: Pick<Pool, 'query'> | PoolClient, userId: string, lock: boolean): Promise<Target | null> {
  const user = await db.query<{ id: string; name: string; email: string; status: AccountStatus; deidentified_at: Date | null }>(
    `select id, name, email, status, deidentified_at from users where id = $1${lock ? ' for no key update' : ''}`,
    [userId],
  )
  const u = user.rows[0]
  if (!u) return null
  const facts = await db.query<{
    roles: Role[] | null
    applications: number
    has_profile: boolean
    display_name: string | null
    student_no: string | null
    cohort_id: string | null
    cohort_code: string | null
    submissions: number
    advising: number
    evaluating: number
  }>(
    `select (select array_agg(r.role order by r.role) from role_assignments r
              where r.user_id = $1 and r.revoked_real_at is null) as roles,
            (select count(*)::int from registration_applications a where a.user_id = $1) as applications,
            p.user_id is not null as has_profile, p.display_name,
            coalesce(si.student_no, p.student_no) as student_no, coalesce(si.cohort_id, p.cohort_id) as cohort_id,
            c.code as cohort_code,
            (select count(*)::int from submission_versions v where v.submitted_by_user_id = $1) as submissions,
            (select count(*)::int from advisor_assignments a where a.teacher_user_id = $1 and a.valid_to is null) as advising,
            (select count(*)::int from evaluator_assignments e where e.teacher_user_id = $1 and e.valid_to is null) as evaluating
       from (select $1::uuid as id) me
       left join user_profiles p on p.user_id = me.id
       left join student_identities si on si.user_id = me.id
       left join cohorts c on c.id = coalesce(si.cohort_id, p.cohort_id)`,
    [userId],
  )
  const f = facts.rows[0]!
  const memberships = await db.query<{ group_id: string; group_code: string; cohort_code: string }>(
    `select g.id as group_id, g.code as group_code, c.code as cohort_code
       from group_memberships m
       join groups g on g.id = m.group_id
       join cohorts c on c.id = m.cohort_id
      where m.user_id = $1 and m.valid_to is null
      order by c.code desc, g.code`,
    [userId],
  )
  const roles = f.roles ?? []
  const activeMemberships: ActiveMembership[] = memberships.rows.map((m) => ({ groupId: m.group_id, groupCode: m.group_code, cohortCode: m.cohort_code }))
  return {
    userId: u.id,
    name: f.display_name ?? u.name,
    loginEmail: u.email,
    status: u.deidentified_at ? 'deidentified' : u.status,
    orphan: roles.length === 0 && f.applications === 0 && !f.has_profile,
    roles,
    hasProfile: f.has_profile,
    studentNo: f.student_no,
    cohortId: f.cohort_id,
    cohortCode: f.cohort_code,
    facts: { memberships: activeMemberships, submissions: f.submissions, advising: f.advising, evaluating: f.evaluating },
  }
}
