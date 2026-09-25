import { expect, test } from '@playwright/test'
import { seedA1 } from './session'

/**
 * S01-05：Roy 要親自走的那一條（票 #48 第 3 節）。
 *
 * A1 用一次性密碼登入 → 被逼改密 → 改密前進不了其他管理功能 → 改完進管理員首頁 →
 * 登出 → 舊密碼失效、新密碼登得回來。
 *
 * 整條路用**真的表單**走，不是打 API：使用者看得到的就是這個。
 */

test.describe.configure({ mode: 'serial' })

const A1_EMAIL = `a1-e2e-${Date.now()}@example.com`
const ONE_TIME_PASSWORD = 'One-Time-Password-9'
const NEW_PASSWORD = 'Roy-New-Password-2026'

test.beforeAll(() => {
  const output = seedA1(A1_EMAIL, ONE_TIME_PASSWORD)
  expect(output).toContain('A1 已建立')
  expect(output, 'seed 的輸出不能帶出密碼').not.toContain(ONE_TIME_PASSWORD)
})

async function signIn(page: import('@playwright/test').Page, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(A1_EMAIL)
  await page.getByLabel('密碼', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  // 等到真的離開登入頁（或看到錯誤訊息）再往下，不然後面的 goto 會跟這次導向搶。
  await Promise.race([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 }),
    page.locator('p[role="alert"]').waitFor({ timeout: 10_000 }),
  ])
}

test('A1 一次性密碼登入後被帶到改密頁，而且進不了其他管理功能', async ({ page }) => {
  await signIn(page, ONE_TIME_PASSWORD)

  await expect(page).toHaveURL(/\/account\/change-password$/)
  await expect(page.getByRole('heading', { name: '請先更改密碼' })).toBeVisible()

  // 改密之前直接開別的管理頁 → 被帶回改密頁。
  await page.goto('/dashboard/admin/cohorts')
  await expect(page).toHaveURL(/\/account\/change-password$/)

  await page.goto('/dashboard/admin')
  await expect(page).toHaveURL(/\/account\/change-password$/)
})

test('設定新密碼之後進得了管理員首頁', async ({ page }) => {
  await signIn(page, ONE_TIME_PASSWORD)
  await expect(page).toHaveURL(/\/account\/change-password$/)

  await page.getByLabel('目前的一次性密碼').fill(ONE_TIME_PASSWORD)
  await page.getByLabel('新密碼', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('再輸入一次新密碼').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: '設定新密碼' }).click()

  // 改完之後直接回自己的後台（票 8 起：改密後導向本人首頁，不再回公開首頁）。
  await expect(page).toHaveURL(/\/dashboard\/admin$/)
  await page.goto('/dashboard/admin')
  await expect(page.getByRole('heading', { name: '系辦首頁' })).toBeVisible()
  await expect(page.getByRole('link', { name: '屆別', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '帳號', exact: true })).toBeVisible()
})

test('新密碼太短或跟目前的一樣會被擋下', async ({ page }) => {
  await signIn(page, NEW_PASSWORD)
  await expect(page).toHaveURL(/\/dashboard\/admin$/)
  await page.goto('/account/change-password')

  await page.getByLabel('目前的密碼').fill(NEW_PASSWORD)
  await page.getByLabel('新密碼', { exact: true }).fill('short')
  await page.getByLabel('再輸入一次新密碼').fill('short')
  await page.getByRole('button', { name: '設定新密碼' }).click()
  await expect(page.locator('p[role="alert"]')).toContainText('至少')

  // 重新載入再試第二種情況：表單送出失敗後欄位狀態不保證，重來一次比較乾淨。
  await page.goto('/account/change-password')
  await page.getByLabel('目前的密碼').fill(NEW_PASSWORD)
  await page.getByLabel('新密碼', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('再輸入一次新密碼').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: '設定新密碼' }).click()
  await expect(page.locator('p[role="alert"]')).toContainText('不能跟目前的密碼一樣')

  // 兩次輸入不一致也擋得住。
  await page.goto('/account/change-password')
  await page.getByLabel('目前的密碼').fill(NEW_PASSWORD)
  await page.getByLabel('新密碼', { exact: true }).fill('Another-Long-Password-1')
  await page.getByLabel('再輸入一次新密碼').fill('Another-Long-Password-2')
  await page.getByRole('button', { name: '設定新密碼' }).click()
  await expect(page.locator('p[role="alert"]')).toContainText('兩次輸入的新密碼不一樣')
})

test('登出之後：舊的一次性密碼失效，新密碼登得回來', async ({ page }) => {
  await signIn(page, NEW_PASSWORD)
  await page.goto('/dashboard/admin')
  // 登出在右上角的帳號選單裡（原型的頭像下拉）。
  await page.getByRole('button', { name: '帳號選單' }).click()
  await page.getByRole('menuitem', { name: '登出' }).click()
  await expect(page).toHaveURL(/\/login$/)

  // 未登入不能直接進後台。
  await page.goto('/dashboard/admin')
  await expect(page).toHaveURL(/\/login\?next=/)

  // 舊的一次性密碼失效。
  await signIn(page, ONE_TIME_PASSWORD)
  await expect(page.locator('p[role="alert"]')).toContainText('不正確')

  // 新密碼可以，而且**直接進管理員首頁**、不再被要求改密。
  await signIn(page, NEW_PASSWORD)
  await expect(page).toHaveURL(/\/dashboard\/admin$/)
  await expect(page.getByRole('heading', { name: '系辦首頁' })).toBeVisible()
})
