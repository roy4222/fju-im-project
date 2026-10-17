import { expect, test } from '@playwright/test'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * AD-20：系辦設定總頁 `/dashboard/admin/settings`（AC-AD-36；Q104）。
 *
 * h1「設定」＋四張卡（屆別、時間軸、首頁設定、操作紀錄），各一句說明，點下去分別到既有路由；總頁沒有分頁列。
 * 非系辦的三種回應（未登入、老師、系辦）在 pages.spec 的 FINGERPRINTS／PROTECTED 那一列驗（AC-AD-18）。
 * 側欄「設定」連到這頁由共用 SH-1-AD 切換時驗，這裡不驗側欄。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const SETTINGS = '/dashboard/admin/settings'

const CARDS = [
  { title: '屆別', hint: '一屆的開始、旗標與轉為進行中', path: '/dashboard/admin/cohorts' },
  { title: '時間軸', hint: '四個階段與活動日期', path: '/dashboard/admin/timeline' },
  { title: '首頁設定', hint: '前台首頁大圖與標語', path: '/dashboard/admin/home-settings' },
  { title: '操作紀錄', hint: '誰在什麼時候做了什麼', path: '/dashboard/admin/audit' },
]

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
})

test('AC-AD-36：h1「設定」、四張卡各一句說明、沒有分頁列', async ({ page }) => {
  const response = await page.goto(SETTINGS)
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: '設定' })).toBeVisible()

  const cards = page.getByRole('list', { name: '設定項目' }).getByRole('link')
  await expect(cards).toHaveCount(4)
  for (const [i, card] of CARDS.entries()) {
    const link = cards.nth(i)
    await expect(link).toContainText(card.title)
    await expect(link).toContainText(card.hint)
    await expect(link).toHaveAttribute('href', card.path)
  }

  // 總頁只是入口：四個子頁的「設定分頁」列不在這頁，也沒有其他分頁列。
  await expect(page.locator('main nav[aria-label$="分頁"]')).toHaveCount(0)
})

for (const card of CARDS) {
  test(`AC-AD-36：點「${card.title}」卡到 ${card.path}`, async ({ page }) => {
    await page.goto(SETTINGS)
    await page.getByRole('list', { name: '設定項目' }).getByRole('link', { name: new RegExp(`^${card.title}`) }).click()
    await expect(page).toHaveURL(new RegExp(`${card.path}$`))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })
}
