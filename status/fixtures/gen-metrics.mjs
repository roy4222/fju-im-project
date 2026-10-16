#!/usr/bin/env node
// 產生 fixtures/base/data/metrics.json（DV 設計方案 §7.3 的形狀）：兩站各 288 點（24h、每 5 分鐘一點），
// 時間對齊 base 其他檔的 generatedAt。用固定種子的亂數，重跑結果一模一樣；產物要 commit。
//   node fixtures/gen-metrics.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'base', 'data', 'metrics.json')
const GENERATED_AT = '2026-10-12T09:00:00+08:00'
const POINTS = 288
const STEP_MS = 5 * 60e3

/** mulberry32：小而固定的亂數，只為了讓圖看起來像真的。 */
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 一站的 24h：base 是平常的回應毫秒數；failAt 列出失敗的點（從舊到新的索引）。 */
function site({ seed, base, uptime7d, failAt }) {
  const rand = random(seed)
  const end = new Date(GENERATED_AT).getTime()
  const points = []
  for (let i = 0; i < POINTS; i++) {
    const at = new Date(end - (POINTS - 1 - i) * STEP_MS).toISOString()
    const ok = !failAt.includes(i)
    // 白天（台灣 9～18 點）慢一點，偶爾尖峰。
    const hour = (new Date(at).getUTCHours() + 8) % 24
    const busy = hour >= 9 && hour < 18 ? 40 : 0
    const spike = rand() < 0.03 ? 300 : 0
    const ms = ok ? Math.round(base + busy + spike + rand() * 60) : 3000
    points.push({ at, ms, ok })
  }
  const okCount = points.filter((p) => p.ok).length
  return {
    fetchedAt: GENERATED_AT,
    uptime24h: Math.round((okCount / points.length) * 1e4) / 1e4,
    uptime7d,
    avgMs24h: Math.round(points.reduce((sum, p) => sum + p.ms, 0) / points.length),
    failures24h: points.length - okCount,
    points,
  }
}

const data = {
  generatedAt: GENERATED_AT,
  gatusOk: true,
  error: null,
  sites: {
    test: site({ seed: 1, base: 150, uptime7d: 0.999, failAt: [200] }),
    prod: site({ seed: 2, base: 170, uptime7d: 1, failAt: [] }),
  },
}

// 一點一行，diff 才看得懂。
const text = JSON.stringify(data, null, 2).replace(/\{\s+"at": ("[^"]+"),\s+"ms": (\d+),\s+"ok": (true|false)\s+\}/g, '{ "at": $1, "ms": $2, "ok": $3 }')
fs.writeFileSync(OUT, text + '\n')
console.log(`寫好 ${path.relative(process.cwd(), OUT)}`)
