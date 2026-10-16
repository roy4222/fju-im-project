/**
 * 服務健康頁（DV 設計方案 §5.1）要畫的東西。純函式：吃 health／metrics／collector 與「現在」，回畫面直接用的資料。
 * 兩站健康、Access 302 的正本在這頁；Gatus 回應時間與可用率的正本也在這頁（§2）。
 */
import type { ChartSeries } from '@/components/charts/area-chart'
import type { CollectorStatus, HealthData, IsoTime, MetricsData, Site, SiteHealth, SiteMetrics } from '@/lib/data/types'
import { shortSha } from '@/lib/data/version'
import { formatTime } from '@/lib/deploy/view'
import { formatAge } from '@/lib/gate/gates'

export const SITES: Site[] = ['test', 'prod']
export const SITE_LABEL: Record<Site, string> = { test: '測試站', prod: '正式站' }

/** 沒有值時畫面上的字。 */
export const DASH = '—'

export type SiteState = 'green' | 'red' | 'grey'

export type SiteCardView = {
  site: Site
  label: string
  state: SiteState
  /** 「正常」「失敗」「還沒有健康資料」 */
  okText: string
  commit: string | null
  commitShort: string | null
  checkedAt: string | null
  checkedAge: string | null
  /** 最近 6 次，新到舊（health.json 原順序） */
  last6: boolean[]
  reason: string | null
}

/** ok：本輪 Gatus 成功；stale：本輪失敗、畫的是上次成功的值；none：沒有可畫的資料。 */
export type ChartState = 'ok' | 'stale' | 'none'

export type ChartView = {
  state: ChartState
  series: ChartSeries[]
  /** stale：「Gatus 本輪失敗，資料時間 …」；none：沒有資料的原因 */
  note: string | null
  error: string | null
}

export type UptimeRow = { site: Site; label: string; uptime24h: string; uptime7d: string; avgMs24h: string; failures24h: string }

export type AccessRow = { host: string; guarded: boolean; status: string; location: string }

export type HealthView = {
  sites: SiteCardView[]
  chart: ChartView
  uptime: UptimeRow[]
  /** null＝health.json 不存在 */
  access: AccessRow[] | null
  /** collector 本輪抓健康檢查失敗的說明（沒有失敗就是空的） */
  sourceNotes: string[]
}

function ageOf(at: string | null | undefined, now: Date): string | null {
  if (!at) return null
  const t = Date.parse(at)
  return Number.isNaN(t) ? null : formatAge(now.getTime() - t)
}

/** 0～1 → 「99.7%」（一位小數）；null → 「—」。 */
export function formatPercent(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : DASH
}

/** 毫秒 → 「213 ms」（整數）；null → 「—」。 */
export function formatMs(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)} ms` : DASH
}

const formatCount = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : DASH)

export function siteCard(site: Site, h: SiteHealth | null | undefined, now: Date): SiteCardView {
  const base = { site, label: SITE_LABEL[site] }
  if (!h) {
    return { ...base, state: 'grey', okText: '還沒有健康資料', commit: null, commitShort: null, checkedAt: null, checkedAge: null, last6: [], reason: null }
  }
  return {
    ...base,
    state: h.ok ? 'green' : 'red',
    okText: h.ok ? '正常' : '失敗',
    commit: h.commit,
    commitShort: shortSha(h.commit),
    checkedAt: h.checkedAt ? formatTime(h.checkedAt) : null,
    checkedAge: ageOf(h.checkedAt, now),
    last6: Array.isArray(h.last6) ? h.last6.slice(0, 6) : [],
    reason: h.reason,
  }
}

const sitesOf = (m: MetricsData | null): Partial<Record<Site, SiteMetrics | null>> => m?.sites ?? {}

/** 兩站 24h 回應時間的系列（`ms` → `value`）；沒有資料的站不放。 */
export function chartView(metrics: MetricsData | null): ChartView {
  if (!metrics) return { state: 'none', series: [], note: '還沒有 Gatus 資料（metrics.json 不存在）', error: null }
  const sites = sitesOf(metrics)
  const series: ChartSeries[] = SITES.flatMap((site) => {
    const s = sites[site]
    if (!s || !Array.isArray(s.points) || !s.points.length) return []
    return [{ id: site, label: SITE_LABEL[site], points: s.points.map((p) => ({ at: p.at, value: p.ms })) }]
  })
  if (!series.length) {
    return {
      state: 'none',
      series,
      note: metrics.gatusOk ? '還沒有 Gatus 資料（兩站都沒有點）' : '還沒有 Gatus 資料（Gatus 從沒抓成功過）',
      error: metrics.error,
    }
  }
  if (metrics.gatusOk) return { state: 'ok', series, note: null, error: null }
  const fetched = SITES.map((site) => sites[site]?.fetchedAt)
    .filter((at): at is IsoTime => !!at && !Number.isNaN(Date.parse(at)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
  return {
    state: 'stale',
    series,
    note: `Gatus 本輪失敗，資料時間 ${fetched ? formatTime(fetched) : DASH}`,
    error: metrics.error,
  }
}

export function uptimeRows(metrics: MetricsData | null): UptimeRow[] {
  const sites = sitesOf(metrics)
  return SITES.map((site) => {
    const s = sites[site]
    return {
      site,
      label: SITE_LABEL[site],
      uptime24h: formatPercent(s?.uptime24h),
      uptime7d: formatPercent(s?.uptime7d),
      avgMs24h: formatMs(s?.avgMs24h),
      failures24h: formatCount(s?.failures24h),
    }
  })
}

// Gatus（metrics）失敗由 metrics.json 自己的 gatusOk 標在圖上，這裡只看健康檢查。
const SOURCE_LABEL: Record<string, string> = { health: '健康檢查' }

/** collector 本輪抓健康檢查失敗時的一句說明（畫面上照舊值畫，但要知道不是新資料）。 */
export function sourceNotes(collector: CollectorStatus | null, now: Date): string[] {
  const sources = collector?.sources ?? {}
  return Object.keys(SOURCE_LABEL).flatMap((key) => {
    const s = sources[key]
    if (!s || s.ok) return []
    const age = ageOf(s.at, now)
    return [`收集器本輪抓${SOURCE_LABEL[key]}失敗${s.error ? `（${s.error}）` : ''}${age ? `，${age}` : ''}；下面是上次成功的資料`]
  })
}

export function buildHealthView(
  input: { health: HealthData | null; metrics: MetricsData | null; collector: CollectorStatus | null },
  now: Date,
): HealthView {
  const { health, metrics, collector } = input
  return {
    sites: SITES.map((site) => siteCard(site, health?.[site], now)),
    chart: chartView(metrics),
    uptime: uptimeRows(metrics),
    access: health
      ? (Array.isArray(health.accessGuard) ? health.accessGuard : []).map((g) => ({
          host: g.host,
          guarded: g.guarded,
          status: g.status === null ? DASH : String(g.status),
          location: g.location ?? DASH,
        }))
      : null,
    sourceNotes: sourceNotes(collector, now),
  }
}
