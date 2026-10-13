// 測試環境：截圖張數是「機器＋引擎」的表現，不是引擎邏輯——同一份程式在 Mac mini 空機約 34 張／秒、間隔 ≤ 40 ms，
// 別的程序同時在跑（實測 loadavg 9～11 時）會掉到 22 張／秒、間隔 70～160 ms。
// 看「畫面內容、事件時間、暫停、捲動」的測試不該因此中止或失敗，所以預設把中止門檻放寬到 300 ms（中止門檻本身在
// recorder.test.ts 的「截圖跟不上（> 100 ms）中止」專門測；對齊誤差則以實際間隔為上限）。
// 要用產品門檻（間隔 > 100 ms 中止、≥ 25 張／秒、≤ 50 ms、quality.ok）驗機器，在空機上跑：
//   TUTORIAL_STRICT_QUALITY=1 pnpm -C tools/tutorial test

export const STRICT = !!process.env.TUTORIAL_STRICT_QUALITY;

/** 展開進 startChapter 的選項。 */
export const CAPTURE_OPTS: { maxGapMs?: number } = STRICT ? {} : { maxGapMs: 300 };

/** 逐格對齊誤差的上限：達到單路標準時 50 ms；否則「實際最大間隔 ＋ 30 ms」（量化誤差 ≈ 間隔 − 半格，再加負載下的延遲抖動）。 */
export function alignBound(meets: boolean, maxGapMs: number): number {
  return meets ? 50 : maxGapMs + 30;
}
