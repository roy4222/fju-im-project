// 使用報表頁（AC-DV-23、24、25、30）：usage.json 不在就整頁 404、側欄不出現；在就照 range／role 算。
import { readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import RootLayout from '@/app/layout'
import UsagePage from '@/app/usage/page'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { UsageReport } from '@/lib/data/types'
import { actionLabel } from '@/lib/usage/actions'
import { summarize } from '@/lib/usage/usage'

// AC-DV-30 數 readFile、AC-DV-23 數 stat：read.ts 與 layout.tsx 用具名 import，要在模組層換掉才攔得到。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) }
})

const fixtures = path.join(import.meta.dirname, '..', 'fixtures')
const base = path.join(fixtures, 'base', 'data')
const usageDir = path.join(fixtures, 'usage', 'data')
const fixtureReport = (): UsageReport => JSON.parse(readFileSync(path.join(usageDir, 'usage.json'), 'utf8'))

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'status-usage-'))
})
afterAll(() => rm(root, { recursive: true, force: true }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

async function render(dataDir: string, params: Record<string, string> = {}) {
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  const page = await UsagePage({ searchParams: Promise.resolve(params) })
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>{page}</SidebarProvider>
    </TooltipProvider>,
  )
}

async function renderLayout(dataDir: string) {
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  return renderToStaticMarkup(await RootLayout({ children: <main /> }))
}

/** 某個 data-testid 元素開始、到它對應的結束標籤為止（同名標籤不巢狀時夠用）。 */
function block(html: string, id: string): string {
  const start = html.search(new RegExp(`<(\\w+)[^>]*data-testid="${id}"`))
  if (start < 0) return ''
  const tag = html.slice(start + 1).match(/^\w+/)![0]
  const end = html.indexOf(`</${tag}>`, start)
  return html.slice(start, end + tag.length + 3)
}
/** active-users 卡裡的數字。 */
const cardValue = (html: string, role: string) => {
  const start = html.indexOf(`data-testid="active-users-${role}"`)
  return html.slice(start).match(/data-testid="active-users-value"[^>]*>([^<]*)</)?.[1]
}
const anchors = (html: string) => [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map((m) => ({ attrs: m[1]!, text: m[2]! }))
const barActions = (html: string) => [...block(html, 'usage-bar-chart').matchAll(/<rect data-action="([^"]+)"/g)].map((m) => m[1])

describe('AC-DV-23 沒有 usage.json', () => {
  it('/usage 與帶參數都 404（notFound），側欄沒有使用報表', async () => {
    for (const params of [{}, { range: '7d' }, { range: 'term', role: 'teacher' }] as Record<string, string>[]) {
      await expect(render(base, params)).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_HTTP_ERROR_FALLBACK;404') })
    }
    const html = await renderLayout(base)
    expect(html).not.toContain('href="/usage"')
    expect(html).not.toContain('使用報表')
  })

  it('layout 對 usage.json 只做一次 stat、不讀內容', async () => {
    await renderLayout(base)
    const calls = vi.mocked(fsp.stat).mock.calls.map(([f]) => String(f))
    expect(calls.filter((f) => f.endsWith('usage.json'))).toEqual([path.join(base, 'usage.json')])
    expect(vi.mocked(fsp.readFile).mock.calls.map(([f]) => String(f)).filter((f) => f.endsWith('usage.json'))).toEqual([])
  })
})

describe('AC-DV-24 有 usage.json（fixtures/usage/data）', () => {
  it('fixture：120 天 × 3 角色、約 40 筆 actions、含改密碼、3 個 count30d:0', () => {
    const r = fixtureReport()
    expect(r.daily).toHaveLength(360)
    expect(r.actions.length).toBeGreaterThanOrEqual(38)
    expect(r.actions.some((a) => a.action === 'account.change_password')).toBe(true)
    expect(r.actions.filter((a) => a.count30d === 0)).toHaveLength(3)
  })

  it('側欄多出「使用報表」', async () => {
    const html = await renderLayout(usageDir)
    expect(html).toContain('href="/usage"')
    expect(html).toContain('使用報表')
  })

  it('預設 7 天：分段鈕三個 <a href="?range=…">、目前那個 aria-current；角色 chips 四個 <a>', async () => {
    const html = await render(usageDir)
    expect(html).toMatch(/<h1[^>]*>使用報表<\/h1>/)
    const range = anchors(block(html, 'usage-range'))
    expect(range.map((a) => a.text)).toEqual(['7 天', '30 天', '本學期'])
    expect(range.map((a) => a.attrs.match(/href="([^"]*)"/)?.[1])).toEqual(['?range=7d', '?range=30d', '?range=term'])
    expect(range.map((a) => a.attrs.includes('aria-current="page"'))).toEqual([true, false, false])
    const roles = anchors(block(html, 'usage-role'))
    expect(roles.map((a) => a.text)).toEqual(['全部', '學生', '老師', '系辦'])
    expect(roles.map((a) => a.attrs.match(/href="([^"]*)"/)?.[1])).toEqual([
      '?range=7d',
      '?range=7d&amp;role=student',
      '?range=7d&amp;role=teacher',
      '?range=7d&amp;role=admin',
    ])
    expect(roles.map((a) => a.attrs.includes('aria-current="page"'))).toEqual([true, false, false, false])
    expect(html).toContain('統計範圍：已登入使用者・每日去重')
  })

  it('30 天：三張每日活躍人數卡＝範圍內 daily.activeUsers 平均（整數）', async () => {
    const r = fixtureReport()
    const html = await render(usageDir, { range: '30d' })
    expect(anchors(block(html, 'usage-range')).find((a) => a.attrs.includes('aria-current'))?.text).toBe('30 天')
    const days = new Set([...new Set(r.daily.map((d) => d.day))].sort().slice(-30))
    for (const role of ['student', 'teacher', 'admin'] as const) {
      const rows = r.daily.filter((d) => d.role === role && days.has(d.day))
      expect(rows).toHaveLength(30)
      const avg = Math.round(rows.reduce((s, d) => s + d.activeUsers, 0) / rows.length)
      expect(cardValue(html, role)).toBe(avg.toLocaleString('en-US'))
    }
    expect(block(html, 'active-users')).toContain('每日活躍人數')
  })

  it('30 天：長條圖是 <svg>、前 15 個 action 依 count30d 排、白話名、對不到的顯示原代碼', async () => {
    const r = fixtureReport()
    const html = await render(usageDir, { range: '30d' })
    const chart = block(html, 'usage-bar-chart')
    expect(chart.startsWith('<svg')).toBe(true)
    const totals = new Map<string, number>()
    for (const a of r.actions) totals.set(a.action, (totals.get(a.action) ?? 0) + a.count30d)
    // 同次數依代碼排（item.create 與 showcase.draft_create 都是 150）
    const expected = [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 15)
    expect(barActions(html)).toEqual(expected.map(([action]) => action))
    expect(chart).toContain('>交作業<')
    expect(chart).toContain(`>${actionLabel('grading.return')}<`)
    expect(chart).toContain('>experiment.preview_toggle<')
    expect(chart).toContain(`>${expected[0]![1].toLocaleString('en-US')}<`)
  })

  it('30 天：很少用的功能列範圍內 count ≤ 2（含 0 的三個）', async () => {
    const r = fixtureReport()
    const html = await render(usageDir, { range: '30d' })
    const table = block(html, 'rare-features')
    const rows = [...table.matchAll(/<tr data-action="([^"]+)"/g)].map((m) => m[1])
    const totals = new Map<string, number>()
    for (const a of r.actions) totals.set(a.action, (totals.get(a.action) ?? 0) + a.count30d)
    expect(new Set(rows)).toEqual(new Set([...totals].filter(([, c]) => c <= 2).map(([a]) => a)))
    for (const zero of r.actions.filter((a) => a.count30d === 0)) expect(rows).toContain(zero.action)
    // 改密碼三個角色加總 > 2，不在表裡
    expect(rows).not.toContain('account.change_password')
    expect(table).toContain('>建立屆別<')
  })

  it('本學期＋老師：分段鈕帶 role、只有老師卡有數字、長條圖只算老師列（Q-DV-7 定案：8/1 起算）', async () => {
    const r = fixtureReport()
    const html = await render(usageDir, { range: 'term', role: 'teacher' })
    const range = anchors(block(html, 'usage-range'))
    expect(range.map((a) => a.attrs.match(/href="([^"]*)"/)?.[1])).toEqual([
      '?range=7d&amp;role=teacher',
      '?range=30d&amp;role=teacher',
      '?range=term&amp;role=teacher',
    ])
    expect(range.find((a) => a.attrs.includes('aria-current'))?.text).toBe('本學期')
    expect(anchors(block(html, 'usage-role')).find((a) => a.attrs.includes('aria-current'))?.text).toBe('老師')
    expect(block(html, 'usage-window')).toContain('2026-08-01 — 2026-10-12')

    const term = r.daily.filter((d) => d.role === 'teacher' && d.day >= '2026-08-01')
    expect(term).toHaveLength(73)
    expect(cardValue(html, 'teacher')).toBe(String(Math.round(term.reduce((s, d) => s + d.activeUsers, 0) / term.length)))
    expect(cardValue(html, 'student')).toBe('—')
    expect(cardValue(html, 'admin')).toBe('—')

    const teacher = r.actions
      .filter((a) => a.role === 'teacher')
      .sort((a, b) => b.countTerm - a.countTerm)
      .slice(0, 15)
    expect(barActions(html)).toEqual(teacher.map((a) => a.action))
    expect(block(html, 'usage-bar-chart')).toContain(`>${(26).toLocaleString('en-US')}<`)
  })

  it('不認得的 range／role 退回 7 天、全部', async () => {
    const html = await render(usageDir, { range: '90d', role: 'guest' })
    expect(anchors(block(html, 'usage-range')).find((a) => a.attrs.includes('aria-current'))?.text).toBe('7 天')
    expect(anchors(block(html, 'usage-role')).find((a) => a.attrs.includes('aria-current'))?.text).toBe('全部')
    expect(barActions(html)).toEqual(summarize(fixtureReport(), '7d', 'all').bars.map((b) => b.action))
  })

  it('usage.json 壞掉：不 404、不 500，顯示讀不懂', async () => {
    const dir = path.join(root, 'broken')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'usage.json'), '{"daily":')
    expect(await render(dir)).toContain('data-testid="usage-invalid"')
    await writeFile(path.join(dir, 'usage.json'), '{}')
    expect(await render(dir)).toContain('data-testid="usage-invalid"')
  })
})

describe('AC-DV-25（fixture 段）：usage.json 過得了 collector 的白名單與遮蔽', () => {
  // collector 是 .mjs、tsconfig 沒開 allowJs：用變數路徑動態 import，型別當 any。
  const lib = (name: string) => import(path.join(import.meta.dirname, '..', 'collector', 'lib', name))

  it('陣列版：遮蔽零命中、照原樣寫；全文沒有 email、UUID', async () => {
    const { findSensitiveKeys } = await lib('redact.mjs')
    const { serializeChecked } = await lib('files.mjs')
    const r = fixtureReport()
    expect(findSensitiveKeys(r)).toEqual([])
    expect(JSON.parse(serializeChecked('usage.json', r))).toEqual(r)
    expect(readFileSync(path.join(usageDir, 'usage.json'), 'utf8')).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('物件版（action 當鍵）：形狀驗證失敗、不寫檔', async () => {
    const { serializeChecked } = await lib('files.mjs')
    const r = { ...fixtureReport(), actions: { 'account.change_password': 3 } }
    expect(() => serializeChecked('usage.json', r)).toThrow()
  })
})

describe('AC-DV-30 讀檔次數', () => {
  it('/usage 一次 render 只讀 usage.json 一次', async () => {
    await render(usageDir, { range: '30d', role: 'student' })
    const files = vi.mocked(fsp.readFile).mock.calls.map(([f]) => String(f))
    expect(files).toEqual([path.join(usageDir, 'usage.json')])
  })
})
