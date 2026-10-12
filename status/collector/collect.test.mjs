// AC-S-8、9、10：跑一輪收集器，看 /data 的檔案形狀、遮蔽、GitHub 失敗時的行為。
import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configFromEnv, parseHosts, runOnce } from './collect.mjs'
import {
  HOSTS,
  MAIN_SHA,
  REPO_BODIES,
  TEAM,
  accessRoutes,
  baseConfig,
  fakeDigest,
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
      attempt: 1,
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
    expect(vmj.deploys.test[1]).toEqual({ at: '2026-10-07T01:00:00Z', event: 'deployed', tag: 'sha-7', digest: fakeDigest(7) })
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

  const REPO_NAMES = ['tickets.json', 'test-map.json', 'go-live-waivers.json', 'go-live-policy.json']
  const repoSnapshot = () => Object.fromEntries(REPO_NAMES.map((n) => [n, fs.readFileSync(path.join(vm.dataDir, 'repo', n), 'utf8')]))
  const versionDirs = () => (fs.existsSync(path.join(vm.dataDir, 'repo-versions')) ? fs.readdirSync(path.join(vm.dataDir, 'repo-versions')).sort() : [])

  it('repo 四檔是「完整版本目錄＋單一指標切換」：repo 是指向 repo-versions/<版本>/ 的相對 symlink，前一版保留、更早的清掉', async () => {
    let cfg = await start()
    await runOnce(cfg, NOW)
    expect(fs.lstatSync(path.join(vm.dataDir, 'repo')).isSymbolicLink()).toBe(true)
    const target1 = fs.readlinkSync(path.join(vm.dataDir, 'repo'))
    expect(path.isAbsolute(target1)).toBe(false)
    expect(target1.startsWith('repo-versions/')).toBe(true)
    expect(versionDirs()).toHaveLength(1)
    await server.close()

    for (const [i, ch] of ['e', 'f'].entries()) {
      cfg = await start({ ...githubRoutes({ sha: ch.repeat(40) }), ...rawRoutes({ sha: ch.repeat(40) }) })
      await runOnce(cfg, new Date(NOW.getTime() + (i + 1) * 600e3))
      await server.close()
      server = undefined
    }
    // 讀取端照舊讀 repo/<檔>，拿到的是最新版、四檔同一個 sourceSha
    for (const n of REPO_NAMES) expect(read(`repo/${n}`).sourceSha).toBe('f'.repeat(40))
    // 只留最新與前一版（讀到一半的讀取端還能把前一版讀完），更早的清掉；前一版四檔齊全
    const dirs = versionDirs()
    expect(dirs).toHaveLength(2)
    const previous = dirs.find((d) => d !== path.basename(fs.readlinkSync(path.join(vm.dataDir, 'repo'))))
    expect(fs.readdirSync(path.join(vm.dataDir, 'repo-versions', previous)).sort()).toEqual([...REPO_NAMES].sort())
    expect(JSON.parse(fs.readFileSync(path.join(vm.dataDir, 'repo-versions', previous, 'tickets.json'), 'utf8')).sourceSha).toBe('e'.repeat(40))
    expect(dirs.some((d) => d.includes('.tmp-'))).toBe(false)
  })

  it('舊版 collector 留下的 repo/ 真目錄：第一輪搬走、換成 symlink，之後讀得到新版', async () => {
    fs.mkdirSync(path.join(vm.dataDir, 'repo'))
    fs.writeFileSync(path.join(vm.dataDir, 'repo', 'tickets.json'), '{"legacy":true}')
    const cfg = await start()
    const status = await runOnce(cfg, NOW)
    expect(status.sources.repo.ok).toBe(true)
    expect(fs.lstatSync(path.join(vm.dataDir, 'repo')).isSymbolicLink()).toBe(true)
    expect(read('repo/tickets.json').sourceSha).toBe(MAIN_SHA)
    expect(fs.readdirSync(vm.dataDir).filter((f) => f.startsWith('repo'))).toEqual(['repo', 'repo-versions'])
  })

  it('第二檔寫到一半 ENOSPC：指標不動、四檔都還是上一版，暫存版本目錄清掉', async () => {
    let cfg = await start()
    await runOnce(cfg, NOW)
    const before = repoSnapshot()
    const link = fs.readlinkSync(path.join(vm.dataDir, 'repo'))
    await server.close()

    const newSha = 'd'.repeat(40)
    cfg = await start({ ...githubRoutes({ sha: newSha }), ...rawRoutes({ sha: newSha }) })
    const real = fs.writeFileSync
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
      if (String(file).includes('test-map.json')) {
        const err = new Error('ENOSPC: no space left on device')
        err.code = 'ENOSPC'
        throw err
      }
      return real.call(fs, file, ...rest)
    })
    let status
    try {
      status = await runOnce(cfg, new Date(NOW.getTime() + 600e3))
    } finally {
      spy.mockRestore()
    }
    expect(status.sources.repo.ok).toBe(false)
    expect(status.sources.repo.error).toContain('ENOSPC')
    expect(repoSnapshot()).toEqual(before)
    expect(fs.readlinkSync(path.join(vm.dataDir, 'repo'))).toBe(link)
    expect(versionDirs()).toHaveLength(1)
    expect(read('github.json').mainSha).toBe(newSha)
  })

  it('第二次 rename（指標切換）失敗：指標仍指舊版、四檔一致，暫存 symlink 不留下', async () => {
    let cfg = await start()
    await runOnce(cfg, NOW)
    const before = repoSnapshot()
    const link = fs.readlinkSync(path.join(vm.dataDir, 'repo'))
    await server.close()

    const newSha = 'd'.repeat(40)
    cfg = await start({ ...githubRoutes({ sha: newSha }), ...rawRoutes({ sha: newSha }) })
    const real = fs.renameSync
    let renames = 0
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('repo') && ++renames === 2) {
        const err = new Error('EIO: i/o error, rename')
        err.code = 'EIO'
        throw err
      }
      return real.call(fs, from, to)
    })
    let status
    try {
      status = await runOnce(cfg, new Date(NOW.getTime() + 600e3))
    } finally {
      spy.mockRestore()
    }
    expect(renames).toBe(2)
    expect(status.sources.repo.ok).toBe(false)
    expect(status.sources.repo.error).toContain('EIO')
    expect(repoSnapshot()).toEqual(before)
    expect(fs.readlinkSync(path.join(vm.dataDir, 'repo'))).toBe(link)
    expect(fs.readdirSync(vm.dataDir).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('deploy_log 的 digest 欄是 none（本機建的映像）：vm.json 照常寫，digest 是 null', async () => {
    vm.write('prod/deploy/deploy_log', '2026-10-09T01:00:00Z\tdeployed\tabc1234\tfull\tnone\tunchanged\n')
    const cfg = await start()
    const status = await runOnce(cfg, NOW)
    expect(status.sources.vm.ok).toBe(true)
    expect(read('vm.json').deploys.prod).toEqual([{ at: '2026-10-09T01:00:00Z', event: 'deployed', tag: 'abc1234', digest: null }])
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
      fs.readFileSync(path.join(vm.fju, 'test/deploy/deploy_log'), 'utf8') + `2026-10-09T01:00:00Z\tdeployed\tsomeone@example.com\tfull\tghcr.io/roy4222/fju-web@${fakeDigest(9)}\tunchanged\n`,
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
      `2026-10-09T01:00:00Z\tdeployed\tpostgres://fju_app:FAKEPASS123@fju-prod-postgres:5432/fju\tfull\tghcr.io/roy4222/fju-web@${fakeDigest(9)}\tunchanged\n`,
    )
    cfg = await start()
    const status = await runOnce(cfg, new Date(NOW.getTime() + 600e3))
    expect(status.sources.vm.ok).toBe(false)
    expect(status.sources.vm.error).toContain('連線字串')
    expect(fs.readFileSync(path.join(vm.dataDir, 'vm.json'), 'utf8')).toBe(before)
    expect(allOutput()).not.toContain('FAKEPASS123')
  })

  it('envcheck 檔多了白名單外的欄位（含 password、沒有鍵名提示的 FAKE 值）：只輸出規格列的五個欄位，多的全部丟掉', async () => {
    let cfg = await start()
    await runOnce(cfg, NOW)
    await server.close()
    vm.write(
      'status/envcheck/prod.json',
      JSON.stringify({
        site: 'prod',
        checkedAt: NOW.toISOString(),
        missing: ['GOOGLE_CLIENT_SECRET'],
        forbiddenPresent: [],
        flags: { REGISTRATION_OPEN: 'absent', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'false', extra: 'FAKEPASS457' },
        debug: { password: 'FAKEPASS456' },
        note: 'FAKEPASS458', // 鍵名沒有提示、值也沒有樣式：只有白名單擋得住
        values: ['FAKEPASS459'],
      }),
    )
    cfg = await start()
    const later = new Date(NOW.getTime() + 600e3)
    const status = await runOnce(cfg, later)
    expect(status.sources.vm).toEqual({ ok: true, at: later.toISOString(), error: null })
    const vmj = read('vm.json')
    expect(vmj.generatedAt).toBe(later.toISOString())
    expect(vmj.prodEnv).toEqual({
      site: 'prod',
      checkedAt: NOW.toISOString(),
      missing: ['GOOGLE_CLIENT_SECRET'],
      forbiddenPresent: [],
      flags: { REGISTRATION_OPEN: 'absent', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'false' },
    })
    expect(vmj.prodEnvError).toBeNull()
    expect(allOutput()).not.toContain('FAKEPASS')
  })

  it('envcheck 的已知欄位值不合樣式（旗標不是 false/absent/other、missing 不是鍵名）：prodEnv 改成 null 並記原因，值不輸出', async () => {
    for (const [label, env] of [
      ['旗標', { flags: { REGISTRATION_OPEN: 'FAKEPASS321', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'false' } }],
      ['missing', { missing: ['DB_PASSWORD=FAKEPASS322'] }],
      ['site', { site: 'postgres://app:FAKEPASS323@db/fju' }],
    ]) {
      vm.write(
        'status/envcheck/prod.json',
        JSON.stringify({ site: 'prod', checkedAt: NOW.toISOString(), missing: [], forbiddenPresent: [], flags: { REGISTRATION_OPEN: 'absent', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'false' }, ...env }),
      )
      const cfg = await start()
      const status = await runOnce(cfg, NOW)
      await server.close()
      server = undefined
      expect(status.sources.vm.ok, label).toBe(true)
      const vmj = read('vm.json')
      expect(vmj.prodEnv, label).toBeNull()
      expect(vmj.prodEnvError, label).toContain('格式')
      expect(vmj.deploys.test, label).toHaveLength(5)
      expect(allOutput(), label).not.toContain('FAKEPASS')
    }
  })

  it('repo 四檔之一（tickets.json）藏了敏感鍵底下的容器與 URL 編碼的連線字串：四檔都不寫、錯誤只說類別', async () => {
    for (const [body, kind] of [
      [{ ...REPO_BODIES['tickets.json'], tickets: [{ id: 'X', secret: { value: 'FAKEPASS999' } }] }, '敏感欄位'],
      [{ ...REPO_BODIES['tickets.json'], tickets: [{ id: 'X', token: ['FAKEPASS998'] }] }, '敏感欄位'],
      [{ ...REPO_BODIES['tickets.json'], tickets: [{ id: 'X', note: 'postgresql://db/fju?user=app&%70assword=FAKEPASS997' }] }, '連線字串'],
      [{ ...REPO_BODIES['tickets.json'], tickets: [{ id: 'X', meta: { accessKey: 'FAKEPASS996' } }] }, '敏感欄位'], // Review 第三輪 P1
      [{ ...REPO_BODIES['tickets.json'], tickets: [{ id: 'X', note: '{"password":"FAKEPASS359"}' }] }, '密碼'], // 字串裡的 JSON
      [{ ...REPO_BODIES['tickets.json'], tickets: [{ id: 'X', note: '{"nested":{"token":["FAKEPASS995"]}}' }] }, '敏感欄位'], // 內嵌 JSON 的巢狀容器
      [{ ...REPO_BODIES['tickets.json'], tickets: [{ id: 'X', note: 'postgresql://db/fju?%2570assword=FAKEPASS994' }] }, '連線字串'], // 雙層編碼
    ]) {
      const cfg = await start({ [`GET /raw/roy4222/fju-im-project/${MAIN_SHA}/docs/status/tickets.json`]: () => ({ body }) })
      const status = await runOnce(cfg, NOW)
      await server.close()
      server = undefined
      expect(status.sources.repo.ok).toBe(false)
      expect(status.sources.repo.error).toContain(kind)
      expect(status.sources.repo.error).not.toContain('FAKEPASS')
      expect(fs.existsSync(path.join(vm.dataDir, 'repo'))).toBe(false)
      expect(allOutput()).not.toContain('FAKEPASS')
    }
  })

  it('GitHub job 名稱藏了字串化的 JSON 密碼：github.json 不寫、保留上一版', async () => {
    let cfg = await start()
    await runOnce(cfg, NOW)
    const before = fs.readFileSync(path.join(vm.dataDir, 'github.json'), 'utf8')
    await server.close()
    cfg = await start(githubRoutes({ ciRun: { run_attempt: 2 }, ciJobs: [{ name: '{"password":"FAKEPASS363"}', conclusion: 'success' }] }))
    const status = await runOnce(cfg, new Date(NOW.getTime() + 600e3))
    expect(status.sources.github.ok).toBe(false)
    expect(status.sources.github.error).toContain('密碼')
    expect(fs.readFileSync(path.join(vm.dataDir, 'github.json'), 'utf8')).toBe(before)
    expect(allOutput()).not.toContain('FAKEPASS')
  })

  it('GitHub 回應多了規格外的欄位（PR body 帶密碼、head.repo）：不進 github.json', async () => {
    const cfg = await start(githubRoutes({ extraPr: { body: 'password: FAKEPASS555', head: { ref: 'claude/p1-t14', repo: { ssh_url: 'git@github.com:x/y.git' } } } }))
    await rounds(cfg, 2) // prs 是輪替項目，第二輪才抓到
    expect(read('collector.json').sources.github.ok).toBe(true)
    const gh = read('github.json')
    expect(Object.keys(gh.prs[0]).sort()).toEqual(['headRef', 'merged', 'number', 'state', 'updatedAt', 'url'])
    expect(allOutput()).not.toContain('FAKEPASS')
    expect(allOutput()).not.toContain('ssh_url')
  })

  it('每個輸出檔都只有白名單列的頂層欄位', async () => {
    const cfg = await start()
    await rounds(cfg, 2)
    expect(Object.keys(read('github.json')).sort()).toEqual(['apiCalls', 'ci', 'fetchError', 'fetchedAt', 'generatedAt', 'healthCron', 'image', 'mainSha', 'prs'])
    expect(Object.keys(read('health.json')).sort()).toEqual(['accessGuard', 'generatedAt', 'prod', 'test'])
    expect(Object.keys(read('vm.json')).sort()).toEqual(['backups', 'deploys', 'generatedAt', 'prodDns', 'prodEnv', 'prodEnvError'])
    expect(Object.keys(read('acceptance-index.json')).sort()).toEqual(['generatedAt', 'latestFullAttempt', 'requiredItems', 'requiredItemsSourceSha', 'runs'])
    expect(Object.keys(read('collector.json')).sort()).toEqual(['generatedAt', 'sources'])
  })
})

describe('GitHub run 重跑（run_attempt）', () => {
  it('同一個 run 重跑後結論仍 failure 但 jobs 變了：attempt 改變就重抓 jobs，每輪仍 ≤ 4 次', async () => {
    const failing = (lint) => [{ name: 'lint', conclusion: lint }, { name: 'e2e-smoke', conclusion: 'failure' }]
    let cfg = await start(githubRoutes({ ciRun: { conclusion: 'failure', run_attempt: 1 }, ciJobs: failing('failure') }))
    const calls = await rounds(cfg, 2)
    expect(calls.every((c) => c <= 4)).toBe(true)
    expect(read('github.json').ci).toMatchObject({ runId: 11, attempt: 1, conclusion: 'failure', jobs: failing('failure') })
    expect(server.seen.filter((s) => s.endsWith('/actions/runs/11/jobs'))).toHaveLength(1)
    await server.close()

    // 重跑：attempt 2，lint 過了、e2e 還是失敗，整體結論不變。
    cfg = await start(githubRoutes({ ciRun: { conclusion: 'failure', run_attempt: 2 }, ciJobs: failing('success') }))
    const later = new Date(NOW.getTime() + 600e3)
    const before = apiCount()
    await runOnce(cfg, later)
    expect(apiCount() - before).toBeLessThanOrEqual(4)
    expect(read('github.json').ci).toMatchObject({ runId: 11, attempt: 2, conclusion: 'failure', jobs: failing('success') })
    expect(server.seen.filter((s) => s.endsWith('/actions/runs/11/jobs'))).toHaveLength(1)

    // 再一輪沒變：不再抓 jobs。
    await runOnce(cfg, new Date(later.getTime() + 600e3))
    expect(server.seen.filter((s) => s.endsWith('/actions/runs/11/jobs'))).toHaveLength(1)
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
