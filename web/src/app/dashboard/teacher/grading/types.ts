/** 評分工作台 Server Action 的回傳（型別放這裡：`actions.ts` 只能匯出 async 函式）。 */
export type BenchOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; fields?: readonly string[] }

/** 儲存草稿的回執：儲存時間（台北分鐘）與伺服器時間（ISO；評分卡用它丟掉比這次寫入更早發出的重抓結果）。 */
export type DraftReceiptView = {
  readonly savedAtText: string
  readonly serverTime: string
}

/** 正式送出的收件回執（給收件章對話框）。`serverTime` 用途同 `DraftReceiptView`。 */
export type FinalReceiptView = {
  readonly groupCode: string
  readonly stageName: string
  readonly teacherScore: string
  readonly gate: 'pass' | 'fail' | null
  readonly receivedAtText: string
  readonly evaluationId: string
  readonly serverTime: string
}
