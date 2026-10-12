import { PageShell } from "@/components/page-shell"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/components/utils"
import { dataOrNull, readData } from "@/lib/data/read"
import type { TicketStatus } from "@/lib/data/types"
import { shortSha } from "@/lib/data/version"
import { REPO_URL, buildProgress, type BatchSection, type ProgressView } from "@/lib/progress/progress"

const STATUS_COLOR: Record<TicketStatus, string> = {
  todo: "bg-muted text-muted-foreground",
  doing: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  review: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  merged: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  blocked: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  dropped: "bg-zinc-200 text-zinc-600 line-through dark:bg-zinc-800 dark:text-zinc-400",
}

function Summary({ view }: { view: ProgressView }) {
  return (
    <Card data-testid="progress-summary">
      <CardHeader>
        <CardTitle>共 {view.total} 張票</CardTitle>
        <CardDescription>
          票清單最後更新 {view.updatedAt ?? "沒有資料"}；來源{" "}
          {view.sourceSha ? (
            <a href={`${REPO_URL}/commit/${view.sourceSha}`} className="font-mono underline-offset-4 hover:underline" data-testid="tickets-source-sha">
              {shortSha(view.sourceSha)}
            </a>
          ) : (
            "沒有資料"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {view.counts.map((c) => (
          <span key={c.status} data-testid={`count-${c.status}`} className={cn("rounded-md px-2 py-1 text-sm", STATUS_COLOR[c.status])}>
            {`${c.label} ${c.count}`}
          </span>
        ))}
      </CardContent>
    </Card>
  )
}

function BatchTable({ section }: { section: BatchSection }) {
  return (
    <Card data-testid={`batch-${section.id}`}>
      <CardHeader>
        <CardTitle>{section.name}</CardTitle>
        {section.plan ? <CardDescription className="font-mono text-xs">{section.plan}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>票號</TableHead>
              <TableHead>票名</TableHead>
              <TableHead className="hidden md:table-cell">波次</TableHead>
              <TableHead>狀態</TableHead>
              <TableHead>PR</TableHead>
              <TableHead className="hidden lg:table-cell">相依</TableHead>
              <TableHead className="hidden lg:table-cell">備註</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {section.rows.map(({ ticket: t, statusLabel, pr, mismatch }) => (
              <TableRow
                key={t.id}
                data-testid={`ticket-${t.id}`}
                data-mismatch={mismatch ? "true" : "false"}
                className={mismatch ? "bg-yellow-100 hover:bg-yellow-100 dark:bg-yellow-950/50" : undefined}
              >
                <TableCell className="font-mono text-xs">{t.id}</TableCell>
                <TableCell className="whitespace-normal">
                  {t.title}
                  {mismatch ? <div className="text-xs font-medium text-yellow-800 dark:text-yellow-200">{mismatch}</div> : null}
                </TableCell>
                <TableCell className="hidden md:table-cell">{t.wave}</TableCell>
                <TableCell>
                  <span className={cn("rounded-md px-2 py-0.5 text-xs", STATUS_COLOR[t.status] ?? "")}>{statusLabel}</span>
                </TableCell>
                <TableCell>
                  {pr ? (
                    <a href={pr.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                      #{pr.number} <span className="text-xs text-muted-foreground">{pr.label}</span>
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell font-mono text-xs">{t.dependsOn.join("、") || "—"}</TableCell>
                <TableCell className="hidden lg:table-cell whitespace-normal text-xs">{t.note || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function SideCards({ view, ci }: { view: ProgressView; ci: { url: string; conclusion: string | null; headSha: string } | null }) {
  return (
    <div className="flex flex-col gap-4">
      <Card data-testid="main-ci">
        <CardHeader>
          <CardDescription>main 最新 CI</CardDescription>
          <CardTitle>
            {ci ? (
              <a href={ci.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                {shortSha(ci.headSha)}：{ci.conclusion ?? "還在跑"}
              </a>
            ) : (
              "沒有資料"
            )}
          </CardTitle>
          <CardDescription>Playwright 報告在這次執行的 artifact 裡。</CardDescription>
        </CardHeader>
      </Card>
      <Card data-testid="recent-merged">
        <CardHeader>
          <CardDescription>最近 5 個合併的 PR</CardDescription>
        </CardHeader>
        <CardContent>
          {view.recentMerged.length ? (
            <ul className="flex flex-col gap-1 text-sm">
              {view.recentMerged.map((p) => (
                <li key={p.number}>
                  <a href={p.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                    #{p.number}
                  </a>{" "}
                  <span className="font-mono text-xs text-muted-foreground">{p.headRef}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">沒有資料</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** 開發進度（設計方案 §3.10）：票清單依批次分區，跟 GitHub 對不上的列標黃。 */
export default async function ProgressPage() {
  const [tickets, github] = await Promise.all([
    readData("repo/tickets.json").then(dataOrNull),
    readData("github.json").then(dataOrNull),
  ])
  const view = buildProgress(tickets, github)
  return (
    <PageShell title="開發進度">
      <Summary view={view} />
      <div className="grid grid-cols-1 gap-4 @5xl/main:grid-cols-[1fr_18rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {view.sections.length ? (
            view.sections.map((s) => <BatchTable key={s.id} section={s} />)
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>還沒有票清單資料</CardTitle>
                <CardDescription>收集器還沒抓到 docs/status/tickets.json，或檔案壞掉。</CardDescription>
              </CardHeader>
            </Card>
          )}
        </div>
        <SideCards view={view} ci={github?.ci ?? null} />
      </div>
      {view.sections.some((s) => s.rows.some((r) => r.mismatch)) ? (
        <p className="text-sm text-muted-foreground">
          <Badge variant="outline">提醒</Badge> 黃底的列是票清單跟 GitHub 對不上，請主腦更新 docs/status/tickets.json；這頁不會自動改檔。
        </p>
      ) : null}
    </PageShell>
  )
}
