import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 套件限速的設定守門（票 T3 資安審查）。
 *
 * 契約管到的四條路由我們自己在 hook 裡限速，套件自己的那一層必須關掉：套件的鍵只有 IP＋路徑，
 * 不含帳號，等於一個跨帳號共用的桶——例如把 `/sign-in/email` 的 60 次／10 分鐘加回來，
 * 同一個校園出口後面第 61 個人拿正確密碼也會吃 429。
 * `a1-login.integration.test.ts` 的鄰居測試改成 29 次之後（每 IP 失敗桶的預算之內）
 * 已經抓不到這件事，所以在這裡直接斷言設定值。
 */

const BASE_URL = 'http://127.0.0.1:3000'

let db: IsolatedDatabase
let authInstance: ReturnType<typeof import('@/infrastructure/auth/auth-instance').getAuth>

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'route-table', setup: migratedSchema })

  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)

  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret')

  authInstance = (await import('@/infrastructure/auth/auth-instance')).getAuth()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db?.close()
})

describe('套件限速設定', () => {
  it('契約管到的四條路關掉套件自己的限速', () => {
    const rules: Record<string, unknown> = authInstance.options.rateLimit?.customRules ?? {}
    for (const p of ['/sign-in/email', '/change-password', '/sign-up/email', '/sign-in/social']) {
      expect(rules[p], p).toBe(false)
    }
  })
})
