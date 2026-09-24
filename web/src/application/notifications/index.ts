/**
 * 模組 08 站內通知與日曆的公開入口（母 spec §4.3）。
 *
 * 票 11 只交付「發事件」與「排到期工作」兩個共用 port；通知匣、背景工作在票 12。
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type {
  DomainEventInput,
  EventActor,
  EventConsumer,
  EventType,
  NormalizedDomainEvent,
} from '@/application/notifications/events'
export {
  consumersOf,
  DomainEventRejected,
  EVENT_CATALOG,
  EVENT_CONSUMERS,
  isEventType,
  normalizeDomainEvent,
} from '@/application/notifications/events'
export type {
  DueWorkIdentity,
  DueWorkKind,
  DueWorkSubject,
  ScheduleDueWorkInput,
  ScheduledDueWork,
} from '@/application/notifications/due-work'
export {
  checkDueWork,
  DUE_WORK_KINDS,
  DueWorkRejected,
  isDueWorkKind,
  TEST_ONLY_DUE_WORK_KINDS,
} from '@/application/notifications/due-work'
export type { DueWorkScheduler, EventPublisher } from '@/application/notifications/ports'
