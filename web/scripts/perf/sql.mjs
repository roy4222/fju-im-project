#!/usr/bin/env node
/**
 * 每頁送出幾句 SQL、各歸哪一類（共用 SH-0，設計方案 §7.4.2；由 perf-out 的 qcount.mjs 改寫）。
 *
 *   PERF_PASSWORD=… pnpm -C web perf:sql --base http://localhost:3399 --as teacher \
 *     [--routes /dashboard/teacher,/dashboard/teacher/grading] [--dataset normal|x3] \
 *     [--expect scripts/perf/sql-expect.json] [--json out.json] [--dump <route>] \
 *     [--name fju-perf-pg] [--log-cmd "<印出 Postgres log 的指令>"]
 *
 * 做法：owner 連線送 `select 'PERFMARK BEGIN <id>'`／`END` 標記，每路由抓兩次（第一次暖機、第二次為準），
 * 從量測庫的 log（docker：`docker logs <name>`；native：`perf:db up` 記下的 log 檔；或 `--log-cmd`）取兩個標記之間
 * `fju_app` 的 `statement`／`execute` 行。量測時不要起 worker（它也用 fju_app，輪詢會算進來）。
 *
 * 分類照 `signatures.json`（正規化後語句的前綴）：identity／badge／其餘 page；每條實際送出的 SQL 都算進一類，
 * 三類相加等於 total。`duplicates` 是出現 ≥ 2 次的正規化語句，只是診斷、不另加總。
 *
 * 不跟隨轉址：`status` 是原始回應碼；不是 200 的列標 N/A，最後 exit 1（不輸出假零值）。
 * `--expect`：total 超過 max、identity 超過、或 noDuplicate 的簽名出現在 duplicates → exit 1，並列出 duplicates 與前 5 大表。
 * 沒給 `--routes` 時量 `--as` 那個角色的預設後台路由＋三個公開頁（匿名只量公開頁）。
 */
/* global performance, fetch, URL, setTimeout */
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { DEFAULT_NAME, fail, ownerUrl, parseArgs, readState } from './db.mjs'
import { PERF_ACCOUNTS, resolveAs, signIn } from './accounts.mjs'

const HERE = import.meta.dirname
const APP_USER = 'fju_app'
const PUBLIC_ROUTES = ['/', '/honors', '/news']
// 不放學生的 grading／industry／timeline：學生 ST-7 會把它們轉址（3xx），放進預設會讓量測 exit 1。
export const DEFAULT_ROUTES = {
  student: ['/dashboard/student', '/dashboard/student/affairs', '/dashboard/student/groups'],
  teacher: ['/dashboard/teacher', '/dashboard/teacher/grading', '/dashboard/teacher/affairs', '/dashboard/teacher/groups'],
  admin: ['/dashboard/admin', '/dashboard/admin/affairs', '/dashboard/admin/accounts', '/dashboard/admin/groups', '/dashboard/admin/grading'],
}

const LINE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)? \S+ \[(\d+)\] (\S*)@(\S*) ([A-Z]+):\s+(.*)$/
const STATEMENT = /^(?:statement|execute [^:]*):\s?([\s\S]*)$/

/** 去註解、去雙引號、字串與數字常數換成 ?、空白合一、小寫。參數值本來就不在語句裡。 */
export function normalize(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/(?<![$\w])\d+(?:\.\d+)?\b/g, '?')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Postgres log（log_line_prefix `%m [%p] %u@%d `）→ `[{ user, text }]`，續行併回上一筆。 */
export function parseLog(text) {
  const entries = []
  let cur = null
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw)
    if (m) {
      cur = { pid: m[1], user: m[2], level: m[4], text: m[5] }
      entries.push(cur)
    } else if (cur) {
      cur.text += `\n${raw}`
    }
  }
  return entries
}

/** 兩個標記之間 fju_app 送出的語句（原文）。找不到標記回 null。 */
export function statementsBetween(entries, id) {
  const begin = entries.findIndex((e) => e.text.includes(`PERFMARK BEGIN ${id}'`))
  const end = entries.findIndex((e) => e.text.includes(`PERFMARK END ${id}'`))
  if (begin < 0 || end < 0 || end < begin) return null
  const out = []
  for (const e of entries.slice(begin + 1, end)) {
    if (e.user !== APP_USER || e.level !== 'LOG') continue
    const m = STATEMENT.exec(e.text)
    if (m) out.push(m[1])
  }
  return out
}

/** 每條語句歸 identity／badge／page 其中一類；duplicates 只是診斷。 */
export function classify(statements, signatures) {
  const counts = { identity: 0, badge: 0, page: 0 }
  const seen = new Map()
  const rows = []
  for (const raw of statements) {
    const sig = normalize(raw)
    const kind = signatures.identity.some((p) => sig.startsWith(p))
      ? 'identity'
      : signatures.badge.some((p) => sig.startsWith(p))
        ? 'badge'
        : 'page'
    counts[kind]++
    seen.set(sig, (seen.get(sig) ?? 0) + 1)
    rows.push({ kind, sig })
  }
  const duplicates = [...seen].filter(([, n]) => n >= 2).map(([sig, count]) => ({ sig, count })).sort((a, b) => b.count - a.count)
  return { total: statements.length, ...counts, duplicates, rows }
}

/** 語句碰到的表，依出現在幾句裡排序。 */
export function topTables(rows, n = 5) {
  const tally = new Map()
  for (const { sig } of rows) {
    const tables = new Set([...sig.matchAll(/\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)/g)].map((m) => m[1]))
    for (const t of tables) tally.set(t, (tally.get(t) ?? 0) + 1)
  }
  return [...tally].sort((a, b) => b[1] - a[1]).slice(0, n).map(([table, count]) => ({ table, count }))
}

/** `--expect` 的判定；回傳不合格的原因（空陣列＝過）。 */
export function judge(row, expect) {
  if (!expect) return []
  const why = []
  if (typeof expect.max === 'number' && row.total > expect.max) why.push(`total ${row.total} > max ${expect.max}`)
  if (typeof expect.identity === 'number' && row.identity > expect.identity) why.push(`identity ${row.identity} > ${expect.identity}`)
  for (const p of expect.noDuplicate ?? []) {
    const hit = row.duplicates.find((d) => d.sig.startsWith(p))
    if (hit) why.push(`重複：${p}（${hit.count} 次）`)
  }
  return why
}

function logReader(opts) {
  if (opts['log-cmd']) return () => execSync(opts['log-cmd'], { encoding: 'utf8', maxBuffer: 1 << 30 })
  const name = opts.name ?? DEFAULT_NAME
  const state = readState(name)
  if (state?.engine === 'native') return () => fs.readFileSync(state.logFile, 'utf8')
  // docker logs 把容器的 stderr（Postgres 的 log）印在 stderr。
  return () => execSync(`docker logs ${name} 2>&1`, { encoding: 'utf8', maxBuffer: 1 << 30, shell: '/bin/sh' })
}

function pad(v, n) {
  return String(v).padStart(n)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.base) fail('缺少 --base <url>')
  const who = resolveAs(opts.as)
  const routes = opts.routes
    ? String(opts.routes).split(',').map((r) => r.trim()).filter(Boolean)
    : [...(DEFAULT_ROUTES[who.label] ?? []), ...PUBLIC_ROUTES]
  if (!PERF_ACCOUNTS[who.label] && who.email && !opts.routes) fail('用 email 當 --as 時要給 --routes。')
  const signatures = JSON.parse(fs.readFileSync(path.join(HERE, 'signatures.json'), 'utf8'))
  const expectAll = opts.expect ? JSON.parse(fs.readFileSync(path.resolve(opts.expect), 'utf8')) : null
  const readLog = logReader(opts)

  const cookie = await signIn(opts.base, who.email)
  const pool = new Pool({ connectionString: ownerUrl(opts.name ?? DEFAULT_NAME), max: 1 })
  const marks = []
  try {
    for (const route of routes) {
      for (const pass of ['warm', 'measure']) {
        const id = randomUUID()
        await pool.query(`select 'PERFMARK BEGIN ${id}'`)
        const t0 = performance.now()
        const res = await fetch(new URL(route, opts.base), { headers: cookie ? { cookie } : {}, redirect: 'manual' })
        await res.arrayBuffer()
        const ms = Math.round(performance.now() - t0)
        await pool.query(`select 'PERFMARK END ${id}'`)
        if (pass === 'measure') marks.push({ route, id, status: res.status, ms })
      }
    }
  } finally {
    await pool.end()
  }

  // Postgres 寫 log 是非同步的：等最後一個標記出現在 log 裡。
  let entries = []
  for (let i = 0; i < 20; i++) {
    entries = parseLog(readLog())
    if (entries.some((e) => e.text.includes(`PERFMARK END ${marks.at(-1).id}'`))) break
    await new Promise((r) => setTimeout(r, 250))
  }

  const results = []
  let failed = false
  for (const m of marks) {
    const statements = statementsBetween(entries, m.id)
    if (statements === null) fail(`log 裡找不到 ${m.route} 的標記；量測庫有開 log_statement=all 嗎？（--name／--log-cmd）`)
    const base = { route: m.route, as: who.label, dataset: opts.dataset ?? readState(opts.name ?? DEFAULT_NAME)?.dataset ?? 'normal', status: m.status, ms: m.ms }
    if (m.status !== 200) {
      failed = true
      results.push({ ...base, total: 'N/A', identity: 'N/A', badge: 'N/A', page: 'N/A', duplicates: 'N/A' })
      continue
    }
    const c = classify(statements, signatures)
    const row = { ...base, total: c.total, identity: c.identity, badge: c.badge, page: c.page, duplicates: c.duplicates }
    const expect = expectAll?.[m.route]
    const why = expect && (!expect.as || expect.as === who.label) ? judge(row, expect) : []
    if (why.length > 0) {
      failed = true
      row.fail = why
      row.topTables = topTables(c.rows)
    }
    if (opts.dump === m.route) row.statements = c.rows
    results.push(row)
  }

  console.log(`perf:sql  as=${who.label}  base=${opts.base}`)
  console.log(`${'route'.padEnd(34)} status    ms  total  identity  badge  page  dup`)
  for (const r of results) {
    const dup = Array.isArray(r.duplicates) ? r.duplicates.length : 'N/A'
    console.log(`${r.route.padEnd(34)} ${pad(r.status, 6)} ${pad(r.ms, 5)} ${pad(r.total, 6)} ${pad(r.identity, 9)} ${pad(r.badge, 6)} ${pad(r.page, 5)} ${pad(dup, 4)}`)
  }
  for (const r of results) {
    if (r.status !== 200) console.log(`\n✗ ${r.route}：回應 ${r.status}（不是 200，不跟隨轉址），該列 N/A。`)
    if (r.fail) {
      console.log(`\n✗ ${r.route}：${r.fail.join('；')}`)
      console.log('  duplicates：')
      for (const d of r.duplicates) console.log(`    ×${d.count}  ${d.sig.slice(0, 160)}`)
      console.log(`  前 5 大表：${r.topTables.map((t) => `${t.table}(${t.count})`).join('、')}`)
    }
    if (r.statements) {
      console.log(`\n── ${r.route} 全部語句 ──`)
      for (const s of r.statements) console.log(`  [${s.kind}] ${s.sig.slice(0, 220)}`)
    }
  }
  if (opts.json) fs.writeFileSync(path.resolve(opts.json), `${JSON.stringify(results, null, 2)}\n`)
  if (failed) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
