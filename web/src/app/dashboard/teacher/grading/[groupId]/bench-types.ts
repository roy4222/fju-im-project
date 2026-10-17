import type { GroupVersionWithFiles } from '@/application/submissions'

/**
 * 評分單組頁（TE-06b）用的型別。總覽的在 `../overview-types.ts`；`../types.ts`（Server Action 回傳）不放這裡。
 */

/** 頁首「上一組／下一組」的一邊：沒有就是 null（鍵停用）。 */
export type NeighbourLink = { readonly href: string; readonly groupCode: string } | null

/** 左欄一列：每個整組作業最新一次正式送出的版本＋它的附件。 */
export type SubmissionRow = GroupVersionWithFiles

/** 「送出紀錄」一列：第幾次正式送出、什麼時候（台北時間文字，頁面伺服器端排好）。 */
export type SubmissionRecord = { readonly no: number; readonly atText: string }

/** 評語上限（B 階段 TE-B4）：跟用例、資料庫 `char_length` 同一個數，按字元（code point）算，emoji 算一個字。 */
export const COMMENT_MAX = 500
export const commentLength = (text: string) => [...text].length
