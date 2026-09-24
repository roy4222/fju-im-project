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
 * Better Auth 內建的限速對 `/api/auth/*` 是全域的（正式模式預設開著），
 * 每個測試都註冊一個新帳號會很快撞到 429——那是套件的保護在正常運作，不是 bug。
 * 契約 03 §6 自己的逐路由限速由 S01-05／S01-15 實作。
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

  /**
   * Better Auth 內建的限速是**全域**的（預設 10 次／60 秒／IP，涵蓋整個 `/api/auth/*`）。
   * 一次 CI 跑只註冊四個帳號不會撞到；但在本機連續重跑時會。
   * 這裡最多等一個視窗再試一次——**不是**把限速關掉，那是真的保護。
   *
   * 順帶一提：這個預設值對正式環境太緊（全系在同一個對外 IP 後面，一分鐘只有 10 次
   * 就會擋到正常登入）。契約 03 §6 的逐路由限速由 S01-05／S01-15 實作，屆時一併調整。
   */
  // 每次註冊帶一個隨機的來源 IP：註冊限速是每 IP 每小時 30 次（票 7），CI 直連 app 時
  // 沒帶標頭的請求全部落在同一個「unknown」桶，e2e 一多就會互相吃掉額度。
  // 經過 Caddy（本機 8080）時這個標頭會被 Caddy 覆寫成真的來源，等於沒帶——那是正確的行為。
  const headers = { 'x-real-ip': `10.250.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` }
  let response = await request.post('/api/auth/sign-up/email', {
    headers,
    data: { email, password: 'E2e-Password-Correct-9', name: `e2e ${role ?? 'pending'}` },
  })
  if (response.status() === 429) {
    await new Promise((resolve) => setTimeout(resolve, 61_000))
    response = await request.post('/api/auth/sign-up/email', {
      headers,
      data: { email, password: 'E2e-Password-Correct-9', name: `e2e ${role ?? 'pending'}` },
    })
  }
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
