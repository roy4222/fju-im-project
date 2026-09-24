#!/usr/bin/env node
/**
 * 建立第一位管理員 A1（S01-05；劇本 P00 步驟 3）。
 *
 *   A1_EMAIL=... A1_INITIAL_PASSWORD=... DATABASE_URL_OWNER=... pnpm -C web seed:a1
 *
 * 值只從環境變數來，**不寫進任何檔案、不印在終端機**。腳本只回報「建好了／已存在」。
 *
 * 為什麼不走 `auth.api.createUser`：admin plugin 的每個 `/admin/*` 端點都要求呼叫端帶著
 * 一個 role 是 admin 的 session（契約 03 §2 的 2026-09-15 補充）。系統上線時一個管理員都
 * 沒有，這是先有雞還是先有蛋。所以 A1 直接寫資料庫，密碼用 Better Auth 自己的 `hashPassword`
 * 產生，格式與套件一致（登入時用 `verifyPassword` 驗得過）。
 *
 * 建出來的 A1：
 *   - `users.status = 'active'`、`must_change_password = true`（第一件事就是被逼改密）
 *   - `users.role = 'admin'`（admin plugin 的套件欄，讓 internalAuth 的五個能力用得起來）
 *   - `role_assignments` 一列 admin（業務角色的唯一來源）
 *   - `user_profiles` 一列（顯示名稱與聯絡 Email）
 */
import { Pool } from 'pg'
import { uuidv7 } from 'uuidv7'
import { hashPassword } from 'better-auth/crypto'

const email = process.env.A1_EMAIL
const password = process.env.A1_INITIAL_PASSWORD
const displayName = process.env.A1_NAME ?? '系辦管理員'
const url = process.env.DATABASE_URL_OWNER

if (!url) {
  console.error('缺少 DATABASE_URL_OWNER（建帳號要用 owner 連線）。')
  process.exit(1)
}
if (!email || !password) {
  console.error('缺少 A1_EMAIL 或 A1_INITIAL_PASSWORD。值由維運從密碼管理器帶入，不寫進檔案。')
  process.exit(1)
}
if (password.length < 12) {
  console.error('一次性密碼至少 12 個字元。')
  process.exit(1)
}

const pool = new Pool({ connectionString: url, max: 1 })
const client = await pool.connect()
try {
  await client.query('begin')

  const existing = await client.query('select id, status, must_change_password from users where email = $1', [email])
  if (existing.rowCount > 0) {
    await client.query('rollback')
    const row = existing.rows[0]
    console.log(`A1 已存在（status=${row.status}、must_change_password=${row.must_change_password}），不做任何事。`)
    console.log('要重發一次性密碼請走系辦的「臨時密碼」功能（S01-12），不要重跑 seed。')
    process.exit(0)
  }

  const userId = uuidv7()
  await client.query(
    `insert into users (id, name, email, email_verified, created_at, updated_at, role, banned, status, must_change_password)
     values ($1, $2, $3, true, now(), now(), 'admin', false, 'active', true)`,
    [userId, displayName, email],
  )
  await client.query(
    `insert into accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
     values ($1, $2, 'credential', $3, $4, now(), now())`,
    // Better Auth 的 credential provider 用 user id 當 account_id（text 欄），所以同一個值傳兩次：
    // 一次當文字、一次當 uuid，不能共用同一個參數（PostgreSQL 推不出型別）。
    [uuidv7(), userId, userId, await hashPassword(password)],
  )
  await client.query(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
     values ($1, $2, 'admin', $2, now(), 'seed:a1（系統上線時的第一位管理員）')`,
    [uuidv7(), userId],
  )
  await client.query(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email)
     values ($1, $2, lower($3), $4)`,
    [userId, displayName, displayName, email],
  )
  // 稽核：誰在什麼時候建了第一個管理員。actor 是 system——那時候還沒有人可以當 actor。
  await client.query(
    `insert into audit_events (id, actor_kind, action, target_type, target_id, scope, real_at, business_at, payload)
     values ($1, 'system', 'account.seed_first_admin', 'user', $2, 'global', now(), now(), '{"source":"seed:a1"}'::jsonb)`,
    [uuidv7(), userId],
  )

  await client.query('commit')
  console.log('A1 已建立：status=active、must_change_password=true、角色 admin。')
  console.log('第一次登入會被帶到改密頁；改完密碼之後這組一次性密碼就失效。')
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  client.release()
  await pool.end()
}
