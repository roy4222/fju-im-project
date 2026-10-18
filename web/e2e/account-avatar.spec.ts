import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * VB-10：「我的帳號」頭像區塊（AC-VI-77；SH-9 的 AvatarPicker 掛在 `/account`）。
 *
 * 位元組走真的上傳端點（正式建置的 sharp 縮圖、清 EXIF）；這裡只驗畫面：沒選過顯示 hash 預設圖、
 * 上傳後換成 `/api/files/<id>` 且是 256×256 WebP、選預設圖後回到 `/avatars/NNN.webp`、超過 2 MB 與錯誤類型先被擋。
 * C3-04：選檔後先開「裁切頭像」視窗（圓形取景框、拖動、縮放），按「儲存」才上傳；AC-C3-03、04、05。
 * 截圖（上傳前後）寫到 `VB10_SHOT_DIR`（沒設就不截）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const FIXTURE = new URL('../test/fixtures/exif.jpg', import.meta.url).pathname
const LANDSCAPE = new URL('./fixtures/landscape-1200x800.jpg', import.meta.url).pathname
const SMALL = new URL('./fixtures/small-200x200.png', import.meta.url).pathname
const FAKE_HEIC = new URL('./fixtures/fake.heic', import.meta.url).pathname
const SHOT_DIR = process.env.VB10_SHOT_DIR

test.describe.configure({ mode: 'serial' })

let pool: Pool
let student: TestSession

/** 掛上 CSP 違規監聽（要在頁面載入前）。 */
async function watchCsp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] }
    w.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
}
const cspViolations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)

/** 取景框 canvas 在 (x, 128) 的紅色值：橫幅測試圖左 1/3 是藍（r≈40）、其餘橘（r≈230）。 */
const redAt = (page: Page, x: number) =>
  page.getByTestId('avatar-crop-canvas').evaluate((el, px) => {
    const canvas = el as HTMLCanvasElement
    return canvas.getContext('2d')!.getImageData(px, 128, 1, 1).data[0]
  }, x)

const avatarImg = (page: Page) => page.getByTestId('account-avatar').locator('img').first()

async function shot(page: Page, name: string) {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 1 })
  student = await createTestSession(request, 'student')
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email) values ($1, '頭像學生', '頭像學生', $2)
     on conflict (user_id) do nothing`,
    [student.userId, student.email],
  )
})

test.afterAll(async () => {
  await pool?.end()
})

test.beforeEach(async ({ page }) => {
  await page.context().addCookies([toPlaywrightCookie(student.cookie, BASE_URL)])
})

test('沒選過：顯示 hash 預設圖；上傳 EXIF 照片後換成自己的圖（256×256 WebP），重新整理仍在', async ({ page }) => {
  await page.goto('/account')
  const img = avatarImg(page)
  await expect(img).toHaveAttribute('src', /^\/avatars\/\d{3}\.webp$/)
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0)
  await shot(page, 'vb10-before-upload')

  await page.getByLabel('上傳圖片').setInputFiles(FIXTURE)
  await page.getByRole('dialog', { name: '裁切頭像' }).getByRole('button', { name: '儲存' }).click()
  await expect(page.getByRole('status').filter({ hasText: '頭像已更新' })).toBeVisible()
  await expect(img).toHaveAttribute('src', /^\/api\/files\/[0-9a-f-]{36}$/)
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(256)
  await shot(page, 'vb10-after-upload')

  const row = (await pool.query<{ avatar_file_id: string | null }>('select avatar_file_id from user_profiles where user_id = $1', [student.userId])).rows[0]
  expect(row?.avatar_file_id).toBeTruthy()
  const src = await img.getAttribute('src')
  expect(src).toBe(`/api/files/${row?.avatar_file_id}`)
  const response = await page.request.get(src!)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toBe('image/webp')

  await page.reload()
  await expect(avatarImg(page)).toHaveAttribute('src', src!)
  // 後台的帳號選單也是同一張（前台沒有帳號選單，C2-14）。
  await page.goto('/dashboard/student')
  await expect(page.getByRole('button', { name: '帳號選單' }).locator('img')).toHaveAttribute('src', src!)
})

test('選預設圖：頭像換成 /avatars/NNN.webp，舊的上傳檔立刻 404', async ({ page }) => {
  await page.goto('/account')
  const before = await avatarImg(page).getAttribute('src')
  expect(before).toMatch(/^\/api\/files\//)

  await page.getByRole('button', { name: '選預設圖' }).click()
  await page.getByRole('button', { name: '預設頭像 7', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '頭像已更新' })).toBeVisible()
  await expect(avatarImg(page)).toHaveAttribute('src', '/avatars/007.webp')
  await expect(page.getByRole('button', { name: '預設頭像 7', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect((await page.request.get(before!)).status()).toBe(404)
})

test('超過 2 MB、不是圖片類型：在瀏覽器就先擋，頭像不變', async ({ page }) => {
  await page.goto('/account')
  const before = await avatarImg(page).getAttribute('src')
  const input = page.getByLabel('上傳圖片')

  await input.setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) })
  await expect(page.getByRole('alert').filter({ hasText: '超過 2 MB' })).toBeVisible()

  await input.setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await expect(page.getByRole('alert').filter({ hasText: '只收 PNG、JPG、WebP' })).toBeVisible()

  await expect(avatarImg(page)).toHaveAttribute('src', before!)
})

test('裁切視窗：圓形取景框、拖動與縮放、儲存後頭像換成裁好的圖（256 WebP），CSP 違規 0、視窗內沒有 style 屬性', async ({ page }) => {
  await watchCsp(page)
  const uploads: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/files/upload')) uploads.push(r.url())
  })
  await page.goto('/account')
  await page.getByLabel('上傳圖片').setInputFiles(LANDSCAPE)

  const dialog = page.getByRole('dialog', { name: '裁切頭像' })
  await expect(dialog).toBeVisible()
  expect(uploads).toHaveLength(0) // 選檔後先裁切，不直接上傳
  for (const name of ['重選', '取消', '儲存']) await expect(dialog.getByRole('button', { name })).toBeVisible()
  const canvas = page.getByTestId('avatar-crop-canvas')
  const slider = dialog.getByRole('slider')
  await expect(slider).toBeEnabled()
  await shot(page, 'c3-04-crop-dialog')

  // 預設置中：x=100 對應原圖 x≈512（橘）；往右拖到底後取景框看到照片左側，x=100 變成藍。
  await expect.poll(() => redAt(page, 100)).toBeGreaterThan(180)
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => redAt(page, 100)).toBeLessThan(100)

  // 滾輪放大、滑桿也能縮放。
  const before = Number(await slider.inputValue())
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -300)
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(before)
  await slider.fill('2')
  await expect(slider).toHaveValue('2')

  // 視窗內沒有任何帶內容的 style 屬性（截圖時 Playwright 會在 range 上留空的 style=""，不算）。
  const styled = await dialog
    .locator('[style]')
    .evaluateAll((els) => els.filter((e) => (e.getAttribute('style') ?? '').trim() !== '').map((e) => e.outerHTML.slice(0, 120)))
  expect(styled).toEqual([])
  expect(await dialog.getAttribute('style')).toBeNull()

  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(page.getByRole('status').filter({ hasText: '頭像已更新' })).toBeVisible()
  await expect(dialog).toHaveCount(0)
  expect(uploads).toHaveLength(1)
  const img = avatarImg(page)
  await expect(img).toHaveAttribute('src', /^\/api\/files\/[0-9a-f-]{36}$/)
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(256)
  const row = (await pool.query<{ avatar_file_id: string | null }>('select avatar_file_id from user_profiles where user_id = $1', [student.userId])).rows[0]
  expect(await img.getAttribute('src')).toBe(`/api/files/${row?.avatar_file_id}`)
  const response = await page.request.get(`/api/files/${row?.avatar_file_id}`)
  expect(response.headers()['content-type']).toBe('image/webp')
  await page.reload()
  await expect(avatarImg(page)).toHaveAttribute('src', `/api/files/${row?.avatar_file_id}`)

  expect(await cspViolations(page)).toEqual([])
})

test('裁切視窗：小圖提示、HEIC 不能裁且不送出、鍵盤操作與 Esc、焦點鎖在視窗內', async ({ page }) => {
  await watchCsp(page)
  const posts: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST') posts.push(r.url())
  })
  await page.goto('/account')
  const before = await avatarImg(page).getAttribute('src')
  const input = page.getByLabel('上傳圖片')
  const dialog = page.getByRole('dialog', { name: '裁切頭像' })

  // (a) 200×200 小圖：仍可裁，提示會模糊。
  await input.setInputFiles(SMALL)
  await expect(dialog.getByText('照片較小，會模糊')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '儲存' })).toBeEnabled()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toHaveCount(0)

  // (b) HEIC：不能裁、儲存不能按、沒有任何 POST。
  await input.setInputFiles({ name: 'photo.heic', mimeType: 'image/heic', buffer: (await import('node:fs')).readFileSync(FAKE_HEIC) })
  await expect(dialog.getByRole('alert').filter({ hasText: '這個格式不能裁切，請換 JPG 或 PNG' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '儲存' })).toBeDisabled()
  await dialog.getByRole('button', { name: '取消' }).click()
  expect(posts).toEqual([])

  // (c) 鍵盤：Tab 到畫布、方向鍵、+／-、Esc。
  await input.setInputFiles(LANDSCAPE)
  await expect(dialog.getByRole('slider')).toBeEnabled()
  const canvas = page.getByTestId('avatar-crop-canvas')
  await canvas.focus()
  await expect(canvas).toBeFocused()
  await expect.poll(() => redAt(page, 100)).toBeGreaterThan(180)
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight') // 4px × 20 = 80，夾在 64
  await expect.poll(() => redAt(page, 100)).toBeLessThan(100)
  const slider = dialog.getByRole('slider')
  const start = Number(await slider.inputValue())
  await page.keyboard.press('+')
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(start)
  await page.keyboard.press('-')
  await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(start, 5)

  // 焦點只在視窗內打轉。
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true)
  }

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(avatarImg(page)).toHaveAttribute('src', before!)
  expect(posts).toEqual([])
  expect(await cspViolations(page)).toEqual([])
})
