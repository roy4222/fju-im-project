import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import {
  isCohortId,
  isRequestId,
  normalizeCreateInput,
  normalizeGroupingSettings,
  type ActivateCohortReceipt,
  type BusinessClockSource,
  type Cohort,
  type CohortCommand,
  type CohortFlag,
  type CohortStatus,
  type CohortStatusQuery,
  type CreateCohortInput,
  type CreateCohortReceipt,
  type GroupingSettingsInput,
  type SetCohortFlagReceipt,
  type SetGroupingSettingsReceipt,
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
import { err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 屆別的寫入與查詢（票 5；模組實作設計 02 §3「create → preparing」「設旗標」；票 11「preparing → active」）。
 *
 * 每個寫入都是同一個形狀（契約 01 §8）：
 * 開交易 → 帳本 `begin`（同一個請求編號重送只做一次）→ 業務寫入 → 稽核 → 帳本 `commit` → COMMIT。
 * 用例回 `Err` 時整個交易回滾，帳本不會留下「失敗」的那一筆，同一個編號修正後還能再送。
 */

type Row = {
  id: string
  code: string
  name: string
  status: CohortStatus
  is_default_working: boolean
  is_registration_open: boolean
  year_end_date: string | null
  proposal_default_days: number
  group_size_min: number
  group_size_max: number
  revision: number
  created_at: Date
}

const COLUMNS =
  "id, code, name, status, is_default_working, is_registration_open, to_char(year_end_date, 'YYYY-MM-DD') as year_end_date, " +
  'proposal_default_days, group_size_min, group_size_max, revision, created_at'

function toCohort(row: Row): Cohort {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    isDefaultWorking: row.is_default_working,
    isRegistrationOpen: row.is_registration_open,
    yearEndDate: row.year_end_date,
    proposalDefaultDays: row.proposal_default_days,
    groupSizeMin: row.group_size_min,
    groupSizeMax: row.group_size_max,
    revision: row.revision,
    createdAt: row.created_at,
  }
}

/** 旗標對應的欄位。欄名只從這張表取，不會拿使用者輸入拼 SQL。 */
const FLAG_COLUMN: Record<CohortFlag, 'is_default_working' | 'is_registration_open'> = {
  defaultWorking: 'is_default_working',
  registrationOpen: 'is_registration_open',
}

const FLAG_OPERATION: Record<CohortFlag, string> = {
  defaultWorking: 'cohort.set_default_working',
  registrationOpen: 'cohort.set_registration_open',
}

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  /** 全站唯一的業務時間來源（測試站會被模擬鐘推開）。 */
  businessClock: BusinessClockSource
  /** 預設用應用連線池；整合測試傳自己的隔離 schema 進來。 */
  pool?: PoolSource
  realClock?: Clock
}

export class PgCohortCommand implements CohortCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #pool: PoolSource
  readonly #realClock: Clock
  readonly #businessClock: BusinessClockSource

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#events = deps.events
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
    this.#businessClock = deps.businessClock
  }

  async create(
    actor: ResolvedActor,
    input: CreateCohortInput,
    requestId: string,
  ): Promise<Result<CreateCohortReceipt>> {
    const denied = authorizeAdmin(actor)
    if (denied) return denied
    if (!isRequestId(requestId)) return badRequestId()

    const normalized = normalizeCreateInput(input)
    if (!normalized.ok) return normalized
    const { code, name } = normalized.value
    const userId = actorUserId(actor)
    // 業務時間在開交易**之前**讀：業務鐘自己也借連線，交易裡再借一條會跟別的寫入互等（票 11 審查建議）。
    const businessAt = await this.#businessClock.now()

    return this.#inTransaction(async (tx) => {
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'cohort.create',
          requestId,
          fingerprint: sha256(canonicalJson({ code, name })),
          // 帳本列先寫、屆別後建，此時還沒有 cohort_id 可以指（FK），所以記在 global。
          scope: 'global',
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<CreateCohortReceipt>(begun)

      const taken = await tx.query('select 1 from cohorts where code = $1', [code])
      if (taken.rowCount) return codeTaken(code)

      const id = uuidv7()
      await tx.query(
        `insert into cohorts (id, code, name, status, created_by_kind, created_by_user_id,
                              created_at, updated_at, updated_by_user_id)
         values ($1, $2, $3, 'preparing', 'user', $4, $5, $5, $4)`,
        [id, code, name, userId, realAt],
      )
      // 票 11 起，建立也留一筆狀態紀錄（from_status 為 NULL＝建立；模組實作設計 02 §3）。
      await insertStatusEvent(tx, { cohortId: id, from: null, to: 'preparing', userId, realAt, businessAt })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'cohort.create',
        targetType: 'cohort',
        targetId: id,
        scope: 'cohort',
        cohortId: id,
        realAt,
        businessAt,
        payload: { code, name, status: 'preparing' },
      })

      const receipt = {
        cohortId: id,
        code,
        name,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { cohortId: id } })
      return { ok: true as const, receipt }
    })
  }

  setDefaultWorking(actor: ResolvedActor, cohortId: string, requestId: string) {
    return this.#setFlag(actor, cohortId, 'defaultWorking', requestId)
  }

  setRegistrationOpen(actor: ResolvedActor, cohortId: string, requestId: string) {
    return this.#setFlag(actor, cohortId, 'registrationOpen', requestId)
  }

  /**
   * 把旗標交給某一屆，原本持有的那一屆在**同一個交易**裡取消。
   *
   * 兩件事要注意：
   * 1. 旗標由部分唯一索引守著（`cohorts_one_*`），索引不能延後檢查，所以一定要
   *    先清舊的、再設新的，分兩句。
   * 2. 兩個管理員同時把旗標交給不同的屆別時，READ COMMITTED 下後到的那個看不到
   *    前者剛設好的新持有者，會撞唯一索引。所以先拿一把「這個旗標」的交易級 advisory lock，
   *    讓同一個旗標的切換排隊一個一個來。
   */
  async #setFlag(
    actor: ResolvedActor,
    cohortId: string,
    flag: CohortFlag,
    requestId: string,
  ): Promise<Result<SetCohortFlagReceipt>> {
    const denied = authorizeAdmin(actor)
    if (denied) return denied
    if (!isRequestId(requestId)) return badRequestId()
    if (!isCohortId(cohortId)) return cohortNotFound()
    const userId = actorUserId(actor)
    const column = FLAG_COLUMN[flag]
    const businessAt = await this.#businessClock.now()

    return this.#inTransaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`cohorts.${column}`])

      const found = await tx.query<Row>(`select ${COLUMNS} from cohorts where id = $1 for update`, [cohortId])
      const target = found.rows[0]
      if (!target) return cohortNotFound()

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: FLAG_OPERATION[flag],
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId, flag })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<SetCohortFlagReceipt>(begun)

      if (target.status === 'archived') {
        return err('COHORT_ARCHIVED', `${target.code} 已封存，不能設為這個屆別。`)
      }

      let previous: { id: string; code: string } | null = null
      if (!target[column]) {
        const cleared = await tx.query<{ id: string; code: string }>(
          `update cohorts
              set ${column} = false, revision = revision + 1, updated_at = $2, updated_by_user_id = $3
            where ${column} and id <> $1
        returning id, code`,
          [cohortId, realAt, userId],
        )
        previous = cleared.rows[0] ?? null

        await tx.query(
          `update cohorts
              set ${column} = true, revision = revision + 1, updated_at = $2, updated_by_user_id = $3
            where id = $1`,
          [cohortId, realAt, userId],
        )

        await this.#audit.append(tx, {
          actorKind: 'user',
          actorUserId: userId,
          role: 'admin',
          action: FLAG_OPERATION[flag],
          targetType: 'cohort',
          targetId: cohortId,
          scope: 'cohort',
          cohortId,
          realAt,
          businessAt,
          payload: { flag, previousCohortId: previous?.id ?? null, previousCode: previous?.code ?? null },
        })
      }
      // 本來就是這一屆：不改資料、不留稽核，照樣回成功（按兩次不該變成錯誤）。

      const receipt = {
        flag,
        cohortId,
        code: target.code,
        previousCohortId: previous?.id ?? null,
        previousCode: previous?.code ?? null,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { cohortId } })
      return { ok: true as const, receipt }
    })
  }

  /**
   * 籌備中→進行中（票 11；模組實作設計 02 §3「preparing → active」）。
   *
   * 前置：已設好階段與年度結束日（S02 起的規則；缺了回 `VALIDATION_FAILED` 並說去哪裡設）。
   * 同一筆交易：改狀態、寫 `cohort_status_events`、發 `cohort.activated` 事件、稽核、帳本。
   * 已經是進行中就照樣回成功但什麼都不寫（按兩次不該多一筆狀態紀錄）。
   */
  async activate(
    actor: ResolvedActor,
    cohortId: string,
    requestId: string,
  ): Promise<Result<ActivateCohortReceipt>> {
    const denied = authorizeAdmin(actor)
    if (denied) return denied
    if (!isRequestId(requestId)) return badRequestId()
    if (!isCohortId(cohortId)) return cohortNotFound()
    const userId = actorUserId(actor)
    const businessAt = await this.#businessClock.now()

    return this.#inTransaction(async (tx) => {
      const found = await tx.query<Row>(`select ${COLUMNS} from cohorts where id = $1 for update`, [cohortId])
      const target = found.rows[0]
      if (!target) return cohortNotFound()

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'cohort.activate',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<ActivateCohortReceipt>(begun)

      if (target.status === 'archived') {
        return err('COHORT_ARCHIVED', `${target.code} 已封存，要先解封才能轉為進行中。`)
      }

      const alreadyActive = target.status === 'active'
      if (!alreadyActive) {
        const stages = await tx.query('select 1 from cohort_stages where cohort_id = $1', [cohortId])
        if (!stages.rowCount || !target.year_end_date) {
          return err(
            'VALIDATION_FAILED',
            `${target.code} 還沒設定階段與年度結束日。先到「時間軸」把四個階段的開始日與年度結束日填好，再轉為進行中。`,
          )
        }

        await tx.query(
          `update cohorts
              set status = 'active', revision = revision + 1, updated_at = $2, updated_by_user_id = $3
            where id = $1`,
          [cohortId, realAt, userId],
        )
        await insertStatusEvent(tx, { cohortId, from: 'preparing', to: 'active', userId, realAt, businessAt })
        await this.#events.publish(tx, {
          type: 'cohort.activated',
          scope: 'cohort',
          cohortId,
          source: { type: 'cohort', id: cohortId, version: target.revision + 1 },
          actor: { kind: 'user', userId },
          // 產品矩陣沒有「屆別轉進行中」的通知：不發給任何人，事件只留紀錄。
          recipients: [],
          payload: { code: target.code, from: 'preparing', to: 'active' },
          occurredRealAt: realAt,
          occurredBusinessAt: businessAt,
        })
        await this.#audit.append(tx, {
          actorKind: 'user',
          actorUserId: userId,
          role: 'admin',
          action: 'cohort.activate',
          targetType: 'cohort',
          targetId: cohortId,
          scope: 'cohort',
          cohortId,
          realAt,
          businessAt,
          payload: { code: target.code, from: 'preparing', to: 'active' },
        })
      }

      const receipt = {
        cohortId,
        code: target.code,
        alreadyActive,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { cohortId } })
      return { ok: true as const, receipt }
    })
  }

  /**
   * 分組設定（票 13）：每組最少／最多人數、提案預設天數。
   *
   * `cohorts FOR UPDATE`＋畫面帶來的 revision：兩個管理員同時改，後到的看到版本變了回 `CONFLICT`。
   * 只影響**之後**發起的提案：已經在等確認的提案人數與到期時間不變（大家確認的是發起時的內容）。
   */
  async setGroupingSettings(
    actor: ResolvedActor,
    cohortId: string,
    input: GroupingSettingsInput,
    expectedRevision: number,
    requestId: string,
  ): Promise<Result<SetGroupingSettingsReceipt>> {
    const denied = authorizeAdmin(actor, '設定分組')
    if (denied) return denied
    if (!isRequestId(requestId)) return badRequestId()
    if (!isCohortId(cohortId)) return cohortNotFound()
    const normalized = normalizeGroupingSettings(input)
    if (!normalized.ok) return normalized
    const settings = normalized.value
    const userId = actorUserId(actor)
    const businessAt = await this.#businessClock.now()

    return this.#inTransaction(async (tx) => {
      const found = await tx.query<Row>(`select ${COLUMNS} from cohorts where id = $1 for update`, [cohortId])
      const target = found.rows[0]
      if (!target) return cohortNotFound()

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'cohort.set_grouping_settings',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId, ...settings, expectedRevision })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<SetGroupingSettingsReceipt>(begun)
      if (target.status === 'archived') return err('COHORT_ARCHIVED', `${target.code} 已封存，不能再改分組設定。`)
      if (target.revision !== expectedRevision) return staleRevision()

      await tx.query(
        `update cohorts
            set group_size_min = $2, group_size_max = $3, proposal_default_days = $4,
                revision = revision + 1, updated_at = $5, updated_by_user_id = $6
          where id = $1`,
        [cohortId, settings.groupSizeMin, settings.groupSizeMax, settings.proposalDefaultDays, realAt, userId],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'cohort.set_grouping_settings',
        targetType: 'cohort',
        targetId: cohortId,
        scope: 'cohort',
        cohortId,
        realAt,
        businessAt,
        payload: {
          before: {
            groupSizeMin: target.group_size_min,
            groupSizeMax: target.group_size_max,
            proposalDefaultDays: target.proposal_default_days,
          },
          after: settings,
        },
      })

      const receipt = { cohortId, code: target.code, ...settings, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { cohortId } })
      return { ok: true as const, receipt }
    })
  }

  /** 唯一鍵被同時送出的另一筆搶先（代碼、或兩個旗標的部分唯一索引）：回衝突，請使用者重載。 */
  #inTransaction<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'cohorts', body, (constraint) =>
      constraint === 'cohorts_code_unique'
        ? err('CONFLICT', '這個屆別代碼剛剛被別人用了，請換一個。', { details: { field: 'code' } })
        : err('CONFLICT', '剛剛有人同時修改了屆別，請重新整理頁面再試一次。'),
    )
  }
}

/** 屆別狀態紀錄（`cohort_status_events`；不可變）。 */
async function insertStatusEvent(
  tx: PoolClient,
  event: {
    cohortId: string
    from: CohortStatus | null
    to: CohortStatus
    userId: string
    realAt: Date
    businessAt: Date
  },
): Promise<void> {
  await tx.query(
    `insert into cohort_status_events (id, cohort_id, from_status, to_status, actor_user_id, real_at, business_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [uuidv7(), event.cohortId, event.from, event.to, event.userId, event.realAt, event.businessAt],
  )
}

export class PgCohortStatusQuery implements CohortStatusQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  async list(): Promise<Cohort[]> {
    const rows = await this.#reader().query<Row>(
      `select ${COLUMNS} from cohorts order by created_at desc, code desc`,
    )
    return rows.rows.map(toCohort)
  }

  async get(cohortId: string): Promise<Cohort | null> {
    if (!isCohortId(cohortId)) return null
    const rows = await this.#reader().query<Row>(`select ${COLUMNS} from cohorts where id = $1`, [cohortId])
    return rows.rows[0] ? toCohort(rows.rows[0]) : null
  }

  async defaultWorking(): Promise<Cohort | null> {
    const rows = await this.#reader().query<Row>(`select ${COLUMNS} from cohorts where is_default_working`)
    return rows.rows[0] ? toCohort(rows.rows[0]) : null
  }

  async registrationOpen(): Promise<Cohort | null> {
    const rows = await this.#reader().query<Row>(`select ${COLUMNS} from cohorts where is_registration_open`)
    return rows.rows[0] ? toCohort(rows.rows[0]) : null
  }
}

function codeTaken(code: string) {
  return err('CONFLICT', `屆別代碼 ${code} 已經有人用了，請換一個。`, { details: { field: 'code' } })
}
