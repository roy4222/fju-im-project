#!/usr/bin/env node
/**
 * 每個路由的 First Load JS（gzip）對預算（共用 SH-0，設計方案 §7.2、§7.4.3）。
 *
 *   pnpm -C web build && pnpm -C web perf:bundle [--budget scripts/perf/budget.json] [--write-baseline] [--dir <web 目錄>]
 *
 * 資料來源：`.next/diagnostics/route-bundle-stats.json`（Next 16.3.8 只在 Turbopack 建置時寫；本專案 `next build`
 * 預設就是 Turbopack，用 `--webpack` 建的沒有這個檔）。每列的 `firstLoadChunkPaths` 是相對專案根目錄（web/）的路徑：
 * 去重、逐檔 gzip（zlib level 9）、加總＝該路由的 First Load JS gz。
 *
 * 判定：每路由 ≤ `limit`；`$shared`（所有路由都載入的 chunk）≤ 它的 `limit`；三角色首頁的 chunk 內容不含
 * `$rules.homeRoutesMustNotContain` 的任何字串。缺 manifest、缺 chunk 檔、預算列的路由不在 manifest、
 * manifest 的路由沒有預算列 → exit 1，不輸出假零值。超過 → exit 1 並列最大 5 個 chunk。
 *
 * `--write-baseline`：用同一算法覆寫每列 `baseline`，`limit = min(ceil(baseline × 1.1), 250)`；
 * baseline 已超過 250 時 `limit = ceil(baseline × 1.1)`（Q106，算法在 `limits.mjs`）。`$shared` 的 limit 固定 230、`$rules` 保留。
 *
 * 預算讀的是「基底 `budget.json` ＋ `budget.d/` 小檔」合併後的結果（D-23 放寬，`scripts/overlay/merge.mjs`）；
 * 小檔撞鍵 → exit 1。`budget.d/` 有小檔時 `--write-baseline` 拒絕執行（先 `pnpm -C web overlay fold budget`）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { WEB_ROOT, fail, parseArgs } from './db.mjs'
import { SHARED_LIMIT_KB, limitFor } from './limits.mjs'
import { OverlayError, hasOverlayFiles, mergeFromBaseFile } from '../overlay/merge.mjs'

const STATS = path.join('.next', 'diagnostics', 'route-bundle-stats.json')
const HOME_ROUTES = ['/dashboard/student', '/dashboard/teacher', '/dashboard/admin']
const DEFAULT_RULES = { homeRoutesMustNotContain: ['recharts'] }

// 相容既有 import：算法搬到 limits.mjs（overlay 合併器也要用，不能經這支把 pg 拉進 e2e）。
export { limitFor }

const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10

/** 讀 manifest，算每個路由的 gz 大小。回 `{ routes: Map<route, {gz, chunks}>, shared, sizes }`。 */
export function measure(webDir) {
  const statsFile = path.join(webDir, STATS)
  if (!fs.existsSync(statsFile)) {
    fail(`找不到 ${statsFile}。先 pnpm -C web build（預設 Turbopack；--webpack 建的沒有這個檔）。`)
  }
  const rows = JSON.parse(fs.readFileSync(statsFile, 'utf8'))
  if (!Array.isArray(rows) || rows.length === 0) fail(`${statsFile} 是空的。`)
  const sizes = new Map()
  const gz = (rel) => {
    if (!sizes.has(rel)) {
      const file = path.resolve(webDir, rel)
      if (!fs.existsSync(file)) fail(`manifest 列的 chunk 不存在：${rel}（build 是不是不完整？）`)
      sizes.set(rel, gzipSync(fs.readFileSync(file), { level: 9 }).length)
    }
    return sizes.get(rel)
  }
  const routes = new Map()
  for (const row of rows) {
    if (row.route.startsWith('/_')) continue // /_not-found、/_global-error 不是使用者會開的頁
    const chunks = [...new Set(row.firstLoadChunkPaths ?? [])]
    if (chunks.length === 0) fail(`${row.route} 沒有 firstLoadChunkPaths。`)
    routes.set(row.route, { gz: chunks.reduce((sum, c) => sum + gz(c), 0), chunks })
  }
  const all = [...routes.values()]
  const shared = all[0].chunks.filter((c) => all.every((r) => r.chunks.includes(c)))
  return { routes, shared: { gz: shared.reduce((s, c) => s + gz(c), 0), chunks: shared }, sizes }
}

function writeBaseline(budgetFile, result) {
  const old = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : {}
  const out = {
    $comment: old.$comment ?? 'perf:bundle 的預算（KB，gzip）。baseline＝c0f32bd 用同一算法實測；limit＝min(ceil(baseline×1.1), 250)（Q106）。新路由加自己的列，不改既有列。',
    $shared: { baseline: kb(result.shared.gz), limit: SHARED_LIMIT_KB },
    $rules: old.$rules ?? DEFAULT_RULES,
  }
  for (const route of [...result.routes.keys()].sort()) {
    const baseline = kb(result.routes.get(route).gz)
    out[route] = { baseline, limit: limitFor(baseline) }
  }
  fs.writeFileSync(budgetFile, `${JSON.stringify(out, null, 2)}\n`)
  console.log(`已寫入 ${budgetFile}（${result.routes.size} 個路由）。`)
}

/** 基底＋小檔合併後的預算；小檔撞鍵就 exit 1。 */
function readBudget(budgetFile) {
  try {
    return mergeFromBaseFile(budgetFile, 'budget').merged
  } catch (e) {
    if (e instanceof OverlayError) fail(e.message)
    throw e
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const webDir = path.resolve(opts.dir ?? WEB_ROOT)
  const budgetFile = path.resolve(opts.budget ?? path.join(import.meta.dirname, 'budget.json'))
  if (opts['write-baseline'] && hasOverlayFiles(budgetFile)) {
    fail(`${path.basename(budgetFile, '.json')}.d/ 還有小檔，--write-baseline 會重寫基底、跟小檔撞鍵。先 pnpm -C web overlay fold budget 再跑。`)
  }
  const result = measure(webDir)
  if (opts['write-baseline']) writeBaseline(budgetFile, result)
  if (!fs.existsSync(budgetFile)) fail(`找不到預算檔 ${budgetFile}。`)
  const budget = readBudget(budgetFile)

  const problems = []
  const lines = []
  const routeKeys = Object.keys(budget).filter((k) => !k.startsWith('$'))
  for (const route of routeKeys) {
    if (!result.routes.has(route)) problems.push({ route, why: '預算列的路由不在 route-bundle-stats.json（缺路由）' })
  }
  for (const [route, { gz, chunks }] of [...result.routes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const row = budget[route]
    const now = kb(gz)
    if (!row) {
      problems.push({ route, why: `沒有預算列（現值 ${now} KB）；在 budget.json 加一列` })
      continue
    }
    const over = now > row.limit
    lines.push(`${route.padEnd(48)} ${String(row.baseline).padStart(8)} ${String(now).padStart(8)} ${String(row.limit).padStart(6)} ${(now - row.baseline >= 0 ? '+' : '') + (Math.round((now - row.baseline) * 10) / 10)}${over ? '  ✗' : ''}`)
    if (over) problems.push({ route, why: `${now} KB > limit ${row.limit} KB`, chunks })
  }
  const shared = kb(result.shared.gz)
  if (budget.$shared && shared > budget.$shared.limit) problems.push({ route: '$shared', why: `${shared} KB > limit ${budget.$shared.limit} KB`, chunks: result.shared.chunks })

  const banned = budget.$rules?.homeRoutesMustNotContain ?? []
  for (const route of HOME_ROUTES) {
    const r = result.routes.get(route)
    if (!r) continue
    for (const chunk of r.chunks) {
      const text = fs.readFileSync(path.resolve(webDir, chunk), 'utf8')
      for (const lib of banned) if (text.includes(lib)) problems.push({ route, why: `首頁 chunk ${chunk} 含「${lib}」` })
    }
  }

  console.log(`perf:bundle  ${path.relative(process.cwd(), path.join(webDir, STATS)) || STATS}`)
  console.log(`${'route'.padEnd(48)} baseline      now  limit  差`)
  for (const l of lines) console.log(l)
  console.log(`${'$shared（每個路由都載入）'.padEnd(44)} ${String(budget.$shared?.baseline ?? '-').padStart(8)} ${String(shared).padStart(8)} ${String(budget.$shared?.limit ?? '-').padStart(6)}`)
  console.log(`首頁不可含：${banned.join('、') || '（無）'}`)

  if (problems.length > 0) {
    for (const p of problems) {
      console.log(`\n✗ ${p.route}：${p.why}`)
      if (p.chunks) {
        const top = [...p.chunks].sort((a, b) => result.sizes.get(b) - result.sizes.get(a)).slice(0, 5)
        for (const c of top) console.log(`    ${String(kb(result.sizes.get(c))).padStart(7)} KB  ${c}`)
      }
    }
    process.exit(1)
  }
  console.log(`\n全部 ${result.routes.size} 個路由都在預算內。`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
