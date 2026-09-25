import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { adminCredentials, expectDashboardBlocked, screenshotter, signIn, signOut } from './helpers'

/**
 * 第 1 站：登入、進後台、登出（對照 e2e/acceptance/station-1-login.md）。
 *
 * E2E 管理員登入 → 後台 → 登出 → 看不到後台 → 重登 → 登出 → 錯誤密碼被擋（只試一次：登入有限速）。
 * 同一個瀏覽器工作階段一路走下去，前一步失敗後面就跳過。
 */

test.describe.configure({ mode: 'serial' })

const shot = screenshotter('station-1')
let context: BrowserContext
let page: Page

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  page = await context.newPage()
})

test.afterAll(async () => {
  await context?.close()
})

test('1＋2 打開登入頁，用 E2E 管理員登入', async () => {
  const { email, password } = adminCredentials()
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible()
  await expect(page.getByLabel('Email')).toBeVisible()
  await expect(page.getByLabel('密碼', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '登入', exact: true })).toBeVisible()
  await shot(page, 'login-page')

  await signIn(page, email, password)
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page, 'E2E 管理員不該被帶去改密頁').not.toHaveURL(/\/account\/change-password/)
  await shot(page, 'signed-in')
})

test('3 進到後台：系辦首頁、右上角帳號選單有我的帳號與登出', async () => {
  await page.goto('/dashboard/admin')
  await expect(page.getByRole('heading', { name: '系辦首頁' })).toBeVisible()
  await shot(page, 'admin-dashboard')
  await page.getByRole('button', { name: '帳號選單' }).click()
  await expect(page.getByRole('menuitem', { name: '我的帳號' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '登出' })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('4 登出之後看不到後台', async () => {
  await signOut(page)
  await shot(page, 'signed-out')
  await expectDashboardBlocked(page)
  await shot(page, 'dashboard-blocked')
})

test('5 再登入一次，看得到系辦首頁', async () => {
  const { email, password } = adminCredentials()
  await signIn(page, email, password)
  await expect(page).not.toHaveURL(/\/login/)
  await page.goto('/dashboard/admin')
  await expect(page.getByRole('heading', { name: '系辦首頁' })).toBeVisible()
  await shot(page, 'signed-in-again')
})

test('6＋7 登出後用錯誤密碼（只試一次）登不進去', async () => {
  const { email } = adminCredentials()
  await page.goto('/dashboard/admin')
  await signOut(page)

  await signIn(page, email, `wrong-password-${Date.now()}`)
  await expect(page).toHaveURL(/\/login/)
  await expect(page.locator('p[role="alert"]')).toContainText('不正確')
  await shot(page, 'wrong-password')
  await expectDashboardBlocked(page)
})
