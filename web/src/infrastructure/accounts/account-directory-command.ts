import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import {
  accountAdminDenied,
  buildAccountsCsv,
  classifyBulk,
  DIRECTORY_PAGE_SIZE,
  EXPORT_MAX_ROWS,
  isUserId,
  likePattern,
  normalizeStatusReason,
  remainingEffectiveAdmins,
  parseBulkStudentNos,
  sameTargets,
  type AccountDirectoryCommand,
  type AccountRow,
  type AccountStatus,
  type AccountSummary,
  type AdminRequestContext,
  type BulkCandidate,
  type BulkDisableReceipt,
  type BulkPreview,
  type DirectoryFilter,
  type DirectoryPage,
  type ExportSelection,
  type ResolvedActor,
  type Role,
  type StatusChange,
  type StatusChangeReceipt,
} from '@/application/accounts'
import { isRequestId } from '@/application/cohorts'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import { defaultNextStep, type ErrorCode } from '@/shared/errors'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { SessionRevocationExecutor } from '@/infrastructure/accounts/session-revocation'
import { occupyStudentNo, studentNoHolder } from '@/infrastructure/accounts/student-identities'
import { isEffectiveAdmin, lockAdmins } from '@/infrastructure/accounts/admin-guard'

/**
 * 帳號列表、停用／恢復、批次停用與匯出（工程模組 01 §3 active⇄disabled、§5 `AccountCommand`／`UserDirectoryQuery`；票 9）。
 *
 * 新增老師與臨時密碼（票 8）在 `account-command.ts`；兩邊共用授權規則 `accountAdminDenied`。
 *
 * 每個方法第一件事是授權（`accountAdminDenied`，規則在 application 層）；
 * 停用與恢復在一個交易裡寫完狀態、狀態事件、學號占用、撤 session 工作、稽核與帳本，
 * commit 之後才呼叫 Better Auth（經 `SessionRevocationExecutor`）。全程用 `fju_app` 的權限就做得完。
 *
 * **學號占用表的大小寫**：`student_identities` 的主鍵 `(cohort_id, student_no)` 是大小寫敏感的，
 * 但所有比對都用 `upper()`。不改 schema 的前提下，寫入一律存大寫（`occupyStudentNo`），
 * 並在寫入前用 `upper()` 再查一次（擋住正規化以前寫進去的小寫舊列）。
 * 顯示用的學號（`user_profiles`、`registration_applications`）照本人填的原樣保存，不動。
 */

export type AccountDirectoryCommandDeps = {
  readonly audit: AuditWriter<PoolClient>
  readonly ledger: OperationLedger<PoolClient>
  readonly db: () => Pool
  readonly revocations?: SessionRevocationExecutor
  readonly clock?: Clock
}

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

type Queryable = Pick<Pool, 'query'> | PoolClient

// ── 查詢 ────────────────────────────────────────────────────────────────────

/**
 * 孤兒帳號的 SQL 條件（票 10b），與 application 層 `isOrphan` 是同一個定義：
 * 沒有停用或去識別化、沒有有效角色、沒有任何註冊申請、沒有個人資料。
 * `u` 是 `users` 的別名。
 */
function orphanCondition(u: string): string {
  return `(${u}.deidentified_at is null and ${u}.status in ('pending','active')
    and not exists (select 1 from role_assignments r where r.user_id = ${u}.id and r.revoked_real_at is null)
    and not exists (select 1 from registration_applications x where x.user_id = ${u}.id)
    and not exists (select 1 from user_profiles p where p.user_id = ${u}.id))`
}

/**
 * 每個帳號一列。待審的人沒有 `user_profiles`，資料取他最新一筆註冊申請（lateral）；
 * 有 profile 的人一律以 profile 為準（`on up.user_id is null` 讓申請那一邊只在沒有 profile 時接上）。
 */
const DIRECTORY_BASE = `
  select u.id as user_id,
         u.email as login_email,
         case when u.deidentified_at is not null then 'deidentified' else u.status end as status,
         u.created_at,
         coalesce(up.display_name, ra.applied_name, u.name) as name,
         coalesce(up.student_no, ra.student_no) as student_no,
         coalesce(up.department_class, ra.department_class) as department_class,
         coalesce(up.phone, ra.phone) as phone,
         coalesce(up.contact_email, ra.contact_email) as contact_email,
         up.cohort_id,
         c.code as cohort_code,
         c.name as cohort_name,
         ra.state as application_state,
         coalesce(
           (select array_agg(r.role order by r.role)
              from role_assignments r
             where r.user_id = u.id and r.revoked_real_at is null),
           '{}'::text[]
         ) as roles,
         ${orphanCondition('u')} as is_orphan
    from users u
    left join user_profiles up on up.user_id = u.id
    left join lateral (
      select x.applied_name, x.student_no, x.department_class, x.phone, x.contact_email, x.state
        from registration_applications x
       where x.user_id = u.id
       order by x.created_at desc, x.id desc
       limit 1
    ) ra on up.user_id is null
    left join cohorts c on c.id = up.cohort_id`

/** 排序鍵 → SQL（白名單；外面帶進來的字串永遠不會直接進 ORDER BY）。 */
const ORDER_BY: Record<DirectoryFilter['sort'], string> = {
  createdAt: 'created_at',
  studentNo: 'upper(student_no)',
  cohort: 'cohort_code',
  status: `case status when 'pending' then 1 when 'active' then 2 when 'disabled' then 3 else 4 end`,
}

type DirectoryRow = {
  user_id: string
  login_email: string
  status: AccountStatus
  created_at: Date
  name: string
  student_no: string | null
  department_class: string | null
  phone: string | null
  contact_email: string | null
  cohort_id: string | null
  cohort_code: string | null
  cohort_name: string | null
  application_state: 'pending' | 'approved' | 'rejected' | null
  roles: Role[]
  is_orphan: boolean
  total?: string
}

function toAccountRow(r: DirectoryRow): AccountRow {
  return {
    userId: r.user_id,
    name: r.name,
    studentNo: r.student_no,
    departmentClass: r.department_class,
    cohortId: r.cohort_id,
    cohortCode: r.cohort_code,
    cohortName: r.cohort_name,
    phone: r.phone,
    loginEmail: r.login_email,
    contactEmail: r.contact_email,
    roles: r.roles,
    status: r.status,
    applicationState: r.application_state === 'pending' || r.application_state === 'rejected' ? r.application_state : null,
    createdAt: new Date(r.created_at).toISOString(),
    orphan: r.is_orphan,
  }
}

/** 篩選 → WHERE 子句與參數（參數從 `$1` 起）。 */
function whereOf(filter: DirectoryFilter): { clause: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  const add = (value: unknown) => {
    params.push(value)
    return `$${params.length}`
  }
  if (filter.q) {
    const p = add(likePattern(filter.q))
    conditions.push(
      `(name ilike ${p} escape '\\' or student_no ilike ${p} escape '\\' or login_email ilike ${p} escape '\\' or contact_email ilike ${p} escape '\\')`,
    )
  }
  if (filter.role) conditions.push(`${add(filter.role)} = any(roles)`)
  if (filter.cohortId) conditions.push(`cohort_id = ${add(filter.cohortId)}::uuid`)
  if (filter.status) conditions.push(`status = ${add(filter.status)}`)
  if (filter.orphan) conditions.push('is_orphan')
  return { clause: conditions.length > 0 ? `where ${conditions.join(' and ')}` : '', params }
}

function orderOf(filter: DirectoryFilter): string {
  const dir = filter.dir === 'asc' ? 'asc' : 'desc'
  // 空值（沒學號、沒屆別）一律排最後，不管升降冪；同值再依建立時間與 ID，分頁才穩定。
  return `order by ${ORDER_BY[filter.sort]} ${dir} nulls last, created_at desc, user_id desc`
}

// ── 用例 ────────────────────────────────────────────────────────────────────

export class PgAccountDirectoryCommand implements AccountDirectoryCommand {
  readonly #deps: AccountDirectoryCommandDeps
  readonly #clock: Clock
  readonly #revocations: SessionRevocationExecutor

  constructor(deps: AccountDirectoryCommandDeps) {
    this.#deps = deps
    this.#clock = deps.clock ?? new RealClock()
    this.#revocations = deps.revocations ?? new SessionRevocationExecutor({ db: deps.db, clock: this.#clock })
  }

  async list(actor: ResolvedActor, filter: DirectoryFilter): Promise<Result<DirectoryPage>> {
    const blocked = accountAdminDenied(actor)
    if (blocked) return denied(blocked)

    const db = this.#deps.db()
    const { clause, params } = whereOf(filter)
    const offset = (filter.page - 1) * DIRECTORY_PAGE_SIZE
    const rows = await db.query<DirectoryRow>(
      `select d.*, count(*) over () as total
         from (${DIRECTORY_BASE}) d
         ${clause}
         ${orderOf(filter)}
        limit ${DIRECTORY_PAGE_SIZE} offset ${offset}`,
      params,
    )
    // 翻到超過最後一頁時，`count(*) over ()` 拿不到總數；另外算一次。
    const total =
      rows.rows.length > 0
        ? Number(rows.rows[0]!.total)
        : Number((await db.query<{ n: string }>(`select count(*) as n from (${DIRECTORY_BASE}) d ${clause}`, params)).rows[0]!.n)
    const cohorts = await db.query<{ id: string; code: string; name: string }>(
      `select id, code, name from cohorts order by created_at desc, code desc`,
    )
    return ok(
      { rows: rows.rows.map(toAccountRow), total, page: filter.page, pageSize: DIRECTORY_PAGE_SIZE, cohorts: cohorts.rows },
      meta(this.#clock.now()),
    )
  }

  async summary(actor: ResolvedActor): Promise<Result<AccountSummary>> {
    const blocked = accountAdminDenied(actor)
    if (blocked) return denied(blocked)

    const row = (
      await this.#deps.db().query<Record<keyof AccountSummary, string>>(
        `select
           (select count(*) from registration_applications ra join users x on x.id = ra.user_id
             where ra.state = 'pending' and x.status = 'pending') as "pendingApplications",
           count(*) filter (where u.status = 'pending' and u.deidentified_at is null) as "pending",
           count(*) filter (where u.status = 'active' and u.deidentified_at is null) as "active",
           count(*) filter (where u.status = 'disabled' and u.deidentified_at is null) as "disabled",
           count(*) filter (
             where u.status = 'active' and u.deidentified_at is null
               and exists (select 1 from role_assignments r
                            where r.user_id = u.id and r.role = 'student' and r.revoked_real_at is null)
           ) as "activeStudents",
           count(*) filter (where ${orphanCondition('u')}) as "orphans"
         from users u`,
      )
    ).rows[0]!
    return ok(
      {
        pendingApplications: Number(row.pendingApplications),
        pending: Number(row.pending),
        active: Number(row.active),
        disabled: Number(row.disabled),
        activeStudents: Number(row.activeStudents),
        orphans: Number(row.orphans),
      },
      meta(this.#clock.now()),
    )
  }

  async exportCsv(actor: ResolvedActor, selection: ExportSelection): Promise<Result<{ csv: string; count: number }>> {
    const blocked = accountAdminDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')

    const db = this.#deps.db()
    let rows: DirectoryRow[]
    if (selection.kind === 'ids') {
      rows = (
        await db.query<DirectoryRow>(
          `select d.* from (${DIRECTORY_BASE}) d where user_id = any($1::uuid[]) ${orderOf({ sort: 'studentNo', dir: 'asc' } as DirectoryFilter)}`,
          [selection.userIds],
        )
      ).rows
    } else {
      const { clause, params } = whereOf(selection.filter)
      rows = (
        await db.query<DirectoryRow>(
          `select d.* from (${DIRECTORY_BASE}) d ${clause} ${orderOf(selection.filter)} limit ${EXPORT_MAX_ROWS + 1}`,
          params,
        )
      ).rows
    }
    if (rows.length > EXPORT_MAX_ROWS) {
      return err('VALIDATION_FAILED', `一次最多匯出 ${EXPORT_MAX_ROWS} 筆，請先篩選再匯出。`)
    }
    if (rows.length === 0) return err('VALIDATION_FAILED', '沒有符合的帳號可以匯出。')

    const now = this.#clock.now()
    const tx = await db.connect()
    try {
      await tx.query('begin')
      // 匯出稽核（2026-09-15 定案：匯出留紀錄）。只記範圍與筆數，不記個資、不記搜尋字（可能是姓名）。
      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: 'account.export',
        targetType: 'account_directory',
        scope: 'global',
        realAt: now,
        businessAt: now,
        payload:
          selection.kind === 'ids'
            ? { kind: 'ids', requested: selection.userIds.length, count: rows.length }
            : {
                kind: 'filter',
                count: rows.length,
                hasSearch: selection.filter.q.length > 0,
                role: selection.filter.role,
                cohortId: selection.filter.cohortId,
                status: selection.filter.status,
              },
      })
      await tx.query('commit')
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }
    return ok({ csv: buildAccountsCsv(rows.map(toAccountRow)), count: rows.length }, meta(now))
  }

  // ── 停用與恢復 ────────────────────────────────────────────────────────────

  async disable(actor: ResolvedActor, input: StatusChange, context: AdminRequestContext): Promise<Result<StatusChangeReceipt>> {
    return this.#changeStatus(actor, input, context, 'disable')
  }

  async restore(actor: ResolvedActor, input: StatusChange, context: AdminRequestContext): Promise<Result<StatusChangeReceipt>> {
    return this.#changeStatus(actor, input, context, 'restore')
  }

  async #changeStatus(
    actor: ResolvedActor,
    input: StatusChange,
    context: AdminRequestContext,
    action: 'disable' | 'restore',
  ): Promise<Result<StatusChangeReceipt>> {
    const blocked = accountAdminDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    if (!isUserId(input.userId)) return err('VALIDATION_FAILED', '找不到這個帳號，請重新整理頁面。')
    if (!isRequestId(input.requestId)) return err('VALIDATION_FAILED', '這次送出缺少請求編號，請重新整理頁面再試。')
    const reason = normalizeStatusReason(input.reason)
    if (!reason.ok) return reason
    // 不可停用自己（工程模組 01 §3）；恢復自己也不會發生——停用的人進不來。
    if (input.userId === actor.userId) return err('FORBIDDEN', '不能停用自己的帳號。')

    const operationKind = action === 'disable' ? 'account.disable' : 'account.restore'
    const now = this.#clock.now()
    const fingerprint = sha256(canonicalJson({ userId: input.userId, reason: reason.value }))

    const tx = await this.#deps.db().connect()
    let receipt: StatusChangeReceipt
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
        return ok(begun.receipt as StatusChangeReceipt, meta(now, input.requestId))
      }

      // 最後一位管理員保護（票 10b）：停用會讓管理員變少，先鎖整組管理員列、確認操作者此刻仍是有效管理員，
      // **再**鎖目標（順序與取消管理員相同，見 admin-guard.ts）。兩位管理員同時互相停用只會成功一個。
      const admins = action === 'disable' ? await lockAdmins(tx) : null
      if (admins && !isEffectiveAdmin(admins, actor.userId)) {
        await tx.query('rollback')
        return denied('FORBIDDEN')
      }

      const locked = await lockAccounts(tx, [input.userId])
      const target = locked.get(input.userId)
      const from = action === 'disable' ? 'active' : 'disabled'
      if (!target) {
        await tx.query('rollback')
        return err('CONFLICT', '找不到這個帳號，請重新整理頁面。')
      }
      // 孤兒帳號（票 10b）待審也可以停用：它沒有申請可以退回，停用是唯一的收尾方式。
      const orphanDisable = action === 'disable' && target.status === 'pending' && target.isOrphan
      if (target.status !== from && !orphanDisable) {
        await tx.query('rollback')
        return err('CONFLICT', statusConflictMessage(action, target.status))
      }
      if (admins && remainingEffectiveAdmins(admins, target.userId) < 1) {
        await tx.query('rollback')
        return err('CONFLICT', '這是最後一位管理員，不能停用。')
      }

      if (action === 'restore') {
        const occupied = await this.#occupyStudentNo(tx, target, now)
        if (!occupied.ok) {
          await tx.query('rollback')
          return occupied
        }
      }
      await this.#applyStatus(tx, actor.userId, target, action, reason.value, now, null)

      receipt = {
        userId: target.userId,
        name: target.name,
        status: action === 'disable' ? 'disabled' : 'active',
        changedAt: now.toISOString(),
        revocation: 'pending',
      }
      await this.#deps.ledger.commit(tx, begun.recordId, { receipt, resultRef: { userId: target.userId } })
      await tx.query('commit')
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }

    // commit 之後才碰 Better Auth（附錄 A 規則 1–4）。失敗不影響已經生效的停用／恢復。
    const revocation = await this.#runRevocation(input.userId, context)
    return ok({ ...receipt, revocation }, meta(now, input.requestId))
  }

  // ── 批次停用 ──────────────────────────────────────────────────────────────

  async previewBulkDisable(actor: ResolvedActor, text: string): Promise<Result<BulkPreview>> {
    const blocked = accountAdminDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    const parsed = parseBulkStudentNos(typeof text === 'string' ? text : '')
    if (!parsed.ok) return parsed
    const candidates = await bulkCandidates(this.#deps.db(), parsed.entries.map((e) => e.studentNo))
    return ok(classifyBulk(parsed, candidates, actor.userId), meta(this.#clock.now()))
  }

  async bulkDisable(
    actor: ResolvedActor,
    input: { text: string; expectedUserIds: readonly string[]; reason: string; requestId: string },
    context: AdminRequestContext,
  ): Promise<Result<BulkDisableReceipt>> {
    const blocked = accountAdminDenied(actor)
    if (blocked || actor.kind !== 'authenticated') return denied(blocked ?? 'UNAUTHENTICATED')
    if (!isRequestId(input.requestId)) return err('VALIDATION_FAILED', '這次送出缺少請求編號，請重新整理頁面再試。')
    if (!Array.isArray(input.expectedUserIds) || !input.expectedUserIds.every(isUserId)) {
      return err('VALIDATION_FAILED', '預覽資料不完整，請重新預覽。')
    }
    const reason = normalizeStatusReason(input.reason)
    if (!reason.ok) return reason
    const parsed = parseBulkStudentNos(typeof input.text === 'string' ? input.text : '')
    if (!parsed.ok) return parsed

    const expected = [...new Set(input.expectedUserIds)].sort()
    const now = this.#clock.now()
    const fingerprint = sha256(canonicalJson({ userIds: expected, reason: reason.value }))

    const tx = await this.#deps.db().connect()
    let receipt: BulkDisableReceipt
    let targets: string[]
    try {
      await tx.query('begin')
      const begun = await this.#deps.ledger.begin(
        tx,
        { actorUserId: actor.userId, operationKind: 'account.bulk_disable', requestId: input.requestId, fingerprint, scope: 'global' },
        now,
      )
      if (begun.outcome === 'mismatch') {
        await tx.query('rollback')
        return err('REQUEST_MISMATCH', '這個請求編號已經用在別的操作上，請重新預覽後再試。')
      }
      if (begun.outcome === 'replay') {
        await tx.query('commit')
        if (begun.receiptExpired) return err('RECEIPT_EXPIRED', '這次批次停用已經完成，回執已過期；請看帳號列表。')
        return ok(begun.receipt as BulkDisableReceipt, meta(now, input.requestId))
      }

      // 先鎖住預覽時看到的那群人，再用同一份 TXT 重算一次：跟預覽不同就請系辦重新預覽。
      const locked = await lockAccounts(tx, expected)
      const preview = classifyBulk(parsed, await bulkCandidates(tx, parsed.entries.map((e) => e.studentNo)), actor.userId)
      targets = preview.hits.map((h) => h.userId)
      if (targets.length === 0) {
        await tx.query('rollback')
        return err('VALIDATION_FAILED', '沒有要停用的帳號。')
      }
      if (!sameTargets(expected, targets) || targets.some((id) => locked.get(id)?.status !== 'active')) {
        await tx.query('rollback')
        return err('CONFLICT', '名單剛剛有變動（有人被停用或恢復了），請重新預覽後再確認。')
      }

      const bulkId = uuidv7()
      for (const id of targets) {
        await this.#applyStatus(tx, actor.userId, locked.get(id)!, 'disable', reason.value, now, bulkId)
      }
      await this.#deps.audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: 'admin',
        action: 'account.bulk_disable',
        targetType: 'user',
        targetId: bulkId,
        scope: 'global',
        reason: reason.value,
        realAt: now,
        businessAt: now,
        payload: {
          disabled: targets.length,
          alreadyDisabled: preview.alreadyDisabled.length,
          notFound: preview.notFound.length,
          duplicates: preview.duplicates.length,
          skipped: preview.skipped.length,
          userIds: targets,
        },
      })
      receipt = {
        disabled: targets.length,
        names: preview.hits.slice(0, 20).map((h) => h.name),
        changedAt: now.toISOString(),
        revocationFailed: 0,
      }
      await this.#deps.ledger.commit(tx, begun.recordId, { receipt, resultRef: { bulkId } })
      await tx.query('commit')
    } catch (error) {
      await tx.query('rollback').catch(() => undefined)
      throw error
    } finally {
      tx.release()
    }

    let revocationFailed = 0
    for (const id of targets) {
      if ((await this.#runRevocation(id, context)) === 'failed') revocationFailed += 1
    }
    return ok({ ...receipt, revocationFailed }, meta(now, input.requestId))
  }

  // ── 內部 ──────────────────────────────────────────────────────────────────

  /**
   * 一次狀態變更的全部寫入（同一個交易）：`users.status`、狀態事件、學號占用、撤 session 主工作、稽核。
   * 恢復時的學號占用由呼叫端先做（它可能失敗而要整體回滾）。
   */
  async #applyStatus(
    tx: PoolClient,
    actorUserId: string,
    target: LockedAccount,
    action: 'disable' | 'restore',
    reason: string,
    now: Date,
    bulkId: string | null,
  ): Promise<void> {
    const to = action === 'disable' ? 'disabled' : 'active'
    await tx.query(`update users set status = $2, updated_at = $3 where id = $1`, [target.userId, to, now])
    const statusEventId = uuidv7()
    await tx.query(
      `insert into user_status_events (id, user_id, from_status, to_status, reason, actor_kind, actor_user_id, real_at)
       values ($1, $2, $3, $4, $5, 'user', $6, $7)`,
      [statusEventId, target.userId, target.status, to, reason, actorUserId, now],
    )
    // 停用釋出有效學號（附錄 A：停用或去識別化時 DELETE）；停用不動角色。
    if (action === 'disable') await tx.query('delete from student_identities where user_id = $1', [target.userId])
    await this.#revocations.enqueue(tx, { userId: target.userId, statusEventId, expected: to, now, actorUserId })
    await this.#deps.audit.append(tx, {
      actorKind: 'user',
      actorUserId,
      role: 'admin',
      action: action === 'disable' ? 'account.disable' : 'account.restore',
      targetType: 'user',
      targetId: target.userId,
      scope: target.cohortId ? 'cohort' : 'global',
      cohortId: target.cohortId,
      reason,
      realAt: now,
      businessAt: now,
      payload: { statusEventId, from: target.status, to, ...(bulkId ? { bulkId } : {}) },
    })
  }

  /**
   * 恢復時重新占用有效學號（工程模組 01 §3 disabled→active：唯一違反→`STUDENT_NO_TAKEN`）。
   * 只有學生（有屆別、有學號）才占用；老師與管理員沒有學號。
   */
  async #occupyStudentNo(tx: PoolClient, target: LockedAccount, now: Date): Promise<{ ok: true } | Err> {
    if (!target.isStudent || !target.cohortId || !target.studentNo) return { ok: true }
    const taken = await studentNoHolder(tx, target.cohortId, target.studentNo, target.userId)
    if (taken) {
      return err(
        'STUDENT_NO_TAKEN',
        `學號 ${target.studentNo} 在這一屆已經有另一個有效帳號（${taken}），不能恢復。請先確認是不是同一個人重複註冊。`,
      )
    }
    await tx.query('delete from student_identities where user_id = $1', [target.userId])
    try {
      await occupyStudentNo(tx, target.cohortId, target.studentNo, target.userId, now)
    } catch (error) {
      if ((error as { code?: string })?.code !== '23505') throw error
      return err('STUDENT_NO_TAKEN', `學號 ${target.studentNo} 在這一屆已經有另一個有效帳號，不能恢復。`)
    }
    return { ok: true }
  }

  async #runRevocation(userId: string, context: AdminRequestContext) {
    try {
      return await this.#revocations.runForUser(userId, context.headers)
    } catch (error) {
      // 工作列留在資料庫裡，收斂工作（票 12）會接手；這裡只記錄，不讓已生效的停用變成錯誤。
      console.error('[accounts] 撤 session 執行失敗，留給收斂工作', error)
      return 'failed' as const
    }
  }
}

// ── 共用小工具 ──────────────────────────────────────────────────────────────

type LockedAccount = {
  userId: string
  name: string
  status: AccountStatus
  cohortId: string | null
  studentNo: string | null
  isStudent: boolean
  /** 孤兒帳號（票 10b）：待審也可以停用。 */
  isOrphan: boolean
}

/**
 * 依 ID 順序鎖住幾個帳號（固定順序，兩個批次同時跑也不會互等成死結）。
 *
 * 用 `for no key update`（票 10b）：只改狀態欄、不動主鍵，不需要最強的 `for update`。
 * `for update` 會跟外鍵檢查拿的 key share 鎖互斥——另一個交易剛以這個人為 actor 寫了帳本
 * （`operation_records.actor_user_id` 外鍵），兩位管理員互相停用時就會死結。
 */
async function lockAccounts(tx: PoolClient, userIds: readonly string[]): Promise<Map<string, LockedAccount>> {
  const result = new Map<string, LockedAccount>()
  if (userIds.length === 0) return result
  const rows = await tx.query<{
    id: string
    name: string
    status: string
    deidentified_at: Date | null
    cohort_id: string | null
    student_no: string | null
    is_student: boolean
    is_orphan: boolean
  }>(
    `select u.id, coalesce(up.display_name, u.name) as name, u.status, u.deidentified_at,
            up.cohort_id, up.student_no,
            exists (select 1 from role_assignments r
                     where r.user_id = u.id and r.role = 'student' and r.revoked_real_at is null) as is_student,
            ${orphanCondition('u')} as is_orphan
       from users u
       left join user_profiles up on up.user_id = u.id
      where u.id = any($1::uuid[])
      order by u.id
      for no key update of u`,
    [[...userIds]],
  )
  for (const r of rows.rows) {
    result.set(r.id, {
      userId: r.id,
      name: r.name,
      status: r.deidentified_at ? 'deidentified' : (r.status as AccountStatus),
      cohortId: r.cohort_id,
      studentNo: r.student_no,
      isStudent: r.is_student,
      isOrphan: r.is_orphan,
    })
  }
  return result
}

/** 批次停用的比對來源：核准過的學生資料（學號忽略大小寫）。 */
async function bulkCandidates(db: Queryable, studentNos: readonly string[]): Promise<BulkCandidate[]> {
  if (studentNos.length === 0) return []
  const rows = await db.query<{ id: string; name: string; student_no: string; cohort_code: string | null; status: string; deidentified_at: Date | null }>(
    `select u.id, up.display_name as name, up.student_no, c.code as cohort_code, u.status, u.deidentified_at
       from user_profiles up
       join users u on u.id = up.user_id
       left join cohorts c on c.id = up.cohort_id
      where up.student_no is not null and upper(up.student_no) = any($1::text[])
      order by c.code desc nulls last, u.created_at`,
    [[...new Set(studentNos.map((s) => s.toUpperCase()))]],
  )
  return rows.rows
    .filter((r) => !r.deidentified_at)
    .map((r) => ({ userId: r.id, name: r.name, studentNo: r.student_no, cohortCode: r.cohort_code, status: r.status as AccountStatus }))
}

function statusConflictMessage(action: 'disable' | 'restore', current: AccountStatus): string {
  if (action === 'disable') {
    if (current === 'disabled') return '這個帳號已經是停用狀態了，請重新整理頁面。'
    if (current === 'pending') return '待審核的帳號不是用停用處理，請在待審核清單裡退回。'
    return '這個帳號目前不能停用，請重新整理頁面。'
  }
  if (current === 'active') return '這個帳號已經恢復了，請重新整理頁面。'
  return '這個帳號目前不能恢復，請重新整理頁面。'
}
