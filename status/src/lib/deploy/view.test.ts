import { describe, expect, it } from 'vitest'

import type { DeployLogEntry, GithubData, VmData } from '@/lib/data/types'

import { buildDeployView, deployRow, formatTime, runView } from './view'

const NOW = new Date('2026-10-12T09:05:00+08:00')
const SHA = '7162644000000000000000000000000000000000'

const run = (conclusion: string | null, jobs: [string, string | null][] = [['e2e-smoke', conclusion]]) => ({
  runId: 1,
  headSha: SHA,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  url: 'https://github.com/x/y/actions/runs/1',
  jobs: jobs.map(([name, c]) => ({ name, conclusion: c })),
})

const github = (over: Partial<GithubData> = {}): GithubData => ({
  generatedAt: '2026-10-12T09:00:00+08:00',
  mainSha: SHA,
  ci: run('success'),
  image: run('success'),
  healthCron: { conclusion: 'success', url: 'https://github.com/x/y/actions/runs/3', at: '2026-10-12T08:20:00+08:00' },
  prs: [],
  ...over,
})

const entry = (i: number, over: Partial<DeployLogEntry> = {}): DeployLogEntry => ({
  at: `2026-10-0${i}T00:00:00Z`,
  event: 'deployed',
  tag: SHA,
  digest: `sha256:${String(i).repeat(64)}`,
  ...over,
})

const vm = (test: DeployLogEntry[], prod: DeployLogEntry[] = []): VmData => ({
  generatedAt: '2026-10-12T09:00:00+08:00',
  deploys: { test, prod },
  backups: { test: { latest: null, lastRecord: null }, prod: { latest: null, lastRecord: null } },
  prodEnv: null,
})

describe('buildDeployView（DV 設計方案 §5.2）', () => {
  it('三個來源都沒有 → 卡片資料都是 null、部署表是空的、版本列仍有兩站', () => {
    const v = buildDeployView({ github: null, vm: null, health: null }, NOW)
    expect(v.ci).toBeNull()
    expect(v.image).toBeNull()
    expect(v.healthCron).toBeNull()
    expect(v.githubAt).toBeNull()
    expect(v.githubAge).toBeNull()
    expect(v.deploys).toEqual({ test: [], prod: [] })
    expect(v.versionRows.map((r) => r.site)).toEqual(['test', 'prod'])
  })

  it('CI 成功 → 綠、沒有失敗 job；多久前用 github.json 的收集時間', () => {
    const v = buildDeployView({ github: github(), vm: null, health: null }, NOW)
    expect(v.ci).toMatchObject({ state: 'green', label: '成功', headSha: SHA, failedJobs: [] })
    expect(v.githubAge).toBe('5 分鐘前')
    expect(v.healthCron).toMatchObject({ state: 'green', label: '成功', age: '45 分鐘前' })
  })

  it('CI 失敗 → 紅，只列沒過的 job（skipped 不算沒過）', () => {
    const ci = run('failure', [
      ['lint', 'success'],
      ['e2e-smoke', 'failure'],
      ['audit', 'skipped'],
      ['unit', 'cancelled'],
    ])
    const v = buildDeployView({ github: github({ ci }), vm: null, health: null }, NOW)
    expect(v.ci).toMatchObject({ state: 'red', label: '失敗（failure）', failedJobs: ['e2e-smoke', 'unit'] })
    expect(v.ci!.jobs).toHaveLength(4)
  })

  it('CI 還在跑 → 灰「還在跑」', () => {
    expect(runView(run(null))).toMatchObject({ state: 'grey', label: '還在跑' })
  })

  it('部署每站最多 5 筆，保留新到舊的前 5 筆', () => {
    const seven = [1, 2, 3, 4, 5, 6, 7].map((i) => entry(i))
    const v = buildDeployView({ github: null, vm: vm(seven, seven.slice(0, 2)), health: null }, NOW)
    expect(v.deploys.test.map((r) => r.at)).toEqual(seven.slice(0, 5).map((e) => e.at))
    expect(v.deploys.prod).toHaveLength(2)
  })

  it('部署列：tag 變短 SHA、digest 為 null 原樣留 null、非 deployed 算失敗', () => {
    expect(deployRow(entry(1, { digest: null }))).toMatchObject({ tag: '7162644', digest: null, ok: true, result: '成功' })
    expect(deployRow(entry(1, { event: 'rolled-back' }))).toMatchObject({ ok: false, result: '已回滾' })
    expect(deployRow(entry(1, { event: 'something-new', tag: null }))).toMatchObject({ ok: false, result: 'something-new', tag: null })
  })

  it('時間印台北時間；壞掉的字串原樣回', () => {
    expect(formatTime('2026-10-12T00:40:00Z')).toBe('10/12 08:40')
    expect(formatTime('not-a-time')).toBe('not-a-time')
  })
})
