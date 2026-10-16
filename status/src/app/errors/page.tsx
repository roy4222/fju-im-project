import type { Metadata } from "next"

import { PageShell } from "@/components/page-shell"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { dataOrNull, readData } from "@/lib/data/read"
import type { CollectorSourceState, CollectorStatus } from "@/lib/data/types"
import { formatTime } from "@/lib/deploy/view"
import { dozzleRoot, dozzleUrl } from "@/lib/events/containers"
import { buildEvents, ERRORS_LIMIT, EVENT_KIND_LABEL, failureEvents, type StatusEvent } from "@/lib/events/events"

export const metadata: Metadata = { title: "錯誤紀錄" }

/** 「現在」：抽成函式讓頁面本體保持純粹。 */
const currentTime = () => new Date()

/** collector 的五個來源照這個順序排；之後多出來的（DV-12 的 metrics）接在後面。 */
const SOURCE_ORDER = ["github", "repo", "health", "vm", "acceptance"]

function sourceRows(collector: CollectorStatus | null): [string, CollectorSourceState][] {
  const rank = (name: string) => {
    const i = SOURCE_ORDER.indexOf(name)
    return i < 0 ? SOURCE_ORDER.length : i
  }
  return Object.entries(collector?.sources ?? {}).sort(([a], [b]) => rank(a) - rank(b))
}

function SourceTable({ collector }: { collector: CollectorStatus | null }) {
  const rows = sourceRows(collector)
  return (
    <Card data-testid="source-table">
      <CardHeader>
        <CardTitle>收集器來源</CardTitle>
        <CardDescription>
          每 10 分鐘抓一次；失敗時畫面用的是上次成功的資料。
          {collector ? `收集器最後一輪 ${formatTime(collector.generatedAt)}。` : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>來源</TableHead>
                <TableHead>狀態</TableHead>
                <TableHead>最後時間</TableHead>
                <TableHead>錯誤</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(([name, s]) => (
                <TableRow key={name} data-testid="source-row" data-source={name} data-ok={s.ok ? "true" : "false"}>
                  <TableCell>
                    <code className="font-mono text-xs">{name}</code>
                  </TableCell>
                  <TableCell>{s.ok ? "正常" : <Badge variant="destructive">失敗</Badge>}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatTime(s.at)}</TableCell>
                  <TableCell className="break-all">{s.error ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">沒有收集器資料（collector.json 不存在或讀不到）</p>
        )}
      </CardContent>
    </Card>
  )
}

function EventList({ events }: { events: StatusEvent[] }) {
  const logs = dozzleRoot()
  return (
    <Card data-testid="event-list">
      <CardHeader>
        <CardTitle>最近的失敗</CardTitle>
        <CardDescription>最多 {ERRORS_LIMIT} 筆，新到舊；成功的部署、備份與驗收跑完不列。</CardDescription>
      </CardHeader>
      <CardContent>
        {events.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>時間</TableHead>
                <TableHead>類型</TableHead>
                <TableHead>內容</TableHead>
                <TableHead>
                  <span className="sr-only">連結</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e, i) => (
                <TableRow key={`${e.at}-${e.kind}-${i}`} data-testid="event-row" data-kind={e.kind}>
                  <TableCell className="whitespace-nowrap">{formatTime(e.at)}</TableCell>
                  <TableCell className="whitespace-nowrap">{EVENT_KIND_LABEL[e.kind]}</TableCell>
                  <TableCell className="break-all">
                    {/* Dozzle 連結已在右邊那顆鈕；站內頁與 GitHub run 才掛在內容上 */}
                    {e.href && !e.href.startsWith(logs) ? (
                      <a
                        href={e.href}
                        {...(e.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                        className="underline-offset-4 hover:underline"
                      >
                        {e.text}
                      </a>
                    ) : (
                      e.text
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <a
                      href={dozzleUrl(e.container)}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="event-dozzle"
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      Dozzle
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">最近沒有失敗</p>
        )}
      </CardContent>
    </Card>
  )
}

/** 錯誤紀錄（DV 設計方案 §5.3，Q95 簡單版）：只用 collector 已輸出的 JSON 判「哪裡失敗、何時」，一鍵跳 Dozzle。 */
export default async function ErrorsPage() {
  const [collector, health, github, vm, index] = await Promise.all([
    readData("collector.json").then(dataOrNull),
    readData("health.json").then(dataOrNull),
    readData("github.json").then(dataOrNull),
    readData("vm.json").then(dataOrNull),
    readData("acceptance-index.json").then(dataOrNull),
  ])
  const events = failureEvents(buildEvents({ collector, health, github, vm, index }, currentTime()))

  return (
    <PageShell title="錯誤紀錄">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p data-testid="errors-note" className="text-sm text-muted-foreground">
          這頁只看收集器知道的失敗；容器內的錯誤請開 Dozzle 搜。
        </p>
        <a href={dozzleRoot()} target="_blank" rel="noreferrer" data-testid="open-dozzle" className={buttonVariants()}>
          開 Dozzle
        </a>
      </div>
      <SourceTable collector={collector} />
      <EventList events={events} />
    </PageShell>
  )
}
