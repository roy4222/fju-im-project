import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 票 35（#284）：系辦日常工作頁照原型。外觀由 PR 的並排截圖驗；這裡只測本票**新增的行為**：
 *
 * 1. 後台深淺色切換：頂列按鈕切換、重新整理後還在；回前台是淺色（前台固定白）。
 * 2. 檔案管理（新頁）：專題事務的附件出現在清單，看得到類型、引用位置、引用數、下載連結；
 *    被引用的檔案給「去解除引用」（回編輯器）；搜尋檔名篩得到、篩不到時有空狀態。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T35-${stamp}`
const TITLE = `${CODE} 報告範本`
const FILE_NAME = `t35-${stamp.toLowerCase()}-範本.pdf`
const PDF = Buffer.from('%PDF-1.4\n% e2e 票 35 檔案管理\n')

let pool: Pool
let cohortId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const found = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
    [CODE, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  cohortId = found.rows[0]!.id
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

const htmlIsDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('dark'))

test('後台深淺色：頂列按鈕切換、重新整理後保留；前台維持淺色', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin/timeline')
  await page.evaluate(() => localStorage.removeItem('fju-dash-theme'))
  await page.reload()
  expect(await htmlIsDark(page)).toBe(false)

  await page.getByRole('button', { name: '切換為深色' }).click()
  await expect.poll(() => htmlIsDark(page)).toBe(true)
  await expect(page.getByRole('button', { name: '切換為淺色' })).toBeVisible()

  await page.reload()
  await expect.poll(() => htmlIsDark(page)).toBe(true)

  // 前台固定淺色：離開後台就把 dark 拿掉。
  await page.goto('/')
  await expect.poll(() => htmlIsDark(page)).toBe(false)

  await page.goto('/dashboard/admin/inbox')
  await expect.poll(() => htmlIsDark(page)).toBe(true)
  await page.getByRole('button', { name: '切換為淺色' }).click()
  await expect.poll(() => htmlIsDark(page)).toBe(false)
})

test('檔案管理：專題事務的附件列在清單上，有引用位置、下載與「去解除引用」；搜尋檔名篩得到', async ({ page }) => {
  await asAdmin(page)

  // 用三步驟快速建立一則資源，附上一個 PDF（票 15 的流程）。
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增項目' }).click()
  const dialog = page.getByRole('dialog', { name: '新增項目' })
  await dialog.getByRole('radio', { name: /資源下載/ }).check()
  await dialog.getByLabel('標題').fill(TITLE)
  await dialog.getByLabel('發布對象').selectOption('signed_in')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.locator('input[type=file]').setInputFiles({ name: FILE_NAME, mimeType: 'application/pdf', buffer: PDF })
  await expect(dialog.getByRole('link', { name: FILE_NAME })).toBeVisible()
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('已發布')
  const itemId = (
    await pool.query<{ id: string }>('select id from managed_items where cohort_id = $1 and title = $2', [cohortId, TITLE])
  ).rows[0]!.id

  await page.goto('/dashboard/admin/files')
  await expect(page.getByRole('heading', { name: '檔案管理', exact: true })).toBeVisible()
  // 側欄有「檔案管理」且標成目前這一頁。
  await expect(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '檔案管理' })).toHaveAttribute(
    'aria-current',
    'page',
  )

  const row = page.getByTestId('file-row').filter({ hasText: FILE_NAME })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('公開資源')
  await expect(row.getByRole('link', { name: TITLE })).toHaveAttribute('href', `/dashboard/admin/editor/${itemId}`)
  await expect(row.getByRole('link', { name: `下載 ${FILE_NAME}` })).toHaveAttribute('href', /^\/api\/files\/[0-9a-f-]{36}$/)
  await expect(row.getByRole('link', { name: '去解除引用' })).toHaveAttribute('href', `/dashboard/admin/editor/${itemId}`)

  // 下載走原本的授權路由：系辦拿得到這個檔。
  const href = await row.getByRole('link', { name: `下載 ${FILE_NAME}` }).getAttribute('href')
  const download = await page.request.get(href!)
  expect(download.status()).toBe(200)

  await page.getByLabel('搜尋檔名').fill(FILE_NAME)
  await expect(page.getByTestId('file-row')).toHaveCount(1)
  await page.getByLabel('搜尋檔名').fill(`沒有這個檔-${stamp}`)
  await expect(page.getByTestId('file-row')).toHaveCount(0)
  await expect(page.getByText('沒有符合條件的資料')).toBeVisible()
  await page.getByRole('button', { name: '清除條件' }).click()
  await expect(page.getByTestId('file-row').filter({ hasText: FILE_NAME })).toHaveCount(1)
})
