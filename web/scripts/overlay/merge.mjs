/**
 * 三個共用檔的 overlay 合併器（D-23 放寬，`docs/plans/2026-10-19-c-總表/D-23-放寬.md` §1）。
 *
 * 基底（`e2e/fingerprints.ts` 的字面值、`scripts/perf/budget.json`、`scripts/perf/sql-expect.json`）留在原位、
 * 內容不動；旁邊的 `X.d/` 放每張票一個 `<票號>.json` 小檔，讀取端在讀的時候把基底和小檔合併。
 * 同一個鍵被兩張票同時動、或沒宣告 `from` 就蓋掉別人的值，一律丟 `OverlayError`，不會默默覆蓋。
 *
 * 小檔格式：
 *   { "ticket": "C1-13",
 *     "set":      { "<鍵>": <值>, "<被刪的鍵>": { "from": "<刪它的票>", "value": <值> } },
 *     "override": { "<鍵>": { "from": "base" | "<票號>", "value": <值> } },
 *     "delete":   [{ "key": "<鍵>", "from": "base" | "<票號>" }] }
 *
 * 只用 Node 內建模組（e2e 也會載入這支）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { limitFor } from '../perf/limits.mjs'

/** 檔名主幹：`C1-13`、`C5-12a`（子票）、`C2-22-fix1`（修補票）、`INFRA-2`。 */
export const TICKET_RE = /^[A-Z]+\d*-\d+[a-z]?(?:-fix\d+)?$/
const FILE_FIELDS = new Set(['ticket', 'set', 'override', 'delete'])
const BASE = 'base'

export class OverlayError extends Error {
  constructor(dir, message) {
    super(`overlay（${dir}）：${message}`)
    this.name = 'OverlayError'
    this.dir = dir
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0

/** 三種檔各自的值形狀與 `$` 鍵規則。`$rules` 的形狀跟路由列不同：驗證跳過、原樣保留基底值。 */
const KINDS = {
  fingerprints: {
    baseName: 'fingerprints.ts',
    dollar: {},
    validate(value) {
      if (!isNonEmptyString(value)) return '指紋必須是非空字串'
      return null
    },
  },
  budget: {
    baseName: 'budget.json',
    dollar: { $comment: 'frozen', $rules: 'frozen', $shared: 'override-only' },
    validate(value) {
      const why = shape(value, { baseline: isNumber, limit: isNumber })
      if (why) return `預算列必須是 { baseline, limit }（兩個數字）：${why}`
      const want = limitFor(value.baseline)
      if (value.limit !== want) return `limit ${value.limit} 不等於 limitFor(baseline ${value.baseline})＝${want}`
      return null
    },
    validateShared(value, base) {
      const why = shape(value, { baseline: isNumber, limit: isNumber })
      if (why) return `$shared 必須是 { baseline, limit }（兩個數字）：${why}`
      const baseLimit = base.$shared?.limit
      if (value.limit !== baseLimit) return `$shared.limit ${value.limit} 跟基底的 ${baseLimit} 不同（小檔只能改 $shared.baseline）`
      return null
    },
  },
  'sql-expect': {
    baseName: 'sql-expect.json',
    dollar: { $comment: 'frozen' },
    validate(value) {
      const why = shape(
        value,
        { as: isNonEmptyString, baseline: isNumber, max: isNumber, identity: isNumber },
        { noDuplicate: (v) => Array.isArray(v) && v.every(isNonEmptyString) },
      )
      if (why) return `查詢數期望列必須是 { as, baseline, max, identity, noDuplicate? }：${why}`
      return null
    },
  },
}

/** 物件形狀檢查：必填欄位都在且型別對、選填欄位型別對、沒有多餘欄位。回原因或 null。 */
function shape(value, required, optional = {}) {
  if (!isPlainObject(value)) return '不是物件'
  for (const [k, ok] of Object.entries(required)) {
    if (!(k in value)) return `缺 ${k}`
    if (!ok(value[k])) return `${k} 型別不對`
  }
  for (const [k, ok] of Object.entries(optional)) {
    if (k in value && !ok(value[k])) return `${k} 型別不對`
  }
  const extra = Object.keys(value).filter((k) => !(k in required) && !(k in optional))
  if (extra.length > 0) return `多了欄位 ${extra.join('、')}`
  return null
}

export function kindOf(name) {
  if (!(name in KINDS)) throw new Error(`不認得的 overlay 種類：${name}（fingerprints、budget、sql-expect）`)
  return name
}

/** 基底 `X.json`／`X.ts` → 小檔資料夾 `X.d/`（同層）。 */
export function overlayDirFor(baseFile) {
  const ext = path.extname(baseFile)
  return path.join(path.dirname(baseFile), `${path.basename(baseFile, ext)}.d`)
}

/**
 * 讀資料夾裡的小檔（原文，不解析）。資料夾不存在＝沒有小檔。`README.md` 與 `.` 開頭的檔略過，
 * 其他一律要是 `<票號>.json`，不合規則就報錯（不讓打錯檔名的小檔靜靜被跳過）。
 */
export function readOverlayFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const label = path.basename(dir)
  const files = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === 'README.md' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) throw new OverlayError(label, `${name} 是資料夾；這裡只放 <票號>.json`)
    if (!name.endsWith('.json') || !TICKET_RE.test(name.slice(0, -5))) {
      throw new OverlayError(label, `檔名 ${name} 不合規則（<票號>.json，例如 C1-13.json、C5-12a.json、C2-22-fix1.json）`)
    }
    files.push({ name, text: fs.readFileSync(full, 'utf8') })
  }
  return files
}

/** 把一個小檔解析成動作清單；格式錯誤在這裡就丟。 */
function parseFile(dir, kind, file) {
  const { name } = file
  const stem = name.endsWith('.json') ? name.slice(0, -5) : name
  if (!TICKET_RE.test(stem) || !name.endsWith('.json')) {
    throw new OverlayError(dir, `檔名 ${name} 不合規則（<票號>.json，例如 C1-13.json、C5-12a.json、C2-22-fix1.json）`)
  }
  let doc
  try {
    doc = JSON.parse(file.text)
  } catch (e) {
    throw new OverlayError(dir, `${name} 不是合法 JSON：${e.message}`)
  }
  if (!isPlainObject(doc)) throw new OverlayError(dir, `${name} 的內容必須是物件`)
  const unknown = Object.keys(doc).filter((k) => !FILE_FIELDS.has(k))
  if (unknown.length > 0) throw new OverlayError(dir, `${name} 有未知欄位：${unknown.join('、')}（只認 ticket、set、override、delete）`)
  if (doc.ticket !== stem) throw new OverlayError(dir, `${name} 的 ticket「${doc.ticket}」跟檔名不符（要寫 "${stem}"）`)

  const actions = []
  const seen = new Map() // key → 哪一區
  const note = (key, section) => {
    if (seen.has(key)) throw new OverlayError(dir, `${name} 的鍵 ${key} 出現兩次（${seen.get(key)} 與 ${section}）`)
    seen.set(key, section)
  }
  const checkFrom = (from, where) => {
    if (!isNonEmptyString(from)) throw new OverlayError(dir, `${name} 的 ${where} 缺 from（"base" 或 "<票號>"）`)
    if (from !== BASE && !TICKET_RE.test(from)) throw new OverlayError(dir, `${name} 的 ${where} 的 from「${from}」不是 "base" 也不是票號`)
    if (from === stem) throw new OverlayError(dir, `${name} 的 ${where} 的 from 不能是自己`)
  }

  if ('set' in doc) {
    if (!isPlainObject(doc.set)) throw new OverlayError(dir, `${name} 的 set 必須是物件`)
    for (const [key, raw] of Object.entries(doc.set)) {
      note(key, 'set')
      const readd = isPlainObject(raw) && 'from' in raw && 'value' in raw && Object.keys(raw).length === 2
      if (readd) {
        checkFrom(raw.from, `set ${key}`)
        actions.push({ file: name, ticket: stem, op: 'set', key, from: raw.from, value: raw.value })
      } else {
        actions.push({ file: name, ticket: stem, op: 'set', key, from: null, value: raw })
      }
    }
  }
  if ('override' in doc) {
    if (!isPlainObject(doc.override)) throw new OverlayError(dir, `${name} 的 override 必須是物件`)
    for (const [key, raw] of Object.entries(doc.override)) {
      note(key, 'override')
      if (!isPlainObject(raw) || !('value' in raw) || Object.keys(raw).some((k) => k !== 'from' && k !== 'value')) {
        throw new OverlayError(dir, `${name} 的 override ${key} 必須寫成 { "from": …, "value": … }`)
      }
      checkFrom(raw.from, `override ${key}`)
      actions.push({ file: name, ticket: stem, op: 'override', key, from: raw.from, value: raw.value })
    }
  }
  if ('delete' in doc) {
    if (!Array.isArray(doc.delete)) throw new OverlayError(dir, `${name} 的 delete 必須是陣列`)
    for (const raw of doc.delete) {
      if (!isPlainObject(raw) || !isNonEmptyString(raw.key) || Object.keys(raw).some((k) => k !== 'from' && k !== 'key')) {
        throw new OverlayError(dir, `${name} 的 delete 每一項必須寫成 { "key": …, "from": … }`)
      }
      note(raw.key, 'delete')
      checkFrom(raw.from, `delete ${raw.key}`)
      actions.push({ file: name, ticket: stem, op: 'delete', key: raw.key, from: raw.from })
    }
  }
  return actions
}

/** 值的形狀檢查（含 `$` 鍵規則）。 */
function validateValue(dir, kind, base, a) {
  const spec = KINDS[kind]
  if (a.key.startsWith('$')) {
    const rule = spec.dollar[a.key]
    if (!rule) throw new OverlayError(dir, `${a.file} 動到 ${a.key}：${kind} 的小檔不准動這個鍵${Object.keys(spec.dollar).length === 0 ? '（指紋沒有 $ 鍵）' : ''}`)
    if (rule === 'frozen') throw new OverlayError(dir, `${a.file} 動到 ${a.key}：小檔一律不准動 ${a.key}，要改請改基底`)
    if (a.op !== 'override') throw new OverlayError(dir, `${a.file} 對 ${a.key} 用 ${a.op}：${a.key} 只准 override`)
    const why = spec.validateShared(a.value, base)
    if (why) throw new OverlayError(dir, `${a.file} 的 ${a.key}：${why}`)
    return
  }
  if (a.op === 'delete') return
  const why = spec.validate(a.value)
  if (why) throw new OverlayError(dir, `${a.file} 的鍵 ${a.key}：${why}`)
}

const ownerFile = (owner) => (owner === BASE ? '基底' : `${owner}.json`)

/**
 * 合併一個鍵上的所有動作：先定起點（基底或唯一一個不帶 from 的 set），再沿 `from` 鏈逐個套用。
 * 回 `{ exists, owner, value }`。
 */
function resolveKey(dir, key, actions, baseHas, baseValue) {
  const plainSets = actions.filter((a) => a.op === 'set' && a.from === null)
  if (plainSets.length > 1) {
    throw new OverlayError(dir, `${plainSets[0].file} 與 ${plainSets[1].file} 都 set 同一個鍵 ${key}（set 撞 set：後合的那張改成 override，from 寫先合的票）`)
  }
  if (plainSets.length === 1 && baseHas) {
    throw new OverlayError(dir, `${plainSets[0].file} set 的鍵 ${key} 已在基底（set 撞基底：要改用 override，from: "base"）`)
  }
  const byFrom = new Map()
  for (const a of actions) {
    if (a.from === null) continue
    const other = byFrom.get(a.from)
    if (other) throw new OverlayError(dir, `${other.file} 與 ${a.file} 對鍵 ${key} 都寫 from: "${a.from}"（分叉：後合的那張把 from 改成先合的票）`)
    byFrom.set(a.from, a)
  }

  let state
  if (baseHas) state = { exists: true, owner: BASE, value: baseValue }
  else if (plainSets.length === 1) state = { exists: true, owner: plainSets[0].ticket, value: plainSets[0].value }
  else {
    const a = [...byFrom.values()][0]
    throw new OverlayError(dir, `${a.file} 對鍵 ${key} 寫 ${a.op}（from: "${a.from}"），但這個鍵不存在（基底沒有、也沒有小檔 set 它）`)
  }

  const visited = new Set()
  let cur = state.owner
  while (byFrom.has(cur)) {
    const a = byFrom.get(cur)
    visited.add(a)
    if (a.op === 'override') {
      if (!state.exists) throw new OverlayError(dir, `${a.file} override 鍵 ${key}，但它已被 ${ownerFile(state.owner)} 刪掉（刪了又改：要加回來用帶 from 的 set）`)
      state = { exists: true, owner: a.ticket, value: a.value }
    } else if (a.op === 'delete') {
      if (!state.exists) throw new OverlayError(dir, `${a.file} delete 鍵 ${key}，但它已被 ${ownerFile(state.owner)} 刪掉`)
      state = { exists: false, owner: a.ticket }
    } else {
      if (state.exists) throw new OverlayError(dir, `${a.file} 對鍵 ${key} 用帶 from 的 set，但這個鍵還在（目前主人 ${ownerFile(state.owner)}）；帶 from 的 set 只能把被那張票刪掉的鍵加回來，要改值請用 override`)
      state = { exists: true, owner: a.ticket, value: a.value }
    }
    cur = a.ticket
  }
  for (const a of byFrom.values()) {
    if (!visited.has(a)) {
      throw new OverlayError(dir, `${a.file} 對鍵 ${key} 寫 from: "${a.from}"，但目前主人是 ${ownerFile(state.owner)}（from 要寫目前主人）`)
    }
  }
  return state
}

/**
 * 純函式：基底物件＋小檔清單（`[{ name, text }]`）→ 合併結果。
 * 結果的鍵順序：基底原順序（去掉被刪的）＋新增的鍵（排序），所以檔名順序不影響結果。
 */
export function mergeOverlay(base, files, kind, dir = `${kind}.d`) {
  kindOf(kind)
  if (!isPlainObject(base)) throw new OverlayError(dir, '基底必須是物件')
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const names = new Set()
  const actions = []
  for (const f of sorted) {
    if (names.has(f.name)) throw new OverlayError(dir, `小檔 ${f.name} 出現兩次`)
    names.add(f.name)
    actions.push(...parseFile(dir, kind, f))
  }
  for (const a of actions) validateValue(dir, kind, base, a)

  const byKey = new Map()
  for (const a of actions) {
    if (!byKey.has(a.key)) byKey.set(a.key, [])
    byKey.get(a.key).push(a)
  }
  const merged = {}
  const changed = []
  const deleted = []
  for (const [key, baseValue] of Object.entries(base)) {
    if (!byKey.has(key)) {
      merged[key] = baseValue
      continue
    }
    const state = resolveKey(dir, key, byKey.get(key), true, baseValue)
    if (state.exists) {
      merged[key] = state.value
      changed.push(key)
    } else {
      deleted.push(key)
    }
  }
  for (const key of [...byKey.keys()].filter((k) => !(k in base)).sort()) {
    const state = resolveKey(dir, key, byKey.get(key), false, undefined)
    if (state.exists) {
      merged[key] = state.value
      changed.push(key)
    } else {
      deleted.push(key)
    }
  }
  return { merged, files: sorted.map((f) => f.name), changed, deleted }
}

/** 基底物件＋資料夾路徑 → 合併結果（`fingerprints.ts` 用）。 */
export function mergeFromDir(base, dir, kind) {
  return mergeOverlay(base, readOverlayFiles(dir), kind, path.basename(dir))
}

/** 基底 JSON 檔＋它旁邊的 `.d/` → 合併結果（`bundle.mjs`、`sql.mjs` 用）。 */
export function mergeFromBaseFile(baseFile, kind) {
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'))
  return mergeFromDir(base, overlayDirFor(baseFile), kind)
}

/** 基底 JSON 檔旁邊的 `.d/` 有沒有小檔（`--write-baseline` 要先問）。 */
export function hasOverlayFiles(baseFile) {
  return readOverlayFiles(overlayDirFor(baseFile)).length > 0
}

/**
 * 把小檔併進基底 JSON 檔、刪掉小檔（README 留著）。回 `{ merged, removed }`。
 * 只在沒有開著的 PR 動到小檔時，由主腦或收尾票跑。
 */
export function foldBaseFile(baseFile, kind) {
  const dir = overlayDirFor(baseFile)
  const result = mergeFromBaseFile(baseFile, kind)
  fs.writeFileSync(baseFile, `${JSON.stringify(result.merged, null, 2)}\n`)
  for (const name of result.files) fs.unlinkSync(path.join(dir, name))
  return { merged: result.merged, removed: result.files }
}

/** 指紋的 fold 不改 TS 檔，印出字面值供貼回 `BASE_FINGERPRINTS`。 */
export function fingerprintsLiteral(merged) {
  const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  const lines = Object.entries(merged).map(([k, v]) => `  ${q(k)}: ${q(v)},`)
  return `export const BASE_FINGERPRINTS: Record<string, string> = {\n${lines.join('\n')}\n}\n`
}
