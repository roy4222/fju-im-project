import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * CL-4（#820）：有字數上限的欄位改用計數元件（`_ui/char-count.tsx`），不用按 UTF-16 算的原生 `maxLength`——
 * emoji 不會比伺服器早被擋，字數照「字」算（跟伺服器的 `charLength` 一樣）。這裡走時程頁的階段名稱（上限 20 字）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const stamp = `CL4C-${Date.now().toString(36)}`

let pool: Pool
let cohortId: string

test.beforeAll(async () => {
  if (!process.env.DATABASE_URL_OWNER) throw new Error('e2e 需要 DATABASE_URL_OWNER')
  pool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 })
  cohortId = String((await pool.query(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'preparing', '2099-06-30', 'system') returning id`,
    [stamp],
  )).rows[0]!.id)
})

test.afterAll(async () => { await pool?.end() })

test('階段名稱打 21 個 emoji 不會被瀏覽器截斷、字數寫超過 1 字；20 個 emoji 存得進去', async ({ page }) => {
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
  await page.goto(`/dashboard/admin/timeline?cohort=${cohortId}`)
  await page.getByRole('button', { name: '設定階段與日期', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: new RegExp(`^設定 .*${stamp}.* 的階段與日期$`) })
  const name = dialog.getByLabel('第 1 階段名稱')
  await expect(name).not.toHaveAttribute('maxlength')
  const count = dialog.locator('#' + ((await name.getAttribute('aria-describedby')) ?? 'missing'))

  await name.fill('😀'.repeat(21))
  await expect(name).toHaveValue('😀'.repeat(21))
  await expect(count).toHaveText('21／20 字（超過 1 字）')

  await name.fill('😀'.repeat(20))
  await expect(count).toHaveText('20／20 字')
  const dates = ['2026-09-15', '2026-11-01', '2027-01-10', '2027-03-01']
  for (const [i, date] of dates.entries()) {
    if (i > 0) await dialog.getByLabel(`第 ${i + 1} 階段名稱`).fill(`階段${i + 1}`)
    await dialog.getByLabel(`第 ${i + 1} 階段開始日`).fill(date)
  }
  await dialog.getByLabel('年度結束日').fill('2027-06-30')
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog).toBeHidden()
  const saved = await pool.query<{ name: string }>('select name from cohort_stages where cohort_id = $1 and seq = 1', [cohortId])
  expect(saved.rows[0]?.name).toBe('😀'.repeat(20))
})
