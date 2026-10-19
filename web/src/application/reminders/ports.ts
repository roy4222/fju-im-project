import type { ResolvedActor } from '@/application/accounts'
import type { Result } from '@/shared/result'

/**
 * 催繳（C 階段規格① §1.5、§3.5、§8，A9）的 port；實作在 `infrastructure/reminders/pg-reminders.ts`。
 *
 * 站內通知必發（事件與業務寫入同一筆交易）、Email 盡力（交易 commit 後才寄，每人一封，失敗只留 `mail_outbox`）。
 * 頻率：同一份作業 24 小時只能催一次；評分同一屆 24 小時一次。判斷方式同 `signoff.remind`：
 * 查 `domain_events` 最後一筆 `item.reminded`（`source_id`＝作業）／`grading.reminded`（`source_id`＝屆別）。
 */

export type RemindItemReceipt = {
  readonly itemId: string
  readonly title: string
  /** 收到站內通知的人數（去重後）。 */
  readonly notified: number
  /**
   * 寄出的催繳信數（寄信服務收下或擷取模式存進 outbox）。回放（同一個請求編號再送）時是第一次**排入寄送**的封數：
   * 寄送結果在交易 commit 之後才知道，不寫回帳本；實際結果看 `mail_outbox`。
   */
  readonly mailed: number
  readonly remindedAt: string
  /** 下一次可以再催的時間（這次之後 24 小時）。 */
  readonly nextAllowedAt: Date
}

export type RemindOverdueItem = {
  readonly itemId: string
  readonly title: string
  readonly notified: number
  /** 這份 24 小時內催過，這次略過（`notified` 是 0）。 */
  readonly skippedCooldown: boolean
}

export type RemindOverdueReceipt = {
  /** 已截止、還有人逾期未繳的發布中作業（順序同作業清單）。沒有逾期未繳的作業不列。 */
  readonly items: readonly RemindOverdueItem[]
  /** 全部作業加起來通知的人數（同一人被兩份作業催算兩次：各一則通知）。 */
  readonly notified: number
  readonly mailed: number
  readonly remindedAt: string
}

export type RemindGradingReceipt = {
  readonly cohortId: string
  /** 收到催繳的老師人數。 */
  readonly notified: number
  readonly mailed: number
  readonly remindedAt: string
  readonly nextAllowedAt: Date
}

export type LastReminded = {
  /** 最近一次催繳的真實時間；沒催過是 null。 */
  readonly at: Date | null
  /** 冷卻中時下一次可以催的時間；現在就可以催是 null。 */
  readonly nextAllowedAt: Date | null
}

export interface ReminderCommand {
  /**
   * 系辦催一份作業：名單上「尚未完成」的人（整組→展開組員；同意書→還沒投票的人＋等老師時的主指導；
   * **沒建包的組整組排除**，他們沒票可投）。
   * FORBIDDEN → VALIDATION_FAILED（不是發布中的收件項目）→ CONFLICT「{標題}上次催繳在 {時間}，24 小時內不能再催」
   * （`details.nextAllowedAt`、`details.lastRemindedAt`）。
   */
  remindItem(actor: ResolvedActor, input: { itemId: string }, requestId: string): Promise<Result<RemindItemReceipt>>
  /** 系辦催全屆逾期：所有發布中且已截止的作業各催一次（各自受 24 小時冷卻；被冷卻的跳過並回報）。只催逾期未繳的人。 */
  remindOverdue(actor: ResolvedActor, input: { cohortId: string }, requestId: string): Promise<Result<RemindOverdueReceipt>>
  /** 系辦催評分：有未送齊指派（counted < assigned）的老師各一則；冷卻以屆為單位。 */
  remindGrading(actor: ResolvedActor, input: { cohortId: string }, requestId: string): Promise<Result<RemindGradingReceipt>>
}

export interface ReminderQuery {
  /** `sourceId`：`item` 是作業 id、`grading` 是屆別 id。 */
  lastReminded(actor: ResolvedActor, kind: 'item' | 'grading', sourceId: string): Promise<Result<LastReminded>>
}
