#!/usr/bin/env node
/**
 * 效能量測帳號（共用 SH-0，設計方案 §7.4.1 第 4 步）。
 *
 *   PERF_PASSWORD=… DATABASE_URL_OWNER=… node scripts/perf/accounts.mjs setup
 *   PERF_PASSWORD=… node scripts/perf/accounts.mjs check --base http://localhost:3399
 *
 * setup（owner 連線，寫法照 seed-e2e.mjs）：
 *   - 示範帳號（`@demo.invalid`）沒有密碼、登不進來，所以給學生、老師各加一列 credential 密碼；
 *   - 另建 `perf-admin@perf.invalid`（active、角色 admin）；
 *   - 三個都 `must_change_password=false`、`status=active`；老師補 `profile_completed_at`（否則 needsSetup 導去補資料）；
 *   - 示範屆別 DEMO-114 設成預設工作屆別（seed 建的是 false）。
 * check：三個帳號各自 `/api/auth/sign-in/email` 登入，用自己的 cookie GET 自己的首頁，必須 200（不跟隨轉址）。
 *
 * 密碼取 `PERF_PASSWORD`，不寫進檔案、不印出。也給 sql／lab／trail 匯入 `signIn`、`resolveAs`。
 */
/* global fetch, URL */
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { uuidv7 } from 'uuidv7'
import { hashPassword } from 'better-auth/crypto'
import { fail, ownerUrl, parseArgs, perfPassword } from './db.mjs'

export const PERF_ACCOUNTS = {
  student: { email: '411410123@demo.invalid', home: '/dashboard/student' },
  teacher: { email: 'chen.ch@demo.invalid', home: '/dashboard/teacher' },
  admin: { email: 'perf-admin@perf.invalid', home: '/dashboard/admin' },
}
const ADMIN_NAME = '效能量測管理員'
const DEMO_COHORT_CODE = 'DEMO-114'

/** `--as` → `{ label, email|null }`。role 名取固定帳號；含 `@` 的當 email；`anonymous` 不登入。 */
export function resolveAs(as) {
  if (!as) fail('缺少 --as student|teacher|admin|anonymous|<email>')
  if (as === 'anonymous') return { label: as, email: null }
  if (PERF_ACCOUNTS[as]) return { label: as, email: PERF_ACCOUNTS[as].email }
  if (as.includes('@')) return { label: as, email: as }
  return fail(`--as 不認得「${as}」`)
}

/** 登入取 cookie 字串（`a=b; c=d`）。email 為 null 時回空字串（匿名）。 */
export async function signIn(base, email) {
  if (!email) return ''
  const res = await fetch(new URL('/api/auth/sign-in/email', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(base).origin },
    body: JSON.stringify({ email, password: perfPassword() }),
    redirect: 'manual',
  })
  if (res.status !== 200) fail(`${email} 登入失敗（HTTP ${res.status}）。量測庫是用同一個 PERF_PASSWORD 建的嗎？`)
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0])
  if (cookies.length === 0) fail(`${email} 登入沒有拿到 cookie。`)
  return cookies.join('; ')
}

async function setPassword(client, userId, hash) {
  const found = await client.query(`select id from accounts where user_id = $1 and provider_id = 'credential'`, [userId])
  if (found.rowCount > 0) {
    await client.query(`update accounts set password = $2, updated_at = now() where id = $1`, [found.rows[0].id, hash])
  } else {
    await client.query(
      `insert into accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values ($1, $2, 'credential', $3, $4, now(), now())`,
      [uuidv7(), userId, userId, hash],
    )
  }
}

async function setup() {
  const hash = await hashPassword(perfPassword())
  const pool = new Pool({ connectionString: ownerUrl(), max: 1 })
  const client = await pool.connect()
  try {
    await client.query('begin')
    for (const role of ['student', 'teacher']) {
      const { email } = PERF_ACCOUNTS[role]
      const u = await client.query('select id from users where email = $1', [email])
      if (u.rowCount === 0) throw new Error(`找不到示範帳號 ${email}（seed-demo 跑過了嗎？）`)
      const id = u.rows[0].id
      await client.query(`update users set status = 'active', must_change_password = false, banned = false where id = $1`, [id])
      await setPassword(client, id, hash)
      if (role === 'teacher') {
        await client.query(`update user_profiles set profile_completed_at = coalesce(profile_completed_at, now()) where user_id = $1`, [id])
      }
    }

    const { email } = PERF_ACCOUNTS.admin
    let adminId = (await client.query('select id from users where email = $1', [email])).rows[0]?.id
    if (!adminId) {
      adminId = uuidv7()
      await client.query(
        `insert into users (id, name, email, email_verified, created_at, updated_at, role, banned, status, must_change_password)
         values ($1, $2, $3, true, now(), now(), 'admin', false, 'active', false)`,
        [adminId, ADMIN_NAME, email],
      )
      await client.query(
        `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
         values ($1, $2, 'admin', $2, now(), 'perf:db（隔離量測庫的量測帳號）')`,
        [uuidv7(), adminId],
      )
      await client.query(
        `insert into user_profiles (user_id, display_name, name_normalized, contact_email, profile_completed_at)
         values ($1, $2, $2, $3, now())`,
        [adminId, ADMIN_NAME, email],
      )
    } else {
      await client.query(`update users set status = 'active', must_change_password = false, banned = false where id = $1`, [adminId])
    }
    await setPassword(client, adminId, hash)

    const cohort = await client.query(`update cohorts set is_default_working = (code = $1) returning code, is_default_working`, [DEMO_COHORT_CODE])
    if (!cohort.rows.some((r) => r.code === DEMO_COHORT_CODE && r.is_default_working)) throw new Error(`找不到屆別 ${DEMO_COHORT_CODE}`)
    await client.query('commit')
    console.log(`量測帳號就緒：${Object.values(PERF_ACCOUNTS).map((a) => a.email).join('、')}；${DEMO_COHORT_CODE} 是預設屆別。`)
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

async function check(base) {
  let bad = 0
  for (const [role, { email, home }] of Object.entries(PERF_ACCOUNTS)) {
    const cookie = await signIn(base, email)
    const res = await fetch(new URL(home, base), { headers: { cookie }, redirect: 'manual' })
    const where = res.headers.get('location')
    console.log(`${role.padEnd(8)} ${email.padEnd(26)} GET ${home} → ${res.status}${where ? ` → ${where}` : ''}`)
    if (res.status !== 200) bad++
  }
  if (bad > 0) fail(`${bad} 個帳號的首頁不是 200。`)
  console.log('三個量測帳號都能登入，首頁都是 200。')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseArgs(process.argv.slice(2))
  if (opts._[0] === 'setup') await setup()
  else if (opts._[0] === 'check' && opts.base) await check(opts.base)
  else fail('用法：accounts.mjs setup | check --base <url>')
}
