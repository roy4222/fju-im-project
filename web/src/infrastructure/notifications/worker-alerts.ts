import 'server-only'
import type { PoolClient } from 'pg'
import type { EventPublisher } from '@/application/notifications'

/**
 * 背景工作的維運告警（模組實作設計 08 §6「≥5 標 failed＋管理員告警事件」；模組 01 附錄 A 規則 5 上限告警）。
 *
 * 發一個 `ops.worker_alert` 事件，收件人＝**發生當下**所有有效的管理員（已核准、角色沒被收回），
 * 之後照一般投影進他們的通知匣。跟觸發它的狀態變更在同一筆交易：狀態沒寫成，告警也不會出現。
 */
export type WorkerAlert = {
  readonly title: string
  /** 追溯用的來源：例如 `{ type: 'domain_event', id }`、`{ type: 'due_work', id }`。 */
  readonly source: { readonly type: string; readonly id: string }
  /** 只放 ID、種類與錯誤代碼，不放私有正文。 */
  readonly detail: Record<string, unknown>
  readonly realAt: Date
  readonly businessAt: Date
}

export async function activeAdminIds(tx: Pick<PoolClient, 'query'>): Promise<string[]> {
  const rows = await tx.query<{ user_id: string }>(
    `select distinct ra.user_id
       from role_assignments ra
       join users u on u.id = ra.user_id
      where ra.role = 'admin' and ra.revoked_real_at is null
        and u.status = 'active' and u.deidentified_at is null
      order by ra.user_id`,
  )
  return rows.rows.map((r) => r.user_id)
}

export async function publishWorkerAlert(
  tx: PoolClient,
  events: EventPublisher<PoolClient>,
  alert: WorkerAlert,
): Promise<string> {
  const recipients = await activeAdminIds(tx)
  const { eventId } = await events.publish(tx, {
    type: 'ops.worker_alert',
    scope: 'global',
    source: alert.source,
    actor: { kind: 'worker' },
    recipients,
    recipientBasis: { rule: 'active_admins' },
    payload: { title: alert.title, ...alert.detail },
    occurredRealAt: alert.realAt,
    occurredBusinessAt: alert.businessAt,
  })
  return eventId
}
