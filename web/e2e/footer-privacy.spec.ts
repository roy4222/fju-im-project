import { expect, test, type Page } from '@playwright/test'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * SH-B8（AC-SH-81；訪客 N1）：頁尾「使用」欄最後一個連結是「隱私權政策」，連到 `/privacy`，登入與未登入都有。
 *
 * `/privacy` 頁由 VB-11 做，合併前會 404；這裡只驗連結存在與 href，不點進去。
 * 後台（`DashboardShell`）沒有頁尾，登入的分支用走 `SiteShell` 的首頁驗。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

async function expectPrivacyLast(page: Page) {
  const last = page.getByRole('navigation', { name: '頁尾：使用' }).getByRole('link').last()
  await expect(last).toHaveText('隱私權政策')
  await expect(last).toHaveAttribute('href', '/privacy')
}

test('未登入：首頁頁尾「使用」欄最後是隱私權政策', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '頁尾：使用' }).getByRole('link', { name: '登入' })).toBeVisible()
  await expectPrivacyLast(page)
})

test('學生登入：首頁頁尾「使用」欄最後是隱私權政策', async ({ page }) => {
  const session = await sharedTestSession(page.request, 'student')
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '頁尾：使用' }).getByRole('link', { name: '我的後台' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '頁尾：使用' }).getByRole('link', { name: '我的帳號' })).toHaveCount(0)
  await expectPrivacyLast(page)
})
