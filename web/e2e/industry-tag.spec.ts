import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 產學合作卡片與詳情頁的組別標籤（Q65；AC-VI-39、40）。
 *
 * 有組別連結時寫「已有 N 組・仍可加入」；沒有時統一寫「尚無組別」。合作案沒有名額概念，
 * 「仍可加入」＝合作案還在發布中，所以不出現「額滿」「名額」；下架後案主看詳情頁只剩「已有 N 組」。
 *
 * 合作案、組別與連結直接用 owner 連線建好（建案、連結的畫面流程由 industry.spec.ts 驗）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `Q65-${stamp}`
const LINKED = `標籤兩組${stamp.slice(-4)}`
const EMPTY = `標籤零組${stamp.slice(-4)}`
const WITHDRAWN = `標籤下架${stamp.slice(-4)}`

let pool: Pool
let owner: TestSession
let student: TestSession
const ids = new Map<string, string>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function insertOpportunity(company: string, status: 'published' | 'withdrawn'): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into industry_opportunities
       (id, owner_teacher_user_id, company_name, department, content, requirements, status,
        published_business_at, withdrawn_business_at, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, $2, '資訊部', '標籤測試的合作內容', '會 Python', $3,
             now(), case when $3 = 'withdrawn' then now() else null end, 'user', $1)
     returning id`,
    [owner.userId, company, status],
  )
  ids.set(company, row.rows[0]!.id)
  return row.rows[0]!.id
}

async function linkNewGroups(opportunityId: string, codes: string[], cohortId: string) {
  const at = new Date(Date.now() - 86_400_000)
  for (const code of codes) {
    const group = await pool.query<{ id: string }>(
      `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                           created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
       values (gen_random_uuid(), $1, $2, 'industry', 'active', $4, $4, $4, 'user', $3, $4, $3) returning id`,
      [cohortId, code, owner.userId, at],
    )
    await pool.query(
      `insert into opportunity_links (id, group_id, opportunity_id, valid_from, linked_by_user_id, created_at)
       values (gen_random_uuid(), $1, $2, $3, $4, $3)`,
      [group.rows[0]!.id, opportunityId, at, owner.userId],
    )
  }
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備合作案與組別')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const fresh = async (role: 'teacher' | 'student') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  owner = await fresh('teacher')
  student = await fresh('student')

  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 'system') returning id`,
    [CODE, `${CODE} 標籤測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  const cohortId = cohort.rows[0]!.id

  await linkNewGroups(await insertOpportunity(LINKED, 'published'), ['T01', 'T02'], cohortId)
  await insertOpportunity(EMPTY, 'published')
  await linkNewGroups(await insertOpportunity(WITHDRAWN, 'withdrawn'), ['T03', 'T04'], cohortId)
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

const card = (page: Page, company: string) => page.getByTestId('opportunity-card').filter({ hasText: company })
const detailTags = (page: Page) => page.locator('article[aria-labelledby="opportunity-title"] h1').locator('xpath=preceding-sibling::div[1]')

test('學生看列表：有組別寫「已有 2 組・仍可加入」，沒有組別寫「尚無組別」（AC-VI-39）', async ({ page }) => {
  await signIn(page, student)
  await page.goto('/industry')

  await expect(card(page, LINKED)).toHaveCount(1)
  await expect(card(page, LINKED).getByText('已有 2 組・仍可加入', { exact: true })).toBeVisible()
  await expect(card(page, LINKED).getByText('尚無組別')).toHaveCount(0)

  await expect(card(page, EMPTY).getByText('尚無組別', { exact: true })).toBeVisible()
  await expect(card(page, EMPTY).getByText(/已有|仍可加入/)).toHaveCount(0)

  // 下架的不在前台列表。
  await expect(card(page, WITHDRAWN)).toHaveCount(0)
  await expect(page.getByRole('main').getByText(/額滿|名額/)).toHaveCount(0)
})

test('學生看詳情頁：Tag 跟列表同一句（AC-VI-39）', async ({ page }) => {
  await signIn(page, student)

  await page.goto(`/industry/${ids.get(LINKED)}`)
  await expect(page.getByRole('heading', { level: 1, name: LINKED })).toBeVisible()
  await expect(detailTags(page)).toHaveText('已有 2 組・仍可加入')
  await expect(page.getByRole('main').getByText(/額滿|名額/)).toHaveCount(0)

  await page.goto(`/industry/${ids.get(EMPTY)}`)
  await expect(page.getByRole('heading', { level: 1, name: EMPTY })).toBeVisible()
  await expect(detailTags(page)).toHaveText('尚無組別')
  await expect(page.getByRole('main').getByText(/仍可加入|額滿|名額/)).toHaveCount(0)
})

test('案主看已下架的合作案：只寫「已有 2 組」，不說仍可加入', async ({ page }) => {
  await signIn(page, owner)
  await page.goto(`/industry/${ids.get(WITHDRAWN)}`)
  await expect(page.getByRole('heading', { level: 1, name: WITHDRAWN })).toBeVisible()
  await expect(page.locator('article').getByRole('status')).toContainText('目前狀態')
  await expect(detailTags(page)).toHaveText('已有 2 組')
  await expect(page.getByRole('main').getByText('仍可加入')).toHaveCount(0)
})
