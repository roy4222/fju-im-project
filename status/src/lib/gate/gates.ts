/**
 * 五條「能不能上線」的判定（設計方案 §3.8）。純函式：吃 collector 的 JSON 與「現在」，回綠／紅／灰與原因。
 * G2（驗收）比較長，在 acceptance.ts。
 */
import type { GithubData, HealthData, VmData } from '@/lib/data/types'

import { evaluateAcceptance } from './acceptance'
import type { GateInput, GateResult, GoLiveVerdict } from './types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** 多久以前（毫秒）；時間字串壞掉或沒有是 null。 */
function age(at: string | null | undefined, now: Date): number | null {
  if (!at) return null
  const t = Date.parse(at)
  return Number.isNaN(t) ? null : now.getTime() - t
}

/** 「25 小時前」「40 分鐘前」。 */
export function formatAge(ms: number): string {
  if (ms < HOUR) return `${Math.max(0, Math.floor(ms / MINUTE))} 分鐘前`
  return `${Math.floor(ms / HOUR)} 小時前`
}

// ───────────────────────── G1 CI 全綠 ─────────────────────────

const G1 = 'CI 全綠'
const JOB_OK = new Set(['success', 'skipped'])

export function evaluateCi(github: GithubData | null, now: Date): GateResult {
  const base = { id: 'G1' as const, title: G1 }
  if (!github) return { ...base, state: 'grey', summary: '還沒有 GitHub 資料', reasons: [] }
  const link = github.ci?.url ? { href: github.ci.url, label: '看 CI 這次執行' } : undefined
  if (github.fetchError) return { ...base, state: 'grey', summary: 'GitHub 資料抓取失敗', reasons: [github.fetchError], link }
  const a = age(github.generatedAt, now)
  if (a === null || a > 30 * MINUTE) {
    return { ...base, state: 'grey', summary: 'GitHub 資料超過 30 分鐘沒更新', reasons: [], link }
  }
  const ci = github.ci
  if (!ci || !github.mainSha) return { ...base, state: 'grey', summary: '還沒有 main 的 CI 紀錄', reasons: [], link }
  if (ci.headSha !== github.mainSha) {
    return { ...base, state: 'grey', summary: 'main 最新 commit 的 CI 還沒有結果', reasons: [`CI 最後跑的是 ${ci.headSha.slice(0, 7)}，main 是 ${github.mainSha.slice(0, 7)}`], link }
  }
  if (ci.status !== 'completed' || ci.conclusion === null) {
    return { ...base, state: 'grey', summary: 'main 最新 commit 的 CI 還在跑', reasons: [], link }
  }
  if (ci.conclusion === 'success') return { ...base, state: 'green', summary: `main（${ci.headSha.slice(0, 7)}）的 CI 全部通過`, reasons: [], link }
  const failed = (ci.jobs ?? []).filter((j) => !JOB_OK.has(j.conclusion ?? '')).map((j) => `${j.name}（${j.conclusion ?? '沒有結果'}）`)
  return {
    ...base,
    state: 'red',
    summary: failed.length ? `CI 沒過：${failed.map((f) => f.replace(/（.*$/, '')).join('、')}` : `CI 結果是 ${ci.conclusion}`,
    reasons: failed,
    link,
  }
}

// ───────────────────────── G3 測試站健康 ─────────────────────────

const G3 = '測試站健康'

export function evaluateHealth(health: HealthData | null, now: Date): GateResult {
  const base = { id: 'G3' as const, title: G3 }
  const test = health?.test ?? null
  if (!test) return { ...base, state: 'grey', summary: '還沒有測試站健康檢查資料', reasons: [] }
  const a = age(test.checkedAt ?? health?.generatedAt, now)
  if (a === null || a > 20 * MINUTE) return { ...base, state: 'grey', summary: '健康檢查資料超過 20 分鐘沒更新', reasons: [] }
  const last6 = Array.isArray(test.last6) ? test.last6 : []
  // collector 的 ok 已含 health-cron 的整套規則（200、ok、commit、worker 心跳 ≤ 300 秒）；它說不過就是不過，六筆紀錄救不了。
  if (test.ok !== true) {
    return { ...base, state: 'red', summary: '測試站健康檢查不過', reasons: test.reason ? [test.reason] : [] }
  }
  if (last6.length && last6[0] === false) {
    return { ...base, state: 'red', summary: '測試站最近一次健康檢查失敗', reasons: test.reason ? [test.reason] : [] }
  }
  if (last6.length < 6) return { ...base, state: 'grey', summary: `健康檢查紀錄不到 6 次（目前 ${last6.length} 次）`, reasons: [] }
  if (last6.slice(0, 6).every(Boolean)) return { ...base, state: 'green', summary: '最近 6 次（30 分鐘）健康檢查全過', reasons: [] }
  // 規格沒定義「最近一次過、但 30 分鐘內有失敗」：算資料不夠，等連續 6 次通過。
  return { ...base, state: 'grey', summary: '剛恢復，還沒連續 6 次通過', reasons: [`最近 6 次：${last6.slice(0, 6).map((ok) => (ok ? '過' : '失敗')).join('、')}（新到舊）`] }
}

// ───────────────────────── G4 24 小時內有備份 ─────────────────────────

const G4 = '24 小時內有正式站備份'

/** vm.json 本身太舊（收集器停了）時不拿舊資料判綠。 */
function vmStale(vm: VmData, now: Date): boolean {
  const a = age(vm.generatedAt, now)
  return a === null || a > 30 * MINUTE
}

export function evaluateBackup(vm: VmData | null, now: Date): GateResult {
  const base = { id: 'G4' as const, title: G4 }
  if (!vm) return { ...base, state: 'grey', summary: '還沒有 VM 資料', reasons: [] }
  if (vmStale(vm, now)) return { ...base, state: 'grey', summary: 'VM 資料超過 30 分鐘沒更新', reasons: [] }
  const backup = vm.backups?.prod
  const latest = backup?.latest ?? null
  const notes = backup?.lastRecord && !backup.lastRecord.ok ? [`最後一筆備份紀錄（${backup.lastRecord.at}）是失敗`] : []
  if (!latest) return { ...base, state: 'red', summary: '正式站還沒有任何備份', reasons: notes }
  const a = age(latest.mtime, now)
  if (a === null) return { ...base, state: 'red', summary: `最新備份 ${latest.name} 的時間讀不懂`, reasons: notes }
  if (a > 24 * HOUR) return { ...base, state: 'red', summary: `最新備份 ${formatAge(a)}`, reasons: [latest.name, ...notes] }
  if (!(latest.bytes > 0)) return { ...base, state: 'red', summary: `最新備份 ${latest.name} 是 0 bytes`, reasons: notes }
  return { ...base, state: 'green', summary: `最新備份 ${formatAge(a)}（${latest.name}）`, reasons: notes }
}

// ───────────────────────── G5 正式站設定齊全 ─────────────────────────

const G5 = '正式站設定齊全'

export function evaluateProdEnv(vm: VmData | null, now: Date): GateResult {
  const base = { id: 'G5' as const, title: G5 }
  if (!vm) return { ...base, state: 'grey', summary: '還沒有 VM 資料', reasons: [] }
  if (vmStale(vm, now)) return { ...base, state: 'grey', summary: 'VM 資料超過 30 分鐘沒更新', reasons: [] }
  const env = vm.prodEnv
  const a = age(env?.checkedAt, now)
  if (!env || a === null || a > 26 * HOUR) return { ...base, state: 'grey', summary: '設定檢查超過 26 小時沒跑', reasons: [] }
  const reasons = [
    ...(env.missing ?? []).map((k) => `缺少：${k}`),
    ...(env.forbiddenPresent ?? []).map((k) => `不該有：${k}`),
  ]
  if (env.flags?.REGISTRATION_OPEN !== 'false' && env.flags?.REGISTRATION_OPEN !== 'absent') reasons.push('REGISTRATION_OPEN 不是 false')
  if (env.flags?.BUSINESS_CLOCK_OVERRIDE_ENABLED !== 'false') reasons.push('BUSINESS_CLOCK_OVERRIDE_ENABLED 不是 false')
  if (reasons.length) return { ...base, state: 'red', summary: `正式站設定有 ${reasons.length} 處不對`, reasons }
  return { ...base, state: 'green', summary: `正式站設定齊全（${formatAge(a)}檢查）`, reasons: [] }
}

// ───────────────────────── 五條合起來 ─────────────────────────

export function evaluateGoLive(input: GateInput, now: Date): GoLiveVerdict {
  const gates = [
    evaluateCi(input.github, now),
    evaluateAcceptance(input.acceptance),
    evaluateHealth(input.health, now),
    evaluateBackup(input.vm, now),
    evaluateProdEnv(input.vm, now),
  ]
  return { canGoLive: gates.every((g) => g.state === 'green'), gates }
}
