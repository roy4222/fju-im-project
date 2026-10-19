/**
 * 評分卡（`../grading-bench.tsx`）用到的算分與規則（C1-12a）：評分卡用 `import()` 另一包載入這個檔，
 * decimal.js（`@/shared/score`）就不算進 `[groupId]` 路由的首載 JS。只是轉出口，算式仍是伺服器同一份。
 */
export { blockReason, CONFIRM_NOTE, itemErrors, missingCount, missingText, PASS_FAIL_OPTIONS, RECEIPT_NOTE, SAVED_NOTE } from '@/app/dashboard/teacher/grading/rules'
export { formatScore, LETTER_GRADES, parseItemScore, teacherStageScore } from '@/shared/score'
