import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

/**
 * 票 6：匯入名單（含檔案上傳基礎）。
 *
 * 走真的畫面：管理員選 CSV → 看預覽數字 → 匯入 → 版本列表 → 下載原檔；
 * 再從三種身分直接打下載網址，證明「別人拿到網址也打不開」；
 * 最後是偽裝副檔名與超過上限的檔案被擋。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const cohortCode = `e2e${Date.now().toString(36)}`
const cohortName = `E2E 名單測試屆 ${cohortCode}`

/** ACC-01 的 15 列名單（13 有效、1 重複、1 缺姓名），屆別欄換成這次種的屆別。 */
const rosterCsv = fs
  .readFileSync(path.join(import.meta.dirname, '../test/fixtures/roster-115-test.csv'), 'utf8')
  .replaceAll(',115,', `,${cohortCode},`)

async function signInAs(page: Page, role: TestRole) {
  const session = await sharedTestSession(page.request, role)
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  return session
}

async function openImportDialog(page: Page) {
  await page.goto('/dashboard/admin/accounts')
  await page.getByRole('button', { name: '匯入名單 CSV' }).click()
  await expect(page.getByRole('heading', { name: '匯入本屆名單' })).toBeVisible()
}

let downloadHref = ''

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能種屆別')
  // 屆別管理是票 5 的畫面；這裡直接種一屆，只測名單匯入。
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    await pool.query(
      `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system')`,
      [cohortCode, cohortName],
    )
  } finally {
    await pool.end()
  }
})

test('管理員：選檔 → 預覽 → 匯入 → 版本列表看得到、原檔下載得到', async ({ page }) => {
  await signInAs(page, 'admin')
  await openImportDialog(page)

  await page.getByLabel('選擇名單 CSV 檔').setInputFiles({
    name: 'roster-e2e.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(rosterCsv, 'utf8'),
  })

  await expect(page.getByRole('heading', { name: '預覽・roster-e2e.csv' })).toBeVisible()
  await expect(page.getByTestId('roster-count-總筆數')).toHaveText('15')
  await expect(page.getByTestId('roster-count-有效')).toHaveText('13')
  await expect(page.getByTestId('roster-count-重複')).toHaveText('1')
  await expect(page.getByTestId('roster-count-缺欄')).toHaveText('1')
  await expect(page.getByTestId('roster-count-衝突')).toHaveText('0')
  // CSV 的屆別欄對得到剛種的屆別，預設就選它。
  await expect(page.getByLabel('匯入到哪一屆')).toHaveValue(/.+/)
  await expect(page.getByLabel('匯入到哪一屆').locator('option:checked')).toContainText(cohortName)
  // 預覽列出略過的列與原因（行號）。
  const issues = page.getByRole('list', { name: '需要注意的列' })
  await expect(issues).toContainText('第 15 行 411500003')
  await expect(issues).toContainText('缺姓名')
  // 預覽顯示系級。
  await expect(page.getByRole('cell', { name: '資管二甲' }).first()).toBeVisible()

  await page.getByRole('button', { name: '匯入 13 筆' }).click()
  await expect(page.getByText('已匯入', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: `${cohortName}・13 筆名單` })).toBeVisible()
  await page.getByRole('button', { name: '關閉' }).click()

  // 版本列表：哪一屆、誰、何時、幾筆、原檔。
  await page.reload()
  const row = page.getByRole('row').filter({ hasText: cohortName }).first()
  await expect(row).toBeVisible()
  await expect(row).toContainText('13')
  await expect(row).toContainText(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/)
  const link = row.getByRole('link', { name: /下載/ })
  downloadHref = (await link.getAttribute('href')) ?? ''
  expect(downloadHref).toMatch(/^\/api\/files\/[0-9a-f-]{36}$/)

  const response = await page.request.get(downloadHref)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-disposition']).toMatch(/^attachment;/)
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['cache-control']).toContain('no-store')
  // 原檔原封不動（#51：原檔下載保留原始內容）。
  expect(await response.text()).toBe(rosterCsv)
})

test('別人拿到下載網址也打不開：學生 403、沒登入 401', async ({ browser, playwright }) => {
  expect(downloadHref, '上一個測試要先匯入成功').not.toBe('')

  const studentContext = await browser.newContext()
  const studentPage = await studentContext.newPage()
  await signInAs(studentPage, 'student')
  const asStudent = await studentPage.request.get(downloadHref)
  expect(asStudent.status()).toBe(403)
  expect(await asStudent.text()).not.toContain('411500001')
  await studentContext.close()

  const anonymous = await playwright.request.newContext({ baseURL: BASE_URL })
  const asAnonymous = await anonymous.get(downloadHref)
  expect(asAnonymous.status()).toBe(401)
  // 猜一個不存在的 ID：跟「不是你的」一樣，不透露檔案存不存在。
  expect((await anonymous.get('/api/files/00000000-0000-7000-8000-000000000000')).status()).toBe(401)
  await anonymous.dispose()
})

test('管理員直接打上傳端點（沒有瀏覽器的同源標頭）被擋', async ({ page }) => {
  await signInAs(page, 'admin')
  const response = await page.request.post('/api/files/upload?ticket=forged', {
    data: 'student_no,name\n1,王\n',
    headers: { 'content-type': 'application/octet-stream' },
  })
  expect(response.status()).toBe(403)
})

test('偽裝副檔名：.exe 改名成 .csv 被擋，不會進到預覽', async ({ page }) => {
  await signInAs(page, 'admin')
  await openImportDialog(page)

  const exe = Buffer.alloc(256, 0)
  exe.write('MZ', 0, 'latin1')
  exe[2] = 0x90
  await page.getByLabel('選擇名單 CSV 檔').setInputFiles({ name: 'roster.csv', mimeType: 'text/csv', buffer: exe })

  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('已拒絕')
  await expect(page.getByRole('heading', { name: /預覽/ })).toHaveCount(0)
})

test('超過大小上限（2 MiB）的檔案被擋', async ({ page }) => {
  await signInAs(page, 'admin')
  await openImportDialog(page)

  const big = Buffer.from(`student_no,name\n${'411500001,王小明\n'.repeat(160_000)}`, 'utf8')
  expect(big.length).toBeGreaterThan(2 * 1024 * 1024)
  await page.getByLabel('選擇名單 CSV 檔').setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: big })

  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('上限')
  await expect(page.getByRole('heading', { name: /預覽/ })).toHaveCount(0)
})

test('學生打不開帳號管理頁，也就碰不到匯入', async ({ page }) => {
  await signInAs(page, 'student')
  await page.goto('/dashboard/admin/accounts')
  await expect(page).toHaveURL(/\/403$/)
})
