#!/usr/bin/env node
// 開發者後台的收集器（設計方案 §3.3，票 S-3）。在 fju-status 映像裡以
//   node collector/collect.mjs --loop 600   （每 10 分鐘一輪，compose 的 collector 服務）
//   node collector/collect.mjs --once       （跑一輪就結束，測試與手動用）
// 執行。把 GitHub、Gatus、部署與備份紀錄、envcheck、驗收 inbox 整理成 STATUS_DATA_DIR 底下的 JSON。
// 每個來源各自成敗：一個壞了只記在 collector.json，其他照常更新；任何錯誤都不讓程式結束。
// 寫檔前整份過遮蔽檢查（lib/redact.mjs），命中就整檔不寫、保留上一版。
//
// 環境變數（括號內是預設值；compose 照預設把 VM 目錄唯讀掛到容器內同樣的路徑就不用設）：
//   STATUS_DATA_DIR（/data，唯一可寫）、STATUS_FJU_ROOT（/srv/fju：讀 <站>/deploy/deploy_log、
//   <站>/backups/records.jsonl）、STATUS_OFFSITE_ROOT（<FJU_ROOT>/offsite）、
//   STATUS_ENVCHECK_DIR（<FJU_ROOT>/status/envcheck）、STATUS_INBOX_DIR（<FJU_ROOT>/status/inbox）、
//   STATUS_GATUS_URL（http://gatus:8080）、STATUS_HOSTS（四個網址，逗號或空白分隔，可只寫子網域名）、
//   ACCESS_TEAM_DOMAIN（<team>.cloudflareaccess.com；沒設時接受任何 *.cloudflareaccess.com）、
//   STATUS_GITHUB_REPO（roy4222/fju-im-project）、STATUS_HEALTH_URL_TEST／_PROD、STATUS_PROD_DNS_HOST、
//   STATUS_HTTP_TIMEOUT_MS（15000）。STATUS_GITHUB_API／_RAW、STATUS_ACCESS_PROBE_TEMPLATE 只給測試換假上游。
import dns from 'node:dns'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildAcceptanceIndex } from './lib/acceptance.mjs'
import { readJson, serializeChecked, writeJsonChecked, writeText } from './lib/files.mjs'
import { fetchGithub } from './lib/github.mjs'
import { fetchHealth } from './lib/health.mjs'
import { scrubIp, findLeaks } from './lib/redact.mjs'
import { REPO_FILES, fetchRepoFiles } from './lib/repo-files.mjs'
import { collectVm } from './lib/vm.mjs'

const DEFAULT_HOSTS = ['fju-status', 'fju-status-vm', 'fju-status-logs', 'fju-status-db']
const DOMAIN = 'roy422.dev'

/** STATUS_HOSTS：逗號或空白分隔；只寫子網域名（沒有點）時補上 .roy422.dev。 */
export function parseHosts(value) {
  const list = (value ?? '').split(/[\s,]+/).filter(Boolean)
  return (list.length ? list : DEFAULT_HOSTS).map((h) => (h.includes('.') ? h : `${h}.${DOMAIN}`))
}

export function configFromEnv(env = process.env) {
  const fjuRoot = env.STATUS_FJU_ROOT || '/srv/fju'
  return {
    dataDir: env.STATUS_DATA_DIR || '/data',
    fjuRoot,
    offsiteRoot: env.STATUS_OFFSITE_ROOT || path.join(fjuRoot, 'offsite'),
    envcheckDir: env.STATUS_ENVCHECK_DIR || path.join(fjuRoot, 'status', 'envcheck'),
    inboxDir: env.STATUS_INBOX_DIR || path.join(fjuRoot, 'status', 'inbox'),
    repo: env.STATUS_GITHUB_REPO || 'roy4222/fju-im-project',
    apiBase: env.STATUS_GITHUB_API || 'https://api.github.com',
    rawBase: env.STATUS_GITHUB_RAW || 'https://raw.githubusercontent.com',
    gatusUrl: env.STATUS_GATUS_URL || 'http://gatus:8080',
    healthUrls: {
      test: env.STATUS_HEALTH_URL_TEST || 'https://test.fju.roy422.dev/api/health',
      prod: env.STATUS_HEALTH_URL_PROD || 'https://fju.roy422.dev/api/health',
    },
    hosts: parseHosts(env.STATUS_HOSTS),
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN || null,
    accessProbeTemplate: env.STATUS_ACCESS_PROBE_TEMPLATE || 'https://{host}/',
    prodDnsHost: env.STATUS_PROD_DNS_HOST || 'fju.roy422.dev',
    resolve4: (host) => dns.promises.resolve4(host),
    timeoutMs: Number(env.STATUS_HTTP_TIMEOUT_MS) || 15000,
  }
}

function message(err) {
  return scrubIp(err instanceof Error ? err.message : String(err))
}

export async function runOnce(cfg, now = new Date()) {
  const at = now.toISOString()
  const sources = {}
  const ok = (name) => (sources[name] = { ok: true, at, error: null })
  const fail = (name, err) => (sources[name] = { ok: false, at, error: message(err) })

  // 1. GitHub
  let mainSha = null
  // 上一版同時是快取：這輪沒輪到的項目沿用它（lib/github.mjs）。
  const prevGithub = readJson(path.join(cfg.dataDir, 'github.json')).value
  try {
    const gh = await fetchGithub(cfg, prevGithub, now)
    mainSha = gh.mainSha
    writeJsonChecked(cfg.dataDir, 'github.json', { generatedAt: at, ...gh })
    ok('github')
  } catch (err) {
    fail('github', err)
    // 抓不到：保留上一版內容並標 fetchError；連資料都有洩漏疑慮的（LeakError）就完全不動。
    if (!err?.kinds) {
      const base =
        prevGithub && typeof prevGithub === 'object' && !Array.isArray(prevGithub)
          ? prevGithub
          : { generatedAt: at, mainSha: null, ci: null, image: null, healthCron: null, prs: [] }
      try {
        writeJsonChecked(cfg.dataDir, 'github.json', { ...base, fetchError: message(err), fetchErrorAt: at })
      } catch {
        // 上一版本身寫不回去就算了，collector.json 已經記錯誤
      }
    }
  }

  // 2. repo/ 四檔（同一個 mainSha）
  try {
    if (!mainSha) throw new Error('這輪沒拿到 main 的 SHA，四檔都不更新')
    const files = await fetchRepoFiles({ ...cfg, mainSha, now })
    const texts = REPO_FILES.map((name) => [name, serializeChecked(`repo/${name}`, files[name])])
    for (const [name, text] of texts) writeText(path.join(cfg.dataDir, 'repo', name), text)
    ok('repo')
  } catch (err) {
    fail('repo', err)
  }

  // 3. 健康檢查與 Access 守門
  try {
    const { value, error } = await fetchHealth(cfg, now)
    writeJsonChecked(cfg.dataDir, 'health.json', { generatedAt: at, ...value })
    if (error) fail('health', new Error(error))
    else ok('health')
  } catch (err) {
    fail('health', err)
  }

  // 4. VM 上的紀錄
  try {
    const vm = await collectVm(cfg, now)
    writeJsonChecked(cfg.dataDir, 'vm.json', { generatedAt: at, ...vm })
    ok('vm')
  } catch (err) {
    fail('vm', err)
  }

  // 5. 驗收索引（requiredItems 取自剛寫好的 repo/go-live-policy.json）
  try {
    const policy = readJson(path.join(cfg.dataDir, 'repo', 'go-live-policy.json')).value
    const index = buildAcceptanceIndex(cfg.inboxDir, policy)
    writeJsonChecked(cfg.dataDir, 'acceptance-index.json', { generatedAt: at, ...index })
    ok('acceptance')
  } catch (err) {
    fail('acceptance', err)
  }

  const status = { generatedAt: at, sources }
  try {
    writeJsonChecked(cfg.dataDir, 'collector.json', status)
  } catch {
    // 錯誤訊息本身踩到遮蔽規則：只留成敗，訊息換成固定字樣。
    for (const s of Object.values(sources)) if (s.error && findLeaks(s.error).length) s.error = '錯誤訊息含敏感字樣，已省略'
    writeJsonChecked(cfg.dataDir, 'collector.json', status)
  }
  return status
}

async function main(argv) {
  const i = argv.indexOf('--loop')
  const cfg = configFromEnv()
  if (i === -1) {
    if (!argv.includes('--once')) {
      console.error('用法：node collector/collect.mjs --once | --loop <秒>')
      process.exit(2)
    }
    const status = await runOnce(cfg)
    console.log(JSON.stringify(status))
    return
  }
  const seconds = Number(argv[i + 1])
  if (!Number.isFinite(seconds) || seconds < 30) {
    console.error('--loop 後面要接秒數（至少 30）')
    process.exit(2)
  }
  // 容器裡是 PID 1，不接 SIGTERM 的話 docker stop 要等 10 秒強殺。
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0))
  for (;;) {
    try {
      const status = await runOnce(cfg)
      console.log(JSON.stringify(status))
    } catch (err) {
      console.error(`這輪收集失敗：${message(err)}`)
    }
    await new Promise((r) => setTimeout(r, seconds * 1000))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2))
}
