// 總覽頁（AC-DV-11～18、AC-DV-30）：狀態列 → KPI 五卡 → Gatus 圖 → 能不能上線 → 最近事件；入口卡、工具卡、版本卡都不在這頁。
import * as fsp from 'node:fs/promises'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import OverviewPage from '@/app/page'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CollectorStatus, GithubData, MetricsData, VmData } from '@/lib/data/types'

import { NOW, SCENARIOS, writeScenario, type Scenario } from '../fixtures/gate/scenarios'

// AC-DV-30 數 readFile：read.ts 用具名 import，要在模組層換掉才攔得到。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const fixtures = path.join(import.meta.dirname, '..', 'fixtures', 'base')
const LOGS = 'https://fju-status-logs.roy422.dev'
const AT = '2026-10-12T09:00:00+08:00'
const SHA = '7162644000000000000000000000000000000000'
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString()

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'status-overview-'))
})
afterAll(() => rm(root, { recursive: true, force: true }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

/** fixture 的時間都在 NOW 前幾分鐘；固定在 NOW，vm／github 才不會因過期變灰。 */
async function render(dataDir: string, acceptanceDir = path.join(fixtures, 'acceptance')) {
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  vi.stubEnv('STATUS_ACCEPTANCE_DIR', acceptanceDir)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  // 側欄與 tooltip 的 provider 在 layout.tsx；頁首的側欄按鈕要它們才畫得出來。
  const page = await OverviewPage()
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>{page}</SidebarProvider>
    </TooltipProvider>,
  )
}

const readJson = async <T,>(dir: string, name: string): Promise<T> => JSON.parse(await readFile(path.join(dir, name), 'utf8'))
const put = (dir: string, name: string, value: unknown) => writeFile(path.join(dir, name), JSON.stringify(value))

/**
 * AC-DV-11 的 tmp 目錄：以 fixtures/base/data 為底，collector 5 分鐘前、備份今天 03:30、CI 4 分鐘前 success、
 * disk 62%、metrics 兩站 24h 無失敗、正式站健康 ok、正式站部署 SHA 落後 main。`edit` 再改 vm／metrics。
 */
async function ac11(name: string, edit: { vm?: (vm: VmData) => void; metrics?: (m: MetricsData) => MetricsData | null } = {}) {
  const dir = path.join(root, name)
  await cp(path.join(fixtures, 'data'), dir, { recursive: true })
  const github = await readJson<GithubData>(dir, 'github.json')
  await put(dir, 'github.json', { ...github, generatedAt: minutesAgo(4) })
  const vm = await readJson<VmData>(dir, 'vm.json')
  for (const site of ['test', 'prod'] as const) {
    const b = vm.backups[site]
    b.latest!.mtime = '2026-10-12T03:30:00+08:00'
    b.lastRecord = { at: '2026-10-12T03:30:00+08:00', ok: true }
    b.lastOk = { at: '2026-10-12T03:30:00+08:00', bytes: b.latest!.bytes }
  }
  edit.vm?.(vm)
  await put(dir, 'vm.json', vm)
  let metrics: MetricsData | null = await readJson<MetricsData>(dir, 'metrics.json')
  for (const s of Object.values(metrics.sites)) {
    if (!s) continue
    s.points = s.points.map((p) => ({ ...p, ok: true }))
    s.failures24h = 0
    s.uptime24h = 1
  }
  if (edit.metrics) metrics = edit.metrics(metrics)
  if (metrics) await put(dir, 'metrics.json', metrics)
  else await rm(path.join(dir, 'metrics.json'))
  return dir
}

/** 某個區塊的 HTML（到下一個 data-testid 區塊為止）。 */
const BLOCKS = /data-testid="(?:status-bar|kpi-[a-z]+|overview-chart|go-live-summary|recent-events)"/
const section = (html: string, id: string) => {
  const start = html.indexOf(`data-testid="${id}"`)
  if (start < 0) return ''
  const rest = html.slice(start + 1)
  const end = rest.search(BLOCKS)
  return end < 0 ? rest : rest.slice(0, end)
}
const stateOf = (html: string, id: string) => html.match(new RegExp(`data-testid="${id}" data-state="([a-z-]+)"`))?.[1]
const statusText = (html: string) => html.match(/data-testid="status-text">([^<]*)</)?.[1]

describe('總覽版面（AC-DV-11、AC-DV-16）', () => {
  it('由上到下：狀態列 → 五張 KPI → 圖 → 能不能上線 → 最近事件；五卡連到正本那頁', async () => {
    const html = await render(await ac11('layout'))
    const order = ['status-bar', 'kpi-version', 'kpi-errors', 'kpi-backup', 'kpi-disk', 'kpi-ci', 'overview-chart', 'go-live-summary', 'recent-events']
    const at = order.map((id) => html.indexOf(`data-testid="${id}"`))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    for (const [id, href] of [['version', '/deploy'], ['errors', '/errors'], ['backup', '/backup'], ['disk', '/backup'], ['ci', '/deploy']]) {
      expect(html).toMatch(new RegExp(`<a(?=[^>]*data-testid="kpi-${id}")(?=[^>]*href="${href}")`))
    }
  })

  it('狀態列「1 項要注意・5 分鐘前更新」、測試站 ✓、正式站 ✓', async () => {
    const html = await render(await ac11('bar'))
    const bar = section(html, 'status-bar')
    expect(statusText(html)).toBe('1 項要注意')
    expect(bar).toContain('・5 分鐘前更新')
    expect(bar).toContain('測試站 ✓')
    expect(bar).toContain('正式站 ✓')
  })

  it('五張 KPI 的狀態與字', async () => {
    const html = await render(await ac11('kpis'))
    expect(stateOf(html, 'kpi-version')).toBe('yellow')
    expect(section(html, 'kpi-version')).toContain('不一致')
    expect(section(html, 'kpi-version')).toContain('測試站 7162644・正式站 463931b・main 7162644')
    expect(stateOf(html, 'kpi-errors')).toBe('green')
    expect(section(html, 'kpi-errors')).toMatch(/>0</)
    expect(stateOf(html, 'kpi-backup')).toBe('green')
    expect(section(html, 'kpi-backup')).toContain('成功')
    expect(section(html, 'kpi-backup')).toContain('今天 03:30')
    expect(stateOf(html, 'kpi-disk')).toBe('green')
    expect(section(html, 'kpi-disk')).toContain('62%')
    expect(section(html, 'kpi-disk')).toContain('style="width:62%"')
    expect(stateOf(html, 'kpi-ci')).toBe('green')
    expect(section(html, 'kpi-ci')).toContain('main ✓')
    expect(section(html, 'kpi-ci')).toContain('4 分鐘前')
  })

  it('去重：總覽沒有版本卡、入口卡、工具卡（工具入口只在側欄）', async () => {
    const html = await render(await ac11('dedupe'))
    expect(html).not.toContain('data-testid="version-card"')
    expect(html).not.toContain('data-testid="ci-main"')
    expect(html).not.toMatch(/data-testid="page-/)
    expect(html).not.toMatch(/data-testid="tool-/)
  })
})

describe('主機儲存 KPI（AC-DV-12）', () => {
  const cases: [string, (vm: VmData) => void, string, string, string[]][] = [
    ['85', (vm) => (vm.disk!.percent = 85), 'yellow', '2 項要注意', ['85%']],
    ['92', (vm) => (vm.disk!.percent = 92), 'red', '1 項異常', ['92%']],
    ['null', (vm) => ((vm.disk = null), (vm.diskError = 'EACCES')), 'grey', '1 項要注意', ['>—<', 'EACCES']],
    [
      'kept',
      (vm) => ((vm.disk = { ...vm.disk!, checkedAt: minutesAgo(180) }), (vm.diskError = 'EACCES')),
      'grey',
      '1 項要注意',
      ['62%', '量測時間 10/12 06:05', 'EACCES'],
    ],
  ]
  for (const [name, edit, state, text, contains] of cases) {
    it(`${name} → kpi-disk ${state}、狀態列「${text}」`, async () => {
      const html = await render(await ac11(`disk-${name}`, { vm: edit }))
      expect(stateOf(html, 'kpi-disk')).toBe(state)
      for (const c of contains) expect(section(html, 'kpi-disk')).toContain(c)
      expect(statusText(html)).toBe(text)
    })
  }
})

describe('Gatus 圖（AC-DV-13，Q-DV-1 定案：伺服器端 SVG）', () => {
  it('有資料：一個 <svg>、兩條 path（test、prod）、X 軸至少 5 個小時標、Y 軸含 ms、可用率兩個數字', async () => {
    const html = await render(await ac11('chart', { metrics: (m) => ((m.sites.test!.uptime7d = 0.999), m) }))
    const chart = section(html, 'overview-chart')
    expect(chart.match(/<svg/g)).toHaveLength(1)
    expect(chart).toContain('data-series="test"')
    expect(chart).toContain('data-series="prod"')
    expect(chart.match(/<path/g)).toHaveLength(2)
    expect((chart.match(/>\d{2}:00</g) ?? []).length).toBeGreaterThanOrEqual(5)
    expect(chart).toMatch(/>\d+ ms</)
    expect(chart).toContain('24h 可用率 100.0%')
    expect(chart).toContain('7d 可用率 99.9%')
    expect(chart).not.toContain('<script')
  })

  it('沒有 metrics.json：灰卡「還沒有 Gatus 資料」、kpi-errors 灰', async () => {
    const html = await render(await ac11('no-metrics', { metrics: () => null }))
    expect(stateOf(html, 'overview-chart')).toBe('none')
    expect(section(html, 'overview-chart')).toContain('還沒有 Gatus 資料')
    expect(stateOf(html, 'kpi-errors')).toBe('grey')
  })

  it('Gatus 本輪失敗、保留上次值：照畫舊圖＋灰字與錯誤，kpi-errors 灰', async () => {
    const html = await render(
      await ac11('stale', {
        metrics: (m) => {
          for (const s of Object.values(m.sites)) if (s) s.fetchedAt = minutesAgo(120)
          return { ...m, gatusOk: false, error: 'HTTP 502' }
        },
      }),
    )
    const chart = section(html, 'overview-chart')
    expect(stateOf(html, 'overview-chart')).toBe('stale')
    expect(chart).toContain('data-series="test"')
    expect(chart).toContain('Gatus 本輪失敗，資料時間 10/12 07:05')
    expect(chart).toContain('HTTP 502')
    expect(stateOf(html, 'kpi-errors')).toBe('grey')
  })
})

/** 情境寫進 tmp 目錄（加 collector、metrics）再 render。 */
async function renderScenario(name: string, s: Scenario, collector: CollectorStatus | null = null) {
  const { dataDir, acceptanceDir } = await writeScenario(path.join(root, name), s)
  if (collector) await put(dataDir, 'collector.json', collector)
  return render(dataDir, acceptanceDir)
}

describe('能不能上線摘要（AC-DV-14）', () => {
  it('情境 (b)：「4 / 5」、五列各有 data-state、G1 紅、只有一句結論沒有原因清單、標題連 /go-live', async () => {
    const html = await renderScenario('gates-b', SCENARIOS.b())
    const summary = section(html, 'go-live-summary')
    expect(summary).toContain('4 / 5')
    expect(summary).toMatch(/<a[^>]*href="\/go-live"[^>]*>能不能上線<\/a>/)
    const states = [...summary.matchAll(/data-testid="gate-(G\d)" data-state="([a-z]+)"/g)].map((m) => `${m[1]}:${m[2]}`)
    expect(states).toEqual(['G1:red', 'G2:green', 'G3:green', 'G4:green', 'G5:green'])
    expect(summary).not.toContain('<ul')
    expect(summary.match(/data-testid="gate-G\d-summary"/g)).toHaveLength(5)
  })
})

describe('最近事件（AC-DV-15，Q-DV-4 定案：七類、8 筆）', () => {
  /** 兩站各 3 筆部署（1 筆失敗）、正式站備份失敗、github 來源失敗、CI failure、驗收一夜跑完。 */
  function ac15(): Scenario {
    const s = SCENARIOS.b()
    const d = (at: string, event = 'deployed') => ({ at, event, tag: SHA, digest: null })
    s.vm!.deploys = {
      test: [d('2026-10-12T00:40:00Z'), d('2026-10-11T12:00:00Z', 'e2e-seed-failed'), d('2026-10-11T01:00:00Z')],
      prod: [d('2026-10-12T00:50:00Z'), d('2026-10-10T12:00:00Z'), d('2026-10-09T12:00:00Z')],
    }
    s.vm!.backups.prod.lastRecord = { at: '2026-10-12T03:10:05+08:00', ok: false }
    return s
  }
  const collector: CollectorStatus = {
    generatedAt: AT,
    sources: Object.fromEntries(
      ['github', 'repo', 'health', 'vm', 'acceptance'].map((k) => [
        k,
        k === 'github' ? { ok: false, at: '2026-10-12T08:50:00+08:00', error: 'HTTP 403' } : { ok: true, at: AT, error: null },
      ]),
    ),
  }
  const rows = (html: string) => section(html, 'recent-events').split('data-testid="event-row"').slice(1)

  it('表頭四欄；恰好 8 列、新到舊；類型只在七種內；連結對到正本或 Dozzle、GitHub', async () => {
    const html = await renderScenario('events', ac15(), collector)
    const table = section(html, 'recent-events')
    for (const h of ['時間', '類型', '內容', '連結']) expect(table).toMatch(new RegExp(`<th[^>]*>${h}</th>`))
    const list = rows(html)
    expect(list).toHaveLength(8)
    const KINDS = ['部署', '備份', '來源失敗', '健康失敗', 'CI 失敗', '映像失敗', '驗收']
    for (const r of list) {
      const kind = r.match(/<td[^>]*>[^<]*<\/td><td[^>]*>([^<]*)<\/td>/)?.[1]
      expect(KINDS).toContain(kind)
    }
    const times = list.map((r) => r.match(/>(\d{2}\/\d{2} \d{2}:\d{2})</)![1]!)
    expect([...times].sort().reverse()).toEqual(times)
    const byKind = (k: string) => list.filter((r) => r.startsWith(` data-kind="${k}"`))
    for (const r of byKind('deploy')) expect(r).toContain('href="/deploy"')
    for (const r of byKind('backup')) expect(r).toContain('href="/backup"')
    expect(byKind('source-fail')[0]).toContain(`href="${LOGS}/show?name=fju-status-collector-1"`)
    expect(byKind('ci-fail')[0]).toContain('href="https://github.com/roy4222/fju-im-project/actions/runs/1001"')
  })

  it('所有來源都沒有東西：「最近沒有事件」', async () => {
    const empty = await mkdtemp(path.join(root, 'no-events-'))
    const html = await render(empty)
    expect(section(html, 'recent-events')).toContain('最近沒有事件')
    expect(rows(html)).toHaveLength(0)
  })
})

describe('沒有資料（AC-DV-18；改寫原「還沒有收集器資料」那條，衝突表 C7）', () => {
  for (const [name, setup] of [
    ['空目錄', async () => {}],
    ['壞掉的 vm.json', async (dir: string) => writeFile(path.join(dir, 'vm.json'), '{壞掉')],
  ] as const) {
    it(`${name}：不 throw；狀態列「沒有資料」、五張 KPI 灰「—」、圖灰卡、0 / 5 五條灰、沒有事件`, async () => {
      const dir = await mkdtemp(path.join(root, 'empty-'))
      await mkdir(dir, { recursive: true })
      await setup(dir)
      const html = await render(dir, dir)
      expect(statusText(html)).toBe('沒有資料')
      for (const id of ['version', 'errors', 'backup', 'disk', 'ci']) {
        expect(stateOf(html, `kpi-${id}`)).toBe('grey')
        expect(section(html, `kpi-${id}`)).toContain('>—<')
      }
      expect(section(html, 'overview-chart')).toContain('還沒有 Gatus 資料')
      const summary = section(html, 'go-live-summary')
      expect(summary).toContain('0 / 5')
      expect(summary.match(/data-state="grey"/g)).toHaveLength(5)
      expect(section(html, 'recent-events')).toContain('最近沒有事件')
    })
  }
})

describe('總覽讀檔（AC-DV-30）', () => {
  it('一次 render 讀 ≤ 10 個檔、同一個檔不讀兩次', async () => {
    const readFileSpy = vi.mocked(fsp.readFile)
    readFileSpy.mockClear()
    await render(path.join(fixtures, 'data'))
    const files = readFileSpy.mock.calls.map(([f]) => path.relative(fixtures, String(f)))
    expect(files.length).toBeLessThanOrEqual(10)
    expect(new Set(files).size).toBe(files.length)
    expect(files).toEqual(expect.arrayContaining(['data/metrics.json', 'data/collector.json', 'data/github.json', 'data/vm.json']))
  })
})
