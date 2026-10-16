import Link from "next/link"

import { AreaChart } from "@/components/charts/area-chart"
import { GateCard } from "@/components/gate-card"
import { KpiCard } from "@/components/kpi-card"
import { PageShell } from "@/components/page-shell"
import { RecentEvents } from "@/components/recent-events"
import { StatusBar } from "@/components/status-bar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { loadOverview } from "@/lib/overview/load"
import { buildOverview, type OverviewView } from "@/lib/overview/overview"

/** 「現在」：算多久前用。抽成函式讓頁面本體保持純粹。 */
const currentTime = () => new Date()

/** 兩站 24h 回應時間（跟服務健康頁同一個圖表元件）。沒有資料畫灰卡；本輪 Gatus 失敗照畫舊圖、標灰字。 */
function OverviewChart({ chart }: { chart: OverviewView["chart"] }) {
  const { view } = chart
  if (view.state === "none") {
    return (
      <Card data-testid="overview-chart" data-state="none" className="border border-border bg-muted/60">
        <CardHeader>
          <CardDescription>兩站 24 小時回應時間</CardDescription>
          <CardTitle className="text-muted-foreground">還沒有 Gatus 資料</CardTitle>
          <CardDescription>
            {view.note}
            {view.error ? `：${view.error}` : ""}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }
  return (
    <Card data-testid="overview-chart" data-state={view.state}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Link href="/health" className="underline-offset-4 hover:underline">
              兩站 24 小時回應時間
            </Link>
            {view.state === "stale" ? (
              <span data-testid="chart-stale" className="text-sm font-normal text-muted-foreground">
                {view.note}
                {view.error ? `（${view.error}）` : ""}
              </span>
            ) : null}
          </CardTitle>
          <CardDescription>Gatus 每 5 分鐘檢查一次兩站首頁。</CardDescription>
        </div>
        <dl className="flex gap-4 text-sm" data-testid="overview-uptime">
          <div>
            <dt className="text-xs text-muted-foreground">測試站</dt>
            <dd className="tabular-nums">24h 可用率 {chart.uptime24h}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">測試站</dt>
            <dd className="tabular-nums">7d 可用率 {chart.uptime7d}</dd>
          </div>
        </dl>
      </CardHeader>
      <CardContent>
        <AreaChart series={view.series} unit="ms" />
      </CardContent>
    </Card>
  )
}

/** 五條只列狀態＋一句結論（原因清單在 `/go-live`，DV 設計方案 §4.4）。 */
function GoLiveSummary({ goLive }: { goLive: OverviewView["goLive"] }) {
  return (
    <Card data-testid="go-live-summary">
      <CardHeader className="flex items-baseline justify-between gap-3">
        <CardTitle>
          <Link href="/go-live" className="underline-offset-4 hover:underline">
            能不能上線
          </Link>
        </CardTitle>
        <span data-testid="go-live-count" className="text-sm tabular-nums text-muted-foreground">
          {goLive.green} / {goLive.gates.length}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {goLive.gates.map((g) => (
          <Link key={g.id} href="/go-live" className="rounded-md px-1 py-0.5 hover:bg-muted/50">
            <GateCard gate={g} compact />
          </Link>
        ))}
      </CardContent>
    </Card>
  )
}

/** 總覽（DV 設計方案 §4）：狀態列 → KPI 五卡 → Gatus 圖 → 能不能上線 → 最近事件。一次讀齊資料再往下傳。 */
export default async function OverviewPage() {
  const view = buildOverview(await loadOverview(), currentTime())
  return (
    <PageShell title="總覽">
      <StatusBar view={view.statusBar} />
      <section aria-label="重點指標" className="grid grid-cols-1 gap-4 @xl/main:grid-cols-3 @5xl/main:grid-cols-5">
        {view.kpis.map((k) => (
          <KpiCard key={k.id} kpi={k} />
        ))}
      </section>
      <OverviewChart chart={view.chart} />
      <div className="grid grid-cols-1 gap-4 @5xl/main:grid-cols-2">
        <GoLiveSummary goLive={view.goLive} />
        <RecentEvents events={view.events} />
      </div>
    </PageShell>
  )
}
