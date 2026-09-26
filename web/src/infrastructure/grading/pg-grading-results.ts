import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import {
  applyRemovalChoice,
  computeGroupResult,
  computeStage,
  describeStageStatus,
  normalizeSchemeStages,
  normalizeScores,
  readSchemeStages,
  summarizeScores,
  type ApplySchemeInput,
  type AssignmentHistoryEntry,
  type EvaluationHistoryEntry,
  type Gradebook,
  type GradebookGroup,
  type GradebookQuery,
  type GradingResultsCommand,
  type GroupGradeDetail,
  type MissingEvaluation,
  type OverrideInput,
  type OverrideReceipt,
  type OverrideState,
  type OverrideView,
  type ReassignmentOption,
  type ReassignmentPreview,
  type RemovalChoice,
  type RemoveAssignmentInput,
  type RemoveAssignmentReceipt,
  type ResolveReviewInput,
  type ReturnEvaluationInput,
  type ReturnReceipt,
  type SchemeApplyPreview,
  type SchemeStage,
  type SchemeVersionReceipt,
} from '@/application/grading'
import type { EventPublisher } from '@/application/notifications'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import { authorizeAdmin, badRequestId, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import {
  flagOverridesForReview,
  groupBasisHash,
  loadFacts,
  loadGroupFacts,
  stageBasisHash,
  TEACHER_INACTIVE_SQL,
  TEACHER_NAME_SQL,
  type GroupFacts,
} from '@/infrastructure/grading/facts'
import {
  alreadyAssigned,
  alreadyCounted,
  archived,
  dissolved,
  eligibleTeacher,
  groupNotFound,
  isUuid,
  lockCohort,
  lockGroupAndScheme,
  MAX_REQUIRED_COUNT,
  noScheme,
  notAssigned,
  runGrading,
  stageOf,
  type CohortRow,
  type GroupRow,
  type SchemeRow,
  type VersionRow,
} from '@/infrastructure/grading/pg-grading'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { reachFaultPoint } from '@/shared/fault-points'
import { err, ok, type Err, type Result } from '@/shared/result'
import { exactScore, formatScore, parseFinalScore } from '@/shared/score'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 成績表、退回、更正與復核、移除／改派三選一、套用新方案版本（票 24；產品模組 06 §4「7.3」「7.4」「7.5」；
 * 模組實作設計 06 §2、§3、§6）。
 *
 * 寫入的形狀同票 23（契約 01 §8）：開交易 → 依序上鎖 → 帳本 `begin` → 業務檢查與寫入 → 事件、稽核 → 帳本 `commit`。
 *
 * 鎖順序（契約 01 §6：cohorts → groups → 頭列；和票 23 同一條，所以不會互相卡死）：
 * - 退回：`cohorts FOR SHARE` → `groups FOR SHARE` → `grading_schemes FOR SHARE` → 那一份的 `evaluator_assignments FOR UPDATE`
 *   → `evaluation_status FOR UPDATE`（模組實作設計 06 §6 v2.2：和改派同序）。
 * - 改派：… → 該組該階段**全部**有效指派依 id `FOR UPDATE` → 被移除的那一列 → `stage_requirements FOR UPDATE` → 鎖內重算
 *   `basis_hash` 和預覽比對。正式送出只鎖自己的指派列、退回鎖那一份的指派列、改份數鎖份數列，都會和改派排隊：
 *   預覽之後任何改變採計集合的動作都讓 hash 對不上 → `CONFLICT`（要重新預覽），不會把剛送出的分數當暫存處理。
 * - 更正、復核：`cohorts FOR SHARE` → `groups FOR UPDATE`（和所有拿 `FOR SHARE` 的評分寫入互斥）→ 方案頭列 `FOR SHARE`
 *   → 鎖內重算最終成績與 `basis_hash`。
 * - 套用新方案版本：`cohorts FOR SHARE` → `grading_schemes FOR UPDATE`（和正式送出在方案頭列上排隊，同發布）→ 版本列。
 *
 * 基礎改變（正式送出、退回、改派、改份數、套用新版本）都在同一個交易裡呼叫 `flagOverridesForReview`：
 * 這一組生效中的更正進「待復核」，首次進入時通知管理員。
 *
 * 全部只有管理員：學生、老師呼叫任何一個都是 `FORBIDDEN`，查詢也不回任何分數。
 */

const REASON_MAX = 500
const HASH = /^[0-9a-f]{64}$/

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

type AssignmentLockRow = {
  id: string
  group_id: string
  stage_key: string
  teacher_user_id: string
  valid_to: Date | null
}

function reasonOf(raw: unknown, what: string): { ok: true; value: string } | Err {
  const value = String(raw ?? '').trim()
  if (!value) return err('VALIDATION_FAILED', `請填${what}。`, { details: { field: 'reason' } })
  if (value.length > REASON_MAX) return err('VALIDATION_FAILED', `${what}最多 ${REASON_MAX} 個字。`, { details: { field: 'reason' } })
  return { ok: true, value }
}

function staleBasis(): Err {
  return err('CONFLICT', '預覽之後這一組的評分有變動（有人送出、退回、改派或改了份數），請重新預覽再確認。')
}

function staleFinal(): Err {
  return err('CONFLICT', '這一組的成績剛有變動，請重新整理頁面，看過最新的最終成績再處理。')
}

/** 「新增」會讓要求份數 +1；已經到上限（和設定份數同一個上限）就不能再新增。 */
function addOverLimit(required: number): string {
  return `要求份數已經是 ${required} 份（上限 ${MAX_REQUIRED_COUNT}），不能再新增評分老師；請改選「保留」或「替換」。`
}

function finalIncomplete(code: string): Err {
  return err('FINAL_INCOMPLETE', `${code} 還有階段尚未完成，最終成績還沒出來，不能更正最終結果。`)
}

/** 更正、復核用：屆別 FOR SHARE → 組別 **FOR UPDATE** → 方案頭列 FOR SHARE（見檔頭）。 */
async function lockGroupExclusive(
  tx: PoolClient,
  groupId: string,
): Promise<{ cohort: CohortRow; group: GroupRow; versionId: string | null; versionNo: number | null; stages: SchemeStage[] } | null> {
  const owner = await tx.query<{ cohort_id: string }>('select cohort_id from groups where id = $1', [groupId])
  const cohortId = owner.rows[0]?.cohort_id
  if (!cohortId) return null
  const cohort = await lockCohort(tx, cohortId)
  const group = (await tx.query<GroupRow>('select id, cohort_id, code, status from groups where id = $1 for update', [groupId])).rows[0]
  if (!cohort || !group) return null
  const scheme = (
    await tx.query<SchemeRow>('select id, cohort_id, current_version_id, revision from grading_schemes where cohort_id = $1 for share', [cohortId])
  ).rows[0]
  if (!scheme?.current_version_id) return { cohort, group, versionId: null, versionNo: null, stages: [] }
  const version = (
    await tx.query<VersionRow>('select id, scheme_id, version_no, stages, status, created_at, locked_at from grading_scheme_versions where id = $1', [
      scheme.current_version_id,
    ])
  ).rows[0]!
  return { cohort, group, versionId: version.id, versionNo: version.version_no, stages: readSchemeStages(version.stages) }
}

/** 把這一組還沒被取代的更正（生效中或待復核）標成「已被取代」。 */
async function supersedeOpenOverrides(tx: PoolClient, groupId: string, adminId: string, realAt: Date): Promise<string[]> {
  const rows = await tx.query<{ override_id: string }>(
    `update override_review_state r set state = 'superseded', resolved_by_user_id = $2, resolved_at = $3,
            revision = r.revision + 1, updated_at = $3
       from grade_overrides o
      where o.id = r.override_id and o.group_id = $1 and r.state in ('effective', 'pending_review')
      returning r.override_id`,
    [groupId, adminId, realAt],
  )
  return rows.rows.map((r) => r.override_id)
}

async function insertOverride(
  tx: PoolClient,
  input: {
    groupId: string
    versionId: string
    originalValue: string
    newValue: string
    basisHash: string
    reason: string
    adminId: string
    realAt: Date
  },
): Promise<string> {
  const id = uuidv7()
  await tx.query(
    `insert into grade_overrides (id, group_id, scheme_version_id, original_value, new_value, basis_hash, reason, actor_user_id, real_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, input.groupId, input.versionId, input.originalValue, input.newValue, input.basisHash, input.reason, input.adminId, input.realAt],
  )
  await tx.query(`insert into override_review_state (override_id, state, updated_at) values ($1, 'effective', $2)`, [id, input.realAt])
  return id
}

export class PgGradingResultsCommand implements GradingResultsCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#events = deps.events
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  // ── 退回 ────────────────────────────────────────────────────────────────────

  async returnEvaluation(actor: ResolvedActor, input: ReturnEvaluationInput, requestId: string): Promise<Result<ReturnReceipt>> {
    const denied = authorizeAdmin(actor, '退回評分')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.evaluationId)) return err('VALIDATION_FAILED', '找不到這一份評分，請重新整理頁面。')
    const reason = reasonOf(input.reason, '退回理由')
    if (!reason.ok) return reason
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return runGrading(this.#pool, async (tx) => {
      const owner = await tx.query<{ group_id: string; assignment_id: string }>(
        'select a.group_id, a.id as assignment_id from evaluations e join evaluator_assignments a on a.id = e.assignment_id where e.id = $1',
        [input.evaluationId],
      )
      const found = owner.rows[0]
      if (!found) return err('VALIDATION_FAILED', '找不到這一份評分，請重新整理頁面。')
      const locked = await lockGroupAndScheme(tx, found.group_id)
      if (!locked) return groupNotFound()
      const { cohort, group, stages } = locked
      const assignment = (
        await tx.query<AssignmentLockRow>(
          'select id, group_id, stage_key, teacher_user_id, valid_to from evaluator_assignments where id = $1 for update',
          [found.assignment_id],
        )
      ).rows[0]!
      const status = (
        await tx.query<{ state: string }>('select state from evaluation_status where evaluation_id = $1 for update', [input.evaluationId])
      ).rows[0]

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.return',
          requestId,
          fingerprint: sha256(canonicalJson({ evaluationId: input.evaluationId, reason: reason.value })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<ReturnReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort.code)
      if (group.status === 'dissolved') return dissolved(group.code)
      if (assignment.valid_to !== null) {
        return err('NOT_ASSIGNED', '這位老師已經不是這一組這一階段的評分老師（指派已結束），退回後他無法處理；請先處理指派。')
      }
      if (status?.state !== 'counted') {
        return err('CONFLICT', '這一份評分已經不是採計中（可能剛被退回或改派），請重新整理頁面。')
      }
      const teacher = await eligibleTeacher(tx, assignment.teacher_user_id)
      if (!teacher) {
        return err('VALIDATION_FAILED', '這位老師的帳號已停用或不再是老師，退回後他無法重送；請先移除或改派評分老師。')
      }
      const stageName = (stages ? stageOf(stages, assignment.stage_key)?.name : null) ?? assignment.stage_key

      await reachFaultPoint('grading.return.before-update')
      await tx.query(
        `update evaluation_status set state = 'returned', revision = revision + 1, updated_at = $2, updated_by_user_id = $3
          where evaluation_id = $1`,
        [input.evaluationId, realAt, adminId],
      )
      await tx.query(
        `insert into evaluation_status_events (id, evaluation_id, from_state, to_state, reason, actor_kind, actor_user_id, real_at)
         values ($1, $2, 'counted', 'returned', $3, 'user', $4, $5)`,
        [uuidv7(), input.evaluationId, reason.value, adminId, realAt],
      )
      await this.#events.publish(tx, {
        type: 'grading.returned',
        scope: 'cohort',
        cohortId: cohort.id,
        source: { type: 'grading_assignment', id: assignment.id, version: 1 },
        actor: { kind: 'user', userId: adminId },
        recipients: [teacher.userId],
        recipientBasis: { basis: 'evaluator_assignment', assignmentId: assignment.id },
        // 理由給老師看（產品 7.5「附可見理由與入口」）；**沒有任何分數**。
        payload: {
          title: `${group.code}「${stageName}」的評分被系辦退回：${reason.value}`,
          groupId: group.id,
          code: group.code,
          stageKey: assignment.stage_key,
          reason: reason.value,
        },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.return',
        targetType: 'evaluation',
        targetId: input.evaluationId,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: { assignmentId: assignment.id, groupId: group.id, stageKey: assignment.stage_key, reason: reason.value },
      })
      await flagOverridesForReview(tx, this.#events, {
        groupId: group.id,
        cohortId: cohort.id,
        actor: { kind: 'user', userId: adminId },
        realAt,
        businessAt: businessNow,
      })
      const receipt = { evaluationId: input.evaluationId, groupCode: group.code, stageName, teacherName: teacher.name }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { evaluationId: input.evaluationId } })
      return { ok: true as const, receipt: full }
    })
  }

  // ── 移除／改派三選一 ────────────────────────────────────────────────────────

  async removeAssignment(actor: ResolvedActor, input: RemoveAssignmentInput, requestId: string): Promise<Result<RemoveAssignmentReceipt>> {
    const denied = authorizeAdmin(actor, '移除或改派評分老師')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.assignmentId)) return err('VALIDATION_FAILED', '找不到這個評分指派，請重新整理頁面。')
    const choice = input.choice
    if (choice !== 'keep' && choice !== 'replace' && choice !== 'add') {
      return err('VALIDATION_FAILED', '請選舊分數怎麼算：保留、替換或新增。', { details: { field: 'choice' } })
    }
    const newTeacherId = input.newTeacherUserId ? String(input.newTeacherUserId) : null
    if (newTeacherId !== null && !isUuid(newTeacherId)) {
      return err('VALIDATION_FAILED', '請重新選接手的老師。', { details: { field: 'newTeacherUserId' } })
    }
    if (choice === 'keep' && newTeacherId) {
      return err('VALIDATION_FAILED', '「保留已完成評分」不會產生新的評分要求；要多一位老師評分請選「明確新增」。', {
        details: { field: 'newTeacherUserId' },
      })
    }
    if (choice === 'add' && !newTeacherId) {
      return err('VALIDATION_FAILED', '「明確新增」要選一位新的評分老師。', { details: { field: 'newTeacherUserId' } })
    }
    const reason = reasonOf(input.reason, '移除或改派的理由')
    if (!reason.ok) return reason
    if (typeof input.basisHash !== 'string' || !HASH.test(input.basisHash)) return staleBasis()
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return runGrading(this.#pool, async (tx) => {
      const owner = await tx.query<{ group_id: string; stage_key: string }>(
        'select group_id, stage_key from evaluator_assignments where id = $1',
        [input.assignmentId],
      )
      const found = owner.rows[0]
      if (!found) return err('VALIDATION_FAILED', '找不到這個評分指派，請重新整理頁面。')
      const locked = await lockGroupAndScheme(tx, found.group_id)
      if (!locked) return groupNotFound()
      const { cohort, group, stages, versionId } = locked
      // 該組該階段全部有效指派依 id 上鎖（模組實作設計 06 §6 v2.1）；被移除的那一列就算已結束也鎖住再看。
      const actives = await tx.query<AssignmentLockRow>(
        `select id, group_id, stage_key, teacher_user_id, valid_to from evaluator_assignments
          where group_id = $1 and stage_key = $2 and valid_to is null order by id for update`,
        [found.group_id, found.stage_key],
      )
      const target = (
        await tx.query<AssignmentLockRow & { valid_from: Date }>(
          'select id, group_id, stage_key, teacher_user_id, valid_to, valid_from from evaluator_assignments where id = $1 for update',
          [input.assignmentId],
        )
      ).rows[0]!
      const requirement = (
        await tx.query<{ required_count: number }>(
          'select required_count from stage_requirements where group_id = $1 and stage_key = $2 for update',
          [found.group_id, found.stage_key],
        )
      ).rows[0]

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.assignment_remove',
          requestId,
          fingerprint: sha256(
            canonicalJson({ assignmentId: input.assignmentId, choice, newTeacherId, reason: reason.value, basisHash: input.basisHash }),
          ),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<RemoveAssignmentReceipt>(begun)
      if (cohort.status === 'archived') return err('COHORT_ARCHIVED', `${cohort.code} 已封存，不能改派評分老師；要改派請先解封。`)
      if (group.status === 'dissolved') return dissolved(group.code)
      if (target.valid_to !== null) return err('CONFLICT', '這個評分指派已經結束了（可能剛被別人處理），請重新整理頁面再預覽。')

      const facts = await loadGroupFacts(tx, group.id)
      if (stageBasisHash(versionId, target.stage_key, facts) !== input.basisHash) return staleBasis()

      const targetCounted = facts.counted.find((c) => c.assignmentId === target.id) ?? null
      if (!targetCounted && choice !== 'replace') {
        return err('VALIDATION_FAILED', '這位老師還沒有正式送出分數，沒有可保留的評分；請選「替換」（可以只移除，或換一位老師）。')
      }
      if (choice === 'add' && !requirement) {
        return err('VALIDATION_FAILED', '這一組這一階段還沒設定要求份數；請先設定份數再新增評分老師。')
      }
      if (choice === 'add' && requirement && requirement.required_count >= MAX_REQUIRED_COUNT) {
        // 份數在鎖內讀（`stage_requirements FOR UPDATE`），和改份數排隊；「新增」會 +1，不能超過設定份數的上限。
        return err('VALIDATION_FAILED', addOverLimit(requirement.required_count))
      }
      const stageName = (stages ? stageOf(stages, target.stage_key)?.name : null) ?? target.stage_key
      const oldTeacher = await tx.query<{ name: string }>(
        `select ${TEACHER_NAME_SQL} as name from users u left join user_profiles p on p.user_id = u.id where u.id = $1`,
        [target.teacher_user_id],
      )
      const oldTeacherName = oldTeacher.rows[0]?.name ?? ''

      let newTeacher: { userId: string; name: string } | null = null
      if (newTeacherId) {
        newTeacher = await eligibleTeacher(tx, newTeacherId)
        if (!newTeacher) {
          return err('VALIDATION_FAILED', '找不到接手的老師，或帳號已停用、不再是老師。', { details: { field: 'newTeacherUserId' } })
        }
        if (newTeacher.userId === target.teacher_user_id) {
          return err('VALIDATION_FAILED', '接手的老師不能是同一位老師。', { details: { field: 'newTeacherUserId' } })
        }
        if (actives.rows.some((a) => a.teacher_user_id === newTeacher!.userId)) {
          // 產品 7.4：新老師原本已受指派，必須先處理重複，同一老師不因改派多算一票。
          const dup = alreadyAssigned(newTeacher.name, group.code, stageName)
          return err('VALIDATION_FAILED', `${dup.message}請先處理重複的指派。`, { details: { field: 'newTeacherUserId' } })
        }
        if (facts.counted.some((c) => c.stageKey === target.stage_key && c.teacherUserId === newTeacher!.userId)) {
          // 已結束的指派上還掛著他採計中的分數（之前改派選了保留）：再接手就一人兩票。
          const counted = alreadyCounted(newTeacher.name, group.code, stageName)
          return err('VALIDATION_FAILED', counted.message, { details: { field: 'newTeacherUserId' } })
        }
      }

      await reachFaultPoint('grading.reassign.before-write')
      // 結束舊指派（業務時間不早於起始，模擬鐘倒退時也合法）。
      await tx.query(
        `update evaluator_assignments
            set valid_to = greatest(valid_from, $2), ended_real_at = $3, ended_by_user_id = $4, removal_choice = $5, reason = $6,
                revision = revision + 1, updated_at = $3
          where id = $1`,
        [target.id, businessNow, realAt, adminId, choice, reason.value],
      )
      // 暫存一律失效（保留原作者、內容、時間；只有管理員查得到歷史；不轉給新老師）。
      const drafts = await tx.query<{ evaluation_id: string }>(
        `select evaluation_id from evaluation_status where assignment_id = $1 and state = 'draft' order by evaluation_id for update`,
        [target.id],
      )
      const statusChange = async (evaluationId: string, from: string, to: string, why: string) => {
        await tx.query(
          `update evaluation_status set state = $2, revision = revision + 1, updated_at = $3, updated_by_user_id = $4 where evaluation_id = $1`,
          [evaluationId, to, realAt, adminId],
        )
        await tx.query(
          `insert into evaluation_status_events (id, evaluation_id, from_state, to_state, reason, actor_kind, actor_user_id, real_at)
           values ($1, $2, $3, $4, $5, 'user', $6, $7)`,
          [uuidv7(), evaluationId, from, to, why, adminId, realAt],
        )
      }
      for (const d of drafts.rows) await statusChange(d.evaluation_id, 'draft', 'invalidated', `評分指派已移除：${reason.value}`)
      if (choice === 'replace' && targetCounted) {
        await statusChange(targetCounted.evaluationId, 'counted', 'historical', `替換評分老師、重新評分：${reason.value}`)
      }
      let requiredAfter = requirement?.required_count ?? null
      if (choice === 'add' && requirement) {
        requiredAfter = requirement.required_count + 1
        await tx.query(
          `update stage_requirements set required_count = $3, revision = revision + 1, updated_at = $4, updated_by_user_id = $5
            where group_id = $1 and stage_key = $2`,
          [group.id, target.stage_key, requiredAfter, realAt, adminId],
        )
      }

      let newAssignmentId: string | null = null
      if (newTeacher) {
        newAssignmentId = uuidv7()
        await tx.query(
          `insert into evaluator_assignments
             (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id, previous_assignment_id, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
          [newAssignmentId, group.id, target.stage_key, newTeacher.userId, businessNow, adminId, target.id, realAt],
        )
        await this.#events.publish(tx, {
          type: 'grading.assigned',
          scope: 'cohort',
          cohortId: cohort.id,
          source: { type: 'grading_assignment', id: newAssignmentId, version: 1 },
          actor: { kind: 'user', userId: adminId },
          recipients: [newTeacher.userId],
          recipientBasis: { basis: 'evaluator_assignment', assignmentId: newAssignmentId },
          payload: { title: `你被指派評分：${group.code}「${stageName}」`, groupId: group.id, code: group.code, stageKey: target.stage_key },
          occurredRealAt: realAt,
          occurredBusinessAt: businessNow,
        })
      }
      await this.#events.publish(tx, {
        type: 'grading.assignment_ended',
        scope: 'cohort',
        cohortId: cohort.id,
        source: { type: 'grading_assignment', id: target.id, version: 2 },
        actor: { kind: 'user', userId: adminId },
        // 票 43（NTF-07）：通知被移出的老師本人；同組其他評分老師、新老師（另收 grading.assigned）都不在這裡。
        recipients: [target.teacher_user_id],
        recipientBasis: { basis: 'evaluator_assignment', assignmentId: target.id },
        // 本人異動說明：組別、階段、理由；不帶任何分數。
        payload: {
          title: `你已被移出 ${group.code}「${stageName}」的評分指派：${reason.value}`,
          groupId: group.id,
          code: group.code,
          stageKey: target.stage_key,
          stageName,
          reason: reason.value,
          choice,
          newAssignmentId,
        },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.assignment_remove',
        targetType: 'group',
        targetId: group.id,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: {
          assignmentId: target.id,
          stageKey: target.stage_key,
          choice,
          reason: reason.value,
          oldTeacherUserId: target.teacher_user_id,
          newTeacherUserId: newTeacher?.userId ?? null,
          newAssignmentId,
          requiredBefore: requirement?.required_count ?? null,
          requiredAfter,
          invalidatedDrafts: drafts.rows.length,
          historicalEvaluationId: choice === 'replace' ? (targetCounted?.evaluationId ?? null) : null,
        },
      })
      await flagOverridesForReview(tx, this.#events, {
        groupId: group.id,
        cohortId: cohort.id,
        actor: { kind: 'user', userId: adminId },
        realAt,
        businessAt: businessNow,
      })
      const receipt: RemoveAssignmentReceipt = {
        groupCode: group.code,
        stageName,
        teacherName: oldTeacherName,
        newTeacherName: newTeacher?.name ?? null,
        choice,
        requiredCount: requiredAfter,
      }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { assignmentId: target.id, newAssignmentId } })
      return { ok: true as const, receipt: full }
    })
  }

  // ── 更正與復核 ──────────────────────────────────────────────────────────────

  async override(actor: ResolvedActor, input: OverrideInput, requestId: string): Promise<Result<OverrideReceipt>> {
    const denied = authorizeAdmin(actor, '更正成績')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.groupId)) return groupNotFound()
    const newValue = parseFinalScore(String(input.newValue ?? ''))
    if (newValue === null) {
      return err('VALIDATION_FAILED', '更正後的最終成績要是 0–100、最多兩位小數。', { details: { field: 'newValue' } })
    }
    const reason = reasonOf(input.reason, '更正理由')
    if (!reason.ok) return reason
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return runGrading(this.#pool, async (tx) => {
      const locked = await lockGroupExclusive(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { cohort, group, versionId, stages } = locked
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.override',
          requestId,
          fingerprint: sha256(canonicalJson({ groupId: group.id, newValue, reason: reason.value, basisHash: input.basisHash })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<OverrideReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort.code)
      if (group.status === 'dissolved') return dissolved(group.code)
      if (!versionId) return noScheme()

      const facts = await loadGroupFacts(tx, group.id)
      const result = computeGroupResult(stages, facts.requirements, facts.counted)
      if (!result.complete || result.finalExact === null) return finalIncomplete(group.code)
      const basis = groupBasisHash(versionId, facts)
      if (basis !== input.basisHash) return staleFinal()
      if (formatScore(newValue) === result.finalDisplay) {
        return err('VALIDATION_FAILED', `更正值和目前算出來的最終成績（${result.finalDisplay}）一樣，不需要更正。`, { details: { field: 'newValue' } })
      }

      const superseded = await supersedeOpenOverrides(tx, group.id, adminId, realAt)
      const overrideId = await insertOverride(tx, {
        groupId: group.id,
        versionId,
        originalValue: result.finalExact,
        newValue,
        basisHash: basis,
        reason: reason.value,
        adminId,
        realAt,
      })
      await this.#publishOverridden(tx, cohort.id, group.id, overrideId, adminId, realAt, businessNow)
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.override',
        targetType: 'group',
        targetId: group.id,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: { overrideId, schemeVersionId: versionId, originalValue: result.finalExact, newValue, reason: reason.value, superseded },
      })
      const receipt = { overrideId, groupCode: group.code, originalValue: result.finalExact, newValue }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { overrideId } })
      return { ok: true as const, receipt: full }
    })
  }

  async resolveReview(actor: ResolvedActor, input: ResolveReviewInput, requestId: string): Promise<Result<OverrideReceipt>> {
    const denied = authorizeAdmin(actor, '復核成績更正')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.overrideId)) return err('VALIDATION_FAILED', '找不到這筆更正，請重新整理頁面。')
    if (input.decision !== 'keep' && input.decision !== 'new') return err('VALIDATION_FAILED', '請選沿用原更正值或改成新的更正值。')
    let parsedNew: string | null = null
    if (input.decision === 'new') {
      parsedNew = parseFinalScore(String(input.newValue ?? ''))
      if (parsedNew === null) {
        return err('VALIDATION_FAILED', '新的更正值要是 0–100、最多兩位小數。', { details: { field: 'newValue' } })
      }
    }
    const reason = reasonOf(input.reason, '復核說明')
    if (!reason.ok) return reason
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return runGrading(this.#pool, async (tx) => {
      const owner = await tx.query<{ group_id: string; new_value: string }>('select group_id, new_value from grade_overrides where id = $1', [
        input.overrideId,
      ])
      const found = owner.rows[0]
      if (!found) return err('VALIDATION_FAILED', '找不到這筆更正，請重新整理頁面。')
      const locked = await lockGroupExclusive(tx, found.group_id)
      if (!locked) return groupNotFound()
      const { cohort, group, versionId, stages } = locked
      const state = (
        await tx.query<{ state: OverrideState }>('select state from override_review_state where override_id = $1 for update', [input.overrideId])
      ).rows[0]
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.override_resolve',
          requestId,
          fingerprint: sha256(
            canonicalJson({ overrideId: input.overrideId, decision: input.decision, newValue: parsedNew, reason: reason.value, basisHash: input.basisHash }),
          ),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<OverrideReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort.code)
      if (group.status === 'dissolved') return dissolved(group.code)
      if (state?.state !== 'pending_review') return err('CONFLICT', '這筆更正已經有人處理過了（或不是待復核），請重新整理頁面。')
      if (!versionId) return noScheme()

      const facts = await loadGroupFacts(tx, group.id)
      const result = computeGroupResult(stages, facts.requirements, facts.counted)
      if (!result.complete || result.finalExact === null) {
        return err('FINAL_INCOMPLETE', `${group.code} 在新的計算基礎上還有階段尚未完成；等各階段完成後再決定沿用或重新更正。`)
      }
      const basis = groupBasisHash(versionId, facts)
      if (basis !== input.basisHash) return staleFinal()
      const value = input.decision === 'keep' ? exactScore(found.new_value) : parsedNew!

      const superseded = await supersedeOpenOverrides(tx, group.id, adminId, realAt)
      const overrideId = await insertOverride(tx, {
        groupId: group.id,
        versionId,
        originalValue: result.finalExact,
        newValue: value,
        basisHash: basis,
        reason: input.decision === 'keep' ? `沿用原更正值：${reason.value}` : reason.value,
        adminId,
        realAt,
      })
      await this.#publishOverridden(tx, cohort.id, group.id, overrideId, adminId, realAt, businessNow)
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.override_resolve',
        targetType: 'group',
        targetId: group.id,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: {
          reviewedOverrideId: input.overrideId,
          decision: input.decision,
          overrideId,
          schemeVersionId: versionId,
          originalValue: result.finalExact,
          newValue: value,
          superseded,
        },
      })
      const receipt = { overrideId, groupCode: group.code, originalValue: result.finalExact, newValue: value }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { overrideId } })
      return { ok: true as const, receipt: full }
    })
  }

  async #publishOverridden(
    tx: PoolClient,
    cohortId: string,
    groupId: string,
    overrideId: string,
    adminId: string,
    realAt: Date,
    businessAt: Date,
  ): Promise<void> {
    // 更正完成不通知老師或學生（產品 7.5）；事件只留紀錄。
    await this.#events.publish(tx, {
      type: 'grading.overridden',
      scope: 'cohort',
      cohortId,
      source: { type: 'grade_override', id: overrideId, version: 1 },
      actor: { kind: 'user', userId: adminId },
      recipients: [],
      payload: { groupId },
      occurredRealAt: realAt,
      occurredBusinessAt: businessAt,
    })
  }

  // ── 套用新方案版本 ──────────────────────────────────────────────────────────

  async applySchemeVersion(actor: ResolvedActor, input: ApplySchemeInput, requestId: string): Promise<Result<SchemeVersionReceipt>> {
    const denied = authorizeAdmin(actor, '套用新方案版本')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.versionId)) return err('VALIDATION_FAILED', '找不到這個方案版本，請重新整理頁面。')
    if (typeof input.token !== 'string' || !HASH.test(input.token)) return staleScheme()
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return runGrading(this.#pool, async (tx) => {
      const owner = await tx.query<{ cohort_id: string }>(
        'select s.cohort_id from grading_scheme_versions v join grading_schemes s on s.id = v.scheme_id where v.id = $1',
        [input.versionId],
      )
      const cohortId = owner.rows[0]?.cohort_id
      if (!cohortId) return err('VALIDATION_FAILED', '找不到這個方案版本，請重新整理頁面。')
      const cohort = (await lockCohort(tx, cohortId))!
      const scheme = (
        await tx.query<SchemeRow>('select id, cohort_id, current_version_id, revision from grading_schemes where cohort_id = $1 for update', [cohortId])
      ).rows[0]!
      const target = (
        await tx.query<VersionRow>(
          'select id, scheme_id, version_no, stages, status, created_at, locked_at from grading_scheme_versions where id = $1 for update',
          [input.versionId],
        )
      ).rows[0]!
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.scheme_apply',
          requestId,
          fingerprint: sha256(canonicalJson({ versionId: target.id, token: input.token })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<SchemeVersionReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort.code)
      if (target.status !== 'draft') return err('VALIDATION_FAILED', `v${target.version_no} 已經套用或發布過了，不需要再套用。`)
      const current = scheme.current_version_id ? await versionRow(tx, scheme.current_version_id) : null
      if (current?.status !== 'locked') {
        return err('VALIDATION_FAILED', '目前的版本還沒鎖定（還沒有老師開始評分），直接按「發布」換版本就好。')
      }

      const preview = await buildSchemePreview(tx, cohortId, current, target)
      if (preview.token !== input.token) return staleScheme()
      if (preview.blockers.length > 0) return err('VALIDATION_FAILED', preview.blockers[0]!)

      // 新版本直接成為目前版本並鎖定（已有正式評分照它重算）；舊版本留著（鎖定、可追查）。
      // 換版與鎖定同一步、`locked_at`＝套用時間：解散組別釘版本（`dissolvedVersions`）靠這條。
      await tx.query(`update grading_scheme_versions set status = 'locked', locked_at = $2 where id = $1`, [target.id, realAt])
      await tx.query(
        `update grading_schemes set current_version_id = $2, revision = revision + 1, updated_at = $3, updated_by_user_id = $4 where id = $1`,
        [scheme.id, target.id, realAt, adminId],
      )
      // 解散的組釘在解散當下的版本、不因套用重算，所以它的更正也不進待復核（何況解散後不能復核）。
      const withOverrides = await tx.query<{ group_id: string }>(
        `select distinct o.group_id from grade_overrides o join override_review_state r on r.override_id = o.id
           join groups g on g.id = o.group_id
          where g.cohort_id = $1 and g.status = 'active' and r.state = 'effective' order by o.group_id`,
        [cohortId],
      )
      let flagged = 0
      for (const row of withOverrides.rows) {
        flagged += await flagOverridesForReview(tx, this.#events, {
          groupId: row.group_id,
          cohortId,
          actor: { kind: 'user', userId: adminId },
          realAt,
          businessAt: businessNow,
        })
      }
      await this.#events.publish(tx, {
        type: 'grading.scheme_applied',
        scope: 'cohort',
        cohortId,
        source: { type: 'grading_scheme_version', id: target.id, version: 1 },
        actor: { kind: 'user', userId: adminId },
        recipients: [],
        payload: { schemeId: scheme.id, versionNo: target.version_no, previousVersionId: current.id },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.scheme_apply',
        targetType: 'grading_scheme_version',
        targetId: target.id,
        scope: 'cohort',
        cohortId,
        realAt,
        businessAt: businessNow,
        payload: {
          schemeId: scheme.id,
          versionNo: target.version_no,
          previousVersionId: current.id,
          changedGroups: preview.groups.filter((g) => g.changed).length,
          overridesFlagged: flagged,
        },
      })
      const receipt = { schemeId: scheme.id, versionId: target.id, versionNo: target.version_no, status: 'locked' as const }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { versionId: target.id } })
      return { ok: true as const, receipt: full }
    })
  }
}

function staleScheme(): Err {
  return err('CONFLICT', '看過影響之後，有老師送出或被退回評分、或改了份數；請重新看一次影響再套用。')
}

async function versionRow(db: Pick<Pool, 'query'> | PoolClient, id: string): Promise<VersionRow | null> {
  const rows = await db.query<VersionRow>(
    'select id, scheme_id, version_no, stages, status, created_at, locked_at from grading_scheme_versions where id = $1',
    [id],
  )
  return rows.rows[0] ?? null
}

/**
 * 套用新版本的影響預覽（查詢與執行共用同一段）。擋下的情況（寫成使用者看得懂的句子）：
 * - 新版本本身權重不合法。
 * - 新版本少了已經設定份數、指派或有正式評分的階段。
 * - 已有正式評分在新版本對不上（少了或多了項目、分數超過新的滿分、等第變成分數…）：已送出的分數不可改，所以不能套。
 */
async function buildSchemePreview(
  db: Pick<Pool, 'query'> | PoolClient,
  cohortId: string,
  current: VersionRow,
  target: VersionRow,
): Promise<SchemeApplyPreview> {
  const currentStages = readSchemeStages(current.stages)
  const targetStages = readSchemeStages(target.stages)
  const groups = await db.query<{ id: string; code: string }>(
    `select id, code from groups where cohort_id = $1 and status = 'active' order by code`,
    [cohortId],
  )
  const facts = await loadFacts(
    db,
    groups.rows.map((g) => g.id),
  )
  // 套用只會把「生效中」的更正改成待復核（方案版本在 basis 裡，一定會變）；已經待復核的維持待復核。
  const overrides = await db.query<{ group_id: string }>(
    `select distinct o.group_id from grade_overrides o join override_review_state r on r.override_id = o.id
       join groups g on g.id = o.group_id where g.cohort_id = $1 and r.state = 'effective'`,
    [cohortId],
  )
  const withOverride = new Set(overrides.rows.map((r) => r.group_id))

  const blockers: string[] = []
  const valid = normalizeSchemeStages(targetStages)
  if (!valid.ok) blockers.push(`v${target.version_no} 本身不合法：${valid.message}`)
  const targetKeys = new Set(targetStages.map((s) => s.key))
  const used = new Set<string>()
  for (const f of facts.values()) {
    for (const [k, n] of f.requirements) if (n > 0) used.add(k)
    for (const a of f.active) used.add(a.stageKey)
    for (const c of f.counted) used.add(c.stageKey)
  }
  // 解散的組釘在解散當下的版本、不受套用影響；但它用到的階段（設了份數、有指派或有正式評分）不能從方案拿掉，
  // 否則成績表與匯出的階段欄就沒有它的那一段（凍結的資料要查得到、匯得出）。
  const dissolvedGroups = await db.query<{ id: string }>(`select id from groups where cohort_id = $1 and status = 'dissolved'`, [cohortId])
  const dissolvedFacts = await loadFacts(
    db,
    dissolvedGroups.rows.map((g) => g.id),
  )
  for (const f of dissolvedFacts.values()) {
    for (const [k, n] of f.requirements) if (n > 0) used.add(k)
    for (const a of f.active) used.add(a.stageKey)
    for (const c of f.counted) used.add(c.stageKey)
  }
  const missingStages = [...used].filter((k) => !targetKeys.has(k))
  if (missingStages.length > 0) {
    const names = currentStages.filter((s) => missingStages.includes(s.key)).map((s) => `「${s.name}」`)
    blockers.push(`v${target.version_no} 少了 ${names.join('、') || '已經在用的階段'}，但那個階段已經有份數、指派或正式評分；請保留該階段。`)
  }
  for (const g of groups.rows) {
    for (const c of facts.get(g.id)?.counted ?? []) {
      const stage = stageOf(targetStages, c.stageKey)
      if (!stage) continue
      const check = normalizeScores(stage, c.scores, { complete: true })
      if (!check.ok) {
        blockers.push(
          `${g.code}「${stage.name}」${c.teacherName} 老師已正式送出的分數在 v${target.version_no} 對不上（${check.message}）；已有正式評分的階段不能增減項目、改型態，或把滿分改得比已給的分數低。`,
        )
      }
    }
  }

  const rows = groups.rows.map((g) => {
    const f = facts.get(g.id)!
    const before = computeGroupResult(currentStages, f.requirements, f.counted)
    const after = computeGroupResult(targetStages, f.requirements, f.counted)
    const stages = targetStages.map((s) => ({
      name: s.name,
      before: before.stages.find((x) => x.key === s.key)?.averageDisplay ?? null,
      after: after.stages.find((x) => x.key === s.key)?.averageDisplay ?? null,
    }))
    return {
      groupId: g.id,
      code: g.code,
      finalBefore: before.finalDisplay,
      finalAfter: after.finalDisplay,
      stages,
      changed: before.finalDisplay !== after.finalDisplay || stages.some((s) => s.before !== s.after),
      hasOverride: withOverride.has(g.id),
    }
  })

  const token = sha256(
    canonicalJson({
      current: current.id,
      target: target.id,
      counted: [...facts.values()].flatMap((f) => f.counted.map((c) => c.evaluationId)).sort(),
      requirements: [...facts.entries()].flatMap(([gid, f]) => [...f.requirements.entries()].map(([k, n]) => `${gid}:${k}:${n}`)).sort(),
    }),
  )
  return {
    cohortId,
    versionId: target.id,
    versionNo: target.version_no,
    currentVersionNo: current.version_no,
    blockers: [...new Set(blockers)].slice(0, 10),
    groups: rows,
    token,
  }
}

// ── 查詢 ────────────────────────────────────────────────────────────────────

type OverrideRow = {
  id: string
  group_id: string
  original_value: string
  new_value: string
  reason: string
  state: OverrideState
  version_no: number
  actor_name: string
  real_at: Date
  resolved_at: Date | null
  resolved_by_name: string | null
}

const OVERRIDE_SELECT = `
  select o.id, o.group_id, o.original_value::text as original_value, o.new_value::text as new_value, o.reason, r.state,
         v.version_no, coalesce(nullif(btrim(ap.display_name), ''), au.name) as actor_name, o.real_at,
         r.resolved_at, coalesce(nullif(btrim(rp.display_name), ''), ru.name) as resolved_by_name
    from grade_overrides o
    join override_review_state r on r.override_id = o.id
    join grading_scheme_versions v on v.id = o.scheme_version_id
    join users au on au.id = o.actor_user_id
    left join user_profiles ap on ap.user_id = o.actor_user_id
    left join users ru on ru.id = r.resolved_by_user_id
    left join user_profiles rp on rp.user_id = r.resolved_by_user_id`

function toOverrideView(r: OverrideRow): OverrideView {
  return {
    id: r.id,
    originalValue: exactScore(r.original_value),
    newValue: exactScore(r.new_value),
    reason: r.reason,
    state: r.state,
    schemeVersionNo: r.version_no,
    actorName: r.actor_name,
    realAt: r.real_at,
    resolvedAt: r.resolved_at,
    resolvedByName: r.resolved_by_name,
  }
}

function missingOf(stages: readonly SchemeStage[], facts: GroupFacts): MissingEvaluation[] {
  const counted = new Set(facts.counted.map((c) => c.assignmentId))
  return facts.active
    .filter((a) => !counted.has(a.id))
    .map((a) => ({
      assignmentId: a.id,
      stageKey: a.stageKey,
      stageName: stageOf(stages, a.stageKey)?.name ?? a.stageKey,
      teacherName: a.teacherName,
      teacherInactive: a.teacherInactive,
    }))
}

type CurrentVersion = { id: string; versionNo: number; stages: SchemeStage[] } | null

async function currentVersionOf(db: Pick<Pool, 'query'>, cohortId: string): Promise<CurrentVersion> {
  const row = await db.query<{ id: string; version_no: number; stages: unknown }>(
    `select v.id, v.version_no, v.stages from grading_schemes s join grading_scheme_versions v on v.id = s.current_version_id
      where s.cohort_id = $1`,
    [cohortId],
  )
  const v = row.rows[0]
  return v ? { id: v.id, versionNo: v.version_no, stages: readSchemeStages(v.stages) } : null
}

/**
 * 解散組別釘住的方案版本（產品模組 03 §4「解散：原組別資料凍結」）：解散當下套用的那一版。
 *
 * 解散命令（開站後）在 `group.dissolve` 稽核記下當下的目前版本（`schemeVersionId`），有就直接用——連「還沒鎖定的已發布版本」
 * 也準。沒有記錄（解散命令之前、測試直接改狀態的資料）才用下面的推算：
 *
 * 不用另存欄位也查得出來：目前版本只有三種換法——發布（目前版本還沒鎖定時）、第一位老師開始填時鎖定目前版本、
 * 鎖定之後套用新版本（新版本同時鎖定、`locked_at`＝套用時間）。所以一旦鎖定過，「某個真實時間點的目前版本」
 * 就是 `locked_at` 不晚於那一刻的最後一個鎖定版本（同一時間戳記取版本號大的，版本號只增不減）。解散的組只要有任何評分，解散前一定鎖定過。
 *
 * 解散前還沒鎖定過（沒有任何老師開始評分）：那時的目前版本是「已發布」、沒有時間戳記，換過幾次查不出來；
 * 但它後來若被鎖定，就是第一個鎖定的版本（鎖的一定是目前版本），所以取第一個鎖定版本——解散後、第一次鎖定前
 * 又發布過別的版本時才會不準（這種組沒有任何分數，只影響階段名稱與份數的顯示）。連鎖定都沒有過就照目前版本。
 */
/**
 * 解散當下的組員（`gm`、`g` 是呼叫端的別名）。解散命令把快照（組員資格 id）記在 `group.dissolve` 稽核裡，有就照它，
 * 同一毫秒剛被移出的人也不會誤收；沒有（解散命令之前、測試直接改狀態的舊資料）才退回用時間比：
 * 組員資格的 `valid_to` 是業務時間、`dissolved_real_at` 是真實時間，兩者在模擬業務鐘下不能比，
 * 結束資格時 `updated_at` 寫的是真實時間，所以用它跟解散時間比。
 */
const DISSOLVED_MEMBER_SQL = `case
  when exists (select 1 from audit_events da where da.action = 'group.dissolve' and da.target_type = 'group' and da.target_id = g.id)
    then exists (select 1 from audit_events da cross join lateral jsonb_array_elements(da.payload->'members') dm
                  where da.action = 'group.dissolve' and da.target_type = 'group' and da.target_id = g.id
                    and dm->>'membershipId' = gm.id::text)
  else gm.updated_at >= g.dissolved_real_at
end`

async function dissolvedVersions(db: Pick<Pool, 'query'> | PoolClient, groupIds: readonly string[]): Promise<Map<string, NonNullable<CurrentVersion>>> {
  if (groupIds.length === 0) return new Map()
  const rows = await db.query<{ group_id: string; id: string; version_no: number; stages: unknown }>(
    `select g.id as group_id, v.id, v.version_no, v.stages
       from groups g
       join grading_schemes s on s.cohort_id = g.cohort_id
       left join lateral (
         select (da.payload->>'schemeVersionId')::uuid as version_id from audit_events da
          where da.action = 'group.dissolve' and da.target_type = 'group' and da.target_id = g.id
          order by da.real_at desc limit 1
       ) rec on true
       join lateral (
         select x.id, x.version_no, x.stages from grading_scheme_versions x
          where x.scheme_id = s.id and (x.id = rec.version_id or (rec.version_id is null and x.status = 'locked'))
          order by x.locked_at <= g.dissolved_real_at desc,
                   case when x.locked_at <= g.dissolved_real_at then x.locked_at end desc,
                   case when x.locked_at <= g.dissolved_real_at then x.version_no end desc,
                   x.locked_at, x.version_no
          limit 1
       ) v on true
      where g.id = any($1::uuid[]) and g.status = 'dissolved'`,
    [groupIds],
  )
  return new Map(rows.rows.map((r) => [r.group_id, { id: r.id, versionNo: r.version_no, stages: readSchemeStages(r.stages) }]))
}

export class PgGradebookQuery implements GradebookQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  async gradebook(actor: ResolvedActor, cohortId: string): Promise<Result<Gradebook>> {
    const denied = authorizeAdmin(actor, '查看成績')
    if (denied) return denied
    if (!isUuid(cohortId)) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
    const db = this.#reader()
    const cohort = (await db.query<CohortRow>('select id, code, status from cohorts where id = $1', [cohortId])).rows[0]
    if (!cohort) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
    const version = await currentVersionOf(db, cohortId)

    // 解散的組也列（唯讀；產品模組 03 §4「管理員可查與匯出」），排在進行中的組後面。
    const groups = await db.query<{ id: string; code: string; advisor_name: string | null; dissolved: boolean }>(
      `select g.id, g.code, coalesce(nullif(btrim(p.display_name), ''), u.name) as advisor_name, g.status = 'dissolved' as dissolved
         from groups g
         left join advisor_assignments a on a.group_id = g.id and a.valid_to is null
         left join users u on u.id = a.teacher_user_id
         left join user_profiles p on p.user_id = a.teacher_user_id
        where g.cohort_id = $1 and g.status in ('active', 'dissolved')
        order by g.status = 'dissolved', g.code`,
      [cohortId],
    )
    const ids = groups.rows.map((g) => g.id)
    const [facts, members, overrides, pinned] = await Promise.all([
      loadFacts(db, ids),
      // 解散的組列解散當下的組員（見 `DISSOLVED_MEMBER_SQL`）。解散前就被移出的人不列。
      db.query<{ group_id: string; name: string; student_no: string | null }>(
        `select gm.group_id, ${TEACHER_NAME_SQL} as name, p.student_no
           from group_memberships gm
           join groups g on g.id = gm.group_id
           join users u on u.id = gm.user_id left join user_profiles p on p.user_id = gm.user_id
          where gm.group_id = any($1::uuid[])
            and (gm.valid_to is null or (g.status = 'dissolved' and ${DISSOLVED_MEMBER_SQL}))
          order by gm.group_id, p.student_no nulls last, gm.valid_from, gm.user_id`,
        [ids],
      ),
      db.query<OverrideRow>(`${OVERRIDE_SELECT} where o.group_id = any($1::uuid[]) and r.state <> 'superseded' order by o.real_at desc, o.id desc`, [
        ids,
      ]),
      dissolvedVersions(db, groups.rows.filter((g) => g.dissolved).map((g) => g.id)),
    ])

    const book: GradebookGroup[] = groups.rows.map((g) => {
      const f = facts.get(g.id)!
      const latest = overrides.rows.find((o) => o.group_id === g.id)
      const own = pinned.get(g.id) ?? version
      return {
        id: g.id,
        code: g.code,
        advisorName: g.advisor_name,
        dissolved: g.dissolved,
        versionNo: own?.versionNo ?? null,
        members: members.rows.filter((m) => m.group_id === g.id).map((m) => ({ name: m.name, studentNo: m.student_no })),
        result: computeGroupResult(own?.stages ?? [], f.requirements, f.counted),
        override: latest ? toOverrideView(latest) : null,
        basisHash: groupBasisHash(own?.id ?? null, f),
        // 解散的組評分工作已停止（產品模組 03 §4）：沒有缺評要處理。
        missing: g.dissolved ? [] : missingOf(own?.stages ?? [], f),
      }
    })
    const codeOf = new Map(groups.rows.map((g) => [g.id, g.code]))
    // 解散的組不能再復核（寫入一律拒），不放進待復核清單；那一組的列仍標「更正待復核」。
    const dissolvedIds = new Set(groups.rows.filter((g) => g.dissolved).map((g) => g.id))
    return ok(
      {
        cohort: { id: cohort.id, code: cohort.code, archived: cohort.status === 'archived' },
        version,
        groups: book,
        pendingReviews: overrides.rows
          .filter((o) => o.state === 'pending_review' && !dissolvedIds.has(o.group_id))
          .map((o) => ({
            overrideId: o.id,
            groupId: o.group_id,
            groupCode: codeOf.get(o.group_id) ?? '',
            originalValue: exactScore(o.original_value),
            newValue: exactScore(o.new_value),
            reason: o.reason,
          })),
      },
      { requestId: uuidv7(), serverTime: new Date().toISOString() },
    )
  }

  async groupDetail(actor: ResolvedActor, groupId: string): Promise<Result<GroupGradeDetail>> {
    const denied = authorizeAdmin(actor, '查看成績')
    if (denied) return denied
    if (!isUuid(groupId)) return groupNotFound()
    const db = this.#reader()
    const head = (
      await db.query<{ id: string; code: string; status: string; cohort_id: string; cohort_code: string; cohort_status: string }>(
        `select g.id, g.code, g.status, g.cohort_id, c.code as cohort_code, c.status as cohort_status
           from groups g join cohorts c on c.id = g.cohort_id where g.id = $1`,
        [groupId],
      )
    ).rows[0]
    if (!head) return groupNotFound()
    // 解散的組用解散當下的方案版本算（凍結；見 `dissolvedVersions`）。
    const version = (await dissolvedVersions(db, [groupId])).get(groupId) ?? (await currentVersionOf(db, head.cohort_id))
    const stages = version?.stages ?? []
    const facts = await loadGroupFacts(db, groupId)
    const nameOfStage = (key: string) => stageOf(stages, key)?.name ?? key

    const [overrides, evaluations, assignments] = await Promise.all([
      db.query<OverrideRow>(`${OVERRIDE_SELECT} where o.group_id = $1 order by o.real_at desc, o.id desc`, [groupId]),
      db.query<{
        id: string
        assignment_id: string
        stage_key: string
        teacher_name: string
        kind: 'draft' | 'final'
        state: EvaluationHistoryEntry['state']
        scores: Record<string, string>
        submitted_real_at: Date
        last_reason: string | null
        last_at: Date | null
      }>(
        `select e.id, e.assignment_id, a.stage_key, ${TEACHER_NAME_SQL} as teacher_name, e.kind, s.state, e.scores, e.submitted_real_at,
                ev.reason as last_reason, ev.real_at as last_at
           from evaluations e
           join evaluation_status s on s.evaluation_id = e.id
           join evaluator_assignments a on a.id = e.assignment_id
           join users u on u.id = a.teacher_user_id
           left join user_profiles p on p.user_id = a.teacher_user_id
           left join lateral (
             select x.reason, x.real_at from evaluation_status_events x
              where x.evaluation_id = e.id and x.from_state is not null order by x.real_at desc, x.id desc limit 1
           ) ev on true
          where a.group_id = $1
          order by a.stage_key, e.submitted_real_at desc, e.id desc`,
        [groupId],
      ),
      db.query<{
        id: string
        stage_key: string
        teacher_name: string
        inactive: boolean
        valid_from: Date
        valid_to: Date | null
        removal_choice: RemovalChoice | null
        reason: string | null
        previous_assignment_id: string | null
      }>(
        `select a.id, a.stage_key, ${TEACHER_NAME_SQL} as teacher_name, ${TEACHER_INACTIVE_SQL} as inactive,
                a.valid_from, a.valid_to, a.removal_choice, a.reason, a.previous_assignment_id
           from evaluator_assignments a join users u on u.id = a.teacher_user_id left join user_profiles p on p.user_id = a.teacher_user_id
          where a.group_id = $1
          order by a.stage_key, a.valid_to is not null, a.created_at, a.id`,
        [groupId],
      ),
    ])

    const history: EvaluationHistoryEntry[] = evaluations.rows.map((e) => {
      const stage = stageOf(stages, e.stage_key)
      return {
        evaluationId: e.id,
        assignmentId: e.assignment_id,
        stageKey: e.stage_key,
        stageName: nameOfStage(e.stage_key),
        teacherName: e.teacher_name,
        kind: e.kind,
        state: e.state,
        scores: e.scores,
        display: stage ? summarizeScores(stage, e.scores).score : '',
        submittedAt: e.submitted_real_at,
        lastReason: e.last_reason,
        lastChangedAt: e.last_at,
      }
    })
    const assignmentRows: AssignmentHistoryEntry[] = assignments.rows.map((a) => ({
      id: a.id,
      stageKey: a.stage_key,
      stageName: nameOfStage(a.stage_key),
      teacherName: a.teacher_name,
      teacherInactive: a.inactive,
      active: a.valid_to === null,
      validFrom: a.valid_from,
      endedAt: a.valid_to,
      removalChoice: a.removal_choice,
      reason: a.reason,
      previousAssignmentId: a.previous_assignment_id,
    }))

    return ok(
      {
        group: {
          id: head.id,
          code: head.code,
          cohortId: head.cohort_id,
          cohortCode: head.cohort_code,
          archived: head.cohort_status === 'archived',
          dissolved: head.status === 'dissolved',
        },
        version,
        result: computeGroupResult(stages, facts.requirements, facts.counted),
        basisHash: groupBasisHash(version?.id ?? null, facts),
        overrides: overrides.rows.map(toOverrideView),
        evaluations: history,
        assignments: assignmentRows,
        missing: head.status === 'dissolved' ? [] : missingOf(stages, facts),
      },
      { requestId: uuidv7(), serverTime: new Date().toISOString() },
    )
  }

  async previewReassignment(actor: ResolvedActor, assignmentId: string): Promise<Result<ReassignmentPreview>> {
    const denied = authorizeAdmin(actor, '移除或改派評分老師')
    if (denied) return denied
    if (!isUuid(assignmentId)) return notAssigned()
    const db = this.#reader()
    const target = (
      await db.query<{
        id: string
        group_id: string
        stage_key: string
        teacher_user_id: string
        valid_to: Date | null
        teacher_name: string
        code: string
        group_status: string
        cohort_id: string
        cohort_code: string
        cohort_status: string
      }>(
        `select a.id, a.group_id, a.stage_key, a.teacher_user_id, a.valid_to, ${TEACHER_NAME_SQL} as teacher_name,
                g.code, g.status as group_status, g.cohort_id, c.code as cohort_code, c.status as cohort_status
           from evaluator_assignments a
           join groups g on g.id = a.group_id
           join cohorts c on c.id = g.cohort_id
           join users u on u.id = a.teacher_user_id
           left join user_profiles p on p.user_id = a.teacher_user_id
          where a.id = $1`,
        [assignmentId],
      )
    ).rows[0]
    if (!target) return err('VALIDATION_FAILED', '找不到這個評分指派，請重新整理頁面。')
    if (target.cohort_status === 'archived') return err('COHORT_ARCHIVED', `${target.cohort_code} 已封存，不能改派評分老師；要改派請先解封。`)
    if (target.group_status === 'dissolved') return dissolved(target.code)
    if (target.valid_to !== null) return err('CONFLICT', '這個評分指派已經結束了，請重新整理頁面。')
    const version = await currentVersionOf(db, target.cohort_id)
    if (!version) return noScheme()
    const stage = stageOf(version.stages, target.stage_key)
    if (!stage) return err('VALIDATION_FAILED', '目前的評分方案沒有這個階段，請重新整理頁面。')

    const facts = await loadGroupFacts(db, target.group_id)
    const required = facts.requirements.get(stage.key) ?? null
    const before = computeStage(stage, required, facts.counted)
    const finalBefore = computeGroupResult(version.stages, facts.requirements, facts.counted).finalDisplay
    const hasCounted = facts.counted.some((c) => c.assignmentId === target.id)
    const [draft, override, teachers] = await Promise.all([
      db.query(`select 1 from evaluation_status where assignment_id = $1 and state = 'draft' limit 1`, [target.id]),
      db.query(
        `select 1 from grade_overrides o join override_review_state r on r.override_id = o.id where o.group_id = $1 and r.state = 'effective' limit 1`,
        [target.group_id],
      ),
      db.query<{ id: string; name: string }>(
        `select u.id, ${TEACHER_NAME_SQL} as name
           from users u left join user_profiles p on p.user_id = u.id
          where not (${TEACHER_INACTIVE_SQL})
            and not exists (select 1 from evaluator_assignments a
                             where a.group_id = $1 and a.stage_key = $2 and a.teacher_user_id = u.id and a.valid_to is null)
          order by 2`,
        [target.group_id, stage.key],
      ),
    ])

    const options: ReassignmentOption[] = (['keep', 'replace', 'add'] as const).map((choice) => {
      const next = applyRemovalChoice(choice, { stageKey: stage.key, assignmentId: target.id, requirements: facts.requirements, counted: facts.counted })
      const after = computeStage(stage, next.requirements.get(stage.key) ?? null, next.counted)
      const blockedReason =
        choice !== 'replace' && !hasCounted
          ? '這位老師還沒有正式送出分數，沒有可保留的評分。'
          : choice === 'add' && required === null
            ? '這一組這一階段還沒設定要求份數。'
            : choice === 'add' && required !== null && required >= MAX_REQUIRED_COUNT
              ? addOverLimit(required)
              : null
      return {
        choice,
        blockedReason,
        requiredAfter: after.required,
        countedAfter: after.counted.map((c) => ({ teacherName: c.teacherName, display: c.display })),
        averageAfter: after.averageDisplay,
        stageStatusAfter: describeStageStatus(after),
        finalAfter: computeGroupResult(version.stages, next.requirements, next.counted).finalDisplay,
      }
    })

    return ok(
      {
        assignmentId: target.id,
        cohortId: target.cohort_id,
        groupId: target.group_id,
        groupCode: target.code,
        stageKey: stage.key,
        stageName: stage.name,
        teacherName: target.teacher_name,
        hasCounted,
        hasDraft: (draft.rowCount ?? 0) > 0,
        requiredBefore: before.required,
        countedBefore: before.counted.map((c) => ({ teacherName: c.teacherName, display: c.display })),
        averageBefore: before.averageDisplay,
        stageStatusBefore: describeStageStatus(before),
        finalBefore,
        hasEffectiveOverride: (override.rowCount ?? 0) > 0,
        options,
        // 接手的人不能是本人，也不能是在這一階段已有採計中評分的老師（改派時保留的舊分），否則一人兩票。
        teachers: teachers.rows
          .filter((t) => t.id !== target.teacher_user_id && !facts.counted.some((c) => c.stageKey === stage.key && c.teacherUserId === t.id))
          .map((t) => ({ userId: t.id, name: t.name })),
        basisHash: stageBasisHash(version.id, stage.key, facts),
      },
      { requestId: uuidv7(), serverTime: new Date().toISOString() },
    )
  }

  async previewSchemeVersion(actor: ResolvedActor, versionId: string): Promise<Result<SchemeApplyPreview>> {
    const denied = authorizeAdmin(actor, '套用新方案版本')
    if (denied) return denied
    if (!isUuid(versionId)) return err('VALIDATION_FAILED', '找不到這個方案版本，請重新整理頁面。')
    const db = this.#reader()
    const target = await versionRow(db, versionId)
    if (!target) return err('VALIDATION_FAILED', '找不到這個方案版本，請重新整理頁面。')
    const scheme = (
      await db.query<SchemeRow & { status: string; code: string }>(
        `select s.id, s.cohort_id, s.current_version_id, s.revision, c.status, c.code
           from grading_schemes s join cohorts c on c.id = s.cohort_id where s.id = $1`,
        [target.scheme_id],
      )
    ).rows[0]!
    if (scheme.status === 'archived') return archived(scheme.code)
    if (target.status !== 'draft') return err('VALIDATION_FAILED', `v${target.version_no} 已經套用或發布過了。`)
    const current = scheme.current_version_id ? await versionRow(db, scheme.current_version_id) : null
    if (current?.status !== 'locked') return err('VALIDATION_FAILED', '目前的版本還沒鎖定，直接按「發布」換版本就好。')
    return ok(await buildSchemePreview(db, scheme.cohort_id, current, target), {
      requestId: uuidv7(),
      serverTime: new Date().toISOString(),
    })
  }
}
