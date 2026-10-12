// 測試地圖頁與截圖路由（AC-S-15～18）。用 fixtures/map 的假資料畫一次、直接呼叫路由。
import { link, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MapPage from '@/app/map/page'
import { GET } from '@/app/shots/[...path]/route'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

const fixtures = path.join(import.meta.dirname, '..', 'fixtures', 'map')
const RUN = 'night-20261012-2200'

beforeEach(() => {
  vi.stubEnv('STATUS_DATA_DIR', path.join(fixtures, 'data'))
  vi.stubEnv('STATUS_ACCEPTANCE_DIR', path.join(fixtures, 'acceptance'))
})
afterEach(() => vi.unstubAllEnvs())

async function render(params: Record<string, string> = {}) {
  // 頁面是 async Server Component：先 await 拿到元素再渲染。
  const page = await MapPage({ searchParams: Promise.resolve(params) })
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>{page}</SidebarProvider>
    </TooltipProvider>,
  )
}

/** 某個 data-testid 元素的開頭標籤＋到下一個同層標籤前的內容（夠用來核對一格）。 */
function cellHtml(html: string, testId: string) {
  const start = html.indexOf(`data-testid="${testId}"`)
  expect(start, `找不到 ${testId}`).toBeGreaterThan(-1)
  return html.slice(start, html.indexOf('</td>', start))
}

/** 某個 data-testid 元素的整個開頭標籤。 */
function openTag(html: string, testId: string) {
  const m = new RegExp(`<[a-z]+(?=[^>]*data-testid="${testId}")[^>]*>`).exec(html)
  expect(m, `找不到 ${testId}`).not.toBeNull()
  return m![0]
}

const shot = (...segments: string[]) =>
  GET(new Request(`http://localhost/shots/${segments.join('/')}`), { params: Promise.resolve({ path: segments }) })

describe('AC-S-15 角色 × 功能格子', () => {
  it('「最新公告」：訪客 ✅、學生 ⚠️、老師 ⬜、系辦 ⚠️（同步驟有要修）', async () => {
    const html = await render()
    expect(cellHtml(html, 'cell-news-visitor')).toContain('data-status="ok"')
    expect(cellHtml(html, 'cell-news-visitor')).toContain('✅ 有點過')
    expect(cellHtml(html, 'cell-news-student')).toContain('⚠️ 有狀況')
    expect(cellHtml(html, 'cell-news-teacher')).toContain('⬜ 沒測到')
    expect(cellHtml(html, 'cell-news-admin')).toContain('⚠️ 有狀況')
  })

  it('不適用的角色格顯示「—」', async () => {
    const html = await render()
    expect(cellHtml(html, 'cell-roster-visitor')).toMatch(/data-status="na"[^>]*>—$/)
  })

  it('「名單匯入」只指到解析失敗的 story-5：有步驟的格全是 ⚠️「報告解析失敗」，沒有任何 ✅', async () => {
    const html = await render()
    for (const role of ['student', 'admin']) {
      expect(cellHtml(html, `cell-roster-${role}`)).toContain('⚠️ 報告解析失敗')
    }
    const row = html.slice(html.indexOf('data-testid="feature-roster"'), html.indexOf('</tr>', html.indexOf('data-testid="feature-roster"')))
    expect(row).not.toContain('✅')
  })

  it('對不到別名的角色字串列在頁尾', async () => {
    const html = await render()
    expect(html).toContain('data-testid="map-unknown-roles"')
    expect(html).toContain('「神秘訪客」')
  })
})

describe('AC-S-16 點格子開抽屜', () => {
  it('訪客 ✅：列出 2 步（步驟號、結果、看到什麼、截圖縮圖），縮圖連到原圖，自動測試連 GitHub', async () => {
    const html = await render({ f: 'news', r: 'visitor' })
    expect(html).toContain('data-testid="cell-drawer"')
    expect(html.match(/data-testid="drawer-step"/g)).toHaveLength(2)
    expect(html).toContain('story-1 第 1 步')
    expect(html).toContain('story-1 第 2 步')
    expect(html).toContain('看到什麼：首頁最新公告區有三則公告')
    expect(html).toContain(`href="/shots/${RUN}/story-1/screenshots/01-home.png"`)
    expect(html).toContain(`src="/shots/${RUN}/story-1/screenshots/01-home.png"`)
    expect(html).toContain('href="https://github.com/roy4222/fju-im-project/blob/main/web/e2e/public-pages.spec.ts"')
    expect(html).not.toContain('drawer-parse-failed')
  })

  it('縮圖連到的原圖 /shots/… 回 200 與圖片', async () => {
    const res = await shot(RUN, 'story-1', 'screenshots', '01-home.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]) // "PNG"
  })

  it('「名單匯入」⚠️：抽屜頂端「story-5 報告解析失敗：問題表欄數不對」，步驟照列並標明問題清單不可信', async () => {
    const html = await render({ f: 'roster', r: 'admin' })
    expect(html).toContain('data-testid="drawer-parse-failed"')
    expect(html).toContain('story-5 報告解析失敗：問題表欄數不對')
    expect(html.match(/data-testid="drawer-step"/g)).toHaveLength(2)
    expect(html).toContain('問題清單不可信')
    expect(html.indexOf('drawer-parse-failed')).toBeLessThan(html.indexOf('drawer-step'))
  })

  it('系辦 ⚠️ 的抽屜列出同步驟的「要修」問題', async () => {
    const html = await render({ f: 'news', r: 'admin' })
    expect(html).toContain('S1-01 發公告後沒有提示成功')
  })

  it('沒點格子、點到不適用的格或不存在的功能：不開抽屜', async () => {
    expect(await render()).not.toContain('cell-drawer')
    expect(await render({ f: 'roster', r: 'visitor' })).not.toContain('cell-drawer')
    expect(await render({ f: 'nope', r: 'admin' })).not.toContain('cell-drawer')
  })
})

describe('AC-S-17 地圖過期黃條與「前台每一區」', () => {
  it('頁頂黃條列出「story-2 第 99 步」', async () => {
    const html = await render()
    expect(html).toContain('data-testid="map-stale"')
    expect(html).toMatch(/data-testid="map-stale"[^>]*>[^<]*story-2 第 99 步/)
  })

  it('adminPage 是 null 且沒有 exception：該列紅底、文字「前台有這區但沒有後台」', async () => {
    const html = await render()
    const tag = openTag(html, 'section-showcase-gallery')
    expect(tag).toContain('data-missing-admin="true"')
    expect(tag).toContain('bg-red-100')
    const row = html.slice(html.indexOf('data-testid="section-showcase-gallery"'))
    expect(row.slice(0, row.indexOf('</tr>'))).toContain('前台有這區但沒有後台')
  })

  it('exception 有值的列（系辦聯絡卡）顯示例外原因、不標紅', async () => {
    const html = await render()
    const tag = openTag(html, 'section-home-contact')
    expect(tag).toContain('data-missing-admin="false"')
    expect(tag).not.toContain('bg-red')
    const row = html.slice(html.indexOf('data-testid="section-home-contact"'))
    expect(row.slice(0, row.indexOf('</tr>'))).toContain('例外：Q18：用程式改，不做後台')
  })

  it('有後台的列連到測試站該頁，前台測過取各角色最差、後台測過取系辦格', async () => {
    const html = await render()
    const row = html.slice(html.indexOf('data-testid="section-home-news"'))
    const tr = row.slice(0, row.indexOf('</tr>'))
    expect(tr).toContain('href="https://test.fju.roy422.dev/dashboard/admin/affairs"')
    expect(tr).toContain('新增：有　編輯：有　刪除：只能下架')
    expect(tr.match(/⚠️ 有狀況/g)).toHaveLength(2)
  })
})

describe('AC-S-18 截圖路由只服務 summary.json 列到的檔', () => {
  it('截圖在 inbox 裡但沒被 summary.json 列到 → 404', async () => {
    expect((await shot(RUN, 'story-1', 'screenshots', '99-unlisted.png')).status).toBe(404)
  })

  it('路徑穿越 /shots/<run>/../../secrets/tunnel.json → 404', async () => {
    expect((await shot(RUN, '..', '..', 'secrets', 'tunnel.json')).status).toBe(404)
    expect((await shot(RUN, '..', 'screenshots', 'tunnel.json')).status).toBe(404)
    expect((await shot('..', 'secrets', 'screenshots', 'tunnel.json')).status).toBe(404)
  })

  it('runId 不在 acceptance-index.runs → 404（就算目錄與 summary 都在）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'status-shots-'))
    await mkdir(path.join(dir, 'night-x', 'story-1', 'screenshots'), { recursive: true })
    await writeFile(path.join(dir, 'night-x', 'story-1', 'screenshots', 'a.png'), 'x')
    await writeFile(
      path.join(dir, 'night-x', 'summary.json'),
      JSON.stringify({ items: [{ id: 'story-1', steps: [{ 截圖: ['story-1/screenshots/a.png'] }] }] }),
    )
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', dir)
    expect((await shot('night-x', 'story-1', 'screenshots', 'a.png')).status).toBe(404)
  })

  it('列到的圖是 symlink、指到同一夜沒列到的 JSON → 404，不吐內容', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'status-shots-'))
    const shots = path.join(dir, RUN, 'story-1', 'screenshots')
    await mkdir(shots, { recursive: true })
    await writeFile(path.join(dir, RUN, 'run.json'), '{"secret":"run-json-content"}')
    await symlink(path.join('..', '..', 'run.json'), path.join(shots, 'a.png'))
    await writeFile(
      path.join(dir, RUN, 'summary.json'),
      JSON.stringify({ items: [{ id: 'story-1', steps: [{ 截圖: ['story-1/screenshots/a.png'] }] }] }),
    )
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', dir)
    const res = await shot(RUN, 'story-1', 'screenshots', 'a.png')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('run-json-content')
  })

  it('整夜的目錄是 symlink、指到 acceptance 外面 → 404', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'status-outside-'))
    await mkdir(path.join(outside, 'story-1', 'screenshots'), { recursive: true })
    await writeFile(path.join(outside, 'story-1', 'screenshots', 'a.png'), 'outside-content')
    await writeFile(
      path.join(outside, 'summary.json'),
      JSON.stringify({ items: [{ id: 'story-1', steps: [{ 截圖: ['story-1/screenshots/a.png'] }] }] }),
    )
    const dir = await mkdtemp(path.join(tmpdir(), 'status-shots-'))
    await symlink(outside, path.join(dir, RUN))
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', dir)
    const res = await shot(RUN, 'story-1', 'screenshots', 'a.png')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('outside-content')
  })

  it('中間的 item 或 screenshots 目錄是 symlink → 404', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'status-shots-'))
    const real = path.join(dir, RUN, 'real-shots')
    await mkdir(real, { recursive: true })
    await writeFile(path.join(real, 'a.png'), 'x')
    await mkdir(path.join(dir, RUN, 'story-1'))
    await symlink(real, path.join(dir, RUN, 'story-1', 'screenshots'))
    await writeFile(
      path.join(dir, RUN, 'summary.json'),
      JSON.stringify({ items: [{ id: 'story-1', steps: [{ 截圖: ['story-1/screenshots/a.png'] }] }] }),
    )
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', dir)
    expect((await shot(RUN, 'story-1', 'screenshots', 'a.png')).status).toBe(404)
  })

  it('列到的圖是硬連結、連到同一夜的 run.json → 404，不吐內容', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'status-shots-'))
    const shots = path.join(dir, RUN, 'story-1', 'screenshots')
    await mkdir(shots, { recursive: true })
    await writeFile(path.join(dir, RUN, 'run.json'), '{"secret":"run-json-content"}')
    await link(path.join(dir, RUN, 'run.json'), path.join(shots, 'a.png'))
    await writeFile(
      path.join(dir, RUN, 'summary.json'),
      JSON.stringify({ items: [{ id: 'story-1', steps: [{ 截圖: ['story-1/screenshots/a.png'] }] }] }),
    )
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', dir)
    const res = await shot(RUN, 'story-1', 'screenshots', 'a.png')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('run-json-content')
  })

  it('列到的圖是硬連結、連到 acceptance 外面的檔案 → 404，不吐內容', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'status-outside-'))
    await writeFile(path.join(outside, 'tunnel.json'), '{"secret":"outside-content"}')
    const dir = await mkdtemp(path.join(tmpdir(), 'status-shots-'))
    const shots = path.join(dir, RUN, 'story-1', 'screenshots')
    await mkdir(shots, { recursive: true })
    await link(path.join(outside, 'tunnel.json'), path.join(shots, 'a.png'))
    await writeFile(
      path.join(dir, RUN, 'summary.json'),
      JSON.stringify({ items: [{ id: 'story-1', steps: [{ 截圖: ['story-1/screenshots/a.png'] }] }] }),
    )
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', dir)
    const res = await shot(RUN, 'story-1', 'screenshots', 'a.png')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('outside-content')
  })

  it('列到了但檔案不存在 → 404', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'status-shots-'))
    await mkdir(path.join(dir, RUN), { recursive: true })
    await writeFile(
      path.join(dir, RUN, 'summary.json'),
      JSON.stringify({ items: [{ id: 'story-1', steps: [{ 截圖: ['story-1/screenshots/gone.png'] }] }] }),
    )
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', dir)
    expect((await shot(RUN, 'story-1', 'screenshots', 'gone.png')).status).toBe(404)
  })
})

describe('資料不夠時照樣畫得出來', () => {
  it('最新一夜沒有 summary.json：整張地圖顯示「最新一夜沒有彙整結果」，不回退；前台每一區照列', async () => {
    const acceptance = await mkdtemp(path.join(tmpdir(), 'status-map-'))
    await mkdir(path.join(acceptance, RUN))
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', acceptance)
    const html = await render({ f: 'news', r: 'visitor' })
    expect(html).toContain('最新一夜沒有彙整結果')
    expect(html).not.toContain('data-testid="map-matrix"')
    expect(html).not.toContain('cell-drawer')
    expect(openTag(html, 'section-showcase-gallery')).toContain('data-missing-admin="true"')
  })

  it('沒有 test-map.json：提示還沒有設定', async () => {
    vi.stubEnv('STATUS_DATA_DIR', await mkdtemp(path.join(tmpdir(), 'status-map-')))
    expect(await render()).toContain('還沒有測試地圖設定')
  })

  it('從來沒有 full 驗收：標題寫「還沒有任何完整驗收」', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'status-map-'))
    await mkdir(path.join(data, 'repo'))
    const { readFile } = await import('node:fs/promises')
    await writeFile(path.join(data, 'repo', 'test-map.json'), await readFile(path.join(fixtures, 'data', 'repo', 'test-map.json')))
    await writeFile(path.join(data, 'acceptance-index.json'), JSON.stringify({ runs: [], latestFullAttempt: null }))
    vi.stubEnv('STATUS_DATA_DIR', data)
    const html = await render()
    expect(html).toContain('還沒有任何完整驗收')
    expect(html).not.toContain('map-matrix')
  })
})
