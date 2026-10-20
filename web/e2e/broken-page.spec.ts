import { expect, test, type Page } from '@playwright/test'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 404／403「壞掉」頁（規格④ §6、C4-05；AC-39～AC-42）：`main` 整塊深藍、上緣三色線，
 * 「404」、標題、說明三段 FuzzyText（canvas，字是輔大三色漸層）；真文字一定在 DOM；「回首頁」偶爾抖。
 * 減少動態不掛 canvas，三段真文字帶 `.broken-text` 靜態三色漸層。
 *
 * `BROKEN_SHOTS=<資料夾>`：順便存 PR 用的截圖（404 桌機、手機、減少動態，403）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const MISSING = '/this-page-does-not-exist'
const TITLE = '找不到這個頁面'
const DESC = '網址可能打錯了，或這個內容已經下架。'
const SHOTS = process.env.BROKEN_SHOTS

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
}

/** 三段 FuzzyText 都畫好（canvas 出現、真文字改 sr-only）。 */
async function expectFuzzyReady(page: Page) {
  const fuzzy = page.getByTestId('fuzzy-text')
  await expect(fuzzy).toHaveCount(3)
  await expect(page.locator('[data-testid=fuzzy-text][data-ready] canvas')).toHaveCount(3)
}

/**
 * 「404」那個 canvas：找出有畫到的像素範圍，取左（0–15%）、中（45–55%）、右（85–100%）三段的平均顏色。
 * 字一直在抖，所以取一段的平均，不取單一點。
 */
async function codeCanvasColors(page: Page) {
  return page.locator('[data-testid=fuzzy-text] canvas').first().evaluate((el) => {
    const canvas = el as HTMLCanvasElement
    const { width, height } = canvas
    const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data
    let minX = width
    let maxX = -1
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (data[(y * width + x) * 4 + 3]! > 200) {
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
        }
    const band = (from: number, to: number) => {
      const x0 = Math.floor(minX + (maxX - minX) * from)
      const x1 = Math.ceil(minX + (maxX - minX) * to)
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = 0; y < height; y++)
        for (let x = x0; x <= x1; x++) {
          const i = (y * width + x) * 4
          if (data[i + 3]! <= 200) continue
          r += data[i]!
          g += data[i + 1]!
          b += data[i + 2]!
          n++
        }
      return n ? { r: r / n, g: g / n, b: b / n, n } : { r: 0, g: 0, b: 0, n }
    }
    return { left: band(0, 0.15), mid: band(0.45, 0.55), right: band(0.85, 1) }
  })
}

test('AC-39 訪客開不存在的網址：404、深藍 main、三段三色漸層 FuzzyText、真文字在 DOM、回首頁、頂列頁尾', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const res = await page.goto(MISSING)
  expect(res?.status()).toBe(404)
  await expect(page.getByTestId('not-found')).toBeVisible()
  await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(19, 48, 92)')
  await expect(page.getByTestId('broken-stripe')).toBeVisible()

  await expectFuzzyReady(page)
  for (const canvas of await page.locator('[data-testid=fuzzy-text] canvas').all()) {
    const gradient = (await canvas.getAttribute('data-gradient')) ?? ''
    for (const c of ['#E56E00', '#F1BA4B', '#8DB6E6']) expect(gradient).toContain(c)
    await expect(canvas).toHaveAttribute('aria-hidden', 'true')
  }

  const { left, mid, right } = await codeCanvasColors(page)
  for (const band of [left, mid, right]) expect(band.n).toBeGreaterThan(0)
  // 偏橘：紅多、綠中、藍很少；偏黃：紅綠都高、藍低；偏藍：藍比紅多。
  expect(left.r).toBeGreaterThan(200)
  expect(left.g).toBeLessThan(160)
  expect(left.b).toBeLessThan(60)
  expect(mid.r).toBeGreaterThan(200)
  expect(mid.g).toBeGreaterThan(160)
  expect(mid.b).toBeLessThan(140)
  expect(right.b).toBeGreaterThan(right.r)

  // 真文字（sr-only，不是 aria-label）
  await expect(page.locator('main h1')).toHaveText(TITLE)
  await expect(page.locator('main p').filter({ hasText: DESC })).toHaveCount(1)
  await expect(page.getByRole('heading', { name: TITLE })).toBeAttached()
  await expect(page.getByTestId('not-found').getByRole('link', { name: '回首頁' })).toHaveAttribute('href', '/')
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByRole('contentinfo')).toBeVisible()
  await shot(page, '404-desktop')
})

test('AC-39 手機寬度：三段字縮在畫面內', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'no-preference' })
  const page = await context.newPage()
  try {
    expect((await page.goto(MISSING))?.status()).toBe(404)
    await expectFuzzyReady(page)
    for (const canvas of await page.locator('[data-testid=fuzzy-text] canvas').all()) {
      const box = await canvas.boundingBox()
      expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
    }
    await shot(page, '404-mobile')
  } finally {
    await context.close()
  }
})

test('AC-40 學生開系辦後台（/403）與不存在的網址（404）：標題說明與三段 FuzzyText 相同，按鈕各自', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.context().clearCookies()
  const session = await sharedTestSession(page.request, 'student')
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])

  await page.goto('/dashboard/admin')
  await expect(page).toHaveURL(/\/403$/)
  await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(19, 48, 92)')
  await expectFuzzyReady(page)
  await expect(page.locator('main h1')).toHaveText(TITLE)
  await expect(page.locator('main p').filter({ hasText: DESC })).toHaveCount(1)
  await expect(page.getByTestId('not-found').getByRole('link', { name: '回到自己的首頁' })).toHaveAttribute('href', '/dashboard/student')
  await shot(page, '403-student')

  expect((await page.goto(MISSING))?.status()).toBe(404)
  await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(19, 48, 92)')
  await expectFuzzyReady(page)
  await expect(page.locator('main h1')).toHaveText(TITLE)
  await expect(page.locator('main p').filter({ hasText: DESC })).toHaveCount(1)
  await expect(page.getByTestId('not-found').getByRole('link', { name: '回首頁' })).toHaveAttribute('href', '/')
})

test('AC-41 404 頁等 8 秒：回首頁至少抖過一次，抖動中點它會到首頁', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const started = Date.now()
  await page.goto(MISSING)
  const link = page.getByTestId('not-found').getByRole('link', { name: '回首頁' })
  await expect(link).toBeVisible()
  // 首次抖動在引擎掛上後 4–7 秒、只持續 0.4 秒：expect 的重試間隔會拉到 1 秒，可能錯過，
  // 所以用 MutationObserver 在 class 加上的當下回報，並且當下就點（抖動中照樣可點）。
  const remaining = 8_000 - (Date.now() - started)
  const glitched = await link.evaluate(
    (el, ms) =>
      new Promise<boolean>((resolve) => {
        if (el.classList.contains('is-glitching')) return resolve(true)
        const mo = new MutationObserver(() => {
          if (!el.classList.contains('is-glitching')) return
          mo.disconnect()
          ;(el as HTMLAnchorElement).click()
          resolve(true)
        })
        mo.observe(el, { attributes: true, attributeFilter: ['class'] })
        setTimeout(() => {
          mo.disconnect()
          resolve(false)
        }, ms)
      }),
    remaining,
  )
  expect(glitched, '8 秒內回首頁要至少抖過一次').toBe(true)
  await expect(page).toHaveURL(`${BASE_URL}/`)
})

test('AC-42 減少動態：沒有 canvas，三段真文字可見且是靜態三色漸層，上緣三色線在，回首頁不抖', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect((await page.goto(MISSING))?.status()).toBe(404)
  await expect(page.getByTestId('fuzzy-text')).toHaveCount(3)
  await expect(page.locator('[data-testid=fuzzy-text] canvas')).toHaveCount(0)
  await expect(page.getByTestId('broken-stripe')).toBeVisible()
  for (const text of await page.locator('[data-testid=fuzzy-text] > .broken-text').all()) {
    await expect(text).toBeVisible()
    const box = await text.boundingBox()
    expect(box && box.width > 20 && box.height > 10).toBe(true)
    const style = await text.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { image: cs.backgroundImage, clip: cs.getPropertyValue('-webkit-background-clip') || cs.backgroundClip }
    })
    expect(style.image).toContain('linear-gradient')
    expect(style.clip).toBe('text')
  }
  await expect(page.locator('main h1')).toHaveText(TITLE)
  await expect(page.locator('main').getByText('404', { exact: true })).toBeVisible()
  await shot(page, '404-reduced-motion')
  // 超過一輪最長間隔（7 秒）都不抖。
  const link = page.getByTestId('not-found').getByRole('link', { name: '回首頁' })
  const glitched = await link.evaluate(
    (el) =>
      new Promise<boolean>((resolve) => {
        const mo = new MutationObserver(() => {
          if (el.classList.contains('is-glitching')) resolve(true)
        })
        mo.observe(el, { attributes: true, attributeFilter: ['class'] })
        setTimeout(() => {
          mo.disconnect()
          resolve(el.classList.contains('is-glitching'))
        }, 7_500)
      }),
  )
  expect(glitched).toBe(false)
})
