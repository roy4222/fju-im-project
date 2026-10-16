#!/usr/bin/env node
/**
 * Pixel Trail 的主執行緒成本（共用 SH-0，設計方案 §3.5、§7.4.5、§7.5；照 perf-out 的 proto.mjs 改寫）。
 *
 *   PERF_PASSWORD=… pnpm -C web perf:trail --base http://localhost:3399 --as student|teacher [--seconds 5] [--json out.json]
 *
 * CPU×4、桌機視窗，開該角色首頁，滑鼠在 `section.hero` 上照固定路徑掃 N 秒（預設 5）：
 *   - scriptPct：CDP `Performance.getMetrics` 的 ScriptDuration 增量 ÷ 掃動經過的時間；
 *   - longTasks／longTaskMs：`PerformanceObserver('longtask')`（> 50 ms）次數與總時長；
 *   - worstFrameMs：掃動期間 requestAnimationFrame 兩幀的最大間隔。
 * 跑兩組：Trail 開（`[data-testid=hero-trail]` 要存在）與對照組（`reducedMotion: 'reduce'`，Trail 不掛）。
 * 判定（§7.5）：Trail 開 `scriptPct ≤ 20` 且 `longTasks === 0`；對照組 `scriptPct ≤ 2`。不合格、或 Trail 開那組
 * 找不到 hero-trail、或頁面沒有 section.hero → exit 1。
 */
/* global URL, window, PerformanceObserver, requestAnimationFrame */ // （window 等是 addInitScript／evaluate 在瀏覽器裡用的）
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { fail, parseArgs } from './db.mjs'
import { PERF_ACCOUNTS, resolveAs, signIn } from './accounts.mjs'

const VIEWPORT = { width: 1280, height: 800 }
export const BUDGET = { scriptPct: 20, longTasks: 0, controlScriptPct: 2 }

const OBSERVERS = () => {
  const perf = { longTasks: 0, longTaskMs: 0, worstFrameMs: 0, sweeping: false }
  window.__perfTrail = perf
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!perf.sweeping) continue
        perf.longTasks++
        perf.longTaskMs += e.duration
      }
    }).observe({ type: 'longtask' })
  } catch {
    perf.longTasks = null
  }
  let last = 0
  const tick = (t) => {
    if (perf.sweeping && last) perf.worstFrameMs = Math.max(perf.worstFrameMs, t - last)
    last = t
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** 固定路徑：在框內畫 8 字（Lissajous），每 16 ms 一步。 */
function pathPoint(box, i) {
  const t = i / 30
  return { x: box.x + box.width * (0.5 + 0.4 * Math.sin(t)), y: box.y + box.height * (0.5 + 0.35 * Math.sin(2 * t)) }
}

async function sweep(browser, base, route, cookie, { reduced, seconds }) {
  const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: reduced ? 'reduce' : 'no-preference' })
  try {
    if (cookie) {
      await context.addCookies(cookie.split('; ').map((p) => ({ name: p.slice(0, p.indexOf('=')), value: p.slice(p.indexOf('=') + 1), url: new URL(base).origin })))
    }
    await context.addInitScript(OBSERVERS)
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await cdp.send('Performance.enable')
    const res = await page.goto(new URL(route, base).href, { waitUntil: 'load' })
    if (!res || res.status() !== 200) throw new Error(`${route} 回 ${res?.status()}`)
    const hero = page.locator('section.hero').first()
    if ((await hero.count()) === 0) throw new Error(`${route} 沒有 section.hero`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500) // 等 hydration 與 Trail 的 chunk 初始化完，掃動期間只量 Trail 本身
    const trail = await page.locator('section.hero [data-testid=hero-trail]').count()
    const state = trail ? await page.locator('section.hero [data-testid=hero-trail]').first().getAttribute('data-state') : null
    const box = await hero.boundingBox()
    const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))

    await page.evaluate(() => (window.__perfTrail.sweeping = true))
    const m0 = await metric()
    const t0 = Date.now()
    for (let i = 0; Date.now() - t0 < seconds * 1000; i++) {
      const p = pathPoint(box, i)
      await page.mouse.move(p.x, p.y)
      await page.waitForTimeout(16)
    }
    const m1 = await metric()
    const wall = (Date.now() - t0) / 1000
    const obs = await page.evaluate(() => {
      window.__perfTrail.sweeping = false
      return window.__perfTrail
    })
    return {
      route,
      trail: trail > 0,
      dataState: state,
      scriptPct: Math.round(((m1.ScriptDuration - m0.ScriptDuration) / wall) * 1000) / 10,
      longTasks: obs.longTasks,
      longTaskMs: Math.round(obs.longTaskMs),
      worstFrameMs: Math.round(obs.worstFrameMs),
    }
  } finally {
    await context.close()
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.base) fail('缺少 --base <url>')
  if (!['student', 'teacher'].includes(opts.as)) fail('--as 只能是 student 或 teacher（有 Pixel Trail 的首頁）')
  const who = resolveAs(opts.as)
  const route = opts.route ?? PERF_ACCOUNTS[who.label].home
  const seconds = Number(opts.seconds ?? 5)
  const cookie = await signIn(opts.base, who.email)
  const browser = await chromium.launch()
  let on
  let off
  try {
    on = await sweep(browser, opts.base, route, cookie, { reduced: false, seconds })
    off = await sweep(browser, opts.base, route, cookie, { reduced: true, seconds })
  } finally {
    await browser.close()
  }

  const problems = []
  if (!on.trail) problems.push('Trail 開的那組找不到 [data-testid=hero-trail]（首頁沒掛 Trail？）')
  if (on.scriptPct > BUDGET.scriptPct) problems.push(`Trail 開 scriptPct ${on.scriptPct} > ${BUDGET.scriptPct}`)
  if (on.longTasks === null || off.longTasks === null) problems.push('瀏覽器不支援 longtask 觀察')
  else if (on.longTasks > BUDGET.longTasks) problems.push(`Trail 開 longTasks ${on.longTasks} > ${BUDGET.longTasks}`)
  if (off.trail) problems.push('對照組（reducedMotion）還有 hero-trail')
  if (off.scriptPct > BUDGET.controlScriptPct) problems.push(`對照組 scriptPct ${off.scriptPct} > ${BUDGET.controlScriptPct}`)

  console.log(`perf:trail  as=${who.label}  ${route}  CPU×4  掃 ${seconds} 秒`)
  console.log(`${'組'.padEnd(10)} trail  data-state   scriptPct  longTasks  longTaskMs  worstFrameMs`)
  for (const [label, r] of [['Trail 開', on], ['對照組', off]]) {
    console.log(`${label.padEnd(10)} ${String(r.trail).padEnd(6)} ${String(r.dataState ?? '-').padEnd(12)} ${String(r.scriptPct).padStart(9)} ${String(r.longTasks).padStart(10)} ${String(r.longTaskMs).padStart(11)} ${String(r.worstFrameMs).padStart(13)}`)
  }
  console.log(`預算（§7.5）：Trail 開 scriptPct ≤ ${BUDGET.scriptPct}、longTasks === 0；對照組 scriptPct ≤ ${BUDGET.controlScriptPct}`)
  if (opts.json) fs.writeFileSync(path.resolve(opts.json), `${JSON.stringify({ on, off, problems }, null, 2)}\n`)
  if (problems.length > 0) {
    for (const p of problems) console.log(`✗ ${p}`)
    process.exit(1)
  }
  console.log('✓ 在預算內。')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
