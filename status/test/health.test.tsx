// 服務健康頁（AC-DV-19、AC-DV-13 的圖表元件、AC-DV-30）：兩站健康、Gatus 圖與可用率、Access 守門。
import { cp, mkdtemp, readFile as readFileText, rm, writeFile } from 'node:fs/promises'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import HealthPage from '@/app/health/page'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CollectorStatus, HealthData, MetricsData } from '@/lib/data/types'

// AC-DV-30 數 readFile：read.ts 用具名 import，要在模組層換掉才攔得到。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const base = path.join(import.meta.dirname, '..', 'fixtures', 'base', 'data')
const NOW = '2026-10-12T09:05:00+08:00'

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'status-health-'))
})
afterAll(() => rm(root, { recursive: true, force: true }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

const wrap = (page: React.ReactNode) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>{page}</SidebarProvider>
    </TooltipProvider>,
  )

async function renderDir(dataDir: string) {
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  return wrap(await HealthPage())
}

type Edit = {
  health?: (h: HealthData) => void
  metrics?: ((m: MetricsData) => void) | 'delete'
  collector?: (c: CollectorStatus) => void
}

/** 複製 fixtures/base/data 到 tmp 再改幾個欄位。 */
async function variant(name: string, edit: Edit) {
  const dir = path.join(root, name)
  await cp(base, dir, { recursive: true })
  const patch = async <T,>(file: string, fn?: (v: T) => void) => {
    if (!fn) return
    const p = path.join(dir, file)
    const v = JSON.parse(await readFileText(p, 'utf8')) as T
    fn(v)
    await writeFile(p, JSON.stringify(v))
  }
  await patch('health.json', edit.health)
  if (edit.metrics === 'delete') await rm(path.join(dir, 'metrics.json'))
  else await patch('metrics.json', edit.metrics)
  await patch('collector.json', edit.collector)
  return dir
}

/** 某個區塊的 HTML（到下一個區塊為止）。 */
const section = (html: string, id: string) => {
  const start = html.indexOf(`data-testid="${id}"`)
  if (start < 0) return ''
  const rest = html.slice(start + 1)
  const end = rest.search(/data-testid="(?:site-test|site-prod|health-chart|uptime-table|access-guard)"/)
  return end < 0 ? rest : rest.slice(0, end)
}
const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0
/** 表格一列的格子文字。 */
const cells = (row: string) => [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1])

describe('服務健康頁（AC-DV-19）', () => {
  it('fixtures/base：標題、五個區塊各一個、沒有占位頁', async () => {
    const html = await renderDir(base)
    expect(html).toMatch(/<h1[^>]*>服務健康<\/h1>/)
    for (const id of ['site-test', 'site-prod', 'health-chart', 'uptime-table', 'access-guard']) {
      expect(count(html, new RegExp(`data-testid="${id}"`, 'g'))).toBe(1)
    }
    expect(html).not.toContain('data-testid="placeholder"')
    expect(html).not.toContain('<script')
  })

  it('fixtures/base：兩站卡有 ok 字、commit 短 SHA、六顆點', async () => {
    const html = await renderDir(base)
    const health: HealthData = JSON.parse(await readFileText(path.join(base, 'health.json'), 'utf8'))
    for (const site of ['test', 'prod'] as const) {
      const card = section(html, `site-${site}`)
      expect(card).toContain('data-state="green"')
      expect(card).toContain('正常')
      expect(card).toContain(`>${health[site]!.commit!.slice(0, 7)}</code>`)
      expect(count(card, /data-ok="true"/g)).toBe(6)
      expect(card).not.toContain('data-testid="site-reason"')
    }
  })

  it('測試站 last6 兩個 false、reason 有字：兩顆紅點、reason 顯示、卡片紅', async () => {
    const dir = await variant('last6', {
      health: (h) => {
        h.test = { ...h.test!, ok: false, last6: [false, true, false, true, true, true], reason: 'worker 心跳逾時' }
      },
    })
    const card = section(await renderDir(dir), 'site-test')
    expect(card).toContain('data-state="red"')
    expect(count(card, /data-ok="false"/g)).toBe(2)
    expect(count(card, /data-ok="true"/g)).toBe(4)
    expect(card).toMatch(/data-testid="site-reason"[^>]*>worker 心跳逾時</)
  })

  it('health-chart：一個 svg、兩條 path（data-series test、prod）、X 軸至少 5 個整點、Y 軸含 ms', async () => {
    const chart = section(await renderDir(base), 'health-chart')
    expect(chart).toContain('data-state="ok"')
    expect(count(chart, /<svg/g)).toBe(1)
    expect(count(chart, /<path /g)).toBe(2)
    expect(chart).toContain('data-series="test"')
    expect(chart).toContain('data-series="prod"')
    expect(count(chart, />\d{2}:00<\/text>/g)).toBeGreaterThanOrEqual(5)
    expect(chart).toMatch(/>\d+ ms<\/text>/)
    expect(chart).not.toContain('NaN')
  })

  it('uptime-table：兩列、四欄，數字跟 metrics.json 一致（百分比一位小數、ms 整數）', async () => {
    const table = section(await renderDir(base), 'uptime-table')
    expect(table).toMatch(
      /<th[^>]*>站<\/th><th[^>]*>24h 可用率<\/th><th[^>]*>7d 可用率<\/th><th[^>]*>24h 平均回應<\/th><th[^>]*>24h 失敗次數<\/th>/,
    )
    const metrics: MetricsData = JSON.parse(await readFileText(path.join(base, 'metrics.json'), 'utf8'))
    const rows = [...table.matchAll(/data-testid="uptime-(test|prod)"[^>]*>(.*?)<\/tr>/g)]
    expect(rows.map((r) => r[1])).toEqual(['test', 'prod'])
    for (const [, site, row] of rows) {
      const m = metrics.sites[site as 'test' | 'prod']!
      expect(cells(row!).slice(1)).toEqual([
        `${(m.uptime24h! * 100).toFixed(1)}%`,
        `${(m.uptime7d * 100).toFixed(1)}%`,
        `${m.avgMs24h} ms`,
        String(m.failures24h),
      ])
    }
    expect(cells(rows[0]![2]!).slice(1)).toEqual(['99.7%', '99.9%', '213 ms', '1'])
  })

  it('access-guard：四列 host／guarded／status／location', async () => {
    const guard = section(await renderDir(base), 'access-guard')
    expect(guard).toMatch(/<th[^>]*>host<\/th><th[^>]*>guarded<\/th><th[^>]*>status<\/th><th[^>]*>location<\/th>/)
    expect(count(guard, /data-testid="access-row"/g)).toBe(4)
    expect(guard).toContain('fju-status.roy422.dev')
    expect(guard).toContain('>302</td>')
  })

  it('缺 metrics.json：圖位置是灰卡「還沒有 Gatus 資料」、uptime-table 全是「—」，頁面照常出來', async () => {
    const dir = await variant('no-metrics', { metrics: 'delete' })
    const html = await renderDir(dir)
    const chart = section(html, 'health-chart')
    expect(chart).toContain('data-state="none"')
    expect(chart).toContain('還沒有 Gatus 資料')
    expect(chart).not.toContain('<svg')
    const table = section(html, 'uptime-table')
    for (const row of table.match(/data-testid="uptime-(?:test|prod)"[^>]*>.*?<\/tr>/g)!) {
      expect(cells(row).slice(1)).toEqual(['—', '—', '—', '—'])
    }
    expect(section(html, 'site-test')).toContain('data-state="green"')
  })

  it('Gatus 本輪失敗（gatusOk:false、HTTP 502、保留 2 小時前的值）：照畫舊圖、灰字寫資料時間與錯誤', async () => {
    const dir = await variant('stale', {
      metrics: (m) => {
        m.gatusOk = false
        m.error = 'HTTP 502'
        m.sites.test!.fetchedAt = '2026-10-12T07:05:00+08:00'
        m.sites.prod!.fetchedAt = '2026-10-12T07:05:00+08:00'
      },
    })
    const chart = section(await renderDir(dir), 'health-chart')
    expect(chart).toContain('data-state="stale"')
    expect(count(chart, /<path /g)).toBe(2)
    expect(chart).toMatch(/data-testid="chart-stale"[^>]*>Gatus 本輪失敗，資料時間 10\/12 07:05（HTTP 502）</)
  })

  it('收集器本輪抓健康檢查失敗：頁頂一句說明，下面照舊值畫', async () => {
    const dir = await variant('source-fail', {
      collector: (c) => {
        c.sources.health = { ok: false, at: '2026-10-12T09:00:00+08:00', error: 'timeout' }
      },
    })
    const html = await renderDir(dir)
    expect(html).toMatch(/data-testid="source-note"[^>]*>收集器本輪抓健康檢查失敗（timeout）/)
    expect(section(html, 'site-test')).toContain('data-state="green"')
  })

  it('沒有任何資料：頁面照常出來，站卡灰、圖灰卡、表「—」、Access 灰卡', async () => {
    const empty = await mkdtemp(path.join(root, 'empty-'))
    const html = await renderDir(empty)
    expect(section(html, 'site-test')).toContain('data-state="grey"')
    expect(section(html, 'site-prod')).toContain('data-state="grey"')
    expect(section(html, 'health-chart')).toContain('還沒有 Gatus 資料')
    expect(section(html, 'access-guard')).toContain('data-state="grey"')
    expect(count(section(html, 'uptime-table'), /<td[^>]*>—<\/td>/g)).toBe(8)
  })
})

describe('服務健康頁讀檔（AC-DV-30）', () => {
  it('一次 render 只讀 health、metrics、collector 三個檔，各一次', async () => {
    vi.stubEnv('STATUS_DATA_DIR', base)
    const readFile = vi.mocked(fsp.readFile)
    readFile.mockClear()
    wrap(await HealthPage())
    const files = readFile.mock.calls.map(([f]) => path.basename(String(f))).sort()
    expect(files).toEqual(['collector.json', 'health.json', 'metrics.json'])
  })
})
