import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { Pool } from 'pg'
import type { APIRequestContext } from '@playwright/test'

/**
 * e2e 用的測試登入狀態（票 #47：「以測試 session 直接寫入」）。
 *
 * 做法：用真的註冊 API 拿一張真的 session cookie，再用 owner 連線把帳號狀態與角色
 * 直接改成要扮的樣子。**不自己偽造 cookie**——Better Auth 的 cookie 是簽章過的，
 * 手工拼一個出來只會測到「我們很會拼字串」，測不到真的登入狀態。
 */

const ownerUrl = process.env.DATABASE_URL_OWNER

export type TestRole = 'admin' | 'teacher' | 'student'

export type TestSession = { cookie: string; email: string; userId: string }

let counter = 0

/**
 * 每個角色只註冊一次，全檔共用。
 *
 * 註冊有限速（契約 03 §6：每 IP 每小時 30 次），每個測試都註冊一個新帳號是浪費額度；
 * 同一個角色重用同一個帳號就夠了。
 */
const shared = new Map<string, Promise<TestSession>>()

export function sharedTestSession(
  request: APIRequestContext,
  role: TestRole | null,
): Promise<TestSession> {
  const key = role ?? 'pending'
  let existing = shared.get(key)
  if (!existing) {
    existing = createTestSession(request, role)
    shared.set(key, existing)
  }
  return existing
}

export async function createTestSession(
  request: APIRequestContext,
  role: TestRole | null,
): Promise<TestSession> {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能造測試登入狀態')

  counter += 1
  const email = `e2e-${role ?? 'pending'}-${Date.now()}-${counter}@example.com`

  // 每次註冊帶一個隨機的來源 IP：註冊限速是每 IP 每小時 30 次（契約 03 §6；票 7 起由 app 自己算，
  // 套件那一層對 `/sign-up/email` 關掉了）。CI 直連 app 時，沒帶標頭的請求全部落在同一個
  // 「unknown」桶，e2e 一多就會互相吃掉額度。經過 Caddy（本機 8080）時這個標頭會被 Caddy
  // 覆寫成真的來源，等於沒帶——那是正確的行為；撞到上限就要等一小時，不重試。
  const headers = { 'x-real-ip': `10.250.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` }
  const response = await request.post('/api/auth/sign-up/email', {
    headers,
    data: { email, password: 'E2e-Password-Correct-9', name: `e2e ${role ?? 'pending'}` },
  })
  if (!response.ok()) throw new Error(`註冊失敗（${response.status()}）：${await response.text()}`)

  const setCookie = response.headers()['set-cookie'] ?? ''
  const cookie = setCookie.split(/,(?=[^;]+=)/)[0]!.split(';')[0]!
  if (!cookie) throw new Error('註冊回應沒有 set-cookie')

  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    const found = await pool.query<{ id: string }>('select id from users where email = $1', [email])
    const userId = found.rows[0]?.id
    if (!userId) throw new Error(`找不到剛註冊的帳號 ${email}`)

    if (role) {
      await pool.query(`update users set status = 'active' where id = $1`, [userId])
      await pool.query(
        `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
         values (gen_random_uuid(), $1, $2, $1, now())`,
        [userId, role],
      )
    }
    return { cookie, email, userId }
  } finally {
    await pool.end()
  }
}

/** 把 cookie 字串拆成 Playwright 的 cookie 物件。 */
export function toPlaywrightCookie(cookie: string, baseUrl: string) {
  const [name, ...rest] = cookie.split('=')
  const { hostname } = new URL(baseUrl)
  return { name: name!, value: rest.join('='), domain: hostname, path: '/' }
}

/**
 * 跑真的 `scripts/seed-a1.mjs` 建第一位管理員（S01-05）。
 *
 * 用子程序跑真的腳本而不是在這裡自己插資料：這樣 e2e 驗到的就是 Roy 會執行的那一支。
 * 一次性密碼只在這個程序的環境變數裡，不寫進任何檔案。
 */
export function seedA1(email: string, oneTimePassword: string): string {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能跑 seed:a1')
  const webRoot = path.join(import.meta.dirname, '..')
  return execFileSync('node', ['scripts/seed-a1.mjs'], {
    cwd: webRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL_OWNER: ownerUrl,
      A1_EMAIL: email,
      A1_INITIAL_PASSWORD: oneTimePassword,
      A1_NAME: '系辦管理員',
    },
  })
}
