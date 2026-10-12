import { describe, expect, it } from 'vitest'
import {
  HERO_UPLOAD,
  HOME_DEFAULTS,
  HOME_LIMITS,
  normalizeHomeSettings,
  resolveHome,
  type HomeSettings,
} from '@/application/site/home-settings'

const FILE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

function settings(overrides: Partial<HomeSettings> = {}): HomeSettings {
  return {
    heroFileId: null,
    heroAlt: null,
    line1: null,
    line2: null,
    revision: 1,
    updatedAt: new Date('2026-10-12T02:00:00Z'),
    updatedByName: '系辦',
    ...overrides,
  }
}

describe('resolveHome：首頁 hero 要顯示什麼', () => {
  it('沒有設定列時用程式內預設，與改版前的首頁一字不差（e2e smoke、public-pages 守著）', () => {
    expect(resolveHome(null)).toEqual({
      heroSrc: '/placeholder/campus.jpg',
      heroAlt: '',
      line1: '輔仁大學資訊管理學系專題管理平台',
      line2: '輔大資管系專題：從分組、提案到成果發表，公告、規則與歷屆作品都在這裡。',
    })
    expect(HOME_DEFAULTS.line1).toBe('輔仁大學資訊管理學系專題管理平台')
  })

  it('有設定列但四欄都是 null（按過「恢復預設」）時一樣回預設', () => {
    expect(resolveHome(settings())).toEqual(resolveHome(null))
  })

  it('有自訂圖時圖片走 /api/files（每次重新授權），alt 用圖片說明', () => {
    expect(resolveHome(settings({ heroFileId: FILE, heroAlt: '利瑪竇大樓夜景', line1: '新標語', line2: '第二行' }))).toEqual({
      heroSrc: `/api/files/${FILE}`,
      heroAlt: '利瑪竇大樓夜景',
      line1: '新標語',
      line2: '第二行',
    })
  })

  it('只改一行時另一行與圖片照用預設', () => {
    const resolved = resolveHome(settings({ line2: '只改第二行' }))
    expect(resolved.line1).toBe(HOME_DEFAULTS.line1)
    expect(resolved.line2).toBe('只改第二行')
    expect(resolved.heroSrc).toBe(HOME_DEFAULTS.heroSrc)
  })
})

describe('normalizeHomeSettings：表單收斂成要存的四欄', () => {
  it('前後空白去掉；空白欄存 null（＝用預設）', () => {
    expect(normalizeHomeSettings({ heroFileId: '', heroAlt: '  ', line1: '  第一行 ', line2: '' })).toEqual({
      ok: true,
      value: { heroFileId: null, heroAlt: null, line1: '第一行', line2: null },
    })
  })

  it('有圖時一定要寫圖片說明（給看不到圖的人）', () => {
    const result = normalizeHomeSettings({ heroFileId: FILE, heroAlt: ' ', line1: '', line2: '' })
    expect(result).toMatchObject({ ok: false, field: 'heroAlt' })
    if (result.ok) return
    expect(result.message).toContain('圖片說明')
  })

  it('沒有圖時圖片說明不存（預設圖是裝飾）', () => {
    expect(normalizeHomeSettings({ heroFileId: null, heroAlt: '說明', line1: '', line2: '' })).toMatchObject({
      ok: true,
      value: { heroFileId: null, heroAlt: null },
    })
  })

  it('檔案編號大小寫統一成小寫；不是 uuid 的擋下', () => {
    expect(normalizeHomeSettings({ heroFileId: FILE.toUpperCase(), heroAlt: 'a', line1: '', line2: '' })).toMatchObject({
      ok: true,
      value: { heroFileId: FILE },
    })
    expect(normalizeHomeSettings({ heroFileId: 'x', heroAlt: 'a', line1: '', line2: '' })).toMatchObject({ ok: false, field: 'hero' })
  })

  it('字數上限與資料庫 CHECK 一致：第一行 40、第二行 120、圖片說明 120（以字計，不是位元組）', () => {
    expect(HOME_LIMITS).toEqual({ line1: 40, line2: 120, heroAlt: 120 })
    const ok = normalizeHomeSettings({ heroFileId: FILE, heroAlt: '圖'.repeat(120), line1: '字'.repeat(40), line2: '字'.repeat(120) })
    expect(ok.ok).toBe(true)
    expect(normalizeHomeSettings({ heroFileId: null, heroAlt: '', line1: '字'.repeat(41), line2: '' })).toMatchObject({
      ok: false,
      field: 'line1',
      message: '標語第一行最多 40 字（現在 41 字）。',
    })
    expect(normalizeHomeSettings({ heroFileId: null, heroAlt: '', line1: '', line2: '字'.repeat(121) })).toMatchObject({ ok: false, field: 'line2' })
    expect(normalizeHomeSettings({ heroFileId: FILE, heroAlt: '圖'.repeat(121), line1: '', line2: '' })).toMatchObject({ ok: false, field: 'heroAlt' })
  })

  it('emoji 等補充平面字元算一個字（與 Postgres char_length 一致）', () => {
    expect(normalizeHomeSettings({ heroFileId: null, heroAlt: '', line1: '🎓'.repeat(40), line2: '' }).ok).toBe(true)
  })

  it('標語不能換行（hero 只有一行的位置）', () => {
    expect(normalizeHomeSettings({ heroFileId: null, heroAlt: '', line1: '第一\n行', line2: '' })).toMatchObject({ ok: false, field: 'line1' })
  })
})

describe('首頁大圖的上傳規則', () => {
  it('只收 PNG／JPG、上限 5 MiB（同公告封面）', () => {
    expect(HERO_UPLOAD).toEqual({ allowedTypes: ['png', 'jpg'], maxBytes: 5 * 1024 * 1024 })
  })
})
