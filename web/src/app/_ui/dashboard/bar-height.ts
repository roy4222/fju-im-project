/**
 * `Bars` 一根柱子的高度（px）：值大於 0 才給最小高度 4px（太小的值還看得到）；
 * 值是 0 就是 0，不畫出一截假的進度（例如還沒開始評分的老師）。
 */
export function barHeight(value: number, max: number, plotHeight: number): number {
  if (!(value > 0) || !(max > 0)) return 0
  return Math.max(4, (Math.min(value, max) / max) * plotHeight)
}
