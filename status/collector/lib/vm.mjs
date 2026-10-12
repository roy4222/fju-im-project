// vm.json（設計方案 §3.3）：唯讀掛入的 deploy_log、備份紀錄、offsite 目錄、envcheck 結果。
// 只取固定幾個欄位；deploy_log 的原因欄、備份紀錄的錯誤訊息都不帶出來。
import fs from 'node:fs'
import path from 'node:path'
import { readJson } from './files.mjs'
import { ShapeError, project } from './shape.mjs'
import { ENVCHECK } from './shapes.mjs'

const SITES = ['test', 'prod']

/**
 * deploy_log 第 5 欄（ops/deploy.sh 第 7 步寫 ${NEW_DIGEST:-none}）：NEW_DIGEST 是 docker 的 RepoDigest，
 * 長得像 ghcr.io/roy4222/fju-web@sha256:<64 hex>；本機建的映像沒有 digest 就是 none。
 * 正規化成 sha256:<64 hex>；none、空的、認不得的都回 null。
 */
export function normalizeDigest(col) {
  if (typeof col !== 'string' || col === '' || col === 'none') return null
  const m = /^(?:[^\s@]+@)?(sha256:[0-9a-f]{64})$/.exec(col)
  return m ? m[1] : null
}

/** deploy_log 一行一筆、tab 分隔：時間、event、tag（或映像）、……；deployed／rolled-back 第 5 欄是 digest。 */
export function parseDeployLog(text, n = 5) {
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    if (cols.length < 2) continue
    const [at, event, tag] = cols
    const hasDigest = event === 'deployed' || event === 'rolled-back'
    rows.push({ at, event, tag: tag ?? null, digest: hasDigest ? normalizeDigest(cols[4]) : null })
  }
  return rows.slice(-n).reverse()
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** records.jsonl 最後一筆 kind=backup 的 {at, ok}；壞行略過（同 ops/lib/backup-record.mjs）。 */
export function lastBackupRecord(text) {
  let last = null
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r && r.kind === 'backup') last = r
    } catch {
      // 寫到一半的行
    }
  }
  return last ? { at: last.finished_at ?? last.started_at ?? null, ok: last.status === 'ok' } : null
}

/** offsite/<站>/ 底下（含子目錄，最多三層）mtime 最新的一般檔。目錄不存在回 null。 */
export function latestFile(dir, depth = 3) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
    throw err
  }
  let best
  for (const e of entries) {
    const p = path.join(dir, e.name)
    let cand = null
    if (e.isFile()) {
      const st = fs.statSync(p)
      cand = { name: path.relative(dir, p), bytes: st.size, mtime: st.mtime.toISOString(), ms: st.mtimeMs }
    } else if (e.isDirectory() && depth > 1) {
      const sub = latestFile(p, depth - 1)
      if (sub?.file) cand = { ...sub.file, name: path.join(e.name, sub.file.name) }
    }
    if (cand && (!best || cand.ms > best.ms)) best = cand
  }
  return { file: best ?? null }
}

export async function collectVm(cfg, now) {
  const deploys = {}
  const backups = {}
  for (const site of SITES) {
    const log = readText(path.join(cfg.fjuRoot, site, 'deploy', 'deploy_log'))
    deploys[site] = log === null ? [] : parseDeployLog(log)

    const dir = path.join(cfg.offsiteRoot, site)
    const found = latestFile(dir)
    const file = found?.file ?? null
    // 欄位名照 S-1 的 types.ts（BackupInfo.latest）；offsiteDir 多分「目錄不存在」與「空目錄」。
    backups[site] = {
      latest: file ? { name: file.name, bytes: file.bytes, mtime: file.mtime } : null,
      offsiteDir: found === null ? 'missing' : file ? 'ok' : 'empty',
      lastRecord: lastBackupRecord(readText(path.join(cfg.fjuRoot, site, 'backups', 'records.jsonl'))),
    }
  }

  // envcheck 結果只取規格列的五個欄位（lib/shapes.mjs ENVCHECK）：多的欄位丟掉；已知欄位值不合樣式就當沒有結果、記原因。
  const env = readJson(path.join(cfg.envcheckDir, 'prod.json'))
  let prodEnv = null
  let prodEnvError = null
  if (env.missing) prodEnvError = '還沒有 envcheck 結果'
  else if (env.error) prodEnvError = env.error
  else {
    try {
      prodEnv = project(ENVCHECK, env.value)
    } catch (err) {
      if (!(err instanceof ShapeError)) throw err
      prodEnvError = `envcheck 結果格式不符（${err.message}）`
    }
  }

  let hasA = false
  try {
    hasA = (await cfg.resolve4(cfg.prodDnsHost)).length > 0
  } catch {
    hasA = false
  }

  return {
    deploys,
    backups,
    prodEnv,
    prodEnvError,
    prodDns: { host: cfg.prodDnsHost, hasA, checkedAt: now.toISOString() },
  }
}
