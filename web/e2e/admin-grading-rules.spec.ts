import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * AD-08：成績頁瘦身＋評分規則子頁 `/dashboard/admin/grading/rules`。
 *
 * - AC-AD-15：`/grading` 的 h1「成績」、分頁「成績表」「評分規則」「評分老師」「結算」（C 階段規格② §2.2）、右端「評分規則 ↗」連結；評分規則、版本紀錄、
 *   評分要求與指派都不在這頁；評分進度是卡片（階段一張、老師一張），除了成績表沒有 `<table>`。
 * - AC-AD-03（成績頁段）：老師卡預設「全部階段」，已解散的組不算進分母；選某階段只算那一階段。
 * - AC-AD-16、17、29：子頁 h1「評分規則」＋「← 回成績」、沒有分頁列；版本紀錄每版一張卡；每組一張指派卡。
 * - AC-AD-23（成績表段）：1280 寬兩頁都不出現橫向捲軸。
 *
 * 資料用 owner 連線直接種（評分規則、指派、一份正式評分）；建立與發布評分規則走真的畫面。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `AD08-${stamp}`
const EMPTY_CODE = `AD08E-${stamp}`
const TEACHER = `王老師${stamp.slice(-3)}`

const STAGES = [
  { key: 'mid', name: '期中', weight: 40, letterMap: null, items: [{ key: 'i1', name: '技術', type: 'number', max: 100, weight: 100 }] },
  { key: 'final', name: '期末', weight: 60, letterMap: null, items: [{ key: 'f1', name: '發表', type: 'number', max: 100, weight: 100 }] },
]

let pool: Pool
let adminId: string
let cohortId: string
let emptyCohortId: string
let teacher: TestSession
const groupIds = new Map<string, string>()
const assignmentIds = new Map<string, string>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function insertCohort(code: string): Promise<string> {
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 'system') returning id`,
    [code, `${code} 成績頁測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  return cohort.rows[0]!.id
}

async function insertGroup(code: string, dissolved = false): Promise<string> {
  const at = new Date(Date.now() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind,
                         dissolved_real_at, dissolve_reason)
     values (gen_random_uuid(), $1, $2, 'general', $3, $4, $4, 'system', $5, $6) returning id`,
    [cohortId, code, dissolved ? 'dissolved' : 'active', at, dissolved ? new Date() : null, dissolved ? '測試解散' : null],
  )
  groupIds.set(code, group.rows[0]!.id)
  return group.rows[0]!.id
}

async function assign(code: string, stageKey: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, now() - interval '1 hour', $4) returning id`,
    [groupIds.get(code), stageKey, teacher.userId, adminId],
  )
  assignmentIds.set(`${code}:${stageKey}`, row.rows[0]!.id)
  return row.rows[0]!.id
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  const teacherContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  teacher = await createTestSession(teacherContext, 'teacher')
  await teacherContext.dispose()
  await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [teacher.userId, TEACHER])

  cohortId = await insertCohort(CODE)
  emptyCohortId = await insertCohort(EMPTY_CODE)
  for (const code of ['G01', 'G02']) await insertGroup(code)
  await insertGroup('G03', true)

  const scheme = await pool.query<{ id: string }>(
    `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
    [cohortId, `${CODE} 評分規則`],
  )
  const versionId = (
    await pool.query<{ id: string }>(
      `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id)
       values (gen_random_uuid(), $1, 1, $2::jsonb, 'published', $3) returning id`,
      [scheme.rows[0]!.id, JSON.stringify(STAGES), adminId],
    )
  ).rows[0]!.id
  await pool.query('update grading_schemes set current_version_id = $2 where id = $1', [scheme.rows[0]!.id, versionId])
  await pool.query(`insert into stage_requirements (group_id, stage_key, required_count, created_by_user_id) values ($1, 'mid', 2, $2)`, [
    groupIds.get('G01'),
    adminId,
  ])

  // 王老師：G01、G02 × 期中、期末＝4 份，已正式送出 G01 期中 1 份；已解散的 G03 期中 1 份不算。
  for (const code of ['G01', 'G02']) for (const stage of ['mid', 'final']) await assign(code, stage)
  await assign('G03', 'mid')
  const counted = assignmentIds.get('G01:mid')!
  const evaluation = await pool.query<{ id: string }>(
    `insert into evaluations (id, assignment_id, kind, scheme_version_id, scores, submitted_real_at, submitted_business_at, request_id)
     values (gen_random_uuid(), $1, 'final', $2, $3::jsonb, now(), now(), gen_random_uuid()) returning id`,
    [counted, versionId, JSON.stringify({ i1: '80' })],
  )
  await pool.query(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [evaluation.rows[0]!.id, counted])
  await pool.query(`update grading_scheme_versions set status = 'locked', locked_at = now() where id = $1`, [versionId])
})

test.afterAll(async () => {
  await pool?.end()
})

/** 成績頁右端帶屆別的「評分規則 ↗」小連結（分頁列另有一個同名分頁，不帶屆別）。 */
function rulesLink(page: Page) {
  return page.getByRole('main').getByRole('link', { name: '評分規則' }).filter({ hasText: '↗' })
}

async function asAdmin(page: Page) {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function noHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth).toBe(clientWidth)
}

test('成績頁：h1「成績」、分頁與「評分規則」連結；設定都不在這頁；評分進度是卡片，預設全部階段、解散的組不算', async ({ page }) => {
  await asAdmin(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/dashboard/admin/grading?cohort=${cohortId}`)

  await expect(page.getByRole('heading', { level: 1, name: '成績', exact: true })).toBeVisible()
  const tabs = page.getByRole('navigation', { name: '成績分頁' })
  await expect(tabs.getByRole('link', { name: '成績表' })).toHaveAttribute('aria-current', 'page')
  await expect(tabs.getByRole('link', { name: '評分規則' })).toHaveAttribute('href', '/dashboard/admin/grading/rules')
  // 分頁列也有「評分規則」：右端那個帶屆別的小連結用「↗」認。
  await expect(rulesLink(page)).toHaveAttribute('href', `/dashboard/admin/grading/rules?cohort=${cohortId}`)

  // 搬到子頁的東西都不在這頁。
  for (const name of ['建立新版評分規則', '評分要求與指派']) await expect(page.getByRole('button', { name })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^版本紀錄/ })).toHaveCount(0)
  for (const name of ['評分規則', '目前版本', '版本紀錄', '評分要求與指派']) await expect(page.getByRole('region', { name, exact: true })).toHaveCount(0)
  await expect(page.getByTestId('scheme-status')).toHaveCount(0)
  // 表格只剩成績表。
  await expect(page.locator('main table')).toHaveCount(1)
  await expect(page.getByRole('table', { name: '成績表' })).toBeVisible()
  await expect(page.getByTestId('gradebook-count')).toHaveText('顯示 3／3 組')

  // 評分進度：全部階段 → 王老師 1／4（已解散的 G03 不算）；期中卡 1／2（只有 G01 設了要 2 份）。
  const progress = page.getByRole('region', { name: '評分進度' })
  await expect(progress.getByRole('link', { name: '全部階段' })).toHaveAttribute('aria-current', 'page')
  const card = progress.getByTestId('teacher-progress').filter({ hasText: TEACHER })
  await expect(card).toContainText('1／4')
  await expect(progress.getByTestId('stage-progress-mid')).toContainText('1／2')
  await expect(progress.getByTestId('stage-progress-final')).toBeVisible()
  await expect(progress.locator('table')).toHaveCount(0)
  await noHorizontalOverflow(page)

  await progress.getByRole('link', { name: '期中' }).click()
  await expect(progress.getByRole('link', { name: '期中' })).toHaveAttribute('aria-current', 'page')
  await expect(progress.getByTestId('teacher-progress').filter({ hasText: TEACHER })).toContainText('1／2')
  await expect(progress.getByTestId('stage-progress-final')).toHaveCount(0)
})

test('評分規則子頁：h1、← 回成績、成績分頁列；目前版本、版本卡；每組一張指派卡，改派連到 reassign', async ({ page }) => {
  await asAdmin(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/dashboard/admin/grading?cohort=${cohortId}`)
  await rulesLink(page).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/grading/rules\\?cohort=${cohortId}$`))

  await expect(page.getByRole('heading', { level: 1, name: '評分規則', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '← 回成績' })).toHaveAttribute('href', `/dashboard/admin/grading?cohort=${cohortId}`)
  // C 階段規格② §2.2：評分規則升成「成績」的第二個分頁（AC-C2-07）。
  const tabs = page.getByRole('navigation', { name: '成績分頁' })
  await expect(tabs.getByRole('link')).toHaveText(['成績表', '評分規則', '評分老師', '結算'])
  await expect(tabs.getByRole('link', { name: '評分規則' })).toHaveAttribute('aria-current', 'page')

  await expect(page.getByTestId('scheme-status')).toHaveText('第 1 版・已鎖定')
  const versions = page.getByRole('region', { name: '版本紀錄' })
  await expect(versions.getByRole('article')).toHaveCount(1)
  await expect(versions.getByRole('article').filter({ hasText: '第 1 版' })).toContainText('已鎖定・目前使用')

  const assign = page.getByRole('region', { name: '評分要求與指派' })
  await expect(assign).toContainText('每組要幾份評分、指派哪位老師評')
  await expect(assign.getByRole('navigation', { name: '選擇階段' }).getByRole('link', { name: '期中' })).toHaveAttribute('aria-current', 'page')
  // 每組一張卡（進行中的組；解散的 G03 不在）：組別、需要幾份、老師與狀態、改派、指派。
  const g01 = page.getByTestId('grading-row-G01')
  await expect(g01).toHaveJSProperty('tagName', 'ARTICLE')
  await expect(page.getByTestId('grading-row-G03')).toHaveCount(0)
  await expect(g01.getByLabel('G01「期中」需要幾位老師評分')).toHaveValue('2')
  await expect(g01).toContainText('已正式送出 1／2 份')
  await expect(g01.getByTestId('evaluator')).toContainText(`${TEACHER}已正式送出`)
  await expect(g01.getByRole('link', { name: `移除或改派 ${TEACHER} 老師` })).toHaveAttribute(
    'href',
    `/dashboard/admin/grading/reassign/${assignmentIds.get('G01:mid')}`,
  )
  await expect(g01.getByRole('button', { name: '指派' })).toBeVisible()
  await expect(assign.locator('table')).toHaveCount(0)
  await noHorizontalOverflow(page)

  await page.getByRole('link', { name: '← 回成績' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '成績', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '評分要求與指派' })).toHaveCount(0)
})

test('新屆別第一次建評分規則：成功訊息在區塊內（標題列不直排）；版本卡「發布第 1 版」→ 已發布', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/rules?cohort=${emptyCohortId}`)
  await expect(page.getByTestId('scheme-status')).toHaveText('還沒有發布的評分規則')
  await expect(page.getByRole('region', { name: '評分要求與指派' })).toContainText('先發布評分規則，才能設定每組要幾份評分、指派哪位老師評')
  const heading = page.getByRole('heading', { level: 1, name: '評分規則', exact: true })
  const lineHeight = await heading.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
  const before = (await heading.boundingBox())!
  // 橫排一行：寬比高大、高度不超過一行；直排是四個字疊起來，寬只有一個字。
  expect(before.width).toBeGreaterThan(before.height)
  expect(before.height).toBeLessThanOrEqual(lineHeight + 1)

  await page.getByRole('button', { name: '建立新版評分規則' }).click()
  await page.getByRole('dialog', { name: '建立新版評分規則' }).getByRole('button', { name: '建立草稿' }).click()
  const current = page.getByRole('region', { name: '目前版本' })
  const hint = current.getByRole('status').filter({ hasText: '已建立評分規則第 1 版（草稿）' })
  await expect(hint).toContainText('「發布」在下方版本紀錄第 1 版那張卡')
  // 網站問題 #8：成功訊息不在標題列，標題不會被擠成直排。
  expect((await heading.boundingBox())!.height).toBe(before.height)

  const card = page.getByRole('region', { name: '版本紀錄' }).getByRole('article').filter({ hasText: '第 1 版' })
  await expect(card).toContainText('草稿')
  await card.getByRole('button', { name: '發布第 1 版' }).click()
  await expect(page.getByTestId('scheme-status')).toHaveText('第 1 版・已發布')
  await expect(card).toContainText('已發布・目前使用')
  await expect(page.getByRole('region', { name: '評分要求與指派' })).toContainText('每組要幾份評分、指派哪位老師評')
})
