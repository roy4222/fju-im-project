import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import { hasRole, statusGate, type ResolvedActor } from '@/application/accounts'
import { cohortLabel, type BusinessClockSource, type CohortStatus } from '@/application/cohorts'
import {
  collectSchemeKeys,
  normalizeSchemeStages,
  normalizeScores,
  readSchemeStages,
  summarizeScores,
  type AdminAssignmentView,
  type AdminGradingBoard,
  type AssignEvaluatorInput,
  type AssignEvaluatorReceipt,
  type AssignmentsForTeacherQuery,
  type BenchEntry,
  type CreateSchemeVersionInput,
  type DraftReceipt,
  type EvaluationState,
  type FinalReceipt,
  type GradingCommand,
  type GradingProgressSummary,
  type GradingQuery,
  type PendingReview,
  type RequirementReceipt,
  type SchemeStage,
  type SchemeVersionReceipt,
  type SchemeVersionStatus,
  type SchemeVersionView,
  type ScoresInput,
  type SetRequirementInput,
  type TeacherBench,
  type TeacherBenchPage,
  type TeacherGroupAssignment,
  type TeacherQueueEntry,
} from '@/application/grading'
import type { EventPublisher } from '@/application/notifications'
import type { AdvisorSubmissionQuery } from '@/application/submissions'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import {
  authorizeAdmin,
  badRequestId,
  inTransaction,
  replayed,
  staleRevision,
  type PoolSource,
} from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { flagOverridesForReview } from '@/infrastructure/grading/facts'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { reachFaultPoint } from '@/shared/fault-points'
import { err, ok, type Err, type Result } from '@/shared/result'
import { exactScore } from '@/shared/score'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 評分方案、要求份數、指派、暫存與正式送出（票 23；模組實作設計 06 §3、§5、§6；產品模組 06 §4「7.2」「7.4」「7.6」）。
 *
 * 每個寫入都是同一個形狀（契約 01 §8）：開交易 → 依序上鎖 → 帳本 `begin` → 業務檢查與寫入 → 事件、稽核 → 帳本 `commit`。
 * 業務時間在開交易**之前**讀一次（和分組其他寫入一樣）。
 *
 * 鎖順序（契約 01 §6：cohorts → groups → 頭列）：`cohorts FOR SHARE` → `groups FOR SHARE` →
 * `grading_schemes`（發布拿 `FOR UPDATE`，其他拿 `FOR SHARE`）→ `evaluator_assignments FOR UPDATE`（暫存、正式送出）。
 * - 發布新版本和「第一位老師開始填」（第一份暫存或正式送出，鎖定方案）在方案頭列上排隊：不會發生「剛鎖定就被換掉版本」。
 * - 同一個指派同時兩個不同請求編號正式送出（B 階段 TE-B1 起＝重送）：在指派列上排隊，後到的醒來看到已有採計，
 *   把它改成 historical（事件 reason `resubmitted`）再採計自己這筆；兩筆都成功、採計恰一筆。
 *   資料庫的部分唯一 `evaluation_status_one_counted` 是後備防線，繞過鎖也不會有兩筆採計。
 * - 系辦結算（`pg-grade-settlements.ts`）拿方案頭列 `FOR UPDATE`；暫存、送出、重送在同一把鎖（`FOR SHARE`）內查現行結算：
 *   誰先拿到鎖誰贏——先結算的話老師 `CONFLICT`，先送出的話結算數得到這一份。
 *
 * 學生零可見：這裡的每一個讀寫都先過角色閘門——學生呼叫任何一個都是 `FORBIDDEN`，查詢也不回任何分數。
 * 老師只拿得到**自己**的指派與輸入；誰是本人一律由 actor 決定，不收畫面傳來的老師 id。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** 要求份數的上限：一組一個階段找十位老師評已經不合理，擋掉打錯字。 */
export const MAX_REQUIRED_COUNT = 10

export type CohortRow = { id: string; code: string; name: string; status: CohortStatus }
export type GroupRow = { id: string; cohort_id: string; code: string; status: 'active' | 'dissolved' }
export type SchemeRow = { id: string; cohort_id: string; current_version_id: string | null; revision: number }
export type VersionRow = {
  id: string
  scheme_id: string
  version_no: number
  stages: unknown
  status: SchemeVersionStatus
  created_at: Date
  locked_at: Date | null
}
type AssignmentRow = {
  id: string
  group_id: string
  stage_key: string
  teacher_user_id: string
  valid_to: Date | null
}

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

/** 老師用例的門：帳號狀態 → 角色。學生、系辦（沒有老師角色）都是 `FORBIDDEN`。 */
function authorizeTeacher(actor: ResolvedActor): { ok: true; userId: string } | Err {
  const blocked = statusGate(actor, 'business')
  if (blocked) return err(blocked, '請先登入並完成帳號設定。')
  if (actor.kind !== 'authenticated' || !hasRole(actor, 'teacher')) return err('FORBIDDEN', '只有受指派的老師可以評分。')
  return { ok: true, userId: actor.userId }
}

export function notAssigned(): Err {
  return err('NOT_ASSIGNED', '這份評分表目前無法儲存，請回到首頁。')
}

export function groupNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個組別，請重新整理頁面。')
}

export function archived(cohort: { readonly name: string; readonly code: string }): Err {
  return err('COHORT_ARCHIVED', `${cohortLabel(cohort)}已封存，評分資料只能查看。`)
}

export function dissolved(code: string): Err {
  return err('GROUP_DISSOLVED', `${code} 已解散，不能再設定或送出評分。`)
}

export function noScheme(): Err {
  return err('VALIDATION_FAILED', '這一屆還沒有發布評分規則；請先建立並發布評分規則。')
}

export function stageOf(stages: readonly SchemeStage[], key: string): SchemeStage | null {
  return stages.find((s) => s.key === key) ?? null
}

/**
 * 清單型的回執（契約寫 `Result<readonly X[]>`）：`ok()` 會把內容展開成物件、陣列就壞了，所以直接在陣列上掛
 * `requestId`、`serverTime`——拿到的仍是陣列（可以 `map`），也滿足 `Receipt<readonly X[]>`。
 */
export function okList<T>(items: readonly T[]): Result<readonly T[]> {
  return { ok: true, receipt: Object.assign([...items], { requestId: uuidv7(), serverTime: new Date().toISOString() }) }
}

/** 評語上限（B 階段 TE-B4；資料庫 `evaluations_comment_length_check` 同一個數，按字元數算）。 */
export const MAX_COMMENT_LENGTH = 500

/** 評語：沒給或只有空白 → null；超過 500 字 → `VALIDATION_FAILED`。內容照老師打的存，不修剪。 */
export function normalizeComment(value: unknown): { ok: true; value: string | null } | Err {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return err('VALIDATION_FAILED', '評語格式不對，請重新整理頁面再試。', { details: { field: 'comment' } })
  if (value.trim() === '') return { ok: true, value: null }
  // 用字元數（code point）比，跟資料庫的 char_length 一致：emoji 不會被算成兩個字。
  if ([...value].length > MAX_COMMENT_LENGTH) {
    return err('VALIDATION_FAILED', `評語最多 ${MAX_COMMENT_LENGTH} 字，請刪短一點再存。`, { details: { field: 'comment' } })
  }
  return { ok: true, value }
}

/** 這一屆這一階段有沒有現行結算（呼叫端已拿方案頭列的鎖）。 */
export async function stageSettled(tx: PoolClient, cohortId: string, stageKey: string): Promise<boolean> {
  const rows = await tx.query('select 1 from grade_settlements where cohort_id = $1 and stage_key = $2 and released_at is null', [
    cohortId,
    stageKey,
  ])
  return (rows.rowCount ?? 0) > 0
}

export function settledConflict(stageName: string): Err {
  return err('CONFLICT', `${stageName}成績已結算，不能再改。需要修改請聯絡系辦解除結算。`)
}

export class PgGradingCommand implements GradingCommand {
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

  // ── 方案版本 ────────────────────────────────────────────────────────────────

  async createSchemeVersion(
    actor: ResolvedActor,
    input: CreateSchemeVersionInput,
    requestId: string,
  ): Promise<Result<SchemeVersionReceipt>> {
    const denied = authorizeAdmin(actor, '設定評分規則')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.cohortId)) return err('VALIDATION_FAILED', '請先選屆別。')
    // 先驗一次（不用開交易就能擋掉權重不合）；代號在鎖內依歷來版本再補一次。
    const normalized = normalizeSchemeStages(input.stages)
    if (!normalized.ok) return normalized
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const cohort = await lockCohort(tx, input.cohortId)
      if (!cohort) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.scheme_create',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId: cohort.id, stages: input.stages })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<SchemeVersionReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort)

      // 一屆一個方案頭列：沒有就建，有就鎖住它分配版本號（兩位管理員同時建，版本號不會撞）。
      await tx.query(
        `insert into grading_schemes (id, cohort_id, name, created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
         values ($1, $2, $3, $4, 'user', $5, $4, $5)
         on conflict (cohort_id) do nothing`,
        [uuidv7(), cohort.id, `${cohort.code} 評分方案`, realAt, adminId],
      )
      const scheme = (
        await tx.query<SchemeRow>(
          'select id, cohort_id, current_version_id, revision from grading_schemes where cohort_id = $1 for update',
          [cohort.id],
        )
      ).rows[0]!
      const next = await tx.query<{ n: number }>(
        'select coalesce(max(version_no), 0) + 1 as n from grading_scheme_versions where scheme_id = $1',
        [scheme.id],
      )
      const versionNo = Number(next.rows[0]!.n)
      // 新增的階段、項目拿「歷來所有版本都沒用過」的代號：刪掉 s1 再新增，不會又發一個 s1，
      // 舊的要求份數、評分指派、暫存分數就不會接到不相干的新階段或新項目上（在方案頭列鎖內讀，兩人同時建也一致）。
      const history = await tx.query<{ stages: unknown }>('select stages from grading_scheme_versions where scheme_id = $1', [scheme.id])
      const keyed = normalizeSchemeStages(input.stages, collectSchemeKeys(history.rows.map((r) => readSchemeStages(r.stages))))
      if (!keyed.ok) return keyed
      const versionId = uuidv7()
      await tx.query(
        `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_at, created_by_user_id)
         values ($1, $2, $3, $4::jsonb, 'draft', $5, $6)`,
        [versionId, scheme.id, versionNo, JSON.stringify(keyed.value), realAt, adminId],
      )
      await tx.query('update grading_schemes set revision = revision + 1, updated_at = $2, updated_by_user_id = $3 where id = $1', [
        scheme.id,
        realAt,
        adminId,
      ])
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.scheme_create',
        targetType: 'grading_scheme_version',
        targetId: versionId,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: { schemeId: scheme.id, versionNo, stageKeys: keyed.value.map((s) => s.key) },
      })
      const receipt = { schemeId: scheme.id, versionId, versionNo, status: 'draft' as const }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { versionId } })
      return { ok: true as const, receipt: full }
    })
  }

  async publishScheme(actor: ResolvedActor, input: { versionId: string }, requestId: string): Promise<Result<SchemeVersionReceipt>> {
    const denied = authorizeAdmin(actor, '發布評分規則')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.versionId)) return err('VALIDATION_FAILED', '找不到這一版評分規則，請重新整理頁面。')
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const owner = await tx.query<{ cohort_id: string }>(
        `select s.cohort_id from grading_scheme_versions v join grading_schemes s on s.id = v.scheme_id where v.id = $1`,
        [input.versionId],
      )
      const cohortId = owner.rows[0]?.cohort_id
      if (!cohortId) return err('VALIDATION_FAILED', '找不到這一版評分規則，請重新整理頁面。')
      const cohort = (await lockCohort(tx, cohortId))!
      const scheme = (
        await tx.query<SchemeRow>(
          'select id, cohort_id, current_version_id, revision from grading_schemes where cohort_id = $1 for update',
          [cohortId],
        )
      ).rows[0]!
      const version = (
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
          operationKind: 'grading.scheme_publish',
          requestId,
          fingerprint: sha256(canonicalJson({ versionId: version.id })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<SchemeVersionReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort)
      if (version.status !== 'draft') return err('VALIDATION_FAILED', `v${version.version_no} 已經發布過了，不需要再發布。`)

      const current = scheme.current_version_id
        ? (
            await tx.query<VersionRow>(
              'select id, scheme_id, version_no, stages, status, created_at, locked_at from grading_scheme_versions where id = $1',
              [scheme.current_version_id],
            )
          ).rows[0]!
        : null
      if (current?.status === 'locked') {
        return err(
          'SCHEME_LOCKED',
          `目前的第 ${current.version_no} 版已有老師開始評分（存了評分草稿或已正式送出），評分規則已鎖定，不能直接換成新版本；改評分項目或權重請在版本清單按「查看重算影響（尚不套用）」（先看重算預覽再確認）。`,
        )
      }

      // 寫進去時驗過了；發布前再驗一次（權重不合 100 不能發布）。
      const stages = readSchemeStages(version.stages)
      const valid = normalizeSchemeStages(stages)
      if (!valid.ok) return valid

      // 已經設定過要求份數或指派的階段，新版本不能拿掉（否則那些指派就對不到方案了）。
      const used = await tx.query<{ stage_key: string }>(
        `select distinct stage_key from (
           select r.stage_key from stage_requirements r join groups g on g.id = r.group_id where g.cohort_id = $1 and r.required_count > 0
           union
           select a.stage_key from evaluator_assignments a join groups g on g.id = a.group_id where g.cohort_id = $1 and a.valid_to is null
         ) k`,
        [cohortId],
      )
      const keys = new Set(stages.map((s) => s.key))
      const missing = used.rows.map((r) => r.stage_key).filter((k) => !keys.has(k))
      if (missing.length > 0) {
        const names = current ? readSchemeStages(current.stages).filter((s) => missing.includes(s.key)).map((s) => `「${s.name}」`) : []
        return err(
          'VALIDATION_FAILED',
          `第 ${version.version_no} 版少了 ${names.join('、') || '已經在用的階段'}，但那個階段已經設定了需要幾位老師評分或指派老師；請保留該階段再發布。`,
        )
      }

      // 只有目前版本還沒鎖定才走得到這裡（上面擋了 SCHEME_LOCKED）。解散組別釘版本（`pg-grading-results.ts` 的 `dissolvedVersions`）靠這條：目前版本鎖定後，只會經套用換成同時鎖定的新版本。
      await tx.query(`update grading_scheme_versions set status = 'published' where id = $1`, [version.id])
      await tx.query(
        `update grading_schemes set current_version_id = $2, revision = revision + 1, updated_at = $3, updated_by_user_id = $4 where id = $1`,
        [scheme.id, version.id, realAt, adminId],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.scheme_publish',
        targetType: 'grading_scheme_version',
        targetId: version.id,
        scope: 'cohort',
        cohortId,
        realAt,
        businessAt: businessNow,
        payload: { schemeId: scheme.id, versionNo: version.version_no, previousVersionId: current?.id ?? null },
      })
      const receipt = { schemeId: scheme.id, versionId: version.id, versionNo: version.version_no, status: 'published' as const }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { versionId: version.id } })
      return { ok: true as const, receipt: full }
    })
  }

  // ── 要求份數與指派 ──────────────────────────────────────────────────────────

  async setRequirement(actor: ResolvedActor, input: SetRequirementInput, requestId: string): Promise<Result<RequirementReceipt>> {
    const denied = authorizeAdmin(actor, '設定每組需要幾位老師評分')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.groupId)) return groupNotFound()
    if (!Number.isInteger(input.revision) || input.revision < 0) return staleRevision()
    const count = input.requiredCount
    if (!Number.isInteger(count) || count < 0 || count > MAX_REQUIRED_COUNT) {
      return err('VALIDATION_FAILED', `需要幾位老師評分要填 0–${MAX_REQUIRED_COUNT} 的整數。`, { details: { field: 'requiredCount' } })
    }
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await lockGroupAndScheme(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { cohort, group, stages } = locked
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.requirement_set',
          requestId,
          fingerprint: sha256(canonicalJson({ groupId: group.id, stageKey: input.stageKey, count, revision: input.revision })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<RequirementReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort)
      if (group.status === 'dissolved') return dissolved(group.code)
      if (!stages) return noScheme()
      const stage = stageOf(stages, String(input.stageKey ?? ''))
      if (!stage) return err('VALIDATION_FAILED', '目前的評分規則沒有這個階段，請重新整理頁面。')

      const existing = await tx.query<{ revision: number }>(
        'select revision from stage_requirements where group_id = $1 and stage_key = $2 for update',
        [group.id, stage.key],
      )
      const current = existing.rows[0]
      if ((current?.revision ?? 0) !== input.revision) return staleRevision()
      if (current) {
        await tx.query(
          `update stage_requirements set required_count = $3, revision = revision + 1, updated_at = $4, updated_by_user_id = $5
            where group_id = $1 and stage_key = $2`,
          [group.id, stage.key, count, realAt, adminId],
        )
      } else {
        await tx.query(
          `insert into stage_requirements (group_id, stage_key, required_count, created_at, created_by_user_id, updated_at, updated_by_user_id)
           values ($1, $2, $3, $4, $5, $4, $5)`,
          [group.id, stage.key, count, realAt, adminId],
        )
      }
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.requirement_set',
        targetType: 'group',
        targetId: group.id,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: { stageKey: stage.key, requiredCount: count, previousRevision: input.revision },
      })
      // 要求份數是計算基礎的一部分（票 24）：這一組有生效中的更正就進「待復核」。
      await flagOverridesForReview(tx, this.#events, {
        groupId: group.id,
        cohortId: cohort.id,
        actor: { kind: 'user', userId: adminId },
        realAt,
        businessAt: businessNow,
      })
      const receipt = { groupId: group.id, groupCode: group.code, stageKey: stage.key, stageName: stage.name, requiredCount: count }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { groupId: group.id, stageKey: stage.key } })
      return { ok: true as const, receipt: full }
    })
  }

  async assign(actor: ResolvedActor, input: AssignEvaluatorInput, requestId: string): Promise<Result<AssignEvaluatorReceipt>> {
    const denied = authorizeAdmin(actor, '指派評分老師')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.groupId)) return groupNotFound()
    if (!isUuid(input.teacherUserId)) return err('VALIDATION_FAILED', '請選評分老師。', { details: { field: 'teacherUserId' } })
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await lockGroupAndScheme(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { cohort, group, stages } = locked
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.assign',
          requestId,
          fingerprint: sha256(canonicalJson({ groupId: group.id, stageKey: input.stageKey, teacherUserId: input.teacherUserId })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<AssignEvaluatorReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort)
      if (group.status === 'dissolved') return dissolved(group.code)
      if (!stages) return noScheme()
      const stage = stageOf(stages, String(input.stageKey ?? ''))
      if (!stage) return err('VALIDATION_FAILED', '目前的評分規則沒有這個階段，請重新整理頁面。')

      const teacher = await eligibleTeacher(tx, input.teacherUserId)
      if (!teacher) return err('VALIDATION_FAILED', '找不到這位老師，或帳號已停用、不再是老師。', { details: { field: 'teacherUserId' } })
      const duplicate = await tx.query(
        `select 1 from evaluator_assignments where group_id = $1 and stage_key = $2 and teacher_user_id = $3 and valid_to is null`,
        [group.id, stage.key, teacher.userId],
      )
      if (duplicate.rowCount) return alreadyAssigned(teacher.name, group.code, stage.name)
      // 票 24：改派時選「保留」後，舊分掛在已結束的指派上繼續採計；同一位老師再被指派回來就會算兩票，擋掉。
      if (await hasCountedInStage(tx, group.id, stage.key, teacher.userId)) {
        return alreadyCounted(teacher.name, group.code, stage.name)
      }

      const assignmentId = uuidv7()
      await tx.query(
        `insert into evaluator_assignments
           (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [assignmentId, group.id, stage.key, teacher.userId, businessNow, adminId, realAt],
      )
      await this.#events.publish(tx, {
        type: 'grading.assigned',
        scope: 'cohort',
        cohortId: cohort.id,
        source: { type: 'grading_assignment', id: assignmentId, version: 1 },
        actor: { kind: 'user', userId: adminId },
        recipients: [teacher.userId],
        recipientBasis: { basis: 'evaluator_assignment', assignmentId },
        // 只放 ID 與標題：組別代號、階段名稱。**沒有任何分數**。
        payload: {
          title: `你被指派評分：${group.code}「${stage.name}」`,
          groupId: group.id,
          code: group.code,
          stageKey: stage.key,
        },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.assign',
        targetType: 'group',
        targetId: group.id,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: { assignmentId, stageKey: stage.key, teacherUserId: teacher.userId },
      })
      const receipt = { assignmentId, groupCode: group.code, stageName: stage.name, teacherName: teacher.name }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { assignmentId } })
      return { ok: true as const, receipt: full }
    })
  }

  // ── 老師暫存與正式送出 ──────────────────────────────────────────────────────

  async saveDraft(actor: ResolvedActor, input: ScoresInput, requestId: string): Promise<Result<DraftReceipt>> {
    return this.#writeEvaluation(actor, input, requestId, 'draft') as Promise<Result<DraftReceipt>>
  }

  async submitFinal(actor: ResolvedActor, input: ScoresInput, requestId: string): Promise<Result<FinalReceipt>> {
    return this.#writeEvaluation(actor, input, requestId, 'final') as Promise<Result<FinalReceipt>>
  }

  async #writeEvaluation(
    actor: ResolvedActor,
    input: ScoresInput,
    requestId: string,
    kind: 'draft' | 'final',
  ): Promise<Result<DraftReceipt | FinalReceipt>> {
    const who = authorizeTeacher(actor)
    if (!who.ok) return who
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.assignmentId)) return notAssigned()
    const scores = input.scores ?? {}
    const comment = normalizeComment(input.comment)
    if (!comment.ok) return comment
    const teacherId = who.userId
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const owner = await tx.query<{ group_id: string }>('select group_id from evaluator_assignments where id = $1', [input.assignmentId])
      const groupId = owner.rows[0]?.group_id
      if (!groupId) return notAssigned()
      const locked = await lockGroupAndScheme(tx, groupId)
      if (!locked) return notAssigned()
      const { cohort, group, stages, versionId, versionNo, versionStatus } = locked
      const assignment = (
        await tx.query<AssignmentRow>(
          'select id, group_id, stage_key, teacher_user_id, valid_to from evaluator_assignments where id = $1 for update',
          [input.assignmentId],
        )
      ).rows[0]!

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: teacherId,
          operationKind: kind === 'draft' ? 'grading.save_draft' : 'grading.submit_final',
          requestId,
          // 沒有評語時指紋跟加評語欄之前一樣。
          fingerprint: sha256(
            canonicalJson({ assignmentId: assignment.id, scores, ...(comment.value !== null ? { comment: comment.value } : {}) }),
          ),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<DraftReceipt | FinalReceipt>(begun)
      // 先驗「是不是本人的有效指派」：不是的話什麼都不說（不透露這組的狀態）。
      if (assignment.teacher_user_id !== teacherId || assignment.valid_to !== null) return notAssigned()
      if (cohort.status === 'archived') return archived(cohort)
      if (group.status === 'dissolved') return dissolved(group.code)
      if (!stages || !versionId) return noScheme()
      const stage = stageOf(stages, assignment.stage_key)
      if (!stage) return err('VALIDATION_FAILED', '目前的評分規則已經沒有這個階段，請聯絡系辦。')

      const normalized = normalizeScores(stage, scores, { complete: kind === 'final' })
      if (!normalized.ok) return normalized
      // B 階段 TE-B2a：系辦結算了這一階段就不能再暫存、送出、重送（方案頭列鎖內查，跟結算排隊）。
      if (await stageSettled(tx, cohort.id, stage.key)) return settledConflict(stage.name)

      // B 階段 TE-B1：正式送出後可以再暫存、再送出。重送＝舊的採計改成歷史（理由 `resubmitted`），這一筆採計。
      const counted = await tx.query<{ evaluation_id: string }>(
        'select evaluation_id from evaluation_status where assignment_id = $1 and state = $2',
        [assignment.id, 'counted'],
      )
      const previousCounted = kind === 'final' ? (counted.rows[0]?.evaluation_id ?? null) : null

      if (previousCounted) {
        await tx.query(
          `update evaluation_status set state = 'historical', revision = revision + 1, updated_at = $2, updated_by_user_id = $3
            where evaluation_id = $1`,
          [previousCounted, realAt, teacherId],
        )
        await tx.query(
          `insert into evaluation_status_events (id, evaluation_id, from_state, to_state, reason, actor_kind, actor_user_id, real_at)
           values ($1, $2, 'counted', 'historical', 'resubmitted', 'user', $3, $4)`,
          [uuidv7(), previousCounted, teacherId, realAt],
        )
      }
      if (kind === 'final') await reachFaultPoint('grading.final.before-insert')
      const evaluationId = uuidv7()
      await tx.query(
        `insert into evaluations
           (id, assignment_id, kind, scheme_version_id, scores, comment, submitted_real_at, submitted_business_at, request_id)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
        [evaluationId, assignment.id, kind, versionId, JSON.stringify(normalized.value), comment.value, realAt, businessNow, requestId],
      )
      const state = kind === 'draft' ? 'draft' : 'counted'
      await tx.query(
        `insert into evaluation_status (evaluation_id, assignment_id, state, created_at, updated_at, updated_by_user_id)
         values ($1, $2, $3, $4, $4, $5)`,
        [evaluationId, assignment.id, state, realAt, teacherId],
      )
      await tx.query(
        `insert into evaluation_status_events (id, evaluation_id, from_state, to_state, actor_kind, actor_user_id, real_at)
         values ($1, $2, null, $3, 'user', $4, $5)`,
        [uuidv7(), evaluationId, state, teacherId, realAt],
      )

      // 第一位老師**開始填**（第一份暫存或正式送出）：目前方案版本鎖定，之後改結構只能走新版本
      // （產品模組 06 §4「7.5」：「第一位老師開始填任何正式方案後，該方案結構即鎖定」；GRD-09）。已鎖定的就不動。
      // 鎖的一定是目前版本，`locked_at`＝鎖定時間。解散組別釘版本（`pg-grading-results.ts` 的 `dissolvedVersions`）靠這條：目前版本鎖定後，只會經套用換成同時鎖定的新版本。
      let lockedNow = false
      if (versionStatus === 'published') {
        const updated = await tx.query(
          `update grading_scheme_versions set status = 'locked', locked_at = $2 where id = $1 and status = 'published'`,
          [versionId, realAt],
        )
        lockedNow = (updated.rowCount ?? 0) > 0
      }

      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: teacherId,
        role: 'teacher',
        action: kind === 'draft' ? 'grading.save_draft' : 'grading.submit_final',
        targetType: 'evaluation',
        targetId: evaluationId,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: {
          assignmentId: assignment.id,
          groupId: group.id,
          stageKey: stage.key,
          schemeVersionId: versionId,
          schemeLocked: lockedNow,
          // 重送：被改成歷史的那一筆（系辦評分紀錄據此標「老師重新送出」）。不發通知（D6）。
          ...(previousCounted ? { resubmitted: true, previousEvaluationId: previousCounted } : {}),
        },
      })
      // 新的一份採計＝計算基礎改變（票 24）：這一組有生效中的更正就進「待復核」。
      if (kind === 'final') {
        await flagOverridesForReview(tx, this.#events, {
          groupId: group.id,
          cohortId: cohort.id,
          actor: { kind: 'user', userId: teacherId },
          realAt,
          businessAt: businessNow,
        })
      }

      const summary = summarizeScores(stage, normalized.value)
      const receipt: DraftReceipt | FinalReceipt =
        kind === 'draft'
          ? { assignmentId: assignment.id, evaluationId, savedAt: realAt.toISOString(), filled: summary.filled, total: summary.total }
          : {
              assignmentId: assignment.id,
              evaluationId,
              groupCode: group.code,
              stageName: stage.name,
              receivedAt: realAt.toISOString(),
              teacherScore: summary.score,
              gate: summary.gate === 'incomplete' ? null : summary.gate,
              versionNo: versionNo!,
            }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { evaluationId } })
      return { ok: true as const, receipt: full }
    })
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return runGrading(this.#pool, body)
  }
}

/** 評分寫入的交易外殼：唯一鍵撞到時翻成使用者看得懂的一句話（票 24 的用例共用）。 */
export function runGrading<R>(pool: PoolSource, body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
  return inTransaction(pool, 'grading', body, (constraint) => {
    if (constraint === 'evaluation_status_one_counted') {
      return err('CONFLICT', '這一份評分剛剛同時有另一次送出，請重新整理頁面看最新的內容再送。')
    }
    if (constraint === 'evaluator_assignments_one_active') {
      return err('VALIDATION_FAILED', '這位老師剛剛已經被指派評這一組的這個階段了；請重新整理頁面。')
    }
    return err('CONFLICT', '剛剛有人同時修改了同一份評分資料，請重新整理頁面再試一次。')
  })
}

/**
 * 這位老師在這一組這一階段是否已有採計中的正式評分（不看指派是否還有效）。
 * 改派選「保留」「新增」後舊分掛在已結束的指派上；同一人再拿到新指派就會一人兩票（產品 7.4「同一老師不因改派多算一票」）。
 */
export async function hasCountedInStage(tx: PoolClient, groupId: string, stageKey: string, teacherUserId: string): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from evaluation_status s join evaluator_assignments a on a.id = s.assignment_id
      where a.group_id = $1 and a.stage_key = $2 and a.teacher_user_id = $3 and s.state = 'counted' limit 1`,
    [groupId, stageKey, teacherUserId],
  )
  return (rows.rowCount ?? 0) > 0
}

export function alreadyCounted(teacherName: string, groupCode: string, stageName: string): Err {
  return err(
    'VALIDATION_FAILED',
    `${teacherName} 老師在 ${groupCode}「${stageName}」已有一份計入成績的評分（改派時選了保留），同一位老師不能再算一票；請改指派其他老師。`,
    { details: { field: 'teacherUserId' } },
  )
}

export function alreadyAssigned(teacherName: string, groupCode: string, stageName: string): Err {
  return err('VALIDATION_FAILED', `${teacherName} 老師已經被指派評 ${groupCode}「${stageName}」了，不能重複指派。`)
}

// ── 查詢 ────────────────────────────────────────────────────────────────────

type EvaluationRow = {
  scheme_version_id: string
  scores: Record<string, string>
  comment: string | null
  submitted_real_at: Date
}

/**
 * 一個指派目前的評分（B 階段 TE-B1）：`counted` 是採計那一筆；`draft` 是**晚於採計**的最新暫存
 * （沒有採計時就是最新暫存）——有採計又有 `draft`＝正式送出後又改了還沒重送（`draftAfterFinal`）。
 * `finals` 是每一次正式送出的時間（舊的在前，含已成歷史、被退回的）。退回、歷史、失效的暫存都不算目前的評分。
 */
export type CurrentEvaluation = {
  readonly counted: EvaluationRow | null
  readonly draft: EvaluationRow | null
  readonly finals: readonly Date[]
}

type CurrentRow = {
  assignment_id: string
  c_version: string | null
  c_scores: Record<string, string> | null
  c_comment: string | null
  c_at: Date | null
  d_version: string | null
  d_scores: Record<string, string> | null
  d_comment: string | null
  d_at: Date | null
  finals: Date[] | null
}

/** 每個指派目前的評分（見 `CurrentEvaluation`）；固定 1 句，不隨指派數增加。 */
export async function latestEvaluations(
  db: Pick<Pool, 'query'>,
  assignmentIds: readonly string[],
): Promise<Map<string, CurrentEvaluation>> {
  if (assignmentIds.length === 0) return new Map()
  const rows = await db.query<CurrentRow>(
    `select a.id as assignment_id,
            c.scheme_version_id as c_version, c.scores as c_scores, c.comment as c_comment, c.submitted_real_at as c_at,
            d.scheme_version_id as d_version, d.scores as d_scores, d.comment as d_comment, d.submitted_real_at as d_at,
            h.finals
       from unnest($1::uuid[]) as a(id)
       left join lateral (
         select e.scheme_version_id, e.scores, e.comment, e.submitted_real_at
           from evaluations e join evaluation_status s on s.evaluation_id = e.id
          where e.assignment_id = a.id and s.state = 'counted' limit 1
       ) c on true
       left join lateral (
         select e.scheme_version_id, e.scores, e.comment, e.submitted_real_at
           from evaluations e join evaluation_status s on s.evaluation_id = e.id
          where e.assignment_id = a.id and s.state = 'draft' and (c.submitted_real_at is null or e.submitted_real_at > c.submitted_real_at)
          order by e.submitted_real_at desc, e.id desc limit 1
       ) d on true
       left join lateral (
         select array_agg(e.submitted_real_at order by e.submitted_real_at, e.id) as finals
           from evaluations e where e.assignment_id = a.id and e.kind = 'final'
       ) h on true`,
    [assignmentIds],
  )
  const out = new Map<string, CurrentEvaluation>()
  for (const r of rows.rows) {
    const counted =
      r.c_at && r.c_version && r.c_scores
        ? { scheme_version_id: r.c_version, scores: r.c_scores, comment: r.c_comment, submitted_real_at: r.c_at }
        : null
    const draft =
      r.d_at && r.d_version && r.d_scores
        ? { scheme_version_id: r.d_version, scores: r.d_scores, comment: r.d_comment, submitted_real_at: r.d_at }
        : null
    if (counted || draft || r.finals?.length) out.set(r.assignment_id, { counted, draft, finals: r.finals ?? [] })
  }
  return out
}

type ReturnedRow = {
  assignment_id: string
  scores: Record<string, string>
  comment: string | null
  submitted_real_at: Date
  reason: string
  returned_at: Date
}

/**
 * 每個指派最近一次被系辦退回的評分（票 24）：老師重新送出前，畫面顯示退回理由，並把退回前的分數預填回表單。
 * 同一個指派已經有新的採計，就不再算「被退回」（呼叫端判斷）。
 */
export async function latestReturned(db: Pick<Pool, 'query'>, assignmentIds: readonly string[]): Promise<Map<string, ReturnedRow>> {
  if (assignmentIds.length === 0) return new Map()
  const rows = await db.query<ReturnedRow>(
    `select distinct on (e.assignment_id) e.assignment_id, e.scores, e.comment, e.submitted_real_at, ev.reason, ev.real_at as returned_at
       from evaluations e
       join evaluation_status s on s.evaluation_id = e.id and s.state = 'returned'
       join lateral (
         select x.reason, x.real_at from evaluation_status_events x
          where x.evaluation_id = e.id and x.to_state = 'returned' order by x.real_at desc, x.id desc limit 1
       ) ev on true
      where e.assignment_id = any($1::uuid[])
      order by e.assignment_id, ev.real_at desc, e.id desc`,
    [assignmentIds],
  )
  return new Map(rows.rows.map((r) => [r.assignment_id, r]))
}

/** 本組現任組長的顯示名（`g`＝groups）；放在主查詢裡當子查詢，不逐組再查。 */
const LEADER_NAME = `(select coalesce(nullif(btrim(lp.display_name), ''), lu.name)
     from group_leaders gl join users lu on lu.id = gl.user_id left join user_profiles lp on lp.user_id = gl.user_id
    where gl.group_id = g.id and gl.valid_to is null limit 1)`

function stateOf(current: CurrentEvaluation | undefined): EvaluationState {
  return current?.counted ? 'counted' : current?.draft ? 'draft' : 'empty'
}

/** 本屆本階段的現行結算（`c`＝cohorts、`a`＝evaluator_assignments）；放在主查詢裡當子查詢，不另查。 */
const SETTLED_AT = `(select gs.settled_at from grade_settlements gs
    where gs.cohort_id = c.id and gs.stage_key = a.stage_key and gs.released_at is null)`

export class PgGradingQuery implements GradingQuery, AssignmentsForTeacherQuery {
  readonly #reader: () => Pick<Pool, 'query'>
  readonly #submissions: Pick<AdvisorSubmissionQuery, 'groupVersionsWithFiles'> | undefined

  /** `submissions`：評分單組頁的「本組正式繳交與附件」（模組 05 的 port，由 composition 注入；只有 `teacherBenchPage` 用）。 */
  constructor(reader: () => Pick<Pool, 'query'> = getPool, submissions?: Pick<AdvisorSubmissionQuery, 'groupVersionsWithFiles'>) {
    this.#reader = reader
    this.#submissions = submissions
  }

  async adminBoard(actor: ResolvedActor, cohortId: string): Promise<Result<AdminGradingBoard>> {
    const denied = authorizeAdmin(actor, '查看評分')
    if (denied) return denied
    if (!isUuid(cohortId)) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
    const db = this.#reader()
    const cohort = (await db.query<CohortRow>('select id, code, name, status from cohorts where id = $1', [cohortId])).rows[0]
    if (!cohort) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')

    const scheme = (
      await db.query<SchemeRow>('select id, cohort_id, current_version_id, revision from grading_schemes where cohort_id = $1', [cohortId])
    ).rows[0]
    const versionRows = scheme
      ? (
          await db.query<VersionRow>(
            `select id, scheme_id, version_no, stages, status, created_at, locked_at
               from grading_scheme_versions where scheme_id = $1 order by version_no desc`,
            [scheme.id],
          )
        ).rows
      : []
    const versions: SchemeVersionView[] = versionRows.map((v) => ({
      id: v.id,
      versionNo: v.version_no,
      status: v.status,
      stages: readSchemeStages(v.stages),
      isCurrent: v.id === scheme?.current_version_id,
      createdAt: v.created_at,
      lockedAt: v.locked_at,
    }))
    const stagesByVersion = new Map(versions.map((v) => [v.id, v.stages]))

    const groups = await db.query<{ id: string; code: string; advisor_name: string | null }>(
      `select g.id, g.code, coalesce(nullif(btrim(p.display_name), ''), u.name) as advisor_name
         from groups g
         left join advisor_assignments a on a.group_id = g.id and a.valid_to is null
         left join users u on u.id = a.teacher_user_id
         left join user_profiles p on p.user_id = a.teacher_user_id
        where g.cohort_id = $1 and g.status = 'active'
        order by g.code`,
      [cohortId],
    )
    const requirements = await db.query<{ group_id: string; stage_key: string; required_count: number; revision: number }>(
      `select r.group_id, r.stage_key, r.required_count, r.revision
         from stage_requirements r join groups g on g.id = r.group_id where g.cohort_id = $1`,
      [cohortId],
    )
    const assignments = await db.query<{
      id: string
      group_id: string
      stage_key: string
      teacher_user_id: string
      teacher_name: string
      inactive: boolean
    }>(
      `select a.id, a.group_id, a.stage_key, a.teacher_user_id,
              coalesce(nullif(btrim(p.display_name), ''), u.name) as teacher_name,
              not (u.status = 'active' and u.deidentified_at is null
                   and exists (select 1 from role_assignments r
                                where r.user_id = u.id and r.role = 'teacher' and r.revoked_real_at is null)) as inactive
         from evaluator_assignments a
         join groups g on g.id = a.group_id
         join users u on u.id = a.teacher_user_id
         left join user_profiles p on p.user_id = a.teacher_user_id
        where g.cohort_id = $1 and a.valid_to is null
        order by a.created_at, a.id`,
      [cohortId],
    )
    const latest = await latestEvaluations(
      db,
      assignments.rows.map((a) => a.id),
    )
    const assignmentViews: AdminAssignmentView[] = assignments.rows.map((a) => {
      const current = latest.get(a.id)
      // 有採計看採計那一筆（正式送出後的新暫存不影響系辦看到的分數，AC-A-2），否則看最新暫存。
      const row = current?.counted ?? current?.draft ?? null
      // 正式分數一律照目前版本算（方案鎖定後套用新版本＝用新權重重算，票 24）；暫存照它填的版本算。
      const currentStages = versions.find((v) => v.isCurrent)?.stages ?? []
      const stage = row
        ? current?.counted
          ? stageOf(currentStages, a.stage_key)
          : stageOf(stagesByVersion.get(row.scheme_version_id) ?? [], a.stage_key)
        : null
      const summary = row && stage ? summarizeScores(stage, current?.counted ? row.scores : pick(stage, row.scores)) : null
      return {
        id: a.id,
        groupId: a.group_id,
        stageKey: a.stage_key,
        teacherUserId: a.teacher_user_id,
        teacherName: a.teacher_name,
        teacherInactive: a.inactive,
        state: stateOf(current),
        score: summary?.score ?? null,
        filled: summary?.filled ?? 0,
        total: summary?.total ?? 0,
        updatedAt: row?.submitted_real_at ?? null,
        comment: row?.comment ?? null,
      }
    })

    const teachers = await db.query<{ id: string; name: string }>(
      `select u.id, coalesce(nullif(btrim(p.display_name), ''), u.name) as name
         from users u left join user_profiles p on p.user_id = u.id
        where u.status = 'active' and u.deidentified_at is null
          and exists (select 1 from role_assignments r where r.user_id = u.id and r.role = 'teacher' and r.revoked_real_at is null)
        order by 2`,
    )

    return ok(
      {
        cohort: { id: cohort.id, code: cohort.code, name: cohort.name, archived: cohort.status === 'archived' },
        schemeId: scheme?.id ?? null,
        versions,
        current: versions.find((v) => v.isCurrent) ?? null,
        groups: groups.rows.map((g) => ({ id: g.id, code: g.code, advisorName: g.advisor_name })),
        requirements: requirements.rows.map((r) => ({
          groupId: r.group_id,
          stageKey: r.stage_key,
          requiredCount: r.required_count,
          revision: r.revision,
        })),
        assignments: assignmentViews,
        teachers: teachers.rows.map((t) => ({ userId: t.id, name: t.name })),
      },
      { requestId: uuidv7(), serverTime: new Date().toISOString() },
    )
  }

  async teacherQueue(actor: ResolvedActor): Promise<readonly TeacherQueueEntry[]> {
    const who = authorizeTeacher(actor)
    if (!who.ok) return []
    const db = this.#reader()
    const rows = await db.query<{
      id: string
      group_id: string
      group_code: string
      stage_key: string
      cohort_code: string
      cohort_name: string
      stages: unknown
      leader_name: string | null
      settled_at: Date | null
    }>(
      `select a.id, a.group_id, g.code as group_code, a.stage_key, c.code as cohort_code, c.name as cohort_name, v.stages,
              ${LEADER_NAME} as leader_name, ${SETTLED_AT} as settled_at
         from evaluator_assignments a
         join groups g on g.id = a.group_id and g.status = 'active'
         join cohorts c on c.id = g.cohort_id and c.status <> 'archived'
         join grading_schemes s on s.cohort_id = c.id
         join grading_scheme_versions v on v.id = s.current_version_id
        where a.teacher_user_id = $1 and a.valid_to is null
        order by c.code, g.code, a.stage_key`,
      [who.userId],
    )
    const ids = rows.rows.map((r) => r.id)
    const [latest, returned] = await Promise.all([latestEvaluations(db, ids), latestReturned(db, ids)])
    return rows.rows.flatMap((r): TeacherQueueEntry[] => {
      const stages = readSchemeStages(r.stages)
      const stage = stageOf(stages, r.stage_key)
      if (!stage) return []
      const current = latest.get(r.id)
      const counted = current?.counted ?? null
      const row = counted ?? current?.draft ?? null
      const summary = row ? summarizeScores(stage, pick(stage, row.scores)) : null
      return [
        {
          assignmentId: r.id,
          cohortCode: r.cohort_code,
          cohortName: r.cohort_name,
          groupId: r.group_id,
          groupCode: r.group_code,
          stageKey: stage.key,
          stageName: stage.name,
          state: stateOf(current),
          filled: summary?.filled ?? 0,
          total: stage.items.length,
          returned: returned.has(r.id) && !counted,
          leaderName: r.leader_name,
          // 跟評閱桌同一個算法：正式分數照目前方案版本算（`teacherBench` 的採計分支）。
          finalScore: counted ? summarizeScores(stage, counted.scores).score : null,
          submittedAt: counted?.submitted_real_at ?? null,
          draftAfterFinal: !!counted && !!current?.draft,
          settled: r.settled_at !== null,
        },
      ]
    })
  }

  async teacherBench(actor: ResolvedActor, groupId: string): Promise<Result<TeacherBench>> {
    const loaded = await this.#bench(actor, groupId)
    if (!loaded.ok) return loaded
    return ok(loaded.bench, { requestId: uuidv7(), serverTime: new Date().toISOString() })
  }

  /**
   * 評分單組頁（TE-11）：評閱桌（4 句）、隊列（3 句）、本組正式繳交與附件（3 句）三路並行，固定 10 句、深度 2。
   * 上一組／下一組由頁面用 `queue` 算，不另查；附件一次批次讀，不逐份呼叫 `receiverVersion`。
   * 沒注入繳交查詢是組裝錯誤（程式寫錯，不是使用者會走到的路），直接 throw；`getGradingQuery()` 一定有注入。
   */
  async teacherBenchPage(actor: ResolvedActor, groupId: string): Promise<Result<TeacherBenchPage>> {
    if (!this.#submissions) throw new Error('PgGradingQuery 沒有注入繳交查詢（composition/grading.ts 的 getGradingQuery）。')
    const [loaded, queue, submissions] = await Promise.all([
      this.#bench(actor, groupId),
      this.teacherQueue(actor),
      this.#submissions.groupVersionsWithFiles(actor, groupId),
    ])
    if (!loaded.ok) return loaded
    return ok(
      { ...loaded.bench, leaderName: loaded.leaderName, queue, submissions: submissions ?? [] },
      { requestId: uuidv7(), serverTime: new Date().toISOString() },
    )
  }

  /**
   * 系辦首頁（AD-21）：本屆待復核的更正，1 句。口徑同 `PgGradebookQuery.gradebook` 的 `pendingReviews`：
   * 只算進行中的組（解散的組不能再復核），新的在前。
   */
  async pendingReviews(actor: ResolvedActor, cohortId: string): Promise<Result<readonly PendingReview[]>> {
    const denied = authorizeAdmin(actor, '查看評分')
    if (denied) return denied
    if (!isUuid(cohortId)) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
    const rows = await this.#reader().query<{
      id: string
      group_id: string
      code: string
      original_value: string
      new_value: string
      reason: string
    }>(
      `select o.id, o.group_id, g.code, o.original_value::text as original_value, o.new_value::text as new_value, o.reason
         from grade_overrides o
         join override_review_state r on r.override_id = o.id
         join groups g on g.id = o.group_id
        where g.cohort_id = $1 and g.status = 'active' and r.state = 'pending_review'
        order by o.real_at desc, o.id desc`,
      [cohortId],
    )
    return okList(
      rows.rows.map((o) => ({
        overrideId: o.id,
        groupId: o.group_id,
        groupCode: o.code,
        originalValue: exactScore(o.original_value),
        newValue: exactScore(o.new_value),
        reason: o.reason,
      })),
    )
  }

  /**
   * 系辦首頁評分卡（AD-21）：1 句。口徑同 `admin/grading/progress.ts` 的 `teacherProgress`（全部階段、排除解散組）：
   * 分母＝進行中組別上、目前方案版本有的階段的有效指派份數；分子＝其中有採計的份數。
   */
  async progressSummary(actor: ResolvedActor, cohortId: string): Promise<Result<GradingProgressSummary>> {
    const denied = authorizeAdmin(actor, '查看評分')
    if (denied) return denied
    if (!isUuid(cohortId)) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
    const row = (
      await this.#reader().query<{ required: number; counted: number }>(
        `select count(*)::int as required,
                count(*) filter (where exists (
                  select 1 from evaluation_status s where s.assignment_id = a.id and s.state = 'counted'))::int as counted
           from evaluator_assignments a
           join groups g on g.id = a.group_id and g.status = 'active'
           join grading_schemes sc on sc.cohort_id = g.cohort_id
           join grading_scheme_versions v on v.id = sc.current_version_id
          where g.cohort_id = $1 and a.valid_to is null
            and exists (select 1 from jsonb_array_elements(v.stages) st where st->>'key' = a.stage_key)`,
        [cohortId],
      )
    ).rows[0]
    return ok({ counted: row?.counted ?? 0, required: row?.required ?? 0 }, { requestId: uuidv7(), serverTime: new Date().toISOString() })
  }

  /** 評閱桌本體：指派＋頭列（含組長）合併 1 句，再並行讀組員、目前評分、退回各 1 句。 */
  async #bench(actor: ResolvedActor, groupId: string): Promise<{ ok: true; bench: TeacherBench; leaderName: string | null } | Err> {
    const who = authorizeTeacher(actor)
    if (!who.ok) return who
    if (!isUuid(groupId)) return notAssigned()
    const db = this.#reader()
    const assignments = await db.query<{
      id: string
      stage_key: string
      code: string
      cohort_code: string
      cohort_name: string
      version_id: string | null
      version_no: number | null
      stages: unknown
      leader_name: string | null
      settled_at: Date | null
    }>(
      `select a.id, a.stage_key, g.code, c.code as cohort_code, c.name as cohort_name, v.id as version_id, v.version_no, v.stages,
              ${LEADER_NAME} as leader_name, ${SETTLED_AT} as settled_at
         from evaluator_assignments a
         join groups g on g.id = a.group_id
         join cohorts c on c.id = g.cohort_id
         left join grading_schemes s on s.cohort_id = c.id
         left join grading_scheme_versions v on v.id = s.current_version_id
        where a.group_id = $1 and a.teacher_user_id = $2 and a.valid_to is null
        order by a.stage_key`,
      [groupId, who.userId],
    )
    const head = assignments.rows[0]
    if (!head) return notAssigned()

    const ids = assignments.rows.map((a) => a.id)
    const [members, latest, returnedRows] = await Promise.all([
      db.query<{ name: string }>(
        `select coalesce(nullif(btrim(p.display_name), ''), u.name) as name
           from group_memberships m join users u on u.id = m.user_id left join user_profiles p on p.user_id = m.user_id
          where m.group_id = $1 and m.valid_to is null order by m.valid_from, m.user_id`,
        [groupId],
      ),
      latestEvaluations(db, ids),
      latestReturned(db, ids),
    ])
    const stages = readSchemeStages(head.stages)

    const entries: BenchEntry[] = assignments.rows.flatMap((a): BenchEntry[] => {
      const stage = stageOf(stages, a.stage_key)
      if (!stage) return []
      const current = latest.get(a.id)
      const state = stateOf(current)
      const settled = a.settled_at ? { settledAt: a.settled_at } : null
      const submissionHistory = (current?.finals ?? []).map((at, i) => ({ no: i + 1, at }))
      const counted = current?.counted
      if (counted) {
        // 正式分數一律照**目前**方案版本算（票 24：方案鎖定後套用新版本＝用新權重重算舊分數；成績表同一個算法）。
        // 正式送出後又暫存（TE-B1）：表單顯示那筆暫存，正式分數仍是採計那一筆。
        const draft = current.draft
        return [
          {
            assignmentId: a.id,
            stage,
            state,
            scores: draft ? pick(stage, draft.scores) : counted.scores,
            savedAt: (draft ?? counted).submitted_real_at,
            submittedAt: counted.submitted_real_at,
            finalScore: summarizeScores(stage, counted.scores).score,
            draftFromOlderVersion: !!draft && draft.scheme_version_id !== head.version_id,
            returned: null,
            comment: (draft ?? counted).comment,
            draftAfterFinal: !!draft,
            resubmittable: !settled,
            settled,
            submissionHistory,
          },
        ]
      }
      // 被退回、還沒重新送出：理由一直顯示；退回的那一份比最新暫存新，就把它預填回表單。
      const row = current?.draft ?? null
      const back = returnedRows.get(a.id)
      const prefillFromReturned = !!back && (!row || back.returned_at.getTime() > row.submitted_real_at.getTime())
      return [
        {
          assignmentId: a.id,
          stage,
          state,
          scores: prefillFromReturned ? pick(stage, back.scores) : row ? pick(stage, row.scores) : {},
          savedAt: row?.submitted_real_at ?? null,
          submittedAt: null,
          finalScore: null,
          draftFromOlderVersion: !prefillFromReturned && !!row && row.scheme_version_id !== head.version_id,
          returned: back ? { reason: back.reason, returnedAt: back.returned_at } : null,
          comment: prefillFromReturned ? back.comment : (row?.comment ?? null),
          draftAfterFinal: false,
          resubmittable: false,
          settled,
          submissionHistory,
        },
      ]
    })
    if (entries.length === 0) return noScheme()

    return {
      ok: true,
      bench: {
        groupId,
        groupCode: head.code,
        cohortCode: head.cohort_code,
        cohortName: head.cohort_name,
        memberNames: members.rows.map((m) => m.name),
        versionNo: head.version_no ?? 0,
        entries,
      },
      leaderName: head.leader_name,
    }
  }

  /** 票 19 重派對話框：原老師在本組的有效評分指派（只有管理員頁面會叫，頁面本身已過管理員守衛）。 */
  async listForGroup(groupId: string, teacherUserId: string): Promise<readonly TeacherGroupAssignment[]> {
    if (!isUuid(groupId) || !isUuid(teacherUserId)) return []
    const db = this.#reader()
    const rows = await db.query<{ id: string; stage_key: string; stages: unknown }>(
      `select a.id, a.stage_key, v.stages
         from evaluator_assignments a
         join groups g on g.id = a.group_id
         left join grading_schemes s on s.cohort_id = g.cohort_id
         left join grading_scheme_versions v on v.id = s.current_version_id
        where a.group_id = $1 and a.teacher_user_id = $2 and a.valid_to is null
        order by a.created_at, a.id`,
      [groupId, teacherUserId],
    )
    const latest = await latestEvaluations(
      db,
      rows.rows.map((r) => r.id),
    )
    return rows.rows.map((r) => {
      const state = stateOf(latest.get(r.id))
      return {
        id: r.id,
        stageName: stageOf(readSchemeStages(r.stages), r.stage_key)?.name ?? r.stage_key,
        state: state === 'counted' ? 'submitted' : state,
      }
    })
  }
}

/** 只留目前方案有的項目（暫存是照舊版本填的時候，多出來的項目不帶到畫面）。 */
export function pick(stage: SchemeStage, scores: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of stage.items) if (typeof scores[item.key] === 'string') out[item.key] = scores[item.key]!
  return out
}

// ── 鎖與共用查詢 ────────────────────────────────────────────────────────────

export async function lockCohort(tx: PoolClient, cohortId: string): Promise<CohortRow | null> {
  const rows = await tx.query<CohortRow>('select id, code, name, status from cohorts where id = $1 for share', [cohortId])
  return rows.rows[0] ?? null
}

/**
 * 鎖順序：屆別 FOR SHARE → 組別 FOR SHARE → 方案頭列 FOR SHARE（見檔頭）。回傳目前方案版本的階段
 * （還沒有發布過版本是 null）。
 */
export async function lockGroupAndScheme(
  tx: PoolClient,
  groupId: string,
): Promise<{
  cohort: CohortRow
  group: GroupRow
  stages: SchemeStage[] | null
  versionId: string | null
  versionNo: number | null
  versionStatus: SchemeVersionStatus | null
} | null> {
  const owner = await tx.query<{ cohort_id: string }>('select cohort_id from groups where id = $1', [groupId])
  const cohortId = owner.rows[0]?.cohort_id
  if (!cohortId) return null
  const cohort = await lockCohort(tx, cohortId)
  const group = (
    await tx.query<GroupRow>('select id, cohort_id, code, status from groups where id = $1 for share', [groupId])
  ).rows[0]
  if (!cohort || !group) return null
  const scheme = (
    await tx.query<SchemeRow>('select id, cohort_id, current_version_id, revision from grading_schemes where cohort_id = $1 for share', [
      cohortId,
    ])
  ).rows[0]
  if (!scheme?.current_version_id) return { cohort, group, stages: null, versionId: null, versionNo: null, versionStatus: null }
  const version = (
    await tx.query<VersionRow>(
      'select id, scheme_id, version_no, stages, status, created_at, locked_at from grading_scheme_versions where id = $1',
      [scheme.current_version_id],
    )
  ).rows[0]!
  return {
    cohort,
    group,
    stages: readSchemeStages(version.stages),
    versionId: version.id,
    versionNo: version.version_no,
    versionStatus: version.status,
  }
}

/** 帳號正常、目前有老師角色的人；不是就回 null。 */
export async function eligibleTeacher(tx: PoolClient, userId: string): Promise<{ userId: string; name: string } | null> {
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
