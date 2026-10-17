// metrics.json（DV 設計方案 §7.3）：Gatus 兩站端點（group site 的 test／prod）24h 回應時間與可用率。
//  - 每輪對 Gatus 固定三次：statuses（pageSize=288，每個端點最多 288 筆＝24h）一次、兩站 uptimes/7d 各一次；
//    每次用 cfg.timeoutMs、失敗不重試。group access 的端點丟掉。
//  - 24h 窗口：先依 timestamp 篩 [now−24h, now]，再依時間舊到新取最後 ≤ 288 筆（最近 288 筆不保證都在 24h 內）。
//  - 失敗保留上次成功值：某站拿不到就沿用上一版 metrics.json 的那一站（連同原本的 fetchedAt），
//    gatusOk:false、error 只放安全的分類文字（HTTP 502、timeout…），不放網址或原始訊息。
import { HttpError, fetchRaw } from './http.mjs'

export const SITES = ['test', 'prod']
export const MAX_POINTS = 288
const DAY_MS = 24 * 3600e3

/** 錯誤轉成安全的分類文字。 */
export function classifyError(err) {
  if (err instanceof HttpError) {
    if (err.status > 0) return `HTTP ${err.status}`
    return /TimeoutError|AbortError/.test(err.message) ? 'timeout' : 'unreachable'
  }
  return err?.kind ?? 'bad-response'
}

function badResponse() {
  return Object.assign(new Error('bad-response'), { kind: 'bad-response' })
}

async function get(cfg, pathname) {
  const res = await fetchRaw(`${cfg.gatusUrl}${pathname}`, { timeoutMs: cfg.timeoutMs })
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status)
  return res.text()
}

/** Gatus 的 time.Duration 是奈秒整數；回傳 ms（四捨五入），認不得就 null。 */
function toMs(duration) {
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? Math.round(duration / 1e6) : null
}

/** 一個端點的 results → 窗口內 points（舊到新、≤ 288 筆）與 24h 統計。 */
export function summarizeResults(results, now) {
  const end = now.getTime()
  const start = end - DAY_MS
  const inWindow = []
  for (const r of Array.isArray(results) ? results : []) {
    const t = Date.parse(r?.timestamp)
    const ms = toMs(r?.duration)
    if (Number.isNaN(t) || ms === null || t < start || t > end) continue
    inWindow.push({ t, point: { at: new Date(t).toISOString(), ms, ok: r.success === true } })
  }
  inWindow.sort((a, b) => a.t - b.t)
  const points = inWindow.slice(-MAX_POINTS).map((x) => x.point)
  if (points.length === 0) return { uptime24h: null, avgMs24h: null, failures24h: null, points }
  const okCount = points.filter((p) => p.ok).length
  return {
    uptime24h: Math.round((okCount / points.length) * 1e4) / 1e4,
    avgMs24h: Math.round(points.reduce((sum, p) => sum + p.ms, 0) / points.length),
    failures24h: points.length - okCount,
    points,
  }
}

/** uptimes/7d 回 text/plain 的 %f（例如 0.998264）。 */
export function parseUptime(text) {
  const v = Number(String(text).trim())
  if (String(text).trim() === '' || !Number.isFinite(v) || v < 0 || v > 1) throw badResponse()
  return v
}

function previousSites(prev) {
  const sites = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev.sites : null
  return Object.fromEntries(SITES.map((s) => [s, sites && typeof sites === 'object' ? (sites[s] ?? null) : null]))
}

/** 回傳 metrics.json 的內容（不含 generatedAt）；不 throw。 */
export async function fetchMetrics(cfg, now, prev) {
  const sites = previousSites(prev)
  const errors = []
  let statuses = null
  try {
    const body = JSON.parse(await get(cfg, `/api/v1/endpoints/statuses?page=1&pageSize=${MAX_POINTS}`))
    if (!Array.isArray(body)) throw badResponse()
    statuses = body
  } catch (err) {
    errors.push(err instanceof SyntaxError ? 'bad-response' : classifyError(err))
  }
  if (statuses) {
    for (const site of SITES) {
      const endpoint = statuses.find((s) => s?.group === 'site' && s?.name === site)
      if (!endpoint) {
        errors.push(`${site}: no-endpoint`)
        continue
      }
      try {
        const uptime7d = parseUptime(await get(cfg, `/api/v1/endpoints/site_${site}/uptimes/7d`))
        const { uptime24h, avgMs24h, failures24h, points } = summarizeResults(endpoint.results, now)
        sites[site] = { fetchedAt: now.toISOString(), uptime24h, uptime7d, avgMs24h, failures24h, points }
      } catch (err) {
        errors.push(`${site}: ${classifyError(err)}`)
      }
    }
  }
  return { gatusOk: errors.length === 0, error: errors.length ? errors.join('；') : null, sites }
}
