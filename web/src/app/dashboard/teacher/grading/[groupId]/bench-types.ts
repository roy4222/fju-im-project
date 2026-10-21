import type { GroupVersionWithFiles } from '@/application/submissions'
import { charLength } from '@/shared/text'

/**
 * 評分單組頁（TE-06b）用的型別。總覽的在 `../overview-types.ts`；`../types.ts`（Server Action 回傳）不放這裡。
 */

/** 頁首「上一組／下一組」的一邊：沒有就是 null（鍵停用）。 */
export type NeighbourLink = { readonly href: string; readonly groupCode: string } | null

/** 左欄一列：每個整組作業最新一次正式送出的版本＋它的附件。 */
export type SubmissionRow = GroupVersionWithFiles

/** 「送出紀錄」一列：第幾次正式送出、什麼時候（台北時間文字，頁面伺服器端排好）。 */
export type SubmissionRecord = { readonly no: number; readonly atText: string }

/**
 * 評分卡一次收到的伺服器事實（`page.tsx` 從 `BenchEntry` 組好整包傳進來；Review #584 第 4、5 輪）。
 * 評分卡只顯示「最後接受」的那一份，不直接讀零散 props——重抓回來比較舊的一份整包丟掉，畫面不會退回舊值。
 *
 * - `version`：這個指派在資料庫的寫入版本（`page.tsx` 的 `benchVersionOf`）：每次暫存、送出、退回的寫入戳記取最大，
 *   同一指派的寫入在列鎖內依序發生，所以它隨每次寫入嚴格變大；是排序快照、確認收據、保存未存內容的唯一鍵。
 * - `serverTime`：這份資料在伺服器讀出的時間；只拿來排「同一個 `version`、只差顯示軸」的兩份快照（嚴格較新才接受）。
 *   結算**不**靠它：評分卡一旦接受過 `readOnly` 的快照就鎖到整頁重載（第 5 輪 S3），之後的快照不能解鎖。
 */
export type BenchSnapshot = {
  readonly version: string
  readonly serverTime: string
  /** 伺服器存的分數（暫存或採計那一筆；被退回時是退回前的）。 */
  readonly scores: Readonly<Record<string, string>>
  readonly comment: string | null
  /** 已有一筆採計（正式送出過、沒被退回）。 */
  readonly hasFinal: boolean
  /** 不能再改：階段已結算（或已採計但不能重送）。 */
  readonly readOnly: boolean
  /** 系辦結算時間；沒結算是 null。 */
  readonly settledAtText: string | null
  /** 正式送出後又存了草稿、還沒重新送出。 */
  readonly draftAfterFinal: boolean
  /** 第 1 次…第 n 次正式送出（舊的在前）。 */
  readonly submissionHistory: readonly SubmissionRecord[]
  readonly savedAtText: string | null
  readonly finalScore: string | null
  readonly draftFromOlderVersion: boolean
}

/** 評語上限（B 階段 TE-B4）：跟用例、資料庫 `char_length` 同一個數，按字元（code point）算，emoji 算一個字。 */
export const COMMENT_MAX = 500
export const commentLength = charLength
