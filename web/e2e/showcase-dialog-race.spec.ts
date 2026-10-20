import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const stamp = `SC1-${Date.now().toString(36)}`
const titles = [`${stamp} 作品一`, `${stamp} 作品二`]
let pool: Pool
let cohortId: string

test.beforeAll(async () => {
  if (!process.env.DATABASE_URL_OWNER) throw new Error('e2e 需要 DATABASE_URL_OWNER')
  pool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 })
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = (await sharedTestSession(context, 'admin')).userId
  await context.dispose()
  cohortId = String((await pool.query(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2099-06-30', 'system') returning id`,
    [stamp],
  )).rows[0]!.id)
  // 留一組沒有作品，讓「新增 › 作品」也能參與同一個下載競態。
  await pool.query(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system')`,
    [cohortId],
  )
  for (const title of titles) {
    const entryId = String((await pool.query(
      `insert into showcase_entries (id, cohort_id, status, created_by_user_id)
       values (gen_random_uuid(), $1, 'draft', $2) returning id`,
      [cohortId, admin],
    )).rows[0]!.id)
    await pool.query(
      `insert into showcase_drafts (entry_id, title, summary, summary_checksum)
       values ($1, $2, '', encode(sha256(convert_to('', 'UTF8')), 'hex'))`,
      [entryId, title],
    )
  }
})

test.afterAll(async () => { await pool?.end() })

type Trigger = { kind: 'edit' | 'delete'; row: number } | { kind: 'create' | 'backfill' }

async function open(page: Page, trigger: Trigger) {
  if ('row' in trigger) {
    const row = page.getByTestId('entry-row').filter({ hasText: titles[trigger.row] })
    await row.getByRole('button', { name: new RegExp(`^${trigger.kind === 'edit' ? '編輯' : '刪除'}：`) }).click()
  } else {
    await page.getByRole('button', { name: '新增', exact: true }).click()
    await page.getByRole('menuitem', { name: trigger.kind === 'create' ? /^作品/ : /^補登歷屆作品/ }).click()
  }
}

const cases: { name: string; first: Trigger; second: Extract<Trigger, { row: number }> }[] = [
  { name: '兩列編輯', first: { kind: 'edit', row: 0 }, second: { kind: 'edit', row: 1 } },
  { name: '兩列刪除', first: { kind: 'delete', row: 0 }, second: { kind: 'delete', row: 1 } },
  { name: '同列編輯再刪除', first: { kind: 'edit', row: 0 }, second: { kind: 'delete', row: 0 } },
  { name: '新增作品再編輯', first: { kind: 'create' }, second: { kind: 'edit', row: 1 } },
  { name: '補登再刪除', first: { kind: 'backfill' }, second: { kind: 'delete', row: 1 } },
]

for (const scenario of cases) {
  test(`FIX-SC1：chunk 下載中${scenario.name}，放行後只開最後選的視窗`, async ({ page }) => {
    await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let held = 0
    await page.route('**/_next/static/chunks/*.js', async (route) => {
      const response = await route.fetch()
      const body = await response.text()
      if (body.includes('showcase-edit-dialog') || body.includes('刪除這件作品')) {
        held += 1
        await gate
      }
      await route.fulfill({ response, body })
    })
    try {
      await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
      await open(page, scenario.first)
      await expect.poll(() => held).toBeGreaterThan(0)
      await open(page, scenario.second)
      release()
      // 等兩種 chunk 都完成，避免只在第一個 dialog 先出現的瞬間就誤判通過。
      await page.waitForLoadState('networkidle')
      const dialog = page.locator('dialog[open]')
      await expect(dialog).toHaveCount(1)
      if (scenario.second.kind === 'edit') {
        await expect(dialog.getByLabel('題目', { exact: true })).toHaveValue(titles[scenario.second.row]!)
        await expect(dialog.locator('a[href="/projects/featured"]')).toHaveAttribute('rel', 'noopener noreferrer')
      } else {
        await expect(dialog).toHaveAttribute('aria-label', '刪除作品')
        await expect(dialog).toContainText(titles[scenario.second.row]!)
      }
      await page.keyboard.press('Escape')
      await expect(page.locator('dialog[open]')).toHaveCount(0)
      // 關掉後可再開另一列，不能留下無法解除的全頁鎖。
      await open(page, { kind: 'edit', row: 0 })
      await expect(page.locator('dialog[open]')).toHaveCount(1)
      await expect(page.locator('dialog[open]').getByLabel('題目', { exact: true })).toHaveValue(titles[0]!)
    } finally {
      release()
      await page.unrouteAll({ behavior: 'wait' })
    }
  })
}
