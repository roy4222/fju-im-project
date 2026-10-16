import type { Metadata } from "next"

import { PageShell } from "@/components/page-shell"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/components/utils"
import { VersionCard } from "@/components/version-card"
import { dataOrNull, readData } from "@/lib/data/read"
import { shortSha } from "@/lib/data/version"
import {
  buildDeployView,
  DEPLOYS_PER_SITE,
  formatTime,
  type DeployRow,
  type HealthCronView,
  type RunState,
  type RunView,
} from "@/lib/deploy/view"

export const metadata: Metadata = { title: "部署與 CI" }

const STATE_CLASS: Record<RunState, string> = {
  green: "border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/40",
  red: "border-red-500/40 bg-red-50 dark:bg-red-950/40",
  grey: "border-border bg-muted/60",
}

const LINK = "underline-offset-4 hover:underline"

/** 「現在」：算多久前用。抽成函式讓頁面本體保持純粹。 */
const currentTime = () => new Date()

function NoData({ testId, title, text }: { testId: string; title: string; text: string }) {
  return (
    <Card data-testid={testId} data-state="grey" className={cn("border", STATE_CLASS.grey)}>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-muted-foreground">{text}</CardTitle>
      </CardHeader>
    </Card>
  )
}

/** main 最新 CI（正本，§2）：結論、headSha、多久前、連結、jobs；失敗時列出失敗的 job。 */
function CiCard({ run, age }: { run: RunView | null; age: string | null }) {
  if (!run) return <NoData testId="ci-main" title="main 最新 CI" text="還沒有 CI 紀錄" />
  return (
    <Card data-testid="ci-main" data-state={run.state} className={cn("border", STATE_CLASS[run.state])}>
      <CardHeader>
        <CardDescription>main 最新 CI</CardDescription>
        <CardTitle>
          <a href={run.url} target="_blank" rel="noreferrer" className={LINK}>
            <code className="font-mono" title={run.headSha}>{shortSha(run.headSha)}</code>：{run.label}
          </a>
        </CardTitle>
        <CardDescription>
          {age ? `收集器 ${age}抓到的結果。` : null}Playwright 報告在這次執行的 artifact 裡。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {run.failedJobs.length ? (
          <p data-testid="ci-failed-jobs" className="font-medium text-red-700 dark:text-red-400">
            沒過的 job：{run.failedJobs.join("、")}
          </p>
        ) : null}
        <ul className="flex flex-wrap gap-1.5">
          {run.jobs.map((j) => (
            <li key={j.name}>
              <Badge variant={j.conclusion === "success" || j.conclusion === "skipped" ? "outline" : "destructive"}>
                {j.name}：{j.conclusion ?? "還在跑"}
              </Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function ImageCard({ run }: { run: RunView | null }) {
  if (!run) return <NoData testId="image-push" title="映像 push" text="還沒有紀錄" />
  return (
    <Card data-testid="image-push" data-state={run.state} className={cn("border", STATE_CLASS[run.state])}>
      <CardHeader>
        <CardDescription>映像 push</CardDescription>
        <CardTitle>
          <a href={run.url} target="_blank" rel="noreferrer" className={LINK}>
            <code className="font-mono" title={run.headSha}>{shortSha(run.headSha)}</code>：{run.label}
          </a>
        </CardTitle>
        {run.failedJobs.length ? <CardDescription>沒過的 job：{run.failedJobs.join("、")}</CardDescription> : null}
      </CardHeader>
    </Card>
  )
}

function HealthCronCard({ cron }: { cron: HealthCronView | null }) {
  if (!cron) return <NoData testId="health-cron" title="健康檢查 cron" text="還沒有紀錄" />
  return (
    <Card data-testid="health-cron" data-state={cron.state} className={cn("border", STATE_CLASS[cron.state])}>
      <CardHeader>
        <CardDescription>健康檢查 cron</CardDescription>
        <CardTitle>
          <a href={cron.url} target="_blank" rel="noreferrer" className={LINK}>
            {cron.label}
          </a>
        </CardTitle>
        <CardDescription>
          最後一次 {formatTime(cron.at)}
          {cron.age ? `（${cron.age}）` : ""}
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

const SITE_LABEL = { test: "測試站", prod: "正式站" } as const

function DeploysCard({ site, rows }: { site: "test" | "prod"; rows: DeployRow[] }) {
  return (
    <Card data-testid={`deploys-${site}`}>
      <CardHeader>
        <CardTitle>{SITE_LABEL[site]}部署</CardTitle>
        <CardDescription>最近 {DEPLOYS_PER_SITE} 筆，新到舊（deploy_log）。</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>時間</TableHead>
                <TableHead>tag</TableHead>
                <TableHead>digest</TableHead>
                <TableHead>結果</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={`${r.at}-${i}`} data-testid="deploy-row" data-ok={r.ok ? "true" : "false"}>
                  <TableCell className="whitespace-nowrap">{formatTime(r.at)}</TableCell>
                  <TableCell className="break-all">
                    {r.tag ? (
                      <code className="font-mono text-xs" title={r.tag}>
                        {r.tagShort}
                      </code>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {r.digest ? (
                      <code className="font-mono text-xs" title={r.digest}>
                        {r.digest.slice(0, 19)}…
                      </code>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {r.ok ? r.result : <Badge variant="destructive" title={r.event}>{r.result}</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">還沒有部署紀錄</p>
        )}
      </CardContent>
    </Card>
  )
}

/** 部署與 CI（DV 設計方案 §5.2）：版本卡與 main CI 詳情的正本；部署紀錄兩站各最近 5 筆。 */
export default async function DeployPage() {
  const [github, vm, health] = await Promise.all([
    readData("github.json").then(dataOrNull),
    readData("vm.json").then(dataOrNull),
    readData("health.json").then(dataOrNull),
  ])
  const view = buildDeployView({ github, vm, health }, currentTime())

  return (
    <PageShell title="部署與 CI">
      <VersionCard rows={view.versionRows} generatedAt={view.githubAt} />

      <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
        <div className="@3xl/main:col-span-2">
          <CiCard run={view.ci} age={view.githubAge} />
        </div>
        <ImageCard run={view.image} />
        <HealthCronCard cron={view.healthCron} />
      </div>

      <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
        <DeploysCard site="test" rows={view.deploys.test} />
        <DeploysCard site="prod" rows={view.deploys.prod} />
      </div>
    </PageShell>
  )
}
