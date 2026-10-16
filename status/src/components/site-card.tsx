import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/components/utils"
import type { SiteCardView, SiteState } from "@/lib/health/view"

const STATE_CLASS: Record<SiteState, string> = {
  green: "border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/40",
  red: "border-red-500/40 bg-red-50 dark:bg-red-950/40",
  grey: "border-border bg-muted/60",
}

const TEXT_CLASS: Record<SiteState, string> = {
  green: "text-emerald-700 dark:text-emerald-400",
  red: "text-red-700 dark:text-red-400",
  grey: "text-muted-foreground",
}

/** 最近 6 次健康檢查（新到舊）：一顆點對一次，綠＝過、紅＝沒過。 */
function Last6({ last6 }: { last6: boolean[] }) {
  return (
    <ol aria-label="最近 6 次檢查（新到舊）" className="flex items-center gap-1.5">
      {last6.map((ok, i) => (
        <li
          key={i}
          data-ok={ok ? "true" : "false"}
          title={ok ? "過" : "沒過"}
          className={cn("size-3 rounded-full", ok ? "bg-emerald-500" : "bg-red-500")}
        />
      ))}
    </ol>
  )
}

/** 一站健康（正本，DV 設計方案 §5.1）：ok、commit 短 SHA、最近 6 次、原因。 */
export function SiteCard({ view }: { view: SiteCardView }) {
  return (
    <Card data-testid={`site-${view.site}`} data-state={view.state} className={cn("border", STATE_CLASS[view.state])}>
      <CardHeader>
        <CardDescription>{view.label}</CardDescription>
        <CardTitle className={TEXT_CLASS[view.state]}>{view.okText}</CardTitle>
        {view.checkedAt ? (
          <CardDescription>
            最後檢查 {view.checkedAt}
            {view.checkedAge ? `（${view.checkedAge}）` : ""}
          </CardDescription>
        ) : null}
      </CardHeader>
      {view.state === "grey" ? null : (
        <CardContent className="flex flex-col gap-2 text-sm">
          <div className="flex gap-3">
            <span className="w-16 shrink-0 text-muted-foreground">commit</span>
            {view.commitShort ? (
              <code className="font-mono" title={view.commit ?? undefined}>
                {view.commitShort}
              </code>
            ) : (
              <span>—</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-muted-foreground">最近 6 次</span>
            <Last6 last6={view.last6} />
          </div>
          {view.reason ? (
            <p data-testid="site-reason" className={cn("break-all font-medium", TEXT_CLASS.red)}>
              {view.reason}
            </p>
          ) : null}
        </CardContent>
      )}
    </Card>
  )
}
