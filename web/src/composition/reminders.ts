import 'server-only'
import type { ReminderCommand, ReminderQuery } from '@/application/reminders'
import { getBusinessClock } from '@/composition/cohorts'
import { getMailer, mailSiteUrl } from '@/composition/mail'
import { getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getOperationLedger } from '@/composition/ops'
import { PgReminders } from '@/infrastructure/reminders/pg-reminders'

/**
 * 催繳（C 階段規格① §1.5、§3.5、§8）的實例組裝：站內通知走事件、催繳信走 `composition/mail.ts` 選好的寄信轉接器
 * （`MAIL_CAPTURE=1` 且本機時存進 `mail_outbox`）。畫面（C1-07 作業繳交狀況頁、C1-15 首頁待辦卡）經這裡拿用例與句子。
 */
let reminders: PgReminders | undefined

function instance(): PgReminders {
  reminders ??= new PgReminders({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    events: getEventPublisher(),
    businessClock: getBusinessClock(),
    mail: { mailer: getMailer(), siteUrl: mailSiteUrl() },
  })
  return reminders
}

export function getReminderCommand(): ReminderCommand {
  return instance()
}

export function getReminderQuery(): ReminderQuery {
  return instance()
}

/** app 對 application 只能帶型別；畫面要用的冷卻字樣與 toast 句子經這裡拿（母 spec §4.3）。 */
export {
  describeCooldown,
  describeGradingReminder,
  describeItemReminder,
  describeOverdueReminder,
  REMIND_COOLDOWN_MS,
} from '@/application/reminders'
