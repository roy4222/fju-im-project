import { expect, test, type Page } from '@playwright/test'
import { createTestSession, toPlaywrightCookie } from './session'

/**
 * 網站問題 #2：登入打錯密碼後 Email 被清空、只重打密碼按登入沒反應。
 *
 * AC-L1：打錯密碼 → 看到錯誤、Email 還在、密碼欄是空的；只補正確密碼就登得進去。
 * AC-L3：密碼欄的眼睛按鈕預設隱藏、按一下顯示、再按隱藏，鍵盤也能操作，不會送出表單。
 *
 * 帳號用 `createTestSession` 造（真的註冊 API，密碼固定是下面那一組），再扮成學生讓它能登入。
 * 每個 context 帶自己的 `X-Real-IP`，登入限速的桶不跟其他 e2e 檔搶。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const CORRECT = 'E2e-Password-Correct-9'

function uniqueIp(): string {
  return `10.251.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`
}

async function freshLoginPage(page: Page) {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': uniqueIp() })
  await page.goto('/login')
}

test('AC-L1：打錯密碼保留 Email、密碼清空，只補密碼就登得進去', async ({ page }) => {
  const { email } = await createTestSession(page.request, 'student')
  await page.context().clearCookies()
  await freshLoginPage(page)

  const emailField = page.getByLabel('Email')
  const passwordField = page.getByLabel('密碼', { exact: true })
  await emailField.fill(email)
  await passwordField.fill('Wrong-Password-000')
  await page.getByRole('button', { name: '登入', exact: true }).click()

  await expect(page.locator('p[role="alert"]')).toBeVisible()
  await expect(emailField).toHaveValue(email)
  await expect(passwordField).toHaveValue('')

  await passwordField.fill(CORRECT)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/)
})

test('AC-L3：登入頁密碼欄的眼睛按鈕', async ({ page }) => {
  await freshLoginPage(page)
  const passwordField = page.getByLabel('密碼', { exact: true })
  await expect(passwordField).toHaveAttribute('type', 'password')
  await expect(passwordField).toHaveAttribute('autocomplete', 'current-password')

  const show = page.getByRole('button', { name: '顯示密碼' })
  await expect(show).toHaveAttribute('type', 'button')
  await expect(show).toHaveAttribute('aria-pressed', 'false')

  await passwordField.fill('peek-a-boo')
  await show.click()
  await expect(passwordField).toHaveAttribute('type', 'text')
  const hide = page.getByRole('button', { name: '隱藏密碼' })
  await expect(hide).toHaveAttribute('aria-pressed', 'true')
  // 按眼睛不會送出表單：還在登入頁、沒有錯誤訊息、輸入的字還在。
  await expect(page).toHaveURL(/\/login/)
  await expect(page.locator('p[role="alert"]')).toHaveCount(0)
  await expect(passwordField).toHaveValue('peek-a-boo')
  await expect(passwordField).toHaveAttribute('autocomplete', 'current-password')

  // 鍵盤：焦點在按鈕上按空白鍵／Enter 也能切換。
  await hide.focus()
  await page.keyboard.press('Space')
  await expect(passwordField).toHaveAttribute('type', 'password')
  await expect(page.getByRole('button', { name: '顯示密碼' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(passwordField).toHaveAttribute('type', 'text')
  await expect(page).toHaveURL(/\/login/)
})

test('AC-L3：註冊頁兩個密碼欄都有眼睛按鈕', async ({ page }) => {
  await page.goto('/register')
  test.skip((await page.getByLabel('確認密碼').count()) === 0, '註冊關閉時沒有表單')
  for (const label of ['密碼', '確認密碼']) {
    const field = page.getByLabel(label, { exact: true })
    await expect(field).toHaveAttribute('type', 'password')
    await expect(field).toHaveAttribute('autocomplete', 'new-password')
  }
  const buttons = page.getByRole('button', { name: '顯示密碼' })
  await expect(buttons).toHaveCount(2)
  await buttons.first().click()
  await expect(page.getByLabel('密碼', { exact: true })).toHaveAttribute('type', 'text')
  await expect(page.getByLabel('確認密碼', { exact: true })).toHaveAttribute('type', 'password')
})

test('AC-L3：改密碼頁三個密碼欄都有眼睛按鈕', async ({ page }) => {
  const session = await createTestSession(page.request, 'student')
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto('/account/change-password')
  const fields = [
    ['目前的密碼', 'current-password'],
    ['新密碼', 'new-password'],
    ['再輸入一次新密碼', 'new-password'],
  ] as const
  for (const [label, autocomplete] of fields) {
    const field = page.getByLabel(label, { exact: true })
    await expect(field).toHaveAttribute('type', 'password')
    await expect(field).toHaveAttribute('autocomplete', autocomplete)
  }
  const buttons = page.getByRole('button', { name: '顯示密碼' })
  await expect(buttons).toHaveCount(3)
  await buttons.nth(1).click()
  await expect(page.getByLabel('新密碼', { exact: true })).toHaveAttribute('type', 'text')
  await expect(page).toHaveURL(/\/account\/change-password/)
})
