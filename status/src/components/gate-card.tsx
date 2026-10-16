import { CheckCircle2Icon, CircleDashedIcon, XCircleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/components/utils"
import type { GateResult, GateState } from "@/lib/gate/types"

export const GATE_STATE: Record<GateState, { label: string; className: string; Icon: typeof CheckCircle2Icon }> = {
  green: { label: "過", className: "border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/40", Icon: CheckCircle2Icon },
  red: { label: "不過", className: "border-red-500/40 bg-red-50 dark:bg-red-950/40", Icon: XCircleIcon },
  grey: { label: "資料不夠", className: "border-border bg-muted/60", Icon: CircleDashedIcon },
}

const ICON_COLOR: Record<GateState, string> = {
  green: "text-emerald-600",
  red: "text-red-600",
  grey: "text-muted-foreground",
}

/**
 * 一條「能不能上線」判定（G1～G5）。`/go-live` 用完整卡（原因清單、連結、補充說明）；
 * 總覽用 `compact`：一行狀態點＋條件名＋一句結論，不列原因（設計方案 §4.4）。
 */
export function GateCard({ gate, compact = false, children }: { gate: GateResult; compact?: boolean; children?: React.ReactNode }) {
  const s = GATE_STATE[gate.state]
  if (compact) {
    return (
      <div data-testid={`gate-${gate.id}`} data-state={gate.state} className="flex items-start gap-2 text-sm">
        <s.Icon className={cn("mt-0.5 size-4 shrink-0", ICON_COLOR[gate.state])} aria-label={s.label} />
        <span className="shrink-0 font-medium">{gate.title}</span>
        <span className="text-muted-foreground" data-testid={`gate-${gate.id}-summary`}>{gate.summary}</span>
      </div>
    )
  }
  // 紅的時候結論就是第一個原因，清單不再重複列。
  const reasons = gate.reasons.filter((r) => r !== gate.summary)
  return (
    <Card data-testid={`gate-${gate.id}`} data-state={gate.state} className={cn("border", s.className)}>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <span className="font-mono">{gate.id}</span>
          <Badge variant="outline">{s.label}</Badge>
        </CardDescription>
        <CardTitle className="flex items-start gap-2">
          <s.Icon className={cn("mt-0.5 size-5 shrink-0", ICON_COLOR[gate.state])} aria-hidden />
          <span>{gate.title}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <p className="font-medium" data-testid={`gate-${gate.id}-summary`}>{gate.summary}</p>
        {reasons.length ? (
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : null}
        {gate.link ? (
          <a href={gate.link.href} className="text-primary underline-offset-4 hover:underline">
            {gate.link.label}
          </a>
        ) : null}
        {children ? <div className="flex flex-col gap-1 text-muted-foreground">{children}</div> : null}
      </CardContent>
    </Card>
  )
}
