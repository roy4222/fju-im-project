// 總覽的純函式（DV 設計方案 §4、§12）：固定 now、直接餵物件；門檻與 Q-DV-2／3 定案值都在這層驗。
import { describe, expect, it } from 'vitest'

import type { CollectorStatus, MetricsData, MetricsPoint, Site } from '@/lib/data/types'
import { evaluateBackup } from '@/lib/gate/gates'
import type { GateInput } from '@/lib/gate/types'

import { NOW, SCENARIOS, toGateInput, type Scenario } from '../../../fixtures/gate/scenarios'

import { backupKpi, buildOverview, errorBuckets, formatDay, prodNotOpen, type Kpi, type KpiId } from './overview'

const now = new Date(NOW)
const AT = '2026-10-12T09:00:00+08:00'
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString()

/** 每 5 分鐘一點、最新一點在 AT，共 288 點；`fails` 是要設成 ok:false 的點（從最新往回數的索引）。 */
function points(fails: number[] = []): MetricsPoint[] {
  const end = Date.parse(AT)
  return Array.from({ length: 288 }, (_, i) => ({
    at: new Date(end - (287 - i) * 5 * 60_000).toISOString(),
    ms: 200,
    ok: !fails.includes(287 - i),
  }))
}

function metrics(over: Partial<Record<Site, number[]>> = {}, gatusOk = true): MetricsData {
  const site = (fails: number[]) => ({
    fetchedAt: AT,
    uptime24h: 1 - fails.length / 288,
    uptime7d: 0.999,
    avgMs24h: 200,
    failures24h: fails.length,
    points: points(fails),
  })
  return { generatedAt: AT, gatusOk, error: gatusOk ? null : 'HTTP 502', sites: { test: site(over.test ?? []), prod: site(over.prod ?? []) } }
}

const collector = (generatedAt = AT): CollectorStatus => ({
  generatedAt,
  sources: Object.fromEntries(['github', 'repo', 'health', 'vm', 'acceptance'].map((k) => [k, { ok: true, at: generatedAt, error: null }])),
})

function overview(s: Scenario = SCENARIOS.a(), m: MetricsData | null = metrics(), c: CollectorStatus | null = collector()) {
  return buildOverview({ gate: toGateInput(s), metrics: m, collector: c }, now)
}

const kpi = (kpis: Kpi[], id: KpiId) => kpis.find((k) => k.id === id)!
const states = (kpis: Kpi[]) => Object.fromEntries(kpis.map((k) => [k.id, k.state]))

describe('buildOverview：情境 (a) 全部正常', () => {
  it('五卡全綠、狀態列「全部正常・5 分鐘前更新」、兩站 ✓、5 / 5', () => {
    const v = overview()
    expect(v.kpis.map((k) => k.id)).toEqual(['version', 'errors', 'backup', 'disk', 'ci'])
    expect(states(v.kpis)).toEqual({ version: 'green', errors: 'green', backup: 'green', disk: 'green', ci: 'green' })
    expect(v.statusBar).toMatchObject({ tone: 'green', text: '全部正常', updated: '5 分鐘前更新' })
    expect(v.statusBar.sites.map((s) => s.text)).toEqual(['測試站 ✓', '正式站 ✓'])
    expect(v.goLive.green).toBe(5)
    expect(v.goLive.gates.map((g) => g.id)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5'])
  })

  it('五卡的大字與點進去的頁', () => {
    const { kpis } = overview()
    expect(kpis.map((k) => [k.id, k.value, k.href])).toEqual([
      ['version', '一致', '/deploy'],
      ['errors', '0', '/errors'],
      ['backup', '成功', '/backup'],
      ['disk', '62%', '/backup'],
      ['ci', 'main ✓', '/deploy'],
    ])
    expect(kpi(kpis, 'version').notes[0]).toBe('測試站 7162644・正式站 7162644・main 7162644')
    // 情境 (a) 是舊版 collector 的 vm.json（沒有 lastOk），大小不知道就不列（跟 /backup 同一個 backupSiteView）。
    expect(kpi(kpis, 'backup').notes[0]).toBe('今天 03:10')
    expect(kpi(kpis, 'disk').bar).toBe(62)
    expect(kpi(kpis, 'ci').notes).toEqual(['5 分鐘前'])
  })
})

describe('主機儲存（AC-DV-12）', () => {
  const withDisk = (percent: number, diskError: string | null = null) => {
    const s = SCENARIOS.a()
    s.vm!.disk = { ...s.vm!.disk!, percent }
    s.vm!.diskError = diskError
    return kpi(overview(s).kpis, 'disk')
  }

  it('門檻 79 綠／80 黃／89 黃／90 紅', () => {
    expect([79, 80, 89, 90].map((p) => withDisk(p).state)).toEqual(['green', 'yellow', 'yellow', 'red'])
  })

  it('diskError 不是 null 一律灰：有上次成功值照列百分比與量測時間，另列錯誤', () => {
    const k = withDisk(95, 'EACCES')
    expect(k.state).toBe('grey')
    expect(k.value).toBe('95%')
    expect(k.notes.join(' ')).toContain('量測時間 10/12 09:00')
    expect(k.notes.join(' ')).toContain('EACCES')
  })

  it('disk 是 null（從沒量成功）→ 灰「—」＋錯誤', () => {
    const s = SCENARIOS.a()
    s.vm!.disk = null
    s.vm!.diskError = 'EACCES'
    const k = kpi(overview(s).kpis, 'disk')
    expect(k).toMatchObject({ state: 'grey', value: '—', bar: null })
    expect(k.notes.join(' ')).toContain('EACCES')
  })
})

describe('狀態列（§4.1）', () => {
  it('有黃無紅 → 「N 項要注意」（N＝黃的張數）', () => {
    const s = SCENARIOS.a()
    s.vm!.disk!.percent = 85
    s.health!.prod!.commit = '463931b000000000000000000000000000000000'
    const v = overview(s)
    expect(states(v.kpis)).toMatchObject({ version: 'yellow', disk: 'yellow' })
    expect(v.statusBar).toMatchObject({ tone: 'yellow', text: '2 項要注意' })
  })

  it('有紅 → 「N 項異常」，黃不算進去', () => {
    const s = SCENARIOS.b()
    s.vm!.disk!.percent = 85
    const v = overview(s)
    expect(states(v.kpis)).toMatchObject({ ci: 'red', disk: 'yellow' })
    expect(v.statusBar).toMatchObject({ tone: 'red', text: '1 項異常' })
  })

  it('灰不算：主機儲存灰、其他綠 → 「全部正常」', () => {
    const s = SCENARIOS.a()
    s.vm!.diskError = 'EACCES'
    expect(overview(s).statusBar.text).toBe('全部正常')
  })

  it('collector 超過 30 分鐘沒跑 → 「資料過期（N 分鐘前）」、字灰；剛好 30 分鐘不算', () => {
    expect(overview(SCENARIOS.a(), metrics(), collector(minutesAgo(45))).statusBar).toMatchObject({
      tone: 'grey',
      text: '資料過期（45 分鐘前）',
      updated: null,
    })
    expect(overview(SCENARIOS.a(), metrics(), collector(minutesAgo(30))).statusBar).toMatchObject({
      text: '全部正常',
      updated: '30 分鐘前更新',
    })
  })

  it('測試站健康失敗 → 藥丸 ✗、24h 錯誤紅', () => {
    const s = SCENARIOS.a()
    s.health!.test!.ok = false
    const v = overview(s)
    expect(v.statusBar.sites[0]).toMatchObject({ state: 'fail', text: '測試站 ✗' })
    expect(kpi(v.kpis, 'errors').state).toBe('red')
  })
})

describe('24h 錯誤（Q-DV-3 定案：兩站端點 ok:false 的點數）', () => {
  it('兩站失敗點相加；0 綠、≥1 黃', () => {
    const k = kpi(overview(SCENARIOS.a(), metrics({ test: [0], prod: [10, 20] })).kpis, 'errors')
    expect(k).toMatchObject({ state: 'yellow', value: '3' })
  })

  it('24 格每小時，舊到新；最新一點在最後一格', () => {
    const { count, buckets } = errorBuckets(metrics({ test: [0, 1, 12], prod: [287] }), ['test', 'prod'])
    expect(count).toBe(4)
    expect(buckets).toHaveLength(24)
    // 0、1 在最近一小時；12＝60 分鐘前，落在倒數第二格；287＝23h55m 前，落在第一格。
    expect(buckets[23]).toBe(2)
    expect(buckets[22]).toBe(1)
    expect(buckets[0]).toBe(1)
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(4)
  })

  it('沒有 metrics.json → 灰「—」', () => {
    expect(kpi(overview(SCENARIOS.a(), null).kpis, 'errors')).toMatchObject({ state: 'grey', value: '—' })
  })

  it('本輪 Gatus 失敗（gatusOk:false）→ 灰，照列保留值與資料時間，不當成新資料', () => {
    const k = kpi(overview(SCENARIOS.a(), metrics({}, false)).kpis, 'errors')
    expect(k).toMatchObject({ state: 'grey', value: '0' })
    expect(k.notes.join(' ')).toContain('Gatus 本輪失敗，資料時間 10/12 09:00（HTTP 502）')
  })
})

describe('正式站尚未開站（Q-DV-2 定案，AC-DV-17）', () => {
  /** health.prod.ok:false、prodDns.hasA:false、正式站備份 3 天前、正式站 24h 全失敗、測試站全正常。 */
  function notOpen(): Scenario {
    const s = SCENARIOS.a()
    s.health!.prod = { ok: false, commit: null, checkedAt: AT, last6: [false, false, false, false, false, false], reason: 'DNS 查不到' }
    s.vm!.prodDns = { host: 'fju.roy422.dev', hasA: false, checkedAt: AT }
    s.vm!.backups.prod.latest!.mtime = '2026-10-09T03:10:00+08:00'
    s.vm!.backups.prod.lastRecord = { at: '2026-10-09T03:10:05+08:00', ok: true }
    s.vm!.deploys.prod = []
    return s
  }
  const allProdFail = () => metrics({ prod: Array.from({ length: 288 }, (_, i) => i) })

  it('判定：兩個條件都成立才算', () => {
    const s = notOpen()
    expect(prodNotOpen(s.health, s.vm)).toBe(true)
    expect(prodNotOpen({ ...s.health!, prod: { ...s.health!.prod!, ok: true } }, s.vm)).toBe(false)
    expect(prodNotOpen(s.health, { ...s.vm!, prodDns: { ...s.vm!.prodDns!, hasA: true } })).toBe(false)
    expect(prodNotOpen(s.health, { ...s.vm!, prodDns: undefined })).toBe(false)
  })

  it('狀態列「全部正常」＋「正式站 尚未開站」；版本、24h 錯誤、備份只看測試站；G5 照常紅', () => {
    const s = notOpen()
    s.health!.prod!.commit = '463931b000000000000000000000000000000000'
    const v = overview(s, allProdFail())
    expect(v.statusBar).toMatchObject({ tone: 'green', text: '全部正常' })
    expect(v.statusBar.sites[1]).toMatchObject({ state: 'not-open', text: '正式站 尚未開站' })
    expect(states(v.kpis)).toMatchObject({ version: 'green', errors: 'green', backup: 'green' })
    expect(kpi(v.kpis, 'errors').value).toBe('0')
    expect(kpi(v.kpis, 'backup').title).toBe('備份（測試站）')
    expect(kpi(v.kpis, 'version').notes[0]).toContain('正式站 尚未開站')
    expect(v.goLive.gates.find((g) => g.id === 'G5')!.state).toBe('red')
  })

  it('同一份資料但正式站有 A 記錄（不是尚未開站）→ 照實紅', () => {
    const s = notOpen()
    s.vm!.prodDns!.hasA = true
    const v = overview(s, allProdFail())
    expect(v.statusBar.sites[1]).toMatchObject({ state: 'fail', text: '正式站 ✗' })
    expect(states(v.kpis)).toMatchObject({ errors: 'yellow', backup: 'red' })
    expect(kpi(v.kpis, 'errors').value).toBe('288')
  })
})

describe('備份卡（沿用 G4 判法）', () => {
  it('情境 (a)～(j) 的正式站：G4 紅 → 卡紅、G4 灰 → 卡灰（兩邊不漂移）', () => {
    for (const [name, make] of Object.entries(SCENARIOS)) {
      const vm = make().vm
      const g4 = evaluateBackup(vm, now).state
      const card = backupKpi(vm, 'prod', now).state
      if (g4 === 'green') expect.soft(card, name).not.toBe('grey')
      else expect.soft(card, name).toBe(g4)
    }
  })

  it('最近一次失敗 → 紅「失敗」＋上次成功時間', () => {
    const s = SCENARIOS.a()
    s.vm!.backups.prod.lastRecord = { at: '2026-10-12T03:10:05+08:00', ok: false }
    s.vm!.backups.prod.lastOk = { at: '2026-10-11T03:10:05+08:00', bytes: 2000 }
    const k = backupKpi(s.vm, 'prod', now)
    expect(k).toMatchObject({ state: 'red', value: '失敗' })
    expect(k.notes).toContain('上次成功 昨天 03:10')
  })

  it('最新備份 25 小時前 → 紅「太舊」；沒有任何備份 → 紅「沒有」', () => {
    expect(backupKpi(SCENARIOS.e().vm, 'prod', now)).toMatchObject({ state: 'red', value: '太舊' })
    const s = SCENARIOS.a()
    s.vm!.backups.prod = { latest: null, lastRecord: null }
    expect(backupKpi(s.vm, 'prod', now)).toMatchObject({ state: 'red', value: '沒有' })
  })

  it('vm.json 超過 30 分鐘沒更新 → 灰', () => {
    const s = SCENARIOS.a()
    s.vm!.generatedAt = minutesAgo(31)
    expect(backupKpi(s.vm, 'prod', now).state).toBe('grey')
  })
})

describe('CI 卡', () => {
  it('failure → 紅「main ✗」＋沒過的 job', () => {
    const k = kpi(overview(SCENARIOS.b()).kpis, 'ci')
    expect(k).toMatchObject({ state: 'red', value: 'main ✗' })
    expect(k.notes).toContain('沒過：e2e-smoke')
  })

  it('還在跑（conclusion null）或 CI 跑的不是 main 最新 → 灰「跑中」', () => {
    const running = SCENARIOS.a()
    running.github!.ci = { ...running.github!.ci!, status: 'in_progress', conclusion: null }
    expect(kpi(overview(running).kpis, 'ci')).toMatchObject({ state: 'grey', value: '跑中' })
    const behind = SCENARIOS.a()
    behind.github!.mainSha = '463931b000000000000000000000000000000000'
    expect(kpi(overview(behind).kpis, 'ci')).toMatchObject({ state: 'grey', value: '跑中' })
  })
})

describe('沒有任何資料（AC-DV-18）', () => {
  it('五張全灰「—」、狀態列「沒有資料」、0 / 5、沒有事件、圖是 none', () => {
    const empty: GateInput = {
      github: null,
      health: null,
      vm: null,
      acceptance: { index: null, run: null, summary: { status: 'missing' }, policy: { status: 'missing' }, waivers: null },
    }
    const v = buildOverview({ gate: empty, metrics: null, collector: null }, now)
    expect(v.kpis.map((k) => [k.state, k.value])).toEqual(Array(5).fill(['grey', '—']))
    expect(v.statusBar).toMatchObject({ tone: 'grey', text: '沒有資料' })
    expect(v.statusBar.sites.map((s) => s.text)).toEqual(['測試站 —', '正式站 —'])
    expect(v.goLive.green).toBe(0)
    expect(v.goLive.gates.every((g) => g.state === 'grey')).toBe(true)
    expect(v.events).toEqual([])
    expect(v.chart.view.state).toBe('none')
  })
})

describe('最近事件（Q-DV-4 定案：總覽 8 筆）', () => {
  it('多於 8 筆只留最新 8 筆，新到舊', () => {
    const s = SCENARIOS.b()
    s.vm!.deploys.test = Array.from({ length: 5 }, (_, i) => ({ at: minutesAgo(10 + i), event: 'deployed', tag: 'abcdef0123', digest: null }))
    s.vm!.deploys.prod = Array.from({ length: 5 }, (_, i) => ({ at: minutesAgo(20 + i), event: 'deployed', tag: 'abcdef0123', digest: null }))
    const { events } = overview(s)
    expect(events).toHaveLength(8)
    const times = events.map((e) => Date.parse(e.at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })
})

describe('formatDay', () => {
  it('台北時間的今天、昨天，更早是月／日', () => {
    expect(formatDay('2026-10-11T19:30:00Z', now)).toBe('今天 03:30')
    expect(formatDay('2026-10-11T03:30:00+08:00', now)).toBe('昨天 03:30')
    expect(formatDay('2026-10-09T03:30:00+08:00', now)).toBe('10/09 03:30')
    expect(formatDay('壞掉', now)).toBe('壞掉')
  })
})
