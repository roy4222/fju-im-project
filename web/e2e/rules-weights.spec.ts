import { expect, test, type Locator, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * C 階段 C1-14（X7；設計方案① §7.5）：前台 `/rules` 章節之後的「評分方式」。驗收 AC-33。
 *
 * 區塊讀「預設工作屆別」目前已發布的評分規則：這裡建一屆並設成預設，結束時把原本的預設還回去
 * （同 `hero.spec.ts`；這個旗標多支 spec 會改，本機請用 --workers=1）。
 * 第 1 版 60／40 直接插資料；「改成 50／50 並發布」走系辦評分規則頁，前台重新整理跟著變。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const CODE = `C114-${Date.now().toString(36).toUpperCase()}`
const RULE = `${CODE} 評分與獎懲`
const STAGES = [
  {
    key: 's1',
    name: '系統驗收',
    weight: 60,
    items: [
      { key: 'i1', name: '功能完整', type: 'number', max: 100, weight: 70 },
      { key: 'i2', name: '文件', type: 'number', max: 100, weight: 30 },
    ],
  },
  { key: 's2', name: '專題發表', weight: 40, items: [{ key: 'i3', name: '發表', type: 'number', max: 100, weight: 100 }] },
]

let pool: Pool
let cohortId = ''
let adminId = ''
let previousDefault: string[] = []

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function one(sql: string, values: unknown[]): Promise<string> {
  return String((await pool.query<{ id: string }>(sql, values)).rows[0]!.id)
}

test.beforeAll(async ({ request }) => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  adminId = (await sharedTestSession(request, 'admin')).userId
  cohortId = await one(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 'system') returning id`,
    [CODE, `${CODE} 評分方式測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  previousDefault = (await pool.query<{ id: string }>('select id from cohorts where is_default_working')).rows.map((r) => r.id)
  await pool.query('update cohorts set is_default_working = false where is_default_working')
  await pool.query('update cohorts set is_default_working = true where id = $1', [cohortId])

  // 一章公開、已發布的規則（建立流程有自己的 e2e），正文不寫比例。
  const itemId = await one(
    `insert into managed_items (id, cohort_id, placement, audience_kind, title, summary, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, 'rules', 'public', $2, '', 'user', $3) returning id`,
    [cohortId, RULE, adminId],
  )
  const versionId = await one(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '', '<p>評分方式與比例以本站「評分規則」為準（見下方）。</p>', $3) returning id`,
    [itemId, RULE, adminId],
  )
  const schemaId = await one(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[]}', $2) returning id`,
    [itemId, adminId],
  )
  await pool.query(
    `update managed_items set status = 'published', actual_opened_at = now(), current_content_version_id = $2, current_schema_version_id = $3
      where id = $1`,
    [itemId, versionId, schemaId],
  )
})

test.afterAll(async () => {
  if (pool && cohortId) {
    await pool.query('update cohorts set is_default_working = false where id = $1', [cohortId])
    if (previousDefault.length > 0) await pool.query('update cohorts set is_default_working = true where id = any($1::uuid[])', [previousDefault])
  }
  await pool?.end()
})

/** 訪客（沒有登入 cookie）開前台 `/rules`，回傳「評分方式」區塊。 */
async function openPublicRules(page: Page): Promise<Locator> {
  await page.goto('/rules')
  await expect(page.getByRole('navigation', { name: '規則目錄' })).toContainText(RULE)
  return page.getByRole('region', { name: '評分方式' })
}

function stage(block: Locator, name: string): Locator {
  return block.getByTestId('grading-stage').filter({ has: block.page().getByRole('heading', { name, exact: true }) })
}

test('預設工作屆別還沒有發布評分規則：前台 /rules 不顯示「評分方式」', async ({ page }) => {
  const block = await openPublicRules(page)
  await expect(block).toHaveCount(0)
})

test('AC-33：已發布 60／40 → 章節之後有「評分方式」：兩個評分項目、比例、說明、細項；章節正文沒有寫死比例', async ({ page }) => {
  const schemeId = await one(
    `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
    [cohortId, `${CODE} 評分規則`],
  )
  const versionId = await one(
    `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, 'published', $3) returning id`,
    [schemeId, JSON.stringify(STAGES), adminId],
  )
  await pool.query('update grading_schemes set current_version_id = $2 where id = $1', [schemeId, versionId])
  await pool.query(
    `insert into grading_stage_settings (cohort_id, stage_key, description, updated_by_user_id) values ($1, 's2', '依發表當天表現評分', $2)`,
    [cohortId, adminId],
  )

  const block = await openPublicRules(page)
  await expect(block).toBeVisible()
  await expect(block).toContainText(`${CODE} 評分方式測試`)
  await expect(block.getByTestId('grading-stage')).toHaveCount(2)
  await expect(block.getByTestId('grading-stage-weight')).toHaveText(['60%', '40%'])
  const acceptance = stage(block, '系統驗收')
  await expect(acceptance.getByRole('list', { name: '「系統驗收」的細項' }).getByRole('listitem')).toHaveText([/功能完整\s*70%/, /文件\s*30%/])
  const talk = stage(block, '專題發表')
  await expect(talk).toContainText('依發表當天表現評分')
  await expect(talk.getByRole('list', { name: '「專題發表」的細項' }).getByRole('listitem')).toHaveText([/發表\s*100%/])

  // 區塊在章節之後（同一欄、DOM 順序在本章之後），不在目錄裡。
  const chapter = page.getByRole('region', { name: RULE })
  await expect(chapter).toBeVisible()
  expect(await chapter.evaluate((el, other) => !!(el.compareDocumentPosition(other!) & Node.DOCUMENT_POSITION_FOLLOWING), await block.elementHandle())).toBe(true)
  await expect(page.getByRole('navigation', { name: '規則目錄' }).getByRole('link', { name: '評分方式' })).toHaveCount(0)
  await expect(chapter).not.toContainText(/60\s*[%％]|40\s*[%％]/)
})

test('AC-33：系辦把比例改成 50／50 並發布新版 → 前台重新整理跟著變', async ({ browser, page }) => {
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
  await page.goto(`/dashboard/admin/grading/rules?cohort=${cohortId}`)
  await expect(page.getByTestId('scheme-status')).toHaveText('第 1 版・已發布')
  await page.getByRole('button', { name: '建立新版評分規則' }).click()
  const dialog = page.getByRole('dialog', { name: '建立新版評分規則' })
  await dialog.getByLabel('占總成績 %').nth(0).fill('50')
  await dialog.getByLabel('占總成績 %').nth(1).fill('50')
  await dialog.getByRole('button', { name: '建立草稿' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: '已建立評分規則第 2 版（草稿）' })).toBeVisible()

  // 草稿還沒發布：前台仍是 60／40。
  const visitor = await browser.newPage({ baseURL: BASE_URL })
  await expect((await openPublicRules(visitor)).getByTestId('grading-stage-weight')).toHaveText(['60%', '40%'])

  await page.reload()
  await page.getByRole('region', { name: '版本紀錄' }).getByRole('button', { name: '發布第 2 版' }).click()
  await expect(page.getByTestId('scheme-status')).toHaveText('第 2 版・已發布')

  const after = await openPublicRules(visitor)
  await expect(after.getByTestId('grading-stage-weight')).toHaveText(['50%', '50%'])
  await expect(stage(after, '專題發表')).toContainText('依發表當天表現評分')
  await visitor.close()
})
