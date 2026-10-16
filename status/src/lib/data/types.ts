/**
 * 開發者後台讀的**全部** JSON 的型別（設計方案 §3.3、§3.4，以及驗收的 run.json／summary.json）。
 *
 * 這是第二波（S-5 測試地圖、S-6 上線判斷與開發進度）唯一的共用檔：要改請在 PR 說明列出、
 * 由 S-1 作者審。欄位名照寫入端原樣（collector、`ops/acceptance-night.sh`、
 * `e2e/acceptance/summarize-night.sh`），中文欄位名也不翻譯。
 */

/** ISO 8601 時間字串。 */
export type IsoTime = string

// ───────────────────────── collector 輸出（/data，§3.3） ─────────────────────────

export type CollectorStamp = { generatedAt: IsoTime }

/** GitHub Actions 一次 run 的摘要（ci.yml、image.yml 同形）。 */
export type WorkflowRunInfo = {
  runId: number
  headSha: string
  /** queued／in_progress／completed… */
  status: string
  /** success／failure／cancelled…；還沒跑完是 null */
  conclusion: string | null
  url: string
  jobs: { name: string; conclusion: string | null }[]
}

export type PullRequestInfo = {
  number: number
  /** open／closed */
  state: string
  merged: boolean
  headRef: string
  url: string
  updatedAt: IsoTime
}

/** `github.json` */
export type GithubData = CollectorStamp & {
  mainSha: string | null
  ci: WorkflowRunInfo | null
  image: WorkflowRunInfo | null
  healthCron: { conclusion: string | null; url: string; at: IsoTime } | null
  /** 最近 100 筆 */
  prs: PullRequestInfo[]
  /** GitHub API 失敗時保留上一版內容並加這欄（AC-S-10）。 */
  fetchError?: string | null
}

/** `repo/*.json`：原樣複本＋`sourceSha`（四檔取自同一個 mainSha）。 */
export type RepoCopy<T> = T & { sourceSha: string; generatedAt?: IsoTime }

export type SiteHealth = {
  ok: boolean
  commit: string | null
  checkedAt: IsoTime | null
  /** 最近 6 次（30 分鐘）結果，新到舊 */
  last6: boolean[]
  reason: string | null
}

export type AccessGuardCheck = {
  host: string
  guarded: boolean
  status: number | null
  location: string | null
}

/** `health.json` */
export type HealthData = CollectorStamp & {
  test: SiteHealth | null
  prod: SiteHealth | null
  accessGuard: AccessGuardCheck[]
}

/** deploy_log 一行（`ops/deploy.sh` 第 7 步：時間、event、tag、…、digest）。 */
export type DeployLogEntry = {
  at: IsoTime
  /** deployed／rolled-back／rollback-start／e2e-seed-failed… */
  event: string
  tag: string | null
  digest: string | null
}

export type BackupInfo = {
  /** offsite 最新檔；目錄不存在或沒有檔是 null */
  latest: { name: string; bytes: number; mtime: IsoTime } | null
  /** `records.jsonl` 最後一筆 */
  lastRecord: { at: IsoTime; ok: boolean } | null
  /**
   * `records.jsonl` 最後一筆**成功**備份（`kind:"backup"`、`status:"ok"`）；後面的失敗與 drill 不覆蓋。
   * 沒有成功過是 null；舊版 collector 寫的 vm.json 沒有這欄（DV 設計方案 §7.2）。
   */
  lastOk?: { at: IsoTime; bytes: number | null } | null
}

/** `ops/status-envcheck.sh prod` 的輸出（只有鍵名與 false/absent/other，§3.8 G5）。 */
export type EnvCheck = {
  site: 'prod'
  checkedAt: IsoTime
  missing: string[]
  forbiddenPresent: string[]
  flags: {
    REGISTRATION_OPEN: 'false' | 'absent' | 'other'
    BUSINESS_CLOCK_OVERRIDE_ENABLED: 'false' | 'other'
  }
}

export type Site = 'test' | 'prod'

/** `vm.json.disk`：statfs 量 inbox 掛載點所在的檔案系統（VM 根磁碟；DV 設計方案 §7.2）。 */
export type DiskUsage = {
  path: string
  totalBytes: number
  usedBytes: number
  availBytes: number
  /** round(used / (used + avail) × 100)，跟 `df` 的 Use% 一致 */
  percent: number
  /** 量成功的時間；本輪失敗時保留上次成功的值與時間 */
  checkedAt: IsoTime
}

/** `vm.json.prodDns`：正式站網域有沒有 A 記錄（不寫 IP）。 */
export type ProdDnsCheck = { host: string; hasA: boolean; checkedAt: IsoTime }

/** `vm.json` */
export type VmData = CollectorStamp & {
  /** 最後 5 筆，新到舊 */
  deploys: Record<Site, DeployLogEntry[]>
  backups: Record<Site, BackupInfo>
  /** envcheck 結果原樣；還沒有任何結果是 null */
  prodEnv: EnvCheck | null
  /** 下面三欄舊版 collector 沒寫，讀端要能吃沒有的情況。 */
  prodDns?: ProdDnsCheck
  /** 從沒量成功過是 null */
  disk?: DiskUsage | null
  /** 本輪 statfs 失敗的分類文字（`EACCES`、`statfs-failed`…）；不是 null 時 `disk` 是上次成功值，畫面標灰 */
  diskError?: string | null
}

/** `metrics.json` 一個點（Gatus 一次檢查）。 */
export type MetricsPoint = { at: IsoTime; ms: number; ok: boolean }

/** `metrics.json.sites.<站>`：24h 窗口內的點（舊到新，≤ 288）與統計；窗口內 0 筆時三個統計是 null。 */
export type SiteMetrics = {
  /** 這站資料成功抓到的時間；本輪失敗時保留上次的值與時間 */
  fetchedAt: IsoTime
  /** 0～1 */
  uptime24h: number | null
  /** 0～1，Gatus uptimes/7d API 的數字 */
  uptime7d: number
  avgMs24h: number | null
  failures24h: number | null
  points: MetricsPoint[]
}

/** `metrics.json`（DV 設計方案 §7.3）：Gatus 兩站端點的回應時間與可用率。 */
export type MetricsData = CollectorStamp & {
  /** 本輪 Gatus 有沒有抓成功；false 時 `sites` 是上次成功值 */
  gatusOk: boolean
  error: string | null
  /** 拿不到端點（且沒有上一版）的站是 null */
  sites: Record<Site, SiteMetrics | null>
}

export type UsageRole = 'student' | 'teacher' | 'admin'

/** `usage.json`（DV 設計方案 §7.5）：只有計數，沒有 ID、Email、名字。正式站上線前檔案不存在。 */
export type UsageReport = CollectorStamp & {
  site: Site
  /** YYYY-MM-DD */
  window: { from: string; to: string }
  /** 最多 120 天 × 3 角色 */
  daily: { day: string; role: UsageRole; activeUsers: number; events: number }[]
  /** `action` 是 `audit_events.action` 代碼，白話名由 `lib/usage/actions.ts` 對照 */
  actions: { action: string; role: UsageRole; count7d: number; count30d: number; countTerm: number }[]
}

/** run.json 的 item（`ops/acceptance-night.sh` write_run_json）。 */
export type RunItem = {
  id: string
  kind: string
  /** not-run／running／ok／failed／timeout／resumed／interrupted／env… */
  status: string
  startedAt: string
  finishedAt: string
  exit: number | null
  resumed: boolean
  note?: string
}

export type AcceptanceRunEntry = {
  runId: string
  /** full／quick… */
  plan: string
  startedAt: IsoTime | null
  finishedAt: IsoTime | null
  commitStart: string | null
  commitEnd: string | null
  items: { id: string; status: string }[]
  hasSummary: boolean
  summaryValid: boolean
  invalidReason: string | null
}

/** `acceptance-index.json` */
export type AcceptanceIndex = CollectorStamp & {
  /** 新到舊 */
  runs: AcceptanceRunEntry[]
  /** 最新一個 plan=full 的 runId（不管成不成功、有沒有 summary.json）；從來沒有是 null */
  latestFullAttempt: string | null
  /** go-live-policy.json 的 `sourceSha`（requiredItems 的來源） */
  requiredItemsSourceSha: string | null
}

export type CollectorSourceState = { ok: boolean; at: IsoTime; error: string | null }

/** `collector.json`：每個來源的狀態。 */
export type CollectorStatus = CollectorStamp & {
  sources: Record<string, CollectorSourceState>
}

// ───────────────────────── 人維護的三（四）個檔（docs/status/，§3.4） ─────────────────────────

export const TICKET_STATUSES = ['todo', 'doing', 'review', 'merged', 'blocked', 'dropped'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

/** 畫面顯示用的中文。 */
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  todo: '還沒開始',
  doing: '做中',
  review: '送審',
  merged: '已合併',
  blocked: '卡住',
  dropped: '不做',
}

export type Ticket = {
  id: string
  batch: string
  title: string
  wave: string
  status: TicketStatus
  owner: string
  branch: string
  pr: number | null
  dependsOn: string[]
  acceptance: string[]
  /** blocked、dropped 必填 */
  note: string
}

/** `docs/status/tickets.json` */
export type TicketsFile = {
  updatedAt: IsoTime
  batches: { id: string; name: string; plan: string }[]
  tickets: Ticket[]
}

export type RoleKey = 'visitor' | 'student' | 'teacher' | 'admin'

export const CRUD_VALUES = ['有', '無', '只能下架', '程式寫死'] as const
export type CrudValue = (typeof CRUD_VALUES)[number]

export type TestMapFeature = {
  key: string
  name: string
  roles: RoleKey[]
  /** 驗收劇本的 (item, 步驟號) */
  evidence: { item: string; steps: number[] }[]
  /** 自動測試檔（repo 相對路徑） */
  e2e: string[]
}

export type TestMapSection = {
  key: string
  page: string
  name: string
  frontFeature: string
  adminPage: string | null
  adminFeature: string | null
  crud: { create: CrudValue; edit: CrudValue; delete: CrudValue } | null
  exception?: string
}

/** `docs/status/test-map.json` */
export type TestMapFile = {
  roles: { key: RoleKey; name: string; aliases: string[] }[]
  features: TestMapFeature[]
  sections: TestMapSection[]
}

/** `docs/status/go-live-policy.json` 的 `items[id]`：story／r1 類有 steps，ux 類有 tasks。 */
export type PolicyItemRequirement = { steps?: number[]; tasks?: number }

/** `docs/status/go-live-policy.json`（必要項＝`PLAN_FULL` 的 18 個 id） */
export type GoLivePolicyFile = {
  requiredItems: string[]
  items: Record<string, PolicyItemRequirement>
}

export type Waiver = {
  runId: string
  item: string
  problemId: string
  approvedBy: string
  approvedAt: string
  reason: string
}

/** `docs/status/go-live-waivers.json` */
export type GoLiveWaiversFile = { waivers: Waiver[] }

// ───────────────────────── 驗收結果（/acceptance/<runId>/，§3.5） ─────────────────────────

/** `run.json`（每夜一定有）。 */
export type RunJson = {
  runId: string
  plan: string
  startedAt: string
  finishedAt: string
  commitStart: string
  commitEnd: string
  items: RunItem[]
  passwordLeaked: boolean
  commitMidway?: { item: string; commit: string; at: string }[]
}

/** summary.json 的步驟列（劇本步驟表五欄；截圖已是 `<item>/<檔名>` 相對路徑）。 */
export type SummaryStep = {
  步驟: string
  角色: string
  /** 只有五種寫法：通過／不通過／做不到（環境：…）／做不到（網站：…）／略過（…） */
  結果: string
  看到什麼: string
  截圖: string[]
}

/** summary.json 的問題列（九欄）。 */
export type SummaryProblem = {
  編號: string
  /** 擋上線／要修／建議／待 Roy 決定 */
  嚴重度: string
  一句話: string
  角色: string
  頁面: string
  步驟: string
  截圖: string
  已知: string
  可開票: string
}

export type SummaryItem = {
  id: string
  kind: string | null
  status: string | null
  resumed: boolean
  dependencyNotMet: boolean
  security: unknown
  report: string | null
  /** 不是 true 時 problems 不可信（問題表解析失敗仍會輸出 steps） */
  parsed: boolean
  summaryLine: string | null
  relay: unknown
  /** 例如 {通過: 12, 環境: 1, 要修: 2} */
  counts: Record<string, number>
  steps: SummaryStep[]
  problems: SummaryProblem[]
  errors: string[]
}

export type PersonaTask = {
  task: number
  score: number | null
  /** 人設報告該任務「完成」那行的原字串；沒填就是 null（`summarize-night.sh:233` 先放 None，parsed 仍是 true） */
  done: string | null
}

export type SummaryPersona = {
  id: string
  title: string | null
  tasks: PersonaTask[]
  average: number | null
}

/** `summary.json`（`summarize-night.sh:657-705`，可能沒有）。 */
export type SummaryJson = {
  runId: string
  plan: string | null
  startedAt: string | null
  finishedAt: string | null
  commitStart: string | null
  commitEnd: string | null
  problemColumns: string[]
  items: SummaryItem[]
  personas: SummaryPersona[]
}

// ───────────────────────── 檔名對照 ─────────────────────────

/** `STATUS_DATA_DIR` 底下每個檔的型別。 */
export type DataFiles = {
  'github.json': GithubData
  'health.json': HealthData
  'vm.json': VmData
  'metrics.json': MetricsData
  'usage.json': UsageReport
  'acceptance-index.json': AcceptanceIndex
  'collector.json': CollectorStatus
  'repo/tickets.json': RepoCopy<TicketsFile>
  'repo/test-map.json': RepoCopy<TestMapFile>
  'repo/go-live-waivers.json': RepoCopy<GoLiveWaiversFile>
  'repo/go-live-policy.json': RepoCopy<GoLivePolicyFile>
}

export type DataFileName = keyof DataFiles
