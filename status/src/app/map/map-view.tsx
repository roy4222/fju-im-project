import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/components/utils"
import type { TestMapFile } from "@/lib/data/types"
import type { CellStatus, MapCell, MapRow, SectionRow, StaleRef, TestMapView } from "@/lib/map/grid"
import { BLOCKING_SEVERITIES } from "@/lib/map/grid"
import { repoFileUrl, shotUrl } from "@/lib/map/links"

const STATUS_TEXT: Record<CellStatus, { icon: string; label: string; className: string }> = {
  ok: { icon: "✅", label: "有點過", className: "bg-green-50 dark:bg-green-950/40" },
  warn: { icon: "⚠️", label: "有狀況", className: "bg-yellow-50 dark:bg-yellow-950/40" },
  "parse-failed": { icon: "⚠️", label: "報告解析失敗", className: "bg-orange-100 dark:bg-orange-950/50" },
  untested: { icon: "⬜", label: "沒測到", className: "" },
  na: { icon: "—", label: "不適用", className: "text-muted-foreground" },
}

export const cellHref = (feature: string, role: string) =>
  `/map?f=${encodeURIComponent(feature)}&r=${encodeURIComponent(role)}`

function StatusMark({ status }: { status: CellStatus | null }) {
  if (status === null) return <span className="text-muted-foreground">沒有結果</span>
  const s = STATUS_TEXT[status]
  return (
    <span className="whitespace-nowrap">
      {s.icon} {s.label}
    </span>
  )
}

/** 一句話的狀態提示（沒有地圖、沒有完整驗收、沒有彙整結果…）。 */
export function Notice({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <Card data-testid={testId}>
      <CardContent className="text-sm">{children}</CardContent>
    </Card>
  )
}

/** 頁頂黃條：測試地圖指到該夜不存在的步驟。 */
export function StaleBar({ stale }: { stale: StaleRef[] }) {
  if (stale.length === 0) return null
  return (
    <div
      data-testid="map-stale"
      className="rounded-lg border border-yellow-300 bg-yellow-100 px-4 py-3 text-sm text-yellow-950 dark:border-yellow-800 dark:bg-yellow-950/60 dark:text-yellow-100"
    >
      驗收地圖指到不存在的步驟：{stale.map((s) => `${s.item} 第 ${s.step} 步`).join("、")}。請更新 docs/status/test-map.json。
    </div>
  )
}

/** 第一張表：角色 × 功能。 */
export function MatrixCard({ view, selected }: { view: TestMapView; selected: { f: string; r: string } | null }) {
  return (
    <Card data-testid="map-matrix">
      <CardHeader>
        <CardTitle>角色 × 功能</CardTitle>
        <CardDescription>
          {[
            "✅ 有點過（每一步都通過、沒有擋上線／要修）",
            "⚠️ 有狀況",
            "⚠️ 報告解析失敗（問題清單不可信）",
            "⬜ 沒測到",
            "— 不適用",
          ].join("　")}
          。點格子看每一步與截圖。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>功能</TableHead>
              {view.roles.map((r) => (
                <TableHead key={r.key}>{r.name}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.rows.map((row) => (
              <TableRow key={row.feature.key} data-testid={`feature-${row.feature.key}`}>
                <TableCell className="font-medium">{row.feature.name}</TableCell>
                {row.cells.map((cell) => (
                  <MatrixCell
                    key={cell.role}
                    feature={row.feature.key}
                    cell={cell}
                    active={selected?.f === row.feature.key && selected.r === cell.role}
                  />
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {view.unknownRoles.length > 0 ? (
          <p data-testid="map-unknown-roles" className="mt-3 text-xs text-muted-foreground">
            認不得的角色（test-map.json 的 aliases 沒有，這些步驟沒算進任何格）：{view.unknownRoles.map((r) => `「${r}」`).join("、")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function MatrixCell({ feature, cell, active }: { feature: string; cell: MapCell; active: boolean }) {
  const s = STATUS_TEXT[cell.status]
  const common = { "data-testid": `cell-${feature}-${cell.role}`, "data-status": cell.status }
  if (cell.status === "na") {
    return (
      <TableCell {...common} className={s.className}>
        —
      </TableCell>
    )
  }
  return (
    <TableCell {...common} className={cn(s.className, active && "ring-2 ring-primary ring-inset")}>
      <Link href={cellHref(feature, cell.role)} scroll={false} className="block underline-offset-4 hover:underline">
        <StatusMark status={cell.status} />
      </Link>
    </TableCell>
  )
}

const CRUD_LABEL = [
  ["create", "新增"],
  ["edit", "編輯"],
  ["delete", "刪除"],
] as const

/** 第二張表：前台每一區對應的管理後台（Q27）。 */
export function SectionsCard({ rows }: { rows: SectionRow[] }) {
  return (
    <Card data-testid="map-sections">
      <CardHeader>
        <CardTitle>前台每一區</CardTitle>
        <CardDescription>
          前台每一區由哪個管理後台頁維護、後台能不能新增／編輯／刪除、前後台各有沒有測過。紅底＝前台有這區但沒有後台。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>前台區</TableHead>
              <TableHead>管理後台頁</TableHead>
              <TableHead>後台能做</TableHead>
              <TableHead>前台測過</TableHead>
              <TableHead>後台測過</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.section.key}
                data-testid={`section-${row.section.key}`}
                data-missing-admin={row.missingAdmin ? "true" : "false"}
                className={row.missingAdmin ? "bg-red-100 hover:bg-red-100 dark:bg-red-950/50" : undefined}
              >
                <TableCell>
                  <div className="font-medium">{row.section.name}</div>
                  <code className="text-xs text-muted-foreground">{row.section.page}</code>
                </TableCell>
                <TableCell>
                  {row.adminUrl ? (
                    <a href={row.adminUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                      {row.section.adminPage}
                    </a>
                  ) : row.section.exception ? (
                    <span data-testid="section-exception">例外：{row.section.exception}</span>
                  ) : (
                    <span className="font-medium text-red-700 dark:text-red-300">Q12：前台有這區但沒有後台</span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {row.section.crud
                    ? CRUD_LABEL.map(([k, label]) => `${label}：${row.section.crud![k]}`).join("　")
                    : "—"}
                </TableCell>
                <TableCell>
                  <StatusMark status={row.front} />
                </TableCell>
                <TableCell>{row.section.adminFeature ? <StatusMark status={row.admin} /> : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/**
 * 點格子後的右側抽屜。伺服器依網址 `?f=&r=` 畫出來，不需要 JavaScript；關閉就是回 `/map`。
 */
export function CellDrawer({
  runId,
  row,
  cell,
  roleName,
}: {
  runId: string
  row: MapRow
  cell: MapCell
  roleName: TestMapFile["roles"][number]["name"]
}) {
  const s = STATUS_TEXT[cell.status]
  const failed = new Set(cell.parseFailures.map((f) => f.item))
  return (
    <>
      <Link href="/map" scroll={false} aria-label="關閉" className="fixed inset-0 z-40 bg-black/20" />
      <aside
        data-testid="cell-drawer"
        role="dialog"
        aria-label={`${row.feature.name} × ${roleName}`}
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col gap-4 overflow-y-auto border-l bg-background p-4 shadow-lg sm:max-w-md"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">
              {row.feature.name} × {roleName}
            </h2>
            <p className="text-sm">
              {s.icon} {s.label}
            </p>
          </div>
          <Link href="/map" scroll={false} className="text-sm underline underline-offset-4">
            關閉
          </Link>
        </div>

        {cell.parseFailures.map((f) => (
          <div
            key={f.item}
            data-testid="drawer-parse-failed"
            className="rounded-md border border-orange-300 bg-orange-100 px-3 py-2 text-sm text-orange-950 dark:border-orange-800 dark:bg-orange-950/60 dark:text-orange-100"
          >
            {f.item} 報告解析失敗：{f.errors.join("；")}
            <div className="text-xs">下面的步驟照列，但這個 item 的問題清單不可信（解析失敗時問題表是空的）。</div>
          </div>
        ))}

        {cell.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">這一夜沒有這個角色在這個功能的步驟。</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {cell.steps.map((st) => (
              <li key={`${st.item}#${st.stepNo}`} data-testid="drawer-step" className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {st.item} 第 {st.stepNo} 步
                  </span>
                  <Badge variant={st.step.結果 === "通過" ? "secondary" : "destructive"}>{st.step.結果}</Badge>
                </div>
                <div className="text-muted-foreground">{st.step.步驟}</div>
                <div className="mt-1">看到什麼：{st.step.看到什麼}</div>
                {st.step.截圖.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {st.step.截圖.map((shot) => (
                      <a key={shot} href={shotUrl(runId, shot)} target="_blank" rel="noreferrer" data-testid="drawer-shot">
                        {/* 截圖走 /shots 路由（Access 後面）；不經 next/image 最佳化，免得伺服器自己去抓又被擋。 */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={shotUrl(runId, shot)}
                          alt={`${st.item} 第 ${st.stepNo} 步截圖`}
                          loading="lazy"
                          className="h-20 w-32 rounded border object-cover"
                        />
                      </a>
                    ))}
                  </div>
                ) : null}
                {failed.has(st.item) ? (
                  <div className="mt-2 text-xs text-orange-800 dark:text-orange-200">問題清單不可信</div>
                ) : st.problems.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1 text-xs">
                    {st.problems.map((p) => (
                      <li key={p.編號} data-testid="drawer-problem">
                        <Badge variant={BLOCKING_SEVERITIES.includes(p.嚴重度) ? "destructive" : "outline"}>{p.嚴重度}</Badge>{" "}
                        {p.編號} {p.一句話}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}

        <div className="text-sm">
          <div className="font-medium">自動測試</div>
          {row.feature.e2e.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {row.feature.e2e.map((file) => (
                <li key={file}>
                  <a href={repoFileUrl(file)} target="_blank" rel="noreferrer" data-testid="drawer-e2e" className="font-mono text-xs underline underline-offset-4">
                    {file}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">這個功能還沒有對應的自動測試。</p>
          )}
        </div>
      </aside>
    </>
  )
}
