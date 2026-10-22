/**
 * perf:bundle 的預算上限算法（Q106），從 bundle.mjs 抽出來：只用內建模組，讓 overlay 的合併器
 * （e2e 載入 `fingerprints.ts` 時也會跑）不必經 bundle.mjs 把 db.mjs／pg 一起拉進來。
 *
 * `limit = ceil(baseline × 1.1)`，baseline ≤ 250 時封頂 250；baseline 已超過 250 時不封頂。
 */
export const HARD_CAP_KB = 250
export const SHARED_LIMIT_KB = 230

export function limitFor(baselineKb) {
  const grown = Math.ceil(baselineKb * 1.1)
  return baselineKb > HARD_CAP_KB ? grown : Math.min(grown, HARD_CAP_KB)
}
