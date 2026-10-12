// github.json（設計方案 §3.3）：repo 公開、不用 token。每輪最多 API_BUDGET＝4 次，
// 10 分鐘一輪 → 每小時 ≤ 24 次，低於未登入 60 次的上限。
//
// 每輪一定打（2 次）：
//   1. commits/main → mainSha
//   2. workflows/ci.yml/runs?branch=main&event=push → ci 的 run（優先挑 head_sha 等於 mainSha 的）
// 視需要（第 3 次）：
//   3. ci 那個 run 的 jobs：只在 run 已完成、且快取裡不是同一個 run／同一個 run_attempt／同一個結論時才打
//      （重跑失敗的 job 會讓 run_attempt +1、jobs 變了但總結論可能還是 failure，所以要比 attempt）
// 剩下的額度輪流給（每次挑「快取最舊」的，從沒抓過的優先）：
//   - workflows/image.yml/runs?branch=main：不限 event，push 與手動重推（workflow_dispatch）都算，挑最新的
//   - workflows/health-cron.yml/runs?status=completed：最近一個已完成的
//   - pulls（最近 100 筆）
// 這輪沒輪到的項目沿用上一版 github.json 的內容，`fetchedAt.<項目>` 保留它原本抓到的時間。
// image 的 jobs 不另外抓，固定是空陣列。
import { fetchJson } from './http.mjs'

export const API_BUDGET = 4
const ROTATING = ['image', 'healthCron', 'prs']

const attemptOf = (run) => (Number.isInteger(run?.run_attempt) ? run.run_attempt : null)

function runOf(run, jobs) {
  if (!run) return null
  return {
    runId: run.id,
    headSha: run.head_sha,
    attempt: attemptOf(run),
    status: run.status,
    conclusion: run.conclusion ?? null,
    url: run.html_url,
    jobs,
  }
}

const newestFirst = (a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || b.id - a.id

/** 優先挑 head_sha 等於 mainSha 的 run 裡最新的一個；都沒有就挑最新的。 */
export function pickRun(runs, mainSha) {
  const sorted = [...runs].sort(newestFirst)
  return sorted.find((r) => r.head_sha === mainSha) ?? sorted[0] ?? null
}

const runsOf = (body) => (Array.isArray(body?.workflow_runs) ? body.workflow_runs : [])

/**
 * prev：上一版 github.json（可能是 undefined）。回傳新的 github.json 內容（不含 generatedAt）。
 * 任何一次 API 失敗就整輪丟錯，由呼叫端保留上一版並標 fetchError。
 */
export async function fetchGithub({ apiBase, repo, timeoutMs }, prev, now = new Date()) {
  const at = now.toISOString()
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'fju-status-collector',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  let used = 0
  const get = (p) => {
    if (used >= API_BUDGET) throw new Error(`超過每輪 ${API_BUDGET} 次 GitHub API 的額度`)
    used += 1
    return fetchJson(`${apiBase}/repos/${repo}${p}`, { headers, timeoutMs })
  }
  const cache = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}
  const fetchedAt = { ...(cache.fetchedAt ?? {}) }

  const commit = await get('/commits/main')
  const mainSha = commit?.sha
  if (typeof mainSha !== 'string' || !/^[0-9a-f]{40}$/.test(mainSha)) {
    throw new Error('commits/main 沒有回合法的 sha')
  }
  fetchedAt.mainSha = at

  const ciRun = pickRun(runsOf(await get('/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=20')), mainSha)
  let ciJobs = []
  if (ciRun?.status === 'completed') {
    const old = cache.ci
    const reusable =
      old &&
      old.runId === ciRun.id &&
      old.attempt === attemptOf(ciRun) &&
      old.status === 'completed' &&
      old.conclusion === (ciRun.conclusion ?? null) &&
      Array.isArray(old.jobs)
    if (reusable) {
      ciJobs = old.jobs
    } else {
      const body = await get(`/actions/runs/${ciRun.id}/jobs?per_page=100`)
      ciJobs = (body?.jobs ?? []).map((j) => ({ name: j.name, conclusion: j.conclusion ?? null }))
    }
  }
  fetchedAt.ci = at

  const out = {
    mainSha,
    ci: runOf(ciRun, ciJobs),
    image: cache.image ?? null,
    healthCron: cache.healthCron ?? null,
    prs: Array.isArray(cache.prs) ? cache.prs : [],
  }

  const fetchers = {
    image: async () =>
      runOf(pickRun(runsOf(await get('/actions/workflows/image.yml/runs?branch=main&per_page=20')), mainSha), []),
    healthCron: async () => {
      const cron = runsOf(await get('/actions/workflows/health-cron.yml/runs?status=completed&per_page=1'))[0] ?? null
      return cron ? { conclusion: cron.conclusion ?? null, url: cron.html_url, at: cron.updated_at } : null
    },
    prs: async () => {
      const pulls = await get('/pulls?state=all&sort=updated&direction=desc&per_page=100')
      return (Array.isArray(pulls) ? pulls : []).map((p) => ({
        number: p.number,
        state: p.state,
        merged: Boolean(p.merged_at),
        headRef: p.head?.ref ?? null,
        url: p.html_url,
        updatedAt: p.updated_at,
      }))
    },
  }
  // 快取最舊的先（沒抓過的排最前面）；同樣舊就照 ROTATING 的順序。
  const order = [...ROTATING].sort((a, b) => String(fetchedAt[a] ?? '').localeCompare(String(fetchedAt[b] ?? '')))
  for (const key of order) {
    if (used >= API_BUDGET) break
    out[key] = await fetchers[key]()
    fetchedAt[key] = at
  }

  return { ...out, fetchedAt, apiCalls: used, fetchError: null }
}
