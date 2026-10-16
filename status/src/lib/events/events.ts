/**
 * 事件流（DV 設計方案 §6.1）：從 collector 已輸出的 JSON 算出「什麼時候發生了什麼」。純函式，不讀檔。
 *
 * 七類（Q-DV-4 定案）：部署、備份、來源失敗、健康失敗、CI 失敗、映像失敗、驗收跑完。
 * 總覽「最近事件」取前 `OVERVIEW_LIMIT` 筆（DV-2）；錯誤紀錄頁只列失敗類、最多 `ERRORS_LIMIT` 筆（DV-5）。
 */
import { backupSiteView, formatBytes } from '@/lib/backup/view'
import type {
  AcceptanceIndex,
  CollectorStatus,
  GithubData,
  HealthData,
  IsoTime,
  Site,
  VmData,
  WorkflowRunInfo,
} from '@/lib/data/types'
import { deployRow, runView } from '@/lib/deploy/view'

import { dozzleUrl, siteApp, sitePostgres, sourceContainer } from './containers'

/** 總覽「最近事件」幾筆（Q-DV-4）。 */
export const OVERVIEW_LIMIT = 8
/** 錯誤紀錄頁最多幾筆（Q-DV-4、§8.2 列表上限）。 */
export const ERRORS_LIMIT = 50

export const EVENT_KINDS = ['deploy', 'backup', 'source-fail', 'health-fail', 'ci-fail', 'image-fail', 'acceptance-run'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/** 畫面「類型」欄的字。 */
export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  deploy: '部署',
  backup: '備份',
  'source-fail': '來源失敗',
  'health-fail': '健康失敗',
  'ci-fail': 'CI 失敗',
  'image-fail': '映像失敗',
  'acceptance-run': '驗收',
}

export type EventLevel = 'info' | 'warn' | 'error'

export type StatusEvent = {
  at: IsoTime
  kind: EventKind
  level: EventLevel
  text: string
  /** 「連結」欄：站內頁、GitHub run 或 Dozzle；沒有可連的是 null */
  href: string | null
  /** 這件事看哪個容器的 log；跟容器無關（CI、映像）是 null，Dozzle 連結就開首頁 */
  container: string | null
}

export type EventsInput = {
  collector: CollectorStatus | null
  health: HealthData | null
  github: GithubData | null
  vm: VmData | null
  index: AcceptanceIndex | null
}

const SITES: Site[] = ['test', 'prod']
const SITE_LABEL: Record<Site, string> = { test: '測試站', prod: '正式站' }

function deployEvents(vm: VmData | null): StatusEvent[] {
  return SITES.flatMap((site) =>
    (vm?.deploys?.[site] ?? []).map((e): StatusEvent => {
      const row = deployRow(e)
      return {
        at: row.at,
        kind: 'deploy',
        level: row.ok ? 'info' : 'error',
        text: `${SITE_LABEL[site]}部署 ${row.tagShort ?? '—'}（${row.result}）`,
        href: '/deploy',
        container: siteApp(site),
      }
    }),
  )
}

/** 每站只算最近一次備份（跟 `/backup` 同一套成敗判斷）；連時間都沒有的「從沒備份過」不是事件。 */
function backupEvents(vm: VmData | null): StatusEvent[] {
  if (!vm) return []
  return SITES.flatMap((site): StatusEvent[] => {
    const v = backupSiteView(vm.backups?.[site])
    if (!v.at) return []
    const ok = v.state === 'green'
    const size = v.bytes !== null ? ` ${formatBytes(v.bytes)}` : ''
    return [
      {
        at: v.at,
        kind: 'backup',
        level: ok ? 'info' : 'error',
        text: ok ? `${SITE_LABEL[site]}備份${size}（成功）` : `${SITE_LABEL[site]}備份${v.label}：${v.error}`,
        href: '/backup',
        container: sitePostgres(site),
      },
    ]
  })
}

function sourceEvents(collector: CollectorStatus | null): StatusEvent[] {
  return Object.entries(collector?.sources ?? {})
    .filter(([, s]) => s && s.ok === false)
    .map(([name, s]): StatusEvent => {
      const container = sourceContainer(name)
      return {
        at: s.at,
        kind: 'source-fail',
        level: 'error',
        text: `收集器來源 ${name} 失敗${s.error ? `：${s.error}` : ''}`,
        href: dozzleUrl(container),
        container,
      }
    })
}

function healthEvents(health: HealthData | null): StatusEvent[] {
  if (!health) return []
  return SITES.flatMap((site): StatusEvent[] => {
    const h = health[site]
    if (!h || h.ok) return []
    const container = siteApp(site)
    return [
      {
        at: h.checkedAt ?? health.generatedAt,
        kind: 'health-fail',
        level: 'error',
        text: `${SITE_LABEL[site]}健康檢查失敗${h.reason ? `：${h.reason}` : ''}`,
        href: dozzleUrl(container),
        container,
      },
    ]
  })
}

/** CI／映像 run 沒有自己的時間欄，用收集器抓到它的時間（github.json 的 generatedAt）。 */
function runFailEvent(
  run: WorkflowRunInfo | null | undefined,
  at: IsoTime | undefined,
  kind: 'ci-fail' | 'image-fail',
): StatusEvent[] {
  if (!run || !at || run.status !== 'completed' || run.conclusion !== 'failure') return []
  const failed = runView(run)?.failedJobs ?? []
  const what = kind === 'ci-fail' ? 'main CI 失敗' : '映像 push 失敗'
  return [
    {
      at,
      kind,
      level: 'error',
      text: failed.length ? `${what}：${failed.join('、')}` : what,
      href: run.url,
      container: null,
    },
  ]
}

/** 最新一夜跑完的驗收（runs 新到舊；還在跑、沒有 finishedAt 的跳過）。 */
function acceptanceEvents(index: AcceptanceIndex | null): StatusEvent[] {
  const run = (index?.runs ?? []).find((r) => r.finishedAt)
  if (!run?.finishedAt) return []
  const items = run.items ?? []
  const ok = items.filter((i) => i.status === 'ok').length
  return [
    {
      at: run.finishedAt,
      kind: 'acceptance-run',
      level: 'info',
      text: `驗收 ${run.plan} 跑完：${ok}／${items.length} 項`,
      href: '/map',
      container: null,
    },
  ]
}

const timeOf = (at: IsoTime) => {
  const t = Date.parse(at)
  return Number.isNaN(t) ? -Infinity : t
}

/**
 * 全部事件，依時間新到舊（時間壞掉的排最後）。`now` 目前不參與計算，
 * 留著讓總覽與錯誤紀錄頁用同一個呼叫形狀（§6.1 `buildEvents(data, now)`）。
 */
export function buildEvents(data: EventsInput, _now: Date): StatusEvent[] {
  const events = [
    ...deployEvents(data.vm),
    ...backupEvents(data.vm),
    ...sourceEvents(data.collector),
    ...healthEvents(data.health),
    ...runFailEvent(data.github?.ci, data.github?.generatedAt, 'ci-fail'),
    ...runFailEvent(data.github?.image, data.github?.generatedAt, 'image-fail'),
    ...acceptanceEvents(data.index),
  ]
  return events.sort((a, b) => timeOf(b.at) - timeOf(a.at))
}

/** 錯誤紀錄頁：只留失敗類（level 是 error 的；成功的部署、備份與驗收跑完不列），最多 50 筆。 */
export function failureEvents(events: StatusEvent[], limit: number = ERRORS_LIMIT): StatusEvent[] {
  return events.filter((e) => e.level === 'error').slice(0, limit)
}
