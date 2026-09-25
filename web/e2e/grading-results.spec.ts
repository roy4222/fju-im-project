import fs from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 24（#235）：成績表、退回、更正與匯出。「做完的樣子」逐條走真的畫面與按鈕：
 *
 * 1. 成績表顯示各組各階段平均與最終（兩位小數），可看計算明細；未達要求份數標「尚未完成」。
 * 2. 系辦退回某位老師的正式分數，老師收到通知（附理由）後修改重送；系辦更正最終結果保留原值與理由，
 *    計算基礎變了進「待復核」，復核後沿用。
 * 3. 移除或改派評分老師時預覽三選一（保留／替換／新增）；預覽過期要重做。
 * 4. 方案鎖定後建新版本改權重，套用前先看影響（取消不重算）。
 * 5. 匯出整屆成績 XLSX／CSV，學號保留前導零；老師被停用時顯示「缺評待處理」。
 *
 * 評分方案、要求份數、指派與已送出的兩份期中分數直接用 owner 連線種好（那是票 23 的事，grading.spec 走過畫面）；
 * 數字用案例本身的：80／84.29 → 82.145（82.15）；期中 60%、期末 40%。
 * 計算、預覽過期四種衝突、並發、授權的細節由整合測試 pg-grading-results.integration.test.ts 證明。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T24-${stamp}`
const tag = stamp.slice(-3)
const NAMES = [`評一老師${tag}`, `評二老師${tag}`, `評三老師${tag}`, `評四老師${tag}`, `評五老師${tag}`]

let pool: Pool
let cohortId: string
let adminId: string
let teachers: TestSession[] = []
let student: TestSession
const groupIds = new Map<string, string>()
const studentNos: string[] = []

const STAGES = [
  {
    key: 'mid',
    name: '期中',
    weight: 60,
    letterMap: null,
    items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }],
  },
  {
    key: 'fin',
    name: '期末',
    weight: 40,
    letterMap: null,
    items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }],
  },
]

let seq = 0
async function insertStudent(): Promise<string> {
  seq += 1
  // 學號故意以 0 開頭：匯出要保留前導零。
  const studentNo = `04${String(Date.now()).slice(-6)}${seq}`
  studentNos.push(studentNo)
  const user = await pool.query<{ id: string }>(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [`組員${seq}`, `t24-${stamp.toLowerCase()}-${seq}@example.com`],
  )
  const id = user.rows[0]!.id
  await pool.query(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)`,
    [id, `組員${seq}`, studentNo, cohortId, `t24-${seq}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return id
}

async function insertGroup(code: string): Promise<string> {
  const members = [await insertStudent(), await insertStudent()]
  const at = new Date(Date.now() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', 'active', $3, $3, 'system') returning id`,
    [cohortId, code, at],
  )
  const id = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
     select gen_random_uuid(), $1, $2, u, $3, 'system' from unnest($4::uuid[]) as u`,
    [id, cohortId, at, members],
  )
  await pool.query(`insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, $3, $2)`, [
    id,
    members[0],
    at,
  ])
  groupIds.set(code, id)
  return id
}

async function assign(groupId: string, stageKey: string, teacherId: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, now() - interval '1 hour', $4) returning id`,
    [groupId, stageKey, teacherId, adminId],
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

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  const fresh = async (role: 'teacher' | 'student') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  teachers = []
  for (const name of NAMES) {
    const session = await fresh('teacher')
    await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [session.userId, name])
    teachers.push(session)
  }
  student = await fresh('student')

  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', (now() + interval '300 days')::date, false, 'system') returning id`,
    [CODE, `${CODE} 成績測試`],
  )
  cohortId = cohort.rows[0]!.id
  const g1 = await insertGroup('G01')
  const g2 = await insertGroup('G02')

  const scheme = await pool.query<{ id: string }>(
    `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
    [cohortId, `${CODE} 評分方案`],
  )
  const version = await pool.query<{ id: string }>(
    `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, 'published', $3) returning id`,
    [scheme.rows[0]!.id, JSON.stringify(STAGES), adminId],
  )
  const versionId = version.rows[0]!.id
  await pool.query('update grading_schemes set current_version_id = $2 where id = $1', [scheme.rows[0]!.id, versionId])
  for (const [groupId, stageKey, count] of [
    [g1, 'mid', 2],
    [g1, 'fin', 1],
    [g2, 'mid', 1],
    [g2, 'fin', 1],
  ] as const) {
    await pool.query(`insert into stage_requirements (group_id, stage_key, required_count, created_by_user_id) values ($1, $2, $3, $4)`, [
      groupId,
      stageKey,
      count,
      adminId,
    ])
  }
  // G01：期中 評一＝80、評三＝84.29 已正式送出；期末 評二還沒送。G02：期中 評五（之後會被停用）還沒送。
  await counted(await assign(g1, 'mid', teachers[0]!.userId), versionId, '80')
  await counted(await assign(g1, 'mid', teachers[2]!.userId), versionId, '84.29')
  await assign(g1, 'fin', teachers[1]!.userId)
  await assign(g2, 'mid', teachers[4]!.userId)
  await pool.query(`update grading_scheme_versions set status = 'locked', locked_at = now() where id = $1`, [versionId])
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

async function openGrading(page: Page) {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '評分', exact: true })).toBeVisible()
}

async function openDetail(page: Page, code = 'G01') {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/grading/${groupIds.get(code)}`)
  await expect(page.getByRole('heading', { name: `${code} 計算明細` })).toBeVisible()
}

const bookRow = (page: Page, code: string) => page.getByTestId(`gradebook-row-${code}`)

async function submitScore(page: Page, teacher: TestSession, stageKey: string, stageName: string, value: string) {
  await signIn(page, teacher)
  await page.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}?stage=${stageKey}`)
  const bench = page.getByRole('region', { name: `G01「${stageName}」評分表` })
  await bench.getByLabel('1. 總分').fill(value)
  await bench.getByRole('button', { name: '正式送出' }).click()
  await page.getByRole('dialog', { name: '確認正式送出' }).getByRole('button', { name: '確認送出' }).click()
  const receipt = page.getByRole('dialog', { name: '已收件' })
  await expect(receipt).toContainText('已鎖定')
  await receipt.getByRole('button', { name: '知道了' }).click()
}

test('成績表：期中 82.15 已完成、期末未達份數標尚未完成；期末送出 90 後最終 85.29，計算明細列出算式', async ({ page }) => {
  await openGrading(page)
  const g1 = bookRow(page, 'G01')
  await expect(g1.getByTestId('stage-mid')).toContainText('82.15')
  await expect(g1.getByTestId('stage-mid')).toContainText('已完成')
  await expect(g1.getByTestId('stage-fin')).toContainText('尚未完成（0／1）')
  await expect(g1.getByTestId('final')).toHaveText('尚未完成')

  await submitScore(page, teachers[1]!, 'fin', '期末', '90')

  await openGrading(page)
  await expect(bookRow(page, 'G01').getByTestId('final')).toHaveText('85.29')
  await openDetail(page)
  await expect(page.getByTestId('adopted-final')).toHaveText('85.29')
  await expect(page.getByTestId('final-formula')).toHaveText('82.145 × 60% ＋ 90 × 40% ＝ 85.287 → 85.29')
  await expect(page.getByTestId('detail-stage-mid').getByTestId('stage-formula')).toHaveText('(80 ＋ 84.29) ÷ 2 ＝ 82.145 → 82.15')
})

test('退回：系辦填理由退回評二的期末 → 老師收到通知、看到理由與預填 → 改 92 重送 → 最終 86.09', async ({ page }) => {
  await openDetail(page)
  await page.getByRole('button', { name: `退回 ${NAMES[1]} 老師的「期末」評分` }).click()
  const dialog = page.getByRole('dialog', { name: '退回評分' })
  await dialog.getByLabel('退回理由（老師看得到）').fill('請補上展示影片的評語')
  await dialog.getByRole('button', { name: '確認退回' }).click()
  await expect(page.getByRole('status').filter({ hasText: `已退回 ${NAMES[1]} 老師的 G01「期末」評分` })).toBeVisible()
  await expect(page.getByTestId('adopted-final')).toHaveText('尚未完成')

  // 老師的通知匣（背景工作投影）：附理由、沒有分數。
  await signIn(page, teachers[1]!)
  await expect(async () => {
    await page.goto('/dashboard/teacher/inbox')
    await expect(page.getByText('G01「期末」的評分被系辦退回：請補上展示影片的評語')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })

  await page.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}?stage=fin`)
  await expect(page.getByTestId('returned-notice')).toContainText('請補上展示影片的評語')
  const bench = page.getByRole('region', { name: 'G01「期末」評分表' })
  await expect(bench.getByLabel('1. 總分')).toHaveValue('90')
  await submitScore(page, teachers[1]!, 'fin', '期末', '92')

  await openDetail(page)
  await expect(page.getByTestId('adopted-final')).toHaveText('86.09')
  await expect(page.getByTestId('evaluation-history').filter({ hasText: '已退回' })).toContainText('請補上展示影片的評語')
})

test('更正：最終 86.09 更正為 88（保留原值、理由；老師輸入不變）', async ({ page }) => {
  await openDetail(page)
  await page.getByRole('button', { name: '更正最終成績' }).click()
  const dialog = page.getByRole('dialog', { name: '更正最終成績' })
  await dialog.getByLabel('更正後的最終成績（0–100，最多兩位小數）').fill('88')
  await dialog.getByLabel('更正理由').fill('口試補考')
  await dialog.getByRole('button', { name: '確認更正' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'G01 的最終成績已更正為 88.00（原 86.09' })).toBeVisible()
  await expect(page.getByTestId('adopted-final')).toHaveText('88.00')
  await expect(page.getByText('已更正：原 86.09 → 88.00（口試補考')).toBeVisible()

  await openGrading(page)
  await expect(bookRow(page, 'G01').getByTestId('final')).toContainText('88.00')
  await expect(bookRow(page, 'G01').getByTestId('final')).toContainText('已更正（原 86.09）')
  const row = await pool.query(`select original_value::text as o, new_value::text as n from grade_overrides where group_id = $1`, [groupIds.get('G01')])
  expect(row.rows).toEqual([{ o: '86.0870', n: '88.0000' }])
})

test('改派三選一：評一（期中）→ 預覽三種；預覽過期要重做；選替換換評四 → 1／2 尚未完成、更正進待復核、評一不能再評', async ({ page }) => {
  await openGrading(page)
  await page.getByRole('link', { name: `移除或改派 ${NAMES[0]} 老師` }).click()
  await expect(page.getByRole('heading', { name: '移除或改派評分老師' })).toBeVisible()
  await expect(page.getByTestId('reassign-before')).toContainText('2／2')
  await expect(page.getByTestId('choice-keep')).toContainText('份數 2／2・平均 82.15・已完成')
  await expect(page.getByTestId('choice-replace')).toContainText('份數 1／2・平均 84.29・尚未完成（1／2）')
  await expect(page.getByTestId('choice-add')).toContainText('份數 2／3・平均 82.15・尚未完成（2／3）')

  // 預覽之後有人改了份數：舊預覽過期，執行被拒，要重新預覽。
  const g1 = groupIds.get('G01')
  await pool.query(`update stage_requirements set required_count = 3, revision = revision + 1 where group_id = $1 and stage_key = 'mid'`, [g1])
  const fill = async () => {
    await page.getByTestId('choice-replace').getByRole('radio').check()
    await page.getByLabel('接手的評分老師（不選＝只移除，之後再指派）').selectOption({ label: NAMES[3]! })
    await page.getByLabel('理由（必填，留在指派紀錄裡）').fill('評一老師請長假')
    await page.getByRole('button', { name: '確認執行' }).click()
  }
  await fill()
  await expect(page.getByRole('alert').filter({ hasText: '預覽之後這一組的評分有變動' })).toBeVisible()
  await expect(page.getByRole('button', { name: '重新預覽' })).toBeVisible()
  await pool.query(`update stage_requirements set required_count = 2, revision = revision + 1 where group_id = $1 and stage_key = 'mid'`, [g1])
  await page.reload()
  await fill()
  await expect(
    page.getByRole('status').filter({ hasText: `G01「期中」${NAMES[0]} 老師 → ${NAMES[3]} 老師（替換評分老師、重新評分；要求份數 2）` }),
  ).toBeVisible()

  await openGrading(page)
  await expect(bookRow(page, 'G01').getByTestId('stage-mid')).toContainText('尚未完成（1／2）')
  // 下面「評分要求與指派」的份數和成績表同一份。
  await expect(page.getByTestId('grading-row-G01')).toContainText('已正式送出 1／2 份')
  await expect(bookRow(page, 'G01').getByTestId('final')).toContainText('尚未完成')
  await expect(bookRow(page, 'G01').getByTestId('final')).toContainText('更正待復核')
  await expect(page.getByRole('region', { name: '待復核' })).toContainText('G01')

  await signIn(page, teachers[0]!)
  await page.goto(`/dashboard/teacher/grading/${g1}`)
  await expect(page.getByRole('heading', { name: '你沒有被指派評這一組' })).toBeVisible()
})

test('評四送出期中 85 → 系辦復核「沿用原更正值」→ 採用 88.00、待復核清單清空', async ({ page }) => {
  await submitScore(page, teachers[3]!, 'mid', '期中', '85')
  await openDetail(page)
  await expect(page.getByTestId('adopted-final')).toHaveText('87.59')
  const form = page.getByRole('form', { name: '復核更正' })
  await form.getByLabel('復核說明').fill('口試結果不變')
  await form.getByRole('button', { name: '確認復核' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已處理待復核：G01 的最終成績已更正為 88.00（原 87.59' })).toBeVisible()
  await expect(page.getByTestId('adopted-final')).toHaveText('88.00')
  await openGrading(page)
  await expect(page.getByRole('region', { name: '待復核' })).toHaveCount(0)
})

test('方案 v2（期中／期末 50／50）：先看影響、取消不重算；確認套用後照新權重重算並鎖定', async ({ page }) => {
  await openGrading(page)
  await page.getByRole('button', { name: '建立新方案版本' }).click()
  const dialog = page.getByRole('dialog', { name: '建立評分方案版本' })
  await dialog.getByLabel('占總成績 %').nth(0).fill('50')
  await dialog.getByLabel('占總成績 %').nth(1).fill('50')
  await dialog.getByRole('button', { name: '建立草稿' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已建立方案 v2（草稿）' })).toBeVisible()

  await page.getByRole('link', { name: '看影響並套用 v2' }).click()
  await expect(page.getByRole('heading', { name: '套用新評分方案' })).toBeVisible()
  // 期中 (84.29＋85)／2＝84.645；期末 92。60／40 → 87.587（87.59）；50／50 → 88.3225（88.32）。
  await expect(page.getByTestId('apply-row-G01')).toContainText('87.59 → 88.32')
  await expect(page.getByTestId('apply-row-G01')).toContainText('更正會進待復核')
  await page.getByRole('link', { name: '取消（不重算）' }).click()
  await expect(page.getByTestId('scheme-status')).toHaveText('v1・已鎖定')

  await page.getByRole('link', { name: '看影響並套用 v2' }).click()
  await page.getByRole('button', { name: '確認套用 v2' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已套用方案 v2' })).toBeVisible()
  await openGrading(page)
  await expect(page.getByTestId('scheme-status')).toHaveText('v2・已鎖定')
  await expect(bookRow(page, 'G01').getByTestId('final')).toContainText('88.32')
  await expect(bookRow(page, 'G01').getByTestId('final')).toContainText('更正待復核')
})

test('老師被停用：G02 期中列「老師已停用，缺評待處理」，分母不縮小', async ({ page }) => {
  await pool.query(`update users set status = 'disabled' where id = $1`, [teachers[4]!.userId])
  await openGrading(page)
  const g2 = bookRow(page, 'G02')
  await expect(g2).toContainText(`期中：${NAMES[4]}（老師已停用，缺評待處理）`)
  await expect(g2.getByTestId('stage-mid')).toContainText('尚未完成（0／1）')
})

test('匯出 CSV／XLSX：每位組員一列、學號保留前導零、數字與畫面一致；篩選「尚未完成」只匯出 G02；非管理員被拒', async ({ page, request }) => {
  await openGrading(page)
  const [csvDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '匯出 CSV' }).click()])
  expect(csvDownload.suggestedFilename()).toMatch(new RegExp(`^成績-${CODE}-\\d{8}-\\d{4}\\.csv$`))
  const csv = fs.readFileSync((await csvDownload.path())!, 'utf8')
  const lines = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n')
  expect(lines).toHaveLength(5)
  expect(lines[0]).toContain('"學號","姓名","期中 份數","期中 平均"')
  expect(lines[1]).toContain(`"G01","${studentNos[0]}"`)
  expect(studentNos[0]!.startsWith('0')).toBe(true)
  expect(lines[1]).toContain('"2／2","84.65","已完成","1／1","92.00","已完成","88.32","88.3225","88.32","更正待復核')
  expect(lines[3]).toContain('期中：')
  expect(lines[3]).toContain('（老師已停用，缺評待處理）')

  const [xlsxDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '匯出 Excel（XLSX）' }).click()])
  const sheet = strFromU8(unzipSync(new Uint8Array(fs.readFileSync((await xlsxDownload.path())!)))['xl/worksheets/sheet1.xml']!)
  expect(sheet).toContain(`<c r="C2" t="inlineStr"><is><t xml:space="preserve">${studentNos[0]}</t></is></c>`)
  expect(sheet).toContain('>88.32<')

  await page.getByLabel('完成狀態').selectOption({ label: '尚未完成' })
  await page.getByRole('button', { name: '套用篩選' }).click()
  await expect(page.getByTestId('gradebook-count')).toHaveText('顯示 1／2 組')
  const [filtered] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '匯出 CSV' }).click()])
  const filteredText = fs.readFileSync((await filtered.path())!, 'utf8')
  expect(filteredText).toContain('"G02"')
  expect(filteredText).not.toContain('"G01"')

  // 老師、學生直接打匯出：403，回應沒有任何分數。
  for (const who of [teachers[2]!, student]) {
    const response = await request.post('/api/admin/grading/export', {
      headers: { cookie: who.cookie, origin: BASE_URL, 'content-type': 'application/json' },
      data: { cohortId, format: 'csv', filter: {} },
    })
    expect(response.status()).toBe(403)
    expect(await response.text()).not.toContain('88.32')
  }
})
