// 錯誤紀錄頁（AC-DV-21、AC-DV-30）：collector 來源表、只列失敗類的事件、每筆一顆 Dozzle 連結。
import * as fsp from 'node:fs/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import ErrorsPage from '@/app/errors/page'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CollectorStatus } from '@/lib/data/types'

import { NOW, SCENARIOS, writeScenario, type Scenario } from '../fixtures/gate/scenarios'

// AC-DV-30 數 readFile：read.ts 用具名 import，要在模組層換掉才攔得到。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const base = path.join(import.meta.dirname, '..', 'fixtures', 'base', 'data')
const LOGS = 'https://fju-status-logs.roy422.dev'
const AT = '2026-10-12T09:00:00+08:00'
const SHA = '7162644000000000000000000000000000000000'

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'status-errors-'))
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

const collector = (over: CollectorStatus['sources'] = {}): CollectorStatus => ({
  generatedAt: AT,
  sources: Object.fromEntries(
    ['github', 'repo', 'health', 'vm', 'acceptance'].map((k) => [k, over[k] ?? { ok: true, at: AT, error: null }]),
  ),
})

async function renderScenario(name: string, s: Scenario, col: CollectorStatus | null = collector()) {
  const { dataDir, acceptanceDir } = await writeScenario(path.join(root, name), s)
  if (col) await writeFile(path.join(dataDir, 'collector.json'), JSON.stringify(col))
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  vi.stubEnv('STATUS_ACCEPTANCE_DIR', acceptanceDir)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  return wrap(await ErrorsPage())
}

/** AC-DV-15 的 tmp 目錄：兩站各 3 筆部署（1 筆失敗）、正式站備份失敗、github 來源失敗、CI failure、驗收一夜跑完。 */
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
const AC15_COLLECTOR = collector({ github: { ok: false, at: '2026-10-12T08:50:00+08:00', error: 'HTTP 403' } })

/** 某個區塊的 HTML（到下一個區塊為止）。 */
const section = (html: string, id: string) => {
  const start = html.indexOf(`data-testid="${id}"`)
  if (start < 0) return ''
  const rest = html.slice(start + 1)
  const end = rest.search(/data-testid="(?:source-table|event-list)"/)
  return end < 0 ? rest : rest.slice(0, end)
}
const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0
/** event-list 每一列的 HTML。 */
const eventRows = (html: string) => section(html, 'event-list').split('data-testid="event-row"').slice(1)

describe('錯誤紀錄頁（AC-DV-21）', () => {
  it('頂部「開 Dozzle」開新分頁到 logs 根網址；說明句；不是占位頁', async () => {
    const html = await renderScenario('top', ac15(), AC15_COLLECTOR)
    expect(html).toMatch(/<h1[^>]*>錯誤紀錄<\/h1>/)
    expect(html).not.toContain('data-testid="placeholder"')
    expect(html).toMatch(new RegExp(`<a href="${LOGS}" target="_blank" rel="noreferrer" data-testid="open-dozzle"[^>]*>開 Dozzle</a>`))
    expect(html).toContain('這頁只看收集器知道的失敗')
  })

  it('source-table 五列 github／repo／health／vm／acceptance；github 列 data-ok="false"、顯示錯誤字串與時間', async () => {
    const html = await renderScenario('sources', ac15(), AC15_COLLECTOR)
    const table = section(html, 'source-table')
    const names = [...table.matchAll(/data-testid="source-row" data-source="([a-z]+)" data-ok="(true|false)"/g)].map((m) => `${m[1]}:${m[2]}`)
    expect(names).toEqual(['github:false', 'repo:true', 'health:true', 'vm:true', 'acceptance:true'])
    const github = table.slice(table.indexOf('data-source="github"'), table.indexOf('data-source="repo"'))
    expect(github).toContain('HTTP 403')
    expect(github).toContain('10/12 08:50')
  })

  it('DV-12 之後多一個 metrics 來源：接在五列後面，第六列', async () => {
    const col = collector()
    col.sources.metrics = { ok: false, at: AT, error: 'HTTP 502' }
    const html = await renderScenario('metrics', SCENARIOS.a(), col)
    const names = [...section(html, 'source-table').matchAll(/data-source="([a-z]+)"/g)].map((m) => m[1])
    expect(names).toEqual(['github', 'repo', 'health', 'vm', 'acceptance', 'metrics'])
  })

  it('event-list 只有失敗類：部署失敗、備份失敗、來源失敗、CI 失敗＝4 列；每列一顆 Dozzle 連結', async () => {
    const html = await renderScenario('events', ac15(), AC15_COLLECTOR)
    const list = section(html, 'event-list')
    const kinds = [...list.matchAll(/data-testid="event-row" data-kind="([a-z-]+)"/g)].map((m) => m[1])
    expect(kinds.sort()).toEqual(['backup', 'ci-fail', 'deploy', 'source-fail'])
    expect(eventRows(html)).toHaveLength(4)
    for (const r of eventRows(html)) {
      expect(r).toMatch(new RegExp(`<a href="${LOGS}(?:/show\\?name=[a-z0-9-]+)?" target="_blank" rel="noreferrer" data-testid="event-dozzle"`))
    }
    expect(list).toContain(`href="${LOGS}/show?name=fju-status-collector-1"`)
    expect(list).toContain(`href="${LOGS}/show?name=fju-test-app"`)
    expect(list).toContain(`href="${LOGS}/show?name=fju-prod-postgres"`)
    // 成功的部署、備份與驗收跑完不列
    expect(list).not.toContain('（成功）')
    expect(list).not.toContain('驗收 full')
    // 類型字只在七種內
    expect(list).toMatch(/<td[^>]*>CI 失敗<\/td>/)
    expect(list).toMatch(/<td[^>]*>來源失敗<\/td>/)
  })

  it('最多 50 列（塞 60 筆失敗部署）', async () => {
    const s = SCENARIOS.a()
    s.vm!.deploys.test = Array.from({ length: 60 }, (_, i) => ({
      at: new Date(Date.parse(AT) - i * 60_000).toISOString(),
      event: 'rolled-back',
      tag: SHA,
      digest: null,
    }))
    const html = await renderScenario('cap', s)
    expect(count(section(html, 'event-list'), /data-testid="event-row"/g)).toBe(50)
  })

  it('全部正常：沒有事件列、寫「最近沒有失敗」', async () => {
    const html = await renderScenario('green', SCENARIOS.a())
    expect(count(html, /data-testid="event-row"/g)).toBe(0)
    expect(section(html, 'event-list')).toContain('最近沒有失敗')
    expect(count(html, /data-ok="false"/g)).toBe(0)
  })

  it('沒有任何資料：頁面照常出來、來源表寫沒有資料、沒有事件', async () => {
    const empty = await mkdtemp(path.join(root, 'empty-'))
    vi.stubEnv('STATUS_DATA_DIR', empty)
    const html = wrap(await ErrorsPage())
    expect(html).toContain('data-testid="open-dozzle"')
    expect(section(html, 'source-table')).toContain('沒有收集器資料')
    expect(section(html, 'event-list')).toContain('最近沒有失敗')
  })

  it('fixtures/base：五個來源都正常', async () => {
    vi.stubEnv('STATUS_DATA_DIR', base)
    const html = wrap(await ErrorsPage())
    expect(count(section(html, 'source-table'), /data-ok="true"/g)).toBe(5)
  })
})

describe('錯誤紀錄頁讀檔（AC-DV-30）', () => {
  it('一次 render 只讀 collector、health、github、vm、acceptance-index 五個檔，各一次', async () => {
    vi.stubEnv('STATUS_DATA_DIR', base)
    const readFile = vi.mocked(fsp.readFile)
    readFile.mockClear()
    wrap(await ErrorsPage())
    const files = readFile.mock.calls.map(([f]) => path.basename(String(f))).sort()
    expect(files).toEqual(['acceptance-index.json', 'collector.json', 'github.json', 'health.json', 'vm.json'])
  })
})
