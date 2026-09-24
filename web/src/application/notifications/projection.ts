import {
  DomainEventRejected,
  isEventType,
  notificationPresentationOf,
  type NotificationKind,
} from '@/application/notifications/events'

/**
 * 「把事件投影成通知」的純規則（模組實作設計 08 §2、§6；產品模組 08 §4「去重、補建與保存」）。
 *
 * - 收件人**只照事件寫入當下固定的名單**，不重新展開（補建也一樣）。
 * - 通知以（事件、收件人）去重：資料庫有唯一鍵，重跑只會被擋掉，不會多一則。
 * - 通知列只存 ID 與標題，不存私有正文（契約 03 §4）。
 *
 * 失敗的投影退避重試：第 n 次失敗後等 2^n 秒；累計 5 次標 failed 並發管理員告警。
 */

/** 投影累計失敗到這個次數就標 failed（契約 01 §4.7 R02：與到期工作同一上限）。 */
export const PROJECTION_MAX_ATTEMPTS = 5

/** 第 `attempts` 次失敗後要等幾秒才再試（2^n；`event_projections` 沒有下次時間欄，由 `claimed_at` 推）。 */
export function projectionBackoffSeconds(attempts: number): number {
  return 2 ** Math.max(0, attempts)
}

/** 失敗一次之後的狀態。 */
export function afterProjectionFailure(attempts: number): { attempts: number; state: 'pending' | 'failed' } {
  const next = attempts + 1
  return { attempts: next, state: next >= PROJECTION_MAX_ATTEMPTS ? 'failed' : 'pending' }
}

/** worker 從 `domain_events` 讀出來、要投影的那一筆。 */
export type ProjectableEvent = {
  readonly id: string
  readonly type: string
  readonly scope: 'cohort' | 'global'
  readonly cohortId: string | null
  readonly sourceType: string
  readonly sourceId: string
  readonly sourceVersion: number | null
  readonly recipients: readonly string[]
  readonly payload: Record<string, unknown>
}

/** 要寫進 `notifications` 的一列（id 與時間由 infrastructure 給）。 */
export type NotificationDraft = {
  readonly eventId: string
  readonly recipientUserId: string
  readonly scope: 'cohort' | 'global'
  readonly cohortId: string | null
  readonly kind: NotificationKind
  readonly title: string
  readonly sourceRef: { readonly type: string; readonly id: string; readonly version: number | null }
}

/** 通知標題上限：標題是給人一眼看懂的，不是正文。 */
export const NOTIFICATION_TITLE_MAX_LENGTH = 120

function titleFrom(payload: Record<string, unknown>, fallback: string): string {
  const raw = payload.title
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.replaceAll(/\s+/g, ' ').trim()
  if (!trimmed) return fallback
  return trimmed.length > NOTIFICATION_TITLE_MAX_LENGTH ? `${trimmed.slice(0, NOTIFICATION_TITLE_MAX_LENGTH - 1)}…` : trimmed
}

/**
 * 一個事件要產生哪些通知。每位收件人一則；收件人已在寫入時去重，這裡再保險去重一次。
 *
 * 事件型別不在目錄、或登記了卻沒有通知樣子——都是程式寫錯，丟 `DomainEventRejected`，
 * 讓這筆投影累計失敗（毒事件），不要默默跳過。
 */
export function notificationsFor(event: ProjectableEvent): NotificationDraft[] {
  if (!isEventType(event.type)) throw new DomainEventRejected(`事件型別 ${event.type} 沒有在 EVENT_CATALOG 登記`)
  const presentation = notificationPresentationOf(event.type)
  if (!presentation) throw new DomainEventRejected(`事件型別 ${event.type} 沒有登記通知的樣子，不能投影成通知`)

  const title = titleFrom(event.payload, presentation.defaultTitle)
  const sourceRef = { type: event.sourceType, id: event.sourceId, version: event.sourceVersion }
  return [...new Set(event.recipients.map((id) => id.toLowerCase()))].map((recipientUserId) => ({
    eventId: event.id,
    recipientUserId,
    scope: event.scope,
    cohortId: event.cohortId,
    kind: presentation.kind,
    title,
    sourceRef,
  }))
}
