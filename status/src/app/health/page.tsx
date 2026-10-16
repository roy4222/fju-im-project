import type { Metadata } from "next"

import { AreaChart } from "@/components/charts/area-chart"
import { PageShell } from "@/components/page-shell"
import { SiteCard } from "@/components/site-card"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { dataOrNull, readData } from "@/lib/data/read"
import { buildHealthView, type AccessRow, type ChartView, type UptimeRow } from "@/lib/health/view"

export const metadata: Metadata = { title: "服務健康" }

/** 「現在」：算多久前用。抽成函式讓頁面本體保持純粹。 */
const currentTime = () => new Date()

const GREY = "border border-border bg-muted/60"

/** 兩站 24h 回應時間（跟總覽同一個圖表元件）。沒有資料畫灰卡；本輪 Gatus 失敗照畫舊圖、標灰字。 */
function HealthChart({ chart }: { chart: ChartView }) {
  if (chart.state === "none") {
    return (
      <Card data-testid="health-chart" data-state="none" className={GREY}>
        <CardHeader>
          <CardDescription>兩站 24 小時回應時間</CardDescription>
          <CardTitle className="text-muted-foreground">還沒有 Gatus 資料</CardTitle>
          <CardDescription>
            {chart.note}
            {chart.error ? `：${chart.error}` : ""}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }
  return (
    <Card data-testid="health-chart" data-state={chart.state}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          兩站 24 小時回應時間
          {chart.state === "stale" ? (
            <span data-testid="chart-stale" className="text-sm font-normal text-muted-foreground">
              {chart.note}
              {chart.error ? `（${chart.error}）` : ""}
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>Gatus 每 5 分鐘檢查一次兩站首頁。</CardDescription>
      </CardHeader>
      <CardContent>
        <AreaChart series={chart.series} unit="ms" />
      </CardContent>
    </Card>
  )
}

function UptimeTable({ rows }: { rows: UptimeRow[] }) {
  return (
    <Card data-testid="uptime-table">
      <CardHeader>
        <CardTitle>可用率與回應時間</CardTitle>
        <CardDescription>Gatus 兩站端點；24h 是最近 24 小時的檢查點，7d 是 Gatus 算的數字。</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>站</TableHead>
              <TableHead>24h 可用率</TableHead>
              <TableHead>7d 可用率</TableHead>
              <TableHead>24h 平均回應</TableHead>
              <TableHead>24h 失敗次數</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.site} data-testid={`uptime-${r.site}`}>
                <TableCell>{r.label}</TableCell>
                <TableCell className="tabular-nums">{r.uptime24h}</TableCell>
                <TableCell className="tabular-nums">{r.uptime7d}</TableCell>
                <TableCell className="tabular-nums">{r.avgMs24h}</TableCell>
                <TableCell className="tabular-nums">{r.failures24h}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/** Access 四個網址最近一次判定（health.json.accessGuard）：沒登入要被 302 到 Access。 */
function AccessGuard({ rows }: { rows: AccessRow[] | null }) {
  if (!rows) {
    return (
      <Card data-testid="access-guard" data-state="grey" className={GREY}>
        <CardHeader>
          <CardDescription>Access 守門</CardDescription>
          <CardTitle className="text-muted-foreground">還沒有健康資料</CardTitle>
        </CardHeader>
      </Card>
    )
  }
  return (
    <Card data-testid="access-guard">
      <CardHeader>
        <CardTitle>Access 守門</CardTitle>
        <CardDescription>不帶登入打這幾個網址，應該被轉到 Cloudflare Access 登入頁。</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>host</TableHead>
                <TableHead>guarded</TableHead>
                <TableHead>status</TableHead>
                <TableHead>location</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.host} data-testid="access-row" data-guarded={r.guarded ? "true" : "false"}>
                  <TableCell className="font-mono text-xs">{r.host}</TableCell>
                  <TableCell>{r.guarded ? "有" : <Badge variant="destructive">沒有</Badge>}</TableCell>
                  <TableCell className="tabular-nums">{r.status}</TableCell>
                  <TableCell className="max-w-md truncate text-xs" title={r.location}>
                    {r.location}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">還沒有檢查紀錄</p>
        )}
      </CardContent>
    </Card>
  )
}

/** 服務健康（DV 設計方案 §5.1）：兩站健康、Gatus 回應時間與可用率、Access 守門。只讀 health／metrics／collector。 */
export default async function HealthPage() {
  const [health, metrics, collector] = await Promise.all([
    readData("health.json").then(dataOrNull),
    readData("metrics.json").then(dataOrNull),
    readData("collector.json").then(dataOrNull),
  ])
  const view = buildHealthView({ health, metrics, collector }, currentTime())

  return (
    <PageShell title="服務健康">
      {view.sourceNotes.map((note) => (
        <p key={note} data-testid="source-note" className="text-sm text-muted-foreground">
          {note}
        </p>
      ))}

      <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
        {view.sites.map((s) => (
          <SiteCard key={s.site} view={s} />
        ))}
      </div>

      <HealthChart chart={view.chart} />
      <UptimeTable rows={view.uptime} />
      <AccessGuard rows={view.access} />
    </PageShell>
  )
}
