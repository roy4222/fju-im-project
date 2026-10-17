#!/usr/bin/env node
/**
 * 實驗室版 Web Vitals（共用 SH-0，設計方案 §7.2、§7.4.4）。
 *
 *   PERF_PASSWORD=… pnpm -C web perf:lab --base http://localhost:3399 --as teacher [--routes /dashboard/teacher] [--runs 5] [--json out.json]
 *
 * Playwright Chromium、CDP `Emulation.setCPUThrottlingRate(4)`；`--as` 的固定帳號（`/api/auth/sign-in/email` 取 cookie）。
 * 量 `lab-routes.json` 裡 `as` 相同的路由：每路由先暖機 1 次、再量 N 次（每次新 context＝冷快取），取 p75。
 *
 * 量法只用瀏覽器原生 `PerformanceObserver`（`addInitScript` 注入，不加依賴、不進產品 bundle）：
 *   - LCP：`largest-contentful-paint` 最後一筆；TTFB：navigation timing 的 `responseStart`。
 *   - INP（兩個數）：照 `actions` 點側欄連結——click 事件時長（Event Timing，`durationThreshold: 16`；
 *     短於 16 ms 不會有 click 紀錄，改取 `first-input` 那筆的時長）與「點下去到新頁的 `main h1` 出現」。
 *   - CLS：`layout-shift`（排除使用者輸入後 500 ms 內的）加總。
 * 量不到的格印 `N/A` 並 exit 1。不進 CI；不同機器的數字不能直接比，PR 附本機結果與 §7.2 目標並列。
 */
/* global URL, window, document, location, performance, PerformanceObserver */ // （window 等是 addInitScript／evaluate 在瀏覽器裡用的）
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { fail, parseArgs } from './db.mjs'
import { resolveAs, signIn } from './accounts.mjs'

const HERE = import.meta.dirname
const VIEWPORT = { width: 1280, height: 800 }
export const TARGETS = { lcp: 1000, clickMs: 100, navMs: 300, cls: 0.05, ttfb: 100 }

export const OBSERVERS = () => {
  const perf = { lcp: null, cls: 0, clicks: [], firstInput: null }
  window.__perfLab = perf
  const watch = (type, fn, extra = {}) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra })
    } catch {
      // 這個瀏覽器不支援該 entry type：對應的格會是 N/A。
    }
  }
  watch('largest-contentful-paint', (e) => (perf.lcp = e.startTime))
  watch('layout-shift', (e) => {
    if (!e.hadRecentInput) perf.cls += e.value
  })
  watch('event', (e) => {
    if (e.name === 'click') perf.clicks.push(e.duration)
  }, { durationThreshold: 16 })
  watch('first-input', (e) => (perf.firstInput = e.duration))
}

export function p75(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0 || v.length < values.length) return null
  return v[Math.ceil(v.length * 0.75) - 1]
}

function cookieList(cookie, base) {
  if (!cookie) return []
  return cookie.split('; ').map((pair) => {
    const i = pair.indexOf('=')
    return { name: pair.slice(0, i), value: pair.slice(i + 1), url: new URL(base).origin }
  })
}

function locator(page, target) {
  const [kind, ...rest] = target.split(':')
  const name = rest.join(':')
  if (kind === 'link') return page.getByRole('link', { name, exact: true }).first()
  if (kind === 'button') return page.getByRole('button', { name, exact: true }).first()
  return page.locator(target).first()
}

async function once(browser, base, route, spec, cookie) {
  const context = await browser.newContext({ viewport: VIEWPORT })
  try {
    await context.addCookies(cookieList(cookie, base))
    await context.addInitScript(OBSERVERS)
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const res = await page.goto(new URL(route, base).href, { waitUntil: 'load' })
    if (!res || res.status() !== 200 || new URL(page.url()).pathname !== route) {
      throw new Error(`${route} 沒有停在本頁（HTTP ${res?.status()}，現在在 ${page.url()}）`)
    }
    await page.waitForTimeout(500) // 讓 LCP 定下來
    const load = await page.evaluate(() => ({
      lcp: window.__perfLab.lcp,
      ttfb: performance.getEntriesByType('navigation')[0]?.responseStart ?? null,
    }))
    let navMs = null
    for (const action of spec.actions ?? []) {
      const from = new URL(page.url()).pathname
      const target = locator(page, action.click)
      await target.waitFor({ state: 'visible' })
      const t0 = Date.now()
      await target.click()
      await page.waitForFunction(
        ([p, sel]) => location.pathname !== p && document.querySelector(sel) !== null,
        [from, action.waitFor ?? 'main h1'],
        { timeout: 15000 },
      )
      navMs = Math.max(navMs ?? 0, Date.now() - t0)
    }
    await page.waitForTimeout(300)
    const after = await page.evaluate(() => window.__perfLab)
    const clickMs = spec.actions?.length ? (after.clicks.length ? Math.max(...after.clicks) : after.firstInput) : null
    return { lcp: load.lcp, ttfb: load.ttfb, cls: after.cls, clickMs, navMs }
  } finally {
    await context.close()
  }
}

const fmt = (v, unit = '') => (v === null ? 'N/A' : `${Math.round(v * (unit ? 1 : 1000)) / (unit ? 1 : 1000)}${unit}`)
const mark = (v, limit) => (v === null ? '' : v <= limit ? ' ✓' : ' ✗')

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.base) fail('缺少 --base <url>')
  const who = resolveAs(opts.as)
  const runs = Number(opts.runs ?? 5)
  const all = JSON.parse(fs.readFileSync(path.join(HERE, 'lab-routes.json'), 'utf8'))
  const wanted = opts.routes ? String(opts.routes).split(',').map((r) => r.trim()) : null
  const routes = Object.entries(all).filter(([r, s]) => !r.startsWith('$') && s.as === who.label && (!wanted || wanted.includes(r)))
  if (routes.length === 0) fail(`lab-routes.json 沒有 as=${who.label} 的路由${wanted ? `（--routes ${wanted.join(',')}）` : ''}。`)

  const cookie = await signIn(opts.base, who.email)
  const browser = await chromium.launch()
  const results = []
  try {
    for (const [route, spec] of routes) {
      await once(browser, opts.base, route, spec, cookie) // 暖機（伺服器端快取、編譯）
      const samples = []
      for (let i = 0; i < runs; i++) samples.push(await once(browser, opts.base, route, spec, cookie))
      const pick = (k) => p75(samples.map((s) => s[k]))
      results.push({ route, as: who.label, runs, lcp: pick('lcp'), clickMs: pick('clickMs'), navMs: pick('navMs'), cls: pick('cls'), ttfb: pick('ttfb'), samples })
    }
  } finally {
    await browser.close()
  }

  console.log(`perf:lab  as=${who.label}  CPU×4  暖機 1＋量 ${runs} 次取 p75  base=${opts.base}`)
  console.log(`${'route'.padEnd(30)} ${'LCP'.padStart(10)} ${'click'.padStart(10)} ${'切頁→h1'.padStart(10)} ${'CLS'.padStart(9)} ${'TTFB'.padStart(9)}`)
  for (const r of results) {
    console.log(
      `${r.route.padEnd(30)} ${(fmt(r.lcp, 'ms') + mark(r.lcp, TARGETS.lcp)).padStart(10)} ${(fmt(r.clickMs, 'ms') + mark(r.clickMs, TARGETS.clickMs)).padStart(10)} ` +
        `${(fmt(r.navMs, 'ms') + mark(r.navMs, TARGETS.navMs)).padStart(10)} ${(fmt(r.cls) + mark(r.cls, TARGETS.cls)).padStart(9)} ${(fmt(r.ttfb, 'ms') + mark(r.ttfb, TARGETS.ttfb)).padStart(9)}`,
    )
  }
  console.log(`目標（§7.2）：LCP ≤ ${TARGETS.lcp} ms、click ≤ ${TARGETS.clickMs} ms、切頁到 main h1 ≤ ${TARGETS.navMs} ms、CLS ≤ ${TARGETS.cls}、TTFB ≤ ${TARGETS.ttfb} ms（✓／✗ 只是對照，不影響 exit code）`)
  if (opts.json) fs.writeFileSync(path.resolve(opts.json), `${JSON.stringify(results, null, 2)}\n`)
  const missing = results.filter((r) => [r.lcp, r.clickMs, r.navMs, r.cls, r.ttfb].some((v) => v === null))
  if (missing.length > 0) {
    console.log(`\n✗ 有量不到的格（N/A）：${missing.map((r) => r.route).join('、')}`)
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
