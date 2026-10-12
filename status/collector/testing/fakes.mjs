// 測試用：假的 HTTP 上游（GitHub API、raw、Gatus、/api/health、四個網址）與假的 VM 目錄。
// 只給 *.test.mjs 用，不進正式流程。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export const MAIN_SHA = 'a'.repeat(40)
export const TEAM = 'fake-team.cloudflareaccess.com'
export const HOSTS = ['fju-status.roy422.dev', 'fju-status-vm.roy422.dev', 'fju-status-logs.roy422.dev', 'fju-status-db.roy422.dev']

/** routes：{ 'GET /path': (req, url) => ({ status, body, headers }) }；找不到回 404。 */
export async function startServer(routes) {
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    seen.push(`${req.method} ${url.pathname}`)
    const handler = routes[`${req.method} ${url.pathname}`]
    const out = handler ? handler(req, url) : { status: 404, body: { message: 'Not Found' } }
    const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {})
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) })
    res.end(body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) }
}

/**
 * 假 GitHub API。imageRuns 可換掉（測「push 失敗→手動重推成功」）；ciUrl 可塞怪字串（測遮蔽）。
 * 帶 event=push 查 image.yml 時只回 push 的 run（模擬真的 API），所以程式誤加過濾就看不到手動重推。
 */
export function githubRoutes({ repo = 'roy4222/fju-im-project', sha = MAIN_SHA, extraPr = {}, imageRuns, ciUrl, ciRun = {}, ciJobs } = {}) {
  // ciRun 可覆寫 run 11 的欄位（測 run_attempt 重跑）；ciJobs 可換掉 run 11 的 jobs。
  const ciRuns = [
    { id: 11, head_sha: sha, event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1, html_url: ciUrl ?? 'https://github.com/x/runs/11', created_at: '2026-10-12T09:00:00Z', ...ciRun },
    { id: 10, head_sha: 'b'.repeat(40), event: 'push', status: 'completed', conclusion: 'failure', run_attempt: 1, html_url: 'https://github.com/x/runs/10', created_at: '2026-10-11T09:00:00Z' },
  ]
  const jobs = ciJobs ?? [{ name: 'lint', conclusion: 'success' }, { name: 'e2e-smoke', conclusion: 'success' }]
  const images = imageRuns ?? [
    { id: 12, head_sha: sha, event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/runs/12', created_at: '2026-10-12T09:00:00Z' },
  ]
  const cron = { id: 9, status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/runs/9', updated_at: '2026-10-12T10:00:00Z' }
  const api = `GET /api/repos/${repo}`
  return {
    [`${api}/commits/main`]: () => ({ body: { sha } }),
    [`${api}/actions/workflows/ci.yml/runs`]: () => ({ body: { workflow_runs: ciRuns } }),
    [`${api}/actions/workflows/image.yml/runs`]: (req, url) => {
      const ev = url.searchParams.get('event')
      return { body: { workflow_runs: ev ? images.filter((r) => r.event === ev) : images } }
    },
    [`${api}/actions/workflows/health-cron.yml/runs`]: (req, url) => ({
      body: { workflow_runs: url.searchParams.get('status') === 'completed' ? [cron] : [] },
    }),
    [`${api}/actions/runs/11/jobs`]: () => ({ body: { jobs } }),
    [`${api}/pulls`]: () => ({
      body: [
        { number: 347, state: 'closed', merged_at: '2026-10-11T00:00:00Z', head: { ref: 'claude/p1-t14' }, html_url: 'https://github.com/x/pull/347', updated_at: '2026-10-11T00:00:00Z', ...extraPr },
        { number: 348, state: 'open', merged_at: null, head: { ref: 'claude/s3' }, html_url: 'https://github.com/x/pull/348', updated_at: '2026-10-12T00:00:00Z' },
      ],
    }),
  }
}

export const REPO_BODIES = {
  'tickets.json': { updatedAt: '2026-10-12T18:00:00+08:00', batches: [], tickets: [] },
  'test-map.json': { roles: [], features: [], sections: [] },
  'go-live-waivers.json': { waivers: [] },
  'go-live-policy.json': { requiredItems: ['security-static', 'story-1'], items: { 'security-static': {}, 'story-1': { steps: [1] } } },
}

export function rawRoutes({ repo = 'roy4222/fju-im-project', sha = MAIN_SHA, bodies = REPO_BODIES } = {}) {
  const out = {}
  for (const [name, body] of Object.entries(bodies)) {
    out[`GET /raw/${repo}/${sha}/docs/status/${name}`] = () => ({ body })
  }
  return out
}

function gatusResult(success, minutesAgo, now) {
  return {
    status: success ? 200 : 502,
    success,
    timestamp: new Date(now.getTime() - minutesAgo * 60000).toISOString(),
    conditionResults: [{ condition: '[STATUS] == 200', success }],
    duration: 1000,
  }
}

export function gatusRoutes(now, { testResults = [true, true, true, true, true, true] } = {}) {
  // Gatus 的 results 舊到新：最後一個是最近一次。
  const site = (name, list) => ({
    name,
    group: 'site',
    key: `site_${name}`,
    results: list.map((s, i) => gatusResult(s, (list.length - i) * 5, now)),
  })
  const access = HOSTS.map((h) => ({
    name: h,
    group: 'access',
    key: `access_${h.replaceAll('.', '-')}`,
    results: [{ status: 302, success: true, timestamp: now.toISOString() }],
  }))
  return {
    'GET /gatus/api/v1/endpoints/statuses': () => ({ body: [site('test', testResults), site('prod', [false]), ...access] }),
  }
}

export function healthRoutes(now) {
  const body = { ok: true, commit: 'abc12345', worker: { lastTickAt: new Date(now.getTime() - 60000).toISOString() } }
  return {
    'GET /health/test': () => ({ body }),
    'GET /health/prod': () => ({ status: 502, body: 'bad gateway' }),
  }
}

export function accessRoutes() {
  const out = {}
  for (const h of HOSTS) {
    out[`GET /access/${h}/`] = () => ({
      status: 302,
      body: '',
      headers: { location: `https://${TEAM}/cdn-cgi/access/login/${h}?kid=x&meta=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJl` },
    })
  }
  return out
}

/** 假 VM 目錄：/srv/fju 的唯讀來源＋空的 data 輸出目錄。 */
export function makeFakeVm(now) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-collector-'))
  const fju = path.join(root, 'srv-fju')
  const w = (rel, text) => {
    const p = path.join(fju, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text)
    return p
  }
  const lines = []
  for (let i = 1; i <= 7; i++) lines.push(`2026-10-0${i}T01:00:00Z\tdeployed\tsha-${i}\tfull\tsha256:d${i}\tunchanged`)
  lines.push('2026-10-08T01:00:00Z\trollback-start\tsha-8\thealth-failed')
  w('test/deploy/deploy_log', lines.join('\n') + '\n')
  w(
    'prod/backups/records.jsonl',
    [
      JSON.stringify({ kind: 'backup', status: 'ok', finished_at: '2026-10-11T03:00:00Z', file: 'a.dump' }),
      JSON.stringify({ kind: 'drill', status: 'ok', finished_at: '2026-10-11T04:00:00Z' }),
      '{"kind":"backup","status"', // 寫到一半的行
    ].join('\n') + '\n',
  )
  const old = w('offsite/prod/fju-prod-old.dump', 'x')
  const fresh = w('offsite/prod/2026/fju-prod-new.dump', 'xyz')
  fs.utimesSync(old, new Date(now.getTime() - 48 * 3600e3), new Date(now.getTime() - 48 * 3600e3))
  fs.utimesSync(fresh, new Date(now.getTime() - 3600e3), new Date(now.getTime() - 3600e3))
  w(
    'status/envcheck/prod.json',
    JSON.stringify({ site: 'prod', checkedAt: now.toISOString(), missing: [], forbiddenPresent: [], flags: { REGISTRATION_OPEN: 'absent', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'false' } }),
  )
  fs.mkdirSync(path.join(fju, 'status', 'inbox'), { recursive: true })
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir)
  return { root, fju, dataDir, write: w, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** 一個 run 目錄：run.json 一定寫，summary 給 undefined 就不寫、給字串就原樣寫（壞檔）。 */
export function writeRun(inbox, runId, { plan = 'full', startedAt, items, summary }) {
  const dir = path.join(inbox, runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'run.json'),
    JSON.stringify({ runId, plan, startedAt, finishedAt: startedAt, commitStart: 'abc12345', commitEnd: 'abc12345', items, passwordLeaked: false }),
  )
  if (summary !== undefined) {
    fs.writeFileSync(path.join(dir, 'summary.json'), typeof summary === 'string' ? summary : JSON.stringify(summary))
  }
}

export function baseConfig({ base, dataDir, fju }) {
  return {
    dataDir,
    fjuRoot: fju,
    offsiteRoot: path.join(fju, 'offsite'),
    envcheckDir: path.join(fju, 'status', 'envcheck'),
    inboxDir: path.join(fju, 'status', 'inbox'),
    repo: 'roy4222/fju-im-project',
    apiBase: `${base}/api`,
    rawBase: `${base}/raw`,
    gatusUrl: `${base}/gatus`,
    healthUrls: { test: `${base}/health/test`, prod: `${base}/health/prod` },
    hosts: HOSTS,
    accessTeamDomain: TEAM,
    accessProbeTemplate: `${base}/access/{host}/`,
    prodDnsHost: 'fju.roy422.dev',
    resolve4: async () => ['203.0.113.7'],
    timeoutMs: 3000,
  }
}
