// vm.json（設計方案 §3.3）：唯讀掛入的 deploy_log、備份紀錄、offsite 目錄、envcheck 結果，
// 以及 inbox 掛載點所在檔案系統的用量（DV 設計方案 §7.2）。
// 只取固定幾個欄位；deploy_log 的原因欄、備份紀錄的錯誤訊息都不帶出來。
import fs from 'node:fs'
import path from 'node:path'
import { readJson } from './files.mjs'
import { ShapeError, project } from './shape.mjs'
import { DISK, ENVCHECK, ISO } from './shapes.mjs'

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

/** records.jsonl 裡 kind=backup 的紀錄，依檔案順序；壞行略過（同 ops/lib/backup-record.mjs）。 */
function backupRecords(text) {
  const out = []
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r && r.kind === 'backup') out.push(r)
    } catch {
      // 寫到一半的行
    }
  }
  return out
}

/** records.jsonl 最後一筆 kind=backup 的 {at, ok}。 */
export function lastBackupRecord(text) {
  const last = backupRecords(text).at(-1)
  return last ? { at: last.finished_at ?? last.started_at ?? null, ok: last.status === 'ok' } : null
}

/**
 * 最後一筆成功備份（kind=backup、status=ok）的 {at, bytes}：後面的失敗備份與 drill 不會蓋掉它（DV 設計方案 §7.2）。
 * at 取 finished_at、缺才取 started_at；時間不是 ISO 的那筆不算（不然整個 vm.json 會被白名單擋下）。bytes 不是非負整數就 null。
 */
export function lastOkBackup(text) {
  for (const r of backupRecords(text).reverse()) {
    if (r.status !== 'ok') continue
    const at = r.finished_at ?? r.started_at
    if (typeof at !== 'string' || !ISO.test(at)) continue
    return { at, bytes: Number.isInteger(r.bytes) && r.bytes >= 0 ? r.bytes : null }
  }
  return null
}

/** statfs 結果 → vm.json 的 disk。算法同 web/src/application/ops/storage.ts usageFromStatfs：百分比分母是已用＋可用（跟 df 的 Use% 一致）。 */
export function diskFromStatfs(st, diskPath, now) {
  const usedBytes = (st.blocks - st.bfree) * st.bsize
  const availBytes = st.bavail * st.bsize
  const denominator = usedBytes + availBytes
  return {
    path: diskPath,
    totalBytes: st.blocks * st.bsize,
    usedBytes,
    availBytes,
    percent: denominator > 0 ? Math.round((usedBytes / denominator) * 100) : 0,
    checkedAt: now.toISOString(),
  }
}

/** statfs 失敗的分類文字：只放 err.code（例如 EACCES），認不得就 statfs-failed；原始訊息含路徑，不帶出來。 */
export function diskErrorCode(err) {
  const code = err?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'statfs-failed'
}

/** 上一版 vm.json 的 disk：照白名單重新投影一次，壞掉或沒有就當作從沒量成功過。 */
function previousDisk(prevVm) {
  const disk = prevVm && typeof prevVm === 'object' && !Array.isArray(prevVm) ? prevVm.disk : null
  if (disk == null) return null
  try {
    return project(DISK, disk)
  } catch (err) {
    if (!(err instanceof ShapeError)) throw err
    return null
  }
}

/**
 * 主機儲存：statfs(cfg.diskPath，預設 inboxDir)。失敗時保留上一版的 disk（連同它原本的 checkedAt），只記本輪錯誤。
 * 量到的值先過白名單：路徑或數字不合（例如 STATUS_DISK_PATH 給了相對路徑）也算這輪失敗，不讓整個 vm.json 寫不出來。
 */
async function measureDisk(cfg, now, prevVm) {
  const statfs = cfg.statfs ?? fs.promises.statfs
  const diskPath = cfg.diskPath ?? cfg.inboxDir
  try {
    return { disk: project(DISK, diskFromStatfs(await statfs(diskPath), diskPath, now)), diskError: null }
  } catch (err) {
    return { disk: previousDisk(prevVm), diskError: diskErrorCode(err) }
  }
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

/** prevVm 是上一版 vm.json 的內容（沒有或讀不到就給 null），只用來在 statfs 失敗時沿用 disk。 */
export async function collectVm(cfg, now, prevVm = null) {
  const deploys = {}
  const backups = {}
  for (const site of SITES) {
    const log = readText(path.join(cfg.fjuRoot, site, 'deploy', 'deploy_log'))
    deploys[site] = log === null ? [] : parseDeployLog(log)

    const dir = path.join(cfg.offsiteRoot, site)
    const found = latestFile(dir)
    const file = found?.file ?? null
    const records = readText(path.join(cfg.fjuRoot, site, 'backups', 'records.jsonl'))
    // 欄位名照 S-1 的 types.ts（BackupInfo.latest）；offsiteDir 多分「目錄不存在」與「空目錄」。
    backups[site] = {
      latest: file ? { name: file.name, bytes: file.bytes, mtime: file.mtime } : null,
      offsiteDir: found === null ? 'missing' : file ? 'ok' : 'empty',
      lastRecord: lastBackupRecord(records),
      lastOk: lastOkBackup(records),
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

  const { disk, diskError } = await measureDisk(cfg, now, prevVm)

  return {
    deploys,
    backups,
    prodEnv,
    prodEnvError,
    prodDns: { host: cfg.prodDnsHost, hasA, checkedAt: now.toISOString() },
    disk,
    diskError,
  }
}
