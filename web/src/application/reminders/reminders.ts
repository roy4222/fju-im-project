import { formatTaipeiMinute } from '@/shared/time'

/**
 * 催繳的純規則（C 階段規格① §1.5、§3.5、§8；AC-12、AC-34）。沒有資料庫：冷卻、收件人篩選、通知標題與回饋句子都在這裡。
 */

/** 同一份作業（評分：同一屆）兩次催繳至少隔多久。 */
export const REMIND_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** 下一次可以催的時間；現在就可以催回 null。 */
export function nextAllowedAt(lastRemindedAt: Date | null, now: Date): Date | null {
  if (!lastRemindedAt) return null
  const next = new Date(lastRemindedAt.getTime() + REMIND_COOLDOWN_MS)
  return next.getTime() > now.getTime() ? next : null
}

/** 這次催完之後的下一次可催時間。 */
export function cooldownEndsAt(remindedAt: Date): Date {
  return new Date(remindedAt.getTime() + REMIND_COOLDOWN_MS)
}

/** 冷卻中再按：CONFLICT 的句子（§3.5「{標題}上次催繳在 {時間}，24 小時內不能再催」）。 */
export function cooldownMessage(subject: string, last: Date, next: Date): string {
  return `${subject}上次催繳在 ${formatTaipeiMinute(last)}，24 小時內不能再催（${formatTaipeiMinute(next)} 之後可以）。`
}

/** 「上次催繳 3 小時前」的相對時間：一分鐘內「剛剛」，一小時內「N 分鐘前」，其餘「N 小時前」。 */
export function relativeAgo(at: Date, now: Date): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - at.getTime()) / 60_000)
  if (minutes < 1) return '剛剛'
  if (minutes < 60) return `${minutes} 分鐘前`
  return `${Math.floor(minutes / 60)} 小時前`
}

/** 按鈕冷卻中的字樣（AC-12「上次催繳剛剛，{明天同一時間} 後可再催」、§8「上次催繳 3 小時前，{時間} 後可再催」）。 */
export function describeCooldown(at: Date, next: Date, now: Date): string {
  return `上次催繳${relativeAgo(at, now)}，${formatTaipeiMinute(next)} 後可再催`
}

/** 站內通知與 Email 同文（§8）：「{作業標題} 尚未繳交，截止 {時間}」；沒有截止（站內同意書可選填）就只說尚未繳交。 */
export function itemReminderTitle(title: string, dueAt: Date | null): string {
  return dueAt ? `${title} 尚未繳交，截止 ${formatTaipeiMinute(dueAt)}` : `${title} 尚未繳交`
}

/** 評分催繳的標題（AC-34「您還有 N 份評分未送出」）。 */
export function gradingReminderTitle(pending: number): string {
  return `您還有 ${pending} 份評分未送出`
}

/**
 * 名單上一位收件者（人或組）跟催繳有關的事實。分類與「逾期」由呼叫端用收件模組同一份 `categoryOf`／`receiverStatus`
 * 算好帶進來（跨模組只能帶型別），口徑才會跟名單頁、首頁逾期卡一致。
 */
export type ReminderReceiver = {
  readonly receiverId: string
  /** 目前名單上、不是免填（`categoryOf === 'current'`）。 */
  readonly current: boolean
  /** 已經有任何正式版本（同意書作業不看這個，看簽核包）。 */
  readonly submitted: boolean
  /** 狀態字是逾期未繳（系辦開放補交、補交期限還沒到的不算）。 */
  readonly overdue: boolean
}

/**
 * 名單上還要催的收件者。口徑同名單頁的 `completionOf`：只看目前名單（不含免填與已移出）、還沒有任何正式版本。
 * `overdue`：只要逾期未繳的（首頁逾期卡）。站內同意書（`consent: true`）的完成與否看簽核包、不看繳交版本，
 * 這裡只挑出要去看包的組（目前名單、`overdue` 時要已逾期）；沒建包的組由呼叫端整組排除。
 */
export function pendingReceiverIds(
  receivers: readonly ReminderReceiver[],
  opts: { readonly scope: 'all' | 'overdue'; readonly consent: boolean },
): string[] {
  return receivers
    .filter((r) => r.current && (opts.consent || !r.submitted))
    .filter((r) => opts.scope === 'all' || r.overdue)
    .map((r) => r.receiverId)
}

/** 一位老師在本屆（目前方案的階段、未解散組、有效指派）的評分份數。 */
export type TeacherGradingCount = { readonly teacherUserId: string; readonly assigned: number; readonly counted: number }

/** 有未送齊指派的老師與各自還差幾份（counted < assigned）；照 user id 排序，事件順序固定。 */
export function teachersBehind(rows: readonly TeacherGradingCount[]): { teacherUserId: string; pending: number }[] {
  return rows
    .filter((r) => r.counted < r.assigned)
    .map((r) => ({ teacherUserId: r.teacherUserId, pending: r.assigned - r.counted }))
    .sort((a, b) => a.teacherUserId.localeCompare(b.teacherUserId))
}

/** 催一份作業成功的 toast（AC-12「已通知 3 人」）。 */
export function describeItemReminder(receipt: { readonly notified: number }): string {
  return `已通知 ${receipt.notified} 人`
}

/** 首頁逾期卡的 toast（AC-34「已通知 N 人（1 份作業 24 小時內催過，略過）」）。 */
export function describeOverdueReminder(receipt: {
  readonly notified: number
  readonly items: readonly { readonly skippedCooldown: boolean }[]
}): string {
  const skipped = receipt.items.filter((i) => i.skippedCooldown).length
  return `已通知 ${receipt.notified} 人${skipped > 0 ? `（${skipped} 份作業 24 小時內催過，略過）` : ''}`
}

/** 首頁評分卡的 toast（AC-34「已通知 2 位老師」）。 */
export function describeGradingReminder(receipt: { readonly notified: number }): string {
  return `已通知 ${receipt.notified} 位老師`
}
