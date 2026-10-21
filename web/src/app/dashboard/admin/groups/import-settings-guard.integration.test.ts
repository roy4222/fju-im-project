import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '../../../../../test/db'
import { migratedSchema } from '../../../../../test/migrations'

/**
 * SEC-2（CL-7C 改成真 session）：匯入分組對話框的 `op: 'settings'` 也要先過系辦＋business 狀態守門（原本不檢查身分）。
 *
 * 登入、session、身分解析與 PostgreSQL 都是真的（照 `test/front-edit-actor.integration.test.ts`）；只替 Next 請求環境
 * 提供 headers，並把 `getGroupImportCommand` 包一層計數（照樣回真的用例），斷言被拒時沒進用例。
 */
const request = vi.hoisted(() => ({ headers: new Headers() }))
const seen = vi.hoisted(() => ({ calls: 0 }))
vi.mock('next/headers', () => ({ headers: async () => request.headers }))
vi.mock('next/cache', async (original) => ({ ...(await original<object>()), refresh: () => undefined }))
vi.mock('@/composition/groups', async (original) => {
  const real = await original<typeof import('@/composition/groups')>()
  return {
    ...real,
    getGroupImportCommand: () => {
      seen.calls += 1
      return real.getGroupImportCommand()
    },
  }
})

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Cl-7c-Correct-Password-9'

let db: IsolatedDatabase
let adminId: string
let cookie: string
let groupImportAction: typeof import('@/app/dashboard/admin/groups/import-actions').groupImportAction

async function oneId(sql: string, values: unknown[] = []) {
  return String((await db.sql(sql, values)).rows[0]!.id)
}

beforeAll(async () => {
  db = await createIsolatedDatabase({ label: 'cl-7c-import-settings', setup: migratedSchema })
  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)
  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'cl-7c-integration-secret-only-32chars')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)
  vi.stubEnv('IDENTITY_CACHE_TTL_SECONDS', '0')

  const { authRouteHandlers } = await import('@/infrastructure/auth/wrapper')
  const email = `cl-7c-${randomUUID()}@example.com`
  const call = (route: string, body: unknown) => authRouteHandlers.POST(new Request(`${BASE_URL}/api/auth/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify(body),
  }))
  expect((await call('sign-up/email', { email, password: PASSWORD, name: '系辦' })).status).toBe(200)
  adminId = await oneId('select id from users where email = $1', [email])
  await db.sql(`update users set status = 'active', email_verified = true where id = $1`, [adminId])
  await db.sql(`insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
    values (gen_random_uuid(), $1, 'admin', $1, now())`, [adminId])
  const signedIn = await call('sign-in/email', { email, password: PASSWORD })
  expect(signedIn.status).toBe(200)
  cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]!
  expect(cookie).toContain('session_token=')

  groupImportAction = (await import('@/app/dashboard/admin/groups/import-actions')).groupImportAction
})

beforeEach(async () => {
  request.headers = new Headers({ cookie })
  await db.sql(`update users set status = 'active', must_change_password = false where id = $1`, [adminId])
  await db.sql(`update role_assignments set revoked_real_at = null where user_id = $1 and role = 'admin'`, [adminId])
  await db.sql(`delete from role_assignments where user_id = $1 and role = 'teacher'`, [adminId])
  seen.calls = 0
})

afterAll(async () => {
  await db?.close()
  vi.unstubAllEnvs()
})

const denied: [string, () => Promise<void>][] = [
  ['未登入', async () => { request.headers = new Headers() }],
  ['非系辦（老師）', async () => {
    await db.sql(`update role_assignments set revoked_real_at = now() where user_id = $1 and role = 'admin'`, [adminId])
    await db.sql(`insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
      values (gen_random_uuid(), $1, 'teacher', $1, now())`, [adminId])
  }],
  ['必須改密的系辦', async () => { await db.sql('update users set must_change_password = true where id = $1', [adminId]) }],
  ['待審的系辦', async () => { await db.sql(`update users set status = 'pending' where id = $1`, [adminId]) }],
  ['停用的系辦', async () => { await db.sql(`update users set status = 'disabled' where id = $1`, [adminId]) }],
]

describe("groupImportAction op='settings' 守門（真 session）", () => {
  it.each(denied)('%s：拒絕（丟錯，對話框顯示連線中斷），不回設定、不進用例', async (_who, become) => {
    await become()
    await expect(groupImportAction({ op: 'settings' })).rejects.toThrow('只有系辦可以匯入分組。')
    expect(seen.calls).toBe(0)
  })

  it('有效系辦：拿到文字與上限', async () => {
    const { GROUP_IMPORT_KIND_LABEL, GROUP_IMPORT_MAX_BYTES, GROUP_IMPORT_OUTCOME_LABEL } = await import('@/composition/groups')
    expect(await groupImportAction({ op: 'settings' })).toEqual({
      kindLabels: GROUP_IMPORT_KIND_LABEL, outcomeLabels: GROUP_IMPORT_OUTCOME_LABEL, maxBytes: GROUP_IMPORT_MAX_BYTES,
    })
  })
})
