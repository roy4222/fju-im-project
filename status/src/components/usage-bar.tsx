import { cn } from "@/components/utils"

export type UsageBarState = "green" | "yellow" | "red" | "grey"

const FILL: Record<UsageBarState, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
  grey: "bg-muted-foreground/40",
}

/**
 * 大進度條＋門檻線（DV 設計方案 §5.4，只給 `/backup` 用）。純 `<div>` 寬度，沒有 JS。
 * 每條門檻線帶 `data-threshold`，旁邊標百分比。
 */
export function UsageBar({
  percent,
  thresholds,
  state,
  label,
}: {
  percent: number
  thresholds: readonly number[]
  state: UsageBarState
  label: string
}) {
  return (
    <div className="pb-5">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="relative h-4 w-full rounded-full bg-muted"
      >
        <div
          data-testid="usage-bar-fill"
          className={cn("h-full rounded-full", FILL[state])}
          style={{ width: `${percent}%` }}
        />
        {thresholds.map((t) => (
          <div
            key={t}
            data-threshold={t}
            aria-hidden
            className="absolute -top-1 -bottom-1 w-0.5 bg-foreground/70"
            style={{ left: `${t}%` }}
          >
            <span className="absolute top-full mt-1 -translate-x-1/2 text-xs text-muted-foreground tabular-nums">{t}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}
