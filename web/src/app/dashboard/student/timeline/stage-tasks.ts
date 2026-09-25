/**
 * 時間軸每一段要列哪些收件（票 38 後續；Codex P2）。
 *
 * 用階段的**身分**（屆別＋序號）比對，不用名稱：同一屆可以有兩段同名，
 * 用名稱比會把同一件收件列在兩段、摘要列的主要按鈕也可能抓到別段的收件。
 * 別屆的收件（理論上學生只在一屆，但查詢不保證）與沒指定階段的收件都不列。
 */
export function tasksOfStage<T extends { readonly cohortId: string; readonly stageSeq: number | null }>(
  items: readonly T[],
  cohortId: string,
  seq: number,
): T[] {
  return items.filter((item) => item.cohortId === cohortId && item.stageSeq === seq)
}
