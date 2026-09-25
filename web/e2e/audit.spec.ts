import { expect, test, type Page } from '@playwright/test'
import { sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

/**
 * 票 36：系辦「操作紀錄」頁（原型 `/dashboard/admin/audit`；模組 10「依角色篩選，每筆有時間、人、動作、對象、理由；不可修改」）。
 *
 * 1. 管理員做一件會留紀錄的事（新增屆別），操作紀錄最上面看得到：動作「新增屆別」、對象是那一屆、操作者有名字。
 * 2. 依角色分頁：「管理員」分頁看得到、「學生」分頁沒有這一筆；網址帶著分頁，重新整理不會丟。
 * 3. 頁面沒有任何修改入口（只讀）。
 * 非管理員被擋在 `pages.spec` 逐條驗 `PROTECTED_ROUTES`（這一頁已登記）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const stamp = Date.now().toString(36).toUpperCase()
const CODE = `E2E-AU-${stamp}`

async function signIn(page: Page, role: TestRole) {
  const session = await sharedTestSession(page.request, role)
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

test('管理員新增屆別後，操作紀錄看得到；角色分頁照網址篩選；頁面只讀', async ({ page }) => {
  await signIn(page, 'admin')
  await page.goto('/dashboard/admin/cohorts')
  await page.getByLabel('代碼').fill(CODE)
  await page.getByLabel('名稱').fill(`${CODE} 操作紀錄測試`)
  await page.getByRole('button', { name: '新增屆別' }).click()
  await expect(page.getByRole('main').getByRole('status')).toContainText(CODE)

  await page.goto('/dashboard/admin/audit')
  await expect(page.getByRole('heading', { name: '操作紀錄', exact: true })).toBeVisible()
  const entry = page.getByTestId('audit-entry').filter({ hasText: `屆別・${CODE}` })
  await expect(entry).toHaveCount(1)
  await expect(entry).toContainText('新增屆別')

  const tabs = page.getByRole('navigation', { name: '依角色篩選' })
  await tabs.getByRole('link', { name: /^管理員/ }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/audit\?role=admin$/)
  await expect(tabs.getByRole('link', { name: /^管理員/ })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('audit-entry').filter({ hasText: `屆別・${CODE}` })).toHaveCount(1)

  await page.goto('/dashboard/admin/audit?role=student')
  await expect(page.getByTestId('audit-entry').filter({ hasText: `屆別・${CODE}` })).toHaveCount(0)

  // 只讀：清單區塊裡沒有按鈕、沒有表單。
  const events = page.getByRole('region', { name: '事件' })
  await expect(events.getByRole('button')).toHaveCount(0)
  await expect(events.locator('form')).toHaveCount(0)
})

test('學生與老師打開操作紀錄被擋，拿不到任何一筆', async ({ page }) => {
  for (const role of ['student', 'teacher'] as const) {
    await page.context().clearCookies()
    await signIn(page, role)
    await page.goto('/dashboard/admin/audit')
    await expect(page.getByTestId('audit-entry')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '操作紀錄', exact: true })).toHaveCount(0)
  }
})
