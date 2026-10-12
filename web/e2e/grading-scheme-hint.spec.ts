import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 第三波 W9（AC-29；N-33、N-148）：系辦建立方案草稿後，提示說清楚「發布」在旁邊的「版本紀錄」裡；
 * 在版本紀錄按「發布」之後，「（草稿）；按發布…」那句不再留在畫面上。
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

async function openAdminGrading(page: Page) {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto(`/dashboard/admin/grading?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '成績管理', exact: true })).toBeVisible()
}

test('建立方案草稿：提示指出「發布」在版本紀錄；發布後那句草稿提示消失', async ({ page }) => {
  await openAdminGrading(page)

  await page.getByRole('button', { name: '建立新方案版本' }).click()
  const editor = page.getByRole('dialog', { name: '建立評分方案版本' })
  await editor.getByRole('button', { name: '建立草稿' }).click()
  await expect(editor).toBeHidden()

  const hint = page.getByRole('status').filter({ hasText: '已建立方案 v1（草稿）' })
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('「發布」在旁邊的「版本紀錄」裡，點開後按 v1 那列的「發布」')

  await page.getByRole('button', { name: /^版本紀錄/ }).click()
  const versions = page.getByRole('dialog', { name: '評分方案版本' })
  await expect(versions).toBeVisible()
  await versions.getByRole('button', { name: '發布 v1' }).click()
  await expect(page.getByTestId('scheme-status')).toHaveText('v1・已發布')

  // 關掉版本紀錄回到頁面（對話框開著時背後的字讀不到，不能拿來證明「消失」）。
  await versions.getByRole('button', { name: '關閉', exact: true }).click()
  await expect(versions).toBeHidden()
  await expect(page.getByRole('button', { name: '建立新方案版本' })).toBeVisible()
  await expect(page.getByText('已建立方案 v1（草稿）')).toHaveCount(0)
  await expect(page.getByText('按「發布」後老師才會用這一版')).toHaveCount(0)
})
