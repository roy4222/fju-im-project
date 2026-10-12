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

/** acceptance-night.sh 跑到一半時 finishedAt／commitEnd 是空字串（write_run_json 的 --arg）：當 null。 */
function str(v) {
  return typeof v === 'string' && v !== '' ? v : null
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
  if (bad.length > 0) {
    const listed = bad.length > 10 ? `${bad.slice(0, 10).join('、')}…等 ${bad.length} 欄` : bad.join('、')
    out.invalidReason = [raw.invalidReason, `run.json 欄位格式不符（${listed}）`].filter(Boolean).join('；')
  }
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

function rawIndexRun(dir, name) {
  const run = readJson(path.join(dir, 'run.json'))
  if (run.missing) return null
  const base = emptyEntry(name)
  const r = run.value
  if (run.error || !r || typeof r !== 'object' || !Array.isArray(r.items)) {
    return { ...base, invalidReason: run.error ?? 'run.json 沒有 items' }
  }
  const runId = typeof r.runId === 'string' && SAFE.test(r.runId) ? r.runId : name
  const entry = {
    ...base,
    runId,
    plan: str(r.plan),
    startedAt: str(r.startedAt),
    finishedAt: str(r.finishedAt),
    commitStart: str(r.commitStart),
    commitEnd: str(r.commitEnd),
    items: r.items
      .filter((i) => i && typeof i.id === 'string')
      .map((i) => ({ id: i.id, status: str(i.status) })),
  }
  if (runId !== name) entry.invalidReason = `run.json 的 runId 跟目錄名 ${name} 不同`
  const summary = readJson(path.join(dir, 'summary.json'))
  if (summary.missing) return entry
  entry.hasSummary = true
  const bad = summary.error ?? checkSummary(summary.value, runId)
  if (bad) entry.invalidReason = bad
  else entry.summaryValid = true
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
