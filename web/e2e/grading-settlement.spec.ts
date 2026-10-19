import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * B 階段 A-03（AD-B1；設計方案 §2.5、§2.6）：系辦結算頁、結算期間的退回、計算明細的評語。走真的畫面與按鈕：
 *
 * - AC-A-4：計算明細頁看得到老師該階段的評語全文。
 * - AC-A-5：結算頁對「期中」按「結算」填理由 → 列變「已結算 {時間}・{系辦名}」，採計份數等於當下 counted 數；稽核頁有「結算成績」。
 * - AC-A-7：已結算的期中按「退回」→ CONFLICT 訊息含「先解除結算」，那一份仍採計。
 * - AC-A-8／AC-TE-38（畫面半）：按「解除結算」填理由 → 列回「未結算」，結算紀錄多一列有解除時間與理由；之後退回照常。
 * - AC-A-10（畫面半）：已封存屆別的結算頁只讀，不顯示按鈕。
 *
 * 評分方案、要求份數、指派與正式分數直接用 owner 連線種好（票 23／A-01 的事）；鎖、交錯、守衛順序由整合測試證明。
 * 老師端「已結算」唯讀與恢復可編輯的畫面歸 A-02。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `A03-${stamp}`
const ARCHIVED_CODE = `A03A-${stamp}`
const tag = stamp.slice(-3)
const NAMES = [`結一老師${tag}`, `結二老師${tag}`]
const COMMENT = `期中簡報架構清楚，${tag}\n但系統展示時間不足，建議期末補上壓力測試結果。`

const STAGES = [
  { key: 'mid', name: '期中', weight: 60, letterMap: null, items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }] },
  { key: 'fin', name: '期末', weight: 40, letterMap: null, items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }] },
]

let pool: Pool
let adminId: string
let adminName: string
let cohortId: string
let archivedCohortId: string
let groupId: string
let midEvaluationId: string
let teachers: TestSession[] = []

async function insertCohort(code: string, status: 'active' | 'archived'): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, $3, (now() + interval '300 days')::date, false, 'system') returning id`,
    [code, `${code} 結算測試`, status],
  )
  return row.rows[0]!.id
}

async function insertScheme(cohort: string): Promise<string> {
  const scheme = await pool.query<{ id: string }>(
    `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
    [cohort, `${CODE} 評分方案`],
  )
  const version = await pool.query<{ id: string }>(
    `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id, locked_at)
     values (gen_random_uuid(), $1, 1, $2::jsonb, 'locked', $3, now()) returning id`,
    [scheme.rows[0]!.id, JSON.stringify(STAGES), adminId],
  )
  await pool.query('update grading_schemes set current_version_id = $2 where id = $1', [scheme.rows[0]!.id, version.rows[0]!.id])
  return version.rows[0]!.id
}

async function insertGroup(cohort: string, code: string): Promise<string> {
  const at = new Date(Date.now() - 86_400_000)
  const row = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', 'active', $3, $3, 'system') returning id`,
    [cohort, code, at],
  )
  return row.rows[0]!.id
}

async function assign(group: string, stageKey: string, teacherId: string): Promise<string> {
  await pool.query(
    `insert into stage_requirements (group_id, stage_key, required_count, created_by_user_id) values ($1, $2, 1, $3)
     on conflict do nothing`,
    [group, stageKey, adminId],
  )
  const row = await pool.query<{ id: string }>(
    `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, now() - interval '1 hour', $4) returning id`,
    [group, stageKey, teacherId, adminId],
  )
  return row.rows[0]!.id
}

async function counted(assignmentId: string, versionId: string, value: string, comment: string | null): Promise<string> {
  const e = await pool.query<{ id: string }>(
    `insert into evaluations (id, assignment_id, kind, scheme_version_id, scores, comment, submitted_real_at, submitted_business_at, request_id)
     values (gen_random_uuid(), $1, 'final', $2, $3::jsonb, $4, now(), now(), gen_random_uuid()) returning id`,
    [assignmentId, versionId, JSON.stringify({ i1: value }), comment],
  )
  await pool.query(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [e.rows[0]!.id, assignmentId])
  return e.rows[0]!.id
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  adminName = (
    await pool.query<{ name: string }>(
      `select coalesce(nullif(btrim(p.display_name), ''), u.name) as name from users u left join user_profiles p on p.user_id = u.id where u.id = $1`,
      [adminId],
    )
  ).rows[0]!.name
  teachers = []
  for (const name of NAMES) {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      const session = await createTestSession(context, 'teacher')
      await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [session.userId, name])
      teachers.push(session)
    } finally {
      await context.dispose()
    }
  }

  cohortId = await insertCohort(CODE, 'active')
  const versionId = await insertScheme(cohortId)
  groupId = await insertGroup(cohortId, 'G01')
  // G01：期中 結一＝80（附評語）、期末 結二＝90，都已正式送出。
  midEvaluationId = await counted(await assign(groupId, 'mid', teachers[0]!.userId), versionId, '80', COMMENT)
  await counted(await assign(groupId, 'fin', teachers[1]!.userId), versionId, '90', null)

  archivedCohortId = await insertCohort(ARCHIVED_CODE, 'archived')
  await insertScheme(archivedCohortId)
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
}

const settleRow = (page: Page, key: string) => page.getByTestId(`settle-row-${key}`)

test('AC-A-4：計算明細頁看得到老師該階段的評語全文', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/${groupId}`)
  const mid = page.getByTestId('detail-stage-mid')
  const comment = mid.getByTestId('stage-comment')
  await expect(comment).toHaveCount(1)
  await expect(comment).toContainText(NAMES[0]!)
  // 全文（含換行）都在，不截斷。
  expect(await comment.locator('p').nth(1).innerText()).toBe(COMMENT)
  // 期末沒有評語：不出現評語區。
  await expect(page.getByTestId('detail-stage-fin').getByTestId('stage-comments')).toHaveCount(0)
})

test('成績分頁多一個「結算」；結算頁每階段一列：未結算、採計份數／應有份數', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading?cohort=${cohortId}`)
  const tabs = page.getByRole('navigation', { name: '成績分頁' })
  await expect(tabs.getByRole('link')).toHaveText(['成績表', '評分規則', '評分老師', '結算'])
  await tabs.getByRole('link', { name: '結算' }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/grading\/settle/)

  await page.goto(`/dashboard/admin/grading/settle?cohort=${cohortId}`)
  await expect(page.getByRole('navigation', { name: '成績分頁' }).getByRole('link', { name: '結算' })).toHaveAttribute('aria-current', 'page')
  for (const key of ['mid', 'fin']) {
    await expect(settleRow(page, key).getByTestId('settle-status')).toHaveText('未結算')
    await expect(settleRow(page, key).getByTestId('counted')).toHaveText('1／1')
  }
  await expect(page.getByRole('table', { name: '結算紀錄' })).toContainText('還沒有結算紀錄')
})

test('AC-A-5：對「期中」按「結算」填理由 → 已結算 {時間}・{系辦名}，採計份數＝當下 counted；稽核頁有「結算成績」', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/settle?cohort=${cohortId}`)
  await settleRow(page, 'mid').getByRole('button', { name: '結算「期中」' }).click()
  const dialog = page.getByRole('dialog', { name: '結算「期中」' })
  // C1-13：理由選填（留空也能結算，見 grading-stage-settings.spec 的 AC-31）；這裡填理由，驗理由會記下來。
  await dialog.getByLabel('結算理由（選填）').fill('期中成績送教務處')
  await dialog.getByRole('button', { name: '確認結算' }).click()

  const status = settleRow(page, 'mid').getByTestId('settle-status')
  await expect(status).toContainText('已結算')
  await expect(status).toContainText(`・${adminName}`)
  await expect(status).toContainText('理由：期中成績送教務處')
  await expect(status).toContainText(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/)
  await expect(settleRow(page, 'mid').getByTestId('counted')).toHaveText('1／1')
  await expect(settleRow(page, 'mid').getByRole('button', { name: '解除「期中」的結算' })).toBeVisible()
  await expect(settleRow(page, 'fin').getByTestId('settle-status')).toHaveText('未結算')

  const rows = await pool.query<{ counted_evaluations: number; settled_by_user_id: string }>(
    `select counted_evaluations, settled_by_user_id from grade_settlements where cohort_id = $1 and stage_key = 'mid' and released_at is null`,
    [cohortId],
  )
  expect(rows.rows).toEqual([{ counted_evaluations: 1, settled_by_user_id: adminId }])
  const audit = await pool.query(`select payload from audit_events where action = 'grading.settle' and cohort_id = $1`, [cohortId])
  expect(audit.rows).toHaveLength(1)
  expect(audit.rows[0]!.payload).toMatchObject({ stageKey: 'mid', stageName: '期中', countedEvaluations: 1, reason: '期中成績送教務處' })

  await page.goto('/dashboard/admin/audit')
  await expect(page.getByTestId('audit-entry').filter({ hasText: '結算成績' }).first()).toBeVisible()
})

test('AC-A-7：已結算的期中按「退回」→ 訊息含「先解除結算」，那一份仍採計', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/${groupId}`)
  await page.getByRole('button', { name: `退回 ${NAMES[0]} 老師的「期中」評分` }).click()
  const dialog = page.getByRole('dialog', { name: '退回評分' })
  await dialog.getByLabel('退回理由（老師看得到）').fill('請補評語')
  await dialog.getByRole('button', { name: '確認退回' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('期中已結算，要修改請先解除結算。')
  const state = await pool.query<{ state: string }>('select state from evaluation_status where evaluation_id = $1', [midEvaluationId])
  expect(state.rows[0]!.state).toBe('counted')
})

test('AC-A-8／AC-TE-38：按「解除結算」填理由 → 列回到「未結算」，結算紀錄有解除時間與理由；之後退回照常', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/settle?cohort=${cohortId}`)
  await settleRow(page, 'mid').getByRole('button', { name: '解除「期中」的結算' }).click()
  const dialog = page.getByRole('dialog', { name: '解除「期中」的結算' })
  await dialog.getByLabel('解除理由（選填）').fill('老師要補評語')
  await dialog.getByRole('button', { name: '確認解除' }).click()

  await expect(settleRow(page, 'mid').getByTestId('settle-status')).toHaveText('未結算')
  await expect(settleRow(page, 'mid').getByRole('button', { name: '結算「期中」' })).toBeVisible()
  const history = page.getByTestId('settlement-history')
  await expect(history).toHaveCount(1)
  await expect(history).toContainText('期中')
  await expect(history).toContainText('理由：期中成績送教務處')
  await expect(history.getByTestId('released')).toContainText(`・${adminName}`)
  await expect(history.getByTestId('released')).toContainText('理由：老師要補評語')
  await expect(history.getByTestId('released')).toContainText(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/)

  const released = await pool.query(`select release_reason from grade_settlements where cohort_id = $1 and released_at is not null`, [cohortId])
  expect(released.rows).toEqual([{ release_reason: '老師要補評語' }])
  expect((await pool.query(`select 1 from audit_events where action = 'grading.release' and cohort_id = $1`, [cohortId])).rowCount).toBe(1)

  // 再結算一次：結算紀錄新的在前（現行那筆在上、已解除的在下）。
  await settleRow(page, 'mid').getByRole('button', { name: '結算「期中」' }).click()
  const again = page.getByRole('dialog', { name: '結算「期中」' })
  await again.getByLabel('結算理由（選填）').fill('補完再結')
  await again.getByRole('button', { name: '確認結算' }).click()
  await expect(history).toHaveCount(2)
  await expect(history.nth(0).getByTestId('released')).toHaveText('結算中')
  await expect(history.nth(1).getByTestId('released')).toContainText('理由：老師要補評語')
  // 解除給後面的退回案例：再解除一次。
  await settleRow(page, 'mid').getByRole('button', { name: '解除「期中」的結算' }).click()
  const release2 = page.getByRole('dialog', { name: '解除「期中」的結算' })
  await release2.getByLabel('解除理由（選填）').fill('改走退回')
  await release2.getByRole('button', { name: '確認解除' }).click()
  await expect(settleRow(page, 'mid').getByTestId('settle-status')).toHaveText('未結算')

  // 解除後退回照常。
  await page.goto(`/dashboard/admin/grading/${groupId}`)
  await page.getByRole('button', { name: `退回 ${NAMES[0]} 老師的「期中」評分` }).click()
  const back = page.getByRole('dialog', { name: '退回評分' })
  await back.getByLabel('退回理由（老師看得到）').fill('請補評語')
  await back.getByRole('button', { name: '確認退回' }).click()
  await expect(page.getByRole('status').filter({ hasText: '退回' }).first()).toBeVisible()
  const state = await pool.query<{ state: string }>('select state from evaluation_status where evaluation_id = $1', [midEvaluationId])
  expect(state.rows[0]!.state).toBe('returned')
})

test('AC-A-10（畫面半）：已封存屆別的結算頁只讀，不顯示「結算」「解除結算」', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/settle?cohort=${archivedCohortId}`)
  await expect(page.getByTestId('cohort-archived')).toContainText('已封存')
  await expect(settleRow(page, 'mid').getByTestId('settle-status')).toHaveText('未結算')
  await expect(page.getByRole('table', { name: '各評分項目結算' }).getByRole('button')).toHaveCount(0)
})
