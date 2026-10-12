// health.json（設計方案 §3.3）。
//  - last6：Gatus 內部 API（group site 的 test／prod），last6[0] 是最近一次。
//  - commit 與「worker 心跳 ≤ 300 秒」：Gatus 的條件沒有日期運算，也不能讀回應 header，
//    所以 collector 每輪自己打一次 /api/health，用跟 health-cron.yml 的 CHECK 相同的規則判斷。
//  - accessGuard：同理，Location header 由 collector 自己用不跟隨轉址的請求讀；只留
//    origin＋路徑（Access 登入網址的 query 帶 meta token，不能寫進檔）。
import { fetchJson, fetchRaw } from './http.mjs'
import { scrubIp } from './redact.mjs'

export const HEARTBEAT_MAX_SECONDS = 300

/** 與 health-cron.yml 的 CHECK 同規則：ok === true、commit 非空字串、lastTickAt 在 300 秒內。 */
export function judgeHealthBody(body, now) {
  if (!body || body.ok !== true) return '回應的 ok 不是 true'
  if (typeof body.commit !== 'string' || body.commit.length === 0) return '回應沒有 commit'
  const tick = body.worker?.lastTickAt
  if (typeof tick !== 'string') return 'worker 沒有心跳時間'
  const at = Date.parse(tick)
  if (Number.isNaN(at)) return 'worker 心跳時間格式不對'
  const age = (now.getTime() - at) / 1000
  if (age > HEARTBEAT_MAX_SECONDS) return `worker 心跳 ${Math.round(age)} 秒前（超過 ${HEARTBEAT_MAX_SECONDS} 秒）`
  return null
}

async function directCheck(url, now, timeoutMs) {
  let res
  try {
    res = await fetchRaw(url, { timeoutMs })
  } catch (err) {
    return { commit: null, reason: err.message }
  }
  let body = null
  try {
    body = JSON.parse(await res.text())
  } catch {
    // 下面依狀態碼回報
  }
  const commit = typeof body?.commit === 'string' && /^[0-9A-Za-z._-]{1,64}$/.test(body.commit) ? body.commit : null
  if (res.status !== 200) return { commit, reason: `/api/health 回 HTTP ${res.status}` }
  return { commit, reason: judgeHealthBody(body, now) }
}

function gatusReason(result) {
  if (!result) return null
  if (result.success) return null
  const failed = (result.conditionResults ?? []).filter((c) => !c.success).map((c) => c.condition)
  const parts = [...failed, ...(result.errors ?? [])]
  return parts.length ? scrubIp(parts.join('；')).slice(0, 300) : 'Gatus 判定失敗'
}

/** Gatus 的 results 是舊到新；回傳新到舊的最近 6 筆。 */
export function lastResults(status, n = 6) {
  return (status?.results ?? []).slice(-n).reverse()
}

export function siteHealth(gatusStatus, direct) {
  const recent = lastResults(gatusStatus)
  const latest = recent[0] ?? null
  const reasons = []
  if (!latest) reasons.push('Gatus 還沒有紀錄')
  const g = gatusReason(latest)
  if (g) reasons.push(g)
  if (direct.reason) reasons.push(direct.reason)
  return {
    ok: Boolean(latest?.success) && !direct.reason,
    commit: direct.commit,
    checkedAt: latest?.timestamp ?? null,
    last6: recent.map((r) => Boolean(r.success)),
    reason: reasons.length ? reasons.join('；') : null,
  }
}

export function judgeAccessGuard({ status, location }, teamDomain) {
  if (status !== 302 || !location) return false
  let u
  try {
    u = new URL(location)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || !u.pathname.startsWith('/cdn-cgi/access/login')) return false
  return teamDomain ? u.host === teamDomain : u.host.endsWith('.cloudflareaccess.com')
}

async function probeAccess(host, template, teamDomain, timeoutMs) {
  const url = template.replaceAll('{host}', host)
  try {
    const res = await fetchRaw(url, { redirect: 'manual', timeoutMs })
    const raw = res.headers.get('location')
    let location = null
    if (raw) {
      try {
        const u = new URL(raw, url)
        location = `${u.origin}${u.pathname}`
      } catch {
        location = null
      }
    }
    return { host, guarded: judgeAccessGuard({ status: res.status, location }, teamDomain), status: res.status, location }
  } catch (err) {
    return { host, guarded: false, status: null, location: null, error: err.message }
  }
}

export async function fetchHealth(cfg, now) {
  let statuses = []
  let gatusError = null
  try {
    const body = await fetchJson(`${cfg.gatusUrl}/api/v1/endpoints/statuses?page=1&pageSize=6`, {
      timeoutMs: cfg.timeoutMs,
    })
    statuses = Array.isArray(body) ? body : []
  } catch (err) {
    gatusError = err.message
  }
  const find = (group, name) => statuses.find((s) => s.group === group && s.name === name) ?? null

  const sites = {}
  for (const site of ['test', 'prod']) {
    const direct = await directCheck(cfg.healthUrls[site], now, cfg.timeoutMs)
    sites[site] = siteHealth(find('site', site), direct)
    if (gatusError) sites[site].reason = [gatusError, sites[site].reason].filter(Boolean).join('；')
  }
  const accessGuard = []
  for (const host of cfg.hosts) {
    const probe = await probeAccess(host, cfg.accessProbeTemplate, cfg.accessTeamDomain, cfg.timeoutMs)
    const latest = lastResults(find('access', host), 1)[0]
    accessGuard.push({ ...probe, gatusOk: latest ? Boolean(latest.success) : null })
  }
  return { value: { ...sites, accessGuard }, error: gatusError }
}
