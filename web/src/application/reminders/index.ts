/**
 * 催繳（C 階段規格① §1.5、§3.5、§8）的公開入口（母 spec §4.3）。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的 `ReminderCommand`／`ReminderQuery` 由 `composition/reminders.ts` 注入。
 */
export type {
  LastReminded,
  ReminderCommand,
  ReminderQuery,
  RemindGradingReceipt,
  RemindItemReceipt,
  RemindOverdueItem,
  RemindOverdueReceipt,
} from '@/application/reminders/ports'
export type { ReminderReceiver, TeacherGradingCount } from '@/application/reminders/reminders'
export {
  cooldownEndsAt,
  cooldownMessage,
  describeCooldown,
  describeGradingReminder,
  describeItemReminder,
  describeOverdueReminder,
  gradingReminderTitle,
  itemReminderTitle,
  nextAllowedAt,
  pendingReceiverIds,
  relativeAgo,
  REMIND_COOLDOWN_MS,
  teachersBehind,
} from '@/application/reminders/reminders'
