import { CheckCircle2Icon, CircleDashedIcon, XCircleIcon } from "lucide-react"

import { PageShell } from "@/components/page-shell"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/components/utils"
import { VersionCard } from "@/components/version-card"
import { buildVersionRows, shortSha } from "@/lib/data/version"
import { evaluateGoLive } from "@/lib/gate/gates"
import { loadGateInput } from "@/lib/gate/load"
import type { GateResult, GateState } from "@/lib/gate/types"

const STATE: Record<GateState, { label: string; className: string; Icon: typeof CheckCircle2Icon }> = {
  green: { label: "過", className: "border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/40", Icon: CheckCircle2Icon },
  red: { label: "不過", className: "border-red-500/40 bg-red-50 dark:bg-red-950/40", Icon: XCircleIcon },
  grey: { label: "資料不夠", className: "border-border bg-muted/60", Icon: CircleDashedIcon },
}

const ICON_COLOR: Record<GateState, string> = {
  green: "text-emerald-600",
  red: "text-red-600",
  grey: "text-muted-foreground",
}

/** 「現在」：判斷資料是否過期用。抽成函式讓頁面本體保持純粹。 */
const currentTime = () => new Date()

function GateCard({ gate }: { gate: GateResult }) {
  const s = STATE[gate.state]
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
        {gate.reasons.length ? (
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {gate.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : null}
        {gate.link ? (
          <a href={gate.link.href} className="text-primary underline-offset-4 hover:underline">
            {gate.link.label}
          </a>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** 能不能上線（設計方案 §3.8）：五條各自綠／紅／灰與原因，全綠才「可以上線」。 */
export default async function GoLivePage() {
  const input = await loadGateInput()
  const { canGoLive, gates } = evaluateGoLive(input, currentTime())
  const rows = buildVersionRows({ github: input.github, vm: input.vm, health: input.health })
  const runId = input.acceptance.index?.latestFullAttempt ?? null
  const testedCommit = input.acceptance.run?.commitEnd ?? null
  const mainSha = input.github?.mainSha ?? null

  return (
    <PageShell title="能不能上線">
      <Card
        data-testid="go-live-verdict"
        data-can-go-live={canGoLive ? "true" : "false"}
        className={cn("border", canGoLive ? STATE.green.className : STATE.red.className)}
      >
        <CardHeader>
          <CardTitle className="text-3xl font-semibold">{canGoLive ? "可以上線" : "還不能上線"}</CardTitle>
          <CardDescription>
            {canGoLive
              ? "五條全部是綠的。"
              : `五條裡有 ${gates.filter((g) => g.state !== "green").length} 條還沒過（紅＝不過、灰＝資料不夠，都算不過）。`}
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
        {gates.map((g) => (
          <GateCard key={g.id} gate={g} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>補充資訊（不是上線條件）</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm text-muted-foreground">
          <p data-testid="tested-commit">
            最近一次完整驗收：{runId ?? "還沒有"}
            {testedCommit ? `，測的是 ${shortSha(testedCommit)}` : ""}
            {mainSha ? `；main 目前是 ${shortSha(mainSha)}` : ""}
            {testedCommit && mainSha && shortSha(testedCommit) !== shortSha(mainSha) ? "（驗收之後 main 有新 commit）" : ""}
          </p>
          <p>G3 若最近一次通過、但 30 分鐘內有過失敗，算「資料不夠」，等連續 6 次通過才變綠。</p>
          <p>G5 的「fju.roy422.dev 有 A 記錄」設定檢查還沒輸出這一項，這頁沒有自動判斷，請上線前自己確認。</p>
        </CardContent>
      </Card>

      <VersionCard rows={rows} generatedAt={input.github?.generatedAt ?? null} />
    </PageShell>
  )
}
