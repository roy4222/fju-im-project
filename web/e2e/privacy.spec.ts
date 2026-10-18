import { expect, test } from '@playwright/test'
import { SITE_CONTACT } from '../src/app/_ui/site-contact'

/**
 * VB-11（AC-VI-70）：`/privacy` 隱私權政策頁。訪客不用登入就打得開，四個 h2，
 * 聯絡資訊來自 `SITE_CONTACT`（不寫死），保存年限寫「依校方規定」。
 */

test('未登入打開 /privacy：200、標題、四個 h2、保存年限依校方規定', async ({ page }) => {
  await page.context().clearCookies()
  const response = await page.goto('/privacy')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: '隱私權政策' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['我們蒐集哪些資料', '資料用在哪裡', '誰看得到', '聯絡我們'])
  await expect(page.getByText('依校方規定')).toBeVisible()
})

test('聯絡資訊來自 SITE_CONTACT', async ({ page }) => {
  await page.goto('/privacy')
  const contact = page.getByTestId('privacy-contact')
  await expect(contact).toContainText(SITE_CONTACT.department)
  await expect(contact).toContainText(SITE_CONTACT.address)
  await expect(contact.getByRole('link', { name: SITE_CONTACT.phone })).toHaveAttribute('href', SITE_CONTACT.phoneHref)
})

test('頁尾「隱私權政策」點得進 /privacy', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/')
  await page.getByRole('navigation', { name: '頁尾：使用' }).getByRole('link', { name: '隱私權政策' }).click()
  await expect(page).toHaveURL(/\/privacy$/)
  await expect(page.getByRole('heading', { level: 1, name: '隱私權政策' })).toBeVisible()
})
