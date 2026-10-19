import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, TEST_DATABASE_URL, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * C2-11 第二步：系辦在帳號列寄重設密碼信，走內部呼叫（略過每 IP 桶與 Turnstile，Email 桶照扣）。
 * 外部請求照舊要 Turnstile、照舊吃每 IP 桶，而且不管同時有沒有內部呼叫在跑都一樣。
 *
 * 開著 Turnstile（替身金鑰）。帳號直接用 SQL 建；信擷取進 `mail_outbox`（這個檔每個測試用自己的 Email，用 Email＋範本找那封信）。
 * 套件的寄信回呼是背景寄送、不回信件編號，所以沒有「回傳的 mail id」可用。
 */

const BASE_URL = 'http://127.0.0.1:3000'

let db: IsolatedDatabase
let app: Pool
let wrapper: typeof import('@/infrastructure/auth/wrapper')

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'c2-11-internal-reset', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')

  const url = new URL(TEST_DATABASE_URL)
  url.username = 'fju_app'
  url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)

  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)
  vi.stubEnv('MAIL_CAPTURE', '1')
  vi.stubEnv('TURNSTILE_SITE_KEY', '1x00000000000000000000AA')
  vi.stubEnv('TURNSTILE_SECRET_KEY', '1x0000000000000000000000000000000AA')
  wrapper = await import('@/infrastructure/auth/wrapper')
  ;(await import('@/infrastructure/auth/auth-instance')).getAuth()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.end()
  await db?.close()
})

let seq = 0
async function person(label: string): Promise<string> {
  const email = `c2-11-${label}-${Date.now()}-${++seq}@example.com`
  const id = String(
    (await db.sql(`insert into users (id, name, email, email_verified, status) values (gen_random_uuid(), '測試的人', $1, true, 'active') returning id`, [email]))
      .rows[0]!.id,
  )
  await db.sql(
    `insert into accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) values (gen_random_uuid(), $1::text, 'credential', $1::uuid, 'x', now(), now())`,
    [id],
  )
  return email
}

async function mailsOf(email: string): Promise<{ template: string; subject: string; status: string }[]> {
  for (let i = 0; i < 50; i += 1) {
    const rows = (await db.sql(`select template, subject, status from mail_outbox where to_email = $1 order by created_at`, [email])).rows as {
      template: string
      subject: string
      status: string
    }[]
    if (rows.length > 0) return rows
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return []
}

const external = (email: string, ip: string, extra: Record<string, string> = {}) =>
  wrapper.authRouteHandlers.POST(
    new Request(`${BASE_URL}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': ip, ...extra },
      body: JSON.stringify({ email, redirectTo: '/reset-password', variant: 'reset' }),
    }),
  )

describe('系辦內部寄重設密碼信', () => {
  it('(a) 同一個出口 IP 連寄 25 位：不要 Turnstile、不吃每 IP 桶，每位都真的排進 mail_outbox（重設密碼那封，不是設定密碼）', async () => {
    const ip = '203.0.113.230'
    const people = await Promise.all(Array.from({ length: 25 }, (_, i) => person(`int-${i}`)))
    for (const email of people) {
      await expect(wrapper.sendAdminResetMail({ email }, new Headers({ 'x-real-ip': ip }))).resolves.toBeDefined()
    }
    for (const email of people) {
      const mails = await mailsOf(email)
      expect(mails, email).toHaveLength(1)
      expect(mails[0]).toMatchObject({ template: 'password_reset', subject: '【專題管理平台】重設密碼', status: 'captured' })
    }
  })
})

describe('外部請求不能借內部豁免', () => {
  it('(b) 外部照舊要 Turnstile、照舊吃每 IP 桶；同時有內部呼叫在跑、外部帶任何標頭或參數也一樣', async () => {
    const ip = '203.0.113.231'
    const internalPeople = await Promise.all(Array.from({ length: 10 }, (_, i) => person(`mix-${i}`)))
    const bait = { 'x-internal-call': '1', 'x-admin-reset': '1', 'x-setup': '1' }

    // 並發探針：內部 10 封與外部 20 次同時送出，外部沒有任何一次被放行（前 20 次都是 400 TURNSTILE_REQUIRED）。
    const [outside] = await Promise.all([
      Promise.all(Array.from({ length: 20 }, (_, i) => external(`c2-11-ext-${Date.now()}-${i}@example.com`, ip, bait))),
      Promise.all(internalPeople.map((email) => wrapper.sendAdminResetMail({ email }, new Headers({ 'x-real-ip': ip })))),
    ])
    for (const [i, response] of outside.entries()) {
      expect(response.status, `外部第 ${i + 1} 次`).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'TURNSTILE_REQUIRED' })
    }
    // 第 21 次起被每 IP 桶擋成 429（內部呼叫沒有扣到這個桶）。
    expect((await external(`c2-11-ext-${Date.now()}-over@example.com`, ip, bait)).status).toBe(429)

    // 內部呼叫結束後，不帶 token 的一般 server 端呼叫（忘記密碼那條）也沒有被留下來的豁免放行。
    await expect(wrapper.requestPasswordReset({ email: await person('after') }, new Headers({ 'x-real-ip': '203.0.113.232' }))).rejects.toMatchObject({
      body: { code: 'TURNSTILE_REQUIRED' },
    })

    // 內部那 10 封都真的寄出了。
    for (const email of internalPeople) expect(await mailsOf(email), email).toHaveLength(1)
  })
})
