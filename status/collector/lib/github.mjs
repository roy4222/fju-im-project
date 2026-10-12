// github.json（設計方案 §3.3）：repo 公開、不用 token。每輪固定 4 次 API：
//   1. commits/main → mainSha
//   2. actions/runs?branch=main → 一次拿到 ci.yml、image.yml、health-cron.yml 的最近 run
//   3. ci 那個 run 的 jobs
//   4. pulls（最近 100 筆）
// 每小時 24 次，低於未登入 60 次的上限。image 的 jobs 不另外抓（會變第 5 次），固定是空陣列。
import { fetchJson } from './http.mjs'

const WORKFLOWS = {
  ci: '.github/workflows/ci.yml',
  image: '.github/workflows/image.yml',
  healthCron: '.github/workflows/health-cron.yml',
}

function runOf(run, jobs) {
  if (!run) return null
  return {
    runId: run.id,
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion ?? null,
    url: run.html_url,
    jobs,
  }
}

/** 同一個 workflow 優先挑 head_sha 等於 mainSha 的最新 run，沒有就挑最新的。runs 由新到舊。 */
export function pickRun(runs, workflowPath, mainSha) {
  const mine = runs.filter((r) => r.path === workflowPath)
  return mine.find((r) => r.head_sha === mainSha) ?? mine[0] ?? null
}

export async function fetchGithub({ apiBase, repo, timeoutMs }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'fju-status-collector',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const get = (p) => fetchJson(`${apiBase}/repos/${repo}${p}`, { headers, timeoutMs })

  const commit = await get('/commits/main')
  const mainSha = commit?.sha
  if (typeof mainSha !== 'string' || !/^[0-9a-f]{40}$/.test(mainSha)) {
    throw new Error('commits/main 沒有回合法的 sha')
  }
  const runsBody = await get('/actions/runs?branch=main&per_page=100')
  const runs = Array.isArray(runsBody?.workflow_runs) ? runsBody.workflow_runs : []

  const ciRun = pickRun(runs, WORKFLOWS.ci, mainSha)
  let ciJobs = []
  if (ciRun) {
    const jobsBody = await get(`/actions/runs/${ciRun.id}/jobs?per_page=100`)
    ciJobs = (jobsBody?.jobs ?? []).map((j) => ({ name: j.name, conclusion: j.conclusion ?? null }))
  }
  const imageRun = pickRun(runs, WORKFLOWS.image, mainSha)
  const cron = runs.find((r) => r.path === WORKFLOWS.healthCron && r.status === 'completed') ?? null

  const pulls = await get('/pulls?state=all&sort=updated&direction=desc&per_page=100')
  const prs = (Array.isArray(pulls) ? pulls : []).map((p) => ({
    number: p.number,
    state: p.state,
    merged: Boolean(p.merged_at),
    headRef: p.head?.ref ?? null,
    url: p.html_url,
    updatedAt: p.updated_at,
  }))

  return {
    mainSha,
    ci: runOf(ciRun, ciJobs),
    image: runOf(imageRun, []),
    healthCron: cron ? { conclusion: cron.conclusion ?? null, url: cron.html_url, at: cron.updated_at } : null,
    prs,
    fetchError: null,
  }
}
