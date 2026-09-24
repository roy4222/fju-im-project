import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { verifyPassword } from 'better-auth/crypto'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../db'
import { migratedSchema } from '../migrations'

/**
 * 票 3b（#244）：web/scripts/seed-e2e.mjs 在真的資料庫上建 E2E 測試管理員。
 *
 * 真的跑腳本（子程序、值只從環境變數進去），每一步回資料庫核對：
 * 建出來的樣子、重跑不改密碼（冪等）、正式站拒絕、密碼太短拒絕、輸出不含秘密。
 */

const webRoot = path.join(import.meta.dirname, '..', '..')
const E2E_EMAIL = 'e2e-admin@example.test'
const E2E_PASSWORD = 'E2E-Password-For-Tests-2026'

let db: IsolatedDatabase
let schemaUrl: string

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'seed-e2e', setup: migratedSchema })
  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)
  schemaUrl = url.toString()
})

afterAll(async () => {
  await db?.close()
})

function runSeed(env: Record<string, string | undefined> = {}) {
  const result = spawnSync('node', ['scripts/seed-e2e.mjs'], {
    cwd: webRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL_OWNER: schemaUrl,
      FJU_SITE: 'test',
      E2E_ADMIN_EMAIL: E2E_EMAIL,
      E2E_ADMIN_PASSWORD: E2E_PASSWORD,
      ...env,
    },
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

async function userCount(): Promise<number> {
  const r = await db.sql('select count(*)::int as n from users where email = $1', [E2E_EMAIL])
  return Number(r.rows[0]!.n)
}

async function passwordHash(): Promise<string> {
  const r = await db.sql(
    `select a.password from accounts a join users u on u.id = a.user_id
     where u.email = $1 and a.provider_id = 'credential'`,
    [E2E_EMAIL],
  )
  return String(r.rows[0]!.password)
}

describe('seed-e2e.mjs 的防呆（在建任何東西之前）', () => {
  it('FJU_SITE=prod 一律拒絕，不建帳號', async () => {
    const r = runSeed({ FJU_SITE: 'prod' })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('拒絕執行')
    expect(await userCount()).toBe(0)
  })

  it('沒設 FJU_SITE 也拒絕（只認明確的 test）', async () => {
    const r = runSeed({ FJU_SITE: undefined })
    expect(r.code).not.toBe(0)
    expect(await userCount()).toBe(0)
  })

  it('密碼不到 16 字元就拒絕', async () => {
    const r = runSeed({ E2E_ADMIN_PASSWORD: 'fifteen-chars-x' })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('至少 16 個字元')
    expect(await userCount()).toBe(0)
  })

  it('少了 email 或密碼就拒絕', async () => {
    expect(runSeed({ E2E_ADMIN_EMAIL: '' }).code).not.toBe(0)
    expect(runSeed({ E2E_ADMIN_PASSWORD: '' }).code).not.toBe(0)
    expect(await userCount()).toBe(0)
  })
})

describe('seed-e2e.mjs 建帳號', () => {
  it('建出 active、不需改密、admin、名稱看得出是測試帳號', async () => {
    const r = runSeed()
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('E2E 測試管理員已建立')

    const user = await db.sql(
      'select id, name, status, must_change_password, role, banned from users where email = $1',
      [E2E_EMAIL],
    )
    expect(user.rowCount).toBe(1)
    expect(user.rows[0]).toMatchObject({
      name: 'E2E 測試管理員',
      status: 'active',
      must_change_password: false,
      role: 'admin',
      banned: false,
    })
    const userId = String(user.rows[0]!.id)

    const roles = await db.sql(
      'select role, reason from role_assignments where user_id = $1 and revoked_real_at is null',
      [userId],
    )
    expect(roles.rows).toHaveLength(1)
    expect(roles.rows[0]!.role).toBe('admin')
    expect(String(roles.rows[0]!.reason)).toContain('seed:e2e')

    const profile = await db.sql('select display_name from user_profiles where user_id = $1', [userId])
    expect(profile.rows[0]!.display_name).toBe('E2E 測試管理員')

    const audit = await db.sql(
      `select actor_kind, target_id, payload from audit_events where action = 'account.seed_e2e_admin'`,
    )
    expect(audit.rowCount).toBe(1)
    expect(audit.rows[0]).toMatchObject({ actor_kind: 'system', target_id: userId })
    expect(JSON.stringify(audit.rows[0]!.payload)).not.toContain(E2E_PASSWORD)

    // 密碼是 Better Auth 的格式，登入時驗得過。
    expect(await verifyPassword({ hash: await passwordHash(), password: E2E_PASSWORD })).toBe(true)
  })

  it('輸出不含密碼、也不含 email', () => {
    const r = runSeed()
    for (const text of [r.stdout, r.stderr]) {
      expect(text).not.toContain(E2E_PASSWORD)
      expect(text).not.toContain(E2E_EMAIL)
    }
  })

  it('重跑是安全的：已存在就不動，連換了密碼也不改', async () => {
    const before = await passwordHash()
    const r = runSeed({ E2E_ADMIN_PASSWORD: 'A-Completely-Different-Password-1' })
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('已存在')

    expect(await userCount()).toBe(1)
    const after = await passwordHash()
    expect(after).toBe(before)
    expect(await verifyPassword({ hash: after, password: E2E_PASSWORD })).toBe(true)

    const audit = await db.sql(`select count(*)::int as n from audit_events where action = 'account.seed_e2e_admin'`)
    expect(Number(audit.rows[0]!.n), '重跑不會多寫一筆稽核').toBe(1)
  })
})
