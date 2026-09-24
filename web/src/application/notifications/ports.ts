import type { DueWorkIdentity, ScheduleDueWorkInput, ScheduledDueWork } from '@/application/notifications/due-work'
import type { DomainEventInput } from '@/application/notifications/events'

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
