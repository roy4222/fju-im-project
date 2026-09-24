import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import { hasRole, statusGate, type ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource, CohortStatus } from '@/application/cohorts'
import {
  ADVISOR_CSV_MAX_BYTES,
  analyzeAdvisorCsv,
  isUuid,
  normalizeEmail,
  normalizeGroupCode,
  normalizeReason,
  planBatch,
  type AdvisorBatchOutcome,
  type AdvisorBatchPreview,
  type AdvisorBatchReceipt,
  type AdvisorBatchRow,
  type AdvisorBatchRowResult,
  type AdvisorChangeKind,
  type AdvisorChangeReceipt,
  type AdvisorCommand,
  type AdvisorSource,
  type AdvisorUploadTicket,
  type AssignAdvisorInput,
  type BatchGroupFact,
  type BatchLookup,
  type BatchTeacherFact,
  type ClaimInput,
  type ExecuteBatchInput,
  type GroupType,
  type UnassignAdvisorInput,
} from '@/application/groups'
import type { EventPublisher } from '@/application/notifications'
import { canonicalJson, type AuditWriter, type FileStorage, type OperationLedger, type UploadRules } from '@/application/ops'
import {
  authorizeAdmin,
  badRequestId,
  inTransaction,
  replayed,
  staleRevision,
  type PoolSource,
} from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { reachFaultPoint } from '@/shared/fault-points'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 指導老師指派、認領與重派（票 19；模組實作設計 03 §3「主指導」「批次指派」、§6「認領」「批次」；
 * 產品模組 03 §4「5.4 指導老師規則」「行政指派的輸入」）。
 *
 * 每個寫入都是同一個形狀（契約 01 §8）：開交易 → 鎖組別 → 帳本 `begin` → 業務寫入 → 事件、稽核 → 帳本 `commit`。
 * 業務時間在開交易**之前**讀一次（和分組其他寫入一樣）。
 *
 * 鎖順序照分組：`cohorts FOR SHARE` → `groups FOR NO KEY UPDATE`。兩位老師同時認領同一組，後到的在組別列排隊，
 * 醒來時看到前者已經寫好的主指導 → `ALREADY_CLAIMED`，而且說得出是誰。資料庫的部分唯一
 * `advisor_assignments_one_active` 是後備防線：就算哪天有人繞過鎖，也只會有一列成功，另一筆收到同一句衝突訊息。
 * 用 `NO KEY UPDATE` 而不是 `UPDATE`：它和分組其他寫入（`FOR UPDATE`）一樣互斥，但不擋別的交易插入指向這組的列
 * （外鍵檢查只拿 `KEY SHARE`），整合測試才證明得到後備防線。
 *
 * 每次主指導改變都把 `groups.revision` 加一：管理員的指派對話框與批次預覽帶著這個版本，
 * 預覽之後有人認領或改派，舊預覽就不能覆蓋新指派（`CONFLICT`）。
 */

export const ADVISOR_UPLOAD_RULES: UploadRules = {
  purpose: 'advisor_csv',
  allowedTypes: ['csv'],
  maxBytes: ADVISOR_CSV_MAX_BYTES,
  scope: { kind: 'global' },
}

type GroupRow = {
  id: string
  cohort_id: string
  code: string
  group_type: GroupType
  status: 'active' | 'dissolved'
  revision: number
}

type CohortRow = { id: string; code: string; status: CohortStatus }

type AdvisorRow = { id: string; teacher_user_id: string; teacher_name: string }

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  files: FileStorage<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

function groupNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個組別，請重新整理頁面。')
}

function alreadyAdvised(code: string, teacherName: string, mine: boolean): Err {
  return mine
    ? err('ALREADY_CLAIMED', `你已經是 ${code} 的指導老師了。`)
    : err('ALREADY_CLAIMED', `${code} 剛由 ${teacherName} 老師認領成功（或已由系辦指派）；需要調整請聯絡系辦重派。`)
}

/** 同一個批次請求裡每一組的請求編號：由批次編號與組別 id 決定，重送整批時每一列都會重播而不是再做一次。 */
function rowRequestId(batchRequestId: string, groupId: string): string {
  const h = sha256(`${batchRequestId}:${groupId}`)
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** 老師用例的門：帳號狀態 → 角色。 */
function authorizeTeacher(actor: ResolvedActor): { ok: true; userId: string } | Err {
  const blocked = statusGate(actor, 'business')
  if (blocked) return err(blocked, '請先登入並完成帳號設定。')
  if (actor.kind !== 'authenticated' || !hasRole(actor, 'teacher')) return err('FORBIDDEN', '只有老師可以認領組別。')
  return { ok: true, userId: actor.userId }
}

/** 鎖到組別之後的共同拒絕：屆別封存、組別已解散。 */
function writeBlocked(cohort: CohortRow, group: GroupRow): Err | null {
  if (cohort.status === 'archived') return err('COHORT_ARCHIVED', '這一屆已封存，分組資料只能查看。')
  if (group.status === 'dissolved') return err('GROUP_DISSOLVED', `${group.code} 已解散，不能再指派指導老師。`)
  return null
}

type Change = {
  readonly kind: AdvisorChangeKind
  readonly group: GroupRow
  readonly actorUserId: string
  readonly role: 'teacher' | 'admin'
  readonly source: AdvisorSource | null
  readonly teacher: { userId: string; name: string } | null
  readonly previous: AdvisorRow | null
  readonly reason: string | null
  readonly realAt: Date
  readonly businessAt: Date
  readonly auditExtra?: Record<string, unknown>
}

export class PgAdvisorCommand implements AdvisorCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #files: FileStorage<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#events = deps.events
    this.#files = deps.files
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  // ── 老師認領 ────────────────────────────────────────────────────────────────

  async claim(actor: ResolvedActor, input: ClaimInput, requestId: string): Promise<Result<AdvisorChangeReceipt>> {
    const who = authorizeTeacher(actor)
    if (!who.ok) return who
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(String(input.groupId ?? ''))) return groupNotFound()
    const teacherId = who.userId
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lockGroup(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { group, cohort } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: teacherId,
          operationKind: 'advisor.claim',
          requestId,
          fingerprint: sha256(canonicalJson({ groupId: group.id })),
          scope: 'cohort',
          cohortId: group.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<AdvisorChangeReceipt>(begun)
      const blocked = writeBlocked(cohort, group)
      if (blocked) return blocked
      if (group.group_type !== 'industry') {
        return err('FORBIDDEN', `${group.code} 是一般專題：一般組由系辦依抽籤結果指派，老師不能自行認領。`)
      }

      const current = await currentAdvisor(tx, group.id)
      if (current) return alreadyAdvised(group.code, current.teacher_name, current.teacher_user_id === teacherId)

      await reachFaultPoint('advisor.claim.before-insert')
      const name = await userName(tx, teacherId)
      const receipt = await this.#apply(tx, {
        kind: 'claimed',
        group,
        actorUserId: teacherId,
        role: 'teacher',
        source: 'claim',
        teacher: { userId: teacherId, name },
        previous: null,
        reason: null,
        realAt,
        businessAt: businessNow,
      })
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { groupId: group.id } })
      return { ok: true as const, receipt: full }
    })
  }

  // ── 管理員逐組指派、重派、解除 ────────────────────────────────────────────────

  async assign(actor: ResolvedActor, input: AssignAdvisorInput, requestId: string): Promise<Result<AdvisorChangeReceipt>> {
    const denied = authorizeAdmin(actor, '指派指導老師')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(String(input.groupId ?? ''))) return groupNotFound()
    if (!Number.isInteger(input.revision)) return staleRevision()
    if (!isUuid(String(input.teacherUserId ?? ''))) {
      return err('VALIDATION_FAILED', '請選指導老師。', { details: { field: 'teacherUserId' } })
    }
    const reason = normalizeReason(String(input.reason ?? ''), '指派指導老師')
    if (!reason.ok) return reason
    // 重派時勾選的評分指派（模組 06）。評分還沒做，清單一定是空的，所以也不可能勾到任何一筆。
    if ((input.gradingSelections ?? []).length > 0) {
      return err('VALIDATION_FAILED', '評分功能還沒開放，沒有評分指派可以一併處理；請重新整理頁面。')
    }
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lockGroup(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { group, cohort } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'advisor.assign',
          requestId,
          fingerprint: sha256(
            canonicalJson({ groupId: group.id, revision: input.revision, teacherUserId: input.teacherUserId, reason: reason.value }),
          ),
          scope: 'cohort',
          cohortId: group.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<AdvisorChangeReceipt>(begun)
      const blocked = writeBlocked(cohort, group)
      if (blocked) return blocked
      if (group.revision !== input.revision) return staleRevision()

      const teacher = await eligibleTeacher(tx, input.teacherUserId)
      if (!teacher) return err('VALIDATION_FAILED', '找不到這位老師，或帳號已停用、不再是老師。', { details: { field: 'teacherUserId' } })
      const current = await currentAdvisor(tx, group.id)
      if (current?.teacher_user_id === teacher.userId) {
        return err('VALIDATION_FAILED', `${group.code} 已經是 ${teacher.name} 老師指導，不需要變更。`)
      }

      const receipt = await this.#apply(tx, {
        kind: current ? 'reassigned' : 'assigned',
        group,
        actorUserId: adminId,
        role: 'admin',
        source: 'admin',
        teacher,
        previous: current,
        reason: reason.value,
        realAt,
        businessAt: businessNow,
        auditExtra: { gradingSelections: [] },
      })
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { groupId: group.id } })
      return { ok: true as const, receipt: full }
    })
  }

  async unassign(actor: ResolvedActor, input: UnassignAdvisorInput, requestId: string): Promise<Result<AdvisorChangeReceipt>> {
    const denied = authorizeAdmin(actor, '解除指導老師')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(String(input.groupId ?? ''))) return groupNotFound()
    if (!Number.isInteger(input.revision)) return staleRevision()
    const reason = normalizeReason(String(input.reason ?? ''), '解除指導老師')
    if (!reason.ok) return reason
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lockGroup(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { group, cohort } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'advisor.unassign',
          requestId,
          fingerprint: sha256(canonicalJson({ groupId: group.id, revision: input.revision, reason: reason.value })),
          scope: 'cohort',
          cohortId: group.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<AdvisorChangeReceipt>(begun)
      const blocked = writeBlocked(cohort, group)
      if (blocked) return blocked
      if (group.revision !== input.revision) return staleRevision()

      const current = await currentAdvisor(tx, group.id)
      if (!current) return err('VALIDATION_FAILED', `${group.code} 目前沒有指導老師，不需要解除。`)

      const receipt = await this.#apply(tx, {
        kind: 'unassigned',
        group,
        actorUserId: adminId,
        role: 'admin',
        source: null,
        teacher: null,
        previous: current,
        reason: reason.value,
        realAt,
        businessAt: businessNow,
      })
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { groupId: group.id } })
      return { ok: true as const, receipt: full }
    })
  }

  // ── 批次指派 CSV ─────────────────────────────────────────────────────────────

  async startBatchUpload(
    actor: ResolvedActor,
    input: { fileName: string; declaredMime: string; declaredSize: number },
  ): Promise<Result<AdvisorUploadTicket>> {
    const denied = authorizeAdmin(actor, '批次指派指導老師')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    const issued = await this.#files.issueUploadTicket(actor.userId, input, ADVISOR_UPLOAD_RULES)
    if (!issued.ok) return issued
    const { ticket, fileId, maxBytes, expiresAt } = issued.receipt
    return ok({ ticket, fileId, maxBytes, expiresAt }, { requestId: uuidv7(), serverTime: this.#realClock.now().toISOString() })
  }

  async previewBatch(actor: ResolvedActor, input: { fileId: string; cohortId: string }): Promise<Result<AdvisorBatchPreview>> {
    const denied = authorizeAdmin(actor, '批次指派指導老師')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    const loaded = await this.#load(actor.userId, input.fileId, input.cohortId)
    if (!loaded.ok) return loaded
    const analyzed = analyzeAdvisorCsv(loaded.text, loaded.lookup)
    if (!analyzed.ok) return err('VALIDATION_FAILED', analyzed.message)
    return ok(
      {
        fileId: loaded.fileId,
        fileName: loaded.fileName,
        cohortId: loaded.cohort.id,
        rows: analyzed.analysis.rows,
        counts: analyzed.analysis.counts,
      },
      { requestId: uuidv7(), serverTime: this.#realClock.now().toISOString() },
    )
  }

  async executeBatch(actor: ResolvedActor, input: ExecuteBatchInput, requestId: string): Promise<Result<AdvisorBatchReceipt>> {
    const denied = authorizeAdmin(actor, '批次指派指導老師')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    const adminId = actor.userId
    const reason = normalizeReason(String(input.reason ?? ''), '批次指派')
    if (!reason.ok) return reason

    // 重新讀同一份原檔、用同一個函式分析：伺服器不信瀏覽器傳回來的預覽。
    const loaded = await this.#load(adminId, input.fileId, input.cohortId)
    if (!loaded.ok) return loaded
    const analyzed = analyzeAdvisorCsv(loaded.text, loaded.lookup)
    if (!analyzed.ok) return err('VALIDATION_FAILED', analyzed.message)
    const planned = planBatch(analyzed.analysis, {
      reason: reason.value,
      confirmReassign: input.confirmReassign === true,
      revisions: input.revisions ?? {},
    })
    if (!planned.ok) return err('VALIDATION_FAILED', planned.message)

    const results: AdvisorBatchRowResult[] = []
    for (const step of planned.steps) {
      const { row } = step
      if (step.action === 'unchanged') {
        results.push(rowResult(row, 'unchanged', row.message))
      } else {
        // 版本不符的列也走一次：帳本先看「這個批次是不是已經做過這一列」（重送整批時，自己做過的那幾組
        // 版本當然變了），做過就回原本的結果；沒做過才因版本不符回 CONFLICT。
        results.push(await this.#applyBatchRow(adminId, row, input, reason.value, requestId, loaded.fileId))
      }
    }

    const counts = { assigned: 0, reassigned: 0, unchanged: 0, conflict: 0, failed: 0 } as Record<AdvisorBatchOutcome, number>
    for (const r of results) counts[r.outcome] += 1
    const realAt = this.#realClock.now()
    const receipt: AdvisorBatchReceipt = { cohortId: loaded.cohort.id, fileName: loaded.fileName, results, counts }

    // 整批的一筆稽核（每一列另有自己的指派稽核）：記下是哪一份原檔（checksum）與結果。
    // 也經帳本：同一個請求編號重送整批時，每一列重播、這一筆也不再多寫。
    const businessAt = await this.#businessClock.now()
    await this.#run(async (tx) => {
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'advisor.batch',
          requestId,
          fingerprint: sha256(canonicalJson({ fileId: loaded.fileId, cohortId: loaded.cohort.id, reason: reason.value })),
          scope: 'cohort',
          cohortId: loaded.cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return ok(null, { requestId, serverTime: realAt.toISOString() })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'advisor.batch',
        targetType: 'cohort',
        targetId: loaded.cohort.id,
        scope: 'cohort',
        cohortId: loaded.cohort.id,
        reason: reason.value,
        realAt,
        businessAt,
        payload: { fileId: loaded.fileId, checksum: loaded.checksum, requestId, counts },
      })
      const summary = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: summary, resultRef: { cohortId: loaded.cohort.id } })
      return ok(null, { requestId, serverTime: realAt.toISOString() })
    })
    return ok(receipt, { requestId, serverTime: realAt.toISOString() })
  }

  /** 批次的一列：自己一個交易、自己的請求編號（由批次編號推出來，重送整批會重播）。 */
  async #applyBatchRow(
    adminId: string,
    row: AdvisorBatchRow,
    input: ExecuteBatchInput,
    reason: string,
    batchRequestId: string,
    fileId: string,
  ): Promise<AdvisorBatchRowResult> {
    const groupId = row.groupId!
    const teacherId = row.teacherUserId!
    const expected = input.revisions[groupId]!
    const businessNow = await this.#businessClock.now()

    const result = await this.#run(async (tx) => {
      const locked = await this.#lockGroup(tx, groupId)
      if (!locked) return groupNotFound()
      const { group, cohort } = locked
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'advisor.batch_assign',
          requestId: rowRequestId(batchRequestId, groupId),
          fingerprint: sha256(canonicalJson({ groupId, teacherUserId: teacherId, reason, fileId })),
          scope: 'cohort',
          cohortId: group.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<AdvisorChangeReceipt>(begun)
      const blocked = writeBlocked(cohort, group)
      if (blocked) return blocked
      // 分析到這裡之間又有人改過（同一組的認領、逐組指派）：拒絕這一列，要求重新預覽。
      if (group.revision !== expected) return staleRevision()

      const teacher = await eligibleTeacher(tx, teacherId)
      if (!teacher) return err('VALIDATION_FAILED', `${row.teacherEmail} 的帳號已停用或不再是老師。`)
      const current = await currentAdvisor(tx, group.id)
      if (current?.teacher_user_id === teacher.userId) return err('CONFLICT', '已經是同一位老師。')

      const receipt = await this.#apply(tx, {
        kind: current ? 'reassigned' : 'assigned',
        group,
        actorUserId: adminId,
        role: 'admin',
        source: 'csv',
        teacher,
        previous: current,
        reason,
        realAt,
        businessAt: businessNow,
        auditExtra: { fileId, line: row.line, batchRequestId },
      })
      const full = { ...receipt, requestId: rowRequestId(batchRequestId, groupId), serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { groupId: group.id } })
      return { ok: true as const, receipt: full }
    })

    if (result.ok) {
      const done = result.receipt
      return rowResult(
        row,
        done.change === 'reassigned' ? 'reassigned' : 'assigned',
        done.change === 'reassigned'
          ? `已從 ${done.previousTeacherName} 老師重派給 ${done.teacherName} 老師。`
          : `已指派 ${done.teacherName} 老師。`,
      )
    }
    if (result.code === 'CONFLICT') {
      return rowResult(row, 'conflict', `${row.groupCode} 在預覽之後被改過，這一列沒有執行；請重新上傳預覽。`)
    }
    return rowResult(row, 'failed', result.message)
  }

  // ── 共用 ────────────────────────────────────────────────────────────────────

  /**
   * 真正改主指導的那一段（同一交易）：結束舊列（重派、解除）→ 插新列（指派、認領、重派）→ 組別版本加一
   * → 事件 → 稽核。事件收件人：首次指派或認領＝全組＋新老師；重派另一則給原老師；解除＝全組＋原老師。
   */
  async #apply(tx: PoolClient, change: Change): Promise<AdvisorChangeReceipt> {
    const { group, previous, teacher, realAt, businessAt, actorUserId, reason } = change
    if (previous) {
      await tx.query(
        `update advisor_assignments
            set valid_to = greatest(valid_from, $2), ended_real_at = $3, ended_by_user_id = $4, end_reason = $5
          where id = $1`,
        [previous.id, businessAt, realAt, actorUserId, reason],
      )
    }
    let assignmentId: string | null = null
    if (teacher && change.source) {
      assignmentId = uuidv7()
      await tx.query(
        `insert into advisor_assignments
           (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason, previous_assignment_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [assignmentId, group.id, teacher.userId, change.source, businessAt, actorUserId, reason, previous?.id ?? null, realAt],
      )
    }
    const bumped = await tx.query<{ revision: number }>(
      `update groups set revision = revision + 1, updated_at = $2, updated_by_user_id = $3 where id = $1 returning revision`,
      [group.id, realAt, actorUserId],
    )
    const revision = bumped.rows[0]!.revision
    const members = await tx.query<{ user_id: string }>(
      'select user_id from group_memberships where group_id = $1 and valid_to is null',
      [group.id],
    )
    const memberIds = members.rows.map((m) => m.user_id)
    const basis = { groupId: group.id, basis: 'group_memberships+advisor', revision }
    const common = {
      scope: 'cohort' as const,
      cohortId: group.cohort_id,
      source: { type: 'group', id: group.id, version: revision },
      actor: { kind: 'user' as const, userId: actorUserId },
      occurredRealAt: realAt,
      occurredBusinessAt: businessAt,
    }

    if (teacher) {
      const title =
        change.kind === 'claimed'
          ? `${teacher.name} 老師認領了組別 ${group.code}，成為指導老師`
          : previous
            ? `組別 ${group.code} 的指導老師換成 ${teacher.name} 老師`
            : `組別 ${group.code} 的指導老師是 ${teacher.name} 老師`
      await this.#events.publish(tx, {
        ...common,
        type: 'advisor.assigned',
        recipients: [...memberIds, teacher.userId],
        recipientBasis: { ...basis, advisorUserId: teacher.userId },
        payload: { title, groupId: group.id, code: group.code, teacherUserId: teacher.userId },
      })
      if (previous) {
        await this.#events.publish(tx, {
          ...common,
          type: 'advisor.replaced',
          recipients: [previous.teacher_user_id],
          recipientBasis: { groupId: group.id, basis: 'previous_advisor', assignmentId: previous.id },
          payload: { title: `系辦已把組別 ${group.code} 重派給其他老師，你不再是這組的指導老師`, groupId: group.id, code: group.code },
        })
      }
    } else if (previous) {
      await this.#events.publish(tx, {
        ...common,
        type: 'advisor.unassigned',
        recipients: [...memberIds, previous.teacher_user_id],
        recipientBasis: { ...basis, previousAdvisorUserId: previous.teacher_user_id },
        payload: { title: `組別 ${group.code} 目前沒有指導老師（系辦已解除 ${previous.teacher_name} 老師的指派）`, groupId: group.id, code: group.code },
      })
    }

    const action =
      change.kind === 'claimed'
        ? 'advisor.claim'
        : change.kind === 'unassigned'
          ? 'advisor.unassign'
          : change.kind === 'reassigned'
            ? 'advisor.reassign'
            : 'advisor.assign'
    await this.#audit.append(tx, {
      actorKind: 'user',
      actorUserId,
      role: change.role,
      action,
      targetType: 'group',
      targetId: group.id,
      scope: 'cohort',
      cohortId: group.cohort_id,
      reason,
      realAt,
      businessAt,
      payload: {
        source: change.source,
        assignmentId,
        teacherUserId: teacher?.userId ?? null,
        previousAssignmentId: previous?.id ?? null,
        previousTeacherUserId: previous?.teacher_user_id ?? null,
        revision,
        ...change.auditExtra,
      },
    })

    return {
      groupId: group.id,
      groupCode: group.code,
      change: change.kind,
      teacherName: teacher?.name ?? null,
      previousTeacherName: previous?.teacher_name ?? null,
    }
  }

  /** 鎖順序：屆別 FOR SHARE → 組別 FOR NO KEY UPDATE（見檔頭）。 */
  async #lockGroup(tx: PoolClient, groupId: string): Promise<{ group: GroupRow; cohort: CohortRow } | null> {
    const owner = await tx.query<{ cohort_id: string }>('select cohort_id from groups where id = $1', [groupId])
    const cohortId = owner.rows[0]?.cohort_id
    if (!cohortId) return null
    const cohort = await tx.query<CohortRow>('select id, code, status from cohorts where id = $1 for share', [cohortId])
    const found = await tx.query<GroupRow>(
      'select id, cohort_id, code, group_type, status, revision from groups where id = $1 for no key update',
      [groupId],
    )
    const group = found.rows[0]
    if (!group || !cohort.rows[0]) return null
    return { group, cohort: cohort.rows[0] }
  }

  /** 讀原檔、解成文字、依所選屆別撈組別與老師（分析用）。 */
  async #load(
    adminId: string,
    fileId: string,
    cohortId: string,
  ): Promise<
    | { ok: true; text: string; fileId: string; fileName: string; checksum: string; cohort: CohortRow; lookup: BatchLookup }
    | Err
  > {
    if (!isUuid(String(fileId ?? ''))) return err('VALIDATION_FAILED', '請先上傳 CSV 檔。')
    if (!isUuid(String(cohortId ?? ''))) return err('VALIDATION_FAILED', '請先選屆別。')
    const read = await this.#files.readOwned(adminId, fileId, 'advisor_csv', ADVISOR_CSV_MAX_BYTES)
    if (!read.ok) return read
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(read.receipt.bytes)
    } catch {
      return err('VALIDATION_FAILED', '檔案不是 UTF-8 編碼；請在 Excel 另存為「CSV UTF-8」再上傳。')
    }

    const db = await this.#pool().connect()
    try {
      const cohort = await db.query<CohortRow>('select id, code, status from cohorts where id = $1', [cohortId])
      if (!cohort.rows[0]) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
      if (cohort.rows[0].status === 'archived') return err('COHORT_ARCHIVED', `${cohort.rows[0].code} 已封存，分組資料只能查看。`)
      return {
        ok: true,
        text,
        fileId: read.receipt.fileId,
        fileName: read.receipt.originalName,
        checksum: read.receipt.checksum,
        cohort: cohort.rows[0],
        lookup: await batchLookup(db, cohortId),
      }
    } finally {
      db.release()
    }
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'advisors', body, (constraint) =>
      constraint === 'advisor_assignments_one_active'
        ? err('ALREADY_CLAIMED', '這組剛剛已經有指導老師了（其他老師同時認領成功）；請重新整理頁面，需要調整請聯絡系辦重派。')
        : err('CONFLICT', '剛剛有人同時修改了這個組別，請重新整理頁面再試一次。'),
    )
  }
}

function rowResult(row: AdvisorBatchRow, outcome: AdvisorBatchOutcome, message: string): AdvisorBatchRowResult {
  return { line: row.line, groupCode: row.groupCode, teacherName: row.teacherName, outcome, message }
}

async function currentAdvisor(tx: PoolClient, groupId: string): Promise<AdvisorRow | null> {
  const rows = await tx.query<AdvisorRow>(
    `select a.id, a.teacher_user_id, coalesce(nullif(btrim(p.display_name), ''), u.name) as teacher_name
       from advisor_assignments a
       join users u on u.id = a.teacher_user_id
       left join user_profiles p on p.user_id = a.teacher_user_id
      where a.group_id = $1 and a.valid_to is null`,
    [groupId],
  )
  return rows.rows[0] ?? null
}

async function userName(tx: PoolClient, userId: string): Promise<string> {
  const rows = await tx.query<{ name: string }>(
    `select coalesce(nullif(btrim(p.display_name), ''), u.name) as name
       from users u left join user_profiles p on p.user_id = u.id where u.id = $1`,
    [userId],
  )
  return rows.rows[0]?.name ?? ''
}

/** 帳號正常、目前有老師角色的人；不是就回 null。 */
async function eligibleTeacher(tx: PoolClient, userId: string): Promise<{ userId: string; name: string } | null> {
  const rows = await tx.query<{ id: string; name: string }>(
    `select u.id, coalesce(nullif(btrim(p.display_name), ''), u.name) as name
       from users u left join user_profiles p on p.user_id = u.id
      where u.id = $1 and u.status = 'active' and u.deidentified_at is null
        and exists (select 1 from role_assignments r
                     where r.user_id = u.id and r.role = 'teacher' and r.revoked_real_at is null)`,
    [userId],
  )
  const row = rows.rows[0]
  return row ? { userId: row.id, name: row.name } : null
}

/**
 * 批次分析要的資料：所選屆別的組別（含已解散，才能說清楚原因）與目前主指導；所有曾經是老師的帳號
 * （停用的也要，才能說「已停用」而不是「找不到」），以及老師的聯絡 Email（只用來提醒「請用登入 Email」）。
 */
async function batchLookup(db: Pick<Pool, 'query'>, cohortId: string): Promise<BatchLookup> {
  const groups = await db.query<{
    id: string
    code: string
    status: 'active' | 'dissolved'
    revision: number
    teacher_user_id: string | null
    teacher_name: string | null
  }>(
    `select g.id, g.code, g.status, g.revision, a.teacher_user_id,
            coalesce(nullif(btrim(p.display_name), ''), u.name) as teacher_name
       from groups g
       left join advisor_assignments a on a.group_id = g.id and a.valid_to is null
       left join users u on u.id = a.teacher_user_id
       left join user_profiles p on p.user_id = a.teacher_user_id
      where g.cohort_id = $1`,
    [cohortId],
  )
  const teachers = await db.query<{ id: string; name: string; email: string; contact_email: string | null; eligible: boolean }>(
    `select u.id, coalesce(nullif(btrim(p.display_name), ''), u.name) as name, u.email, p.contact_email,
            (u.status = 'active' and u.deidentified_at is null
              and exists (select 1 from role_assignments r
                           where r.user_id = u.id and r.role = 'teacher' and r.revoked_real_at is null)) as eligible
       from users u
       left join user_profiles p on p.user_id = u.id
      where exists (select 1 from role_assignments r where r.user_id = u.id and r.role = 'teacher')`,
  )
  const groupsByCode = new Map<string, BatchGroupFact>(
    groups.rows.map((g) => [
      normalizeGroupCode(g.code),
      {
        id: g.id,
        code: g.code,
        status: g.status,
        revision: g.revision,
        advisor: g.teacher_user_id ? { teacherUserId: g.teacher_user_id, teacherName: g.teacher_name ?? '' } : null,
      },
    ]),
  )
  const teachersByLoginEmail = new Map<string, BatchTeacherFact>(
    teachers.rows.map((t) => [normalizeEmail(t.email), { userId: t.id, name: t.name, loginEmail: t.email, eligible: t.eligible }]),
  )
  const teacherLoginByContactEmail = new Map<string, string>(
    teachers.rows
      .filter((t) => t.contact_email && normalizeEmail(t.contact_email) !== normalizeEmail(t.email))
      .map((t) => [normalizeEmail(t.contact_email!), t.email]),
  )
  return { groupsByCode, teachersByLoginEmail, teacherLoginByContactEmail }
}
