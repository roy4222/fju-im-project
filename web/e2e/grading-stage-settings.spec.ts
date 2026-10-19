import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * C1-13：系辦「成績」四個分頁的內容（C 階段規格① §7.4；驗收案例 AC-26、AC-30、AC-30a、AC-30b、AC-31、AC-32）。
 *
 * - 屆別 A（方案已鎖定）：評分規則改對應作業與說明不建新版（AC-26）；成績表「尚缺 N 位評分老師」連到評分老師分頁並高亮（AC-30）；
 *   三位老師 80／90／100 平均 90（AC-32）；結算與解除理由留空都成功、成績表標「已結算」、老師批改頁唯讀（AC-31）。
 * - 屆別 B：兩項評審不一致時設成同一組評審被擋、對齊後才存得進去（AC-30b）；同一組評審在評分老師分頁合成一列，
 *   要幾位、指派、移除都兩項一起動（AC-30a）。
 *
 * 方案、指派、正式評分用 owner 連線直接種（評分流程是 grading.spec 的事）；被驗的動作都走真的畫面。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const tag = stamp.slice(-3)
const CODE_A = `C113A-${stamp}`
const CODE_B = `C113B-${stamp}`
const NAMES = { 甲: `甲老師${tag}`, 乙: `乙老師${tag}`, 丙: `丙老師${tag}`, 丁: `丁老師${tag}` } as const
type Who = keyof typeof NAMES
const ITEM_TITLE = `${CODE_A} 系統驗收文件`

const STAGES = [
  { key: 's1', name: '系統驗收', weight: 60, letterMap: null, items: [{ key: 'i1', name: '功能完整度', type: 'number', max: 100, weight: 100 }] },
  { key: 's2', name: '專題發表', weight: 40, letterMap: null, items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }] },
]

let pool: Pool
let adminId: string
const teachers = {} as Record<Who, TestSession>
const cohorts = { A: '', B: '' }
const versions = { A: '', B: '' }
const groups = new Map<string, string>()
let itemId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function insertCohort(code: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 'system') returning id`,
    [code, `${code} 成績分頁測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  return row.rows[0]!.id
}

async function insertGroup(cohortId: string, key: string, code: string): Promise<string> {
  const at = new Date(Date.now() - 86_400_000)
  const row = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', 'active', $3, $3, 'system') returning id`,
    [cohortId, code, at],
  )
  groups.set(key, row.rows[0]!.id)
  return row.rows[0]!.id
}

async function insertScheme(cohortId: string, code: string): Promise<string> {
  const scheme = await pool.query<{ id: string }>(
    `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
    [cohortId, `${code} 評分規則`],
  )
  const version = await pool.query<{ id: string }>(
    `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, 'published', $3) returning id`,
    [scheme.rows[0]!.id, JSON.stringify(STAGES), adminId],
  )
  await pool.query('update grading_schemes set current_version_id = $2 where id = $1', [scheme.rows[0]!.id, version.rows[0]!.id])
  return version.rows[0]!.id
}

async function requirement(groupId: string, stageKey: string, count: number) {
  await pool.query(`insert into stage_requirements (group_id, stage_key, required_count, created_by_user_id) values ($1, $2, $3, $4)`, [
    groupId,
    stageKey,
    count,
    adminId,
  ])
}

async function assign(groupId: string, stageKey: string, who: Who): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, now() - interval '1 hour', $4) returning id`,
    [groupId, stageKey, teachers[who].userId, adminId],
  )
  return row.rows[0]!.id
}

async function counted(assignmentId: string, versionId: string, value: string) {
  const e = await pool.query<{ id: string }>(
    `insert into evaluations (id, assignment_id, kind, scheme_version_id, scores, submitted_real_at, submitted_business_at, request_id)
     values (gen_random_uuid(), $1, 'final', $2, $3::jsonb, now(), now(), gen_random_uuid()) returning id`,
    [assignmentId, versionId, JSON.stringify({ i1: value })],
  )
  await pool.query(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [e.rows[0]!.id, assignmentId])
}

/** 屆別 A 一份已發布、整組繳交的作業（評分規則的「對應作業」選項）。 */
async function insertGroupItem(cohortId: string, title: string): Promise<string> {
  const item = await pool.query<{ id: string }>(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, status, due_at,
        title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
     values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'group', 'draft', now() + interval '10 days',
             $2, 'C1-13 e2e', '<p>請繳交。</p>', '{"fields":[]}'::jsonb, 'user', $3, $3)
     returning id`,
    [cohortId, title, adminId],
  )
  const id = item.rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, 'C1-13 e2e', '<p>請繳交。</p>', $3) returning id`,
    [id, title, adminId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
    [id, adminId],
  )
  await pool.query(
    `update managed_items set status = 'published', actual_opened_at = now() - interval '1 day', current_content_version_id = $2, current_schema_version_id = $3
      where id = $1`,
    [id, content.rows[0]!.id, schema.rows[0]!.id],
  )
  return id
}

test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  for (const who of Object.keys(NAMES) as Who[]) {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    teachers[who] = await createTestSession(context, 'teacher')
    await context.dispose()
    await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [teachers[who].userId, NAMES[who]])
  }

  // 屆別 A：G01「系統驗收」要 3 位、甲乙丙各送出 80／90／100（方案因此鎖定）；G02「專題發表」要 3 位、只指派甲。
  cohorts.A = await insertCohort(CODE_A)
  versions.A = await insertScheme(cohorts.A, CODE_A)
  const a1 = await insertGroup(cohorts.A, 'A:G01', 'G01')
  const a2 = await insertGroup(cohorts.A, 'A:G02', 'G02')
  await requirement(a1, 's1', 3)
  for (const [who, value] of [['甲', '80'], ['乙', '90'], ['丙', '100']] as const) await counted(await assign(a1, 's1', who), versions.A, value)
  await pool.query(`update grading_scheme_versions set status = 'locked', locked_at = now() where id = $1`, [versions.A])
  await requirement(a2, 's2', 3)
  await assign(a2, 's2', '甲')
  itemId = await insertGroupItem(cohorts.A, ITEM_TITLE)

  // 屆別 B：G01 兩項都還沒指派；G03「系統驗收」甲乙、「專題發表」甲丁（評審不一致）。
  cohorts.B = await insertCohort(CODE_B)
  versions.B = await insertScheme(cohorts.B, CODE_B)
  await insertGroup(cohorts.B, 'B:G01', 'G01')
  const b3 = await insertGroup(cohorts.B, 'B:G03', 'G03')
  for (const who of ['甲', '乙'] as const) await assign(b3, 's1', who)
  for (const who of ['甲', '丁'] as const) await assign(b3, 's2', who)
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function asAdmin(page: Page) {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
}

const stageForm = (page: Page, name: string) => page.getByRole('form', { name: `「${name}」的對應作業與說明` })
const unitRow = (page: Page, code: string, name: string) => page.getByTestId(`grading-row-${code}`).getByRole('group', { name: `${code}「${name}」` })

async function settings(cohortId: string) {
  return (
    await pool.query<{ stage_key: string; item_id: string | null; description: string | null; panel_key: string | null }>(
      'select stage_key, item_id, description, panel_key from grading_stage_settings where cohort_id = $1 order by stage_key',
      [cohortId],
    )
  ).rows
}

async function versionCount(cohortId: string): Promise<number> {
  const row = await pool.query<{ n: number }>(
    `select count(*)::int as n from grading_scheme_versions v join grading_schemes s on s.id = v.scheme_id where s.cohort_id = $1`,
    [cohortId],
  )
  return row.rows[0]!.n
}

/** 移除一位評分老師（改派頁「替換、不指派新老師」＝只移除，理由留空）。 */
async function removeOnly(page: Page, row: ReturnType<typeof unitRow>, who: Who) {
  await row.getByRole('link', { name: `移除或改派 ${NAMES[who]} 老師` }).click()
  await expect(page.getByRole('heading', { name: '移除或改派評分老師' })).toBeVisible()
  await page.getByTestId('choice-replace').getByRole('radio').check()
  await page.getByRole('button', { name: '確認執行' }).click()
  await expect(page.getByRole('link', { name: /計算明細/ })).toBeVisible()
}

test('AC-26：評分規則改對應作業與說明 → 立刻生效、不建新版、版本號與分數不變；用詞是評分項目／細項；改結構才提示建新版', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/rules?cohort=${cohorts.A}`)
  await expect(page.getByTestId('scheme-status')).toHaveText('第 1 版・已鎖定')
  const main = page.getByRole('main')
  await expect(main).toContainText('評分項目')
  await expect(main).toContainText('細項')
  for (const old of ['計分階段', '要求份數', '建立新版']) await expect(main).not.toContainText(old)
  const scoresBefore = await pool.query('select id, scores from evaluations order by id')

  const s1 = stageForm(page, '系統驗收')
  await s1.getByLabel('對應作業').selectOption({ label: ITEM_TITLE })
  await s1.getByRole('button', { name: '儲存' }).click()
  await expect(s1.getByRole('status')).toContainText('已儲存「系統驗收」：不用建新版')

  const s2 = stageForm(page, '專題發表')
  await s2.getByLabel('說明').fill('依發表當天表現評分')
  await s2.getByRole('button', { name: '儲存' }).click()
  await expect(s2.getByRole('status')).toContainText('已儲存「專題發表」')

  await page.reload()
  await expect(page.getByTestId('scheme-status')).toHaveText('第 1 版・已鎖定')
  await expect(page.getByRole('region', { name: '版本紀錄' }).getByRole('article')).toHaveCount(1)
  await expect(stageForm(page, '系統驗收').getByLabel('對應作業')).toHaveValue(itemId)
  await expect(stageForm(page, '專題發表').getByLabel('說明')).toHaveValue('依發表當天表現評分')
  expect(await versionCount(cohorts.A)).toBe(1)
  expect(await settings(cohorts.A)).toEqual([
    { stage_key: 's1', item_id: itemId, description: null, panel_key: null },
    { stage_key: 's2', item_id: null, description: '依發表當天表現評分', panel_key: null },
  ])
  expect((await pool.query('select id, scores from evaluations order by id')).rows).toEqual(scoresBefore.rows)

  // 要改比例、細項（結構）才開「修改評分規則」，那裡才提示已有老師填分、改結構會建新版。
  await page.getByRole('button', { name: '修改評分規則' }).click()
  const dialog = page.getByRole('dialog', { name: '修改評分規則' })
  await expect(dialog.getByRole('note')).toContainText('已有老師填分，改結構會建新版')
  await expect(dialog.getByLabel('第 1 個評分項目第 1 個細項名稱')).toHaveValue('功能完整度')
  // 「專題發表」只有一個「總分」細項＝直接填總分。
  await expect(dialog.getByRole('listitem', { name: '第 2 個評分項目' }).getByLabel('直接填總分（不分細項）')).toBeChecked()
  await dialog.getByRole('button', { name: '先不要' }).click()
  expect(await versionCount(cohorts.A)).toBe(1)
})

test('AC-30：成績表「尚缺 2 位評分老師」是連結 → 評分老師分頁捲到該組、高亮「專題發表」那一列；CSV 註記字串不變', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading?cohort=${cohorts.A}`)
  const g2 = groups.get('A:G02')!
  const link = page.getByTestId('gradebook-row-G02').getByRole('link', { name: '專題發表：尚缺 2 位評分老師' })
  await expect(link).toHaveAttribute('href', new RegExp(`^/dashboard/admin/grading/teachers\\?group=${g2}&stage=s2(&|$)`))
  // 紅字（跟其他待處理註記同一個顏色）。
  await expect(link).toHaveClass(/text-destructive/)

  await link.click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/grading/teachers\\?group=${g2}&stage=s2`))
  await expect(page.getByRole('navigation', { name: '成績分頁' }).getByRole('link', { name: '評分老師' })).toHaveAttribute('aria-current', 'page')
  const row = unitRow(page, 'G02', '專題發表')
  await expect(row).toHaveAttribute('data-highlight', 'true')
  await expect(row).toBeInViewport()
  await expect(row.getByRole('button', { name: '指派' })).toBeVisible()
  await expect(unitRow(page, 'G02', '系統驗收')).not.toHaveAttribute('data-highlight', 'true')

  const admin = await sharedTestSession(page.request, 'admin')
  const response = await page.request.post('/api/admin/grading/export', {
    headers: { cookie: admin.cookie, origin: BASE_URL, 'content-type': 'application/json' },
    data: { cohortId: cohorts.A, format: 'csv', filter: {} },
  })
  expect(response.status()).toBe(200)
  expect(await response.text()).toContain('專題發表：尚缺 2 位評分老師（待指派）')
})

test('AC-32：三位老師 80／90／100 → 成績表「系統驗收」平均 90.00，計算明細列出三位老師與分數', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading?cohort=${cohorts.A}`)
  const cell = page.getByTestId('gradebook-row-G01').getByTestId('stage-s1')
  await expect(cell).toContainText('90.00')
  await expect(cell).toContainText('已完成')

  await page.goto(`/dashboard/admin/grading/${groups.get('A:G01')}`)
  await expect(page.getByRole('heading', { name: 'G01 計算明細' })).toBeVisible()
  const detail = page.getByTestId('detail-stage-s1')
  for (const [who, value] of [['甲', '80.00'], ['乙', '90.00'], ['丙', '100.00']] as const) {
    await expect(detail).toContainText(NAMES[who])
    await expect(detail).toContainText(value)
  }
})

test('AC-31：結算「系統驗收」理由留空 → 成功、成績表標已結算、老師批改頁唯讀；解除結算理由留空也成功', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/settle?cohort=${cohorts.A}`)
  const row = page.getByTestId('settle-row-s1')
  await row.getByRole('button', { name: '結算「系統驗收」' }).click()
  const dialog = page.getByRole('dialog', { name: '結算「系統驗收」' })
  await expect(dialog.getByLabel('結算理由（選填）')).toHaveValue('')
  await dialog.getByRole('button', { name: '確認結算' }).click()
  await expect(row.getByTestId('settle-status')).toContainText('已結算')
  await expect(row.getByTestId('settle-status')).not.toContainText('理由')
  const settled = await pool.query(`select reason from grade_settlements where cohort_id = $1 and stage_key = 's1' and released_at is null`, [cohorts.A])
  expect(settled.rows).toEqual([{ reason: null }])

  await page.goto(`/dashboard/admin/grading?cohort=${cohorts.A}`)
  await expect(page.getByTestId('stage-head-s1')).toContainText('已結算')
  await expect(page.getByTestId('stage-head-s2')).not.toContainText('已結算')

  await signIn(page, teachers.甲)
  await page.goto(`/dashboard/teacher/grading/${groups.get('A:G01')}?stage=s1`)
  await expect(page.getByTestId('settled-notice')).toBeVisible()

  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/settle?cohort=${cohorts.A}`)
  await row.getByRole('button', { name: '解除「系統驗收」的結算' }).click()
  const release = page.getByRole('dialog', { name: '解除「系統驗收」的結算' })
  await release.getByRole('button', { name: '確認解除' }).click()
  await expect(row.getByTestId('settle-status')).toHaveText('未結算')
  const released = await pool.query(`select release_reason from grade_settlements where cohort_id = $1 and stage_key = 's1'`, [cohorts.A])
  expect(released.rows).toEqual([{ release_reason: null }])
})

test('AC-30b：兩項評審不同時設成同一組評審 → 被擋並列出組別、連到評分老師分頁，DB 不變；對齊後再存成功', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/rules?cohort=${cohorts.B}`)
  const assignmentsBefore = (
    await pool.query(
      `select a.id, a.stage_key, a.teacher_user_id, a.valid_to from evaluator_assignments a join groups g on g.id = a.group_id where g.cohort_id = $1 order by a.id`,
      [cohorts.B],
    )
  ).rows

  const s2 = stageForm(page, '專題發表')
  await s2.getByLabel('評審組').selectOption({ label: '與『系統驗收』同一組評審' })
  await s2.getByRole('button', { name: '儲存' }).click()
  await expect(s2.getByRole('alert')).toHaveText('G03 的『系統驗收』與『專題發表』評審不同，請先在評分老師分頁對齊。')
  await expect(s2.getByRole('link', { name: '前往評分老師分頁對齊' })).toHaveAttribute('href', `/dashboard/admin/grading/teachers?cohort=${cohorts.B}`)
  expect(await settings(cohorts.B)).toEqual([])
  const assignmentsAfter = (
    await pool.query(
      `select a.id, a.stage_key, a.teacher_user_id, a.valid_to from evaluator_assignments a join groups g on g.id = a.group_id where g.cohort_id = $1 order by a.id`,
      [cohorts.B],
    )
  ).rows
  expect(assignmentsAfter).toEqual(assignmentsBefore)

  // 對齊：G03「專題發表」移除丁、補乙。
  await s2.getByRole('link', { name: '前往評分老師分頁對齊' }).click()
  await removeOnly(page, unitRow(page, 'G03', '專題發表'), '丁')
  await page.goto(`/dashboard/admin/grading/teachers?cohort=${cohorts.B}`)
  const g3s2 = unitRow(page, 'G03', '專題發表')
  await g3s2.getByLabel('G03「專題發表」評分老師').selectOption({ label: NAMES.乙 })
  await g3s2.getByRole('button', { name: '指派' }).click()
  await expect(g3s2.getByRole('status')).toContainText(`已指派 ${NAMES.乙} 老師評 G03「專題發表」`)

  await page.goto(`/dashboard/admin/grading/rules?cohort=${cohorts.B}`)
  const again = stageForm(page, '專題發表')
  await again.getByLabel('評審組').selectOption({ label: '與『系統驗收』同一組評審' })
  await again.getByRole('button', { name: '儲存' }).click()
  await expect(again.getByRole('status')).toContainText('已儲存「專題發表」')
  const rows = await settings(cohorts.B)
  expect(rows.map((r) => r.stage_key)).toEqual(['s1', 's2'])
  expect(rows[0]!.panel_key).not.toBeNull()
  expect(rows[1]!.panel_key).toBe(rows[0]!.panel_key)
  expect(await versionCount(cohorts.B)).toBe(1)
  await page.reload()
  await expect(stageForm(page, '專題發表').getByLabel('評審組')).toHaveValue('s1')
  await expect(stageForm(page, '系統驗收').getByLabel('評審組')).toHaveValue('s2')
})

test('AC-30a：同一組評審在評分老師分頁合成一列；要 3 位、指派甲乙丙兩項同交易各一筆；移除乙兩項都結束；兩項各自一份成績', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/teachers?cohort=${cohorts.B}`)
  const row = unitRow(page, 'G01', '系統驗收＋專題發表')
  await expect(row).toContainText('（同一組評審）')
  await expect(page.getByTestId('grading-row-G01').getByRole('group')).toHaveCount(1)

  await row.getByLabel('G01「系統驗收＋專題發表」要幾位老師評').fill('3')
  await row.getByRole('button', { name: '儲存' }).click()
  await expect(row.getByTestId('counted')).toContainText('系統驗收 已正式送出 0／3 份')
  for (const who of ['甲', '乙', '丙'] as const) {
    await row.getByLabel('G01「系統驗收＋專題發表」評分老師').selectOption({ label: NAMES[who] })
    await row.getByRole('button', { name: '指派' }).click()
    await expect(row.getByRole('status')).toContainText(`已指派 ${NAMES[who]} 老師評 G01「系統驗收＋專題發表」`)
  }
  await expect(row.getByTestId('evaluator')).toHaveCount(3)

  const g1 = groups.get('B:G01')!
  const requirements = await pool.query<{ stage_key: string; required_count: number }>(
    'select stage_key, required_count from stage_requirements where group_id = $1 order by stage_key',
    [g1],
  )
  expect(requirements.rows).toEqual([
    { stage_key: 's1', required_count: 3 },
    { stage_key: 's2', required_count: 3 },
  ])
  const assignments = await pool.query<{ teacher_user_id: string; stage_key: string; created_at: Date }>(
    'select teacher_user_id, stage_key, created_at from evaluator_assignments where group_id = $1 and valid_to is null order by teacher_user_id, stage_key',
    [g1],
  )
  expect(assignments.rows).toHaveLength(6)
  for (const who of ['甲', '乙', '丙'] as const) {
    const mine = assignments.rows.filter((r) => r.teacher_user_id === teachers[who].userId)
    expect(mine.map((r) => r.stage_key)).toEqual(['s1', 's2'])
    expect(mine[0]!.created_at.getTime()).toBe(mine[1]!.created_at.getTime())
  }

  // 移除乙：兩項的乙都結束。
  await removeOnly(page, row, '乙')
  const ended = await pool.query<{ stage_key: string; valid_to: Date | null }>(
    'select stage_key, valid_to from evaluator_assignments where group_id = $1 and teacher_user_id = $2 order by stage_key',
    [g1, teachers.乙.userId],
  )
  expect(ended.rows.map((r) => r.stage_key)).toEqual(['s1', 's2'])
  expect(ended.rows.every((r) => r.valid_to !== null)).toBe(true)

  // 甲在「系統驗收」送出分數不影響「專題發表」：兩份成績、成績表兩項各自算。
  const s1 = await pool.query<{ id: string }>(
    `select id from evaluator_assignments where group_id = $1 and teacher_user_id = $2 and stage_key = 's1' and valid_to is null`,
    [g1, teachers.甲.userId],
  )
  await counted(s1.rows[0]!.id, versions.B, '88')
  await page.goto(`/dashboard/admin/grading?cohort=${cohorts.B}`)
  const book = page.getByTestId('gradebook-row-G01')
  await expect(book.getByTestId('stage-s1')).toContainText('1／3')
  await expect(book.getByTestId('stage-s2')).toContainText('0／3')
})
