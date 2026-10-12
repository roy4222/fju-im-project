// 總覽頁：三頁入口、三張工具卡、版本卡片（§3.8 補充）。用 fixtures/base 的假資料畫一次。
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import OverviewPage from '@/app/page'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

const fixtures = path.join(import.meta.dirname, '..', 'fixtures', 'base', 'data')

async function render(dataDir: string) {
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  // 側欄與 tooltip 的 provider 在 layout.tsx；頁首的側欄按鈕要它們才畫得出來。
  const page = await OverviewPage()
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>{page}</SidebarProvider>
    </TooltipProvider>,
  )
}

afterEach(() => vi.unstubAllEnvs())

describe('總覽頁', () => {
  it('三頁入口連到 /map、/progress、/go-live', async () => {
    const html = await render(fixtures)
    for (const [id, title] of [['map', '測試地圖'], ['progress', '開發進度'], ['go-live', '能不能上線']]) {
      expect(html).toMatch(new RegExp(`<a(?=[^>]*href="/${id}")(?=[^>]*data-testid="page-${id}")`))
      expect(html).toContain(title)
    }
  })

  it('三張工具卡連到 Access 後面的三個網址', async () => {
    const html = await render(fixtures)
    expect(html).toContain('href="https://fju-status-vm.roy422.dev"')
    expect(html).toContain('href="https://fju-status-logs.roy422.dev"')
    expect(html).toContain('href="https://fju-status-db.roy422.dev"')
    for (const tool of ['Beszel', 'Dozzle', 'PgHero']) expect(html).toContain(tool)
  })

  it('版本卡片：測試站三個 SHA 一致不標黃，正式站落後 main 標黃', async () => {
    const html = await render(fixtures)
    expect(html).toMatch(/data-testid="version-test" data-mismatch="false"/)
    expect(html).toMatch(/data-testid="version-prod" data-mismatch="true"/)
    expect(html).toContain('7162644')
    expect(html).toContain('463931b')
    expect(html).toContain('版本不一致')
  })

  it('collector 還沒有任何資料（或檔案壞掉）時照樣畫得出來，顯示「沒有資料」', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'status-overview-'))
    await writeFile(path.join(empty, 'github.json'), '{壞掉')
    const html = await render(empty)
    expect(html).toContain('還沒有收集器資料')
    expect(html).toContain('沒有資料')
    expect(html).not.toContain('版本不一致')
    expect(html).toContain('data-testid="page-map"')
  })
})
