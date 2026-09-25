import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import {
  isCohortId,
  isRequestId,
  normalizeActivityInput,
  normalizeScheduleInput,
  planStageVersions,
  stagePositionAt,
  type Activity,
  type ActivityAudience,
  type ActivityInput,
  type ActivityReceipt,
  type ActivityStatus,
  type BusinessClockSource,
  type CohortSchedule,
  type CohortStatus,
  type NormalizedActivity,
  type SaveScheduleReceipt,
  type ScheduleInput,
  type Stage,
  type StagePosition,
  type StudentTimeline,
  type TimelineCommand,
  type TimelineQuery,
} from '@/application/cohorts'
import type { EventPublisher } from '@/application/notifications'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import {
  actorUserId,
  authorizeAdmin,
  badRequestId,
  cohortNotFound,
  inTransaction,
  replayed,
  staleRevision,
  type PoolSource,
} from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 階段、年度結束日與獨立活動（票 11；模組實作設計 02 §3「stage upsert」「event upsert／cancel」、§5、§6）。
 *
 * 鎖的順序照契約 01 §6：先 `cohorts`、再頭列。
 * - 存階段：`cohorts FOR UPDATE`（要改年度結束日與 revision），同一屆兩個人同時存會排隊，
 *   後到的看到 revision 變了就回 `CONFLICT`。
 * - 活動：`cohorts FOR SHARE`（確認屆別沒被封存），再 `project_events FOR UPDATE`。
 *
 * 活動每次異動都在同一筆交易發一個 `calendar.changed` 事件（沒有收件人：站內日曆是查出來的，
 * 產品事件矩陣也沒有活動異動通知）。交易回滾時活動、事件、稽核、帳本一起消失。
 */

type CohortRow = { id: string; code: string; status: CohortStatus; revision: number; year_end_date: string | null }

type StageRow = { seq: number; name: string; description: string; start_date: string; deadline_version: number }

type ActivityRow = {
  id: string
  cohort_id: string
  title: string
  description: string | null
  starts_at: Date
  ends_at: Date | null
  all_day: boolean
  audience_kind: ActivityAudience
  status: ActivityStatus
  revision: number
}

const ACTIVITY_COLUMNS =
  'id, cohort_id, title, description, starts_at, ends_at, all_day, audience_kind, status, revision'

function toStage(row: StageRow): Stage {
  return {
    seq: row.seq,
    name: row.name,
    description: row.description,
    startDate: row.start_date,
    deadlineVersion: row.deadline_version,
  }
}

function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    allDay: row.all_day,
    audienceKind: row.audience_kind,
    status: row.status,
    revision: row.revision,
  }
}

async function loadStages(db: Pick<Pool, 'query'> | PoolClient, cohortId: string, lock = false) {
  const rows = await db.query<StageRow>(
    `select seq, name, description, to_char(start_date, 'YYYY-MM-DD') as start_date, deadline_version
       from cohort_stages where cohort_id = $1 order by seq${lock ? ' for update' : ''}`,
    [cohortId],
  )
  return rows.rows.map(toStage)
}

function archived(code: string): Err {
  return err('COHORT_ARCHIVED', `${code} 已封存，不能再改階段或活動。`)
}

function activityNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個活動，請重新整理頁面。')
}

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

export class PgTimelineCommand implements TimelineCommand {
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

  async saveSchedule(
    actor: ResolvedActor,
    cohortId: string,
    input: ScheduleInput,
    expectedRevision: number,
    requestId: string,
  ): Promise<Result<SaveScheduleReceipt>> {
    const denied = authorizeAdmin(actor, '設定階段')
    if (denied) return denied
    if (!isRequestId(requestId)) return badRequestId()
    if (!isCohortId(cohortId)) return cohortNotFound()
    const normalized = normalizeScheduleInput(input)
    if (!normalized.ok) return normalized
    const next = normalized.value
    const userId = actorUserId(actor)
    // 業務時間在開交易**之前**讀：業務鐘自己也借連線，交易裡再借一條會跟別的寫入互等（票 11 審查建議）。
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const found = await tx.query<CohortRow>(
        `select id, code, status, revision, to_char(year_end_date, 'YYYY-MM-DD') as year_end_date
           from cohorts where id = $1 for update`,
        [cohortId],
      )
      const cohort = found.rows[0]
      if (!cohort) return cohortNotFound()

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'cohort.save_schedule',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId, ...next, expectedRevision })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<SaveScheduleReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort.code)
      if (cohort.revision !== expectedRevision) return staleRevision()

      const current: CohortSchedule = { stages: await loadStages(tx, cohortId, true), yearEndDate: cohort.year_end_date }
      const plan = planStageVersions(current, next)
      const oldBySeq = new Map(current.stages.map((stage) => [stage.seq, stage]))

      // (cohort_id, start_date) 是唯一鍵，而且 PostgreSQL 對非延後的唯一鍵是逐列檢查的：
      // 把第 1 段改成原本第 2 段的日期，在第 2 段還沒改之前就會撞。所以日期有變的列
      // 先搬到一個不會撞的暫存日期（9999 年），再一次改成新值；全在同一筆交易裡，外面看不到中間狀態。
      const moving = plan.filter((p) => !p.isNew && oldBySeq.get(p.seq)!.startDate !== p.startDate)
      for (const p of moving) {
        await tx.query(
          `update cohort_stages set start_date = date '9999-01-01' + seq where cohort_id = $1 and seq = $2`,
          [cohortId, p.seq],
        )
      }

      for (const p of plan) {
        const old = oldBySeq.get(p.seq)
        if (!old) {
          await tx.query(
            `insert into cohort_stages
               (id, cohort_id, seq, name, description, start_date, deadline_version, created_by_kind, created_by_user_id,
                created_at, updated_at, updated_by_user_id)
             values ($1, $2, $3, $4, $9, $5, $6, 'user', $7, $8, $8, $7)`,
            [uuidv7(), cohortId, p.seq, p.name, p.startDate, p.deadlineVersion, userId, realAt, p.description],
          )
        } else if (
          old.name !== p.name ||
          old.description !== p.description ||
          old.startDate !== p.startDate ||
          old.deadlineVersion !== p.deadlineVersion
        ) {
          await tx.query(
            `update cohort_stages
                set name = $3, description = $8, start_date = $4, deadline_version = $5, revision = revision + 1,
                    updated_at = $6, updated_by_user_id = $7
              where cohort_id = $1 and seq = $2`,
            [cohortId, p.seq, p.name, p.startDate, p.deadlineVersion, realAt, userId, p.description],
          )
        }
      }

      await tx.query(
        `update cohorts set year_end_date = $2, revision = revision + 1, updated_at = $3, updated_by_user_id = $4
          where id = $1`,
        [cohortId, next.yearEndDate, realAt, userId],
      )

      const changedStages = plan.filter((p) => p.rangeChanged).map((p) => p.seq)
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'cohort.save_schedule',
        targetType: 'cohort',
        targetId: cohortId,
        scope: 'cohort',
        cohortId,
        realAt,
        businessAt,
        payload: {
          before: {
            stages: current.stages.map(({ seq, name, startDate, description }) => ({ seq, name, startDate, description })),
            yearEndDate: current.yearEndDate,
          },
          after: { stages: next.stages, yearEndDate: next.yearEndDate },
          changedStages,
        },
      })

      const receipt = { cohortId, code: cohort.code, changedStages, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { cohortId } })
      return { ok: true as const, receipt }
    })
  }

  async createActivity(
    actor: ResolvedActor,
    cohortId: string,
    input: ActivityInput,
    requestId: string,
  ): Promise<Result<ActivityReceipt>> {
    const denied = authorizeAdmin(actor, '管理活動')
    if (denied) return denied
    if (!isRequestId(requestId)) return badRequestId()
    if (!isCohortId(cohortId)) return cohortNotFound()
    const normalized = normalizeActivityInput(input)
    if (!normalized.ok) return normalized
    const activity = normalized.value
    const userId = actorUserId(actor)
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const cohort = await this.#shareCohort(tx, cohortId)
      if (!cohort) return cohortNotFound()

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'cohort.activity.create',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId, ...activity })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<ActivityReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort.code)

      const id = uuidv7()
      await tx.query(
        `insert into project_events
           (id, cohort_id, title, description, starts_at, ends_at, all_day, audience_kind, status,
            created_by_kind, created_by_user_id, created_at, updated_at, updated_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled', 'user', $9, $10, $10, $9)`,
        [id, cohortId, activity.title, activity.description, activity.startsAt, activity.endsAt, activity.allDay,
          activity.audienceKind, userId, realAt],
      )
      await this.#recordChange(tx, { cohortId, activityId: id, version: 1, action: 'created', userId, realAt, businessAt, before: null, after: activity })

      const receipt = { activityId: id, title: activity.title, action: 'created' as const, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { activityId: id } })
      return { ok: true as const, receipt }
    })
  }

  async updateActivity(
    actor: ResolvedActor,
    activityId: string,
    input: ActivityInput,
    expectedRevision: number,
    requestId: string,
  ): Promise<Result<ActivityReceipt>> {
    const denied = authorizeAdmin(actor, '管理活動')
    if (denied) return denied
    if (!isRequestId(requestId)) return badRequestId()
    if (!isCohortId(activityId)) return activityNotFound()
    const normalized = normalizeActivityInput(input)
    if (!normalized.ok) return normalized
    const activity = normalized.value
    const userId = actorUserId(actor)
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lockActivity(tx, activityId)
      if (!locked) return activityNotFound()
      const { cohort, row } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'cohort.activity.update',
          requestId,
          fingerprint: sha256(canonicalJson({ activityId, ...activity, expectedRevision })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<ActivityReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort.code)
      if (row.revision !== expectedRevision) return staleRevision()
      if (row.status === 'cancelled') return err('VALIDATION_FAILED', '這個活動已經取消，不能再改期。')

      await tx.query(
        `update project_events
            set title = $2, description = $3, starts_at = $4, ends_at = $5, all_day = $6, audience_kind = $7,
                revision = revision + 1, updated_at = $8, updated_by_user_id = $9
          where id = $1`,
        [activityId, activity.title, activity.description, activity.startsAt, activity.endsAt, activity.allDay,
          activity.audienceKind, realAt, userId],
      )
      await this.#recordChange(tx, {
        cohortId: cohort.id,
        activityId,
        version: row.revision + 1,
        action: 'updated',
        userId,
        realAt,
        businessAt,
        before: toActivity(row),
        after: activity,
      })

      const receipt = { activityId, title: activity.title, action: 'updated' as const, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { activityId } })
      return { ok: true as const, receipt }
    })
  }

  async cancelActivity(
    actor: ResolvedActor,
    activityId: string,
    expectedRevision: number,
    requestId: string,
  ): Promise<Result<ActivityReceipt>> {
    const denied = authorizeAdmin(actor, '管理活動')
    if (denied) return denied
    if (!isRequestId(requestId)) return badRequestId()
    if (!isCohortId(activityId)) return activityNotFound()
    const userId = actorUserId(actor)
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lockActivity(tx, activityId)
      if (!locked) return activityNotFound()
      const { cohort, row } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'cohort.activity.cancel',
          requestId,
          fingerprint: sha256(canonicalJson({ activityId, expectedRevision })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<ActivityReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort.code)
      if (row.revision !== expectedRevision) return staleRevision()
      if (row.status === 'cancelled') return err('VALIDATION_FAILED', '這個活動已經取消了。')

      await tx.query(
        `update project_events set status = 'cancelled', revision = revision + 1, updated_at = $2, updated_by_user_id = $3
          where id = $1`,
        [activityId, realAt, userId],
      )
      await this.#recordChange(tx, {
        cohortId: cohort.id,
        activityId,
        version: row.revision + 1,
        action: 'cancelled',
        userId,
        realAt,
        businessAt,
        before: toActivity(row),
        after: null,
      })

      const receipt = { activityId, title: row.title, action: 'cancelled' as const, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { activityId } })
      return { ok: true as const, receipt }
    })
  }

  async #shareCohort(tx: PoolClient, cohortId: string): Promise<CohortRow | null> {
    const found = await tx.query<CohortRow>(
      `select id, code, status, revision, null as year_end_date from cohorts where id = $1 for share`,
      [cohortId],
    )
    return found.rows[0] ?? null
  }

  /** 先鎖屆別（FOR SHARE）、再鎖活動（FOR UPDATE）：契約 01 §6 的鎖順序。 */
  async #lockActivity(tx: PoolClient, activityId: string): Promise<{ cohort: CohortRow; row: ActivityRow } | null> {
    const owner = await tx.query<{ cohort_id: string }>('select cohort_id from project_events where id = $1', [activityId])
    const cohortId = owner.rows[0]?.cohort_id
    if (!cohortId) return null
    const cohort = await this.#shareCohort(tx, cohortId)
    if (!cohort) return null
    const found = await tx.query<ActivityRow>(`select ${ACTIVITY_COLUMNS} from project_events where id = $1 for update`, [
      activityId,
    ])
    const row = found.rows[0]
    return row ? { cohort, row } : null
  }

  /** 活動異動的事件與稽核：跟活動本身在同一筆交易。 */
  async #recordChange(
    tx: PoolClient,
    change: {
      cohortId: string
      activityId: string
      version: number
      action: ActivityReceipt['action']
      userId: string
      realAt: Date
      businessAt: Date
      before: Activity | null
      after: NormalizedActivity | null
    },
  ): Promise<void> {
    const businessAt = change.businessAt
    const summary = (a: Activity | NormalizedActivity | null) =>
      a && {
        title: a.title,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt?.toISOString() ?? null,
        allDay: a.allDay,
        audienceKind: a.audienceKind,
      }

    await this.#events.publish(tx, {
      type: 'calendar.changed',
      scope: 'cohort',
      cohortId: change.cohortId,
      source: { type: 'project_event', id: change.activityId, version: change.version },
      actor: { kind: 'user', userId: change.userId },
      recipients: [],
      payload: { action: change.action, title: (change.after ?? change.before)!.title },
      occurredRealAt: change.realAt,
      occurredBusinessAt: businessAt,
    })
    await this.#audit.append(tx, {
      actorKind: 'user',
      actorUserId: change.userId,
      role: 'admin',
      action: `cohort.activity.${change.action === 'created' ? 'create' : change.action === 'updated' ? 'update' : 'cancel'}`,
      targetType: 'project_event',
      targetId: change.activityId,
      scope: 'cohort',
      cohortId: change.cohortId,
      realAt: change.realAt,
      businessAt,
      payload: { before: summary(change.before), after: summary(change.after) },
    })
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'timeline', body)
  }
}

export class PgTimelineQuery implements TimelineQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  async schedule(cohortId: string): Promise<CohortSchedule> {
    if (!isCohortId(cohortId)) return { stages: [], yearEndDate: null }
    const db = this.#reader()
    const cohort = await db.query<{ year_end_date: string | null }>(
      `select to_char(year_end_date, 'YYYY-MM-DD') as year_end_date from cohorts where id = $1`,
      [cohortId],
    )
    return { stages: await loadStages(db, cohortId), yearEndDate: cohort.rows[0]?.year_end_date ?? null }
  }

  async activities(cohortId: string): Promise<Activity[]> {
    if (!isCohortId(cohortId)) return []
    const rows = await this.#reader().query<ActivityRow>(
      `select ${ACTIVITY_COLUMNS} from project_events where cohort_id = $1 order by starts_at, created_at`,
      [cohortId],
    )
    return rows.rows.map(toActivity)
  }

  async currentStage(cohortId: string, businessAt: Date): Promise<StagePosition> {
    return stagePositionAt(await this.schedule(cohortId), businessAt)
  }

  async studentSchedule(actor: ResolvedActor): Promise<StudentTimeline | null> {
    if (actor.kind !== 'authenticated' || actor.status !== 'active' || !actor.roles.includes('student')) return null
    // 屆別只從登入者推（actor 由 session 在伺服器端解析，來源是資料庫的歸屬屆別）。
    const cohortId = actor.cohortMemberships.find((m) => m.role === 'student')?.cohortId
    if (!cohortId || !isCohortId(cohortId)) return null
    const db = this.#reader()
    const cohort = await db.query<{ code: string; year_end_date: string | null }>(
      `select code, to_char(year_end_date, 'YYYY-MM-DD') as year_end_date from cohorts where id = $1`,
      [cohortId],
    )
    const row = cohort.rows[0]
    if (!row) return null
    return { cohortId, cohortCode: row.code, schedule: { stages: await loadStages(db, cohortId), yearEndDate: row.year_end_date } }
  }
}
