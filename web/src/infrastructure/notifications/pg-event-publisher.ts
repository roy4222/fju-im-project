import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import { normalizeDomainEvent, type DomainEventInput, type EventPublisher } from '@/application/notifications'
import { reachFaultPoint } from '@/shared/fault-points'

/**
 * 「發事件」的寫入（契約 01 §4.5、§4.6、§9；模組 08 §5）。
 *
 * 一次 publish＝一筆 `domain_events`（收件人固定在這一刻）＋每個消費者一筆
 * `event_projections(pending)`。全部用呼叫端的 `tx`：業務寫入失敗、交易回滾時，
 * 事件與投影列一起消失；業務 commit 了，背景工作（票 12）才看得到這筆事件。
 *
 * 事件 id 用 uuidv7（時間序），投影就照 id 順序處理。
 */
export class PgEventPublisher implements EventPublisher<PoolClient> {
  async publish(tx: PoolClient, input: DomainEventInput): Promise<{ eventId: string }> {
    const event = normalizeDomainEvent(input)
    const eventId = uuidv7()

    await tx.query(
      `insert into domain_events
         (id, type, scope, cohort_id, source_type, source_id, source_version, actor_kind, actor_user_id,
          occurred_real_at, occurred_business_at, recipients, recipient_basis, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid[], $13::jsonb, $14::jsonb)`,
      [
        eventId,
        event.type,
        event.scope,
        event.cohortId,
        event.source.type,
        event.source.id,
        event.source.version ?? null,
        event.actor.kind,
        event.actor.kind === 'user' ? event.actor.userId : null,
        event.occurredRealAt,
        event.occurredBusinessAt,
        event.recipients,
        JSON.stringify(event.recipientBasis ?? {}),
        JSON.stringify(event.payload ?? {}),
      ],
    )

    // 故障注入點：證明「事件寫了、業務後面失敗」時整筆回滾（測試用；正式環境是 no-op）。
    await reachFaultPoint('outbox.after-insert')

    for (const consumer of event.consumers) {
      await tx.query(`insert into event_projections (event_id, consumer, state) values ($1, $2, 'pending')`, [
        eventId,
        consumer,
      ])
    }

    return { eventId }
  }
}
