/** 評分工作台 Server Action 的回傳（型別放這裡：`actions.ts` 只能匯出 async 函式）。 */
export type BenchOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; fields?: readonly string[] }

/**
 * 儲存草稿的回執：儲存時間（台北分鐘）與這次寫入的版本（`version`，ISO；就是這一列在資料庫的 `submitted_real_at`，
 * 跟評分單組頁 `BenchSnapshot.version` 同一把尺）。評分卡拿它判斷收據是不是仍是已知最新的寫入、丟掉比這次寫入更早發出的重抓。
 */
export type DraftReceiptView = {
  readonly savedAtText: string
  readonly version: string
}

/** 正式送出的收件回執（給收件章對話框）。`version` 用途同 `DraftReceiptView`。 */
export type FinalReceiptView = {
  readonly groupCode: string
  readonly stageName: string
  readonly teacherScore: string
  readonly gate: 'pass' | 'fail' | null
  readonly receivedAtText: string
  readonly evaluationId: string
  readonly version: string
}
