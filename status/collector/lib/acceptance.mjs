// acceptance-index.json（設計方案 §3.3）：以 inbox/<run>/run.json 為主（每夜一定有），
// 同目錄 summary.json 為輔（可能沒有、可能壞掉）。
// latestFullAttempt＝最新一個 plan=full 的 runId，不管成不成功、有沒有 summary——不回退到更早的夜。
import fs from 'node:fs'
import path from 'node:path'
import { readJson } from './files.mjs'
import { ShapeError, project } from './shape.mjs'
import { RUN_FIELDS } from './shapes.mjs'

const SAFE = /^[A-Za-z0-9._-]+$/

/** acceptance-night.sh 的時間是 date +%Y-%m-%dT%H:%M:%S%z（+0800），補成 +08:00 再解析。 */
export function parseTime(s) {
  if (typeof s !== 'string' || !s) return Number.NaN
  return Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'))
}

function checkSummary(summary, runId) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return 'summary.json 不是 JSON 物件'
  if (!Array.isArray(summary.items)) return 'summary.json 沒有 items'
  if (!Array.isArray(summary.personas)) return 'summary.json 沒有 personas'
  if (summary.runId !== runId) return `summary.json 的 runId 跟 run.json 不同`
  return null
}

/**
 * 一夜的索引分欄過白名單（lib/shapes.mjs RUN_FIELDS）：哪一欄不合樣式就只把那一欄改成 null、記在 invalidReason；
 * 合法的 runId、plan、startedAt 保留，所以排序與 latestFullAttempt（最新的 full 嘗試）不會因為一欄壞掉而回退到更早那夜。
 * 不合樣式的 item 整筆不列。
 */
function indexRun(dir, name) {
  const raw = rawIndexRun(dir, name)
  if (!raw) return null
  const bad = []
  const check = (label, shape, value) => {
    try {
      return project(shape, value)
    } catch (err) {
      if (!(err instanceof ShapeError)) throw err
      bad.push(label)
      return null
    }
  }
  const out = { ...raw, items: [] }
  for (const key of ['plan', 'startedAt', 'finishedAt', 'commitStart', 'commitEnd']) out[key] = check(key, RUN_FIELDS[key], raw[key])
  raw.items.forEach((item, i) => {
    const v = check(`items[${i}]`, RUN_FIELDS.item, item)
    if (v) out.items.push(v)
  })
  if (bad.length > 0) out.invalidReason = [raw.invalidReason, `run.json 欄位格式不符（${listed(bad)}）`].filter(Boolean).join('；')
  return out
}

function emptyEntry(name) {
  return {
    runId: name,
    plan: null,
    startedAt: null,
    finishedAt: null,
    commitStart: null,
    commitEnd: null,
    items: [],
    hasSummary: false,
    summaryValid: false,
    invalidReason: null,
  }
}

const listed = (bad) => (bad.length > 10 ? `${bad.slice(0, 10).join('、')}…等 ${bad.length} 欄` : bad.join('、'))

/**
 * 讀 run.json 並先驗「原始型別」：字串才往下、null／沒有當 null、其他型別記原因；
 * 只有 finishedAt／commitEnd 允許空字串（acceptance-night.sh 跑到一半的 write_run_json 寫 ""），其他欄的空字串算壞。
 * items 不是陣列（null、物件、字串、沒有）：用空陣列代替並獨立記原因，plan 與時間照常保留（不回退）。
 * 壞的 item（不是物件、id 不是非空字串、status 不是非空字串）剔除並記原因。
 */
function rawIndexRun(dir, name) {
  const run = readJson(path.join(dir, 'run.json'))
  if (run.missing) return null
  const base = emptyEntry(name)
  const r = run.value
  if (run.error || !r || typeof r !== 'object' || Array.isArray(r)) {
    return { ...base, invalidReason: run.error ?? 'run.json 不是 JSON 物件' }
  }
  const bad = []
  const field = (key, { emptyOk = false } = {}) => {
    const v = r[key]
    if (v === undefined || v === null) return null
    if (typeof v !== 'string' || (v === '' && !emptyOk)) {
      bad.push(key)
      return null
    }
    return v === '' ? null : v
  }
  const runId = typeof r.runId === 'string' && SAFE.test(r.runId) ? r.runId : name
  const entry = {
    ...base,
    runId,
    plan: field('plan'),
    startedAt: field('startedAt'),
    finishedAt: field('finishedAt', { emptyOk: true }),
    commitStart: field('commitStart'),
    commitEnd: field('commitEnd', { emptyOk: true }),
    items: [],
  }
  if (!Array.isArray(r.items)) {
    bad.push(r.items === undefined ? 'items（沒有）' : 'items（不是陣列）')
  } else {
    r.items.forEach((i, idx) => {
      const ok =
        i && typeof i === 'object' && !Array.isArray(i) && typeof i.id === 'string' && i.id !== '' && typeof i.status === 'string' && i.status !== ''
      if (ok) entry.items.push({ id: i.id, status: i.status })
      else bad.push(`items[${idx}]`)
    })
  }
  const reasons = []
  if (runId !== name) reasons.push(`run.json 的 runId 跟目錄名 ${name} 不同`)
  if (bad.length > 0) reasons.push(`run.json 欄位型別不對（${listed(bad)}）`)
  const summary = readJson(path.join(dir, 'summary.json'))
  if (!summary.missing) {
    entry.hasSummary = true
    const problem = summary.error ?? checkSummary(summary.value, runId)
    if (problem) reasons.push(problem)
    else entry.summaryValid = true
  }
  entry.invalidReason = reasons.length > 0 ? reasons.join('；') : null
  return entry
}

export function buildAcceptanceIndex(inboxDir, policy) {
  let names = []
  try {
    names = fs
      .readdirSync(inboxDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SAFE.test(e.name))
      .map((e) => e.name)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const runs = names.map((n) => indexRun(path.join(inboxDir, n), n)).filter(Boolean)
  // 新到舊：startedAt 為主，解析不了的排最後，同時間再比 runId。
  runs.sort((a, b) => {
    const ta = parseTime(a.startedAt)
    const tb = parseTime(b.startedAt)
    const na = Number.isNaN(ta)
    const nb = Number.isNaN(tb)
    if (na !== nb) return na ? 1 : -1
    if (!na && ta !== tb) return tb - ta
    return b.runId.localeCompare(a.runId)
  })
  return {
    runs,
    latestFullAttempt: runs.find((r) => r.plan === 'full')?.runId ?? null,
    requiredItems: Array.isArray(policy?.requiredItems) ? policy.requiredItems : null,
    requiredItemsSourceSha: typeof policy?.sourceSha === 'string' ? policy.sourceSha : null,
  }
}
