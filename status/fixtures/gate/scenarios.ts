/**
 * 「能不能上線」的假資料組合（AC-S-19 (a)–(j)）。
 *
 * `green()` 是五條全符合的一套（最新 full 18 項齊、全 ok、全 parsed）；其餘每個情境都從它複製一份再改一處。
 * 純函式單元測試用 `toGateInput()`，頁面測試用 `writeScenario()` 寫成真的目錄給頁面讀。
 * 本機要看畫面：`pnpm tsx`／測試裡呼叫 `writeScenario(dir, SCENARIOS.h6())`，再用
 * `STATUS_DATA_DIR=<dir>/data STATUS_ACCEPTANCE_DIR=<dir>/acceptance pnpm dev`。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type {
  AcceptanceIndex,
  GithubData,
  GoLivePolicyFile,
  GoLiveWaiversFile,
  HealthData,
  RepoCopy,
  RunJson,
  SummaryItem,
  SummaryJson,
  SummaryPersona,
  VmData,
} from '@/lib/data/types'
import type { GateInput } from '@/lib/gate/types'

export const NOW = '2026-10-12T09:05:00+08:00'
const AT = '2026-10-12T09:00:00+08:00'
const SHA = '7162644000000000000000000000000000000000'
export const LATEST = 'night-20261011-2200'
export const PREVIOUS = 'night-20261010-2200'

/** 跟 main 的 `PLAN_FULL` 同一份 18 項（S-2 的 go-live-policy.json）。 */
export const REQUIRED = [
  'security-static', 'story-1', 'story-2', 'story-3', 'story-4', 'story-5', 'story-6',
  'ux-admin-midterm', 'ux-leader', 'ux-member', 'ux-ungrouped', 'ux-grader', 'ux-advisor',
  'ux-freshman', 'ux-visitor-highschool', 'ux-visitor-industry', 'ux-admin-newbie', 'r1-login-limit',
]

/** 假政策：story／r1 各要求 8 步（0–7）、人設任務數 ux-grader 4、其他 2。 */
const STEPS = [0, 1, 2, 3, 4, 5, 6, 7]
const taskCount = (id: string) => (id === 'ux-grader' ? 4 : 2)
const kindOf = (id: string) => (id.startsWith('ux-') ? 'persona' : id.startsWith('security') ? 'script' : 'story')
const hasSteps = (id: string) => id.startsWith('story-') || id.startsWith('r1-')

export type Scenario = {
  now: string
  github: GithubData | null
  health: HealthData | null
  vm: VmData | null
  index: AcceptanceIndex | null
  policy: RepoCopy<GoLivePolicyFile> | null
  waivers: RepoCopy<GoLiveWaiversFile> | null
  /** runId → 那夜的 run.json／summary.json（沒有就不寫檔） */
  runs: Record<string, { run?: RunJson; summary?: SummaryJson }>
}

function runJson(runId: string, ids: string[]): RunJson {
  return {
    runId,
    plan: 'full',
    startedAt: '2026-10-11T22:00:00+08:00',
    finishedAt: '2026-10-12T06:00:00+08:00',
    commitStart: SHA,
    commitEnd: SHA,
    items: ids.map((id) => ({
      id,
      kind: kindOf(id),
      status: 'ok',
      startedAt: '2026-10-11T22:00:00+08:00',
      finishedAt: '2026-10-11T23:00:00+08:00',
      exit: 0,
      resumed: false,
    })),
    passwordLeaked: false,
  }
}

function summaryItem(id: string): SummaryItem {
  const steps = hasSteps(id)
    ? STEPS.map((n) => ({ 步驟: `${n} 做第 ${n} 件事`, 角色: '系辦', 結果: '通過', 看到什麼: '畫面正常', 截圖: [] }))
    : []
  return {
    id,
    kind: kindOf(id),
    status: 'ok',
    resumed: false,
    dependencyNotMet: false,
    security: null,
    report: `${id}/report.md`,
    parsed: true,
    summaryLine: steps.length ? `通過 ${steps.length}` : null,
    relay: null,
    counts: steps.length ? { 通過: steps.length } : {},
    steps,
    problems: [],
    errors: [],
  }
}

function persona(id: string): SummaryPersona {
  return {
    id,
    title: id,
    tasks: Array.from({ length: taskCount(id) }, (_, k) => ({ task: k + 1, score: 4, done: '是' })),
    average: 4,
  }
}

function summaryJson(runId: string): SummaryJson {
  return {
    runId,
    plan: 'full',
    startedAt: '2026-10-11T22:00:00+08:00',
    finishedAt: '2026-10-12T06:00:00+08:00',
    commitStart: SHA,
    commitEnd: SHA,
    problemColumns: ['編號', '嚴重度', '一句話', '角色', '頁面', '步驟', '截圖', '已知', '可開票'],
    items: REQUIRED.map(summaryItem),
    personas: REQUIRED.filter((id) => id.startsWith('ux-')).map(persona),
  }
}

function indexEntry(runId: string, run: RunJson, hasSummary = true) {
  return {
    runId,
    plan: run.plan,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    commitStart: run.commitStart,
    commitEnd: run.commitEnd,
    items: run.items.map((i) => ({ id: i.id, status: i.status })),
    hasSummary,
    summaryValid: hasSummary,
    invalidReason: null,
  }
}

/** (a) 五條全符合。 */
export function green(): Scenario {
  const latest = runJson(LATEST, REQUIRED)
  const previous = { ...runJson(PREVIOUS, REQUIRED), startedAt: '2026-10-10T22:00:00+08:00', finishedAt: '2026-10-11T06:00:00+08:00' }
  return {
    now: NOW,
    github: {
      generatedAt: AT,
      mainSha: SHA,
      ci: {
        runId: 1001,
        headSha: SHA,
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/roy4222/fju-im-project/actions/runs/1001',
        jobs: ['typecheck', 'lint', 'unit', 'integration', 'build', 'e2e-smoke', 'audit'].map((name) => ({ name, conclusion: 'success' })),
      },
      image: null,
      healthCron: null,
      prs: [],
      fetchError: null,
    },
    health: {
      generatedAt: AT,
      test: { ok: true, commit: SHA, checkedAt: AT, last6: [true, true, true, true, true, true], reason: null },
      prod: { ok: true, commit: SHA, checkedAt: AT, last6: [true, true, true, true, true, true], reason: null },
      accessGuard: [],
    },
    vm: {
      generatedAt: AT,
      deploys: {
        test: [{ at: '2026-10-12T00:40:00Z', event: 'deployed', tag: SHA, digest: null }],
        prod: [{ at: '2026-10-12T00:50:00Z', event: 'deployed', tag: SHA, digest: null }],
      },
      backups: {
        test: { latest: { name: 'fju-test-20261012.dump', bytes: 1000, mtime: '2026-10-12T03:00:00+08:00' }, lastRecord: null },
        prod: {
          latest: { name: 'fju-prod-20261012.dump', bytes: 2000, mtime: '2026-10-12T03:10:00+08:00' },
          lastRecord: { at: '2026-10-12T03:10:05+08:00', ok: true },
        },
      },
      prodEnv: {
        site: 'prod',
        checkedAt: '2026-10-12T04:10:00+08:00',
        missing: [],
        forbiddenPresent: [],
        flags: { REGISTRATION_OPEN: 'absent', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'false' },
      },
      // G5 改讀 prodDns 後（DV-9），情境 (a) 要有 A 記錄才維持五綠。
      prodDns: { host: 'fju.roy422.dev', hasA: true, checkedAt: AT },
      disk: { path: '/srv/fju/status/inbox', totalBytes: 85899345920, usedBytes: 50594713600, availBytes: 31009665024, percent: 62, checkedAt: AT },
      diskError: null,
    },
    index: {
      generatedAt: AT,
      runs: [indexEntry(LATEST, latest), indexEntry(PREVIOUS, previous)],
      latestFullAttempt: LATEST,
      requiredItemsSourceSha: SHA,
    },
    policy: {
      sourceSha: SHA,
      requiredItems: [...REQUIRED],
      items: Object.fromEntries(
        REQUIRED.map((id) => [id, hasSteps(id) ? { steps: [...STEPS] } : id.startsWith('ux-') ? { tasks: taskCount(id) } : {}]),
      ),
    },
    waivers: { sourceSha: SHA, waivers: [] },
    runs: {
      [LATEST]: { run: latest, summary: summaryJson(LATEST) },
      [PREVIOUS]: { run: previous, summary: summaryJson(PREVIOUS) },
    },
  }
}

const latestSummary = (s: Scenario) => s.runs[LATEST]!.summary!
const item = (s: Scenario, id: string) => latestSummary(s).items.find((i) => i.id === id)!
const problem = (編號: string, 嚴重度: string, 步驟: string, 一句話: string) => ({
  編號, 嚴重度, 一句話, 角色: '系辦', 頁面: '/dashboard/admin', 步驟, 截圖: '', 已知: '', 可開票: '是',
})
const waiver = (runId: string, it: string, problemId: string) => ({
  runId, item: it, problemId, approvedBy: 'Roy', approvedAt: '2026-10-12', reason: '第二段再修',
})

/** 把 story-2 第 7 步改成網站失敗。 */
function siteFailure(s: Scenario) {
  const st = item(s, 'story-2').steps.find((x) => x.步驟.startsWith('7 '))!
  st.結果 = '做不到（網站：按鈕沒反應）'
}

export const SCENARIOS = {
  a: green,
  /** (b) main 最新 commit 的 CI 失敗在 e2e-smoke。 */
  b(): Scenario {
    const s = green()
    s.github!.ci!.conclusion = 'failure'
    s.github!.ci!.jobs.find((j) => j.name === 'e2e-smoke')!.conclusion = 'failure'
    return s
  },
  /** (c) 2 筆「要修」只有 1 筆在豁免檔（同 runId）。 */
  c(): Scenario {
    const s = green()
    item(s, 'story-3').problems = [problem('S3-01', '要修', '2', '成績匯出少一欄'), problem('S3-02', '要修', '5', '簽核按鈕文字不清楚')]
    s.waivers!.waivers = [waiver(LATEST, 'story-3', 'S3-01')]
    return s
  },
  /** (d) 豁免寫的是前一夜的 runId。 */
  d(): Scenario {
    const s = green()
    item(s, 'story-3').problems = [problem('S3-01', '要修', '2', '成績匯出少一欄')]
    s.waivers!.waivers = [waiver(PREVIOUS, 'story-3', 'S3-01')]
    return s
  },
  /** (e) offsite/prod 最新檔 25 小時前。 */
  e(): Scenario {
    const s = green()
    s.vm!.backups.prod.latest!.mtime = '2026-10-11T08:05:00+08:00'
    return s
  },
  /** (f) envcheck 30 小時前。 */
  f(): Scenario {
    const s = green()
    s.vm!.prodEnv!.checkedAt = '2026-10-11T03:05:00+08:00'
    return s
  },
  /** (g) 最新 full 只跑了 story-1（--only），前一夜 full 完整且全綠。 */
  g(): Scenario {
    const s = green()
    const run = runJson(LATEST, ['story-1'])
    const summary = { ...summaryJson(LATEST), items: [summaryItem('story-1')], personas: [] }
    s.runs[LATEST] = { run, summary }
    s.index!.runs[0] = indexEntry(LATEST, run)
    return s
  },
  /** (h) 全 ok、全 parsed、零問題，但 story-3 有一步「做不到（環境：網路斷）」、counts 環境 1。 */
  h(): Scenario {
    const s = green()
    const it = item(s, 'story-3')
    it.steps.find((x) => x.步驟.startsWith('4 '))!.結果 = '做不到（環境：網路斷）'
    it.counts = { 通過: 7, 環境: 1 }
    return s
  },
  /** (h2) ux-grader 有一個任務 done 是空值。 */
  h2(): Scenario {
    const s = green()
    latestSummary(s).personas.find((p) => p.id === 'ux-grader')!.tasks[2]!.done = null
    return s
  },
  /** (h3) repo/go-live-policy.json 不存在。 */
  h3(): Scenario {
    const s = green()
    s.policy = null
    return s
  },
  /** (h4) story-1 的 steps 是空陣列、ux-grader 只有 1 個任務（政策要 4）。 */
  h4(): Scenario {
    const s = green()
    item(s, 'story-1').steps = []
    const grader = latestSummary(s).personas.find((p) => p.id === 'ux-grader')!
    grader.tasks = grader.tasks.slice(0, 1)
    return s
  },
  /** (h5) story-2 第 7 步網站失敗，有對應「要修」且已在同夜豁免檔。 */
  h5(): Scenario {
    const s = green()
    siteFailure(s)
    item(s, 'story-2').problems = [problem('S2-07', '要修', '7', '按鈕沒反應')]
    s.waivers!.waivers = [waiver(LATEST, 'story-2', 'S2-07')]
    return s
  },
  /** (h6) 同 (h5) 但沒有豁免。 */
  h6(): Scenario {
    const s = green()
    siteFailure(s)
    item(s, 'story-2').problems = [problem('S2-07', '要修', '7', '按鈕沒反應')]
    return s
  },
  /** (h7) story-2 第 7 步「不通過」但 problems[] 沒有步驟 7 的列。 */
  h7(): Scenario {
    const s = green()
    item(s, 'story-2').steps.find((x) => x.步驟.startsWith('7 '))!.結果 = '不通過'
    return s
  },
  /** (i) 最新 full 有 run.json 沒有 summary.json，前一夜完整全綠。 */
  i(): Scenario {
    const s = green()
    delete s.runs[LATEST]!.summary
    s.index!.runs[0]!.hasSummary = false
    s.index!.runs[0]!.summaryValid = false
    return s
  },
  /** (j) 最新 full 的 story-2 parsed:false。 */
  j(): Scenario {
    const s = green()
    const it = item(s, 'story-2')
    it.parsed = false
    it.problems = []
    it.errors = ['問題表欄數不對（第 3 列）']
    return s
  },
} satisfies Record<string, () => Scenario>

export type ScenarioName = keyof typeof SCENARIOS

/** 單元測試用：不碰檔案，直接組成 evaluateGoLive 的輸入。 */
export function toGateInput(s: Scenario): GateInput {
  const runId = s.index?.latestFullAttempt ?? null
  const night = runId ? s.runs[runId] : undefined
  return {
    github: s.github,
    health: s.health,
    vm: s.vm,
    acceptance: {
      index: s.index,
      run: night?.run ?? null,
      summary: night?.summary ? { status: 'ok', data: night.summary } : { status: 'missing' },
      policy: s.policy ? { status: 'ok', data: s.policy } : { status: 'missing' },
      waivers: s.waivers,
    },
  }
}

/** 頁面測試用：寫成 `<dir>/data`、`<dir>/acceptance` 兩個目錄（值是 null 的檔不寫）。 */
export async function writeScenario(dir: string, s: Scenario): Promise<{ dataDir: string; acceptanceDir: string }> {
  const dataDir = path.join(dir, 'data')
  const acceptanceDir = path.join(dir, 'acceptance')
  const put = async (file: string, value: unknown) => {
    if (value === null || value === undefined) return
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(value, null, 2))
  }
  await put(path.join(dataDir, 'github.json'), s.github)
  await put(path.join(dataDir, 'health.json'), s.health)
  await put(path.join(dataDir, 'vm.json'), s.vm)
  await put(path.join(dataDir, 'acceptance-index.json'), s.index)
  await put(path.join(dataDir, 'repo', 'go-live-policy.json'), s.policy)
  await put(path.join(dataDir, 'repo', 'go-live-waivers.json'), s.waivers)
  for (const [runId, night] of Object.entries(s.runs)) {
    await put(path.join(acceptanceDir, runId, 'run.json'), night.run)
    await put(path.join(acceptanceDir, runId, 'summary.json'), night.summary)
  }
  return { dataDir, acceptanceDir }
}
