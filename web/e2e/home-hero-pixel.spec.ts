import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { createTestSession, type TestSession } from './session'

/**
 * 前台首頁橫幅淡像素＋區塊標題出血修正（規格④ C4-08，AC-16～AC-20）。
 * 像素層 client 掛上後才有 canvas（SSR 只有照片＋漸層），所以都用 `expect` 等它出現。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const PASSWORD = 'E2e-Password-Correct-9'

const hero = (page: Page) => page.locator('section[aria-label="專題管理平台"]')

/** 首頁橫幅：照片在、像素層恰好一個 canvas、像素層壓在文字底下、標題看得到。 */
async function expectPixelHero(page: Page) {
  const section = hero(page)
  await expect(section.locator('img[data-testid=home-hero-image]')).toHaveCount(1)
  await expect(section.locator('[data-testid=home-hero-pixel] canvas')).toHaveCount(1)
  await expect(section.locator('h1.type-display')).toBeVisible()
  const order = await section.evaluate((root) => {
    const pixel = root.querySelector<HTMLElement>('[data-testid=home-hero-pixel]')!
    const h1 = root.querySelector('h1')!
    // h1 自己沒有 z-index，它的層級是 hero 底下那個「文字層」直系子元素的 z-index。
    const textLayer = [...root.children].find((child) => child.contains(h1)) as HTMLElement
    const gradient = pixel.previousElementSibling as HTMLElement
    const z = (el: Element) => getComputedStyle(el).zIndex
    return {
      pixel: Number(z(pixel)),
      text: Number(z(textLayer)),
      afterGradient: gradient.className.includes('bg-gradient-to-r'),
      pointerEvents: getComputedStyle(pixel).pointerEvents,
    }
  })
  expect(order.afterGradient).toBe(true)
  expect(order.pixel).toBeLessThan(order.text)
  expect(order.pointerEvents).toBe('none')
}

test('AC-16：訪客首頁橫幅有淡像素層，在漸層之上、文字之下', async ({ page }) => {
  await page.goto('/')
  await expectPixelHero(page)
  await expect(hero(page).getByTestId('home-hero-pixel')).toHaveAttribute('data-running', '1')
})

test('AC-17：像素層「淡」——畫面上任一點不透明度不超過 50%', async ({ page }) => {
  await page.goto('/')
  const layer = hero(page).getByTestId('home-hero-pixel')
  await expect(layer).toHaveAttribute('data-running', '1')
  // 淡入 300 ms 結束後，整層的不透明度（CSS）× canvas 像素的 alpha 才是畫面上看到的。
  await page.waitForTimeout(600)
  const result = await layer.evaluate((root) => {
    const canvas = root.querySelector('canvas')!
    const ctx = canvas.getContext('2d')!
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let maxAlpha = 0
    let painted = 0
    for (let i = 3; i < data.length; i += 4 * 7) {
      const alpha = data[i] ?? 0
      if (alpha > 0) painted++
      maxAlpha = Math.max(maxAlpha, alpha)
    }
    return { layerOpacity: Number(getComputedStyle(root).opacity), maxAlpha: maxAlpha / 255, painted }
  })
  expect(result.painted, '要真的有畫出像素').toBeGreaterThan(0)
  expect(result.layerOpacity).toBeLessThanOrEqual(0.5)
  expect(result.layerOpacity * result.maxAlpha).toBeLessThanOrEqual(0.5)
})

test.describe('AC-18：開了減少動態', () => {
  test.use({ reducedMotion: 'reduce' })

  test('沒有 canvas，照片與漸層照舊', async ({ page }) => {
    await page.goto('/')
    const section = hero(page)
    await expect(section.locator('img[data-testid=home-hero-image]')).toHaveCount(1)
    await expect(section.locator('.bg-gradient-to-r')).toHaveCount(1)
    await expect(section.locator('h1')).toBeVisible()
    // 等 hydration 完（有 hydration 才可能掛像素層），再確認沒掛。
    await page.waitForLoadState('networkidle')
    await expect(section.locator('canvas')).toHaveCount(0)
    await expect(section.getByTestId('home-hero-pixel')).toHaveCount(0)
  })
})

test('AC-19：系辦（fju_office=1）在前台編輯模式的首頁也有像素層，橫幅編輯鈕可點', async ({ page }) => {
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
  const admin: TestSession = await createTestSession(api, 'admin')
  await api.dispose()
  // 要從登入頁用密碼登入，才會設 `fju_office` 提示 cookie（proxy 才會把 `/` 改寫到 `/office-edit`）。
  await page.goto('/login')
  await page.getByLabel('Email').fill(admin.email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
  expect((await page.context().cookies()).some((c) => c.name === 'fju_office' && c.value === '1')).toBe(true)

  await page.goto('/')
  await expectPixelHero(page)
  await page.getByRole('button', { name: '編輯頁面' }).click()
  const layer = page.getByTestId('front-edit-layer')
  await expect(layer).toBeAttached()
  await layer.getByRole('button', { name: '編輯「首頁橫幅」' }).click()
  await expect(page.getByRole('dialog', { name: '編輯首頁橫幅' })).toBeVisible()
})

// 1024：PanelTitle 不在中寬出血；1280、1440：xl 才出血的左側標題板仍在版心內，右側（鋪滿全寬的格線裡）不外推。
for (const width of [1024, 1280, 1440]) {
  test.describe(`AC-20：${width} 寬`, () => {
    test.use({ viewport: { width, height: 800 } })

    test('關掉 overflow 遮罩後頁面寬度不超過視窗（區塊標題不出血）', async ({ page }) => {
      await page.goto('/')
      await expect(page.locator('#home-news')).toBeVisible()
      await expect(page.locator('#home-honors')).toBeVisible()
      // 正式站 CSP 擋行內 <style>，用 CSSOM 把 html／body／main 的橫向遮罩關掉，量真實寬度。
      const size = await page.evaluate(() => {
        for (const el of [document.documentElement, document.body, ...document.querySelectorAll('main')]) {
          ;(el as HTMLElement).style.setProperty('overflow-x', 'visible', 'important')
        }
        return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }
      })
      expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth + 1)
    })
  })
}
