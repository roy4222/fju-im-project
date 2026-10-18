import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AccountDirectoryCommand, ResolvedActor } from '@/application/accounts'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, TEST_DATABASE_URL, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * C2-11（AC-C2-24）：寄重設密碼信實際寄不出去時，系辦看到的是錯誤，不寫「已寄出」的稽核。
 *
 * 獨立一個檔：這裡要寄信真的失敗（不擷取、沒有 Brevo 憑證），不能跟帳號列表那組共用——那組的註冊流程要擷取模式才寄得出驗證碼。
 * 帳號直接用 SQL 建，不走註冊。
 */

const BASE_URL = 'http://127.0.0.1:3000'

let db: IsolatedDatabase
let app: Pool
let command: AccountDirectoryCommand
const adminId = '00000000-0000-4000-8000-0000000000a1'

const admin = (): ResolvedActor => ({
  kind: 'authenticated',
  userId: adminId,
  roles: ['admin'],
  status: 'active',
  mustChangePassword: false,
  cohortMemberships: [],
})

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'c2-11-reset-fail', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')

  const url = new URL(TEST_DATABASE_URL)
  url.username = 'fju_app'
  url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)

  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)
  vi.stubEnv('MAIL_CAPTURE', '0')
  vi.stubEnv('BREVO_API_KEY', '')

  const { PgAccountDirectoryCommand } = await import('@/infrastructure/accounts/account-directory-command')
  const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
  const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
  command = new PgAccountDirectoryCommand({ audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), db: () => app })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.end()
  await db?.close()
})

describe('寄重設密碼信：信實際寄不出去', () => {
  it('回錯誤、沒有 account.reset_mail_sent、mail_outbox 是 failed', async () => {
    const email = `c2-11-fail-${Date.now()}@example.com`
    const userId = String(
      (await db.sql(`insert into users (id, name, email, email_verified, status) values (gen_random_uuid(), '寄不出去的人', $1, true, 'active') returning id`, [email]))
        .rows[0]!.id,
    )
    await db.sql(
      `insert into accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) values (gen_random_uuid(), $1::text, 'credential', $1::uuid, 'x', now(), now())`,
      [userId],
    )

    const result = await command.sendResetMail(admin(), { userId }, { headers: new Headers({ 'x-real-ip': '198.51.100.7' }) })

    expect(result).toMatchObject({ ok: false, code: 'INTERNAL' })
    expect((await db.sql(`select count(*)::int as n from audit_events where action = 'account.reset_mail_sent' and target_id = $1`, [userId])).rows[0]).toEqual({ n: 0 })
    expect((await db.sql(`select template, status from mail_outbox where to_email = $1`, [email])).rows).toEqual([{ template: 'password_reset', status: 'failed' }])
  })
})
