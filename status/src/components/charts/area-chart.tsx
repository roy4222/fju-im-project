/**
 * 面積圖（DV 設計方案 §4.3、§5.1；Q-DV-1 定案 (a)）：伺服器端自繪 inline SVG，0 KB client JS。
 * 總覽 `overview-chart` 與服務健康 `health-chart` 共用；兩頁都只透過下面的介面用圖，
 * 要換成別的實作時只換這個檔。
 *
 *   <AreaChart unit="ms" series={[{ id: "test", label: "測試站", points: [{ at, value }] }]} />
 *
 * - 每個系列一條 `<path data-series={id ?? label}>`（折線）；面積底色是 `<polygon>`、軸與格線是
 *   `<line>`／`<text>`，所以整張圖的 `<path>` 數＝系列數。
 * - X 軸固定 24 小時：右端是所有點裡最新的時間，左端往前 24h；刻度是台北時間整點、每 4 小時一個。
 * - Y 軸從 0 到「好看的上限」，刻度字帶 `unit`。
 */
import { cn } from "@/components/utils"

export type ChartPoint = { at: string; value: number }
export type ChartSeries = {
  /** `data-series` 的值（例如 "test"、"prod"）；沒給就用 label */
  id?: string
  label: string
  points: ChartPoint[]
}
export type AreaChartProps = { series: ChartSeries[]; unit: string; className?: string }

export const WINDOW_MS = 24 * 3600e3
const TICK_HOURS = 4

/** 繪圖區在 viewBox 裡的位置（左邊留給 Y 軸字、下面留給 X 軸字）。 */
export const BOX = { width: 720, height: 220, left: 56, right: 12, top: 12, bottom: 28 } as const
const PLOT = {
  x0: BOX.left,
  x1: BOX.width - BOX.right,
  y0: BOX.height - BOX.bottom,
  y1: BOX.top,
}

/** 系列顏色依序取用；用 Tailwind 色票，淺色／深色都看得清楚。 */
const COLORS = [
  { line: "stroke-sky-600 dark:stroke-sky-400", fill: "fill-sky-500/15", dot: "bg-sky-600 dark:bg-sky-400" },
  { line: "stroke-violet-600 dark:stroke-violet-400", fill: "fill-violet-500/10", dot: "bg-violet-600 dark:bg-violet-400" },
  { line: "stroke-amber-600 dark:stroke-amber-400", fill: "fill-amber-500/10", dot: "bg-amber-600 dark:bg-amber-400" },
]

const HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", hour: "2-digit", hourCycle: "h23" })

/** 1、1.5、2、3、4、5、6、8 × 10ⁿ 裡第一個 ≥ max 的數；max ≤ 0 時回 1（避免除以 0）。 */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 1.5, 2, 3, 4, 5, 6, 8]) if (m * p >= max) return m * p
  return 10 * p
}

const round = (n: number) => Math.round(n * 10) / 10

/** 畫一張圖需要的全部座標。純函式，測試直接驗。 */
export function layoutChart(series: ChartSeries[]) {
  const valid = series.flatMap((s) => s.points).filter((p) => Number.isFinite(Date.parse(p.at)) && Number.isFinite(p.value))
  const end = valid.length ? Math.max(...valid.map((p) => Date.parse(p.at))) : 0
  const start = end - WINDOW_MS
  const all = valid.filter((p) => Date.parse(p.at) >= start)
  const yMax = niceMax(all.length ? Math.max(...all.map((p) => p.value)) : 0)

  const x = (t: number) => round(PLOT.x0 + ((t - start) / WINDOW_MS) * (PLOT.x1 - PLOT.x0))
  const y = (v: number) => round(PLOT.y0 - (Math.max(0, v) / yMax) * (PLOT.y0 - PLOT.y1))

  const lines = series.map((s, i) => {
    const pts = s.points
      .map((p) => ({ t: Date.parse(p.at), v: p.value }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.t >= start)
      .sort((a, b) => a.t - b.t)
      .map((p) => [x(p.t), y(p.v)] as const)
    const d = pts.map(([px, py], j) => `${j ? "L" : "M"}${px} ${py}`).join(" ")
    const area = pts.length
      ? [`${pts[0]![0]},${PLOT.y0}`, ...pts.map(([px, py]) => `${px},${py}`), `${pts.at(-1)![0]},${PLOT.y0}`].join(" ")
      : ""
    return { id: s.id ?? s.label, label: s.label, color: COLORS[i % COLORS.length]!, d, area }
  })

  // 台北時間整點、每 TICK_HOURS 小時一個（台北沒有日光節約，整點＝UTC 整點）。
  const xTicks: { x: number; text: string }[] = []
  if (all.length) {
    for (let t = Math.ceil(start / 3600e3) * 3600e3; t <= end; t += 3600e3) {
      const text = HOUR.format(t)
      if (Number(text) % TICK_HOURS === 0) xTicks.push({ x: x(t), text: `${text}:00` })
    }
  }
  const yTicks = [0, yMax / 2, yMax].map((v) => ({ y: y(v), value: v }))
  return { lines, xTicks, yTicks, empty: all.length === 0 }
}

export function AreaChart({ series, unit, className }: AreaChartProps) {
  const { lines, xTicks, yTicks, empty } = layoutChart(series)
  return (
    <figure className={cn("flex flex-col gap-2", className)}>
      <svg
        viewBox={`0 0 ${BOX.width} ${BOX.height}`}
        role="img"
        aria-label={`${series.map((s) => s.label).join("、")}，最近 24 小時（${unit}）`}
        className="h-auto w-full text-muted-foreground"
      >
        {yTicks.map((t) => (
          <g key={t.value}>
            <line x1={PLOT.x0} x2={PLOT.x1} y1={t.y} y2={t.y} className="stroke-border" strokeWidth={1} />
            <text x={PLOT.x0 - 6} y={t.y} dy="0.32em" textAnchor="end" fontSize={11} className="fill-current">
              {`${t.value} ${unit}`}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t.x} x={t.x} y={PLOT.y0 + 18} textAnchor="middle" fontSize={11} className="fill-current">
            {t.text}
          </text>
        ))}
        {lines.map((l) => (l.area ? <polygon key={`a-${l.id}`} points={l.area} className={l.color.fill} /> : null))}
        {lines.map((l) =>
          l.d ? (
            <path
              key={l.id}
              data-series={l.id}
              d={l.d}
              fill="none"
              strokeWidth={1.5}
              strokeLinejoin="round"
              className={l.color.line}
            />
          ) : null,
        )}
        {empty ? (
          <text x={(PLOT.x0 + PLOT.x1) / 2} y={(PLOT.y0 + PLOT.y1) / 2} textAnchor="middle" fontSize={12} className="fill-current">
            沒有資料點
          </text>
        ) : null}
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {lines.map((l) => (
          <span key={l.id} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn("inline-block size-2 rounded-full", l.color.dot)} />
            {l.label}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}
