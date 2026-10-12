import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageShell } from "@/components/page-shell"
import { readData, readSummaryJson } from "@/lib/data/read"
import { shortSha } from "@/lib/data/version"
import { buildSections, buildTestMap, type TestMapView } from "@/lib/map/grid"

import { CellDrawer, MatrixCard, Notice, SectionsCard, StaleBar } from "./map-view"

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/**
 * 測試地圖（設計方案 §3.9、Q27）：最新一次 full 驗收那夜的 summary.json × repo 的 test-map.json。
 * 沒有 summary.json 就整張地圖顯示「最新一夜沒有彙整結果」，不回退到更早的夜。
 */
export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const [testMap, index] = await Promise.all([readData("repo/test-map.json"), readData("acceptance-index.json")])

  if (testMap.status !== "ok") {
    return (
      <PageShell title="測試地圖">
        <Notice testId="map-no-config">
          還沒有測試地圖設定（collector 的 repo/test-map.json{testMap.status === "invalid" ? `：${testMap.error}` : "不存在"}）。
        </Notice>
      </PageShell>
    )
  }

  const runId = index.status === "ok" ? index.data.latestFullAttempt : null
  const run = runId && index.status === "ok" ? index.data.runs.find((r) => r.runId === runId) : undefined
  const summary = runId ? await readSummaryJson(runId) : null
  const view: TestMapView | null = summary?.status === "ok" ? buildTestMap(testMap.data, summary.data) : null
  const sections = buildSections(testMap.data, view)

  const f = one(params.f)
  const r = one(params.r)
  const row = view && f ? view.rows.find((x) => x.feature.key === f) : undefined
  const cell = row && r ? row.cells.find((c) => c.role === r && c.status !== "na") : undefined
  const roleName = cell ? testMap.data.roles.find((x) => x.key === cell.role)?.name ?? cell.role : ""

  return (
    <PageShell title="測試地圖">
      {view ? <StaleBar stale={view.stale} /> : null}

      <Card data-testid="map-run">
        <CardHeader>
          <CardTitle>{runId ? `最新一次完整驗收：${runId}` : "還沒有任何完整驗收"}</CardTitle>
          <CardDescription>
            {run
              ? `測的 commit ${shortSha(run.commitEnd ?? run.commitStart) ?? "不明"}；${run.finishedAt ? `結束於 ${run.finishedAt}` : "還沒結束"}。`
              : runId
                ? ""
                : "Mac mini 跑完一夜 full 驗收、推上來之後這裡才有格子。"}
            測試地圖設定版本 {shortSha(testMap.data.sourceSha) ?? "不明"}。
          </CardDescription>
        </CardHeader>
      </Card>

      {runId && !view ? (
        <Notice testId="map-no-summary">
          最新一夜沒有彙整結果（{runId}
          {summary?.status === "invalid" ? `：summary.json 壞掉，${summary.error}` : "：沒有 summary.json"}）。不回退到更早的夜。
        </Notice>
      ) : null}

      {view ? <MatrixCard view={view} selected={f && r ? { f, r } : null} /> : null}
      <SectionsCard rows={sections} />

      {view && runId && row && cell ? <CellDrawer runId={runId} row={row} cell={cell} roleName={roleName} /> : null}
    </PageShell>
  )
}
