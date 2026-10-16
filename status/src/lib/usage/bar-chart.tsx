/**
 * 使用報表的橫向長條圖（Q-DV-1 定案 (a)：伺服器端自繪 inline SVG，0 KB client JS）。
 * `components/charts/` 目前只有面積圖，這張圖只有使用報表用，先放在 `lib/usage/`。
 *
 * 一條一個 `<rect data-action={代碼}>`；左邊是白話名、右邊是次數；X 軸從 0 到「好看的上限」。
 */
import type { ActionCount } from "./usage"

const ROW = 30
const BAR = 18
const BOX = { width: 720, left: 200, right: 64, top: 8, bottom: 28 } as const
const TICKS = 4

/** 比 max 大的「好看」上限（1、2、2.5、5 × 10ⁿ），再切成 TICKS 格。 */
export function niceMax(max: number): number {
  if (max <= 0) return TICKS
  const raw = max / TICKS
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow
  return Math.max(TICKS, Math.ceil(step) * TICKS)
}

const fmt = (n: number) => n.toLocaleString("en-US")

/** 標籤太長時截斷（SVG 的 `<text>` 不會自動換行）；完整代碼放 `<title>`。 */
const clip = (text: string, max = 30) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function BarChart({ items, label }: { items: ActionCount[]; label: string }) {
  const height = BOX.top + items.length * ROW + BOX.bottom
  const x0 = BOX.left
  const x1 = BOX.width - BOX.right
  const top = niceMax(Math.max(0, ...items.map((i) => i.count)))
  const x = (v: number) => x0 + (v / top) * (x1 - x0)
  const yAxis = height - BOX.bottom

  return (
    <svg
      data-testid="usage-bar-chart"
      viewBox={`0 0 ${BOX.width} ${height}`}
      role="img"
      aria-label={label}
      className="h-auto w-full text-xs"
    >
      {Array.from({ length: TICKS + 1 }, (_, i) => {
        const v = (top / TICKS) * i
        return (
          <g key={i}>
            <line x1={x(v)} x2={x(v)} y1={BOX.top} y2={yAxis} className="stroke-border" strokeDasharray={i ? "3 3" : undefined} />
            <text x={x(v)} y={yAxis + 18} textAnchor="middle" className="fill-muted-foreground tabular-nums">
              {fmt(v)}
            </text>
          </g>
        )
      })}
      {items.map((item, i) => {
        const y = BOX.top + i * ROW + (ROW - BAR) / 2
        return (
          <g key={item.action}>
            <title>{`${item.label === item.action ? item.action : `${item.label}（${item.action}）`}：${fmt(item.count)}`}</title>
            <text x={x0 - 8} y={y + BAR / 2} dominantBaseline="middle" textAnchor="end" className="fill-foreground">
              {clip(item.label)}
            </text>
            <rect
              data-action={item.action}
              x={x0}
              y={y}
              width={Math.max(1, x(item.count) - x0)}
              height={BAR}
              rx={3}
              className={i === 0 ? "fill-orange-500 dark:fill-orange-400" : "fill-sky-600/70 dark:fill-sky-400/70"}
            />
            <text x={x(item.count) + 6} y={y + BAR / 2} dominantBaseline="middle" className="fill-foreground tabular-nums">
              {fmt(item.count)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
