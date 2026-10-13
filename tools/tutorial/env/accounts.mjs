#!/usr/bin/env node
/**
 * 教學影片的示範帳號：照設定檔替指定的人設本機密碼、讓他們直接登入（不用先改密碼）。
 *
 *   [INSTANCE=n] node tools/tutorial/env/accounts.mjs apply              照設定檔設密碼（up.sh、reset.sh 會自動跑）
 *   [INSTANCE=n] node tools/tutorial/env/accounts.mjs list [--passwords]  印「角色／示範名稱／登入帳號」對照（加 --passwords 連密碼一起印）
 *   [INSTANCE=n] node tools/tutorial/env/accounts.mjs check               每個帳號真的登入一次，確認進得了自己的首頁、看得到自己的名字
 *
 * INSTANCE=0～4（沒設＝0）：實例 n 連 fju_tutorial（0）或 fju_tutorial_<n>、網站 port 3300+n。
 * 設定檔：實例 0 是 ~/work/tutorial-secrets/accounts.json，實例 n 是 accounts-<n>.json，權限 600，不進 repo。
 * 實例 n 的設定檔沒有時從實例 0 那份複製（帳號密碼跟實例 0 一樣）；實例 0 的沒有時從同目錄的 accounts.default.json 複製；沒寫 password 的人自動產生隨機密碼並寫回。
 * 要加人：在 accounts 陣列加一筆 { "role": "...", "name": "示範名稱" }（或用 "email" 指定），再跑 apply。
 *
 * 只動本機的教學資料庫（DATABASE_URL_OWNER，預設 fju_tutorial）。示範帳號原本沒有密碼（seed-demo 刻意的），
 * 這裡補一列 credential account；系辦（create: admin）示範資料裡沒有，這裡照 seed-a1 的樣子建一個。
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkDbName, checkPgUrl, instanceOf, parseAccountsFile, validateAccounts, webDir } from './safety.mjs'

const HERE = import.meta.dirname
const WEB_DIR = webDir()
// 沒有自己的 package.json：套件借 web 現有的依賴。
const requireWeb = createRequire(path.join(WEB_DIR, 'package.json'))
const { Pool } = requireWeb('pg')
const { uuidv7 } = requireWeb('uuidv7')
const { hashPassword } = await import(pathToFileURL(requireWeb.resolve('better-auth/crypto')).href)

const [command = 'list', ...flags] = process.argv.slice(2)

let INSTANCE, BASE_URL, DB_URL
// 任何副作用（建設定檔、連資料庫）之前：確認實例、照 pg 實際的解析結果確認只連本機這個實例的教學庫（這支會改密碼）。
try {
  INSTANCE = instanceOf(process.env.INSTANCE)
  BASE_URL = `http://localhost:${INSTANCE.port}`
  DB_URL = process.env.DATABASE_URL_OWNER ?? `postgres://fju_owner:fju_local_dev@127.0.0.1:55432/${INSTANCE.dbName}`
  if (process.env.TUTORIAL_DB !== undefined) checkDbName(process.env.TUTORIAL_DB, INSTANCE.dbName)
  checkPgUrl(DB_URL, requireWeb(createRequire(requireWeb.resolve('pg')).resolve('pg-connection-string')).parse, INSTANCE.dbName)
} catch (error) {
  console.error(`[tutorial-env] 拒絕執行：${error.message}`)
  process.exit(1)
}

const SECRETS_DIR = process.env.TUTORIAL_SECRETS_DIR ?? path.join(os.homedir(), 'work', 'tutorial-secrets')
const CONFIG_0 = path.join(SECRETS_DIR, 'accounts.json')
const CONFIG = INSTANCE.n === 0 ? CONFIG_0 : path.join(SECRETS_DIR, `accounts-${INSTANCE.n}.json`)
const DEFAULTS = path.join(HERE, 'accounts.default.json')

function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 })
    const source = CONFIG !== CONFIG_0 && fs.existsSync(CONFIG_0) ? CONFIG_0 : DEFAULTS
    fs.copyFileSync(source, CONFIG)
    console.log(`第一次使用：從 ${path.basename(source)} 建立 ${CONFIG}`)
  }
  fs.chmodSync(CONFIG, 0o600)
  // 格式錯誤只印檔名，不印 JSON.parse 引用的原文（裡面有密碼）。
  const config = parseAccountsFile(fs.readFileSync(CONFIG, 'utf8'), CONFIG)
  validateAccounts(config)
  let changed = false
  for (const a of config.accounts) {
    if (!a.password) {
      // 16 個字元以上、好唸好打：Demo- 開頭＋隨機字母數字。
      a.password = `Demo-${randomBytes(12).toString('base64url').replace(/[-_]/g, 'x')}`
      changed = true
    }
  }
  if (changed) fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return config.accounts
}

/** 用 name 或 email 找出示範帳號；必須剛好一個（停用的不算）。 */
async function findUser(db, a, i) {
  const { rows } = await db.query(
    `select u.id, u.email, u.status, coalesce(p.display_name, u.name) as name
       from users u left join user_profiles p on p.user_id = u.id
      where u.status <> 'disabled' and ${a.email ? 'u.email = $1' : 'coalesce(p.display_name, u.name) = $1'}`,
    [a.email ?? a.name],
  )
  if (rows.length === 1) return rows[0]
  throw new Error(`accounts[${i}]（${a.role}）${rows.length === 0 ? '找不到對應的帳號（是不是名字打錯、或還沒跑 seed-demo？）' : `對到 ${rows.length} 個帳號，請改用 email 指定`}`)
}

async function createAdmin(db, a) {
  const found = await db.query('select id from users where email = $1', [a.email])
  if (found.rowCount > 0) return
  const id = uuidv7()
  await db.query(
    `insert into users (id, name, email, email_verified, created_at, updated_at, role, banned, status, must_change_password)
     values ($1, $2, $3, true, now(), now(), 'admin', false, 'active', false)`,
    [id, a.name, a.email],
  )
  await db.query(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
     values ($1, $2, 'admin', $2, now(), 'tutorial（教學影片本機環境的系辦帳號）')`,
    [uuidv7(), id],
  )
  await db.query(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email, profile_completed_at)
     values ($1, $2, $3, $4, now())`,
    [id, a.name, a.name.trim(), a.email],
  )
}

async function setPassword(db, user, password) {
  const hash = await hashPassword(password)
  const updated = await db.query(
    `update accounts set password = $2, updated_at = now() where user_id = $1 and provider_id = 'credential'`,
    [user.id, hash],
  )
  if (updated.rowCount === 0) {
    // 同 seed-a1：credential provider 的 account_id 就是 user id（text），user_id 是 uuid，要分兩個參數。
    await db.query(
      `insert into accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values ($1, $2, 'credential', $3, $4, now(), now())`,
      [uuidv7(), user.id, user.id, hash],
    )
  }
  await db.query('update users set must_change_password = false, updated_at = now() where id = $1', [user.id])
}

async function withDb(fn) {
  const pool = new Pool({ connectionString: DB_URL, max: 1 })
  try {
    return await fn(pool)
  } finally {
    await pool.end()
  }
}

async function resolveAll(db, accounts) {
  const out = []
  for (const [i, a] of accounts.entries()) out.push({ ...a, user: await findUser(db, a, i) })
  return out
}

/** 跟 composition/accounts.ts 的 homeForUser 同一個順序。 */
async function homeOf(db, userId) {
  const { rows } = await db.query('select role from role_assignments where user_id = $1 and revoked_real_at is null', [userId])
  const roles = rows.map((r) => r.role)
  if (roles.includes('admin')) return '/dashboard/admin'
  if (roles.includes('teacher')) return '/dashboard/teacher'
  if (roles.includes('student')) return '/dashboard/student'
  return '/register/pending'
}

function printTable(rows, withPasswords) {
  const header = ['角色', '示範名稱', '登入帳號', ...(withPasswords ? ['密碼'] : [])]
  const lines = rows.map((r) => [r.role, r.user.name, r.user.email, ...(withPasswords ? [r.password] : [])])
  const width = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  const cols = header.map((_, i) => Math.max(width(header[i]), ...lines.map((l) => width(l[i]))))
  const fmt = (l) => l.map((c, i) => String(c) + ' '.repeat(cols[i] - width(c))).join('  ')
  console.log(fmt(header))
  for (const l of lines) console.log(fmt(l))
  if (!withPasswords) console.log(`（密碼在 ${CONFIG}；要一起印用 list --passwords）`)
}

async function apply() {
  const accounts = loadConfig()
  await withDb(async (db) => {
    await db.query('begin')
    try {
      for (const a of accounts) if (a.create === 'admin') await createAdmin(db, a)
      for (const r of await resolveAll(db, accounts)) await setPassword(db, r.user, r.password)
      await db.query('commit')
    } catch (error) {
      await db.query('rollback')
      throw error
    }
  })
  console.log(`已設定 ${accounts.length} 個教學帳號的本機密碼。`)
}

async function list() {
  const accounts = loadConfig()
  const rows = await withDb((db) => resolveAll(db, accounts))
  printTable(rows, flags.includes('--passwords'))
}

/** 真的走登入 API 拿 session cookie，再開自己的首頁：200、而且頁面上有自己的名字才算過。 */
async function check() {
  const accounts = loadConfig()
  const rows = await withDb(async (db) => {
    const resolved = await resolveAll(db, accounts)
    for (const r of resolved) r.home = await homeOf(db, r.user.id)
    return resolved
  })
  let failed = 0
  for (const r of rows) {
    const signIn = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ email: r.user.email, password: r.password }),
    })
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    let verdict
    if (!signIn.ok || !cookie) {
      verdict = `登入失敗（${signIn.status}）`
    } else {
      const page = await fetch(`${BASE_URL}${r.home}`, { headers: { cookie }, redirect: 'manual' })
      const html = page.status === 200 ? await page.text() : ''
      verdict =
        page.status !== 200
          ? `${r.home} 回 ${page.status}${page.headers.get('location') ? ` → ${page.headers.get('location')}` : ''}`
          : html.includes(r.user.name)
            ? 'OK'
            : `${r.home} 200 但頁面上找不到「${r.user.name}」`
    }
    if (verdict !== 'OK') failed += 1
    console.log(`${verdict === 'OK' ? '✓' : '✗'} ${r.role}／${r.user.name}：${verdict === 'OK' ? `${r.home} 200，看得到名字` : verdict}`)
  }
  if (failed > 0) {
    console.error(`${failed} 個帳號沒通過。`)
    process.exit(1)
  }
}

const commands = { apply, list, check }
if (!commands[command]) {
  console.error(`不認得的指令：${command}。用法：accounts.mjs apply | list [--passwords] | check`)
  process.exit(1)
}
try {
  await commands[command]()
} catch (error) {
  console.error(`accounts.mjs ${command} 失敗：${error.message}`)
  process.exit(1)
}
