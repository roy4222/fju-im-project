import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * VB-10：「我的帳號」頭像區塊（AC-VI-77；SH-9 的 AvatarPicker 掛在 `/account`）。
 *
 * 位元組走真的上傳端點（正式建置的 sharp 縮圖、清 EXIF）；這裡只驗畫面：沒選過顯示 hash 預設圖、
 * 上傳後換成 `/api/files/<id>` 且是 256×256 WebP、選預設圖後回到 `/avatars/NNN.webp`、超過 2 MB 與錯誤類型先被擋。
 * 截圖（上傳前後）寫到 `VB10_SHOT_DIR`（沒設就不截）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const FIXTURE = new URL('../test/fixtures/exif.jpg', import.meta.url).pathname
const SHOT_DIR = process.env.VB10_SHOT_DIR

test.describe.configure({ mode: 'serial' })

let pool: Pool
let student: TestSession

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
