#!/usr/bin/env node
/**
 * 統一驗證入口（B 階段 V0）：實作與 Review 一律用這支，不手拼指令。
 *
 *   pnpm -C web verify [單元測試檔…]           lint＋typecheck＋單元（給檔名就只跑那些單元測試檔）
 *   pnpm -C web verify --integration <檔…>     只跑指定的整合測試，用自己的 PostgreSQL 容器
 *   pnpm -C web verify --e2e <spec…>           next build＋worker build → next start＋worker → 只跑指定 spec
 *   --static                                    跟 --integration／--e2e 並用時，也跑 lint＋typecheck＋單元
 *
 * 隔離（兩個 worktree 同時跑不互撞）：
 * - 每次執行一個 run id（worktree 路徑雜湊＋PID），容器名 `fju-verify-<id>-<用途>`、資料庫名 `fju_v_<id>`；
 *   PostgreSQL 對外 port 由 docker 指派空的（只綁 127.0.0.1），app 的 port 也自己找空的。
 * - 整合測試與 e2e 各用一個容器：整合測試會改 cluster 層級的 `fju_app` 密碼，會弄壞同 cluster 上跑著的 app。
 * - `.next`、`dist` 本來就在各自 worktree 裡；app 用 `next start --port <自己的>`，不用寫死 3000 的 `pnpm start`。
 * - 結束時（成功、失敗、Ctrl-C、SIGTERM）只停自己啟動的 PID（整個 process group）與自己建的容器。
 *
 * 環境變數：`process.env` 整份透傳給每一步與 app、worker（`IDENTITY_CACHE_TTL_SECONDS=0 pnpm -C web verify --e2e …`
 * 這類前綴會到）。沒設的鍵補 CI e2e-smoke 的測試值（`.github/workflows/ci.yml`，都是假值、不是密鑰）；
 * 連線字串、BASE_URL、BETTER_AUTH_URL 一律改成這次自己的容器與 port，免得 shell 裡沿用別處的資料庫。
 * 不讀任何 `.env` 的值。repo 根缺 `.env`／`.env.migrate`／`.env.backup` 時，照 CI 用 `.env.example`
 * 的空範本補上（Compose 定義要求檔案存在），結束時刪掉自己補的。
 *
 * 只用 Node 內建模組：新 worktree 還沒 `pnpm install` 也跑得起來（會先幫你裝）。
 * 不依賴 GNU `timeout`，等待與逾時都在這支裡用計時器做（macOS／Linux 一樣）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const webDir = path.join(import.meta.dirname, '..')
const repoRoot = path.join(webDir, '..')
const bin = (name) => path.join(webDir, 'node_modules', '.bin', name)

const PG_IMAGE = 'postgres:16.10-alpine'
const OWNER_PASSWORD = 'fju_verify_owner'
const APP_PASSWORD = 'fju_verify_app'
const TAIL_LINES = 40
const HEALTH_TIMEOUT_MS = 180_000

// ───────────── 參數 ─────────────

function usage() {
  return [
    '用法：',
    '  pnpm -C web verify [單元測試檔…]',
    '  pnpm -C web verify --integration <檔…> [--e2e <spec…>] [--static]',
    '  pnpm -C web verify --e2e <spec…> [--static]',
    '例：',
    '  pnpm -C web verify',
    '  pnpm -C web verify --integration src/infrastructure/db/migrations.integration.test.ts',
    '  IDENTITY_CACHE_TTL_SECONDS=0 pnpm -C web verify --e2e e2e/smoke.spec.ts',
  ].join('\n')
}

function parseArgs(argv) {
  const parsed = { unit: [], integration: null, e2e: null, static: false }
  let target = parsed.unit
  for (const arg of argv) {
    if (arg === '--') continue
    if (arg === '-h' || arg === '--help') {
      console.log(usage())
      process.exit(0)
    } else if (arg === '--integration') {
      parsed.integration ??= []
      target = parsed.integration
    } else if (arg === '--e2e') {
      parsed.e2e ??= []
      target = parsed.e2e
    } else if (arg === '--static') {
      parsed.static = true
    } else if (arg.startsWith('-')) {
      throw new Error(`不認得的參數 ${arg}\n${usage()}`)
    } else {
      // 允許寫 web/ 開頭（從 repo 根複製來的路徑），一律轉成相對 web/。
      target.push(arg.replace(/^web\//, ''))
    }
  }
  for (const [flag, files] of [['--integration', parsed.integration], ['--e2e', parsed.e2e]]) {
    if (files && files.length === 0) throw new Error(`${flag} 後面要接檔名（只跑指定的檔，不跑全部）\n${usage()}`)
  }
  for (const file of [...parsed.unit, ...(parsed.integration ?? []), ...(parsed.e2e ?? [])]) {
    if (!fs.existsSync(path.join(webDir, file))) throw new Error(`找不到 ${file}（路徑相對 web/）`)
  }
  if (parsed.unit.length > 0 && !parsed.integration && !parsed.e2e) parsed.static = true
  if (!parsed.integration && !parsed.e2e) parsed.static = true
  return parsed
}

// ───────────── run id 與清理 ─────────────

const worktreeHash = createHash('sha1').update(fs.realpathSync(repoRoot)).digest('hex').slice(0, 6)
const runId = `${worktreeHash}${process.pid.toString(36)}${randomBytes(2).toString('hex')}`
const runDir = path.join(os.tmpdir(), `fju-verify-${runId}`)
fs.mkdirSync(runDir, { recursive: true })

const owned = { containers: [], groups: [], createdFiles: [] }
let foreground = null
/** 正在跑的那一步；被 Ctrl-C 打斷時拿來在摘要記一筆「中斷」。 */
let current = null
let cleanedUp = false

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 同步清理：Ctrl-C、例外、正常結束都走這裡，只動自己記下的東西。 */
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  if (foreground && alive(foreground.pid)) {
    try {
      process.kill(foreground.pid, 'SIGTERM')
    } catch {
      // 已經結束
    }
  }
  for (const pid of owned.groups) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      // 整組已經結束
    }
  }
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && owned.groups.some(alive)) sleepSync(200)
  for (const pid of owned.groups) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // 整組已經結束
    }
  }
  for (const name of owned.containers) {
    const r = spawnSync('docker', ['rm', '-f', '-v', name], { encoding: 'utf8' })
    console.log(r.status === 0 ? `[verify] 已移除容器 ${name}` : `[verify] 移除容器 ${name} 失敗：${r.stderr.trim()}`)
  }
  for (const file of owned.createdFiles) fs.rmSync(file, { force: true })
}

process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    console.error(`\n[verify] 收到 ${signal}，停掉自己啟動的程序與容器…`)
    if (current) {
      results.push({ ...current, status: 'fail', ms: Date.now() - current.started, tail: [`被 ${signal} 中斷`] })
      current = null
    } else {
      results.push({ name: '中斷', command: '-', status: 'fail', ms: 0, tail: [`被 ${signal} 中斷`] })
    }
    cleanup()
    printSummary()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

// ───────────── 步驟與摘要 ─────────────

const results = []

function formatMs(ms) {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function printSummary() {
  if (results.length === 0) return
  console.log('\n══════════ verify 摘要 ══════════')
  for (const r of results) {
    const mark = r.status === 'pass' ? '✔ 通過' : r.status === 'skip' ? '－ 略過' : '✘ 失敗'
    console.log(`${mark}  ${r.name}  (${formatMs(r.ms)})\n        $ ${r.command}${r.note ? `\n        ${r.note}` : ''}`)
  }
  for (const r of results.filter((x) => x.status === 'fail')) {
    console.log(`\n── ${r.name} 失敗，最後 ${TAIL_LINES} 行 ──`)
    console.log(r.tail.join('\n'))
  }
  const failed = results.filter((x) => x.status === 'fail').length
  console.log(`\n${failed === 0 ? '全部通過' : `${failed} 步失敗，app／worker log 在 ${runDir}`}；run id ${runId}`)
}

function tailOf(text) {
  return text.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1).slice(-TAIL_LINES)
}

/** 前景跑一步：輸出照樣印到終端機，同時留最後 40 行給摘要。 */
function runStep(name, command, args, { env, cwd = webDir } = {}) {
  const display = [command, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')
  console.log(`\n▶ ${name}\n  $ ${display}`)
  const started = Date.now()
  current = { name, command: display, started }
  return new Promise((resolve) => {
    let buffer = ''
    let errBuffer = ''
    const keep = (chunk) => {
      buffer += chunk
      if (buffer.length > 200_000) buffer = buffer.slice(-100_000)
    }
    const child = spawn(command, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] })
    foreground = child
    child.stdout.on('data', (d) => {
      process.stdout.write(d)
      keep(d.toString())
    })
    child.stderr.on('data', (d) => {
      process.stderr.write(d)
      keep(d.toString())
      errBuffer = (errBuffer + d.toString()).slice(-100_000)
    })
    const finish = (ok, extra = '') => {
      foreground = null
      current = null
      const tail = tailOf(buffer + extra)
      // vitest 的錯誤細節走 stderr，常被之後的 stdout 進度擠出尾段；不在尾段裡就另外附 stderr 的尾巴。
      const errTail = tailOf(errBuffer).filter((line) => line.trim() && !line.includes('ELIFECYCLE'))
      if (!ok && errTail.length > 0 && !errTail.every((line) => tail.includes(line))) {
        tail.push(`── stderr 最後 ${Math.min(errTail.length, 20)} 行 ──`, ...errTail.slice(-20))
      }
      const result = { name, command: display, status: ok ? 'pass' : 'fail', ms: Date.now() - started, tail }
      results.push(result)
      resolve(ok)
    }
    child.on('error', (error) => finish(false, `\n${error.message}`))
    child.on('close', (code, signal) => finish(code === 0, code === 0 ? '' : `\n（結束碼 ${code ?? signal}）`))
  })
}

function skipStep(name, reason) {
  results.push({ name, command: '-', status: 'skip', ms: 0, tail: [], note: reason })
}

/** 自己跑的判斷步驟（等 health 之類），一樣進摘要。 */
async function checkStep(name, command, fn) {
  console.log(`\n▶ ${name}\n  $ ${command}`)
  const started = Date.now()
  current = { name, command, started }
  try {
    const note = await fn()
    current = null
    if (note) console.log(`  ${note}`)
    results.push({ name, command, status: 'pass', ms: Date.now() - started, tail: [], note })
    return true
  } catch (error) {
    current = null
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    results.push({ name, command, status: 'fail', ms: Date.now() - started, tail: tailOf(message) })
    return false
  }
}

// ───────────── 環境 ─────────────

/** CI e2e-smoke 的測試值（假值，不是密鑰）；呼叫者 shell 裡有設的以呼叫者為準。 */
const testDefaults = {
  BETTER_AUTH_SECRET: 'ci-only-secret-ci-only-secret-32ch',
  GOOGLE_CLIENT_ID: 'ci-only-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'ci-only-client-secret',
  BUSINESS_CLOCK_OVERRIDE_ENABLED: 'true',
  FILE_MAX_BYTES: '104857600',
  GIT_COMMIT: 'verify-local',
  APP_VERSION: 'verify-local',
  PLAYWRIGHT_BROWSERS_PATH: path.join(os.homedir(), '.cache', 'fju-verify-browsers'),
}

function baseEnv() {
  const env = { ...process.env }
  for (const [key, value] of Object.entries(testDefaults)) if (!env[key]) env[key] = value
  return env
}

/** 這些一律蓋成這次自己的，呼叫者的值（可能指到共用庫）不能漏進來。 */
function forceEnv(env, forced) {
  for (const [key, value] of Object.entries(forced)) {
    if (process.env[key] && process.env[key] !== value) console.log(`[verify] ${key} 改用這次自己的值（不沿用 shell 裡的）`)
    env[key] = value
  }
  return env
}

/** 照 CI：缺 Compose 要的三個憑證檔就用 .env.example 的空範本補上，結束時刪掉自己補的。 */
function ensureComposeEnvFiles() {
  const template = path.join(repoRoot, '.env.example')
  for (const name of ['.env', '.env.migrate', '.env.backup']) {
    const file = path.join(repoRoot, name)
    if (fs.existsSync(file)) continue
    fs.copyFileSync(template, file, fs.constants.COPYFILE_EXCL)
    owned.createdFiles.push(file)
    console.log(`[verify] repo 根缺 ${name}，暫時用 .env.example 的空範本補上（結束時刪掉）`)
  }
}

// ───────────── PostgreSQL 容器 ─────────────

function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  if (r.error) throw new Error(`docker 跑不起來：${r.error.message}`)
  if (r.status !== 0) throw new Error(`docker ${args[0]} 失敗：${(r.stderr || r.stdout).trim()}`)
  return r.stdout.trim()
}

async function startPostgres(purpose) {
  const name = `fju-verify-${runId}-${purpose}`
  const database = `fju_v_${runId}`
  // 先記下名字再建：建到一半被 Ctrl-C 也收得掉。
  owned.containers.push(name)
  docker([
    'run', '-d', '--name', name,
    '--label', 'fju-verify=1', '--label', `fju-verify.worktree=${repoRoot}`, '--label', `fju-verify.pid=${process.pid}`,
    '-e', 'POSTGRES_USER=fju_owner', '-e', `POSTGRES_PASSWORD=${OWNER_PASSWORD}`, '-e', `POSTGRES_DB=${database}`,
    '-p', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql/data',
    PG_IMAGE,
  ])
  const mapping = docker(['port', name, '5432/tcp']).split('\n')[0]
  const port = Number(mapping.split(':').at(-1))
  if (!Number.isInteger(port) || port <= 0) throw new Error(`讀不到容器 ${name} 的 port：${mapping}`)
  // 走 TCP 問：初始化期間的暫時伺服器只聽 unix socket，用 socket 問會太早說好。
  const deadline = Date.now() + 60_000
  while (true) {
    const r = spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'fju_owner', '-d', database], { encoding: 'utf8' })
    if (r.status === 0) break
    if (Date.now() > deadline) throw new Error(`容器 ${name} 60 秒內沒有就緒：${(r.stdout + r.stderr).trim()}`)
    await delay(500)
  }
  const ownerUrl = `postgres://fju_owner:${OWNER_PASSWORD}@127.0.0.1:${port}/${database}`
  const appUrl = `postgres://fju_app:${APP_PASSWORD}@127.0.0.1:${port}/${database}`
  return { name, port, database, ownerUrl, appUrl, note: `容器 ${name}，127.0.0.1:${port}，資料庫 ${database}` }
}

// ───────────── 長駐程序（next start、worker） ─────────────

function startBackground(label, command, args, env) {
  const logFile = path.join(runDir, `${label}.log`)
  const out = fs.openSync(logFile, 'a')
  // detached：自己一個 process group，停的時候連 next-server 子程序一起收。
  const child = spawn(command, args, { cwd: webDir, env, stdio: ['ignore', out, out], detached: true })
  fs.closeSync(out)
  owned.groups.push(child.pid)
  let exited = null
  child.on('exit', (code, signal) => {
    exited = code ?? signal
  })
  console.log(`[verify] ${label} 啟動，PID ${child.pid}，log ${logFile}`)
  return { pid: child.pid, logFile, exitStatus: () => exited }
}

function logTail(file) {
  try {
    return tailOf(fs.readFileSync(file, 'utf8')).join('\n')
  } catch {
    return '(沒有 log)'
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// ───────────── 各模式 ─────────────

async function ensureInstalled(env) {
  if (fs.existsSync(bin('vitest')) && fs.existsSync(bin('next'))) return true
  return runStep('安裝相依（node_modules 不存在）', 'pnpm', ['install', '--frozen-lockfile', '--filter', '@fju/web...'], {
    env,
    cwd: repoRoot,
  })
}

async function runStatic(unitFiles) {
  const env = baseEnv()
  await runStep('lint', 'pnpm', ['run', 'lint'], { env })
  await runStep('typecheck', 'pnpm', ['run', 'typecheck'], { env })
  await runStep(unitFiles.length ? `單元測試（${unitFiles.length} 檔）` : '單元測試', 'pnpm', ['run', 'test:unit', ...unitFiles], { env })
}

async function runIntegration(files) {
  const name = `整合測試（${files.length} 檔）`
  let pg
  const ok = await checkStep('整合測試資料庫', `docker run ${PG_IMAGE}（唯一名稱、docker 指派 port）`, async () => {
    pg = await startPostgres('int')
    return pg.note
  })
  if (!ok) return skipStep(name, '資料庫沒起來')
  ensureComposeEnvFiles()
  const env = forceEnv(baseEnv(), { TEST_DATABASE_URL: pg.ownerUrl, DATABASE_URL_OWNER: pg.ownerUrl, DATABASE_URL: pg.appUrl })
  await runStep(name, 'pnpm', ['run', 'test:integration', ...files], { env })
}

async function runE2e(specs) {
  const name = `e2e（${specs.length} 個 spec，--workers=1）`
  const later = ['migration', 'build（next build＋worker）', '瀏覽器（chromium）', 'app＋worker 啟動', name]
  const skipRest = (from, reason) => later.slice(later.indexOf(from)).forEach((step) => skipStep(step, reason))

  let pg
  const dbOk = await checkStep('e2e 資料庫', `docker run ${PG_IMAGE}（唯一名稱、docker 指派 port）`, async () => {
    pg = await startPostgres('e2e')
    return pg.note
  })
  if (!dbOk) return skipRest('migration', '資料庫沒起來')

  const appPort = await freePort()
  const baseUrl = `http://127.0.0.1:${appPort}`
  const filesRoot = path.join(runDir, 'files')
  fs.mkdirSync(filesRoot, { recursive: true })
  const env = baseEnv()
  if (!process.env.FILES_ROOT) env.FILES_ROOT = filesRoot
  forceEnv(env, { DATABASE_URL_OWNER: pg.ownerUrl, DATABASE_URL: pg.appUrl, BASE_URL: baseUrl, BETTER_AUTH_URL: baseUrl })

  if (!(await runStep('migration', 'node', ['scripts/migrate.mjs'], { env }))) return skipRest('build（next build＋worker）', 'migration 失敗')
  // migration 建了 fju_app 但不設密碼；這個容器是自己的，照 CI 直接設。
  const rolePassword = await checkStep('設定 fju_app 密碼（自己的容器）', `docker exec ${pg.name} psql -c "ALTER ROLE fju_app PASSWORD …"`, async () => {
    docker(['exec', pg.name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'fju_owner', '-d', pg.database, '-c', `ALTER ROLE fju_app PASSWORD '${APP_PASSWORD}'`])
  })
  if (!rolePassword) return skipRest('build（next build＋worker）', 'fju_app 密碼沒設好')

  if (!(await runStep('build（next build＋worker）', 'pnpm', ['run', 'build'], { env }))) return skipRest('瀏覽器（chromium）', 'build 失敗')
  if (!(await runStep('瀏覽器（chromium）', bin('playwright'), ['install', 'chromium'], { env }))) return skipRest('app＋worker 啟動', '瀏覽器沒裝好')

  let app
  let worker
  const started = await checkStep('app＋worker 啟動', `next start --hostname 127.0.0.1 --port ${appPort} ＆ node dist/worker.mjs，等 ${baseUrl}/api/health`, async () => {
    app = startBackground('app', bin('next'), ['start', '--hostname', '127.0.0.1', '--port', String(appPort)], env)
    worker = startBackground('worker', 'node', ['dist/worker.mjs'], env)
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    let last = ''
    while (Date.now() < deadline) {
      if (app.exitStatus() !== null) throw new Error(`app 提早結束（${app.exitStatus()}）\n${logTail(app.logFile)}`)
      if (worker.exitStatus() !== null) throw new Error(`worker 提早結束（${worker.exitStatus()}）\n${logTail(worker.logFile)}`)
      try {
        const response = await globalThis.fetch(`${baseUrl}/api/health`, { signal: globalThis.AbortSignal.timeout(5_000) })
        if (response.ok) return `app PID ${app.pid}、worker PID ${worker.pid}，${baseUrl} health 綠`
        last = `HTTP ${response.status} ${await response.text().catch(() => '')}`
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
      await delay(1_000)
    }
    throw new Error(`app 在 ${HEALTH_TIMEOUT_MS / 1000} 秒內 health 沒綠（最後：${last}）\n${logTail(app.logFile)}`)
  })
  if (!started) return skipStep(name, 'app 沒起來')

  const ok = await runStep(name, bin('playwright'), ['test', '--workers=1', ...specs], { env })
  if (!ok) {
    const last = results.at(-1)
    last.tail = [...last.tail, '── worker log 最後幾行 ──', ...tailOf(logTail(worker.logFile)).slice(-10)]
  }
}

// ───────────── 主流程 ─────────────

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  console.log(`[verify] run id ${runId}（worktree ${repoRoot}）`)
  if (!(await ensureInstalled(baseEnv()))) {
    printSummary()
    process.exit(1)
  }
  if (args.static) await runStatic(args.unit)
  if (args.integration) await runIntegration(args.integration)
  if (args.e2e) await runE2e(args.e2e)
  cleanup()
  printSummary()
  if (results.every((r) => r.status === 'pass')) fs.rmSync(runDir, { recursive: true, force: true })
  process.exit(results.some((r) => r.status !== 'pass') ? 1 : 0)
}

main().catch((error) => {
  console.error('[verify] 非預期錯誤：', error)
  cleanup()
  printSummary()
  process.exit(1)
})
