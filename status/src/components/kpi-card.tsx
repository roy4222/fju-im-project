import Link from "next/link"

import { Sparkline } from "@/components/sparkline"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/components/utils"
import type { Kpi, KpiState } from "@/lib/overview/overview"

export const KPI_CLASS: Record<KpiState, string> = {
  green: "border-emerald-500/40",
  yellow: "border-yellow-500/60 bg-yellow-50 dark:bg-yellow-950/40",
  red: "border-red-500/40 bg-red-50 dark:bg-red-950/40",
  grey: "border-border bg-muted/60",
}

const VALUE_CLASS: Record<KpiState, string> = {
  green: "text-emerald-700 dark:text-emerald-400",
  yellow: "text-yellow-700 dark:text-yellow-400",
  red: "text-red-700 dark:text-red-400",
  grey: "text-muted-foreground",
}

const BAR_CLASS: Record<KpiState, string> = {
  green: "bg-emerald-500",
  yellow: "bg-yellow-500",
  red: "bg-red-500",
  grey: "bg-muted-foreground/50",
}

/** 總覽 KPI 一張（DV 設計方案 §4.2）：大字結論＋小字，整張連到正本那頁。 */
export function KpiCard({ kpi }: { kpi: Kpi }) {
  return (
    <Link
      href={kpi.href}
      data-testid={`kpi-${kpi.id}`}
      data-state={kpi.state}
      className="group rounded-xl focus-visible:outline-2"
    >
      <Card className={cn("h-full gap-3 border transition-colors group-hover:bg-muted/50", KPI_CLASS[kpi.state])}>
        <CardHeader>
          <CardDescription>{kpi.title}</CardDescription>
          <CardTitle className={cn("text-2xl tabular-nums", VALUE_CLASS[kpi.state])}>{kpi.value}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          {kpi.bar !== undefined ? (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              {kpi.bar !== null ? <div className={cn("h-full rounded-full", BAR_CLASS[kpi.state])} style={{ width: `${kpi.bar}%` }} /> : null}
            </div>
          ) : null}
          {kpi.buckets ? <Sparkline values={kpi.buckets} label="最近 24 小時每小時失敗次數" /> : null}
          {kpi.notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </CardContent>
      </Card>
    </Link>
  )
}
