import { expect, test, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie } from './session'

/**
 * C4-07 登入／註冊群組外觀（規格④ §4；驗收案例 AC-21～AC-32、AC-64）。
 *
 * - 背景 LetterGlitch 在 `login`／`register`／`reset-password` 的 layout；照片與頁尾拿掉，頂列保留。
 * - 寄信走擷取模式（`MAIL_CAPTURE=1`）：註冊驗證碼從 `mail_outbox` 取。
 * - 每個 context 帶自己的 `X-Real-IP`，不跟其他 spec 搶限速桶。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const run = Date.now().toString(36)
const PASSWORD = 'C4-07-Password-Correct'
const DEEP_BLUE = 'rgb(19, 48, 92)'

test.describe.configure({ mode: 'serial' })

let pool: Pool
test.beforeAll(() => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能讀 mail_outbox')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
})
test.afterAll(async () => {
  await pool?.end()
})

let ipCounter = 0
function uniqueIp(): string {
  ipCounter += 1
  return `10.247.${Math.floor(Math.random() * 250)}.${(ipCounter % 250) + 1}`
}

async function guest(browser: Browser, options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { 'x-real-ip': uniqueIp() },
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'no-preference',
    ...options,
  })
  return context.newPage()
}

const glitch = (page: Page) => page.getByTestId('letter-glitch')
const progress = (page: Page) => page.locator('ol[aria-label="註冊進度"]')

/** 任何 CSS 顏色（含 oklch）轉成 `rgb(r, g, b)`：畫到 1×1 canvas 再讀回來。 */
async function bgRgb(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const ctx = c.getContext('2d')!
    ctx.fillStyle = getComputedStyle(el).backgroundColor
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `rgb(${r}, ${g}, ${b})`
  })
}

/** AC-21／AC-30 共通：沒有照片與頁尾、頂列在、背景 canvas 1 個深藍底、白卡置中最寬 440。 */
async function expectStage(page: Page) {
  await expect(page.locator('main img')).toHaveCount(0)
  await expect(page.locator('footer')).toHaveCount(0)
  await expect(page.getByRole('contentinfo')).toHaveCount(0)
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.locator('[data-testid=letter-glitch] canvas')).toHaveCount(1)
  await expect(glitch(page)).toHaveCSS('background-color', DEEP_BLUE)
  const card = page.locator('.auth-card')
  await expect(card).toHaveCSS('max-width', '440px')
  const gaps = await card.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: document.documentElement.clientWidth - r.right }
  })
  expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(2)
}

/** AC-64：沒有 CSP 違規；`.auth-card` 內沒有 style 屬性。 */
function watchCsp(page: Page): string[] {
  const violations: string[] = []
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text())
  })
  return violations
}

test('AC-21／AC-22／AC-64 /login：沒有照片與頁尾、LetterGlitch 背景、白卡置中、登入鈕 #E56E00、沒有 CSP 違規', async ({ browser }) => {
  const page = await guest(browser)
  const violations = watchCsp(page)
  await page.goto('/login')
  await expectStage(page)
  expect(await bgRgb(page.getByTestId('login-card').getByRole('button', { name: '登入', exact: true }))).toBe('rgb(229, 110, 0)')
  expect(await page.locator('.auth-card [style]').count()).toBe(0)
  await expect(glitch(page)).toHaveAttribute('data-running', '1')
  expect(violations).toEqual([])
  await page.context().close()
})

test('AC-23 canvas 前 3 欄：黃、橘、淺藍（逐欄交錯）', async ({ browser }) => {
  const page = await guest(browser)
  await page.goto('/login')
  await expect(glitch(page)).toHaveAttribute('data-grid', '14')
  // 取樣：每欄所有不透明像素的平均色相（getImageData 是未預乘的顏色）。
  const hues = await page.locator('[data-testid=letter-glitch] canvas').evaluate((canvas: HTMLCanvasElement) => {
    const cell = canvas.width / canvas.clientWidth * 14
    const c = document.createElement('canvas')
    c.width = canvas.width
    c.height = canvas.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(canvas, 0, 0)
    return [0, 1, 2].map((col) => {
      const data = ctx.getImageData(Math.round(col * cell), 0, Math.floor(cell), c.height).data
      let r = 0, g = 0, b = 0, n = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]! < 40) continue
        r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n += 1
      }
      r /= n; g /= n; b /= n
      const max = Math.max(r, g, b), min = Math.min(r, g, b)
      let h = 0
      if (max === r) h = 60 * (((g - b) / (max - min)) % 6)
      else if (max === g) h = 60 * ((b - r) / (max - min) + 2)
      else h = 60 * ((r - g) / (max - min) + 4)
      return { hue: (h + 360) % 360, n }
    })
  })
  for (const h of hues) expect(h.n).toBeGreaterThan(0)
  expect(hues[0]!.hue).toBeGreaterThan(35)
  expect(hues[0]!.hue).toBeLessThan(55)
  expect(hues[1]!.hue).toBeGreaterThan(18)
  expect(hues[1]!.hue).toBeLessThan(35)
  expect(hues[2]!.hue).toBeGreaterThan(195)
  expect(hues[2]!.hue).toBeLessThan(230)
  await page.context().close()
})

test('AC-24 減少動態：沒有 canvas、靜態字元紋理、底色 #13305C', async ({ browser }) => {
  const page = await guest(browser, { reducedMotion: 'reduce' })
  await page.goto('/login')
  await expect(page.locator('.auth-glitch-static')).toHaveCount(1)
  await expect(glitch(page)).toHaveClass(/auth-glitch-static/)
  await expect(glitch(page)).toHaveCSS('background-color', DEEP_BLUE)
  await expect(glitch(page)).toHaveCSS('background-image', /^url\("data:image\/svg\+xml/)
  await page.waitForTimeout(500)
  await expect(page.locator('canvas')).toHaveCount(0)
  await page.context().close()
})

test('AC-25／AC-31 390×844 觸控：canvas 1、格 18、20 fps；白卡不超出、不橫捲；兩個連結 14 px、高 ≥ 44', async ({ browser }) => {
  const page = await guest(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await page.goto('/login')
  await expect(page.locator('[data-testid=letter-glitch] canvas')).toHaveCount(1)
  await expect(glitch(page)).toHaveAttribute('data-grid', '18')
  await expect(glitch(page)).toHaveAttribute('data-fps', '20')
  const width = await page.locator('.auth-card').evaluate((el) => el.getBoundingClientRect().width)
  expect(width).toBeLessThanOrEqual(390 - 32)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  for (const link of [page.locator('a[href="/forgot-password"]'), page.getByTestId('register-hint').getByRole('link', { name: '註冊' })]) {
    await expect(link).toHaveCSS('font-size', '14px')
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
  await page.context().close()
})

test('AC-30 忘記密碼模式、重設密碼頁：同一套背景與卡片', async ({ browser }) => {
  const page = await guest(browser)
  await page.goto('/login?mode=forgot')
  await expect(page.getByTestId('login-card')).toHaveAttribute('data-mode', 'forgot')
  await expectStage(page)
  await page.goto('/reset-password?token=c4-07-not-a-real-token')
  await expectStage(page)
  await page.context().close()
})

test('AC-32 切到別的分頁：背景停（data-running="0"）', async ({ browser }) => {
  const page = await guest(browser)
  await page.goto('/login')
  await expect(glitch(page)).toHaveAttribute('data-running', '1')
  // headless 的 bringToFront 不會讓舊分頁變成 hidden：直接把 visibilityState 改成 hidden 並發 visibilitychange（跟瀏覽器切分頁一樣的訊號）。
  const setHidden = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h })
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') })
      document.dispatchEvent(new Event('visibilitychange'))
    }, hidden)
  await setHidden(true)
  await expect(page.locator('[data-testid=letter-glitch][data-running="0"]')).toHaveCount(1)
  await setHidden(false)
  await expect(glitch(page)).toHaveAttribute('data-running', '1')
  await page.context().close()
})

async function stepOne(page: Page, email: string) {
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByLabel('確認密碼').fill(PASSWORD)
  await page.getByRole('button', { name: '建立帳號' }).click()
  await expect(page).toHaveURL(/\/register\/verify$/)
}

test('AC-26／AC-27／AC-28 步驟條；第 1→2 步同一張 canvas；回上一步 dir=back 反向、登出、續辦票刪除', async ({ browser }) => {
  const page = await guest(browser)
  await page.goto('/register')
  await expectStage(page)
  // AC-26：3 項、第 1 項目前步驟；沒帶 dir 時沒有 data-anim。
  await expect(progress(page).locator('li')).toHaveCount(3)
  expect(await progress(page).locator('li').evaluateAll((lis) => lis.map((li) => li.getAttribute('data-state')))).toEqual([
    'current',
    'todo',
    'todo',
  ])
  await expect(progress(page).locator('li').first()).toHaveAttribute('aria-current', 'step')
  await expect(progress(page)).not.toHaveAttribute('data-anim', /.*/)

  // AC-27：記號放在 canvas 上；換到第 2 步還在＝沒有重掛。
  await page.locator('[data-testid=letter-glitch] canvas').evaluate((c) => ((c as unknown as { __fxId: string }).__fxId = 'c4-07'))
  const email = `c4-07-back-${run}@example.com`
  await stepOne(page, email)
  expect(await page.locator('[data-testid=letter-glitch] canvas').evaluate((c) => (c as unknown as { __fxId?: string }).__fxId)).toBe('c4-07')
  await expect(progress(page).locator('li').nth(1)).toHaveAttribute('aria-current', 'step')

  // AC-28：回上一步 → /register?dir=back&email=…、data-anim="back"、已登出、續辦票刪掉。
  await page.context().addCookies([{ name: 'fju_signup_resume', value: 'x', domain: new URL(BASE_URL).hostname, path: '/register' }])
  await page.getByRole('button', { name: 'Email 打錯了？回上一步修改' }).click()
  await expect(page).toHaveURL(`/register?dir=back&email=${encodeURIComponent(email)}`)
  await expect(progress(page)).toHaveAttribute('data-anim', 'back')
  await expect(progress(page).locator('li')).toHaveCount(3)
  await expect(progress(page).locator('li').first()).toHaveAttribute('aria-current', 'step')
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email)
  const names = (await page.context().cookies()).map((c) => c.name)
  expect(names.filter((n) => /session_token/.test(n))).toEqual([])
  expect(names).not.toContain('fju_signup_resume')
  await page.context().close()
})

async function latestOtp(email: string): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const rows = await pool.query<{ body_text: string | null }>(
      `select body_text from mail_outbox where to_email = $1 and template = 'email_otp' order by created_at desc limit 1`,
      [email],
    )
    const otp = /(\d{6})/.exec(rows.rows[0]?.body_text ?? '')?.[1]
    if (otp) return otp
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`mail_outbox 沒有 ${email} 的驗證碼`)
}

test('AC-29 等待審核頁、改密碼頁：沒有 LetterGlitch、頁尾還在', async ({ browser }) => {
  test.setTimeout(120_000)
  const page = await guest(browser)
  await page.goto('/register')
  const email = `c4-07-pending-${run}@example.com`
  await stepOne(page, email)
  await page.getByLabel('驗證碼第 1 位').fill(await latestOtp(email))
  await expect(page).toHaveURL(/\/register\/apply/)
  await expect(glitch(page)).toHaveCount(1)
  await page.getByLabel('姓名').fill(`外觀測試${run}`)
  await page.getByLabel('學號').fill(`4${String(Date.now()).slice(-8)}`)
  await page.getByLabel('系級').fill('資管二甲')
  await page.getByLabel('手機').fill('0912-345-678')
  await page.getByRole('button', { name: '送出申請' }).click()
  await expect(page).toHaveURL(/\/register\/pending/)
  await expect(glitch(page)).toHaveCount(0)
  await expect(page.getByRole('contentinfo')).toBeVisible()
  await page.context().close()

  const student = await guest(browser)
  const session = await createTestSession(student.request, 'student')
  await student.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await student.goto('/account/change-password')
  await expect(student).toHaveURL(/\/account\/change-password/)
  await expect(glitch(student)).toHaveCount(0)
  await expect(student.getByRole('contentinfo')).toBeVisible()
  await student.context().close()
})
