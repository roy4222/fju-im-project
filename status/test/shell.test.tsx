// 外殼（DV AC-DV-01～04）：側欄八項＋外部工具、深色跟系統、四個占位頁、「驗收地圖」改名。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import BackupPage from '@/app/backup/page'
import DeployPage from '@/app/deploy/page'
import ErrorsPage from '@/app/errors/page'
import GoLivePage from '@/app/go-live/page'
import HealthPage from '@/app/health/page'
import RootLayout, { metadata as layoutMetadata } from '@/app/layout'
import MapPage, { metadata as mapMetadata } from '@/app/map/page'
import OverviewPage from '@/app/page'
import { AppSidebar } from '@/components/app-sidebar'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toolEntries } from '@/lib/data/hosts'

import { NOW, SCENARIOS, writeScenario } from '../fixtures/gate/scenarios'

const fixtures = path.join(import.meta.dirname, '..', 'fixtures')
const baseData = path.join(fixtures, 'base', 'data')

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'status-shell-'))
})
afterAll(() => rm(root, { recursive: true, force: true }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function renderLayout(dataDir: string) {
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  return renderToStaticMarkup(await RootLayout({ children: <main data-testid="content" /> }))
}

/** 包上 layout 裡的 provider，畫一頁的內容。 */
const renderPage = (page: React.ReactNode) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>{page}</SidebarProvider>
    </TooltipProvider>,
  )

/** 依出現順序列出所有 `<a>` 的 href。 */
const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1])

const NAV = ['/', '/health', '/deploy', '/errors', '/backup', '/progress', '/map']
const TOOLS = ['logs', 'db', 'vm'].map((key) => toolEntries().find((t) => t.key === key)!)

describe('AC-DV-01 側欄', () => {
  it('沒有 usage.json：導覽依序七項，沒有使用報表與能不能上線；外部工具 Dozzle、PgHero、Beszel 開新分頁', async () => {
    const html = await renderLayout(baseData)
    // 第一個 <a> 是側欄頂端「開發者後台」回總覽。
    expect(hrefs(html)).toEqual(['/', ...NAV, ...TOOLS.map((t) => t.url)])
    expect(html).not.toContain('href="/usage"')
    expect(html).not.toContain('href="/go-live"')
    expect(html).not.toContain('使用報表')
    for (const [i, title] of ['總覽', '服務健康', '部署與 CI', '錯誤紀錄', '備份與儲存', '開發進度', '驗收地圖'].entries()) {
      expect(html).toMatch(new RegExp(`href="${NAV[i]}"[^>]*>(?:(?!</a>).)*<svg[^>]*lucide(?:(?!</a>).)*${title}`))
    }
    expect(html).toContain('外部工具')
    for (const tool of TOOLS) {
      const a = html.match(new RegExp(`<a\\b[^>]*href="${tool.url}"[^>]*>((?:(?!</a>).)*)</a>`))
      expect(a, tool.tool).not.toBeNull()
      expect(a![0]).toContain('target="_blank"')
      expect(a![0]).toContain('rel="noreferrer"')
      expect(a![1]).toContain('<svg')
      expect(a![1]).toContain(tool.tool)
      expect(a![1]).toContain(tool.title)
    }
    expect(TOOLS.map((t) => t.tool)).toEqual(['Dozzle', 'PgHero', 'Beszel'])
  })

  it('有 usage.json：使用報表出現在備份與儲存和開發進度之間', async () => {
    const dir = await mkdtemp(path.join(root, 'usage-'))
    await writeFile(path.join(dir, 'usage.json'), '{}')
    const html = await renderLayout(dir)
    expect(hrefs(html).slice(0, 9)).toEqual(['/', '/', '/health', '/deploy', '/errors', '/backup', '/usage', '/progress', '/map'])
  })

  it('側欄可收成圖示欄（collapsible="icon"）', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SidebarProvider defaultOpen={false}>
          <AppSidebar nav={{ showUsage: false }} tools={toolEntries()} />
        </SidebarProvider>
      </TooltipProvider>,
    )
    expect(html).toMatch(/data-state="collapsed" data-collapsible="icon"/)
  })
})

describe('AC-DV-02 深色跟系統', () => {
  it('globals.css 用 prefers-color-scheme，不再靠 .dark class', async () => {
    const css = await readFile(path.join(import.meta.dirname, '..', 'src', 'components', 'globals.css'), 'utf8')
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).not.toContain('&:is(.dark *)')
    expect(css).not.toMatch(/^\.dark\s*\{/m)
  })

  it('<html> 宣告 color-scheme: light dark，沒有 .dark class', async () => {
    const html = await renderLayout(baseData)
    const tag = html.match(/<html\b[^>]*>/)![0]
    expect(tag).toMatch(/style="color-scheme:\s*light dark"/)
    expect(tag).not.toMatch(/class="[^"]*\bdark\b/)
  })
})

describe('AC-DV-03 四個占位頁', () => {
  const PAGES = [
    ['服務健康', HealthPage, 'href="/go-live"'],
    ['部署與 CI', DeployPage, '/actions"'],
    ['錯誤紀錄', ErrorsPage, `href="${toolEntries().find((t) => t.key === 'logs')!.url}"`],
    ['備份與儲存', BackupPage, 'href="/go-live"'],
  ] as const
  for (const [title, Page, link] of PAGES) {
    it(`${title}：<h1> 是頁名，內容連到現在的正本`, () => {
      const html = renderPage(<Page />)
      expect(html).toMatch(new RegExp(`<h1[^>]*>${title}</h1>`))
      expect(html).toContain('data-testid="placeholder"')
      expect(html).toContain(link)
    })
  }
})

describe('AC-DV-04 「測試地圖」改名「驗收地圖」', () => {
  it('側欄', async () => {
    const html = await renderLayout(baseData)
    expect(html).toContain('驗收地圖')
    expect(html).not.toContain('測試地圖')
  })

  it('/map：<h1>、<title>、設定版本句、過期黃條', async () => {
    vi.stubEnv('STATUS_DATA_DIR', path.join(fixtures, 'map', 'data'))
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', path.join(fixtures, 'map', 'acceptance'))
    const html = renderPage(await MapPage({ searchParams: Promise.resolve({}) }))
    expect(html).toMatch(/<h1[^>]*>驗收地圖<\/h1>/)
    expect(html).toContain('驗收地圖設定版本')
    expect(html).toContain('data-testid="map-stale"')
    expect(html).toContain('驗收地圖指到不存在的步驟')
    expect(html).not.toContain('測試地圖')
    expect(mapMetadata.title).toBe('驗收地圖')
    expect(layoutMetadata.title).toMatchObject({ template: '%s｜開發者後台' })
  })

  it('/map 沒有設定時的提示', async () => {
    vi.stubEnv('STATUS_DATA_DIR', await mkdtemp(path.join(root, 'no-map-')))
    const html = renderPage(await MapPage({ searchParams: Promise.resolve({}) }))
    expect(html).toContain('還沒有驗收地圖設定')
    expect(html).not.toContain('測試地圖')
  })

  it('/go-live 的 G2 連結字', async () => {
    const { dataDir, acceptanceDir } = await writeScenario(path.join(root, 'go-live'), SCENARIOS.a())
    vi.stubEnv('STATUS_DATA_DIR', dataDir)
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', acceptanceDir)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    const html = renderPage(await GoLivePage())
    expect(html).toMatch(/<a[^>]*href="\/map"[^>]*>看 [^<]+ 的驗收地圖/)
    expect(html).not.toContain('測試地圖')
  })

  it('總覽入口卡', async () => {
    vi.stubEnv('STATUS_DATA_DIR', baseData)
    const html = renderPage(await OverviewPage())
    expect(html).toContain('驗收地圖')
    expect(html).not.toContain('測試地圖')
  })
})
