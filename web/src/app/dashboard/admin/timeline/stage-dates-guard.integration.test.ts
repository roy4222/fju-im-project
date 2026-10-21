import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '../../../../../test/db'
import { migratedSchema } from '../../../../../test/migrations'

/**
 * SEC-2（CL-7C 改成真 session）：甘特拖拉的兩個動作要先過系辦＋business 狀態守門，才去讀目前存的階段（`schedule()`）。
 *
 * 登入、session、身分解析、用例與 PostgreSQL 都是真的（照 `test/front-edit-actor.integration.test.ts`）；
 * 只替 Next 請求環境提供 headers，並把 composition 的三個 port 包一層計數（呼叫照樣轉給真的實作），
 * 用來斷言「被拒時沒讀資料、沒進用例」。
 */
const request = vi.hoisted(() => ({ headers: new Headers() }))
const seen = vi.hoisted(() => ({ schedule: 0, previewSchedule: 0, saveSchedule: 0 }))
vi.mock('next/headers', () => ({ headers: async () => request.headers }))
vi.mock('next/cache', async (original) => ({ ...(await original<object>()), refresh: () => undefined }))
vi.mock('@/composition/cohorts', async (original) => {
  const real = await original<typeof import('@/composition/cohorts')>()
  const count = <T extends object>(port: T, name: keyof typeof seen & keyof T): T =>
    new Proxy(port, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop !== name || typeof value !== 'function') return value
        return (...args: unknown[]) => {
          seen[name] += 1
          return value.apply(target, args)
        }
      },
    })
  return {
    ...real,
    getTimelineQuery: () => count(real.getTimelineQuery(), 'schedule'),
    getSchedulePreview: () => count(real.getSchedulePreview(), 'previewSchedule'),
    getTimelineCommand: () => count(real.getTimelineCommand(), 'saveSchedule'),
  }
})

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Cl-7c-Correct-Password-9'

let db: IsolatedDatabase
let adminId: string
let cookie: string
let cohortId: string
let actions: typeof import('@/app/dashboard/admin/timeline/actions')

async function oneId(sql: string, values: unknown[] = []) {
  return String((await db.sql(sql, values)).rows[0]!.id)
}

beforeAll(async () => {
  db = await createIsolatedDatabase({ label: 'cl-7c-stage-dates', setup: migratedSchema })
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

  cohortId = await oneId(`insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
    values (gen_random_uuid(), 'CL7C', 'CL7C', 'active', '2027-06-30', 'system') returning id`)
  for (const [i, start] of ['2026-09-01', '2026-11-01', '2027-02-01', '2027-04-01'].entries()) {
    await db.sql(`insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
      values (gen_random_uuid(), $1, $2, $3, $4, 'system')`, [cohortId, i + 1, `階段${i + 1}`, start])
  }
  actions = await import('@/app/dashboard/admin/timeline/actions')
})

beforeEach(async () => {
  request.headers = new Headers({ cookie })
  await db.sql(`update users set status = 'active', must_change_password = false where id = $1`, [adminId])
  await db.sql(`update role_assignments set revoked_real_at = null where user_id = $1 and role = 'admin'`, [adminId])
  await db.sql(`delete from role_assignments where user_id = $1 and role = 'teacher'`, [adminId])
  seen.schedule = 0
  seen.previewSchedule = 0
  seen.saveSchedule = 0
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

const stagesNow = async () => (await db.sql('select seq, name, start_date::text from cohort_stages where cohort_id = $1 order by seq', [cohortId])).rows
const input = (revision: number) => ({ stages: [{ seq: 2, startDate: '2026-11-15' }], yearEndDate: '2027-06-30', revision })
const revisionNow = async () => Number((await db.sql('select revision from cohorts where id = $1', [cohortId])).rows[0]!.revision)

describe.each([
  ['previewScheduleAction', 'previewSchedule'],
  ['saveStageDatesAction', 'saveSchedule'],
] as const)('%s 守門（真 session）', (name, useCase) => {
  it.each(denied)('%s：直接拒絕，不讀 schedule、不進用例、階段不變', async (_who, become) => {
    const before = await stagesNow()
    await become()
    const result = await actions[name](cohortId, input(1))
    expect(result.ok).toBe(false)
    expect(seen.schedule).toBe(0)
    expect(seen[useCase]).toBe(0)
    expect(await stagesNow()).toEqual(before)
  })

  it('有效系辦：讀了 schedule 再交給用例', async () => {
    const revision = await revisionNow()
    const result = await actions[name](cohortId, input(revision))
    expect(result).toMatchObject({ ok: true })
    expect(seen.schedule).toBeGreaterThan(0)
    expect(seen[useCase]).toBe(1)
  })
})
