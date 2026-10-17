import type { GroupVersionWithFiles } from '@/application/submissions'

/**
 * 評分單組頁（TE-06b）用的型別。總覽的在 `../overview-types.ts`；`../types.ts`（Server Action 回傳）不放這裡。
 */

/** 頁首「上一組／下一組」的一邊：沒有就是 null（鍵停用）。 */
export type NeighbourLink = { readonly href: string; readonly groupCode: string } | null

/** 左欄一列：每個整組作業最新一次正式送出的版本＋它的附件。 */
export type SubmissionRow = GroupVersionWithFiles
