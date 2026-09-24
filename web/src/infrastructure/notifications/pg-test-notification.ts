import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import {
  normalizeTestNotification,
  type EventPublisher,
  type TestNotificationCommand,
  type TestNotificationInput,
  type TestNotificationReceipt,
} from '@/application/notifications'
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
 * 管理端「發一則測試通知」（模組實作設計 08 §6；票 12「做完的樣子」3）。
 *
 * 用來驗證「發事件 → 背景工作投影 → 收件人的通知匣」整條路。只有測試站
 * （`BUSINESS_CLOCK_OVERRIDE_ENABLED=true`）開放：正式站頁面沒有入口，直接打 Server Action 也在這裡被拒。
 *
 * 形狀跟其他寫入用例一樣：帳本 `begin`（同一個請求編號重送只發一次）→ 發 `test.notification` 事件
 * （收件人固定為選的那一位）→ 稽核 → 帳本 `commit`。通知本身由 worker 投影，所以重送、重跑都只會有一則。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Deps = {
  enabled: boolean
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  reader?: () => Pick<Pool, 'query'>
  realClock?: Clock
}

export class PgTestNotificationCommand implements TestNotificationCommand {
  readonly enabled: boolean
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #reader: () => Pick<Pool, 'query'>
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.enabled = deps.enabled
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#events = deps.events
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#reader = deps.reader ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  async recipientOptions(): Promise<readonly { userId: string; label: string }[]> {
    if (!this.enabled) return []
    const rows = await this.#reader().query<{ id: string; name: string; email: string }>(
      `select id, name, email from users
        where status = 'active' and deidentified_at is null
        order by name, email
        limit 500`,
    )
    return rows.rows.map((r) => ({ userId: r.id, label: `${r.name}（${r.email}）` }))
  }

  async send(
    actor: ResolvedActor,
    input: TestNotificationInput,
    requestId: string,
  ): Promise<Result<TestNotificationReceipt>> {
    // 環境開關最先：正式站不管是誰、送什麼，都是同一個拒絕，也不留任何紀錄。
    if (!this.enabled) return err('FORBIDDEN', '正式站沒有測試通知。', { next: { kind: 'home' } })
    const denied = authorizeAdmin(actor, '發送測試通知')
    if (denied) return denied
    if (!UUID.test(requestId)) return badRequestId()
    const normalized = normalizeTestNotification(input)
    if (!normalized.ok) return err('VALIDATION_FAILED', normalized.message)
    const value = normalized.value
    const userId = actorUserId(actor)

    return inTransaction(this.#pool, 'test-notification', async (tx) => {
      const recipient = await tx.query<{ name: string }>(
        `select name from users where id = $1 and status = 'active' and deidentified_at is null`,
        [value.recipientUserId],
      )
      if (!recipient.rows[0]) return err('VALIDATION_FAILED', '找不到這位收件人，或他的帳號還沒核准。')
      if (value.cohortId) {
        const cohort = await tx.query('select 1 from cohorts where id = $1', [value.cohortId])
        if (!cohort.rows[0]) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
      }

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'notification.test.send',
          requestId,
          fingerprint: sha256(canonicalJson(value)),
          scope: value.cohortId ? 'cohort' : 'global',
          cohortId: value.cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<TestNotificationReceipt>(begun)

      const businessAt = await this.#businessClock.now()
      // 來源 id 用請求編號：同一次「發送」就是同一個來源，追溯時對得起來。
      const { eventId } = await this.#events.publish(tx, {
        type: 'test.notification',
        scope: value.cohortId ? 'cohort' : 'global',
        cohortId: value.cohortId,
        source: { type: 'test', id: requestId.toLowerCase(), version: 1 },
        actor: { kind: 'user', userId },
        recipients: [value.recipientUserId],
        recipientBasis: { rule: 'chosen_by_admin' },
        payload: { title: value.title },
        occurredRealAt: realAt,
        occurredBusinessAt: businessAt,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'notification.test.send',
        targetType: 'user',
        targetId: value.recipientUserId,
        scope: value.cohortId ? 'cohort' : 'global',
        cohortId: value.cohortId,
        realAt,
        businessAt,
        payload: { eventId, title: value.title },
      })

      const receipt = {
        eventId,
        recipientName: recipient.rows[0].name,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { eventId } })
      return { ok: true as const, receipt }
    })
  }
}
