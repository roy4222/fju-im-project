import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { PageShell } from "@/components/page-shell"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/components/utils"
import { readData } from "@/lib/data/read"
import type { UsageReport, UsageRole } from "@/lib/data/types"
import { formatTime } from "@/lib/deploy/view"
import { BarChart } from "@/lib/usage/bar-chart"
import {
  parseRange,
  parseRole,
  RANGES,
  RARE_MAX,
  ROLES,
  summarize,
  TOP_N,
  type RoleFilter,
  type UsageRange,
} from "@/lib/usage/usage"

export const metadata: Metadata = { title: "使用報表" }

const RANGE_LABEL: Record<UsageRange, string> = { "7d": "7 天", "30d": "30 天", term: "本學期" }
const RANGE_DESC: Record<UsageRange, string> = { "7d": "近 7 天", "30d": "近 30 天", term: "本學期" }
const ROLE_LABEL: Record<RoleFilter, string> = { all: "全部", student: "學生", teacher: "老師", admin: "系辦" }
const ROLE_BADGE: Record<UsageRole, string> = {
  student: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  teacher: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  admin: "bg-muted text-foreground",
}

/** 分段鈕與角色 chips 都是 `<a href="?range=…&role=…">`：Server Component 讀 searchParams，不用 client state（§8.4）。 */
const href = (range: UsageRange, role: RoleFilter) => (role === "all" ? `?range=${range}` : `?range=${range}&role=${role}`)

const LINK_BASE = "inline-flex h-8 items-center px-3 text-sm transition-colors"

function RangeTabs({ range, role }: { range: UsageRange; role: RoleFilter }) {
  return (
    <nav aria-label="統計範圍" data-testid="usage-range" className="inline-flex overflow-hidden rounded-md border">
      {RANGES.map((r) => (
        <a
          key={r}
          href={href(r, role)}
          aria-current={r === range ? "page" : undefined}
          className={cn(
            LINK_BASE,
            "border-l first:border-l-0",
            r === range ? "bg-primary text-primary-foreground" : "hover:bg-muted",
          )}
        >
          {RANGE_LABEL[r]}
        </a>
      ))}
    </nav>
  )
}

function RoleChips({ range, role }: { range: UsageRange; role: RoleFilter }) {
  return (
    <nav aria-label="角色" data-testid="usage-role" className="flex flex-wrap gap-2">
      {(["all", ...ROLES] as const).map((r) => (
        <a
          key={r}
          href={href(range, r)}
          aria-current={r === role ? "page" : undefined}
          className={cn(
            LINK_BASE,
            "rounded-full border",
            r === role ? "border-primary bg-primary/10 font-medium" : "text-muted-foreground hover:bg-muted",
          )}
        >
          {ROLE_LABEL[r]}
        </a>
      ))}
    </nav>
  )
}

function ActiveUsersCard({ role, value }: { role: UsageRole; value: number | null }) {
  return (
    <Card data-testid={`active-users-${role}`}>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          每日活躍人數
          <Badge variant="outline" className={cn("border-transparent", ROLE_BADGE[role])}>
            {ROLE_LABEL[role]}
          </Badge>
        </CardDescription>
        <CardTitle data-testid="active-users-value" className="text-3xl tabular-nums">
          {value === null ? "—" : value.toLocaleString("en-US")}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">日均人數</CardContent>
    </Card>
  )
}

function Report({ report, range, role }: { report: UsageReport; range: UsageRange; role: RoleFilter }) {
  const summary = summarize(report, range, role)
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <RangeTabs range={range} role={role} />
        <RoleChips range={range} role={role} />
        <p data-testid="usage-window" className="ml-auto text-sm text-muted-foreground tabular-nums">
          {summary.from} — {summary.to}
        </p>
      </div>

      <div data-testid="active-users" className="grid grid-cols-1 gap-4 @xl/main:grid-cols-3">
        {ROLES.map((r) => (
          <ActiveUsersCard key={r} role={r} value={summary.activeUsers[r]} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 @5xl/main:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>各功能使用次數</CardTitle>
            <CardDescription>
              {RANGE_DESC[range]}・{ROLE_LABEL[role]}・前 {TOP_N} 名
            </CardDescription>
          </CardHeader>
          <CardContent>
            {summary.bars.length === 0 ? (
              <p className="text-sm text-muted-foreground">這個範圍沒有任何使用紀錄。</p>
            ) : (
              <BarChart items={summary.bars} label={`各功能使用次數（${RANGE_DESC[range]}）`} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>很少用的功能</CardTitle>
            <CardDescription>{RANGE_DESC[range]}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <table data-testid="rare-features" className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 font-normal">功能</th>
                  <th className="py-2 text-right font-normal">次數</th>
                </tr>
              </thead>
              <tbody>
                {summary.rare.map((c) => (
                  <tr key={c.action} data-action={c.action} className="border-b last:border-b-0">
                    <td className="py-2" title={c.action}>
                      {c.label}
                    </td>
                    <td className="py-2 text-right tabular-nums">{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground">
              {summary.rare.length === 0 ? "沒有很少用的功能。" : `只列這個範圍內用了 ${RARE_MAX} 次以下的功能。`}
            </p>
          </CardContent>
        </Card>
      </div>

      <p data-testid="usage-footer" className="text-sm text-muted-foreground">
        統計範圍：已登入使用者・每日去重
        {report.generatedAt ? (
          <>
            ・資料時間 <time dateTime={report.generatedAt}>{formatTime(report.generatedAt)}</time>
          </>
        ) : null}
      </p>
    </>
  )
}

const isReport = (data: UsageReport) =>
  Array.isArray(data.daily) && Array.isArray(data.actions) && typeof data.window?.to === "string"

/**
 * 使用報表（DV 設計方案 §7.5；AC-DV-23、24）：只讀 usage.json 一個檔（§8.3）。
 * 正式站開通前檔案不存在 → 404（側欄也不顯示，Q96）。
 */
export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const result = await readData("usage.json")
  if (result.status === "missing") notFound()
  const params = await searchParams
  const range = parseRange(params.range)
  const role = parseRole(params.role)

  return (
    <PageShell title="使用報表">
      {result.status === "ok" && isReport(result.data) ? (
        <Report report={result.data} range={range} role={role} />
      ) : (
        <p data-testid="usage-invalid" className="text-sm text-muted-foreground">
          usage.json 讀不懂{result.status === "invalid" ? `（${result.error}）` : "（缺 daily、actions 或 window）"}
          ，等 collector 下一輪。
        </p>
      )}
    </PageShell>
  )
}
