/**
 * 總覽（DV 設計方案 §4）要畫的東西。純函式：吃 `loadOverview()` 一次讀齊的資料與「現在」，回畫面直接用的資料。
 *
 * 總覽只放結論，正本都在子頁（§2）：版本與 CI → `/deploy`、備份與儲存 → `/backup`、
 * Gatus 圖 → `/health`、五條 → `/go-live`、事件 → `/errors`。能委派給子頁 lib 的判法都委派，不另寫一份。
 *
 * 正式站「尚未開站」（Q-DV-2 定案）：`health.prod.ok:false` 且 `vm.prodDns.hasA:false`。
 * 這時狀態列顯示灰字、版本一致不看正式站列、24h 錯誤不算正式站、備份卡看測試站；G5 照常紅。
 */
import { backupSiteView, diskView, formatBytes } from '@/lib/backup/view'
import type { CollectorStatus, HealthData, IsoTime, MetricsData, Site, VmData } from '@/lib/data/types'
import { buildVersionRows, shortSha } from '@/lib/data/version'
import { formatTime, runView } from '@/lib/deploy/view'
import { buildEvents, OVERVIEW_LIMIT, type StatusEvent } from '@/lib/events/events'
import { evaluateBackup, evaluateGoLive, formatAge } from '@/lib/gate/gates'
import type { GateInput, GateResult } from '@/lib/gate/types'
import { chartView, DASH, formatPercent, SITE_LABEL, type ChartView } from '@/lib/health/view'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** collector 超過這麼久沒跑 → 狀態列「資料過期」（跟 `gates.ts` 的 vmStale 同一個 30 分鐘）。 */
export const STALE_MS = 30 * MINUTE
/** 24h 錯誤的小條圖幾格（每格一小時）。 */
export const ERROR_BUCKETS = 24

export type OverviewData = {
  /** `loadGateInput()` 讀的六個檔＋最新一夜 run／summary */
  gate: GateInput
  metrics: MetricsData | null
  collector: CollectorStatus | null
}

export type KpiState = 'green' | 'yellow' | 'red' | 'grey'
export type KpiId = 'version' | 'errors' | 'backup' | 'disk' | 'ci'

export type Kpi = {
  id: KpiId
  title: string
  state: KpiState
  /** 大字 */
  value: string
  /** 小字，一行一句 */
  notes: string[]
  href: string
  /** 主機儲存的進度條（0～100）；其他卡沒有 */
  bar?: number | null
  /** 24h 錯誤的每小時失敗數，舊到新 24 格；其他卡沒有 */
  buckets?: number[]
}

export type SitePill = { site: Site; label: string; state: 'ok' | 'fail' | 'none' | 'not-open'; text: string }

export type StatusBarView = {
  tone: KpiState
  /** 「全部正常」「1 項要注意」「2 項異常」「資料過期（45 分鐘前）」「沒有資料」 */
  text: string
  /** 「5 分鐘前更新」；資料過期或不知道時間時是 null */
  updated: string | null
  sites: SitePill[]
}

export type OverviewChart = {
  view: ChartView
  /** 測試站 24h／7d 可用率（「99.7%」；沒有是「—」） */
  uptime24h: string
  uptime7d: string
}

export type OverviewView = {
  statusBar: StatusBarView
  kpis: Kpi[]
  chart: OverviewChart
  goLive: { gates: GateResult[]; green: number }
  events: StatusEvent[]
}

function age(at: string | null | undefined, now: Date): number | null {
  if (!at) return null
  const t = Date.parse(at)
  return Number.isNaN(t) ? null : now.getTime() - t
}

const ageText = (at: string | null | undefined, now: Date) => {
  const a = age(at, now)
  return a === null ? null : formatAge(a)
}

const TAIPEI_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
const TAIPEI_HM = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** 台北時間「今天 03:30」「昨天 22:10」，更早是「10/09 03:30」。壞掉的時間字串原樣回。 */
export function formatDay(at: IsoTime, now: Date): string {
  const t = new Date(at)
  if (Number.isNaN(t.getTime())) return at
  const day = TAIPEI_DAY.format(t)
  const hm = TAIPEI_HM.format(t)
  if (day === TAIPEI_DAY.format(now)) return `今天 ${hm}`
  if (day === TAIPEI_DAY.format(new Date(now.getTime() - 24 * HOUR))) return `昨天 ${hm}`
  return formatTime(at)
}

/** 正式站尚未開站（Q-DV-2 定案）：健康檢查失敗且網域沒有 A 記錄。 */
export function prodNotOpen(health: HealthData | null, vm: VmData | null): boolean {
  return health?.prod?.ok === false && vm?.prodDns?.hasA === false
}

// ───────────────────────── KPI 五卡（§4.2） ─────────────────────────

function versionKpi(gate: GateInput, notOpen: boolean): Kpi {
  const base = { id: 'version' as const, title: '版本一致', href: '/deploy' }
  if (!gate.github) return { ...base, state: 'grey', value: DASH, notes: ['還沒有 GitHub 資料'] }
  const rows = buildVersionRows(gate)
  const considered = notOpen ? rows.filter((r) => r.site === 'test') : rows
  const mismatch = considered.some((r) => r.mismatch)
  const siteSha = (site: Site) => {
    const r = rows.find((x) => x.site === site)
    return shortSha(r?.healthCommit ?? r?.deployedTag ?? null) ?? DASH
  }
  const main = shortSha(gate.github.ci?.headSha ?? gate.github.mainSha) ?? DASH
  return {
    ...base,
    state: mismatch ? 'yellow' : 'green',
    value: mismatch ? '不一致' : '一致',
    notes: [`測試站 ${siteSha('test')}・正式站 ${notOpen ? '尚未開站' : siteSha('prod')}・main ${main}`],
  }
}

/** 兩站（尚未開站的正式站除外）24h 內 `ok:false` 的點，以最新一點為右端分 24 格（Q-DV-3 定案）。 */
export function errorBuckets(metrics: MetricsData | null, sites: Site[]): { count: number; buckets: number[] } {
  const points = sites.flatMap((s) => metrics?.sites?.[s]?.points ?? [])
  const times = points.map((p) => Date.parse(p.at)).filter((t) => Number.isFinite(t))
  const buckets = Array<number>(ERROR_BUCKETS).fill(0)
  if (!times.length) return { count: 0, buckets }
  const end = Math.max(...times)
  let count = 0
  for (const p of points) {
    if (p.ok !== false) continue
    const t = Date.parse(p.at)
    const back = end - t
    if (!Number.isFinite(t) || back < 0 || back >= ERROR_BUCKETS * HOUR) continue
    count++
    buckets[ERROR_BUCKETS - 1 - Math.floor(back / HOUR)]!++
  }
  return { count, buckets }
}

function errorsKpi(gate: GateInput, metrics: MetricsData | null, notOpen: boolean): Kpi {
  const base = { id: 'errors' as const, title: '24h 錯誤', href: '/errors' }
  const sites: Site[] = notOpen ? ['test'] : ['test', 'prod']
  const testDown = gate.health?.test?.ok === false
  if (!metrics) {
    return { ...base, state: testDown ? 'red' : 'grey', value: DASH, notes: ['還沒有 Gatus 資料', ...(testDown ? ['測試站健康檢查失敗'] : [])] }
  }
  const { count, buckets } = errorBuckets(metrics, sites)
  const notes = [notOpen ? '測試站端點失敗次數（正式站尚未開站，不算）' : '兩站端點失敗次數']
  if (testDown) notes.push('測試站健康檢查失敗')
  let state: KpiState = count === 0 ? 'green' : 'yellow'
  if (!metrics.gatusOk) {
    // 本輪 Gatus 失敗：sites 是上次成功值，照畫但標灰，不當成新資料（§4.2、§7.3）。
    const fetched = sites
      .map((s) => metrics.sites?.[s]?.fetchedAt)
      .filter((at): at is IsoTime => !!at && !Number.isNaN(Date.parse(at)))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
    notes.push(`Gatus 本輪失敗，資料時間 ${fetched ? formatTime(fetched) : DASH}${metrics.error ? `（${metrics.error}）` : ''}`)
    state = 'grey'
  }
  if (testDown) state = 'red'
  return { ...base, state, value: String(count), notes, buckets }
}

/**
 * 備份卡：狀態跟 G4（`evaluateBackup`）同一套規則，但站可以換——正式站尚未開站時看測試站。
 * 再疊 `/backup` 的 `backupSiteView`：最近一次紀錄失敗、0 bytes 也算紅，跟備份頁一致；任一邊紅就紅。
 */
export function backupKpi(vm: VmData | null, site: Site, now: Date): Kpi {
  const base = { id: 'backup' as const, title: `備份（${SITE_LABEL[site]}）`, href: '/backup' }
  if (!vm) return { ...base, state: 'grey', value: DASH, notes: ['還沒有 VM 資料'] }
  // evaluateBackup 只看 backups.prod：把要看的站放到 prod 的位置，判法就一字不差。
  const gate = evaluateBackup({ ...vm, backups: { ...vm.backups, prod: vm.backups?.[site] } }, now)
  if (gate.state === 'grey') return { ...base, state: 'grey', value: DASH, notes: [gate.summary] }
  const v = backupSiteView(vm.backups?.[site])
  const when = v.at ? formatDay(v.at, now) : null
  const size = v.bytes !== null && v.bytes > 0 ? formatBytes(v.bytes) : null
  const first = [when, size].filter(Boolean).join('・')
  if (gate.state === 'green' && v.state === 'green') return { ...base, state: 'green', value: '成功', notes: first ? [first] : [] }
  const value = v.label === '沒有' ? '沒有' : v.state === 'red' ? '失敗' : '太舊'
  const lastOk = v.state === 'red' && typeof v.lastOk === 'object' && v.lastOk ? `上次成功 ${formatDay(v.lastOk.at, now)}` : null
  const notes = [first, v.error ?? gate.summary, lastOk].filter((n): n is string => !!n)
  return { ...base, state: 'red', value, notes }
}

function diskKpi(vm: VmData | null): Kpi {
  const base = { id: 'disk' as const, title: '主機儲存', href: '/backup' }
  if (!vm) return { ...base, state: 'grey', value: DASH, notes: ['還沒有 VM 資料'], bar: null }
  const d = diskView(vm.disk, vm.diskError)
  const notes: string[] = []
  if (d.usedBytes !== null && d.totalBytes !== null) {
    notes.push(`已用 ${formatBytes(d.usedBytes)}／共 ${formatBytes(d.totalBytes)}${d.checkedAt ? `・量測時間 ${formatTime(d.checkedAt)}` : ''}`)
  }
  if (d.error) notes.push(`本輪量測失敗：${d.error}`)
  else if (d.percent === null) notes.push('還沒有量過')
  return { ...base, state: d.state, value: d.percent === null ? DASH : `${d.percent}%`, notes, bar: d.percent }
}

function ciKpi(gate: GateInput, now: Date): Kpi {
  const base = { id: 'ci' as const, title: 'CI', href: '/deploy' }
  const github = gate.github
  if (!github) return { ...base, state: 'grey', value: DASH, notes: ['還沒有 GitHub 資料'] }
  const run = runView(github.ci)
  if (!run) return { ...base, state: 'grey', value: DASH, notes: ['還沒有 main 的 CI 紀錄'] }
  // CI run 沒有自己的時間欄，用收集器抓到它的時間（跟最近事件同一個做法）。
  const when = ageText(github.generatedAt, now)
  const notes = [when].filter((n): n is string => !!n)
  if (github.mainSha && run.headSha !== github.mainSha) {
    return { ...base, state: 'grey', value: '跑中', notes: [...notes, `main 最新 commit ${shortSha(github.mainSha)} 的 CI 還沒有結果`] }
  }
  if (run.state === 'grey') return { ...base, state: 'grey', value: '跑中', notes }
  if (run.state === 'green') return { ...base, state: 'green', value: 'main ✓', notes }
  return { ...base, state: 'red', value: 'main ✗', notes: run.failedJobs.length ? [...notes, `沒過：${run.failedJobs.join('、')}`] : notes }
}

// ───────────────────────── 狀態列（§4.1） ─────────────────────────

function sitePill(site: Site, health: HealthData | null, notOpen: boolean): SitePill {
  const label = SITE_LABEL[site]
  if (site === 'prod' && notOpen) return { site, label, state: 'not-open', text: `${label} 尚未開站` }
  const ok = health?.[site]?.ok
  if (ok === true) return { site, label, state: 'ok', text: `${label} ✓` }
  if (ok === false) return { site, label, state: 'fail', text: `${label} ✗` }
  return { site, label, state: 'none', text: `${label} ${DASH}` }
}

export function statusBar(kpis: Kpi[], collector: CollectorStatus | null, health: HealthData | null, notOpen: boolean, now: Date): StatusBarView {
  const sites = (['test', 'prod'] as const).map((s) => sitePill(s, health, notOpen))
  if (kpis.every((k) => k.state === 'grey')) return { tone: 'grey', text: '沒有資料', updated: null, sites }
  const a = age(collector?.generatedAt, now)
  if (a !== null && a > STALE_MS) return { tone: 'grey', text: `資料過期（${formatAge(a)}）`, updated: null, sites }
  const red = kpis.filter((k) => k.state === 'red').length
  const yellow = kpis.filter((k) => k.state === 'yellow').length
  const [tone, text]: [KpiState, string] = red ? ['red', `${red} 項異常`] : yellow ? ['yellow', `${yellow} 項要注意`] : ['green', '全部正常']
  return { tone, text, updated: a === null ? null : `${formatAge(a)}更新`, sites }
}

// ───────────────────────── 合起來 ─────────────────────────

export function buildOverview(data: OverviewData, now: Date): OverviewView {
  const { gate, metrics, collector } = data
  const notOpen = prodNotOpen(gate.health, gate.vm)
  const kpis = [
    versionKpi(gate, notOpen),
    errorsKpi(gate, metrics, notOpen),
    backupKpi(gate.vm, notOpen ? 'test' : 'prod', now),
    diskKpi(gate.vm),
    ciKpi(gate, now),
  ]
  const verdict = evaluateGoLive(gate, now)
  const test = metrics?.sites?.test
  return {
    statusBar: statusBar(kpis, collector, gate.health, notOpen, now),
    kpis,
    chart: { view: chartView(metrics), uptime24h: formatPercent(test?.uptime24h), uptime7d: formatPercent(test?.uptime7d) },
    goLive: { gates: verdict.gates, green: verdict.gates.filter((g) => g.state === 'green').length },
    events: buildEvents(
      { collector, health: gate.health, github: gate.github, vm: gate.vm, index: gate.acceptance.index },
      now,
    ).slice(0, OVERVIEW_LIMIT),
  }
}
