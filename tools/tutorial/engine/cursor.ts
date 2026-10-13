// 游標路徑：純函式，錄影時規劃、後製時取樣，兩邊用同一套數學。

export type Point = { x: number; y: number };
export type Move = { startMs: number; endMs: number; from: Point; to: Point };

/** 一段移動的基本時長範圍（Roy：游標不能動太快、要看得到軌跡）。 */
export const MOVE_MIN_MS = 600;
export const MOVE_MAX_MS = 900;
/** 瞬時速度上限（px/ms，影片像素）。超遠的移動會因此拉長到 900 ms 以上。 */
export const MAX_SPEED_PX_PER_MS = 2.4;
/** 低於這個距離就不畫移動（避免原地抖一下）。 */
export const MIN_MOVE_PX = 3;

/** easeInOutSine：峰值速度是平均速度的 π/2 倍。 */
const ease = (u: number) => (1 - Math.cos(Math.PI * u)) / 2;
const PEAK_FACTOR = Math.PI / 2;

export function moveDurationMs(dist: number): number {
  const nominal = MOVE_MIN_MS + (MOVE_MAX_MS - MOVE_MIN_MS) * Math.min(1, dist / 1200);
  const bySpeed = (dist * PEAK_FACTOR) / MAX_SPEED_PX_PER_MS;
  return Math.round(Math.max(nominal, bySpeed));
}

export function planMove(from: Point, to: Point, startMs: number): Move {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const d = dist < MIN_MOVE_PX ? 0 : moveDurationMs(dist);
  return { startMs, endMs: startMs + d, from: { ...from }, to: { ...to } };
}

/** 時間 t 的游標位置；moves 依時間排序、不重疊。 */
export function cursorAt(moves: readonly Move[], initial: Point, t: number): Point {
  let pos = initial;
  for (const m of moves) {
    if (t < m.startMs) break;
    if (t >= m.endMs) {
      pos = m.to;
      continue;
    }
    const k = ease((t - m.startMs) / (m.endMs - m.startMs));
    return { x: m.from.x + (m.to.x - m.from.x) * k, y: m.from.y + (m.to.y - m.from.y) * k };
  }
  return { ...pos };
}
