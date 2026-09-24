import 'server-only'
import type { InboxCommand, InboxQuery, TestNotificationCommand } from '@/application/notifications'
import { getBusinessClock } from '@/composition/cohorts'
import { businessClockOverrideEnabled, getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getOperationLedger } from '@/composition/ops'
import { PgInbox } from '@/infrastructure/notifications/pg-inbox'
import { PgTestNotificationCommand } from '@/infrastructure/notifications/pg-test-notification'

/**
 * 通知匣與管理端測試通知的組裝（票 12；模組實作設計 08 §5、§6）。
 */

// 頁面要用的純規則（app 對 application 只能帶型別，執行期的東西經 composition 轉出去）。
export {
  inboxFilterParam,
  notificationKindLabel,
  parseInboxFilter,
  SOURCE_STATE_TEXT,
  TEST_NOTIFICATION_TITLE_MAX_LENGTH,
} from '@/application/notifications'
export { businessClockOverrideEnabled } from '@/composition/notifications'
let inbox: PgInbox | undefined
let testNotification: TestNotificationCommand | undefined

export function getInboxQuery(): InboxQuery {
  inbox ??= new PgInbox()
  return inbox
}

export function getInboxCommand(): InboxCommand {
  inbox ??= new PgInbox()
  return inbox
}

export function getTestNotificationCommand(): TestNotificationCommand {
  testNotification ??= new PgTestNotificationCommand({
    enabled: businessClockOverrideEnabled(),
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    events: getEventPublisher(),
    businessClock: getBusinessClock(),
  })
  return testNotification
}
