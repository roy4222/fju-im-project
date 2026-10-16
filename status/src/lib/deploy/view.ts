/**
 * 部署與 CI 頁（DV 設計方案 §5.2）要畫的東西。純函式：吃 github／vm／health 與「現在」，回畫面直接用的資料。
 * 版本卡與 main CI 詳情的正本在這頁（§2）；其他頁只放結論與連結。
 */
import type { DeployLogEntry, GithubData, HealthData, IsoTime, Site, VmData, WorkflowRunInfo } from '@/lib/data/types'
import { buildVersionRows, type VersionRow } from '@/lib/data/version'
import { formatAge } from '@/lib/gate/gates'

/** 每站最多列幾筆部署（§8.2 列表上限）。 */
export const DEPLOYS_PER_SITE = 5

export type RunState = 'green' | 'red' | 'grey'

export type RunView = {
  state: RunState
  /** 「成功」「失敗（failure）」「還在跑」… */
  label: string
  headSha: string
  url: string
  jobs: { name: string; conclusion: string | null }[]
  /** 沒過的 job 名（success、skipped 以外） */
  failedJobs: string[]
}

export type HealthCronView = { state: RunState; label: string; url: string; at: IsoTime; age: string | null }

export type DeployRow = {
  at: IsoTime
  event: string
  /** deploy_log 原樣的 tag（可能是 SHA、或回滾時的完整映像名稱）；沒寫是 null */
  tag: string | null
  /** 畫面用：裡面的 git SHA 縮成 7 碼、sha256 縮成 12 碼，其他字不動 */
  tagShort: string | null
  /** 完整 digest；本機建的映像（deploy_log 寫 none）是 null */
  digest: string | null
  ok: boolean
  result: string
}

export type DeployView = {
  versionRows: VersionRow[]
  /** github.json 的收集時間（版本卡、CI 卡都用它） */
  githubAt: IsoTime | null
  /** 收集器多久前抓的 GitHub 資料（run 本身沒有時間欄） */
  githubAge: string | null
  ci: RunView | null
  image: RunView | null
  healthCron: HealthCronView | null
  deploys: Record<Site, DeployRow[]>
}

const JOB_OK = new Set(['success', 'skipped'])

function ageOf(at: string | null | undefined, now: Date): string | null {
  if (!at) return null
  const t = Date.parse(at)
  return Number.isNaN(t) ? null : formatAge(now.getTime() - t)
}

function conclusionView(conclusion: string | null): { state: RunState; label: string } {
  if (conclusion === null) return { state: 'grey', label: '還在跑' }
  if (conclusion === 'success') return { state: 'green', label: '成功' }
  return { state: 'red', label: `失敗（${conclusion}）` }
}

export function runView(run: WorkflowRunInfo | null | undefined): RunView | null {
  if (!run) return null
  const jobs = Array.isArray(run.jobs) ? run.jobs : []
  const { state, label } = conclusionView(run.status === 'completed' ? run.conclusion : null)
  return {
    state,
    label,
    headSha: run.headSha,
    url: run.url,
    jobs,
    failedJobs: jobs.filter((j) => !JOB_OK.has(j.conclusion ?? '')).map((j) => j.name),
  }
}

const EVENT_LABEL: Record<string, string> = {
  deployed: '成功',
  'rolled-back': '已回滾',
  'rollback-start': '開始回滾',
  'e2e-seed-failed': '種子資料失敗',
}

/** 只縮寫 tag 裡的雜湊：`ghcr.io/x/web:7162644000…` → `ghcr.io/x/web:7162644`；`t2`、`main` 這種原樣。 */
export function abbreviateTag(tag: string | null): string | null {
  if (!tag) return null
  return tag
    .replace(/sha256:([0-9a-f]{12})[0-9a-f]{52}/gi, 'sha256:$1…')
    .replace(/(^|[^0-9a-f])([0-9a-f]{7})[0-9a-f]{33}(?![0-9a-f])/gi, '$1$2')
}

export function deployRow(e: DeployLogEntry): DeployRow {
  const ok = e.event === 'deployed'
  return {
    at: e.at,
    event: e.event,
    tag: e.tag,
    tagShort: abbreviateTag(e.tag),
    digest: e.digest,
    ok,
    result: EVENT_LABEL[e.event] ?? e.event,
  }
}

export function buildDeployView(
  input: { github: GithubData | null; vm: VmData | null; health: HealthData | null },
  now: Date,
): DeployView {
  const { github, vm } = input
  const cron = github?.healthCron ?? null
  return {
    versionRows: buildVersionRows(input),
    githubAt: github?.generatedAt ?? null,
    githubAge: ageOf(github?.generatedAt, now),
    ci: runView(github?.ci),
    image: runView(github?.image),
    healthCron: cron ? { ...conclusionView(cron.conclusion), url: cron.url, at: cron.at, age: ageOf(cron.at, now) } : null,
    deploys: {
      test: (vm?.deploys?.test ?? []).slice(0, DEPLOYS_PER_SITE).map(deployRow),
      prod: (vm?.deploys?.prod ?? []).slice(0, DEPLOYS_PER_SITE).map(deployRow),
    },
  }
}

const TAIPEI = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** 台北時間「10/12 08:40」。壞掉的時間字串原樣回。 */
export function formatTime(at: IsoTime): string {
  const t = new Date(at)
  if (Number.isNaN(t.getTime())) return at
  const p = Object.fromEntries(TAIPEI.formatToParts(t).map((x) => [x.type, x.value]))
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`
}
