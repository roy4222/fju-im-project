// 事件庫（DV 設計方案 §6.1；AC-DV-15 的事件庫段、AC-DV-21 的 event-list 規則）。
import { describe, expect, it } from 'vitest'

import type {
  AcceptanceIndex,
  CollectorStatus,
  DeployLogEntry,
  GithubData,
  HealthData,
  SiteHealth,
  VmData,
  WorkflowRunInfo,
} from '@/lib/data/types'

import { COLLECTOR, dozzleUrl, GATUS } from './containers'
import {
  buildEvents,
  ERRORS_LIMIT,
  EVENT_KIND_LABEL,
  EVENT_KINDS,
  failureEvents,
  OVERVIEW_LIMIT,
  type EventsInput,
} from './events'

const NOW = new Date('2026-10-12T09:05:00+08:00')
const AT = '2026-10-12T09:00:00+08:00'
const SHA = '7162644000000000000000000000000000000000'
const LOGS = 'https://fju-status-logs.roy422.dev'

const run = (conclusion: string, failedJob = 'e2e-smoke'): WorkflowRunInfo => ({
  runId: 1,
  headSha: SHA,
  status: 'completed',
  conclusion,
  url: `https://github.com/roy4222/fju-project/actions/runs/${conclusion}`,
  jobs: [
    { name: 'lint', conclusion: 'success' },
    { name: failedJob, conclusion },
  ],
})

const github = (over: Partial<GithubData> = {}): GithubData => ({
  generatedAt: AT,
  mainSha: SHA,
  ci: run('success'),
  image: run('success'),
  healthCron: null,
  prs: [],
  ...over,
})

const site = (over: Partial<SiteHealth> = {}): SiteHealth => ({
  ok: true,
  commit: SHA,
  checkedAt: '2026-10-12T08:55:00+08:00',
  last6: [true, true, true, true, true, true],
  reason: null,
  ...over,
})

const health = (over: Partial<HealthData> = {}): HealthData => ({
  generatedAt: AT,
  test: site(),
  prod: site(),
  accessGuard: [],
  ...over,
})

const deploy = (at: string, event = 'deployed'): DeployLogEntry => ({ at, event, tag: SHA, digest: null })

const vm = (over: Partial<VmData> = {}): VmData => ({
  generatedAt: AT,
  deploys: { test: [], prod: [] },
  backups: {
    test: { latest: null, lastRecord: null },
    prod: { latest: null, lastRecord: null },
  },
  prodEnv: null,
  ...over,
})

const sources = (over: CollectorStatus['sources'] = {}): CollectorStatus => ({
  generatedAt: AT,
  sources: {
    github: { ok: true, at: AT, error: null },
    repo: { ok: true, at: AT, error: null },
    health: { ok: true, at: AT, error: null },
    vm: { ok: true, at: AT, error: null },
    acceptance: { ok: true, at: AT, error: null },
    ...over,
  },
})

const index = (finishedAt: string | null, statuses: string[]): AcceptanceIndex => ({
  generatedAt: AT,
  runs: [
    {
      runId: 'night-20261011-2200',
      plan: 'full',
      startedAt: '2026-10-11T22:00:00+08:00',
      finishedAt,
      commitStart: SHA,
      commitEnd: SHA,
      items: statuses.map((status, i) => ({ id: `item-${i}`, status })),
      hasSummary: true,
      summaryValid: true,
      invalidReason: null,
    },
  ],
  latestFullAttempt: 'night-20261011-2200',
  requiredItemsSourceSha: SHA,
})

const EMPTY: EventsInput = { collector: null, health: null, github: null, vm: null, index: null }

/** AC-DV-15 的資料：兩站各 3 筆部署（1 筆失敗）、正式站備份失敗、github 來源失敗、CI failure、驗收一夜跑完。 */
function ac15(): EventsInput {
  return {
    collector: sources({ github: { ok: false, at: '2026-10-12T08:50:00+08:00', error: 'HTTP 403' } }),
    health: health(),
    github: github({ ci: run('failure') }),
    vm: vm({
      deploys: {
        test: [deploy('2026-10-12T00:40:00Z'), deploy('2026-10-11T12:00:00Z', 'e2e-seed-failed'), deploy('2026-10-11T01:00:00Z')],
        prod: [deploy('2026-10-11T08:00:00Z'), deploy('2026-10-10T12:00:00Z'), deploy('2026-10-09T12:00:00Z')],
      },
      backups: {
        test: {
          latest: { name: 'fju-test-20261012.dump', bytes: 123456, mtime: '2026-10-12T03:00:00+08:00' },
          lastRecord: { at: '2026-10-12T03:00:05+08:00', ok: true },
          lastOk: { at: '2026-10-12T03:00:05+08:00', bytes: 123456 },
        },
        prod: {
          latest: { name: 'fju-prod-20261011.dump', bytes: 234567, mtime: '2026-10-11T03:10:00+08:00' },
          lastRecord: { at: '2026-10-12T03:10:05+08:00', ok: false },
          lastOk: { at: '2026-10-11T03:10:05+08:00', bytes: 234567 },
        },
      },
    }),
    index: index('2026-10-12T06:00:00+08:00', Array.from({ length: 18 }, () => 'ok')),
  }
}

describe('buildEvents（§6.1）', () => {
  it('依時間新到舊；時間壞掉的排最後', () => {
    const input = ac15()
    input.vm!.deploys.prod.push(deploy('不是時間'))
    const events = buildEvents(input, NOW)
    const times = events.slice(0, -1).map((e) => Date.parse(e.at))
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(events.at(-1)!.at).toBe('不是時間')
  })

  it('七類（Q-DV-4）：類型只在七種內、畫面字是「部署、備份、來源失敗、健康失敗、CI 失敗、映像失敗、驗收」', () => {
    expect(EVENT_KINDS.map((k) => EVENT_KIND_LABEL[k])).toEqual([
      '部署', '備份', '來源失敗', '健康失敗', 'CI 失敗', '映像失敗', '驗收',
    ])
    const input = ac15()
    input.health = health({ test: site({ ok: false, reason: 'worker 心跳逾時' }) })
    input.github = github({ ci: run('failure'), image: run('failure', 'push') })
    const kinds = new Set(buildEvents(input, NOW).map((e) => e.kind))
    expect([...kinds].sort()).toEqual([...EVENT_KINDS].sort())
  })

  it('總覽 8 筆、錯誤紀錄 50 筆（Q-DV-4）', () => {
    expect(OVERVIEW_LIMIT).toBe(8)
    expect(ERRORS_LIMIT).toBe(50)
  })

  it('AC-DV-15 的資料：6 筆部署、2 筆備份、來源失敗、CI 失敗、驗收跑完＝11 筆；前 8 筆依時間', () => {
    const events = buildEvents(ac15(), NOW)
    expect(events).toHaveLength(11)
    expect(events.slice(0, OVERVIEW_LIMIT).map((e) => e.kind)).toEqual([
      'ci-fail', 'source-fail', 'deploy', 'acceptance-run', 'backup', 'backup', 'deploy', 'deploy',
    ])
  })

  it('每類的字、連結與容器', () => {
    const input = ac15()
    input.health = health({ test: site({ ok: false, reason: 'worker 心跳逾時' }) })
    input.github = github({ ci: run('failure'), image: run('failure', 'push') })
    const events = buildEvents(input, NOW)
    const of = (kind: string) => events.filter((e) => e.kind === kind)

    const failedDeploy = of('deploy').find((e) => e.level === 'error')!
    expect(failedDeploy).toMatchObject({ text: '測試站部署 7162644（種子資料失敗）', href: '/deploy', container: 'fju-test-app' })
    expect(of('deploy').find((e) => e.level === 'info')!.text).toBe('測試站部署 7162644（成功）')

    const [testBackup, prodBackup] = [of('backup').find((e) => e.text.startsWith('測試站'))!, of('backup').find((e) => e.text.startsWith('正式站'))!]
    expect(testBackup).toMatchObject({ level: 'info', text: '測試站備份 120.6 KB（成功）', href: '/backup' })
    expect(prodBackup).toMatchObject({ level: 'error', text: '正式站備份失敗：最近一次備份紀錄是失敗', container: 'fju-prod-postgres' })

    expect(of('source-fail')[0]).toMatchObject({
      level: 'error',
      text: '收集器來源 github 失敗：HTTP 403',
      href: `${LOGS}/show?name=${COLLECTOR}`,
      container: COLLECTOR,
    })
    expect(of('health-fail')[0]).toMatchObject({
      at: '2026-10-12T08:55:00+08:00',
      text: '測試站健康檢查失敗：worker 心跳逾時',
      href: `${LOGS}/show?name=fju-test-app`,
    })
    expect(of('ci-fail')[0]).toMatchObject({ at: AT, text: 'main CI 失敗：e2e-smoke', href: input.github.ci!.url, container: null })
    expect(of('image-fail')[0]).toMatchObject({ text: '映像 push 失敗：push', href: input.github.image!.url })
    expect(of('acceptance-run')[0]).toMatchObject({ level: 'info', text: '驗收 full 跑完：18／18 項', href: '/map' })
  })

  it('health 來源失敗看 Gatus 的 log，其他來源看收集器', () => {
    const input = { ...EMPTY, collector: sources({ health: { ok: false, at: AT, error: 'timeout' } }) }
    expect(buildEvents(input, NOW)[0]!.container).toBe(GATUS)
    expect(dozzleUrl(null)).toBe(LOGS)
  })

  it('不算事件的：CI 還在跑或被取消、驗收還沒跑完、從沒備份過、健康正常', () => {
    const cancelled = run('cancelled')
    const input: EventsInput = {
      collector: sources(),
      health: health(),
      github: github({ ci: { ...run('failure'), status: 'in_progress' }, image: cancelled }),
      vm: vm(),
      index: index(null, ['ok']),
    }
    expect(buildEvents(input, NOW)).toEqual([])
  })

  it('沒有任何資料：空陣列、不 throw', () => {
    expect(buildEvents(EMPTY, NOW)).toEqual([])
  })
})

describe('failureEvents（錯誤紀錄頁）', () => {
  it('只列失敗類：AC-DV-15 的資料是部署失敗、備份失敗、來源失敗、CI 失敗 4 筆', () => {
    const failures = failureEvents(buildEvents(ac15(), NOW))
    expect(failures.map((e) => e.kind).sort()).toEqual(['backup', 'ci-fail', 'deploy', 'source-fail'])
    expect(failures.every((e) => e.level === 'error')).toBe(true)
  })

  it('最多 50 筆', () => {
    const many = Array.from({ length: 60 }, (_, i) => deploy(new Date(Date.parse(AT) - i * 60_000).toISOString(), 'rolled-back'))
    const failures = failureEvents(buildEvents({ ...EMPTY, vm: vm({ deploys: { test: many, prod: [] } }) }, NOW))
    expect(failures).toHaveLength(ERRORS_LIMIT)
    expect(failures[0]!.at).toBe(many[0]!.at)
  })
})
