import { expect, test } from '@playwright/test'

/**
 * VB-11（AC-VI-70）：`/privacy` 隱私權政策頁。訪客不用登入就打得開，有四段文案，保存年限寫「依校方規定」。
 */

test('未登入打開 /privacy：200、標題、四段、保存年限依校方規定', async ({ page }) => {
  await page.context().clearCookies()
  const response = await page.goto('/privacy')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: '隱私權政策' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(4)
  await expect(page.getByText('依校方規定')).toBeVisible()
})

test('頁尾「隱私權政策」點得進 /privacy', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/')
  await page.getByRole('navigation', { name: '頁尾：使用' }).getByRole('link', { name: '隱私權政策' }).click()
  await expect(page).toHaveURL(/\/privacy$/)
  await expect(page.getByRole('heading', { level: 1, name: '隱私權政策' })).toBeVisible()
})
