import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import { hasRole, statusGate, type ResolvedActor } from '@/application/accounts'
import { canManageCohorts, type BusinessClockSource } from '@/application/cohorts'
import {
  optionalReason,
  readSchemeStages,
  type GradingSettlementCommand,
  type GradingSettlementQuery,
  type ReleaseReceipt,
  type Settlement,
  type SettlementHistory,
  type SettlementReceipt,
} from '@/application/grading'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import { authorizeAdmin, badRequestId, cohortNotFound, inTransaction, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { archived, isUuid, lockCohort, noScheme, okList, stageOf } from '@/infrastructure/grading/pg-grading'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, ok, type Err, type Result } from '@/shared/result'
import { formatTaipeiMinute, RealClock, type Clock } from '@/shared/time'

/**
 * 系辦結算（B 階段 TE-B2a；設計方案 §2）：結算一屆的一個評分階段，結算期間老師不能暫存、送出、重送；解除後恢復。
 *
 * 鎖順序（契約 01 §6；跟 `pg-grading.ts`、`pg-grading-results.ts` 一樣 cohorts → groups → grading_schemes）：
 * `cohorts FOR SHARE` → `grading_schemes` 頭列 `FOR UPDATE`（結算不碰組別，跳過 groups）。老師的暫存、送出、重送在同一個頭列拿
 * `FOR SHARE` 後查現行結算，所以兩邊排隊：先結算 → 老師 `CONFLICT`；先送出 → 結算的採計份數含這一份（§2.4 交錯案例）。
 * 兩位系辦同時結算同一階段：在頭列排隊，後到的看到現行結算 → `CONFLICT`；部分唯一 `grade_settlements_active_one` 是後備防線。
 *
 * 守衛順序：FORBIDDEN → VALIDATION_FAILED → COHORT_ARCHIVED → CONFLICT。錯誤碼表沒有 NOT_FOUND，「找不到這筆結算」用
 * VALIDATION_FAILED（同全站「找不到…請重新整理頁面」）。不發通知、不新增事件（設計方案 §2.2）。
 */

const MAX_REASON_LENGTH = 500

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

type SettlementRow = {
  id: string
  cohort_id: string
  stage_key: string
  settled_at: Date
  settled_by_user_id: string
  settled_by_name: string
  reason: string | null
  counted_evaluations: number
  released_at: Date | null
  released_by_user_id: string | null
  released_by_name: string | null
  release_reason: string | null
}

const NAME = (alias: string, profile: string) => `coalesce(nullif(btrim(${profile}.display_name), ''), ${alias}.name)`

const SETTLEMENT_SELECT = `
  select gs.id, gs.cohort_id, gs.stage_key, gs.settled_at, gs.settled_by_user_id, ${NAME('su', 'sp')} as settled_by_name,
         gs.reason, gs.counted_evaluations, gs.released_at, gs.released_by_user_id, ${NAME('ru', 'rp')} as released_by_name,
         gs.release_reason
    from grade_settlements gs
    join users su on su.id = gs.settled_by_user_id
    left join user_profiles sp on sp.user_id = gs.settled_by_user_id
    left join users ru on ru.id = gs.released_by_user_id
    left join user_profiles rp on rp.user_id = gs.released_by_user_id`

/**
 * 理由（C1-04、X2 改選填）：沒填或只有空白存 null；有填就去掉頭尾空白、1–500 字（資料庫 check 同一個數，按字元數算）。
 */
function reasonOf(value: unknown, what: string): { ok: true; value: string | null } | Err {
  return optionalReason(value, `${what}理由`, MAX_REASON_LENGTH)
}

function settlementNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這筆結算，請重新整理頁面。')
}

function toSettlement(r: SettlementRow, stageName: string): Settlement {
  return {
    settlementId: r.id,
    cohortId: r.cohort_id,
    stageKey: r.stage_key,
    stageName,
    settledAt: r.settled_at,
    settledBy: { userId: r.settled_by_user_id, name: r.settled_by_name },
    reason: r.reason,
    countedEvaluations: r.counted_evaluations,
  }
}

function toHistory(r: SettlementRow, stageName: string): SettlementHistory {
  return {
    ...toSettlement(r, stageName),
    releasedAt: r.released_at,
    releasedBy: r.released_by_user_id ? { userId: r.released_by_user_id, name: r.released_by_name ?? '' } : null,
    releaseReason: r.release_reason,
  }
}

/** 目前方案版本的階段（還沒發布過是空的）。 */
async function currentStages(db: Pick<Pool, 'query'>, cohortId: string) {
  const rows = await db.query<{ stages: unknown }>(
    `select v.stages from grading_schemes s join grading_scheme_versions v on v.id = s.current_version_id where s.cohort_id = $1`,
    [cohortId],
  )
  return rows.rows[0] ? readSchemeStages(rows.rows[0].stages) : []
}

/** 帳本存的回執是 JSON：重放時把日期欄轉回 `Date`，跟第一次回的一樣。 */
function reviveDates<R>(result: Result<R>, keys: readonly string[]): Result<R> {
  if (!result.ok) return result
  const receipt: Record<string, unknown> = { ...result.receipt }
  for (const k of keys) if (typeof receipt[k] === 'string') receipt[k] = new Date(receipt[k] as string)
  return { ok: true, receipt: receipt as typeof result.receipt }
}

export class PgGradingSettlementCommand implements GradingSettlementCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  async settleStage(
    actor: ResolvedActor,
    input: { readonly cohortId: string; readonly stageKey: string; readonly reason?: string | null },
    requestId: string,
  ): Promise<Result<SettlementReceipt>> {
    const denied = authorizeAdmin(actor, '結算成績')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.cohortId)) return cohortNotFound()
    const reason = reasonOf(input.reason, '結算')
    if (!reason.ok) return reason
    const stageKey = String(input.stageKey ?? '')
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const cohort = await lockCohort(tx, input.cohortId)
      if (!cohort) return cohortNotFound()
      const scheme = (
        await tx.query<{ id: string; current_version_id: string | null }>(
          'select id, current_version_id from grading_schemes where cohort_id = $1 for update',
          [cohort.id],
        )
      ).rows[0]
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.settle',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId: cohort.id, stageKey, reason: reason.value ?? '' })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return reviveDates(replayed<SettlementReceipt>(begun), ['settledAt'])
      if (!scheme?.current_version_id) return noScheme()
      const version = (
        await tx.query<{ stages: unknown }>('select stages from grading_scheme_versions where id = $1', [scheme.current_version_id])
      ).rows[0]!
      const stage = stageOf(readSchemeStages(version.stages), stageKey)
      if (!stage) return err('VALIDATION_FAILED', '目前的評分規則沒有這個階段，請重新整理頁面。')
      if (cohort.status === 'archived') return archived(cohort)

      const active = (
        await tx.query<{ settled_at: Date }>(
          'select settled_at from grade_settlements where cohort_id = $1 and stage_key = $2 and released_at is null',
          [cohort.id, stage.key],
        )
      ).rows[0]
      if (active) return err('CONFLICT', `${stage.name}已於 ${formatTaipeiMinute(active.settled_at)} 結算，請重新整理頁面。`)

      // 在頭列鎖內數：老師的送出、重送要等這筆結算提交才能進來（或在它之前已提交、已算進來）。
      const counted = (
        await tx.query<{ n: number }>(
          `select count(*)::int as n
             from evaluation_status s
             join evaluator_assignments a on a.id = s.assignment_id
             join groups g on g.id = a.group_id
            where g.cohort_id = $1 and a.stage_key = $2 and s.state = 'counted'`,
          [cohort.id, stage.key],
        )
      ).rows[0]!.n

      const settlementId = uuidv7()
      await tx.query(
        `insert into grade_settlements (id, cohort_id, stage_key, settled_at, settled_by_user_id, reason, counted_evaluations, request_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $4)`,
        [settlementId, cohort.id, stage.key, realAt, adminId, reason.value, counted, requestId],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.settle',
        targetType: 'grade_settlement',
        targetId: settlementId,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: { cohortId: cohort.id, stageKey: stage.key, stageName: stage.name, countedEvaluations: counted, reason: reason.value },
      })
      const name = await actorName(tx, adminId)
      const settlement: Settlement = {
        settlementId,
        cohortId: cohort.id,
        stageKey: stage.key,
        stageName: stage.name,
        settledAt: realAt,
        settledBy: { userId: adminId, name },
        reason: reason.value,
        countedEvaluations: counted,
      }
      const full = { ...settlement, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { settlementId } })
      return { ok: true as const, receipt: full }
    })
  }

  async releaseSettlement(
    actor: ResolvedActor,
    input: { readonly settlementId: string; readonly reason?: string | null },
    requestId: string,
  ): Promise<Result<ReleaseReceipt>> {
    const denied = authorizeAdmin(actor, '解除成績結算')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.settlementId)) return settlementNotFound()
    const reason = reasonOf(input.reason, '解除結算')
    if (!reason.ok) return reason
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const owner = await tx.query<{ cohort_id: string }>('select cohort_id from grade_settlements where id = $1', [input.settlementId])
      const cohortId = owner.rows[0]?.cohort_id
      if (!cohortId) return settlementNotFound()
      const cohort = (await lockCohort(tx, cohortId))!
      await tx.query('select 1 from grading_schemes where cohort_id = $1 for update', [cohortId])
      const row = (
        await tx.query<{ stage_key: string; settled_at: Date; counted_evaluations: number; released_at: Date | null }>(
          'select stage_key, settled_at, counted_evaluations, released_at from grade_settlements where id = $1 for update',
          [input.settlementId],
        )
      ).rows[0]!
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'grading.release',
          requestId,
          fingerprint: sha256(canonicalJson({ settlementId: input.settlementId, reason: reason.value ?? '' })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return reviveDates(replayed<ReleaseReceipt>(begun), ['releasedAt'])
      if (cohort.status === 'archived') return archived(cohort)
      const stageName = stageOf(await currentStages(tx, cohortId), row.stage_key)?.name ?? row.stage_key
      if (row.released_at) {
        return err('CONFLICT', `這筆結算已於 ${formatTaipeiMinute(row.released_at)} 解除，請重新整理頁面。`)
      }

      await tx.query(
        `update grade_settlements set released_at = $2, released_by_user_id = $3, release_reason = $4 where id = $1`,
        [input.settlementId, realAt, adminId, reason.value],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'grading.release',
        targetType: 'grade_settlement',
        targetId: input.settlementId,
        scope: 'cohort',
        cohortId,
        realAt,
        businessAt: businessNow,
        payload: { cohortId, stageKey: row.stage_key, stageName, countedEvaluations: row.counted_evaluations, reason: reason.value },
      })
      const receipt = { settlementId: input.settlementId, stageKey: row.stage_key, stageName, releasedAt: realAt }
      const full = { ...receipt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt: full, resultRef: { settlementId: input.settlementId } })
      return { ok: true as const, receipt: full }
    })
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'grading-settlement', body, (constraint) =>
      constraint === 'grade_settlements_active_one'
        ? err('CONFLICT', '這個階段剛剛已經有人結算了，請重新整理頁面。')
        : err('CONFLICT', '剛剛有人同時修改了同一份結算資料，請重新整理頁面再試一次。'),
    )
  }
}

async function actorName(db: Pick<Pool, 'query'>, userId: string): Promise<string> {
  const rows = await db.query<{ name: string }>(
    `select ${NAME('u', 'p')} as name from users u left join user_profiles p on p.user_id = u.id where u.id = $1`,
    [userId],
  )
  return rows.rows[0]?.name ?? ''
}

export class PgGradingSettlementQuery implements GradingSettlementQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  async settlementOf(actor: ResolvedActor, cohortId: string, stageKey: string): Promise<Result<{ readonly settlement: Settlement | null }>> {
    const blocked = statusGate(actor, 'business')
    if (blocked) return err(blocked, '請先登入並完成帳號設定。')
    if (actor.kind !== 'authenticated' || !(hasRole(actor, 'teacher') || canManageCohorts(actor))) {
      return err('FORBIDDEN', '只有老師與系辦可以查看成績結算。')
    }
    if (!isUuid(cohortId)) return cohortNotFound()
    const db = this.#reader()
    const [rows, stages] = await Promise.all([
      db.query<SettlementRow>(`${SETTLEMENT_SELECT} where gs.cohort_id = $1 and gs.stage_key = $2 and gs.released_at is null`, [
        cohortId,
        String(stageKey ?? ''),
      ]),
      currentStages(db, cohortId),
    ])
    const row = rows.rows[0]
    return ok(
      { settlement: row ? toSettlement(row, stageOf(stages, row.stage_key)?.name ?? row.stage_key) : null },
      { requestId: uuidv7(), serverTime: new Date().toISOString() },
    )
  }

  async settlements(actor: ResolvedActor, cohortId: string): Promise<Result<readonly SettlementHistory[]>> {
    const denied = authorizeAdmin(actor, '查看成績結算')
    if (denied) return denied
    if (!isUuid(cohortId)) return cohortNotFound()
    const db = this.#reader()
    const [rows, stages] = await Promise.all([
      db.query<SettlementRow>(`${SETTLEMENT_SELECT} where gs.cohort_id = $1 order by gs.settled_at desc, gs.id desc`, [cohortId]),
      currentStages(db, cohortId),
    ])
    return okList(rows.rows.map((r) => toHistory(r, stageOf(stages, r.stage_key)?.name ?? r.stage_key)))
  }
}
