// 開發進度頁（AC-S-13）：fixtures/progress 有 4 張票，P1-T13 寫「做中」但 PR #344 已合併。
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProgressPage from '@/app/progress/page'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

const fixtures = path.join(import.meta.dirname, '..', 'fixtures', 'progress', 'data')

async function render(dataDir: string) {
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  const page = await ProgressPage()
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>{page}</SidebarProvider>
    </TooltipProvider>,
  )
}

/** 某張票那一列的 HTML。 */
const row = (html: string, id: string) => html.match(new RegExp(`<tr[^>]*data-testid="ticket-${id}"[\\s\\S]*?</tr>`))?.[0] ?? ''

afterEach(() => vi.unstubAllEnvs())

describe('開發進度頁（AC-S-13）', () => {
  it('依批次分區列出 4 張票', async () => {
    const html = await render(fixtures)
    const p1 = html.indexOf('data-testid="batch-p1"')
    const s = html.indexOf('data-testid="batch-s"')
    expect(p1).toBeGreaterThan(-1)
    expect(s).toBeGreaterThan(p1)
    for (const id of ['P1-T1', 'P1-T13']) {
      const at = html.indexOf(`data-testid="ticket-${id}"`)
      expect(at).toBeGreaterThan(p1)
      expect(at).toBeLessThan(s)
    }
    for (const id of ['S-1', 'S-6']) expect(html.indexOf(`data-testid="ticket-${id}"`)).toBeGreaterThan(s)
    expect(html.match(/data-testid="ticket-/g)).toHaveLength(4)
    expect(html).toContain('第一段修正')
    expect(html).toContain('開發者後台')
  })

  it('狀態顯示中文', async () => {
    const html = await render(fixtures)
    expect(row(html, 'P1-T13')).toContain('做中')
    expect(row(html, 'P1-T1')).toContain('已合併')
    expect(row(html, 'S-6')).toContain('還沒開始')
    expect(html).not.toMatch(/>doing</)
  })

  it('P1-T13 那列黃底、寫「票清單跟 GitHub 對不上」，其他列不標', async () => {
    const html = await render(fixtures)
    const t13 = row(html, 'P1-T13')
    expect(t13).toContain('data-mismatch="true"')
    expect(t13).toContain('bg-yellow-100')
    expect(t13).toContain('票清單跟 GitHub 對不上')
    for (const id of ['P1-T1', 'S-1', 'S-6']) expect(row(html, id)).toContain('data-mismatch="false"')
    expect(html.match(/票清單跟 GitHub 對不上：/g)).toHaveLength(1)
  })

  it('頁頂顯示各狀態張數與票清單 sourceSha', async () => {
    const html = await render(fixtures)
    expect(html).toMatch(/data-testid="count-merged"[^>]*>已合併 2</)
    expect(html).toMatch(/data-testid="count-doing"[^>]*>做中 1</)
    expect(html).toMatch(/data-testid="count-todo"[^>]*>還沒開始 1</)
    expect(html).toMatch(/data-testid="tickets-source-sha"[^>]*>7162644</)
    expect(html).toContain('2026-10-12T08:30:00+08:00')
  })

  it('右側：main 最新 CI 連到 run、最近 5 個合併的 PR', async () => {
    const html = await render(fixtures)
    expect(html).toContain('href="https://github.com/roy4222/fju-im-project/actions/runs/1001"')
    const recent = html.slice(html.indexOf('data-testid="recent-merged"'))
    expect(recent.match(/href="https:\/\/github.com\/roy4222\/fju-im-project\/pull\/\d+"/g)).toHaveLength(5)
  })

  it('沒有資料時照樣畫得出來', async () => {
    const html = await render(path.join(fixtures, 'does-not-exist'))
    expect(html).toContain('還沒有票清單資料')
  })
})
