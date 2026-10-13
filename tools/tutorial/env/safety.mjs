#!/usr/bin/env node
/**
 * 教學環境的防呆：這幾支腳本會刪庫、清目錄、送訊號，所以動手前先確認目標真的是本機的教學專用那一份。
 *
 * 純函式（給 safety.test.mjs 測）＋兩個給 shell 用的子指令：
 *
 *   node safety.mjs check-env                         驗證環境變數決定的目標；過了就印出正規化後的值（KEY=VALUE 一行一個）
 *   node safety.mjs proc-record <kind> <pid> <meta> <cwd>  程序剛起來時記下它的身分（啟動時間、工作目錄、種類、PGID）
 *   node safety.mjs proc-check  <kind> <meta>         pid 檔記的那個程序還是不是我們起的那一個（是＝exit 0）
 *
 * 規則：
 *   - 實例 `INSTANCE` 只能是 0～4（沒設＝0）。實例 n 的資料庫是 `fju_tutorial`（0）或 `fju_tutorial_<n>`、app port 3300+n。
 *   - 資料庫名只接受 `fju_tutorial` 與 `fju_tutorial_1`～`fju_tutorial_4`，而且要等於這個實例的那一個
 *     （同一個 cluster 上還有各票的 e2e／測試庫）。
 *   - 連線字串照 pg 實際的解析結果驗：host 只能是 localhost／127.0.0.1／::1、port 55432、database 是這個實例的；
 *     帶任何查詢參數（例如 `?host=` 會蓋掉網址裡的 host）一律拒絕。
 *   - FILES_ROOT 正規化（realpath，含符號連結）後必須是 `~/work/tutorial-files/<n>` 或它底下的目錄
 *     （每個實例分開，reset 一個實例不會清到別的實例的檔案）；邊界上的 work、tutorial-files、<n> 三層
 *     本身都不能是符號連結（否則邊界會跟著連結跑到別的實例或 HOME）。
 *   - Docker 一律經本機 unix socket；`DOCKER_HOST` 設成 unix:// 以外（tcp、ssh…）就拒絕。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

export const PG_PORT = '55432'
export const DB_NAMES = new Set(['fju_tutorial', 'fju_tutorial_1', 'fju_tutorial_2', 'fju_tutorial_3', 'fju_tutorial_4'])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export class SafetyError extends Error {}

/** `INSTANCE` → 這個實例的資料庫名、app port、檔案子目錄名。只接受 0～4。 */
export function instanceOf(value) {
  const raw = value === undefined || value === '' ? '0' : String(value)
  if (!/^[0-4]$/.test(raw)) throw new SafetyError(`INSTANCE 只能是 0～4（收到「${raw}」）。`)
  const n = Number(raw)
  return { n, dbName: n === 0 ? 'fju_tutorial' : `fju_tutorial_${n}`, port: 3300 + n }
}

/** 資料庫名只能是 fju_tutorial 或 fju_tutorial_1～4；給了 expected 就還要等於它。 */
export function checkDbName(name, expected) {
  if (!DB_NAMES.has(name)) {
    throw new SafetyError(`資料庫名只能是 fju_tutorial 或 fju_tutorial_1～fju_tutorial_4（收到「${name}」）；免得刪到別的庫。`)
  }
  if (expected !== undefined && name !== expected) throw new SafetyError(`這個實例的資料庫是 ${expected}，不是「${name}」。`)
  return name
}

/**
 * 用 pg 實際會用的解析器（pg-connection-string）拆連線字串，再驗目的地。
 * `parse` 由呼叫端注入，測試不需要 web 的 node_modules。
 */
export function checkPgUrl(url, parse, expectedDb) {
  if (!url) throw new SafetyError('缺少資料庫連線字串。')
  let u
  try {
    u = new URL(url)
  } catch {
    throw new SafetyError('資料庫連線字串不是合法網址。')
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new SafetyError('資料庫連線字串要是 postgres://。')
  // 查詢參數（host=、hostaddr=、port=、dbname=、service=、options=…）可以蓋掉網址本身的目的地，一律不收。
  if (u.search) throw new SafetyError('資料庫連線字串不可帶查詢參數（例如 ?host= 會改寫連線目的地）。')
  const target = parse(url)
  if (!target.host || !LOOPBACK.has(target.host)) throw new SafetyError(`資料庫只能連本機（localhost／127.0.0.1／::1），這次是「${target.host ?? '沒寫'}」。`)
  if (String(target.port) !== PG_PORT) throw new SafetyError(`資料庫 port 只能是 ${PG_PORT}（本機 Compose 的 postgres），這次是「${target.port ?? '沒寫'}」。`)
  checkDbName(target.database, expectedDb)
  return { host: target.host, port: String(target.port), database: target.database }
}

/** 不存在的路徑：找最近一個存在的上層做 realpath，再接回剩下的部分。 */
function realpathLoose(p, fsImpl) {
  const abs = path.resolve(p)
  let head = abs
  const tail = []
  while (!fsImpl.existsSync(head)) {
    const parent = path.dirname(head)
    if (parent === head) break
    tail.unshift(path.basename(head))
    head = parent
  }
  return path.join(fsImpl.realpathSync(head), ...tail)
}

/**
 * FILES_ROOT 正規化後必須是 `<home>/work/tutorial-files/<n>` 或它底下。回傳正規化後的路徑。
 *
 * 邊界是固定的：HOME 本身先 realpath（HOME 是符號連結沒關係），之後 work、tutorial-files、<n> 三層
 * 每一層只要存在就必須是真的目錄，不能是符號連結——否則 `tutorial-files/0 → 1` 或 `→ $HOME` 這種連結會讓
 * 邊界本身跟著跑到別的實例或 HOME，realpath 比對就形同虛設。
 */
export function checkFilesDir(dir, home, n, fsImpl = fs) {
  if (!dir) throw new SafetyError('FILES_ROOT 是空的。')
  if (!Number.isInteger(n)) throw new SafetyError('checkFilesDir 要知道是哪個實例。')
  let root
  try {
    root = fsImpl.realpathSync(home)
  } catch {
    throw new SafetyError(`HOME（${home}）不存在，算不出教學檔案目錄的邊界。`)
  }
  for (const part of ['work', 'tutorial-files', String(n)]) {
    root = path.join(root, part)
    let st
    try {
      st = fsImpl.lstatSync(root)
    } catch {
      continue // 還沒建：之後 mkdir -p 會建成真的目錄
    }
    if (st.isSymbolicLink()) throw new SafetyError(`${root} 是符號連結；教學檔案目錄的每一層都必須是真的目錄（reset 會清空它，不能讓它指到別處）。`)
    if (!st.isDirectory()) throw new SafetyError(`${root} 不是目錄。`)
  }
  const real = realpathLoose(dir, fsImpl)
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new SafetyError(`FILES_ROOT 只能是 ${root} 或它底下的目錄（「${dir}」正規化後是 ${real}）；reset 會清空它。`)
  }
  return real
}

/** Docker 只走本機 unix socket。回傳 `docker -H` 要用的 endpoint。 */
export function checkDocker(env, fsImpl = fs) {
  const dockerHost = env.DOCKER_HOST
  if (dockerHost && !dockerHost.startsWith('unix://')) {
    throw new SafetyError(`DOCKER_HOST=${dockerHost} 不是本機 unix socket，拒絕執行（教學環境只操作本機的 postgres 容器）。`)
  }
  const sock = env.TUTORIAL_DOCKER_SOCK ?? path.join(env.HOME ?? os.homedir(), '.colima', 'default', 'docker.sock')
  if (!path.isAbsolute(sock)) throw new SafetyError(`TUTORIAL_DOCKER_SOCK 要是絕對路徑（收到「${sock}」）。`)
  let st
  try {
    st = fsImpl.statSync(sock)
  } catch {
    throw new SafetyError(`找不到本機 Docker socket ${sock}（用 TUTORIAL_DOCKER_SOCK 指定本機的 socket 路徑）。`)
  }
  if (!st.isSocket()) throw new SafetyError(`${sock} 不是 unix socket。`)
  return `unix://${sock}`
}

/**
 * 帳號設定檔的文字 → 物件。JSON.parse 的錯誤訊息會引用出錯位置附近的原文（可能正好是密碼），
 * 所以這裡吞掉它，只回報檔名＋「格式錯誤」。
 */
export function parseAccountsFile(text, file) {
  try {
    return JSON.parse(text)
  } catch {
    throw new SafetyError(`${file} 格式錯誤（不是合法的 JSON；用 JSON 檢查工具看，這裡不印內容）。`)
  }
}

/** 設定檔每一筆的檢查：錯誤只列索引與缺的欄位，不印整筆（裡面有密碼）。 */
export function validateAccounts(config) {
  if (!config || !Array.isArray(config.accounts)) throw new SafetyError('設定檔要有 accounts 陣列。')
  config.accounts.forEach((a, i) => {
    const missing = []
    if (!a || typeof a !== 'object') throw new SafetyError(`accounts[${i}] 不是物件。`)
    if (!a.role) missing.push('role')
    if (!a.name && !a.email) missing.push('name 或 email')
    if (a.create === 'admin') {
      if (!a.name) missing.push('name（create: admin 要寫）')
      if (!a.email) missing.push('email（create: admin 要寫）')
    }
    if (missing.length > 0) throw new SafetyError(`accounts[${i}] 缺少欄位：${[...new Set(missing)].join('、')}`)
  })
  return config.accounts
}

// ── 程序身分 ───────────────────────────────────────────────────────────────

const KIND_PATTERNS = {
  app: [/next-server/, /next\/dist\/bin\/next start --port \d+/],
  worker: [/node dist\/worker\.mjs/],
}

/** 讀真實程序的身分；測試會注入假的。 */
export function probeProcess(pid) {
  try {
    const ps = execFileSync('ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim()
    const m = ps.match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/)
    if (!m) return null
    const lsof = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
    const cwd = lsof.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null
    return { pgid: m[1], lstart: m[2].replace(/\s+/g, ' '), command: m[3], cwd }
  } catch {
    return null
  }
}

export function recordProcess(kind, pid, expectedCwd, probe = probeProcess) {
  if (!KIND_PATTERNS[kind]) throw new SafetyError(`不認得的程序種類 ${kind}`)
  const p = probe(pid)
  if (!p) throw new SafetyError(`程序 ${pid} 剛起來就不見了`)
  if (p.cwd !== expectedCwd) throw new SafetyError(`程序 ${pid} 的工作目錄是 ${p.cwd}，不是 ${expectedCwd}`)
  return { kind, pid: String(pid), pgid: p.pgid, lstart: p.lstart, cwd: expectedCwd }
}

/** pid 檔記的程序還在、而且啟動時間、工作目錄、種類、PGID 都對得上，才算是我們的。回傳不符的原因（null＝相符）。 */
export function mismatch(meta, probe = probeProcess) {
  if (!meta || !meta.pid || !KIND_PATTERNS[meta.kind]) return 'pid 檔內容不完整'
  const p = probe(meta.pid)
  if (!p) return `程序 ${meta.pid} 已不存在`
  if (p.lstart !== meta.lstart) return `程序 ${meta.pid} 的啟動時間不同（pid 被別的程序重用了）`
  if (p.pgid !== meta.pgid || meta.pgid !== meta.pid) return `程序 ${meta.pid} 的 PGID 不同`
  if (p.cwd !== meta.cwd) return `程序 ${meta.pid} 的工作目錄不同`
  if (!KIND_PATTERNS[meta.kind].some((re) => re.test(p.command))) return `程序 ${meta.pid} 不是 ${meta.kind}`
  return null
}

// ── CLI ───────────────────────────────────────────────────────────────────

/**
 * web 的依賴（pg、better-auth）從哪一份 checkout 拿：TUTORIAL_REPO（lib.sh 設成網站 checkout）→ ~/work/tutorial-site
 * → 這支腳本所在的 repo，取第一個裝好依賴的。網站 checkout 還沒建（第一次 up.sh）時退回腳本所在的 repo。
 */
export function webDir(env = process.env) {
  const candidates = [env.TUTORIAL_REPO, path.join(env.HOME ?? os.homedir(), 'work', 'tutorial-site'), path.join(import.meta.dirname, '..', '..', '..')]
  for (const c of candidates) if (c && fs.existsSync(path.join(c, 'web', 'node_modules', 'pg'))) return path.join(c, 'web')
  throw new SafetyError('找不到裝好依賴的 web（先在 repo 根跑 pnpm install）。')
}

function loadPgParse() {
  const requireWeb = createRequire(path.join(webDir(), 'package.json'))
  const requirePg = createRequire(requireWeb.resolve('pg'))
  return requirePg('pg-connection-string').parse
}

/** 給 accounts.mjs 與 check-env 共用：驗完回傳正規化後的值。 */
export function checkEnv(env = process.env) {
  const inst = instanceOf(env.INSTANCE)
  if (env.TUTORIAL_DB !== undefined) checkDbName(env.TUTORIAL_DB, inst.dbName)
  const parse = loadPgParse()
  for (const key of ['DATABASE_URL_OWNER', 'DATABASE_URL']) if (env[key] !== undefined) checkPgUrl(env[key], parse, inst.dbName)
  const out = { INSTANCE: String(inst.n), DB_NAME: inst.dbName, PORT: String(inst.port) }
  if (env.FILES_ROOT !== undefined) out.FILES_ROOT = checkFilesDir(env.FILES_ROOT, env.HOME ?? os.homedir(), inst.n)
  if (env.TUTORIAL_CHECK_DOCKER === '1') out.DOCKER_ENDPOINT = checkDocker(env)
  return out
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'check-env') {
    const out = checkEnv()
    for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`)
  } else if (cmd === 'proc-record') {
    const [kind, pid, file, cwd] = rest
    const meta = recordProcess(kind, pid, fs.realpathSync(cwd))
    fs.writeFileSync(file, `${JSON.stringify(meta)}\n`)
  } else if (cmd === 'proc-check') {
    const [kind, file] = rest
    let meta = null
    try {
      meta = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {}
    const why = meta && meta.kind !== kind ? 'pid 檔的程序種類不對' : mismatch(meta)
    if (why) {
      if (process.env.TUTORIAL_VERBOSE === '1') console.error(why)
      process.exit(1)
    }
  } else {
    console.error('用法：safety.mjs check-env | proc-record <kind> <pid> <file> <cwd> | proc-check <kind> <file>')
    process.exit(2)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    main()
  } catch (error) {
    console.error(`[tutorial-env] 拒絕執行：${error.message}`)
    process.exit(1)
  }
}
