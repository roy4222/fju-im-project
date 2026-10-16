// 服務健康頁的純函式（DV 設計方案 §5.1、§12；AC-DV-19）：固定 now、fixture 物件直接餵。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CollectorStatus, HealthData, MetricsData } from '@/lib/data/types'

import { buildHealthView, chartView, formatMs, formatPercent, siteCard, sourceNotes, uptimeRows } from './view'

const base = path.join(import.meta.dirname, '..', '..', '..', 'fixtures', 'base', 'data')
const load = <T>(f: string): T => JSON.parse(readFileSync(path.join(base, f), 'utf8'))
const NOW = new Date('2026-10-12T09:05:00+08:00')

describe('formatPercent／formatMs', () => {
  it('百分比一位小數、ms 整數；null 是「—」', () => {
    expect(formatPercent(0.9965)).toBe('99.7%')
    expect(formatPercent(1)).toBe('100.0%')
    expect(formatPercent(0.999)).toBe('99.9%')
    expect(formatPercent(null)).toBe('—')
    expect(formatMs(213)).toBe('213 ms')
    expect(formatMs(212.6)).toBe('213 ms')
    expect(formatMs(null)).toBe('—')
  })
})

describe('siteCard', () => {
  it('ok → 綠、短 SHA、六顆點照原順序、多久前', () => {
    const health = load<HealthData>('health.json')
    const card = siteCard('test', health.test, NOW)
    expect(card).toMatchObject({ state: 'green', okText: '正常', commitShort: '7162644', checkedAge: '5 分鐘前', reason: null })
    expect(card.last6).toEqual([true, true, true, true, true, true])
  })

  it('失敗 → 紅、帶 reason；last6 超過 6 個只取前 6', () => {
    const card = siteCard(
      'test',
      { ok: false, commit: null, checkedAt: null, last6: [false, true, false, true, true, true, true], reason: 'worker 心跳逾時' },
      NOW,
    )
    expect(card).toMatchObject({ state: 'red', okText: '失敗', commitShort: null, checkedAt: null, reason: 'worker 心跳逾時' })
    expect(card.last6).toEqual([false, true, false, true, true, true])
  })

  it('沒有這站 → 灰、沒有點', () => {
    expect(siteCard('prod', null, NOW)).toMatchObject({ state: 'grey', okText: '還沒有健康資料', last6: [] })
  })
})

describe('chartView', () => {
  it('fixture：兩個系列 test、prod，各 288 點，ms 原樣變 value', () => {
    const metrics = load<MetricsData>('metrics.json')
    const v = chartView(metrics)
    expect(v.state).toBe('ok')
    expect(v.series.map((s) => [s.id, s.label, s.points.length])).toEqual([
      ['test', '測試站', 288],
      ['prod', '正式站', 288],
    ])
    expect(v.series[0]!.points[0]).toEqual({ at: metrics.sites.test!.points[0]!.at, value: metrics.sites.test!.points[0]!.ms })
  })

  it('沒有 metrics.json → none「還沒有 Gatus 資料」', () => {
    expect(chartView(null)).toMatchObject({ state: 'none', series: [] })
    expect(chartView(null).note).toContain('還沒有 Gatus 資料')
  })

  it('兩站都是 null → none，帶本輪錯誤', () => {
    const v = chartView({ generatedAt: 'x', gatusOk: false, error: 'HTTP 502', sites: { test: null, prod: null } })
    expect(v).toMatchObject({ state: 'none', error: 'HTTP 502' })
    expect(v.note).toContain('還沒有 Gatus 資料')
  })

  it('gatusOk:false 但保留上次值 → stale：照畫舊圖、「Gatus 本輪失敗，資料時間」取兩站較新的 fetchedAt', () => {
    const metrics = load<MetricsData>('metrics.json')
    metrics.gatusOk = false
    metrics.error = 'HTTP 502'
    metrics.sites.test!.fetchedAt = '2026-10-12T07:00:00+08:00'
    metrics.sites.prod!.fetchedAt = '2026-10-12T06:00:00+08:00'
    const v = chartView(metrics)
    expect(v).toMatchObject({ state: 'stale', note: 'Gatus 本輪失敗，資料時間 10/12 07:00', error: 'HTTP 502' })
    expect(v.series).toHaveLength(2)
  })
})

describe('uptimeRows', () => {
  it('fixture：兩列，跟 metrics.json 一致（百分比一位小數、ms 整數）', () => {
    expect(uptimeRows(load<MetricsData>('metrics.json'))).toEqual([
      { site: 'test', label: '測試站', uptime24h: '99.7%', uptime7d: '99.9%', avgMs24h: '213 ms', failures24h: '1' },
      { site: 'prod', label: '正式站', uptime24h: '100.0%', uptime7d: '100.0%', avgMs24h: '226 ms', failures24h: '0' },
    ])
  })

  it('沒有 metrics.json、或某站 null、或窗口內 0 筆（統計是 null）→ 「—」', () => {
    const dash = { uptime24h: '—', uptime7d: '—', avgMs24h: '—', failures24h: '—' }
    expect(uptimeRows(null)).toEqual([
      { site: 'test', label: '測試站', ...dash },
      { site: 'prod', label: '正式站', ...dash },
    ])
    const rows = uptimeRows({
      generatedAt: 'x',
      gatusOk: true,
      error: null,
      sites: {
        test: { fetchedAt: 'x', uptime24h: null, uptime7d: 0.98, avgMs24h: null, failures24h: null, points: [] },
        prod: null,
      },
    })
    expect(rows[0]).toEqual({ site: 'test', label: '測試站', ...dash, uptime7d: '98.0%' })
    expect(rows[1]).toEqual({ site: 'prod', label: '正式站', ...dash })
  })
})

describe('sourceNotes', () => {
  it('健康檢查來源本輪失敗才有一句；其他來源失敗不算', () => {
    const collector = load<CollectorStatus>('collector.json')
    expect(sourceNotes(collector, NOW)).toEqual([])
    collector.sources.github = { ok: false, at: '2026-10-12T09:00:00+08:00', error: 'HTTP 500' }
    expect(sourceNotes(collector, NOW)).toEqual([])
    collector.sources.health = { ok: false, at: '2026-10-12T08:00:00+08:00', error: 'timeout' }
    expect(sourceNotes(collector, NOW)).toEqual(['收集器本輪抓健康檢查失敗（timeout），1 小時前；下面是上次成功的資料'])
    expect(sourceNotes(null, NOW)).toEqual([])
  })
})

describe('buildHealthView', () => {
  it('fixture：兩張站卡、圖、兩列可用率、Access 四列', () => {
    const v = buildHealthView(
      { health: load('health.json'), metrics: load('metrics.json'), collector: load('collector.json') },
      NOW,
    )
    expect(v.sites.map((s) => [s.site, s.state])).toEqual([
      ['test', 'green'],
      ['prod', 'green'],
    ])
    expect(v.chart.state).toBe('ok')
    expect(v.uptime).toHaveLength(2)
    expect(v.access).toHaveLength(4)
    expect(v.access![0]).toEqual({
      host: 'fju-status.roy422.dev',
      guarded: true,
      status: '302',
      location: 'https://example-team.cloudflareaccess.com/cdn-cgi/access/login/',
    })
  })

  it('全部沒有：站卡灰、圖 none、表全「—」、Access 是 null', () => {
    const v = buildHealthView({ health: null, metrics: null, collector: null }, NOW)
    expect(v.sites.map((s) => s.state)).toEqual(['grey', 'grey'])
    expect(v.chart.state).toBe('none')
    expect(v.uptime.every((r) => r.uptime24h === '—')).toBe(true)
    expect(v.access).toBeNull()
  })

  it('Access 某列沒有 status、location → 「—」', () => {
    const health = load<HealthData>('health.json')
    health.accessGuard = [{ host: 'x.example', guarded: false, status: null, location: null }]
    expect(buildHealthView({ health, metrics: null, collector: null }, NOW).access).toEqual([
      { host: 'x.example', guarded: false, status: '—', location: '—' },
    ])
  })
})
