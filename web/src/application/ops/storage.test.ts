import { describe, expect, it } from 'vitest'
import {
  formatGiB,
  isStorageMeasurementStale,
  STORAGE_STALE_AFTER_MS,
  storageAlertLabel,
  storageAlertLevel,
  storageTileText,
  usageFromStatfs,
  type StorageMeasurement,
} from '@/application/ops/storage'

/** 票 28：磁碟用量的等級（≥80% 警戒、≥90% 危險；只看站內、不推播）。 */
describe('storageAlertLevel', () => {
  it('80% 以下正常；剛好 80% 起警戒；90% 起危險', () => {
    expect(storageAlertLevel(0)).toBe('ok')
    expect(storageAlertLevel(79.9)).toBe('ok')
    expect(storageAlertLevel(80)).toBe('warn80')
    expect(storageAlertLevel(89.9)).toBe('warn80')
    expect(storageAlertLevel(90)).toBe('critical')
    expect(storageAlertLevel(104)).toBe('critical')
  })

  it('等級有中文標示', () => {
    expect(storageAlertLabel('ok')).toBe('正常')
    expect(storageAlertLabel('warn80')).toContain('警戒')
    expect(storageAlertLabel('critical')).toContain('危險')
  })
})

describe('usageFromStatfs：跟 df 一樣的算法', () => {
  it('已用＝總－空閒；百分比的分母是「已用＋一般使用者可用」（不含 root 保留）', () => {
    // 100 個區塊、空閒 30（其中 5 個只給 root）→ 已用 70、可用 25 → 70／95 = 73.7%
    const usage = usageFromStatfs({ bsize: 4096, blocks: 100, bfree: 30, bavail: 25 })
    expect(usage.totalBytes).toBe(100 * 4096)
    expect(usage.usedBytes).toBe(70 * 4096)
    expect(usage.freeBytes).toBe(25 * 4096)
    expect(usage.usedPercent).toBe(73.7)
  })

  it('空的檔案系統（區塊數 0）不會除以零', () => {
    expect(usageFromStatfs({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 }).usedPercent).toBe(0)
  })
})

describe('量測過期', () => {
  const now = new Date('2026-09-25T12:00:00Z')

  it('三個小時內是新的；超過就算過期（背景工作可能停了）', () => {
    expect(isStorageMeasurementStale(new Date(now.getTime() - STORAGE_STALE_AFTER_MS), now)).toBe(false)
    expect(isStorageMeasurementStale(new Date(now.getTime() - STORAGE_STALE_AFTER_MS - 1), now)).toBe(true)
  })
})

describe('storageTileText：系辦首頁「儲存與備份」磚', () => {
  const now = new Date('2026-09-25T12:00:00Z')
  const GiB = 1024 ** 3
  const base: StorageMeasurement = {
    measuredRealAt: new Date('2026-09-25T11:30:00Z'),
    path: '/srv/fju/files',
    totalBytes: 100 * GiB,
    usedBytes: 85 * GiB,
    freeBytes: 10 * GiB,
    usedPercent: 89.5,
    filesBytes: GiB,
    tmpBytes: 0,
    dbBytes: 50 * 1024 * 1024,
    alertLevel: 'warn80',
    drill: false,
  }

  it('還沒量過：顯示 — 並說明什麼時候會有', () => {
    expect(storageTileText(null, now, '')).toEqual({ value: '—', hint: expect.stringContaining('還沒有量測') })
  })

  it('≥80%：數字是百分比，說明第一段就是「警戒」', () => {
    const text = storageTileText(base, now, '09/25 19:30')
    expect(text.value).toBe('89.5%')
    expect(text.hint.startsWith('警戒（≥80%）')).toBe(true)
    expect(text.hint).toContain('已用 85 GiB／95 GiB')
    expect(text.hint).toContain('09/25 19:30 量測')
    expect(text.hint).not.toContain('過期')
  })

  it('演練寫的量測標「故障演練」；太舊的量測標「量測過期」', () => {
    expect(storageTileText({ ...base, drill: true }, now, 'x').hint).toContain('（故障演練）')
    const old = { ...base, measuredRealAt: new Date(now.getTime() - STORAGE_STALE_AFTER_MS - 1) }
    expect(storageTileText(old, now, 'x').hint).toContain('量測過期')
  })
})

describe('formatGiB', () => {
  it('取到小數一位', () => {
    expect(formatGiB(97 * 1024 ** 3)).toBe('97 GiB')
    expect(formatGiB(1.25 * 1024 ** 3)).toBe('1.3 GiB')
  })
})
