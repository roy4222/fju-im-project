/** 評分工作台 Server Action 的回傳（型別放這裡：`actions.ts` 只能匯出 async 函式）。 */
export type BenchOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; fields?: readonly string[] }

/** 正式送出的收件回執（給收件章對話框）。 */
export type FinalReceiptView = {
  readonly groupCode: string
  readonly stageName: string
  readonly teacherScore: string
  readonly gate: 'pass' | 'fail' | null
  readonly receivedAtText: string
  readonly evaluationId: string
}
