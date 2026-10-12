// repo/ 四檔（設計方案 §3.3、§3.4）：全部取自同一個 mainSha 的 docs/status/。
// 任一檔抓不到或不是合法 JSON 物件 → 四檔都不更新（避免畫面混用兩個版本的設定）。
import { fetchJson } from './http.mjs'

export const REPO_FILES = ['tickets.json', 'test-map.json', 'go-live-waivers.json', 'go-live-policy.json']

/** 回傳 { 'tickets.json': {...原內容, sourceSha, generatedAt}, ... }；任一失敗就丟錯。 */
export async function fetchRepoFiles({ rawBase, repo, mainSha, timeoutMs, now }) {
  const out = {}
  for (const name of REPO_FILES) {
    let body
    try {
      body = await fetchJson(`${rawBase}/${repo}/${mainSha}/docs/status/${name}`, { timeoutMs })
    } catch (err) {
      throw new Error(`docs/status/${name}：${err.message}`)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(`docs/status/${name} 不是 JSON 物件`)
    }
    out[name] = { ...body, sourceSha: mainSha, generatedAt: now.toISOString() }
  }
  return out
}
