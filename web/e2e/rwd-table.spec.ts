import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * RWD 共用部分（規格④ C4-04）：
 * AC-58 競賽卡在 768 寬圖在上、文字欄夠寬；AC-59 資料表右緣有捲動提示、首欄固定。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `RWD-${stamp}`
const TITLE = `${CODE} 競賽`

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

test('AC-58：768 寬競賽頁，圖片在上全寬、文字欄 ≥ 400px', async ({ page }) => {
  test.setTimeout(120_000)
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.locator('#ed-title').fill(TITLE)
  await page.locator('#ed-body').fill('報名請洽系辦。')
  await page.getByLabel('誰看得到').selectOption('public')
  await page.getByTestId('category-competition').click()
  await page.getByLabel(/報名截止日/).fill('2099-12-31')
  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toContainText('已發布')

  await page.context().clearCookies()
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.goto(`/competitions?q=${encodeURIComponent(CODE)}`)
  const card = page.getByTestId('competition-card').filter({ hasText: TITLE })
  await expect(card).toBeVisible()
  const cardBox = (await card.boundingBox())!
  const img = (await card.locator('img').boundingBox())!
  const text = (await card.locator('> div').nth(1).boundingBox())!
  expect(img.width).toBeGreaterThanOrEqual(cardBox.width - 2)
  expect(img.y + img.height).toBeLessThanOrEqual(text.y + 1)
  expect(text.width).toBeGreaterThanOrEqual(400)
  await page.screenshot({ path: process.env.RWD_SHOT_DIR ? `${process.env.RWD_SHOT_DIR}/competitions-768.png` : undefined, fullPage: false })
})

test('AC-59：390 寬檔案表，右緣有捲動提示、首欄固定', async ({ page }) => {
  await asAdmin(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/dashboard/admin/files')
  const table = page.getByLabel('檔案列表')
  await expect(table).toBeVisible()
  const container = page.locator('[data-slot="table-container"]').filter({ has: table })
  await expect(container).toHaveAttribute('data-scroll', 'start')
  await expect(container).toHaveAttribute('data-sticky-first', '')
  const scroller = table.locator('xpath=..')
  const first = table.locator('thead th').first()
  const left0 = (await first.boundingBox())!.x
  await page.screenshot({ path: process.env.RWD_SHOT_DIR ? `${process.env.RWD_SHOT_DIR}/files-390.png` : undefined })

  await scroller.evaluate((el) => (el.scrollLeft = 120))
  await expect(container).toHaveAttribute('data-scroll', 'mid')
  expect((await first.boundingBox())!.x).toBeCloseTo(left0, 0)

  await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth))
  await expect(container).toHaveAttribute('data-scroll', 'end')
  expect((await first.boundingBox())!.x).toBeCloseTo(left0, 0)
})
