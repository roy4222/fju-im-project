import { cn } from "@/components/utils"
import type { KpiState, SitePill, StatusBarView } from "@/lib/overview/overview"

const TONE_CLASS: Record<KpiState, string> = {
  green: "border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/40",
  yellow: "border-yellow-500/60 bg-yellow-50 dark:bg-yellow-950/40",
  red: "border-red-500/40 bg-red-50 dark:bg-red-950/40",
  grey: "border-border bg-muted/60 text-muted-foreground",
}

const PILL_CLASS: Record<SitePill["state"], string> = {
  ok: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  fail: "border-red-500/40 text-red-700 dark:text-red-400",
  none: "border-border text-muted-foreground",
  "not-open": "border-border text-muted-foreground",
}

/** 總覽第一列（DV 設計方案 §4.1）：左邊整體狀態與更新時間，右邊兩站健康藥丸。 */
export function StatusBar({ view }: { view: StatusBarView }) {
  return (
    <section
      data-testid="status-bar"
      data-state={view.tone}
      aria-label="整體狀態"
      className={cn("flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3", TONE_CLASS[view.tone])}
    >
      <p className="font-medium">
        <span data-testid="status-text">{view.text}</span>
        {view.updated ? <span className="font-normal text-muted-foreground">・{view.updated}</span> : null}
      </p>
      <ul className="flex flex-wrap gap-2 text-sm">
        {view.sites.map((s) => (
          <li
            key={s.site}
            data-testid={`status-${s.site}`}
            data-state={s.state}
            className={cn("rounded-full border bg-background px-3 py-0.5", PILL_CLASS[s.state])}
          >
            {s.text}
          </li>
        ))}
      </ul>
    </section>
  )
}
