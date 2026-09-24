#!/usr/bin/env node
/**
 * 建立測試站專用的 E2E 測試管理員（票 3b，#244）。
 *
 *   FJU_SITE=test E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... DATABASE_URL_OWNER=... pnpm -C web seed:e2e
 *
 * 給 Codex（Playwright）在測試站 test.fju.roy422.dev 自動驗收用。ops/deploy.sh 在
 * `--site test` 且 Doppler stg 有這兩個鍵時，migration 成功後自動跑它。
 *
 * **正式站永遠不建**：只有 `FJU_SITE=test` 才會動手，其他值（含 prod、空的）一律拒絕，
 * 而且在連資料庫之前就擋下。deploy.sh 那一層也只在 test 站呼叫——兩道鎖。
 *
 * 值只從環境變數來，**不寫進任何檔案、不印在終端機**（連 email 也不印）。
 *
 * 跟 A1（seed-a1.mjs）一樣直接寫資料庫、密碼用 Better Auth 的 `hashPassword`，差別：
 *   - `must_change_password = false`：自動驗收要能直接登入，不能卡在改密頁。
 *   - 名稱固定「E2E 測試管理員」，稽核 action 是 `account.seed_e2e_admin`，一看就知道是測試帳號。
 *   - 密碼至少 16 個字元（它不會被逼著改掉，所以要一開始就夠長）。
 *   - 已存在（同一個 email）就什麼都不做：不改密碼、不改角色、不改狀態。
 */
import { Pool } from 'pg'
import { uuidv7 } from 'uuidv7'
import { hashPassword } from 'better-auth/crypto'

const DISPLAY_NAME = 'E2E 測試管理員'
const MIN_PASSWORD_LENGTH = 16

const site = process.env.FJU_SITE
const email = process.env.E2E_ADMIN_EMAIL
const password = process.env.E2E_ADMIN_PASSWORD
const url = process.env.DATABASE_URL_OWNER

// 第一件事就檢查站台：不是 test 就不往下走，連資料庫都不連。
if (site !== 'test') {
  console.error(`E2E 測試管理員只建在測試站（FJU_SITE=test）；這次是「${site ?? '沒設定'}」，拒絕執行。`)
  process.exit(1)
}
if (!url) {
  console.error('缺少 DATABASE_URL_OWNER（建帳號要用 owner 連線）。')
  process.exit(1)
}
if (!email || !password) {
  console.error('缺少 E2E_ADMIN_EMAIL 或 E2E_ADMIN_PASSWORD。值放在 Doppler stg，不寫進檔案。')
  process.exit(1)
}
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`E2E_ADMIN_PASSWORD 至少 ${MIN_PASSWORD_LENGTH} 個字元。`)
  process.exit(1)
}

const pool = new Pool({ connectionString: url, max: 1 })
const client = await pool.connect()
try {
  await client.query('begin')

  const existing = await client.query('select id, name, status from users where email = $1', [email])
  if (existing.rowCount > 0) {
    await client.query('rollback')
    const row = existing.rows[0]
    const note = row.name === DISPLAY_NAME ? '' : '（注意：這個 email 的帳號不是 E2E 測試管理員，請換一個 E2E_ADMIN_EMAIL）'
    console.log(`E2E 測試管理員已存在（status=${row.status}），不做任何事。${note}`)
    process.exit(0)
  }

  const userId = uuidv7()
  await client.query(
    `insert into users (id, name, email, email_verified, created_at, updated_at, role, banned, status, must_change_password)
     values ($1, $2, $3, true, now(), now(), 'admin', false, 'active', false)`,
    [userId, DISPLAY_NAME, email],
  )
  await client.query(
    `insert into accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
     values ($1, $2, 'credential', $3, $4, now(), now())`,
    // 同 seed-a1：account_id（text）與 user_id（uuid）是同一個值，但要分成兩個參數。
    [uuidv7(), userId, userId, await hashPassword(password)],
  )
  await client.query(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
     values ($1, $2, 'admin', $2, now(), 'seed:e2e（測試站自動驗收用的測試管理員，正式站不建）')`,
    [uuidv7(), userId],
  )
  await client.query(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email)
     values ($1, $2, lower($3), $4)`,
    [userId, DISPLAY_NAME, DISPLAY_NAME, email],
  )
  // 稽核：部署腳本（system）在測試站建了測試管理員。
  await client.query(
    `insert into audit_events (id, actor_kind, action, target_type, target_id, scope, real_at, business_at, payload)
     values ($1, 'system', 'account.seed_e2e_admin', 'user', $2, 'global', now(), now(), '{"source":"seed:e2e","site":"test"}'::jsonb)`,
    [uuidv7(), userId],
  )

  await client.query('commit')
  console.log('E2E 測試管理員已建立：status=active、must_change_password=false、角色 admin（只在測試站）。')
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  client.release()
  await pool.end()
}
