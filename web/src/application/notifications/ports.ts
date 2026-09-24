import type { ResolvedActor } from '@/application/accounts'
import type { DueWorkIdentity, ScheduleDueWorkInput, ScheduledDueWork } from '@/application/notifications/due-work'
import type { DomainEventInput } from '@/application/notifications/events'
import type {
  InboxCohortOption,
  InboxFilter,
  InboxPage,
  MarkReadReceipt,
  TestNotificationInput,
  TestNotificationReceipt,
} from '@/application/notifications/inbox'
import type { Result } from '@/shared/result'

/**
 * 模組 08 提供給所有業務用例的兩個 port（模組實作設計 08 §5；契約 01 §9）。
 *
 * 兩個都吃呼叫端的 `tx`，**自己不開交易**：業務寫入、帳本、稽核、事件、到期工作
 * 全部在同一筆交易裡，一起 commit 或一起消失（契約 01 §6「被呼叫的 command 接受 tx」）。
 * `tx` 的型別由 infrastructure 決定（目前是 pg 的 `PoolClient`），這裡當不透明的把手。
 *
 * 內容不合規則（事件型別沒登記、到期工作種類不在白名單）會丟 `DomainEventRejected`／
 * `DueWorkRejected`——那是程式寫錯，讓交易整筆回滾。
 */

export interface EventPublisher<Tx = unknown> {
  /**
   * 寫一筆 `domain_events`，並替目錄登記的每個消費者建一列 `event_projections(pending)`。
   * 收件人在這裡固定（去重、排序後存進事件）。回傳新事件的 id。
   */
  publish(tx: Tx, event: DomainEventInput): Promise<{ eventId: string }>
}

/**
 * 通知匣查詢（模組實作設計 08 §5 `InboxQuery`）。只回**本人**的通知：
 * 誰是本人由 actor 決定，不收外面傳進來的 userId。帳號狀態不對（停用、待審、必須改密）回空的。
 */
export interface InboxQuery {
  list(actor: ResolvedActor, filter: InboxFilter, cursor: string | null): Promise<InboxPage>
  unreadCount(actor: ResolvedActor): Promise<number>
  /** 篩選下拉的屆別：本人通知裡出現過的屆別。 */
  cohortOptions(actor: ResolvedActor): Promise<readonly InboxCohortOption[]>
}

/**
 * 已讀（模組實作設計 08 §5 `InboxCommand`）。已讀本身就冪等（重按只是 0 筆），所以不走操作帳本。
 * 別人的或不存在的通知編號一律 `FORBIDDEN`「無法存取」，而且什麼都不改（契約 03 §4）。
 */
export interface InboxCommand {
  markRead(actor: ResolvedActor, notificationId: string): Promise<Result<MarkReadReceipt>>
  /** 把目前篩選範圍內本人的未讀全部標已讀。 */
  markAllRead(actor: ResolvedActor, filter: InboxFilter): Promise<Result<MarkReadReceipt>>
}

/** 管理端「發一則測試通知」（模組實作設計 08 §6）。正式站一律拒絕。 */
export interface TestNotificationCommand {
  readonly enabled: boolean
  send(actor: ResolvedActor, input: TestNotificationInput, requestId: string): Promise<Result<TestNotificationReceipt>>
  /** 收件人下拉：已核准（active）的帳號。 */
  recipientOptions(): Promise<readonly { userId: string; label: string }[]>
}

export interface DueWorkScheduler<Tx = unknown> {
  /**
   * 排一件到期工作。同一個（種類、對象、期限版本）重排不會多一列（`created=false`），
   * 所以用例重試是安全的。
   */
  schedule(tx: Tx, work: ScheduleDueWorkInput): Promise<ScheduledDueWork>
  /**
   * 取消某個版本還沒執行的工作（pending→cancelled）。已完成、已失敗的不動。
   * 回傳實際取消的筆數（0 代表那個版本本來就沒排或已經不是 pending）。
   */
  cancel(tx: Tx, work: DueWorkIdentity): Promise<number>
}
