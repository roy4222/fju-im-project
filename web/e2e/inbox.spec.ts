import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 12（#223）：背景工作與通知匣。「做完的樣子」逐條走，**背景工作要在跑**（CI 的 e2e-smoke 會起它）：
 *
 * 1. `/api/health` 的 worker 欄有版本與最近的心跳。
 * 2. 系辦在通知匣「發一則測試通知」給 S01 → 幾秒內 S01 的鈴鐺未讀 1、通知匣有這一則；S02 什麼都沒有。
 * 3. S01 單筆標已讀 → 未讀 0；重新登入（新的 session）仍是已讀。
 * 4. 再發兩則（其中一則屬某一屆）→ 屆別篩選只看得到那一則 → 「全部標為已讀」未讀歸零。
 *
 * 全程用真的表單與按鈕；「別人的通知編號標已讀被拒」在整合測試（直接打用例）證明。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'E2e-Password-Correct-9'

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
let pool: Pool
let s01: TestSession
let s02: TestSession
let cohortCode: string

/** 每位學生用自己的 request context 註冊：共用一個的話第二次會帶著第一位的 cookie，被 Better Auth 當成跨站請求擋下。 */
async function freshStudent(): Promise<TestSession> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  try {
    return await createTestSession(context, 'student')
  } finally {
    await context.dispose()
  }
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  // 兩位全新的學生：未讀數才會從 0 開始算。
  s01 = await freshStudent()
  s02 = await freshStudent()
  cohortCode = `T12-${stamp}`
  await pool.query(`insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system')`, [
    cohortCode,
    `${cohortCode} 通知測試`,
  ])
})

test.afterAll(async () => {
  await pool?.end()
})

async function useCookie(page: Page, cookie: string) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(cookie, BASE_URL)])
}

function feedback(page: Page, role: 'status' | 'alert') {
  return page.getByRole('main').getByRole(role)
}

async function sendTestNotification(page: Page, recipient: TestSession, title: string, cohort?: string) {
  const admin = await sharedTestSession(page.request, 'admin')
  await useCookie(page, admin.cookie)
  await page.goto('/dashboard/admin/inbox')
  await page.getByLabel('收件人', { exact: true }).selectOption({ label: `e2e student（${recipient.email}）` })
  if (cohort) await page.getByLabel('屆別', { exact: true }).selectOption({ label: cohort })
  await page.getByLabel('標題', { exact: true }).fill(title)
  await page.getByRole('button', { name: '發送測試通知' }).click()
  await expect(feedback(page, 'status')).toContainText('已發給')
}

/** 等背景工作把通知投影進來（每 5 秒一輪；最多等 30 秒）。 */
async function waitForItem(page: Page, title: string) {
  await expect
    .poll(
      async () => {
        await page.goto('/dashboard/student/inbox')
        return page.getByTestId('inbox-item').filter({ hasText: title }).count()
      },
      { timeout: 30_000, intervals: [1_000, 2_000] },
    )
    .toBe(1)
}

test('背景工作在跑：/api/health 的 worker 欄有版本與最近的心跳', async ({ request }) => {
  await expect
    .poll(
      async () => {
        const body = (await (await request.get('/api/health')).json()) as { ok: boolean; worker: { version: string | null; lastTickAt: string | null } }
        return body.ok && body.worker.version !== null && body.worker.lastTickAt !== null
          ? Date.now() - Date.parse(body.worker.lastTickAt) < 60_000
          : false
      },
      { timeout: 30_000 },
    )
    .toBe(true)
})

test('系辦發測試通知給 S01：S01 鈴鐺未讀 1、通知匣有這一則；S02 看不到', async ({ page }) => {
  const title = `測試通知 ${stamp} A`
  await sendTestNotification(page, s01, title)

  await useCookie(page, s01.cookie)
  await waitForItem(page, title)
  await expect(page.getByTestId('inbox-bell')).toHaveAccessibleName('通知，1 則未讀')
  await expect(page.getByTestId('inbox-bell-count')).toHaveText('1')
  await expect(page.getByTestId('inbox-item').filter({ hasText: title })).toHaveAttribute('data-read', 'false')

  await useCookie(page, s02.cookie)
  await page.goto('/dashboard/student/inbox')
  await expect(page.getByTestId('inbox-bell')).toHaveAccessibleName('通知，沒有未讀')
  await expect(page.getByTestId('inbox-item')).toHaveCount(0)
  await expect(page.getByText('還沒有通知')).toBeVisible()
})

test('S01 單筆標已讀：未讀變 0；重新登入（新的 session）仍是已讀', async ({ page }) => {
  const title = `測試通知 ${stamp} A`
  await useCookie(page, s01.cookie)
  await page.goto('/dashboard/student/inbox')
  await page.getByRole('button', { name: `把「${title}」標為已讀` }).click()
  await expect(page.getByTestId('inbox-item').filter({ hasText: title })).toHaveAttribute('data-read', 'true')
  await expect(page.getByTestId('inbox-bell')).toHaveAccessibleName('通知，沒有未讀')

  // 真的重新登入一次（另一個乾淨的「裝置」）：拿一張新的 session cookie。
  const device = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const signIn = await device.post('/api/auth/sign-in/email', { data: { email: s01.email, password: PASSWORD } })
  expect(signIn.ok(), await signIn.text()).toBe(true)
  const fresh = (signIn.headers()['set-cookie'] ?? '').split(/,(?=[^;]+=)/)[0]!.split(';')[0]!
  await device.dispose()
  expect(fresh).not.toBe(s01.cookie)
  await useCookie(page, fresh)
  await page.goto('/dashboard/student/inbox')
  await expect(page.getByTestId('inbox-item').filter({ hasText: title })).toHaveAttribute('data-read', 'true')
  await expect(page.getByTestId('inbox-bell')).toHaveAccessibleName('通知，沒有未讀')
})

test('再發兩則（一則屬某一屆）：屆別篩選只看得到那一屆；全部標為已讀後未讀歸零', async ({ page }) => {
  const scoped = `測試通知 ${stamp} B`
  const global = `測試通知 ${stamp} C`
  await sendTestNotification(page, s01, scoped, cohortCode)
  await sendTestNotification(page, s01, global)

  await useCookie(page, s01.cookie)
  await waitForItem(page, scoped)
  await waitForItem(page, global)
  await expect(page.getByTestId('inbox-bell-count')).toHaveText('2')

  // 依屆別篩選。
  await page.getByRole('navigation', { name: '依屆別篩選' }).getByRole('link', { name: cohortCode }).click()
  await expect(page).toHaveURL(/cohort=/)
  await expect(page.getByTestId('inbox-item')).toHaveCount(1)
  await expect(page.getByTestId('inbox-item')).toContainText(scoped)
  await page.getByRole('navigation', { name: '依屆別篩選' }).getByRole('link', { name: '全站' }).click()
  await expect(page.getByTestId('inbox-item').filter({ hasText: scoped })).toHaveCount(0)
  await expect(page.getByTestId('inbox-item').filter({ hasText: global })).toHaveCount(1)

  await page.getByRole('navigation', { name: '依屆別篩選' }).getByRole('link', { name: '全部' }).click()
  await expect(page).not.toHaveURL(/cohort=/)
  await expect(page.getByTestId('inbox-item').and(page.locator('[data-read="false"]'))).toHaveCount(2)
  await page.getByRole('button', { name: '全部標為已讀' }).click()
  await expect(feedback(page, 'status')).toContainText('已把 2 則標為已讀')
  await expect(page.getByTestId('inbox-bell')).toHaveAccessibleName('通知，沒有未讀')
  await expect(page.getByTestId('inbox-item').and(page.locator('[data-read="false"]'))).toHaveCount(0)

  // 資料庫裡是真的已讀（不是畫面自己藏起來）。
  const unread = await pool.query(`select count(*)::int as n from notifications where recipient_user_id = $1 and read_at is null`, [s01.userId])
  expect(unread.rows[0].n).toBe(0)
})
