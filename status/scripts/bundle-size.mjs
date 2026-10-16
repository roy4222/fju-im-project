#!/usr/bin/env node
/**
 * 前端 JS 預算（DV 設計方案 §8.2、§8.6；AC-DV-29）。先 `pnpm --ignore-workspace run build` 再跑：
 *
 *   node scripts/bundle-size.mjs
 *
 * 讀 `.next/diagnostics/route-bundle-stats.json`（Turbopack build 才有）：每個受驗路由的
 * `firstLoadChunkPaths` 去重成集合；共用＝所有受驗路由集合的交集；專屬＝該路由集合減共用。
 * 三個數字都是集合內逐檔 gzip（zlib 預設等級）後加總，1 KB = 1024 bytes（跟 §8.1 的基準 202.6 KB 同一個量法）。
 * 共用 > 230 KB、任一路由專屬 > 30 KB 或總量 > 260 KB 就 exit 1；統計檔不存在或少了受驗路由也 exit 1。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const STATS = path.join(root, '.next', 'diagnostics', 'route-bundle-stats.json')

/** 受驗 UI 路由。`/usage` 在 DV-7 合併後才有頁面，有才量；`/shots/*`、`/healthz` 不是頁面，不量。 */
const REQUIRED = ['/', '/health', '/deploy', '/errors', '/backup', '/go-live', '/progress', '/map']
const OPTIONAL = ['/usage']

const LIMIT = { shared: 230, exclusive: 30, total: 260 }

const kb = (bytes) => bytes / 1024
const fmt = (bytes) => `${kb(bytes).toFixed(1)} KB`

let stats
try {
  stats = JSON.parse(readFileSync(STATS, 'utf8'))
} catch (err) {
  console.error(`讀不到 ${path.relative(root, STATS)}（要先跑 pnpm --ignore-workspace run build）：${err.message}`)
  process.exit(1)
}

const byRoute = new Map(stats.map((r) => [r.route, new Set(r.firstLoadChunkPaths)]))
const missing = REQUIRED.filter((r) => !byRoute.has(r))
if (missing.length > 0) {
  console.error(`route-bundle-stats.json 少了受驗路由：${missing.join('、')}`)
  process.exit(1)
}
const routes = [...REQUIRED, ...OPTIONAL.filter((r) => byRoute.has(r))]

const sizeCache = new Map()
const gzSize = (chunk) => {
  if (!sizeCache.has(chunk)) sizeCache.set(chunk, gzipSync(readFileSync(path.join(root, chunk))).length)
  return sizeCache.get(chunk)
}
const sum = (chunks) => [...chunks].reduce((n, c) => n + gzSize(c), 0)

const shared = new Set([...byRoute.get(routes[0])].filter((c) => routes.every((r) => byRoute.get(r).has(c))))
const sharedBytes = sum(shared)

const failures = []
if (kb(sharedBytes) > LIMIT.shared) failures.push(`共用 ${fmt(sharedBytes)} > ${LIMIT.shared} KB`)

console.log(`共用 gz：${fmt(sharedBytes)}（${shared.size} 檔；門檻 ${LIMIT.shared} KB）`)
console.log(`路由\t專屬增量 gz\tFirst Load 總量 gz（門檻：專屬 ${LIMIT.exclusive} KB、總量 ${LIMIT.total} KB）`)
for (const route of routes) {
  const exclusive = [...byRoute.get(route)].filter((c) => !shared.has(c))
  const exclusiveBytes = sum(exclusive)
  const totalBytes = sharedBytes + exclusiveBytes
  console.log(`${route}\t${fmt(exclusiveBytes)}\t${fmt(totalBytes)}`)
  if (kb(exclusiveBytes) > LIMIT.exclusive) failures.push(`${route} 專屬 ${fmt(exclusiveBytes)} > ${LIMIT.exclusive} KB`)
  if (kb(totalBytes) > LIMIT.total) failures.push(`${route} 總量 ${fmt(totalBytes)} > ${LIMIT.total} KB`)
}

if (failures.length > 0) {
  console.error(`超過預算：\n${failures.map((f) => `- ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('全部在預算內。')
