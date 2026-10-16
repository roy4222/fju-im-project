import { cn } from "@/components/utils"

/**
 * 迷你長條圖（DV 設計方案 §4.2「24h 錯誤」）：每格一根，高度＝該格數值／最大值。伺服器端畫的 `<svg>`，0 KB client JS。
 * 全部是 0 時只畫底線，不畫長條。
 */
export function Sparkline({ values, label, className }: { values: number[]; label: string; className?: string }) {
  const max = Math.max(0, ...values)
  const w = 4
  const gap = 1
  const h = 20
  const width = values.length * (w + gap) - gap
  return (
    <svg
      data-testid="sparkline"
      viewBox={`0 0 ${Math.max(width, 1)} ${h}`}
      role="img"
      aria-label={label}
      className={cn("h-5 w-full max-w-32", className)}
      preserveAspectRatio="none"
    >
      <line x1={0} x2={Math.max(width, 1)} y1={h - 0.5} y2={h - 0.5} className="stroke-border" strokeWidth={1} />
      {max > 0
        ? values.map((v, i) =>
            v > 0 ? (
              <rect
                key={i}
                x={i * (w + gap)}
                y={h - Math.max(2, (v / max) * h)}
                width={w}
                height={Math.max(2, (v / max) * h)}
                className="fill-amber-500 dark:fill-amber-400"
              />
            ) : null,
          )
        : null}
    </svg>
  )
}
