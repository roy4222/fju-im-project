import { expect, test, type Browser, type Page } from '@playwright/test'
import { createTestSession, grantExtraRole, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 41（ACC-10 部分）：老師兼系辦的後台切換。
 *
 * - 兼任者：後台頂列帳號選單有「切換到系辦後台／老師後台」，點了就到另一個後台；前台帳號選單兩個後台都列。
 * - 只有一個角色的老師：選單沒有任何「切換到」；直接打系辦後台照樣被擋到 /403（切換只是導覽，不授權）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

async function pageAs(browser: Browser, session: TestSession): Promise<Page> {
  const context = await browser.newContext()
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  return context.newPage()
}

async function openAccountMenu(page: Page) {
  await page.getByRole('button', { name: '帳號選單' }).click()
  return page.getByRole('menu')
}

test('老師兼系辦：在兩個後台之間用帳號選單切換', async ({ browser, playwright }) => {
  const seeder = await playwright.request.newContext({ baseURL: BASE_URL })
  const dual = await createTestSession(seeder, 'teacher')
  await seeder.dispose()
  await grantExtraRole(dual.userId, 'admin')
  const page = await pageAs(browser, dual)

  await page.goto('/dashboard/teacher')
  let menu = await openAccountMenu(page)
  await expect(menu.getByRole('menuitem', { name: /切換到/ })).toHaveCount(1)
  await menu.getByRole('menuitem', { name: '切換到系辦後台' }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin$/)

  menu = await openAccountMenu(page)
  await expect(menu.getByRole('menuitem', { name: /切換到/ })).toHaveCount(1)
  await menu.getByRole('menuitem', { name: '切換到老師後台' }).click()
  await expect(page).toHaveURL(/\/dashboard\/teacher$/)

  // 前台：「回後台」按鈕去預設的系辦後台，帳號選單兩個後台都列。
  await page.goto('/')
  await expect(page.getByRole('banner').getByRole('link', { name: '管理後台', exact: true })).toHaveAttribute('href', '/dashboard/admin')
  menu = await openAccountMenu(page)
  await expect(menu.getByRole('menuitem', { name: '管理後台' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '老師工作台' })).toBeVisible()
})

test('只有老師角色：帳號選單沒有切換，直接打系辦後台被擋', async ({ browser, page: seedPage }) => {
  const teacher = await sharedTestSession(seedPage.request, 'teacher')
  const page = await pageAs(browser, teacher)

  await page.goto('/dashboard/teacher')
  const menu = await openAccountMenu(page)
  await expect(menu.getByRole('menuitem', { name: '我的帳號' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /切換到/ })).toHaveCount(0)

  await page.goto('/dashboard/admin')
  await expect(page).toHaveURL(/\/403$/)

  await page.goto('/')
  const front = await openAccountMenu(page)
  await expect(front.getByRole('menuitem', { name: '老師工作台' })).toBeVisible()
  await expect(front.getByRole('menuitem', { name: '管理後台' })).toHaveCount(0)
})
