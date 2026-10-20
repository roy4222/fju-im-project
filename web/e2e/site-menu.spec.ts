import { expect, test, type Page } from '@playwright/test'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 前台導覽列（C4-09，規格④ 設計方案 §5、§8 原因 C、§10）：手機 Staggered Menu、1024 寬登入後頂列、logo 彩蛋。
 * AC-33～AC-38、AC-49～AC-53。`SITE_MENU_SHOTS=<資料夾>` 時留截圖給 PR。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const SHOTS = process.env.SITE_MENU_SHOTS
const EGG = '恭喜發現彩蛋！資管系祝你專題順利 🎉'

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** 記下瀏覽器載入過的 JS 裡，有沒有 FlyingButton 那個 chunk（內容含 `flying-button`）。 */
function watchFlyingChunk(page: Page) {
  const hits: string[] = []
  page.on('response', async (res) => {
    if (!res.url().endsWith('.js')) return
    const body = await res.text().catch(() => '')
    if (body.includes('flying-button')) hits.push(res.url())
  })
  return hits
}

const logo = (page: Page) => page.locator('header a[data-egg-count]')

test.describe('手機選單 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('AC-33 開選單：dialog＋三層色塊；AC-34 Tab 循環、Esc 關回焦點；AC-35 點選項導向並關', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/')
    const trigger = page.getByRole('button', { name: '開啟選單' })
    await trigger.click()

    const dialog = page.locator('dialog[open]')
    await expect(dialog).toHaveCount(1)
    await expect(dialog.getByRole('navigation', { name: '主導覽（手機）' })).toBeVisible()
    await expect(dialog.locator('.sm-layer')).toHaveCount(3)
    await expect(dialog).toHaveAttribute('data-open', '1')
    const header = page.locator('header')
    await expect(header.locator('button.sm-trigger')).toHaveAttribute('aria-expanded', 'true')
    await expect(header.locator('button.sm-trigger')).toHaveAttribute('aria-label', '關閉選單')
    await page.waitForTimeout(900)
    await shot(page, 'menu-open')

    // AC-34：從第一項 Tab 到最後一項，再按一次回到第一項。
    const items = dialog.locator('a[href], button')
    const count = await items.count()
    await items.first().focus()
    for (let i = 1; i < count; i++) await page.keyboard.press('Tab')
    await expect(items.last()).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(items.first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')

    // AC-35
    await trigger.click()
    await page.locator('dialog[open]').getByRole('link', { name: '專題規則' }).click()
    await expect(page).toHaveURL(/\/rules$/)
    await expect(page.locator('dialog[open]')).toHaveCount(0)
  })

  test('AC-36 減少動態：沒有色塊層，面板照樣看得到', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await page.getByRole('button', { name: '開啟選單' }).click()
    const dialog = page.locator('dialog[open]')
    await expect(dialog.locator('.sm-layer')).toHaveCount(0)
    await expect(dialog.locator('.sm-panel')).toBeVisible()
    await expect(dialog.getByRole('link', { name: '專題規則' })).toBeVisible()
  })
})

test('AC-37 1024：學生登入後頂列不溢出；訪客主導覽仍展開', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '主導覽', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '開啟選單' })).toBeHidden()

  const session = await sharedTestSession(page.request, 'student')
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto('/')
  const width = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(width).toBeLessThanOrEqual(1024)
  const overflow = await page.locator('header').evaluate((h) =>
    [...h.querySelectorAll('a, button')].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.right > window.innerWidth
    }).length,
  )
  expect(overflow).toBe(0)
  await shot(page, 'header-1024-student')
  // 「我的後台」在 1024～1279 收進選單（設計方案 §8 原因 C）。
  await page.getByRole('button', { name: '開啟選單' }).click()
  await expect(page.locator('dialog[open]').getByRole('link', { name: '我的後台' })).toBeVisible()
})

test('AC-38 1280：主導覽展開、漢堡隱藏', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '主導覽', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '開啟選單' })).toBeHidden()
})

test.describe('logo 彩蛋', () => {
  test('AC-53 載入首頁不點：沒有 FlyingButton chunk', async ({ page }) => {
    const hits = watchFlyingChunk(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    expect(hits).toEqual([])
  })

  test('AC-49 5 秒內點 10 次：第 3 下起晃、第 10 下訊息＋FlyingButton；網址不變、沒有骨架', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const hits = watchFlyingChunk(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const egg = logo(page)
    for (let i = 1; i <= 2; i++) await egg.click()
    await expect(egg).toHaveAttribute('data-egg-count', '2')
    await expect(egg).not.toHaveClass(/is-shaking/)
    await egg.click()
    await expect(egg).toHaveClass(/is-shaking/)
    await shot(page, 'egg-shaking')
    for (let i = 4; i <= 10; i++) await egg.click()
    await expect(page.getByTestId('easter-egg')).toHaveText(EGG)
    await expect(page.locator('[data-fx=flying-button] canvas')).toHaveCount(1)
    await page.waitForTimeout(700)
    await shot(page, 'egg-flying')
    await expect(page).toHaveURL(`${BASE_URL}/`)
    await expect(page.locator('html[data-nav-pending]')).toHaveCount(0)
    expect(hits.length).toBe(1)
  })

  test('AC-50 點 2 次等 6 秒再點：計數歸零，第 3 下不晃', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/')
    const egg = logo(page)
    await egg.click()
    await egg.click()
    await page.waitForTimeout(6000)
    await egg.click()
    await expect(egg).toHaveAttribute('data-egg-count', '1')
    await expect(egg).not.toHaveClass(/is-shaking/)
  })

  test('AC-51 在 /rules 點 logo 一次：回首頁、計數 0', async ({ page }) => {
    await page.goto('/rules')
    await logo(page).click()
    await expect(page).toHaveURL(`${BASE_URL}/`)
    await expect(logo(page)).toHaveAttribute('data-egg-count', '0')
  })

  test('AC-52 減少動態點 10 次：只有訊息，沒有 canvas、沒下載 FlyingButton', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const hits = watchFlyingChunk(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const egg = logo(page)
    for (let i = 1; i <= 10; i++) await egg.click()
    await expect(page.getByTestId('easter-egg')).toHaveText(EGG)
    await page.waitForTimeout(500)
    await expect(page.locator('[data-fx=flying-button]')).toHaveCount(0)
    expect(hits).toEqual([])
  })
})
