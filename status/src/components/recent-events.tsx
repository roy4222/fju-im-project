import Link from "next/link"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/components/utils"
import { formatTime } from "@/lib/deploy/view"
import { EVENT_KIND_LABEL, type StatusEvent } from "@/lib/events/events"

const LINK_LABEL: Record<StatusEvent["kind"], string> = {
  deploy: "部署與 CI",
  backup: "備份與儲存",
  "source-fail": "Dozzle",
  "health-fail": "Dozzle",
  "ci-fail": "GitHub",
  "image-fail": "GitHub",
  "acceptance-run": "驗收地圖",
}

function EventLink({ e }: { e: StatusEvent }) {
  if (!e.href) return <span className="text-muted-foreground">—</span>
  const className = "text-primary underline-offset-4 hover:underline"
  if (e.href.startsWith("/")) {
    return (
      <Link href={e.href} className={className}>
        {LINK_LABEL[e.kind]}
      </Link>
    )
  }
  return (
    <a href={e.href} target="_blank" rel="noreferrer" className={className}>
      {LINK_LABEL[e.kind]}
    </a>
  )
}

/** 總覽「最近事件」（DV 設計方案 §4.5）：最近幾筆，完整清單在錯誤紀錄頁。 */
export function RecentEvents({ events }: { events: StatusEvent[] }) {
  return (
    <Card data-testid="recent-events">
      <CardHeader>
        <CardTitle>最近事件</CardTitle>
        <CardDescription>部署、備份、收集器來源、健康檢查、CI、映像、驗收；新到舊。</CardDescription>
      </CardHeader>
      <CardContent>
        {events.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>時間</TableHead>
                <TableHead>類型</TableHead>
                <TableHead>內容</TableHead>
                <TableHead>連結</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e, i) => (
                <TableRow key={i} data-testid="event-row" data-kind={e.kind} data-level={e.level}>
                  <TableCell className="whitespace-nowrap tabular-nums">{formatTime(e.at)}</TableCell>
                  <TableCell className={cn("whitespace-nowrap", e.level === "error" && "text-red-700 dark:text-red-400")}>
                    {EVENT_KIND_LABEL[e.kind]}
                  </TableCell>
                  <TableCell className="whitespace-normal">{e.text}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <EventLink e={e} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">最近沒有事件</p>
        )}
      </CardContent>
    </Card>
  )
}
