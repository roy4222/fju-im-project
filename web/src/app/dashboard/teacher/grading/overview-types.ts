import type { TeacherQueueEntry } from '@/application/grading'

/**
 * 評分總覽（TE-06a）用的型別。單組頁的型別在 `[groupId]/bench-types.ts`；`types.ts`（Server Action 回傳）不放這裡。
 */

/** 總覽的四個篩選（網址 `?filter=`；「全部」不帶參數）。 */
export type GradingFilter = 'all' | 'pending' | 'draft' | 'submitted'

/** 一張卡的狀態：待評（沒評過或被系辦退回）、草稿、已送出（採計）。 */
export type GradingStatus = Exclude<GradingFilter, 'all'>

/** 分類只需要的欄位；`TeacherQueueEntry` 本身就符合，單元測試可以只給這幾欄。 */
export type Classifiable = Pick<TeacherQueueEntry, 'state' | 'returned'>

/** 總覽上方的階段切換（同一位老師被指派多個階段時才出現）。 */
export type StageOption = { readonly key: string; readonly name: string }
