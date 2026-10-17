// AC-DV-07：Gatus 回應 → metrics.json 的 sites。fixtures/gatus-statuses.json 是真 Gatus v5.37.0 的
// GET /api/v1/endpoints/statuses?page=1&pageSize=288 回應存檔（duration 是奈秒整數，result 帶 hostname）。
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../testing/fakes.mjs'
import { classifyError, fetchMetrics, parseUptime, summarizeResults } from './metrics.mjs'
import { serializeChecked } from './files.mjs'
import { HttpError } from './http.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const STATUSES = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'gatus-statuses.json'), 'utf8'))
const endpoint = (key) => STATUSES.find((e) => e.key === key)
const lastAt = (key) => Date.parse(endpoint(key).results.at(-1).timestamp)
// 固定 now：存檔裡最後一筆的一分鐘後
const NOW = new Date(Math.max(lastAt('site_test'), lastAt('site_prod')) + 60e3)

let server
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function gatus(routes) {
  server = await startServer(routes)
  return { gatusUrl: `${server.base}/gatus`, timeoutMs: 3000 }
}

const uptime = (value) => () => ({ body: value, headers: { 'content-type': 'text/plain' } })
const realRoutes = {
  'GET /gatus/api/v1/endpoints/statuses': () => ({ body: STATUSES }),
  'GET /gatus/api/v1/endpoints/site_test/uptimes/7d': uptime('0.999000'),
  'GET /gatus/api/v1/endpoints/site_prod/uptimes/7d': uptime('0.250000'),
}

/** 以存檔裡一筆真 result 當模板，從 end 往回每 stepMin 分鐘一筆，共 n 筆（舊到新）。 */
function series(n, end, stepMin, ok = () => true) {
  const tpl = endpoint('site_test').results[0]
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(end.getTime() - (n - 1 - i) * stepMin * 60e3)
    return { ...tpl, success: ok(i), duration: 180e6 + i * 1e6, timestamp: at.toISOString() }
  })
}

describe('真 Gatus 回應存檔', () => {
  it('存檔是兩個 site 端點各 ≥ 3 筆、duration 是奈秒整數', () => {
    for (const key of ['site_test', 'site_prod']) {
      const results = endpoint(key).results
      expect(results.length).toBeGreaterThanOrEqual(3)
      for (const r of results) expect(Number.isInteger(r.duration)).toBe(true)
    }
    expect(STATUSES.some((e) => e.group === 'access')).toBe(true)
  })

  it('轉成 sites：ms = round(duration / 1e6)、舊到新、只有 at／ms／ok；uptime7d 取 API 數字；access 端點丟掉', async () => {
    const cfg = await gatus(realRoutes)
    const m = await fetchMetrics(cfg, NOW, null)
    expect(m.gatusOk).toBe(true)
    expect(m.error).toBeNull()
    expect(Object.keys(m.sites)).toEqual(['test', 'prod'])
    for (const [site, key] of [['test', 'site_test'], ['prod', 'site_prod']]) {
      const raw = endpoint(key).results
      const s = m.sites[site]
      expect(s.fetchedAt).toBe(NOW.toISOString())
      expect(s.points).toEqual(raw.map((r) => ({ at: new Date(r.timestamp).toISOString(), ms: Math.round(r.duration / 1e6), ok: r.success })))
      const okCount = raw.filter((r) => r.success).length
      expect(s.uptime24h).toBe(Math.round((okCount / raw.length) * 1e4) / 1e4)
      expect(s.failures24h).toBe(raw.length - okCount)
      expect(s.avgMs24h).toBe(Math.round(s.points.reduce((a, p) => a + p.ms, 0) / s.points.length))
    }
    // 存檔：測試站全成功、正式站全失敗（擷取時正式站假站回 502）
    expect(m.sites.test.uptime24h).toBe(1)
    expect(m.sites.prod.uptime24h).toBe(0)
    expect(m.sites.test.uptime7d).toBe(0.999)
    expect(m.sites.prod.uptime7d).toBe(0.25)
    expect(JSON.stringify(m)).not.toContain('hostname')
    // 過得了寫檔前的白名單與遮蔽（result 的 hostname 是 IP，不能漏到輸出）
    expect(() => serializeChecked('metrics.json', { generatedAt: NOW.toISOString(), ...m })).not.toThrow()
    // statuses 一次＋兩站 uptimes 各一次
    expect(server.seen.filter((s) => s.startsWith('GET /gatus/'))).toHaveLength(3)
  })
})

describe('24h 窗口：先篩後截', () => {
  it('300 筆其中 20 筆在 25h 前：窗口外的不進 points 也不進可用率', () => {
    // 前 20 筆在 25h 前且全失敗，後 280 筆在窗口內且第 0 筆失敗
    const old = series(20, new Date(NOW.getTime() - 25 * 3600e3), 5, () => false)
    const recent = series(280, NOW, 5, (i) => i !== 0)
    const s = summarizeResults([...old, ...recent], NOW)
    expect(s.points).toHaveLength(280)
    expect(s.points[0].at).toBe(recent[0].timestamp)
    expect(s.failures24h).toBe(1)
    expect(s.uptime24h).toBe(Math.round((279 / 280) * 1e4) / 1e4)
    expect(s.uptime24h).toBe(0.9964)
  })

  it('窗口內超過 288 筆：取最新的 288 筆、舊到新', () => {
    const results = series(300, NOW, 4)
    const s = summarizeResults(results, NOW)
    expect(s.points).toHaveLength(288)
    expect(s.points[0].at).toBe(results[12].timestamp)
    expect(s.points.at(-1).at).toBe(results[299].timestamp)
    expect(s.points[0].ms).toBe(192)
  })

  it('Gatus 回的順序亂掉也照時間排；未來時間的結果不算', () => {
    const results = series(3, NOW, 5)
    const future = { ...results[0], timestamp: new Date(NOW.getTime() + 60e3).toISOString() }
    const s = summarizeResults([results[2], future, results[0], results[1]], NOW)
    expect(s.points.map((p) => p.at)).toEqual(results.map((r) => r.timestamp))
  })

  it('窗口內 0 筆：uptime24h、avgMs24h、failures24h 都是 null', () => {
    const s = summarizeResults(series(5, new Date(NOW.getTime() - 30 * 3600e3), 5), NOW)
    expect(s).toEqual({ uptime24h: null, avgMs24h: null, failures24h: null, points: [] })
  })
})

describe('失敗', () => {
  const prev = {
    generatedAt: '2026-10-16T13:00:00.000Z',
    gatusOk: true,
    error: null,
    sites: {
      test: { fetchedAt: '2026-10-16T13:00:00.000Z', uptime24h: 1, uptime7d: 1, avgMs24h: 10, failures24h: 0, points: [] },
      prod: null,
    },
  }

  it('逾時：error 是 timeout、保留上一版、只打一次（不重試）', async () => {
    const slow = http.createServer(() => {}) // 永遠不回
    await new Promise((r) => slow.listen(0, '127.0.0.1', r))
    let hits = 0
    slow.on('request', () => hits++)
    try {
      const m = await fetchMetrics({ gatusUrl: `http://127.0.0.1:${slow.address().port}`, timeoutMs: 200 }, NOW, prev)
      expect(m).toEqual({ gatusOk: false, error: 'timeout', sites: prev.sites })
      expect(hits).toBe(1)
    } finally {
      slow.closeAllConnections()
      await new Promise((r) => slow.close(r))
    }
  })

  it('statuses 回 502：error 是 HTTP 502、不打 uptimes', async () => {
    const cfg = await gatus({ ...realRoutes, 'GET /gatus/api/v1/endpoints/statuses': () => ({ status: 502, body: 'x' }) })
    const m = await fetchMetrics(cfg, NOW, prev)
    expect(m).toEqual({ gatusOk: false, error: 'HTTP 502', sites: prev.sites })
    expect(server.seen).toEqual(['GET /gatus/api/v1/endpoints/statuses'])
  })

  it('回的不是 JSON 陣列、uptime 不是 0～1 的數字：bad-response', async () => {
    let cfg = await gatus({ ...realRoutes, 'GET /gatus/api/v1/endpoints/statuses': () => ({ body: '<html>' }) })
    expect((await fetchMetrics(cfg, NOW, prev)).error).toBe('bad-response')
    await server.close()
    cfg = await gatus({ ...realRoutes, 'GET /gatus/api/v1/endpoints/site_prod/uptimes/7d': uptime('NaN') })
    const m = await fetchMetrics(cfg, NOW, prev)
    expect(m.error).toBe('prod: bad-response')
    expect(m.sites.prod).toBeNull() // 沒有上一版
    expect(m.sites.test.fetchedAt).toBe(NOW.toISOString())
  })

  it('某站端點不在 statuses 裡：該站保留上一版、不打它的 uptimes', async () => {
    const onlyProd = STATUSES.filter((e) => e.key !== 'site_test')
    const cfg = await gatus({ ...realRoutes, 'GET /gatus/api/v1/endpoints/statuses': () => ({ body: onlyProd }) })
    const m = await fetchMetrics(cfg, NOW, prev)
    expect(m.error).toBe('test: no-endpoint')
    expect(m.sites.test).toEqual(prev.sites.test)
    expect(server.seen).not.toContain('GET /gatus/api/v1/endpoints/site_test/uptimes/7d')
  })

  it('錯誤只留分類文字，不帶網址或 IP', () => {
    expect(classifyError(new HttpError('連不到 127.0.0.1:9/api（ECONNREFUSED）', 0))).toBe('unreachable')
    expect(classifyError(new HttpError('連不到 gatus:8080/api（TimeoutError）', 0))).toBe('timeout')
    expect(classifyError(new HttpError('x', 503))).toBe('HTTP 503')
    expect(parseUptime('0.998264\n')).toBe(0.998264)
    expect(() => parseUptime('')).toThrow()
    expect(() => parseUptime('1.5')).toThrow()
  })
})
