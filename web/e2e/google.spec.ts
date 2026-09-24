import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie } from './session'

/**
 * 票 10：Google 登入與本人帳號頁——**只驗按鈕與導向**。
 *
 * Google 在 CI 登不了（也不該在 CI 打真的 Google），所以往 `accounts.google.com` 的導向
 * 在瀏覽器端被攔下來，只檢查「導去的網址帶了什麼」：client_id、回呼網址、state、PKCE 的 S256
 * challenge。回呼之後的整段（首次待審、同 Email 拒絕、連結、搶綁、設密碼）由整合測試
 * `google-oauth.integration.test.ts` 用假的 token 端點證明。
 *
 * **真實 Google 登入由 Roy 手動驗**（ACC-13／16／18）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

/** 攔下往 Google 的導向，回一頁假的，並把網址交出來。 */
async function interceptGoogle(context: BrowserContext): Promise<() => URL | null> {
  let captured: URL | null = null
  await context.route('https://accounts.google.com/**', async (route) => {
    captured = new URL(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Google（測試替身）</title>' })
  })
  return () => captured
}

function expectGoogleAuthorizeUrl(url: URL | null) {
  expect(url, '沒有導去 Google').not.toBeNull()
  expect(url!.origin + url!.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(url!.searchParams.get('client_id')).toBeTruthy()
  expect(url!.searchParams.get('redirect_uri')).toMatch(/\/api\/auth\/callback\/google$/)
  expect(url!.searchParams.get('state')).toMatch(/^[\w-]{20,}$/)
  expect(url!.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url!.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
}

/** 從 state 找回套件存的導回網址（`verifications` 一列；確認 `next` 經過 safeNextPath）。 */
async function storedCallback(state: string): Promise<{ callbackURL: string; errorURL: string; newUserURL: string }> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    const row = await pool.query<{ value: string }>('select value from verifications where identifier = $1', [state])
    return JSON.parse(row.rows[0]!.value) as { callbackURL: string; errorURL: string; newUserURL: string }
  } finally {
    await pool.end()
  }
}

test('登入頁：Google 大鈕導去 Google（state＋PKCE），next 經過 safeNextPath', async ({ page, context }) => {
  const google = await interceptGoogle(context)
  await page.goto('/login?next=%2Faccount')
  await page.getByRole('button', { name: '使用 Google 帳號登入' }).click()
  await expect.poll(google).not.toBeNull()
  expectGoogleAuthorizeUrl(google())

  const stored = await storedCallback(google()!.searchParams.get('state')!)
  expect(stored).toMatchObject({
    callbackURL: '/login?next=%2Faccount',
    errorURL: '/login?next=%2Faccount',
    newUserURL: '/register/pending?via=google',
  })
})

test('登入頁：站外的 next 不會被帶進 Google 的導回網址', async ({ page, context }) => {
  const google = await interceptGoogle(context)
  await page.goto('/login?next=%2F%5Cevil.example')
  await page.getByRole('button', { name: '使用 Google 帳號登入' }).click()
  await expect.poll(google).not.toBeNull()
  const stored = await storedCallback(google()!.searchParams.get('state')!)
  expect(stored.callbackURL).toBe('/login')
  expect(stored.errorURL).toBe('/login')
})

test('註冊頁：Google 註冊鈕也導去 Google，失敗回註冊頁', async ({ page, context }) => {
  const google = await interceptGoogle(context)
  await page.goto('/register')
  await page.getByRole('button', { name: '使用 Google 帳號註冊' }).click()
  await expect.poll(google).not.toBeNull()
  expectGoogleAuthorizeUrl(google())
  const stored = await storedCallback(google()!.searchParams.get('state')!)
  expect(stored).toMatchObject({ errorURL: '/register', newUserURL: '/register/pending?via=google' })
})

test('Google 回來說同 Email 已有帳號：提示用原方式登入後再連結', async ({ page }) => {
  await page.goto('/login?error=account_not_linked')
  await expect(page.getByTestId('google-error')).toContainText('請先用原本的 Email 與密碼登入，再到「我的帳號」連結 Google')
  await page.goto('/login?error=unable_to_create_session')
  await expect(page.getByTestId('google-error')).toContainText('Google 登入沒有完成')
})

test.describe('帳號頁', () => {
  let page: Page
  let session: { cookie: string; email: string; userId: string }

  test.beforeEach(async ({ browser }) => {
    const context = await browser.newContext()
    page = await context.newPage()
    session = await createTestSession(page.request, 'student')
    await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  })

  test('看得到登入 Email（不能換）與兩種登入方式；連結 Google 導去 Google', async () => {
    const google = await interceptGoogle(page.context())
    await page.goto('/account')
    await expect(page.getByTestId('login-email')).toContainText(session.email)
    await expect(page.getByTestId('login-email')).toContainText('不能自行更換')
    await expect(page.getByTestId('method-password')).toContainText('更改密碼')
    await expect(page.getByTestId('method-google')).toBeVisible()

    await page.getByRole('button', { name: '連結 Google' }).click()
    await expect.poll(google).not.toBeNull()
    expectGoogleAuthorizeUrl(google())
    const stored = await storedCallback(google()!.searchParams.get('state')!)
    expect(stored).toMatchObject({ callbackURL: '/account?linked=google', errorURL: '/account' })
  })

  test('登入超過 10 分鐘：連結前要重新登入確認身分', async () => {
    const pool = new Pool({ connectionString: ownerUrl, max: 1 })
    try {
      await pool.query(`update sessions set created_at = now() - interval '11 minutes' where user_id = $1`, [session.userId])
    } finally {
      await pool.end()
    }
    await page.goto('/account')
    await expect(page.getByTestId('reconfirm')).toContainText('要連結 Google，請先重新登入確認是你本人')
    await expect(page.getByRole('button', { name: '連結 Google' })).toHaveCount(0)
    await page.getByRole('button', { name: '重新登入確認身分' }).click()
    await expect(page).toHaveURL(/\/login\?next=%2Faccount$/)
  })

  test('改手機與聯絡 Email', async () => {
    const pool = new Pool({ connectionString: ownerUrl, max: 1 })
    try {
      await pool.query(
        `insert into user_profiles (user_id, display_name, name_normalized, contact_email, phone)
         values ($1, 'e2e 學生', 'e2e 學生', $2, '0912-345-678')`,
        [session.userId, session.email],
      )
    } finally {
      await pool.end()
    }
    await page.goto('/account')
    await page.getByLabel('手機').fill('0987-654-321')
    await page.getByLabel('聯絡 Email').fill('e2e-contact@example.com')
    await page.getByRole('button', { name: '儲存變更' }).click()
    await expect(page.getByTestId('account-notice')).toHaveText('聯絡資料已更新。')
    await expect(page.getByLabel('手機')).toHaveValue('0987-654-321')
    await expect(page.getByLabel('聯絡 Email')).toHaveValue('e2e-contact@example.com')
    await expect(page.getByTestId('login-email')).toContainText(session.email)
  })
})
