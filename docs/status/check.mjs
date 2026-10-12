#!/usr/bin/env node
// 檢查 docs/status/ 四個人維護的設定檔格式（開發者後台 S-2，設計方案 §3.4）。
// 零依賴：只用 Node 內建模組。CI（.github/workflows/status.yml）與主腦改完檔都跑：
//   node docs/status/check.mjs
//   node docs/status/check.mjs --night-script <另一份 acceptance-night.sh>   # 測試用
//   node docs/status/check.mjs --dir <另一個放四個檔的目錄>                   # 測試用
// 全部通過結束碼 0；有任何錯誤逐條印出「哪個檔、哪一筆、哪個欄位」，結束碼 1。

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

const TICKET_STATUSES = ['todo', 'doing', 'review', 'merged', 'blocked', 'dropped']
const NOTE_REQUIRED = ['blocked', 'dropped']
const ROLE_KEYS = ['visitor', 'student', 'teacher', 'admin']
const CRUD_KEYS = ['create', 'edit', 'delete']
const CRUD_VALUES = ['有', '無', '只能下架', '程式寫死']
const RUN_ID = /^night-\d{8}-\d{4}(\d{2})?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function parseArgs(argv) {
  const opts = { dir: HERE, nightScript: join(REPO_ROOT, 'ops', 'acceptance-night.sh') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir' || a === '--night-script') {
      const v = argv[++i]
      if (!v) throw new Error(`${a} 後面要接路徑`)
      if (a === '--dir') opts.dir = resolve(v)
      else opts.nightScript = resolve(v)
    } else {
      throw new Error(`不認得的參數：${a}`)
    }
  }
  return opts
}

const errors = []
const fail = (file, where, msg) => errors.push(`[${file}] ${where}：${msg}`)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string'
const isNonEmptyStr = (v) => typeof v === 'string' && v.trim() !== ''
const isStepNo = (v) => Number.isInteger(v) && v >= 0

function readJson(dir, file) {
  const p = join(dir, file)
  if (!existsSync(p)) {
    fail(file, '整檔', `找不到 ${p}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    fail(file, '整檔', `不是合法 JSON（${e.message}）`)
    return null
  }
}

function duplicates(list) {
  const seen = new Set()
  const dup = new Set()
  for (const x of list) (seen.has(x) ? dup : seen).add(x)
  return [...dup]
}

// 純文字解析 ops/acceptance-night.sh 的 PLAN_FULL=( … )：每個引號字串第一個 | 前的 id（一行多筆也抓）。不執行腳本。
export function parsePlanFull(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^\s*PLAN_FULL=\(\s*$/.test(l))
  if (start < 0) return null
  const ids = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('#')) continue
    for (const m of line.matchAll(/["']([^"'|]+)\|/g)) ids.push(m[1].trim())
    if (/^\)/.test(line)) return ids
  }
  return null // 沒找到結尾的 )
}

// 必要項的類型由 id 決定：story-*／r1-* 看步驟，ux-* 看人設任務數，security-static 只看 status。
function itemKind(id) {
  if (/^story-\d+$/.test(id) || /^r1-/.test(id)) return 'steps'
  if (/^ux-/.test(id)) return 'tasks'
  if (id === 'security-static') return 'none'
  return null
}

function checkPolicy(dir, nightScript) {
  const F = 'go-live-policy.json'
  const policy = readJson(dir, F)
  let planIds = null
  if (!existsSync(nightScript)) {
    fail('acceptance-night.sh', '整檔', `找不到 ${nightScript}`)
  } else {
    planIds = parsePlanFull(readFileSync(nightScript, 'utf8'))
    if (planIds === null) fail('acceptance-night.sh', 'PLAN_FULL', `${nightScript} 裡找不到完整的 PLAN_FULL=( … ) 區塊`)
    else {
      for (const d of duplicates(planIds)) fail('acceptance-night.sh', 'PLAN_FULL', `id 重複：${d}`)
    }
  }
  // 回傳給測試地圖對照用：項目清單以 PLAN_FULL 為準（政策檔自己壞掉時不連帶報一堆錯）。
  const result = { itemIds: planIds ?? [], steps: {} }
  if (!isObj(policy)) {
    if (policy !== null) fail(F, '整檔', '最外層要是物件')
    return result
  }
  const req = policy.requiredItems
  if (!Array.isArray(req) || req.length === 0) {
    fail(F, 'requiredItems', '要是非空陣列（等於 PLAN_FULL 的 id）')
    return result
  }
  if (!planIds) result.itemIds = req
  req.forEach((id, i) => {
    if (!isNonEmptyStr(id)) fail(F, `requiredItems[${i}]`, '要是非空字串')
    else if (itemKind(id) === null) fail(F, `requiredItems[${i}]`, `不認得的項目類型：${id}（只認 story-N、r1-*、ux-*、security-static）`)
  })
  for (const d of duplicates(req)) fail(F, 'requiredItems', `id 重複：${d}`)
  if (planIds) {
    const reqSet = new Set(req)
    const planSet = new Set(planIds)
    for (const id of planSet) if (!reqSet.has(id)) fail(F, 'requiredItems', `少了 ${id}（acceptance-night.sh 的 PLAN_FULL 有）`)
    for (const id of reqSet) if (!planSet.has(id)) fail(F, 'requiredItems', `多了 ${id}（acceptance-night.sh 的 PLAN_FULL 沒有）`)
  }

  const items = policy.items
  if (!isObj(items)) {
    fail(F, 'items', '要是物件，鍵是每個必要項的 id')
    return result
  }
  const reqSet = new Set(req)
  for (const id of reqSet) if (!(id in items)) fail(F, `items`, `少了 ${id} 那筆`)
  for (const id of Object.keys(items)) {
    if (!reqSet.has(id)) {
      fail(F, 'items', `多了 ${id} 那筆（不在 requiredItems）`)
      continue
    }
    const v = items[id]
    const where = `items["${id}"]`
    if (!isObj(v)) {
      fail(F, where, '要是物件')
      continue
    }
    const kind = itemKind(id)
    if (kind === 'steps') {
      if (!Array.isArray(v.steps) || v.steps.length === 0) fail(F, `${where}.steps`, '要是非空的步驟號陣列')
      else {
        v.steps.forEach((s, i) => {
          if (!isStepNo(s)) fail(F, `${where}.steps[${i}]`, `步驟號要是 ≥ 0 的整數，現在是 ${JSON.stringify(s)}`)
        })
        for (const d of duplicates(v.steps)) fail(F, `${where}.steps`, `步驟號重複：${d}`)
        if (v.steps.every(isStepNo)) result.steps[id] = v.steps
      }
    } else if (kind === 'tasks') {
      if (!Number.isInteger(v.tasks) || v.tasks < 1) fail(F, `${where}.tasks`, `人設任務數要是 ≥ 1 的整數，現在是 ${JSON.stringify(v.tasks)}`)
    } else if (kind === 'none') {
      if (Object.keys(v).length > 0) fail(F, where, '要是空物件 {}（只看 status，不要求步驟）')
    }
  }
  return result
}

function checkTickets(dir) {
  const F = 'tickets.json'
  const doc = readJson(dir, F)
  if (!isObj(doc)) {
    if (doc !== null) fail(F, '整檔', '最外層要是物件')
    return
  }
  if (!isNonEmptyStr(doc.updatedAt) || Number.isNaN(Date.parse(doc.updatedAt))) fail(F, 'updatedAt', '要是 ISO 時間字串')
  const batchIds = new Set()
  if (!Array.isArray(doc.batches) || doc.batches.length === 0) fail(F, 'batches', '要是非空陣列')
  else {
    doc.batches.forEach((b, i) => {
      const where = `batches[${i}]`
      if (!isObj(b)) return fail(F, where, '要是物件')
      if (!isNonEmptyStr(b.id)) fail(F, `${where}.id`, '要是非空字串')
      else if (batchIds.has(b.id)) fail(F, `${where}.id`, `批次 id 重複：${b.id}`)
      else batchIds.add(b.id)
      if (!isNonEmptyStr(b.name)) fail(F, `${where}.name`, '要是非空字串')
      if (!isNonEmptyStr(b.plan)) fail(F, `${where}.plan`, '要是非空字串（設計方案路徑）')
    })
  }
  if (!Array.isArray(doc.tickets)) return fail(F, 'tickets', '要是陣列')
  const ids = doc.tickets.map((t) => (isObj(t) ? t.id : undefined))
  const idSet = new Set(ids.filter(isNonEmptyStr))
  for (const d of duplicates(ids.filter(isNonEmptyStr))) fail(F, 'tickets', `票號重複：${d}`)
  doc.tickets.forEach((t, i) => {
    if (!isObj(t)) return fail(F, `tickets[${i}]`, '要是物件')
    const where = `tickets[${i}]（${isNonEmptyStr(t.id) ? t.id : '沒有 id'}）`
    if (!isNonEmptyStr(t.id)) fail(F, `${where}.id`, '要是非空字串')
    if (!batchIds.has(t.batch)) fail(F, `${where}.batch`, `指到不存在的批次：${JSON.stringify(t.batch)}`)
    for (const k of ['title', 'wave', 'owner']) if (!isNonEmptyStr(t[k])) fail(F, `${where}.${k}`, '要是非空字串')
    if (!isStr(t.branch)) fail(F, `${where}.branch`, '要是字串（還沒開分支就寫空字串）')
    if (!TICKET_STATUSES.includes(t.status)) fail(F, `${where}.status`, `只能是 ${TICKET_STATUSES.join('／')}，現在是 ${JSON.stringify(t.status)}`)
    if (!isStr(t.note)) fail(F, `${where}.note`, '要是字串')
    else if (NOTE_REQUIRED.includes(t.status) && t.note.trim() === '') fail(F, `${where}.note`, `狀態是 ${t.status} 時必填原因`)
    if (!(t.pr === null || (Number.isInteger(t.pr) && t.pr > 0))) fail(F, `${where}.pr`, `要是正整數或 null，現在是 ${JSON.stringify(t.pr)}`)
    if (t.status === 'merged' && t.pr === null) fail(F, `${where}.pr`, '狀態是 merged 時要填 PR 號')
    if (!Array.isArray(t.dependsOn)) fail(F, `${where}.dependsOn`, '要是陣列')
    else
      t.dependsOn.forEach((d, j) => {
        if (d === t.id) fail(F, `${where}.dependsOn[${j}]`, '不能相依自己')
        else if (!idSet.has(d)) fail(F, `${where}.dependsOn[${j}]`, `指到不存在的票：${JSON.stringify(d)}`)
      })
    if (!Array.isArray(t.acceptance) || !t.acceptance.every(isNonEmptyStr)) fail(F, `${where}.acceptance`, '要是字串陣列')
  })
}

function checkTestMap(dir, policy) {
  const F = 'test-map.json'
  const doc = readJson(dir, F)
  if (!isObj(doc)) {
    if (doc !== null) fail(F, '整檔', '最外層要是物件')
    return
  }
  // 角色：剛好四個；每個都要有別名；同一個別名不能同時歸到兩個角色（完全相等比對，歸兩邊就分不出來）。
  const aliasOwner = new Map()
  if (!Array.isArray(doc.roles)) fail(F, 'roles', '要是陣列')
  else {
    const keys = doc.roles.map((r) => (isObj(r) ? r.key : undefined))
    for (const k of ROLE_KEYS) if (!keys.includes(k)) fail(F, 'roles', `少了角色 ${k}`)
    for (const k of keys) if (!ROLE_KEYS.includes(k)) fail(F, 'roles', `不認得的角色 key：${JSON.stringify(k)}（只能是 ${ROLE_KEYS.join('／')}）`)
    for (const d of duplicates(keys)) fail(F, 'roles', `角色 key 重複：${d}`)
    doc.roles.forEach((r, i) => {
      if (!isObj(r)) return fail(F, `roles[${i}]`, '要是物件')
      const where = `roles[${i}]（${r.key}）`
      if (!isNonEmptyStr(r.name)) fail(F, `${where}.name`, '要是非空字串')
      if (!Array.isArray(r.aliases) || r.aliases.length === 0) return fail(F, `${where}.aliases`, '要是非空字串陣列（劇本「角色」欄的實際寫法）')
      r.aliases.forEach((a, j) => {
        if (!isNonEmptyStr(a)) return fail(F, `${where}.aliases[${j}]`, '要是非空字串')
        if (aliasOwner.has(a) && aliasOwner.get(a) !== r.key) fail(F, `${where}.aliases[${j}]`, `「${a}」同時歸到 ${aliasOwner.get(a)} 與 ${r.key}`)
        else if (aliasOwner.has(a)) fail(F, `${where}.aliases[${j}]`, `別名重複：「${a}」`)
        aliasOwner.set(a, r.key)
      })
    })
  }

  const itemSet = new Set(policy.itemIds)
  const featureKeys = new Set()
  if (!Array.isArray(doc.features)) fail(F, 'features', '要是陣列')
  else {
    const keys = doc.features.map((f) => (isObj(f) ? f.key : undefined))
    for (const d of duplicates(keys.filter(isNonEmptyStr))) fail(F, 'features', `功能 key 重複：${d}`)
    doc.features.forEach((f, i) => {
      if (!isObj(f)) return fail(F, `features[${i}]`, '要是物件')
      const where = `features[${i}]（${isNonEmptyStr(f.key) ? f.key : '沒有 key'}）`
      if (!isNonEmptyStr(f.key)) fail(F, `${where}.key`, '要是非空字串')
      else featureKeys.add(f.key)
      if (!isNonEmptyStr(f.name)) fail(F, `${where}.name`, '要是非空字串')
      if (!Array.isArray(f.roles) || f.roles.length === 0) fail(F, `${where}.roles`, '要是非空陣列')
      else f.roles.forEach((r, j) => ROLE_KEYS.includes(r) || fail(F, `${where}.roles[${j}]`, `不認得的角色：${JSON.stringify(r)}`))
      if (!Array.isArray(f.evidence)) fail(F, `${where}.evidence`, '要是陣列')
      else
        f.evidence.forEach((e, j) => {
          const w = `${where}.evidence[${j}]`
          if (!isObj(e)) return fail(F, w, '要是物件')
          if (!itemSet.has(e.item)) return fail(F, `${w}.item`, `不是夜跑完整計畫裡的項目：${JSON.stringify(e.item)}`)
          if (itemKind(e.item) !== 'steps') return fail(F, `${w}.item`, `${e.item} 沒有步驟表（人設、資安掃描不能當步驟證據）`)
          if (!Array.isArray(e.steps) || e.steps.length === 0) return fail(F, `${w}.steps`, '要是非空的步驟號陣列')
          // 政策檔那一項的步驟號本身壞掉時，上面已經報過，這裡不再逐步對照。
          const known = policy.steps[e.item] ? new Set(policy.steps[e.item]) : null
          e.steps.forEach((s, k) => {
            if (!isStepNo(s)) fail(F, `${w}.steps[${k}]`, `步驟號要是 ≥ 0 的整數，現在是 ${JSON.stringify(s)}`)
            else if (known && !known.has(s)) fail(F, `${w}.steps[${k}]`, `${e.item} 沒有第 ${s} 步（對照 go-live-policy.json 的 items）`)
          })
        })
      if (!Array.isArray(f.e2e)) fail(F, `${where}.e2e`, '要是陣列（沒有就寫 []）')
      else
        f.e2e.forEach((p, j) => {
          if (!isNonEmptyStr(p)) fail(F, `${where}.e2e[${j}]`, '要是非空字串')
          else if (!existsSync(join(REPO_ROOT, p))) fail(F, `${where}.e2e[${j}]`, `repo 裡沒有這個檔：${p}`)
        })
    })
  }

  if (!Array.isArray(doc.sections)) return fail(F, 'sections', '要是陣列')
  const sKeys = doc.sections.map((s) => (isObj(s) ? s.key : undefined))
  for (const d of duplicates(sKeys.filter(isNonEmptyStr))) fail(F, 'sections', `前台區 key 重複：${d}`)
  doc.sections.forEach((s, i) => {
    if (!isObj(s)) return fail(F, `sections[${i}]`, '要是物件')
    const where = `sections[${i}]（${isNonEmptyStr(s.key) ? s.key : '沒有 key'}）`
    if (!isNonEmptyStr(s.key)) fail(F, `${where}.key`, '要是非空字串')
    if (!isNonEmptyStr(s.name)) fail(F, `${where}.name`, '要是非空字串')
    if (!isNonEmptyStr(s.page) || !s.page.startsWith('/')) fail(F, `${where}.page`, '要是 / 開頭的前台路徑')
    if (!featureKeys.has(s.frontFeature)) fail(F, `${where}.frontFeature`, `指到不存在的功能：${JSON.stringify(s.frontFeature)}`)
    const hasException = isNonEmptyStr(s.exception)
    if (s.exception !== undefined && !hasException) fail(F, `${where}.exception`, '有寫就要是非空字串（例外原因）')
    if (s.adminPage !== null && !(isNonEmptyStr(s.adminPage) && s.adminPage.startsWith('/dashboard/'))) fail(F, `${where}.adminPage`, '要是 /dashboard/ 開頭的路徑或 null')
    if (s.adminFeature !== null && !featureKeys.has(s.adminFeature)) fail(F, `${where}.adminFeature`, `指到不存在的功能：${JSON.stringify(s.adminFeature)}`)
    if (s.crud === null) {
      if (!hasException) fail(F, `${where}.crud`, '只有寫了 exception 的列可以是 null')
    } else if (!isObj(s.crud)) fail(F, `${where}.crud`, '要是 {create, edit, delete} 物件或 null')
    else {
      for (const k of CRUD_KEYS)
        if (!CRUD_VALUES.includes(s.crud[k])) fail(F, `${where}.crud.${k}`, `只能是 ${CRUD_VALUES.join('／')}，現在是 ${JSON.stringify(s.crud[k])}`)
      for (const k of Object.keys(s.crud)) if (!CRUD_KEYS.includes(k)) fail(F, `${where}.crud.${k}`, '多出來的欄位（只能有 create、edit、delete）')
    }
  })
}

function checkWaivers(dir, policy) {
  const F = 'go-live-waivers.json'
  const doc = readJson(dir, F)
  if (!isObj(doc)) {
    if (doc !== null) fail(F, '整檔', '最外層要是物件')
    return
  }
  if (!Array.isArray(doc.waivers)) return fail(F, 'waivers', '要是陣列（沒有豁免就寫 []）')
  const itemSet = new Set(policy.itemIds)
  const keys = []
  doc.waivers.forEach((w, i) => {
    const where = `waivers[${i}]`
    if (!isObj(w)) return fail(F, where, '要是物件')
    if (!isStr(w.runId) || !RUN_ID.test(w.runId)) fail(F, `${where}.runId`, `要是 night-YYYYMMDD-HHMM 這種夜跑 id，現在是 ${JSON.stringify(w.runId)}`)
    if (!itemSet.has(w.item)) fail(F, `${where}.item`, `不是夜跑完整計畫裡的項目：${JSON.stringify(w.item)}`)
    for (const k of ['problemId', 'approvedBy', 'reason']) if (!isNonEmptyStr(w[k])) fail(F, `${where}.${k}`, '要是非空字串')
    if (!isStr(w.approvedAt) || !DATE.test(w.approvedAt)) fail(F, `${where}.approvedAt`, '要是 YYYY-MM-DD')
    keys.push(`${w.runId}|${w.item}|${w.problemId}`)
  })
  for (const d of duplicates(keys)) fail(F, 'waivers', `同一夜同一題重複豁免：${d}`)
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  const policy = checkPolicy(opts.dir, opts.nightScript)
  checkTickets(opts.dir)
  checkTestMap(opts.dir, policy)
  checkWaivers(opts.dir, policy)
  if (errors.length > 0) {
    console.error(`docs/status 格式檢查失敗（${errors.length} 項）：`)
    for (const e of errors) console.error(`- ${e}`)
    process.exit(1)
  }
  console.log('docs/status 格式檢查通過：tickets.json、test-map.json、go-live-policy.json、go-live-waivers.json')
}

// 直接執行才跑（被 import 時只提供 parsePlanFull）；用 realpath 比對，透過 symlink 執行也算。
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) main()
