// AC-S-8、9、10：跑一輪收集器，看 /data 的檔案形狀、遮蔽、GitHub 失敗時的行為。
import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configFromEnv, parseHosts, runOnce } from './collect.mjs'
import {
  HOSTS,
  MAIN_SHA,
  TEAM,
  accessRoutes,
  baseConfig,
  gatusRoutes,
  githubRoutes,
  healthRoutes,
  makeFakeVm,
  rawRoutes,
  startServer,
} from './testing/fakes.mjs'

const NOW = new Date('2026-10-12T10:15:00Z')
const here = path.dirname(fileURLToPath(import.meta.url))

let vm
let server
let routes

function allRoutes() {
  return { ...githubRoutes(), ...rawRoutes(), ...gatusRoutes(NOW), ...healthRoutes(NOW), ...accessRoutes() }
}

async function start(overrides = {}) {
  routes = { ...allRoutes(), ...overrides }
  server = await startServer(routes)
  return baseConfig({ base: server.base, dataDir: vm.dataDir, fju: vm.fju })
}

function run(args, options) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { encoding: 'utf8', ...options }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
    })
  })
}

const apiCount = () => server.seen.filter((s) => s.startsWith('GET /api/')).length

/** 連跑 n 輪（每輪隔 10 分鐘，最後一輪在 end），回傳每輪打了幾次 GitHub API。 */
async function rounds(cfg, n, end = NOW) {
  const calls = []
  for (let i = n - 1; i >= 0; i--) {
    const before = apiCount()
    await runOnce(cfg, new Date(end.getTime() - i * 600e3))
    calls.push(apiCount() - before)
  }
  return calls
}

const read = (rel) => JSON.parse(fs.readFileSync(path.join(vm.dataDir, rel), 'utf8'))
const allOutput = () =>
  fs
    .readdirSync(vm.dataDir, { recursive: true })
    .filter((f) => f.endsWith('.json'))
    .map((f) => fs.readFileSync(path.join(vm.dataDir, f), 'utf8'))
    .join('\n')

beforeEach(() => {
  vm = makeFakeVm(NOW)
})
afterEach(async () => {
  await server?.close()
  server = undefined
  vm.cleanup()
})

describe('AC-S-8 一輪收集的輸出', () => {
  it('寫出五個檔與 repo/ 四檔，形狀符合設計方案 §3.3，每檔有 generatedAt', async () => {
    const cfg = await start()
    // GitHub 的輪替項目要兩輪才全部抓過一次（每輪最多 4 次 API）
    const calls = await rounds(cfg, 2)
    expect(calls).toEqual([4, 4])
    const status = read('collector.json')

    expect(Object.values(status.sources).every((s) => s.ok)).toBe(true)
    for (const f of ['github.json', 'health.json', 'vm.json', 'acceptance-index.json', 'collector.json']) {
      expect(read(f).generatedAt).toBe(NOW.toISOString())
    }

    const gh = read('github.json')
    expect(gh.mainSha).toBe(MAIN_SHA)
    expect(gh.fetchError).toBeNull()
    // 挑 head_sha 等於 mainSha 的那個 ci run，不是另一個失敗的舊 run
    expect(gh.ci).toEqual({
      runId: 11,
      headSha: MAIN_SHA,
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/x/runs/11',
      jobs: [
        { name: 'lint', conclusion: 'success' },
        { name: 'e2e-smoke', conclusion: 'success' },
      ],
    })
    expect(gh.image).toMatchObject({ runId: 12, conclusion: 'success', jobs: [] })
    // health-cron 另外查最近一個「已完成」的 run
    expect(gh.healthCron).toEqual({ conclusion: 'success', url: 'https://github.com/x/runs/9', at: '2026-10-12T10:00:00Z' })
    // 第一輪抓的 image 沿用到第二輪，fetchedAt 保留第一輪的時間
    expect(gh.fetchedAt).toEqual({
      mainSha: NOW.toISOString(),
      ci: NOW.toISOString(),
      image: new Date(NOW.getTime() - 600e3).toISOString(),
      healthCron: NOW.toISOString(),
      prs: NOW.toISOString(),
    })
    expect(gh.prs[0]).toEqual({
      number: 347,
      state: 'closed',
      merged: true,
      headRef: 'claude/p1-t14',
      url: 'https://github.com/x/pull/347',
      updatedAt: '2026-10-11T00:00:00Z',
    })

    for (const name of ['tickets.json', 'test-map.json', 'go-live-waivers.json', 'go-live-policy.json']) {
      const f = read(`repo/${name}`)
      expect(f.sourceSha).toBe(gh.mainSha)
      expect(f.generatedAt).toBe(NOW.toISOString())
    }
    expect(read('repo/go-live-policy.json').requiredItems).toEqual(['security-static', 'story-1'])

    const health = read('health.json')
    expect(health.test).toEqual({
      ok: true,
      commit: 'abc12345',
      checkedAt: new Date(NOW.getTime() - 5 * 60000).toISOString(),
      last6: [true, true, true, true, true, true],
      reason: null,
    })
    expect(health.prod.ok).toBe(false)
    expect(health.prod.reason).toContain('HTTP 502')
    expect(health.accessGuard).toHaveLength(4)
    for (const [i, g] of health.accessGuard.entries()) {
      expect(g).toMatchObject({ host: HOSTS[i], guarded: true, status: 302, gatusOk: true })
      // Access 登入網址的 query 帶 meta token：只留 origin＋路徑
      expect(g.location).toBe(`https://${TEAM}/cdn-cgi/access/login/${HOSTS[i]}`)
    }

    const vmj = read('vm.json')
    expect(vmj.deploys.test).toHaveLength(5)
    expect(vmj.deploys.test[0]).toEqual({ at: '2026-10-08T01:00:00Z', event: 'rollback-start', tag: 'sha-8', digest: null })
    expect(vmj.deploys.test[1]).toEqual({ at: '2026-10-07T01:00:00Z', event: 'deployed', tag: 'sha-7', digest: 'sha256:d7' })
    expect(vmj.deploys.prod).toEqual([])
    expect(vmj.backups.prod.offsiteDir).toBe('ok')
    expect(vmj.backups.prod.latest).toEqual({
      name: path.join('2026', 'fju-prod-new.dump'),
      bytes: 3,
      mtime: new Date(NOW.getTime() - 3600e3).toISOString(),
    })
    expect(vmj.backups.prod.lastRecord).toEqual({ at: '2026-10-11T03:00:00Z', ok: true })
    expect(vmj.backups.test).toEqual({ latest: null, offsiteDir: 'missing', lastRecord: null })
    expect(vmj.prodEnv.flags.BUSINESS_CLOCK_OVERRIDE_ENABLED).toBe('false')
    expect(vmj.prodEnvError).toBeNull()
    // 只回有沒有 A 記錄，不寫 IP
    expect(vmj.prodDns).toEqual({ host: 'fju.roy422.dev', hasA: true, checkedAt: NOW.toISOString() })
    expect(JSON.stringify(vmj)).not.toContain('203.0.113.7')

    const idx = read('acceptance-index.json')
    expect(idx).toMatchObject({ runs: [], latestFullAttempt: null, requiredItems: ['security-static', 'story-1'], requiredItemsSourceSha: MAIN_SHA })

    expect(read('collector.json').sources).toEqual(
      Object.fromEntries(['github', 'repo', 'health', 'vm', 'acceptance'].map((k) => [k, { ok: true, at: NOW.toISOString(), error: null }])),
    )
  })

  it('GitHub API 每輪 ≤ 4 次、每小時（6 輪）≤ 24 次；每個項目最多隔兩輪就更新一次', async () => {
    const cfg = await start()
    const calls = await rounds(cfg, 12)
    for (const c of calls) expect(c).toBeLessThanOrEqual(4)
    for (let i = 0; i + 6 <= calls.length; i++) {
      expect(calls.slice(i, i + 6).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(24)
    }
    const { fetchedAt } = read('github.json')
    for (const key of ['image', 'healthCron', 'prs']) {
      expect(NOW.getTime() - Date.parse(fetchedAt[key])).toBeLessThanOrEqual(600e3)
    }
    // ci 的 jobs 只在第一次看到這個 run 時抓
    expect(server.seen.filter((s) => s.endsWith('/actions/runs/11/jobs'))).toHaveLength(1)
  })

  it('映像 push 失敗、之後手動重推（workflow_dispatch）成功：顯示最新那次的成功', async () => {
    const cfg = await start(
      githubRoutes({
        imageRuns: [
          { id: 20, head_sha: MAIN_SHA, event: 'push', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/x/runs/20', created_at: '2026-10-12T09:00:00Z' },
          { id: 21, head_sha: MAIN_SHA, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/runs/21', created_at: '2026-10-12T09:30:00Z' },
        ],
      }),
    )
    await runOnce(cfg, NOW)
    expect(read('github.json').image).toMatchObject({ runId: 21, conclusion: 'success' })
  })

  it('go-live-policy.json 在 raw 回 404：四檔都不更新、collector.json 記錯誤', async () => {
    let cfg = await start()
    await runOnce(cfg, NOW)
    const before = Object.fromEntries(
      ['tickets.json', 'test-map.json', 'go-live-waivers.json', 'go-live-policy.json'].map((n) => [n, fs.readFileSync(path.join(vm.dataDir, 'repo', n), 'utf8')]),
    )
    await server.close()

    const newSha = 'c'.repeat(40)
    const raw = rawRoutes({ sha: newSha })
    delete raw[`GET /raw/roy4222/fju-im-project/${newSha}/docs/status/go-live-policy.json`]
    cfg = await start({ ...githubRoutes({ sha: newSha }), ...raw })
    const later = new Date(NOW.getTime() + 600e3)
    const status = await runOnce(cfg, later)

    expect(status.sources.repo.ok).toBe(false)
    expect(status.sources.repo.error).toContain('go-live-policy.json')
    expect(status.sources.repo.error).toContain('404')
    for (const [n, text] of Object.entries(before)) {
      expect(fs.readFileSync(path.join(vm.dataDir, 'repo', n), 'utf8')).toBe(text)
    }
    // 其他來源照常更新
    expect(read('github.json').mainSha).toBe(newSha)
    expect(read('collector.json').sources.repo.ok).toBe(false)
  })

  it('raw 回的不是合法 JSON 也算失敗、四檔不寫', async () => {
    const cfg = await start({ [`GET /raw/roy4222/fju-im-project/${MAIN_SHA}/docs/status/test-map.json`]: () => ({ body: '{壞掉' }) })
    const status = await runOnce(cfg, NOW)
    expect(status.sources.repo.ok).toBe(false)
    expect(fs.existsSync(path.join(vm.dataDir, 'repo'))).toBe(false)
  })
})

describe('AC-S-9 遮蔽：命中就整檔不寫', () => {
  it('deploy_log 混入 email、GitHub 回應混入 dp.st token：兩檔保留上一版，其他照常', async () => {
    let cfg = await start()
    await runOnce(cfg, NOW)
    const ghBefore = fs.readFileSync(path.join(vm.dataDir, 'github.json'), 'utf8')
    const vmBefore = fs.readFileSync(path.join(vm.dataDir, 'vm.json'), 'utf8')
    await server.close()

    vm.write(
      'test/deploy/deploy_log',
      fs.readFileSync(path.join(vm.fju, 'test/deploy/deploy_log'), 'utf8') + '2026-10-09T01:00:00Z\tdeployed\tsomeone@example.com\tfull\tsha256:x\tunchanged\n',
    )
    cfg = await start({ ...githubRoutes({ ciUrl: 'https://github.com/x/runs/11?dp.st.prd.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }) })
    const status = await runOnce(cfg, new Date(NOW.getTime() + 600e3))

    expect(status.sources.vm).toMatchObject({ ok: false })
    expect(status.sources.vm.error).toContain('Email')
    expect(status.sources.github).toMatchObject({ ok: false })
    expect(status.sources.github.error).toContain('token')
    expect(fs.readFileSync(path.join(vm.dataDir, 'vm.json'), 'utf8')).toBe(vmBefore)
    expect(fs.readFileSync(path.join(vm.dataDir, 'github.json'), 'utf8')).toBe(ghBefore)
    expect(status.sources.health.ok).toBe(true)
    expect(status.sources.acceptance.ok).toBe(true)

    const out = allOutput()
    expect(out).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/)
    expect(out).not.toContain('dp.st.')
    // 錯誤訊息只說類別，不帶命中的字串
    expect(read('collector.json').sources.vm.error).not.toContain('example.com')
  })
})

describe('AC-S-9 帳密連線字串與敏感欄位', () => {
  it('deploy_log 的 tag 欄混入 postgres://帳號:密碼@…：vm.json 不寫、保留上一版、來源記失敗', async () => {
    let cfg = await start()
    await runOnce(cfg, NOW)
    const before = fs.readFileSync(path.join(vm.dataDir, 'vm.json'), 'utf8')
    await server.close()
    vm.write(
      'prod/deploy/deploy_log',
      '2026-10-09T01:00:00Z\tdeployed\tpostgres://fju_app:FAKEPASS123@fju-prod-postgres:5432/fju\tfull\tsha256:x\tunchanged\n',
    )
    cfg = await start()
    const status = await runOnce(cfg, new Date(NOW.getTime() + 600e3))
    expect(status.sources.vm.ok).toBe(false)
    expect(status.sources.vm.error).toContain('連線字串')
    expect(fs.readFileSync(path.join(vm.dataDir, 'vm.json'), 'utf8')).toBe(before)
    expect(allOutput()).not.toContain('FAKEPASS123')
  })

  it('envcheck 檔被塞了 JSON 的 "password" 欄位：vm.json 不寫、保留上一版、錯誤不帶值', async () => {
    let cfg = await start()
    await runOnce(cfg, NOW)
    const before = fs.readFileSync(path.join(vm.dataDir, 'vm.json'), 'utf8')
    await server.close()
    vm.write(
      'status/envcheck/prod.json',
      JSON.stringify({ site: 'prod', checkedAt: NOW.toISOString(), missing: [], forbiddenPresent: [], flags: {}, debug: { password: 'FAKEPASS456' } }),
    )
    cfg = await start()
    const status = await runOnce(cfg, new Date(NOW.getTime() + 600e3))
    expect(status.sources.vm.ok).toBe(false)
    expect(status.sources.vm.error).toContain('敏感欄位')
    expect(fs.readFileSync(path.join(vm.dataDir, 'vm.json'), 'utf8')).toBe(before)
    expect(allOutput()).not.toContain('FAKEPASS456')
  })
})

describe('AC-S-10 GitHub 失敗', () => {
  for (const [label, override] of [
    ['API 回 403（超過次數）', { 'GET /api/repos/roy4222/fju-im-project/commits/main': () => ({ status: 403, body: { message: 'rate limit' } }) }],
    ['斷網', null],
  ]) {
    it(`${label}：github.json 保留上一版並加 fetchError，其他來源照常，程式不當掉`, async () => {
      let cfg = await start()
      await runOnce(cfg, NOW)
      const prev = read('github.json')
      await server.close()

      cfg = await start(override ?? {})
      if (!override) {
        cfg.apiBase = 'http://127.0.0.1:1/api' // 連不上
        cfg.rawBase = 'http://127.0.0.1:1/raw'
      }
      const later = new Date(NOW.getTime() + 600e3)
      const status = await runOnce(cfg, later)

      const gh = read('github.json')
      expect(gh.fetchError).toMatch(override ? /HTTP 403/ : /連不到/)
      expect(gh.fetchErrorAt).toBe(later.toISOString())
      expect({ ...gh, fetchError: null, fetchErrorAt: undefined }).toEqual({ ...prev, fetchErrorAt: undefined })
      expect(status.sources.github.ok).toBe(false)
      expect(status.sources.repo.ok).toBe(false)
      expect(status.sources.health.ok).toBe(true)
      expect(status.sources.vm.ok).toBe(true)
      expect(read('health.json').generatedAt).toBe(later.toISOString())
      expect(read('vm.json').generatedAt).toBe(later.toISOString())
    })
  }

  it('第一次就失敗（沒有上一版）也寫出帶 fetchError 的空殼', async () => {
    const cfg = await start({ 'GET /api/repos/roy4222/fju-im-project/commits/main': () => ({ status: 500, body: {} }) })
    await runOnce(cfg, NOW)
    expect(read('github.json')).toMatchObject({ mainSha: null, ci: null, prs: [], fetchError: expect.stringContaining('HTTP 500') })
  })
})

describe('命令列', () => {
  it('node collector/collect.mjs --once 用環境變數設定、跑一輪就結束（結束碼 0）', async () => {
    await start()
    // 假上游在同一個程序裡：要用非同步的 execFile，spawnSync 會卡住事件迴圈。
    const r = await run([path.join(here, 'collect.mjs'), '--once'], {
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        STATUS_DATA_DIR: vm.dataDir,
        STATUS_FJU_ROOT: vm.fju,
        STATUS_GITHUB_API: `${server.base}/api`,
        STATUS_GITHUB_RAW: `${server.base}/raw`,
        STATUS_GATUS_URL: `${server.base}/gatus`,
        STATUS_HEALTH_URL_TEST: `${server.base}/health/test`,
        STATUS_HEALTH_URL_PROD: `${server.base}/health/prod`,
        STATUS_HOSTS: 'fju-status,fju-status-vm,fju-status-logs,fju-status-db',
        ACCESS_TEAM_DOMAIN: TEAM,
        STATUS_ACCESS_PROBE_TEMPLATE: `${server.base}/access/{host}/`,
        STATUS_PROD_DNS_HOST: 'nothing.invalid',
      },
    })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).sources.github.ok).toBe(true)
    expect(read('health.json').accessGuard.every((g) => g.guarded)).toBe(true)
    expect(read('vm.json').prodDns.hasA).toBe(false)
  })

  it('沒給 --once／--loop 就印用法、結束碼 2', () => {
    const r = spawnSync(process.execPath, [path.join(here, 'collect.mjs')], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--once')
  })

  it('STATUS_HOSTS 接受子網域名或完整網址，空的用預設四個', () => {
    expect(parseHosts('fju-status, fju-status-vm.roy422.dev')).toEqual(['fju-status.roy422.dev', 'fju-status-vm.roy422.dev'])
    expect(parseHosts(undefined)).toEqual(HOSTS)
    expect(configFromEnv({}).inboxDir).toBe('/srv/fju/status/inbox')
  })
})
