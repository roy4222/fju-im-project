// 能不能上線頁（AC-S-19）：每個 fixtures 組合寫成真的目錄，讓頁面自己讀檔、判斷、畫出來。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import GoLivePage from '@/app/go-live/page'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

import { NOW, SCENARIOS, writeScenario, type ScenarioName } from '../fixtures/gate/scenarios'

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'status-go-live-'))
})
afterAll(() => rm(root, { recursive: true, force: true }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function render(name: ScenarioName) {
  const { dataDir, acceptanceDir } = await writeScenario(path.join(root, name), SCENARIOS[name]())
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  vi.stubEnv('STATUS_ACCEPTANCE_DIR', acceptanceDir)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  const page = await GoLivePage()
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>{page}</SidebarProvider>
    </TooltipProvider>,
  )
}

const state = (html: string, id: string) => html.match(new RegExp(`data-testid="gate-${id}" data-state="(\\w+)"`))?.[1]
/** 某條卡片的 HTML（到下一條卡片或 </main> 為止）。 */
const card = (html: string, id: string) => {
  const start = html.indexOf(`data-testid="gate-${id}"`)
  const rest = html.slice(start + 1)
  const end = rest.search(/data-testid="gate-G\d"|<\/main>/)
  return rest.slice(0, end)
}
const NOT_YET = /data-can-go-live="false"[\s\S]*還不能上線/

describe('能不能上線頁（AC-S-19）', () => {
  it('(a) 五條全符合 → 五綠、大字「可以上線」', async () => {
    const html = await render('a')
    for (const id of ['G1', 'G2', 'G3', 'G4', 'G5']) expect(state(html, id)).toBe('green')
    expect(html).toMatch(/data-can-go-live="true"[\s\S]*可以上線/)
    expect(html).not.toContain('還不能上線')
  })

  it('(b) G1 紅、寫出 e2e-smoke', async () => {
    const html = await render('b')
    expect(state(html, 'G1')).toBe('red')
    expect(card(html, 'G1')).toContain('e2e-smoke')
    expect(html).toMatch(NOT_YET)
  })

  it('(c) G2 紅、列出沒被同意那筆', async () => {
    const html = await render('c')
    expect(state(html, 'G2')).toBe('red')
    expect(card(html, 'G2')).toContain('S3-02')
    expect(card(html, 'G2')).not.toContain('S3-01')
  })

  it('(d) G2 紅（舊豁免不算）', async () => {
    const html = await render('d')
    expect(state(html, 'G2')).toBe('red')
    expect(card(html, 'G2')).toContain('S3-01')
  })

  it('(e) G4 紅「最新備份 25 小時前」', async () => {
    const html = await render('e')
    expect(state(html, 'G4')).toBe('red')
    expect(card(html, 'G4')).toContain('最新備份 25 小時前')
  })

  it('(f) G5 灰「設定檢查超過 26 小時沒跑」', async () => {
    const html = await render('f')
    expect(state(html, 'G5')).toBe('grey')
    expect(card(html, 'G5')).toContain('設定檢查超過 26 小時沒跑')
    expect(html).toMatch(NOT_YET)
  })

  it('(g) G2 紅「最新一夜只跑了 1／18 項」，不拿前一夜充數', async () => {
    const html = await render('g')
    expect(state(html, 'G2')).toBe('red')
    expect(card(html, 'G2')).toContain('最新一夜只跑了 1／18 項')
  })

  it('(h) G2 紅「環境未完成：story-3 第 N 步」', async () => {
    const html = await render('h')
    expect(state(html, 'G2')).toBe('red')
    expect(card(html, 'G2')).toContain('環境未完成：story-3 第 4 步')
  })

  it('(h2) G2 紅「人設任務沒完成：ux-grader 任務 k」', async () => {
    const html = await render('h2')
    expect(state(html, 'G2')).toBe('red')
    expect(card(html, 'G2')).toContain('人設任務沒完成：ux-grader 任務 3')
  })

  it('(h3) G2 灰「上線政策檔缺失」，不得綠', async () => {
    const html = await render('h3')
    expect(state(html, 'G2')).toBe('grey')
    expect(card(html, 'G2')).toContain('上線政策檔缺失')
    expect(html).toMatch(NOT_YET)
  })

  it('(h4) G2 紅「story-1 缺步驟」「ux-grader 只有 1／4 個任務」', async () => {
    const html = await render('h4')
    expect(state(html, 'G2')).toBe('red')
    expect(card(html, 'G2')).toContain('story-1 缺步驟 0–7')
    expect(card(html, 'G2')).toContain('ux-grader 只有 1／4 個任務')
  })

  it('(h5) 網站失敗有對應「要修」且已豁免 → G2 綠、可以上線', async () => {
    const html = await render('h5')
    expect(state(html, 'G2')).toBe('green')
    expect(html).toMatch(/data-can-go-live="true"/)
  })

  it('(h6) G2 紅、列出那筆沒被同意的「要修」', async () => {
    const html = await render('h6')
    expect(state(html, 'G2')).toBe('red')
    expect(card(html, 'G2')).toContain('要修、沒被同意：story-2 S2-07')
  })

  it('(h7) G2 紅「story-2 第 7 步失敗但沒有登錄問題」', async () => {
    const html = await render('h7')
    expect(state(html, 'G2')).toBe('red')
    expect(card(html, 'G2')).toContain('story-2 第 7 步失敗但沒有登錄問題')
  })

  it('(i) G2 紅「最新一夜沒有彙整結果」', async () => {
    const html = await render('i')
    expect(state(html, 'G2')).toBe('red')
    expect(card(html, 'G2')).toContain('最新一夜沒有彙整結果')
  })

  it('(j) G2 紅、列出 story-2 解析失敗；大字「還不能上線」', async () => {
    const html = await render('j')
    expect(state(html, 'G2')).toBe('red')
    expect(card(html, 'G2')).toContain('story-2 解析失敗')
    expect(html).toMatch(NOT_YET)
  })

  it('G3：collector 判 ok:false（worker 心跳逾時）、六筆都 true → G3 紅、還不能上線', async () => {
    const s = SCENARIOS.a()
    s.health!.test!.ok = false
    s.health!.test!.reason = 'worker 心跳 600 秒前'
    const { dataDir, acceptanceDir } = await writeScenario(path.join(root, 'g3-not-ok'), s)
    vi.stubEnv('STATUS_DATA_DIR', dataDir)
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', acceptanceDir)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SidebarProvider>{await GoLivePage()}</SidebarProvider>
      </TooltipProvider>,
    )
    expect(state(html, 'G3')).toBe('red')
    expect(card(html, 'G3')).toContain('worker 心跳 600 秒前')
    expect(html).toMatch(NOT_YET)
  })

  it('完全沒有資料時五條都灰、還不能上線', async () => {
    vi.stubEnv('STATUS_DATA_DIR', path.join(root, 'nothing', 'data'))
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', path.join(root, 'nothing', 'acceptance'))
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SidebarProvider>{await GoLivePage()}</SidebarProvider>
      </TooltipProvider>,
    )
    for (const id of ['G1', 'G2', 'G3', 'G4', 'G5']) expect(state(html, id)).toBe('grey')
    expect(html).toMatch(NOT_YET)
  })

  it('AC-DV-10：沒有補充資訊卡與版本卡；tested-commit 在 G2 卡、30 分鐘句在 G3 卡、G5 卡沒有「自己確認」', async () => {
    const html = await render('a')
    expect(html).not.toContain('補充資訊')
    expect(html).not.toContain('data-testid="version-card"')
    expect(card(html, 'G2')).toMatch(/data-testid="tested-commit">最近一次完整驗收：[^<，]+，測的是 [0-9a-f]{7}；main 目前是 [0-9a-f]{7}/)
    expect(card(html, 'G3')).toContain('30 分鐘內有過失敗算資料不夠')
    expect(card(html, 'G5')).not.toContain('自己確認')
  })

  it('AC-DV-09：沒有 A 記錄 → G5 紅、卡上寫出 host；沒有 DNS 資料 → G5 灰', async () => {
    const s = SCENARIOS.a()
    s.vm!.prodDns!.hasA = false
    let { dataDir, acceptanceDir } = await writeScenario(path.join(root, 'dns-no-a'), s)
    vi.stubEnv('STATUS_DATA_DIR', dataDir)
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', acceptanceDir)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    const red = renderToStaticMarkup(
      <TooltipProvider>
        <SidebarProvider>{await GoLivePage()}</SidebarProvider>
      </TooltipProvider>,
    )
    expect(state(red, 'G5')).toBe('red')
    expect(card(red, 'G5')).toContain('fju.roy422.dev 沒有 A 記錄')
    expect(red).toMatch(NOT_YET)

    const g = SCENARIOS.a()
    delete g.vm!.prodDns
    ;({ dataDir, acceptanceDir } = await writeScenario(path.join(root, 'dns-missing'), g))
    vi.stubEnv('STATUS_DATA_DIR', dataDir)
    vi.stubEnv('STATUS_ACCEPTANCE_DIR', acceptanceDir)
    const grey = renderToStaticMarkup(
      <TooltipProvider>
        <SidebarProvider>{await GoLivePage()}</SidebarProvider>
      </TooltipProvider>,
    )
    expect(state(grey, 'G5')).toBe('grey')
    expect(card(grey, 'G5')).toContain('DNS 檢查沒有資料')
  })
})
