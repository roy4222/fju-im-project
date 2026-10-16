// AC-DV-05、AC-DV-06（vm 段）：vm.json 的主機儲存（statfs）與備份上次成功；metrics.json、usage.json 的白名單登記（DV-8）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runOnce } from '../collect.mjs'
import { accessRoutes, baseConfig, gatusRoutes, githubRoutes, healthRoutes, makeFakeVm, rawRoutes, startServer } from '../testing/fakes.mjs'
import { serializeChecked } from './files.mjs'
import { project } from './shape.mjs'
import { METRICS, USAGE, shapeFor } from './shapes.mjs'
import { collectVm, diskErrorCode, diskFromStatfs } from './vm.mjs'

const NOW = new Date('2026-10-12T10:15:00Z')
const LATER = new Date(NOW.getTime() + 600e3)

describe('diskFromStatfs：跟 df 的 Use% 同算法（web usageFromStatfs）', () => {
  it('已用＝(總−空閒)×區塊、可用＝一般使用者可用×區塊、百分比分母是已用＋可用', () => {
    const disk = diskFromStatfs({ bsize: 4096, blocks: 1000, bfree: 300, bavail: 250 }, '/srv/fju/status/inbox', NOW)
    expect(disk).toEqual({
      path: '/srv/fju/status/inbox',
      totalBytes: 1000 * 4096,
      usedBytes: 700 * 4096,
      availBytes: 250 * 4096,
      percent: 74, // 700 / 950 = 73.68…
      checkedAt: NOW.toISOString(),
    })
  })

  it('全空的檔案系統（分母 0）百分比是 0，不是 NaN', () => {
    expect(diskFromStatfs({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 }, '/x', NOW).percent).toBe(0)
  })

  it('跟真的 fs.statfs 現場算一次比對，誤差 ≤ 1%', async () => {
    const dir = os.tmpdir()
    const disk = diskFromStatfs(await fs.promises.statfs(dir), dir, NOW)
    const st = fs.statfsSync(dir)
    const used = (st.blocks - st.bfree) * st.bsize
    const expected = (used / (used + st.bavail * st.bsize)) * 100
    expect(Math.abs(disk.percent - expected)).toBeLessThanOrEqual(1)
    expect(disk.totalBytes).toBe(st.blocks * st.bsize)
  })
})

describe('diskErrorCode：只放安全的分類文字', () => {
  it.each([
    [Object.assign(new Error('EACCES: permission denied, statfs /srv/secret/x'), { code: 'EACCES' }), 'EACCES'],
    [Object.assign(new Error('x'), { code: 'ENOENT' }), 'ENOENT'],
    [new Error('沒有 code 的錯誤 /srv/secret'), 'statfs-failed'],
    [Object.assign(new Error('x'), { code: 'password=hunter2' }), 'statfs-failed'],
    ['不是 Error', 'statfs-failed'],
  ])('%s → %s', (err, code) => {
    expect(diskErrorCode(err)).toBe(code)
  })
})

describe('collectVm 的 disk：失敗保留上次成功值', () => {
  let vm
  beforeEach(() => {
    vm = makeFakeVm(NOW)
  })
  afterEach(() => vm.cleanup())

  const cfgWith = (statfs, extra = {}) => ({ ...baseConfig({ base: 'http://127.0.0.1:1', dataDir: vm.dataDir, fju: vm.fju }), statfs, ...extra })
  const fakeStatfs = async () => ({ bsize: 1024, blocks: 100, bfree: 38, bavail: 38 })
  const eacces = async () => {
    throw Object.assign(new Error('EACCES: permission denied, statfs /srv/fju/status/inbox'), { code: 'EACCES' })
  }

  it('沒設 diskPath 時量 inboxDir；成功時 diskError 是 null', async () => {
    const seen = []
    const out = await collectVm(cfgWith(async (p) => (seen.push(p), fakeStatfs())), NOW, null)
    expect(seen).toEqual([path.join(vm.fju, 'status', 'inbox')])
    expect(out.disk).toMatchObject({ path: seen[0], percent: 62, checkedAt: NOW.toISOString() })
    expect(out.diskError).toBeNull()
  })

  it('有設 diskPath（STATUS_DISK_PATH）就量那裡', async () => {
    const seen = []
    await collectVm(cfgWith(async (p) => (seen.push(p), fakeStatfs()), { diskPath: '/srv/other' }), NOW, null)
    expect(seen).toEqual(['/srv/other'])
  })

  it('statfs 失敗：disk 保留上一版的值與原本的 checkedAt（只取白名單欄位），diskError 只有分類文字', async () => {
    const first = await collectVm(cfgWith(fakeStatfs), NOW, null)
    const prev = { ...first, disk: { ...first.disk, secret: 'FAKEPASS701' } }
    const out = await collectVm(cfgWith(eacces), LATER, prev)
    expect(out.disk).toEqual(first.disk)
    expect(out.disk.checkedAt).toBe(NOW.toISOString())
    expect(out.diskError).toBe('EACCES')
    expect(JSON.stringify(out)).not.toContain('FAKEPASS')
    expect(JSON.stringify(out)).not.toContain('permission denied')
  })

  it('量到的值不合白名單（相對路徑）：當這輪失敗、沿用上一版', async () => {
    const first = await collectVm(cfgWith(fakeStatfs), NOW, null)
    const out = await collectVm(cfgWith(fakeStatfs, { diskPath: 'relative/dir' }), LATER, first)
    expect(out.disk).toEqual(first.disk)
    expect(out.diskError).toBe('statfs-failed')
  })

  it.each([
    ['沒有上一版', null],
    ['上一版不是物件', ['x']],
    ['上一版沒有 disk（舊版 collector）', { deploys: {} }],
    ['上一版的 disk 壞掉', { disk: { path: '/x', percent: 'NaN' } }],
  ])('statfs 失敗且%s：disk 是 null、照樣回其他欄位', async (_label, prev) => {
    const out = await collectVm(cfgWith(eacces), LATER, prev)
    expect(out.disk).toBeNull()
    expect(out.diskError).toBe('EACCES')
    expect(out.deploys.test).toHaveLength(5)
  })
})

describe('AC-DV-05 跑一輪收集器：vm.json 的 disk 與 lastOk', () => {
  let vm
  let server
  beforeEach(() => {
    vm = makeFakeVm(NOW)
  })
  afterEach(async () => {
    await server?.close()
    server = undefined
    vm.cleanup()
  })

  const read = (rel) => JSON.parse(fs.readFileSync(path.join(vm.dataDir, rel), 'utf8'))

  it('成功備份→失敗備份→成功 drill＋壞行；第二輪 statfs EACCES 時保留上次 disk、vm 來源仍 ok', async () => {
    const T1 = '2026-10-11T03:00:00Z'
    const T2 = '2026-10-12T03:00:00Z'
    const T3 = '2026-10-12T04:00:00Z'
    vm.write(
      'prod/backups/records.jsonl',
      [
        JSON.stringify({ kind: 'backup', status: 'ok', started_at: '2026-10-11T02:59:00Z', finished_at: T1, bytes: 1200 }),
        JSON.stringify({ kind: 'backup', status: 'failed', finished_at: T2 }),
        JSON.stringify({ kind: 'drill', status: 'ok', finished_at: T3 }),
        '{"kind":"backup","status":"ok"', // 寫到一半的行
      ].join('\n') + '\n',
    )
    const routes = { ...githubRoutes(), ...rawRoutes(), ...gatusRoutes(NOW), ...healthRoutes(NOW), ...accessRoutes() }
    server = await startServer(routes)
    const cfg = baseConfig({ base: server.base, dataDir: vm.dataDir, fju: vm.fju })

    // 第一輪：真的 fs.statfs（沒有注入），量 inbox 所在的檔案系統。
    await runOnce(cfg, NOW)
    const first = read('vm.json')
    const st = fs.statfsSync(cfg.inboxDir)
    const used = (st.blocks - st.bfree) * st.bsize
    expect(first.disk).toMatchObject({ path: cfg.inboxDir, checkedAt: NOW.toISOString() })
    expect(Math.abs(first.disk.percent - (used / (used + st.bavail * st.bsize)) * 100)).toBeLessThanOrEqual(1)
    expect(Object.keys(first.disk).sort()).toEqual(['availBytes', 'checkedAt', 'path', 'percent', 'totalBytes', 'usedBytes'])
    expect(first.diskError).toBeNull()
    expect(first.backups.prod.lastOk).toEqual({ at: T1, bytes: 1200 })
    expect(first.backups.prod.lastRecord).toEqual({ at: T2, ok: false })
    expect(first.backups.test.lastOk).toBeNull()

    // 第二輪：statfs 會 throw EACCES。
    cfg.statfs = async () => {
      throw Object.assign(new Error('EACCES: permission denied, statfs /srv/fju/status/inbox'), { code: 'EACCES' })
    }
    const status = await runOnce(cfg, LATER)
    const second = read('vm.json')
    expect(second.generatedAt).toBe(LATER.toISOString())
    expect(second.disk).toEqual(first.disk)
    expect(second.diskError).toBe('EACCES')
    expect(status.sources.vm).toEqual({ ok: true, at: LATER.toISOString(), error: null })
    expect(read('collector.json').sources.vm.ok).toBe(true)
    // 備份與部署照常寫；部署、prodEnv、prodDns 跟改前一樣
    expect(second.backups).toEqual(first.backups)
    expect(second.deploys).toEqual(first.deploys)
    expect(second.prodEnv).toEqual(first.prodEnv)
    expect(second.prodDns).toEqual({ host: 'fju.roy422.dev', hasA: true, checkedAt: LATER.toISOString() })
  })

  it('從沒量成功過（第一輪就 EACCES）：disk 是 null、vm.json 照寫', async () => {
    const routes = { ...githubRoutes(), ...rawRoutes(), ...gatusRoutes(NOW), ...healthRoutes(NOW), ...accessRoutes() }
    server = await startServer(routes)
    const cfg = {
      ...baseConfig({ base: server.base, dataDir: vm.dataDir, fju: vm.fju }),
      statfs: async () => {
        throw Object.assign(new Error('x'), { code: 'EACCES' })
      },
    }
    const status = await runOnce(cfg, NOW)
    expect(read('vm.json')).toMatchObject({ disk: null, diskError: 'EACCES' })
    expect(status.sources.vm.ok).toBe(true)
  })
})

describe('AC-DV-06（vm 段）：disk 多塞規格外欄位不會輸出', () => {
  const at = NOW.toISOString()
  const vm = {
    generatedAt: at,
    deploys: { test: [], prod: [] },
    backups: {
      test: { latest: null, offsiteDir: 'missing', lastRecord: null, lastOk: null },
      prod: { latest: null, offsiteDir: 'missing', lastRecord: { at, ok: true }, lastOk: { at, bytes: null } },
    },
    prodEnv: null,
    prodEnvError: '還沒有 envcheck 結果',
    prodDns: { host: 'fju.roy422.dev', hasA: true, checkedAt: at },
    disk: { path: '/srv/fju/status/inbox', totalBytes: 100, usedBytes: 62, availBytes: 38, percent: 62, checkedAt: at },
    diskError: null,
  }

  it('disk.secret、lastOk 多的欄位都被白名單丟掉', () => {
    const dirty = {
      ...vm,
      disk: { ...vm.disk, secret: 'FAKEPASS702' },
      backups: { ...vm.backups, prod: { ...vm.backups.prod, lastOk: { ...vm.backups.prod.lastOk, file: 'FAKEPASS703' } } },
    }
    const text = serializeChecked('vm.json', dirty)
    expect(text).not.toContain('FAKEPASS')
    expect(JSON.parse(text)).toEqual(vm)
  })

  it('percent 超出 0–100、diskError 不是分類文字：整檔不寫', () => {
    expect(() => serializeChecked('vm.json', { ...vm, disk: { ...vm.disk, percent: 101 } })).toThrow()
    expect(() => serializeChecked('vm.json', { ...vm, diskError: 'EACCES: permission denied /srv' })).toThrow()
  })
})

describe('metrics.json、usage.json 已登記白名單（DV-12、DV-B1 才寫檔）', () => {
  const at = NOW.toISOString()
  const site = { fetchedAt: at, uptime24h: 0.997, uptime7d: 0.999, avgMs24h: 183, failures24h: 1, points: [{ at, ms: 181, ok: true }] }
  const metrics = { generatedAt: at, gatusOk: true, error: null, sites: { test: site, prod: null } }
  const usage = {
    generatedAt: at,
    site: 'prod',
    window: { from: '2026-07-01', to: '2026-10-15' },
    daily: [{ day: '2026-10-15', role: 'student', activeUsers: 41, events: 388 }],
    actions: [{ action: 'account.change_password', role: 'student', count7d: 1, count30d: 2, countTerm: 3 }],
  }

  it('shapeFor 不再 throw', () => {
    expect(shapeFor('metrics.json')).toBe(METRICS)
    expect(shapeFor('usage.json')).toBe(USAGE)
  })

  it('metrics：points 只留 at／ms／ok，頂層只留四鍵；窗口內 0 筆時三個數字可以是 null', () => {
    const dirty = {
      ...metrics,
      extra: 1,
      sites: { test: { ...site, points: [{ ...site.points[0], hostname: 'x', password: 'y' }] }, prod: null },
    }
    const out = project(METRICS, dirty)
    expect(Object.keys(out).sort()).toEqual(['error', 'gatusOk', 'generatedAt', 'sites'])
    expect(Object.keys(out.sites.test.points[0]).sort()).toEqual(['at', 'ms', 'ok'])
    const empty = { ...site, uptime24h: null, avgMs24h: null, failures24h: null, points: [] }
    expect(project(METRICS, { ...metrics, sites: { test: empty, prod: empty } }).sites.prod).toEqual(empty)
    expect(() => project(METRICS, { ...metrics, sites: { test: { ...site, uptime24h: 1.5 }, prod: null } })).toThrow()
    expect(() => project(METRICS, { ...metrics, sites: { test: { ...site, points: Array(289).fill(site.points[0]) }, prod: null } })).toThrow()
  })

  it('usage：action 是陣列裡的值（不是鍵），含 password 字樣也照寫；角色只收三種', () => {
    expect(JSON.parse(serializeChecked('usage.json', { ...usage, debug: 'x' }))).toEqual(usage)
    expect(() => project(USAGE, { ...usage, daily: [{ ...usage.daily[0], role: 'guest' }] })).toThrow()
    expect(() => project(USAGE, { ...usage, daily: [{ ...usage.daily[0], email: 'a@b.c' }] })).not.toThrow()
    expect(JSON.stringify(project(USAGE, { ...usage, daily: [{ ...usage.daily[0], email: 'a@b.c' }] }))).not.toContain('a@b.c')
  })
})
