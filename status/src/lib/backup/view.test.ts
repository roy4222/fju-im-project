import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { BackupInfo, VmData } from '@/lib/data/types'

import { backupSiteView, buildBackupView, diskView, formatBytes, THRESHOLDS } from './view'

const NOW = new Date('2026-10-12T09:05:00+08:00')
const baseVm = (): VmData =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'fixtures', 'base', 'data', 'vm.json'), 'utf8'))

describe('formatBytes', () => {
  it('1024 進位、一位小數，挑最大不小於 1 的單位', () => {
    expect(formatBytes(0)).toBe('0 bytes')
    expect(formatBytes(512)).toBe('512 bytes')
    expect(formatBytes(123456)).toBe('120.6 KB')
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB')
    expect(formatBytes(85899345920)).toBe('80.0 GB')
    expect(formatBytes(50594713600)).toBe('47.1 GB')
  })
})

describe('backupSiteView', () => {
  it('最新一筆成功 → 綠、時間是紀錄時間、大小是異地檔大小、不另外列上次成功', () => {
    const v = backupSiteView(baseVm().backups.prod)
    expect(v).toMatchObject({ state: 'green', label: '成功', at: '2026-10-12T03:10:05+08:00', bytes: 234567, error: null })
    expect(v.lastOk).toBeNull()
    expect(v.offsite).toEqual({ name: 'fju-prod-20261012.dump', bytes: 234567, mtime: '2026-10-12T03:10:00+08:00' })
  })

  it('異地檔 0 bytes → 紅「0 bytes」，仍給上次成功（失敗不覆蓋成功時間）', () => {
    const b: BackupInfo = {
      latest: { name: 'fju-prod-20261012.dump', bytes: 0, mtime: '2026-10-12T03:10:00+08:00' },
      lastRecord: { at: '2026-10-12T03:10:05+08:00', ok: false },
      lastOk: { at: '2026-10-11T03:10:05+08:00', bytes: 230000 },
    }
    const v = backupSiteView(b)
    expect(v.state).toBe('red')
    expect(v.label).toBe('0 bytes')
    expect(v.bytes).toBe(0)
    expect(v.error).toContain('0 bytes')
    expect(v.lastOk).toEqual({ at: '2026-10-11T03:10:05+08:00', bytes: 230000 })
  })

  it('紀錄說成功但檔案 0 bytes → 也是紅「0 bytes」', () => {
    const b = baseVm().backups.prod
    b.latest!.bytes = 0
    expect(backupSiteView(b)).toMatchObject({ state: 'red', label: '0 bytes' })
  })

  it('最新一筆紀錄失敗、檔案是前一天的 → 紅「失敗」，錯誤寫紀錄時間，上次成功另列', () => {
    const b: BackupInfo = {
      latest: { name: 'fju-prod-20261011.dump', bytes: 230000, mtime: '2026-10-11T03:10:00+08:00' },
      lastRecord: { at: '2026-10-12T03:10:05+08:00', ok: false },
      lastOk: { at: '2026-10-11T03:10:05+08:00', bytes: 230000 },
    }
    const v = backupSiteView(b)
    expect(v).toMatchObject({ state: 'red', label: '失敗', at: '2026-10-12T03:10:05+08:00', bytes: null })
    expect(v.error).toContain('失敗')
    expect(v.lastOk?.at).toBe('2026-10-11T03:10:05+08:00')
  })

  it('失敗且從沒成功過 → lastOk 標成「從沒成功」', () => {
    const v = backupSiteView({ latest: null, lastRecord: { at: '2026-10-12T03:10:05+08:00', ok: false }, lastOk: null })
    expect(v.state).toBe('red')
    expect(v.lastOk).toBe('never')
  })

  it('舊版 collector 沒寫 lastOk → 失敗時 lastOk 是 null（不顯示，不說從沒成功）', () => {
    const v = backupSiteView({ latest: null, lastRecord: { at: '2026-10-12T03:10:05+08:00', ok: false } })
    expect(v.lastOk).toBeNull()
  })

  it('什麼都沒有 → 紅「沒有」', () => {
    expect(backupSiteView({ latest: null, lastRecord: null, lastOk: null })).toMatchObject({ state: 'red', label: '沒有', at: null })
    expect(backupSiteView(undefined)).toMatchObject({ state: 'red', label: '沒有' })
  })

  it('沒有紀錄只有異地檔 → 看檔案：有大小就算成功', () => {
    const v = backupSiteView({ latest: { name: 'a.dump', bytes: 10, mtime: '2026-10-12T03:00:00+08:00' }, lastRecord: null })
    expect(v).toMatchObject({ state: 'green', at: '2026-10-12T03:00:00+08:00', bytes: 10 })
  })
})

describe('diskView', () => {
  it(`門檻 ${THRESHOLDS.join('／')}：<80 綠、80～89 黃、≥90 紅`, () => {
    const disk = baseVm().disk!
    expect(diskView(disk, null).state).toBe('green')
    expect(diskView({ ...disk, percent: 79 }, null).state).toBe('green')
    expect(diskView({ ...disk, percent: 80 }, null).state).toBe('yellow')
    expect(diskView({ ...disk, percent: 89 }, null).state).toBe('yellow')
    expect(diskView({ ...disk, percent: 90 }, null).state).toBe('red')
  })

  it('本輪量失敗 → 灰，保留上次的值與量測時間，附錯誤', () => {
    const disk = baseVm().disk!
    const v = diskView(disk, 'EACCES')
    expect(v).toMatchObject({ state: 'grey', error: 'EACCES', percent: 62, checkedAt: disk.checkedAt })
  })

  it('從沒量成功 → 灰、沒有數字', () => {
    expect(diskView(null, 'EACCES')).toMatchObject({ state: 'grey', percent: null, error: 'EACCES' })
    expect(diskView(undefined, undefined)).toMatchObject({ state: 'grey', percent: null, error: null })
  })

  it('百分比夾在 0～100（進度條寬度不會爆）', () => {
    const disk = baseVm().disk!
    expect(diskView({ ...disk, percent: 130 }, null).percent).toBe(100)
    expect(diskView({ ...disk, percent: -3 }, null).percent).toBe(0)
  })
})

describe('buildBackupView', () => {
  it('fixture：兩站成功、磁碟 62% 綠、G4 綠', () => {
    const v = buildBackupView(baseVm(), NOW)
    expect(v.sites.test.state).toBe('green')
    expect(v.sites.prod.state).toBe('green')
    expect(v.disk.state).toBe('green')
    expect(v.gate.id).toBe('G4')
    expect(v.gate.state).toBe('green')
  })

  it('沒有 vm.json → 兩站「沒有資料」灰、磁碟灰、G4 灰', () => {
    const v = buildBackupView(null, NOW)
    expect(v.sites.test).toMatchObject({ state: 'grey', label: '沒有資料' })
    expect(v.sites.prod.state).toBe('grey')
    expect(v.disk.state).toBe('grey')
    expect(v.gate.state).toBe('grey')
  })
})
