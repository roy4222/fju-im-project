import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 第三波 W9（AC-29；N-33、N-148）：系辦建立方案草稿後，提示說清楚「發布」在下方版本紀錄第 1 版那張卡；
 * 在版本紀錄按「發布」之後，「（草稿）；按發布…」那句不再留在畫面上。
 * AD-08 起評分規則在子頁 `/dashboard/admin/grading/rules`，版本紀錄是頁內區塊（不是對話框）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `W9-${stamp}`

let pool: Pool
let cohortId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 1 })
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 'system') returning id`,
    [CODE, `${CODE} 方案提示測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id
})

test.afterAll(async () => {
  await pool?.end()
})

async function openRules(page: Page) {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto(`/dashboard/admin/grading/rules?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '評分規則', exact: true })).toBeVisible()
}

test('建立方案草稿：提示指出「發布」在版本紀錄；發布後那句草稿提示消失', async ({ page }) => {
  await openRules(page)

  await page.getByRole('button', { name: '建立新版評分規則' }).click()
  const editor = page.getByRole('dialog', { name: '建立新版評分規則' })
  await editor.getByRole('button', { name: '建立草稿' }).click()
  await expect(editor).toBeHidden()

  const hint = page.getByRole('status').filter({ hasText: '已建立評分規則第 1 版（草稿）' })
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('「發布」在下方版本紀錄第 1 版那張卡')

  const versions = page.getByRole('region', { name: '版本紀錄' })
  await expect(versions).toBeVisible()
  await versions.getByRole('button', { name: '發布第 1 版' }).click()
  await expect(page.getByTestId('scheme-status')).toHaveText('第 1 版・已發布')

  await expect(page.getByRole('button', { name: '建立新版評分規則' })).toBeVisible()
  await expect(page.getByText('已建立評分規則第 1 版（草稿）')).toHaveCount(0)
  await expect(page.getByText('按「發布」後老師才會用這一版')).toHaveCount(0)
})
