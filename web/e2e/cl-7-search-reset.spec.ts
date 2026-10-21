import { expect, test, type Locator, type Page } from '@playwright/test'
import { sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

/**
 * CL-7（第 1 條，fju/default-value-needs-key）：網址參數帶進來的搜尋框，站內換頁把 `q` 拿掉後不留舊字。
 *
 * 搜尋框是不受控欄位（`defaultValue={q}`）。站內 `<Link>` 換到同一頁、只是查詢字串不同時，React 沿用舊的 DOM：
 * 沒有 `key={q}` 的話網址已經沒有 q、清單也是全部，框裡卻還留著上一次的字。
 *
 * 每支都先在頁面上做記號，換頁後確認記號還在（真的是站內換頁、不是整頁重載——整頁重載本來就會清掉）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const OLD = 'cl7-舊字'

async function signIn(page: Page, role: TestRole) {
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, role)).cookie, BASE_URL)])
}

async function expectClearedAfterClientNav(page: Page, url: string, box: () => Locator, navigate: () => Promise<void>) {
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}q=${encodeURIComponent(OLD)}`)
  await expect(box()).toHaveValue(OLD)
  await page.evaluate(() => { (window as unknown as { __cl7: number }).__cl7 = 1 })
  await navigate()
  await expect.poll(() => new URL(page.url()).searchParams.get('q'), { timeout: 10_000, message: '換頁後網址還帶著 q' }).toBeNull()
  expect(await page.evaluate(() => (window as unknown as { __cl7?: number }).__cl7), '應該是站內換頁（沒有整頁重載）').toBe(1)
  await expect(box()).toHaveValue('')
}

const mainNav = (page: Page) => page.getByRole('navigation', { name: '主導覽' })

test('公告列表：點主導覽「最新公告」回到 /news，搜尋框清空', async ({ page }) => {
  await expectClearedAfterClientNav(
    page,
    '/news',
    () => page.getByRole('searchbox', { name: '搜尋公告' }),
    () => mainNav(page).getByRole('link', { name: '最新公告' }).click(),
  )
})

test('檔案下載：點主導覽「檔案下載」，搜尋框清空', async ({ page }) => {
  await signIn(page, 'student')
  await expectClearedAfterClientNav(
    page,
    '/files',
    () => page.getByRole('searchbox', { name: '搜尋資源' }),
    () => mainNav(page).getByRole('link', { name: '檔案下載' }).click(),
  )
})

test('產學合作：點主導覽「產學合作」，搜尋框清空、排序回預設', async ({ page }) => {
  await signIn(page, 'student')
  const sort = page.locator('#industry-sort')
  await page.goto('/industry')
  const defaultSort = await sort.inputValue()
  const other = await sort.locator('option').evaluateAll((os, d) => (os as HTMLOptionElement[]).map((o) => o.value).find((v) => v !== d)!, defaultSort)
  await expectClearedAfterClientNav(
    page,
    `/industry?sort=${encodeURIComponent(other)}`,
    () => page.getByRole('searchbox', { name: '搜尋合作案' }),
    () => mainNav(page).getByRole('link', { name: '產學合作' }).click(),
  )
  await expect(sort).toHaveValue(defaultSort)
})

for (const path of ['/dashboard/admin/accounts', '/dashboard/admin/accounts/disabled']) {
  test(`帳號（${path}）：按「清除條件」，搜尋框清空`, async ({ page }) => {
    await signIn(page, 'admin')
    await expectClearedAfterClientNav(
      page,
      path,
      () => page.getByRole('search', { name: '篩選帳號' }).getByRole('searchbox'),
      () => page.getByRole('link', { name: '清除條件' }).click(),
    )
  })
}

test('系辦公告管理：點「種類」換到別的分類（連結拿掉 q），搜尋框清空', async ({ page }) => {
  await signIn(page, 'admin')
  await expectClearedAfterClientNav(
    page,
    '/dashboard/admin/affairs?placement=news',
    () => page.locator('form[action="/dashboard/admin/affairs"] input[name="q"]'),
    () => page.getByRole('navigation', { name: '種類' }).getByRole('link', { name: '全部' }).click(),
  )
})

test('學生找隊員：再點「找隊員」分頁（連結拿掉 q），搜尋框清空', async ({ page }) => {
  await signIn(page, 'student')
  await expectClearedAfterClientNav(
    page,
    '/dashboard/student/groups?tab=team',
    () => page.getByRole('searchbox', { name: '搜尋姓名、學號或技能' }),
    () => page.getByRole('navigation', { name: '組別分頁' }).getByRole('link', { name: '找隊員' }).click(),
  )
})
