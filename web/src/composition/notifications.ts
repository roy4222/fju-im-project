import 'server-only'
import type { PoolClient } from 'pg'
import type { DueWorkScheduler, EventPublisher } from '@/application/notifications'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'

/**
 * 模組 08 的兩個共用 port（票 11）：「發事件」與「排到期工作」。
 *
 * 後面每一張會發通知或排截止的票（13 提案、15 發布、17 送出…）都從這裡拿，
 * 在自己用例的交易裡呼叫，不要自己寫 `domain_events`／`due_work`。
 */
let eventPublisher: EventPublisher<PoolClient> | undefined
let dueWorkScheduler: DueWorkScheduler<PoolClient> | undefined

/** 測試站才有的東西（模擬業務鐘、`test_noop`）都看這一個開關（契約 05 §1）。 */
export function businessClockOverrideEnabled(): boolean {
  return process.env.BUSINESS_CLOCK_OVERRIDE_ENABLED === 'true'
}

export function getEventPublisher(): EventPublisher<PoolClient> {
  eventPublisher ??= new PgEventPublisher()
  return eventPublisher
}

export function getDueWorkScheduler(): DueWorkScheduler<PoolClient> {
  dueWorkScheduler ??= new PgDueWorkScheduler({ testKindsEnabled: businessClockOverrideEnabled() })
  return dueWorkScheduler
}
