import { GATE_STATE, GateCard } from "@/components/gate-card"
import { PageShell } from "@/components/page-shell"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/components/utils"
import { shortSha } from "@/lib/data/version"
import { evaluateGoLive } from "@/lib/gate/gates"
import { loadGateInput } from "@/lib/gate/load"

/** 「現在」：判斷資料是否過期用。抽成函式讓頁面本體保持純粹。 */
const currentTime = () => new Date()

/**
 * 能不能上線（設計方案 §3.8；DV 改版 §2、§7.4）：五條各自綠／紅／灰與原因，全綠才「可以上線」。
 * 不進側欄，從總覽「能不能上線」標題進來；版本卡的正本在 /deploy。
 */
export default async function GoLivePage() {
  const input = await loadGateInput()
  const { canGoLive, gates } = evaluateGoLive(input, currentTime())
  const runId = input.acceptance.index?.latestFullAttempt ?? null
  const testedCommit = input.acceptance.run?.commitEnd ?? null
  const mainSha = input.github?.mainSha ?? null

  const extra: Partial<Record<string, React.ReactNode>> = {
    G2: (
      <p data-testid="tested-commit">
        最近一次完整驗收：{runId ?? "還沒有"}
        {testedCommit ? `，測的是 ${shortSha(testedCommit)}` : ""}
        {mainSha ? `；main 目前是 ${shortSha(mainSha)}` : ""}
        {testedCommit && mainSha && shortSha(testedCommit) !== shortSha(mainSha) ? "（驗收之後 main 有新 commit）" : ""}
      </p>
    ),
    G3: <p>若最近一次通過、但 30 分鐘內有過失敗算資料不夠，等連續 6 次通過才變綠。</p>,
  }

  return (
    <PageShell title="能不能上線">
      <Card
        data-testid="go-live-verdict"
        data-can-go-live={canGoLive ? "true" : "false"}
        className={cn("border", canGoLive ? GATE_STATE.green.className : GATE_STATE.red.className)}
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
          <GateCard key={g.id} gate={g}>
            {extra[g.id]}
          </GateCard>
        ))}
      </div>
    </PageShell>
  )
}
