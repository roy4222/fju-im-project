/**
 * 模組 08 站內通知與日曆的公開入口（母 spec §4.3）。
 *
 * 票 11 交付「發事件」與「排到期工作」兩個共用 port；票 12 加上背景工作的純規則
 * （投影、到期工作生命週期）與通知匣。
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type {
  DomainEventInput,
  EventActor,
  EventConsumer,
  EventType,
  NormalizedDomainEvent,
  NotificationKind,
  NotificationPresentation,
} from '@/application/notifications/events'
export {
  consumersOf,
  DomainEventRejected,
  EVENT_CATALOG,
  EVENT_CONSUMERS,
  isEventType,
  normalizeDomainEvent,
  notificationPresentationOf,
} from '@/application/notifications/events'
export type {
  ClaimedDueWork,
  DueWorkHandler,
  DueWorkHandlers,
  DueWorkIdentity,
  DueWorkKind,
  DueWorkOutcome,
  DueWorkRunResult,
  DueWorkSubject,
  DueWorkTransition,
  ScheduleDueWorkInput,
  ScheduledDueWork,
} from '@/application/notifications/due-work'
export {
  checkDueWork,
  DUE_WORK_KINDS,
  DUE_WORK_MAX_ATTEMPTS,
  DUE_WORK_WAIT_SECONDS,
  DueWorkRejected,
  dueWorkTransition,
  isDueWorkKind,
  TEST_ONLY_DUE_WORK_KINDS,
} from '@/application/notifications/due-work'
export type { NotificationDraft, ProjectableEvent } from '@/application/notifications/projection'
export {
  afterProjectionFailure,
  NOTIFICATION_TITLE_MAX_LENGTH,
  notificationsFor,
  PROJECTION_MAX_ATTEMPTS,
  projectionBackoffSeconds,
} from '@/application/notifications/projection'
export type {
  InboxCohortOption,
  InboxCursor,
  InboxFilter,
  InboxItem,
  InboxPage,
  MarkReadReceipt,
  NormalizedTestNotification,
  NotificationSourceState,
  TestNotificationInput,
  TestNotificationReceipt,
} from '@/application/notifications/inbox'
export {
  decodeInboxCursor,
  encodeInboxCursor,
  INBOX_PAGE_SIZE,
  inboxFilterParam,
  normalizeTestNotification,
  NOTIFICATION_KIND_LABEL,
  notificationKindLabel,
  parseInboxFilter,
  SOURCE_STATE_TEXT,
  TEST_NOTIFICATION_TITLE_MAX_LENGTH,
} from '@/application/notifications/inbox'
export type {
  DueWorkScheduler,
  EventPublisher,
  InboxCommand,
  InboxQuery,
  TestNotificationCommand,
} from '@/application/notifications/ports'
