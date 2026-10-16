#!/usr/bin/env node
/**
 * 效能量測用的隔離資料庫（共用 SH-0，設計方案 §7.4.1）。
 *
 *   PERF_PASSWORD=<≥16 字> pnpm -C web perf:db up [--dataset normal|x3] [--base <url>]
 *   pnpm -C web perf:db check --base http://localhost:3399     三個量測帳號登入、GET 自己的首頁要 200
 *   pnpm -C web perf:db down
 *
 * 其他參數：`--name fju-perf-pg`（容器／資料目錄名）、`--port 5499`、
 * `--engine docker|native`（預設 docker；沒有 docker 的機器用 native，要 `--pg-bin <postgres 的 bin 目錄>`
 * 或環境變數 `PERF_PG_BIN`）。
 *
 * `up` 做的事：起 Postgres（`log_statement=all`，`perf:sql` 從它的 log 數 SQL）→ owner 跑 migration →
 * 設 `fju_app` 密碼 → `seed-demo.mjs`（`FJU_SITE=test`：這是隔離庫，不是測試站）→ `accounts.mjs` 建量測帳號、
 * 設 DEMO-114 為預設屆別 →（x3）`dataset.mjs x3`。已經有同名的庫就報錯，請先 `down`（不重複種）。
 *
 * 密碼一律取 `PERF_PASSWORD`（owner、fju_app、三個量測帳號共用），不寫進任何檔、不印出。
 * 印出的 `DATABASE_URL` 不含密碼；起 app 時另帶 `PGPASSWORD="$PERF_PASSWORD"`（node-postgres 會讀）。
 *
 * `down` 只刪這個名字的容器（native：只刪帶有本工具標記檔的資料目錄）。
 */
/* global setTimeout */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'

export const WEB_ROOT = path.join(import.meta.dirname, '..', '..')
export const DEFAULT_NAME = 'fju-perf-pg'
export const DEFAULT_PORT = 5499
const IMAGE = 'postgres:16.10-alpine' // 照 docker-compose.yml 的版本
const OWNER = 'fju_owner'
const DB = 'fju'
const MARKER = '.fju-perf-db'
// %u@%d：perf:sql 要靠它只取 fju_app 的語句。
const LOG_LINE_PREFIX = '%m [%p] %u@%d '
const MIN_PASSWORD_LENGTH = 16

/** `--key value` 與 `--flag` 的簡單解析；位置參數放 `_`。 */
export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1)
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[a.slice(2)] = argv[++i]
    } else {
      out[a.slice(2)] = true
    }
  }
  return out
}

export function fail(message) {
  console.error(message)
  process.exit(1)
}

export function perfPassword() {
  const pw = process.env.PERF_PASSWORD
  if (!pw || pw.length < MIN_PASSWORD_LENGTH) fail(`請設環境變數 PERF_PASSWORD（至少 ${MIN_PASSWORD_LENGTH} 個字元）。`)
  return pw
}

function stateFile(name) {
  return path.join(os.tmpdir(), 'fju-perf', `${name}.json`)
}

/** `up` 寫下的狀態（engine、port、native 的 log 檔）；沒有就是 null。 */
export function readState(name = DEFAULT_NAME) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(name), 'utf8'))
  } catch {
    return null
  }
}

/** owner 連線字串：`DATABASE_URL_OWNER` 優先，否則用 `up` 的狀態＋`PERF_PASSWORD`。 */
export function ownerUrl(name = DEFAULT_NAME) {
  if (process.env.DATABASE_URL_OWNER) return process.env.DATABASE_URL_OWNER
  const state = readState(name)
  if (!state) fail(`找不到量測庫「${name}」的狀態；先跑 perf:db up，或設 DATABASE_URL_OWNER。`)
  return `postgres://${OWNER}:${encodeURIComponent(perfPassword())}@127.0.0.1:${state.port}/${DB}`
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', ...opts })
  if (r.error) throw r.error
  return r
}

function must(cmd, args, opts = {}) {
  const r = run(cmd, args, opts)
  if (r.status !== 0) fail(`${cmd} ${args[0] ?? ''} 失敗（exit ${r.status}）${r.stderr ? `：${r.stderr.trim()}` : ''}`)
  return r
}

function hasDocker() {
  try {
    return run('docker', ['version', '--format', '{{.Server.Version}}'], { capture: true }).status === 0
  } catch {
    return false
  }
}

function dockerExists(name) {
  const r = run('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], { capture: true })
  return r.stdout.split('\n').includes(name)
}

function nativeDir(name) {
  return path.join(os.tmpdir(), 'fju-perf', name)
}

function pgBin(opts) {
  const dir = opts['pg-bin'] ?? process.env.PERF_PG_BIN
  if (!dir) fail('native 模式要 --pg-bin <postgres 的 bin 目錄>（或 PERF_PG_BIN）。')
  for (const b of ['initdb', 'pg_ctl', 'postgres']) {
    if (!fs.existsSync(path.join(dir, b))) fail(`${dir} 裡沒有 ${b}。`)
  }
  return dir
}

async function waitReady(url) {
  for (let i = 0; i < 60; i++) {
    const pool = new Pool({ connectionString: url, max: 1 })
    try {
      await pool.query('select 1')
      return
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    } finally {
      await pool.end().catch(() => {})
    }
  }
  fail('Postgres 60 秒內沒有起來。')
}

function startDocker(name, port, pw) {
  must('docker', [
    'run', '-d', '--name', name, '-p', `${port}:5432`,
    '-e', `POSTGRES_USER=${OWNER}`, '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_DB=${DB}`,
    '-e', 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C', '-e', 'TZ=UTC',
    IMAGE,
    '-c', 'log_statement=all', '-c', 'log_min_duration_statement=-1', '-c', `log_line_prefix=${LOG_LINE_PREFIX}`,
  ], { env: { ...process.env, POSTGRES_PASSWORD: pw }, capture: true })
  return { engine: 'docker', name, port }
}

async function startNative(name, port, pw, opts) {
  const bin = pgBin(opts)
  const dir = nativeDir(name)
  const data = path.join(dir, 'data')
  const logFile = path.join(dir, 'postgres.log')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, MARKER), 'fju perf db\n')
  const pwFile = path.join(dir, 'pw.tmp')
  fs.writeFileSync(pwFile, pw, { mode: 0o600 })
  try {
    must(path.join(bin, 'initdb'), ['-D', data, '-U', OWNER, `--pwfile=${pwFile}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C'], { capture: true })
  } finally {
    fs.rmSync(pwFile, { force: true })
  }
  const pgOpts = [
    `-p ${port}`, `-k ${dir}`, '-c listen_addresses=127.0.0.1', '-c TimeZone=UTC',
    '-c log_statement=all', '-c log_min_duration_statement=-1', `-c "log_line_prefix=${LOG_LINE_PREFIX}"`,
  ].join(' ')
  must(path.join(bin, 'pg_ctl'), ['-D', data, '-l', logFile, '-o', pgOpts, '-w', 'start'], { capture: true })
  const admin = new Pool({ connectionString: `postgres://${OWNER}:${encodeURIComponent(pw)}@127.0.0.1:${port}/postgres`, max: 1 })
  try {
    await admin.query(`create database ${DB}`)
  } finally {
    await admin.end()
  }
  return { engine: 'native', name, port, bin, dir, logFile }
}

/** 量測庫的 log 全文（docker：容器 log；native：log 檔）。 */
export function readDbLog(state) {
  if (state.engine === 'native') return fs.readFileSync(state.logFile, 'utf8')
  // docker logs 把 Postgres 寫在 stderr 的 log 印在 stderr；兩邊都收。
  const r = run('docker', ['logs', state.name], { capture: true, maxBuffer: 1 << 30 })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

/** `up` 收尾的防呆：log 裡出現 PERF_PASSWORD 明文就 exit 1（不印出密碼本身）。 */
function assertNoPasswordInLog(state, pw) {
  const log = readDbLog(state)
  if (log.includes(pw)) fail(`量測庫的 log 裡出現 PERF_PASSWORD 明文；請 perf:db down${state.name === DEFAULT_NAME ? '' : ` --name ${state.name}`} 後回報。`)
  console.log('已檢查：量測庫 log 裡沒有 PERF_PASSWORD 明文。')
}

function nodeScript(file, args, env) {
  must(process.execPath, [path.join(WEB_ROOT, file), ...args], { cwd: WEB_ROOT, env: { ...process.env, ...env } })
}

async function up(opts) {
  const pw = perfPassword()
  const name = opts.name ?? DEFAULT_NAME
  const port = Number(opts.port ?? DEFAULT_PORT)
  const dataset = opts.dataset ?? 'normal'
  if (!['normal', 'x3'].includes(dataset)) fail(`--dataset 只能是 normal 或 x3，收到 ${dataset}`)
  const engine = opts.engine ?? (hasDocker() ? 'docker' : null)
  if (!engine) fail('這台沒有 docker；改用 --engine native --pg-bin <postgres 的 bin 目錄>。')

  const exists = engine === 'docker' ? dockerExists(name) : fs.existsSync(nativeDir(name))
  if (exists || readState(name)) fail(`量測庫「${name}」已經存在；要重建請先 perf:db down${name === DEFAULT_NAME ? '' : ` --name ${name}`}。`)

  console.log(`起 Postgres（${engine}，${name}，port ${port}）…`)
  const state = engine === 'docker' ? startDocker(name, port, pw) : await startNative(name, port, pw, opts)
  fs.mkdirSync(path.dirname(stateFile(name)), { recursive: true })
  fs.writeFileSync(stateFile(name), JSON.stringify({ ...state, dataset }, null, 2))

  const owner = `postgres://${OWNER}:${encodeURIComponent(pw)}@127.0.0.1:${port}/${DB}`
  await waitReady(owner)
  const env = { DATABASE_URL_OWNER: owner }

  console.log('migration…')
  nodeScript('scripts/migrate.mjs', [], env)
  const pool = new Pool({ connectionString: owner, max: 1 })
  const client = await pool.connect()
  try {
    // migration 建了 fju_app 但不設密碼（同 ci.yml）。密碼用參數帶不進 ALTER ROLE，所以用 format(%L)。
    // 庫開著 log_statement=all：先把**這條連線**的語句記錄關掉，密碼才不會以明文進 log。
    // 不用 ALTER ROLE fju_owner SET log_statement——那會讓 owner 送的 PERFMARK 標記也從 log 消失。
    await client.query(`set log_statement = 'none'`)
    const { rows } = await client.query(`select format('alter role fju_app password %L', $1::text) as sql`, [pw])
    await client.query(rows[0].sql)
  } finally {
    client.release()
    await pool.end()
  }

  console.log('示範資料（seed-demo）…')
  nodeScript('scripts/seed-demo.mjs', [], { ...env, FJU_SITE: 'test' })
  console.log('量測帳號…')
  nodeScript('scripts/perf/accounts.mjs', ['setup'], env)
  if (dataset === 'x3') {
    console.log('資料集 x3…')
    nodeScript('scripts/perf/dataset.mjs', ['x3'], env)
  }

  assertNoPasswordInLog(state, pw)

  console.log('\n量測庫好了。起 app（BUSINESS_CLOCK_OVERRIDE_ENABLED 不要開，也不要起 worker——它的輪詢會算進 SQL）：')
  console.log(`  DATABASE_URL=postgres://fju_app@127.0.0.1:${port}/${DB}`)
  console.log(`  DATABASE_URL_OWNER=postgres://${OWNER}@127.0.0.1:${port}/${DB}`)
  console.log('  （密碼：PGPASSWORD="$PERF_PASSWORD"）')
  console.log(`  pnpm -C web build && DATABASE_URL=… PGPASSWORD="$PERF_PASSWORD" pnpm -C web start --port 3399`)
  console.log('  然後：pnpm -C web perf:db check --base http://localhost:3399')
  if (opts.base) nodeScript('scripts/perf/accounts.mjs', ['check', '--base', opts.base], env)
}

function down(opts) {
  const name = opts.name ?? DEFAULT_NAME
  const state = readState(name)
  const engine = opts.engine ?? state?.engine ?? 'docker'
  if (engine === 'docker') {
    if (dockerExists(name)) {
      must('docker', ['rm', '-f', name], { capture: true })
      console.log(`已刪除容器 ${name}。`)
    } else {
      console.log(`沒有容器 ${name}。`)
    }
  } else {
    const dir = state?.dir ?? nativeDir(name)
    if (fs.existsSync(path.join(dir, MARKER))) {
      const bin = state?.bin ?? opts['pg-bin'] ?? process.env.PERF_PG_BIN
      if (bin) run(path.join(bin, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'fast', '-w', 'stop'], { capture: true })
      fs.rmSync(dir, { recursive: true, force: true })
      console.log(`已停止並刪除 ${dir}。`)
    } else if (fs.existsSync(dir)) {
      fail(`${dir} 沒有本工具的標記檔，不刪。`)
    } else {
      console.log(`沒有 ${dir}。`)
    }
  }
  fs.rmSync(stateFile(name), { force: true })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cmd = opts._[0]
  if (cmd === 'up') await up(opts)
  else if (cmd === 'down') down(opts)
  else if (cmd === 'check') {
    if (!opts.base) fail('check 要 --base <url>')
    nodeScript('scripts/perf/accounts.mjs', ['check', '--base', opts.base], {})
  } else fail('用法：perf:db up [--dataset normal|x3] [--base <url>] | check --base <url> | down')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
