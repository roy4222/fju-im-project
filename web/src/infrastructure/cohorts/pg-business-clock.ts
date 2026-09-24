import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import {
  businessNowFrom,
  isRequestId,
  normalizeClockInput,
  type BusinessClockCommand,
  type BusinessClockQuery,
  type BusinessClockSource,
  type BusinessClockState,
  type ClockOverride,
  type SetBusinessClockInput,
  type SetBusinessClockReceipt,
} from '@/application/cohorts'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import {
  actorUserId,
  authorizeAdmin,
  badRequestId,
  inTransaction,
  replayed,
  type PoolSource,
} from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 業務鐘與模擬業務鐘（票 11；模組實作設計 02 §2、§5、§6；產品模組 02 §4「模擬業務日期規則」）。
 *
 * `enabled` 由組裝層依 `BUSINESS_CLOCK_OVERRIDE_ENABLED` 給：
 * - false（正式站）：業務時間＝真實時間，**完全不讀** `business_clock_overrides`；
 *   設定用例一律 `FORBIDDEN`，連帳本都不寫。就算表裡被人塞了列也不會生效。
 * - true（測試站）：取最新一筆設定，業務時間＝設定的時刻＋之後的真實經過時間。
 */

type OverrideRow = {
  id: string
  environment: 'local' | 'staging'
  business_at: Date
  real_at: Date
  previous_business_at: Date | null
  set_by_user_id: string
  set_by_name: string | null
  reason: string
}

const SELECT_OVERRIDES = `select o.id, o.environment, o.business_at, o.real_at, o.previous_business_at,
                                o.set_by_user_id, u.name as set_by_name, o.reason
                           from business_clock_overrides o
                           left join users u on u.id = o.set_by_user_id
                          order by o.real_at desc, o.id desc`

function toOverride(row: OverrideRow): ClockOverride {
  return {
    id: row.id,
    environment: row.environment,
    businessAt: row.business_at,
    realAt: row.real_at,
    previousBusinessAt: row.previous_business_at,
    setByUserId: row.set_by_user_id,
    setByName: row.set_by_name,
    reason: row.reason,
  }
}

type Deps = {
  enabled: boolean
  /** 寫進 `environment` 欄的值；正式站用不到。 */
  environment?: 'local' | 'staging'
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  pool?: PoolSource
  reader?: () => Pick<Pool, 'query'>
  realClock?: Clock
}

export class PgBusinessClock implements BusinessClockSource, BusinessClockQuery, BusinessClockCommand {
  readonly #enabled: boolean
  readonly #environment: 'local' | 'staging'
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #pool: PoolSource
  readonly #reader: () => Pick<Pool, 'query'>
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#enabled = deps.enabled
    this.#environment = deps.environment ?? 'staging'
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#pool = deps.pool ?? getPool
    this.#reader = deps.reader ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  get enabled(): boolean {
    return this.#enabled
  }

  async now(): Promise<Date> {
    const realNow = this.#realClock.now()
    if (!this.#enabled) return realNow
    return businessNowFrom(await this.#latest(this.#reader()), realNow)
  }

  async state(): Promise<BusinessClockState> {
    const realNow = this.#realClock.now()
    if (!this.#enabled) return { enabled: false, realNow, businessNow: realNow, latest: null }
    const latest = await this.#latest(this.#reader())
    return { enabled: true, realNow, businessNow: businessNowFrom(latest, realNow), latest }
  }

  async history(limit: number): Promise<ClockOverride[]> {
    if (!this.#enabled) return []
    const rows = await this.#reader().query<OverrideRow>(`${SELECT_OVERRIDES} limit $1`, [limit])
    return rows.rows.map(toOverride)
  }

  async set(
    actor: ResolvedActor,
    input: SetBusinessClockInput,
    requestId: string,
  ): Promise<Result<SetBusinessClockReceipt>> {
    // 環境開關最先：正式站不管是誰、送什麼，都是同一個拒絕，也不留任何紀錄。
    if (!this.#enabled) return err('FORBIDDEN', '正式站沒有模擬業務鐘。', { next: { kind: 'home' } })
    const denied = authorizeAdmin(actor, '調整模擬業務鐘')
    if (denied) return denied
    if (!isRequestId(requestId)) return badRequestId()
    const normalized = normalizeClockInput(input)
    if (!normalized.ok) return normalized
    const { businessAt, reason } = normalized.value
    const userId = actorUserId(actor)

    return inTransaction(this.#pool, 'business-clock', async (tx) => {
      // 兩個人同時設定時排隊：「設定前的業務時間」才會是對方設完之後的值。
      await tx.query(`select pg_advisory_xact_lock(hashtext('business_clock_overrides'))`)

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'business_clock.set',
          requestId,
          fingerprint: sha256(canonicalJson({ businessAt: businessAt.toISOString(), reason })),
          scope: 'global',
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<SetBusinessClockReceipt>(begun)

      const previous = businessNowFrom(await this.#latest(tx), realAt)
      await tx.query(
        `insert into business_clock_overrides
           (id, environment, business_at, real_at, previous_business_at, set_by_user_id, reason)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [uuidv7(), this.#environment, businessAt, realAt, previous, userId, reason],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'business_clock.set',
        targetType: 'business_clock',
        scope: 'global',
        reason,
        realAt,
        businessAt,
        payload: { from: previous.toISOString(), to: businessAt.toISOString(), environment: this.#environment },
      })

      const receipt = {
        businessAt: businessAt.toISOString(),
        previousBusinessAt: previous.toISOString(),
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: {} })
      return { ok: true as const, receipt }
    })
  }

  async #latest(db: Pick<Pool, 'query'> | PoolClient): Promise<ClockOverride | null> {
    const rows = await db.query<OverrideRow>(`${SELECT_OVERRIDES} limit 1`)
    return rows.rows[0] ? toOverride(rows.rows[0]) : null
  }
}
