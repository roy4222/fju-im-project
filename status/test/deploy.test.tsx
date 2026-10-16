// 部署與 CI 頁（AC-DV-20、AC-DV-16 的 /deploy 段、AC-DV-30）：版本卡與 main CI 詳情的正本。
import { readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import DeployPage from '@/app/deploy/page'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { VmData } from '@/lib/data/types'

import { NOW, SCENARIOS, writeScenario, type ScenarioName } from '../fixtures/gate/scenarios'

// AC-DV-30 數 readFile：read.ts 用具名 import，要在模組層換掉才攔得到。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const base = path.join(import.meta.dirname, '..', 'fixtures', 'base', 'data')

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'status-deploy-'))
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

async function render(name: ScenarioName) {
  const { dataDir, acceptanceDir } = await writeScenario(path.join(root, name), SCENARIOS[name]())
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  vi.stubEnv('STATUS_ACCEPTANCE_DIR', acceptanceDir)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  return wrap(await DeployPage())
}

async function renderDir(dataDir: string) {
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  return wrap(await DeployPage())
}

/** 某個區塊的 HTML（到下一個 deploys-/頁尾為止）。 */
const section = (html: string, id: string) => {
  const start = html.indexOf(`data-testid="${id}"`)
  if (start < 0) return ''
  const rest = html.slice(start + 1)
  const end = rest.search(/data-testid="(?:ci-main|image-push|health-cron|deploys-test|deploys-prod)"/)
  return end < 0 ? rest : rest.slice(0, end)
}
const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0

describe('部署與 CI 頁（AC-DV-20）', () => {
  // 搬自 go-live.test.tsx:152-168（衝突表 C2）：斷言不變，只把頁換成 /deploy。
  it('版本卡片：三個 SHA 一致不標黃；正式站部署落後時標黃', async () => {
    const html = await render('a')
    expect(html).toMatch(/data-testid="version-test" data-mismatch="false"/)
    expect(html).toMatch(/data-testid="version-prod" data-mismatch="false"/)
    const s = SCENARIOS.a()
    s.vm!.deploys.prod[0]!.tag = '463931b000000000000000000000000000000000'
    const { dataDir, acceptanceDir } = await writeScenario(path.join(root, 'version'), s)
    vi.stubEnv('STATUS_DATA_DIR', dataDir)
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', acceptanceDir)
    const out = renderToStaticMarkup(
      <TooltipProvider>
        <SidebarProvider>{await DeployPage()}</SidebarProvider>
      </TooltipProvider>,
    )
    expect(out).toMatch(/data-testid="version-prod" data-mismatch="true"/)
    expect(out).toContain('版本不一致')
  })

  it('fixtures/base：版本卡在頁頂、測試站一致、正式站落後標黃', async () => {
    const html = await renderDir(base)
    const at = html.indexOf('data-testid="version-card"')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(html.indexOf('data-testid="ci-main"'))
    expect(html).toMatch(/data-testid="version-test" data-mismatch="false"/)
    expect(html).toMatch(/data-testid="version-prod" data-mismatch="true"/)
    expect(html).toContain('<h1')
    expect(html).toMatch(/<h1[^>]*>部署與 CI<\/h1>/)
    expect(html).not.toContain('data-testid="placeholder"')
  })

  it('fixtures/base：ci-main 有結論、短 SHA、多久前、run 連結、jobs；image-push、health-cron 各一張', async () => {
    const html = await renderDir(base)
    const gh = JSON.parse(readFileSync(path.join(base, 'github.json'), 'utf8'))
    for (const id of ['ci-main', 'image-push', 'health-cron']) expect(count(html, new RegExp(`data-testid="${id}"`, 'g'))).toBe(1)
    const ci = section(html, 'ci-main')
    expect(ci).toContain('data-state="green"')
    expect(ci).toContain('成功')
    expect(ci).toContain(gh.ci.headSha.slice(0, 7))
    expect(ci).toContain(`href="${gh.ci.url}"`)
    expect(ci).toMatch(/收集器 \d+ (?:分鐘|小時)前/)
    for (const job of gh.ci.jobs) expect(ci).toContain(job.name)
    expect(ci).not.toContain('data-testid="ci-failed-jobs"')
    expect(section(html, 'image-push')).toContain(`href="${gh.image.url}"`)
    expect(section(html, 'health-cron')).toContain(`href="${gh.healthCron.url}"`)
  })

  it('fixtures/base：deploys-test、deploys-prod 各一表，列數＝fixture 筆數，欄「時間／tag／digest／結果」', async () => {
    const html = await renderDir(base)
    const vm: VmData = JSON.parse(readFileSync(path.join(base, 'vm.json'), 'utf8'))
    for (const site of ['test', 'prod'] as const) {
      const sec = section(html, `deploys-${site}`)
      expect(sec).toMatch(/<th[^>]*>時間<\/th><th[^>]*>tag<\/th><th[^>]*>digest<\/th><th[^>]*>結果<\/th>/)
      expect(count(sec, /data-testid="deploy-row"/g)).toBe(Math.min(vm.deploys[site].length, 5))
      expect(sec).toContain(vm.deploys[site][0]!.tag!.slice(0, 7))
    }
  })

  it('CI 失敗（情境 b）：ci-main 紅、列出失敗的 job 名', async () => {
    const html = await render('b')
    const ci = section(html, 'ci-main')
    expect(ci).toContain('data-state="red"')
    expect(ci).toMatch(/data-testid="ci-failed-jobs"[^>]*>[^<]*e2e-smoke/)
  })

  it('部署超過 5 筆只列 5 筆；digest 為 null 顯示「—」（collect.test.mjs:340 的情境）', async () => {
    const s = SCENARIOS.a()
    const one = s.vm!.deploys.test[0]!
    s.vm!.deploys.test = Array.from({ length: 7 }, (_, i) => ({ ...one, at: `2026-10-0${i + 1}T00:00:00Z` }))
    s.vm!.deploys.prod = [{ at: '2026-10-09T01:00:00Z', event: 'deployed', tag: 'abc1234', digest: null }]
    const { dataDir } = await writeScenario(path.join(root, 'deploys'), s)
    const html = await renderDir(dataDir)
    expect(count(section(html, 'deploys-test'), /data-testid="deploy-row"/g)).toBe(5)
    const prod = section(html, 'deploys-prod')
    expect(count(prod, /data-testid="deploy-row"/g)).toBe(1)
    expect(prod).toMatch(/<td[^>]*>—<\/td>/)
    expect(prod).not.toContain('sha256:')
  })

  it('沒有任何資料：頁面照常出來，版本卡在、三張卡灰、兩個部署表寫沒有紀錄', async () => {
    const empty = await mkdtemp(path.join(root, 'empty-'))
    const html = await renderDir(empty)
    expect(html).toContain('data-testid="version-card"')
    for (const id of ['ci-main', 'image-push', 'health-cron']) {
      expect(html).toMatch(new RegExp(`data-testid="${id}" data-state="grey"`))
    }
    expect(count(html, /還沒有部署紀錄/g)).toBe(2)
  })
})

describe('部署與 CI 頁讀檔（AC-DV-30）', () => {
  it('一次 render 只讀 github、vm、health 三個檔，各一次', async () => {
    vi.stubEnv('STATUS_DATA_DIR', base)
    const readFile = vi.mocked(fsp.readFile)
    readFile.mockClear()
    wrap(await DeployPage())
    const files = readFile.mock.calls.map(([f]) => path.basename(String(f))).sort()
    expect(files).toEqual(['github.json', 'health.json', 'vm.json'])
  })
})
