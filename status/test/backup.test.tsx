// 備份與儲存頁（AC-DV-22、AC-DV-30）：兩站備份與主機儲存的正本，頁底 G4 一句判定。
import { readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import BackupPage from '@/app/backup/page'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { formatBytes } from '@/lib/backup/view'
import type { VmData } from '@/lib/data/types'
import { formatTime } from '@/lib/deploy/view'

import { NOW } from '../fixtures/gate/scenarios'

// AC-DV-30 數 readFile：read.ts 用具名 import，要在模組層換掉才攔得到。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const base = path.join(import.meta.dirname, '..', 'fixtures', 'base', 'data')
const baseVm = (): VmData => JSON.parse(readFileSync(path.join(base, 'vm.json'), 'utf8'))

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'status-backup-'))
})
afterAll(() => rm(root, { recursive: true, force: true }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

/** fixture 的 vm.json 是 NOW 前 5 分鐘收的；固定在 NOW，G4 才不會因資料過期變灰。 */
async function render(dataDir: string) {
  vi.stubEnv('STATUS_DATA_DIR', dataDir)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  const page = await BackupPage()
  return renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>{page}</SidebarProvider>
    </TooltipProvider>,
  )
}

async function writeVm(name: string, vm: VmData | null) {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  if (vm) await writeFile(path.join(dir, 'vm.json'), JSON.stringify(vm))
  return dir
}

/** 某個區塊的 HTML（到下一個 backup-／disk-usage 區塊為止）。 */
const section = (html: string, id: string) => {
  const start = html.indexOf(`data-testid="${id}"`)
  if (start < 0) return ''
  const rest = html.slice(start + 1)
  const end = rest.search(/data-testid="(?:backup-(?:test|prod|gate)|disk-usage)"/)
  return end < 0 ? rest : rest.slice(0, end)
}
const stateOf = (html: string, id: string) => html.match(new RegExp(`data-testid="${id}" data-state="(\\w+)"`))?.[1]

describe('AC-DV-22 /backup', () => {
  it('fixture：兩站備份的時間、大小（人類可讀）、成敗、錯誤欄', async () => {
    const vm = baseVm()
    const html = await render(base)
    expect(html).toMatch(/<h1[^>]*>備份與儲存<\/h1>/)
    expect(html).not.toContain('data-testid="placeholder"')
    for (const site of ['test', 'prod'] as const) {
      const card = section(html, `backup-${site}`)
      const b = vm.backups[site]
      expect(stateOf(html, `backup-${site}`)).toBe('green')
      expect(card).toContain('成功')
      expect(card).toContain(formatTime(b.lastRecord!.at))
      expect(card).toContain(formatBytes(b.latest!.bytes))
      expect(card).toMatch(/\d+\.\d (?:KB|MB|GB)/)
      expect(card).toContain('錯誤')
      expect(card).toContain(b.latest!.name)
      expect(card).not.toContain('data-testid="backup-last-ok"')
    }
  })

  it('fixture：主機儲存進度條 62%、已用／可用／共、量測時間與路徑、80／90 門檻線、說明句', async () => {
    const disk = baseVm().disk!
    const html = await render(base)
    const card = section(html, 'disk-usage')
    expect(stateOf(html, 'disk-usage')).toBe('green')
    expect(card).toContain('62%')
    expect(card).toMatch(/style="width:\s*62%"/)
    expect(card).toContain(`已用 ${formatBytes(disk.usedBytes)}／可用 ${formatBytes(disk.availBytes)}／共 ${formatBytes(disk.totalBytes)}`)
    expect(card).toMatch(/已用 [\d.]+ GB／可用 [\d.]+ GB／共 [\d.]+ GB/)
    expect(card).toContain(formatTime(disk.checkedAt))
    expect(card).toContain(disk.path)
    expect(card).toContain('data-threshold="80"')
    expect(card).toContain('data-threshold="90"')
    expect(card).toContain('超過 80% 要清，90% 會影響備份')
    expect(card).not.toContain('data-testid="disk-error"')
  })

  it('fixture：頁底 G4 一句判定（綠）連到 /go-live', async () => {
    const html = await render(base)
    expect(stateOf(html, 'backup-gate')).toBe('green')
    const gate = section(html, 'backup-gate')
    expect(gate).toContain('G4')
    expect(gate).toContain('href="/go-live"')
  })

  it('正式站備份 0 bytes：backup-prod 紅「0 bytes」、仍顯示上次成功時間；G4 紅；測試站不受影響', async () => {
    const vm = baseVm()
    const lastOkAt = '2026-10-11T03:10:05+08:00'
    vm.backups.prod = {
      latest: { name: 'fju-prod-20261012.dump', bytes: 0, mtime: '2026-10-12T03:10:00+08:00' },
      lastRecord: { at: '2026-10-12T03:10:05+08:00', ok: false },
      lastOk: { at: lastOkAt, bytes: 230000 },
    }
    const html = await render(await writeVm('zero', vm))
    expect(stateOf(html, 'backup-prod')).toBe('red')
    const card = section(html, 'backup-prod')
    expect(card).toContain('0 bytes')
    expect(card).toContain('data-testid="backup-last-ok"')
    expect(card).toContain('上次成功')
    expect(card).toContain(formatTime(lastOkAt))
    expect(stateOf(html, 'backup-gate')).toBe('red')
    expect(section(html, 'backup-gate')).toContain('href="/go-live"')
    expect(stateOf(html, 'backup-test')).toBe('green')
  })

  it('用量 85% → 黃、92% → 紅（跟門檻線同一套）', async () => {
    for (const [percent, state] of [[85, 'yellow'], [92, 'red']] as const) {
      const vm = baseVm()
      vm.disk = { ...vm.disk!, percent }
      const html = await render(await writeVm(`disk-${percent}`, vm))
      expect(stateOf(html, 'disk-usage')).toBe(state)
      expect(section(html, 'disk-usage')).toMatch(new RegExp(`style="width:\\s*${percent}%"`))
    }
  })

  it('本輪量不到（diskError）→ 灰，照畫上次的值與量測時間並寫出錯誤', async () => {
    const vm = baseVm()
    vm.diskError = 'EACCES'
    const html = await render(await writeVm('disk-error', vm))
    expect(stateOf(html, 'disk-usage')).toBe('grey')
    const card = section(html, 'disk-usage')
    expect(card).toContain('EACCES')
    expect(card).toContain('62%')
    expect(card).toContain(formatTime(vm.disk!.checkedAt))
  })

  it('從沒量成功過（disk:null）→ 灰「—」＋錯誤，沒有進度條', async () => {
    const vm = baseVm()
    vm.disk = null
    vm.diskError = 'statfs-failed'
    const html = await render(await writeVm('disk-null', vm))
    expect(stateOf(html, 'disk-usage')).toBe('grey')
    const card = section(html, 'disk-usage')
    expect(card).toContain('statfs-failed')
    expect(card).not.toContain('data-threshold')
  })

  it('舊版 vm.json（沒有 disk、lastOk）照樣畫、不 500', async () => {
    const vm = baseVm()
    delete vm.disk
    delete vm.diskError
    delete vm.backups.prod.lastOk
    delete vm.backups.test.lastOk
    const html = await render(await writeVm('old', vm))
    expect(stateOf(html, 'backup-prod')).toBe('green')
    expect(stateOf(html, 'disk-usage')).toBe('grey')
  })

  it('沒有 vm.json → 兩站與主機儲存都灰、G4 灰，頁面照樣出來', async () => {
    const html = await render(await writeVm('empty', null))
    expect(html).toMatch(/<h1[^>]*>備份與儲存<\/h1>/)
    for (const id of ['backup-test', 'backup-prod', 'disk-usage', 'backup-gate']) expect(stateOf(html, id)).toBe('grey')
  })
})

describe('AC-DV-30 /backup 讀檔次數', () => {
  it('一次 render 只讀 vm.json 一次（≤ 1）', async () => {
    const spy = vi.mocked(fsp.readFile)
    spy.mockClear()
    await render(base)
    const files = spy.mock.calls.map((c) => String(c[0]))
    expect(files.length).toBeLessThanOrEqual(1)
    expect(files.map((f) => path.basename(f))).toEqual(['vm.json'])
    expect(new Set(files).size).toBe(files.length)
  })
})
