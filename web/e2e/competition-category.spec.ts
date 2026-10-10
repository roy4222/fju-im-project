import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 競賽公告的分類快速鍵（設計方案 2026-10-08 §14-4）：
 *
 * 分類仍是自由文字；完整編輯器的分類欄旁有一顆「競賽資訊」，按下去填好分類、報名截止日與活動日就出現，
 * 發布後訪客在 /competitions 看得到這一則。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T7C-${stamp}`
const TITLE = `${CODE} 專題創意競賽`

let pool: Pool
let cohortId: string

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 1 })
  const yearEnd = new Date(Date.now() + 300 * 86_400_000 + 8 * 3600_000).toISOString().slice(0, 10)
  cohortId = String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
        [CODE, yearEnd],
      )
    ).rows[0]!.id,
  )
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
}

test('分類欄旁按「競賽資訊」：出現報名截止日與活動日，發布後訪客在競賽頁看得到', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.locator('#ed-title').fill(TITLE)
  await page.locator('#ed-body').fill('報名請洽系辦。')
  await page.getByLabel('發布對象').selectOption('public')

  await expect(page.getByText('分類要填「競賽資訊」')).toBeVisible()
  await expect(page.getByTestId('competition-dates')).toHaveCount(0)
  await page.getByTestId('category-competition').click()
  await expect(page.locator('#ed-category')).toHaveValue('競賽資訊')
  await expect(page.getByTestId('competition-dates')).toBeVisible()
  await page.getByLabel(/報名截止日/).fill('2099-12-31')

  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await expect(check.locator('[data-ok="no"]')).toHaveCount(0)
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toContainText('已發布')

  // 訪客（沒有登入）打開競賽頁。
  await page.context().clearCookies()
  await page.goto(`/competitions?q=${encodeURIComponent(CODE)}`)
  const card = page.getByTestId('competition-card').filter({ hasText: TITLE })
  await expect(card).toBeVisible()
  await expect(card).toContainText('報名中')
})
