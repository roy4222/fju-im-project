import { expect, request as playwrightRequest, test, type Browser, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 19（#230）：指導老師指派、認領與重派。「做完的樣子」逐條走：
 *
 * 1. 老師在「產學組認領」按「指定為我的組別」；兩位老師同時搶只有一位成功，另一位看到明確的衝突訊息。
 * 2. 管理員逐組指派或解除主指導；重派時對話框先列原老師在本組的評分指派（現在是空清單）並填理由。
 * 3. 管理員上傳 `group_code,teacher_login_email` CSV 批次指派，預覽分六類，錯誤修好才能逐列執行。
 * 4. 首次指派或認領通知該組全員與老師；重派另通知原老師（看事件的收件人）。
 * 資料庫約束、鎖、預覽後被改的那一列 CONFLICT、重送不重複由整合測試 pg-advisors.integration.test.ts 證明。
 *
 * 組別直接用 owner 連線建好（成組流程是票 13 的事）；票 19 的動作全程用真的畫面與按鈕，重新整理後再看。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T19-${stamp}`

let pool: Pool
let cohortId: string
let adminId: string
let teacherA: TestSession
let teacherB: TestSession
let viewer: TestSession
const NAME_A = `甲老師${stamp.slice(-3)}`
const NAME_B = `乙老師${stamp.slice(-3)}`
/** 組別代碼 → id。G01、G04 是產學組（認領用），G02 一般組（逐組指派）、G05～G07 批次用。 */
const groupIds = new Map<string, string>()
const memberIds = new Map<string, string[]>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

let studentSeq = 0
async function insertStudent(userId: string | null): Promise<string> {
  studentSeq += 1
  const studentNo = `419${String(Date.now()).slice(-5)}${studentSeq}`
  const name = `組員${studentSeq}號`
  let id = userId
  if (!id) {
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [name, `t19-${stamp.toLowerCase()}-${studentSeq}@example.com`],
    )
    id = user.rows[0]!.id
    await pool.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, adminId],
    )
  }
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [id, name, studentNo, cohortId, `t19-${studentSeq}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return id
}

async function insertGroup(code: string, type: 'general' | 'industry', firstMember: string | null = null) {
  const members = [await insertStudent(firstMember), await insertStudent(null)]
  const at = new Date(Date.now() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                         created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, 'active', $5, $5, $5, 'user', $4, $5, $4) returning id`,
    [cohortId, code, type, members[0], at],
  )
  const id = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
     select gen_random_uuid(), $1, $2, u, $4, 'user', $3, $4, $4 from unnest($5::uuid[]) as u`,
    [id, cohortId, members[0], at, members],
  )
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at)
     values (gen_random_uuid(), $1, $2, $3, $2, $3)`,
    [id, members[0], at],
  )
  groupIds.set(code, id)
  memberIds.set(code, members)
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()

  // 每個帳號各用一個乾淨的 context 註冊：同一個 context 第二次註冊會帶著上一個的 cookie，被要求 Origin。
  const fresh = async (role: 'teacher' | 'student') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  teacherA = await fresh('teacher')
  teacherB = await fresh('teacher')
  viewer = await fresh('student')
  await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [teacherA.userId, NAME_A])
  await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [teacherB.userId, NAME_B])

  const now = new Date()
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 'system') returning id`,
    [CODE, `${CODE} 指導老師測試`, ymd(new Date(now.getTime() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id

  await insertGroup('G01', 'industry')
  await insertGroup('G02', 'general', viewer.userId)
  await insertGroup('G04', 'industry')
  await insertGroup('G05', 'general')
  await insertGroup('G06', 'general')
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function openTeacherPage(page: Page, session: TestSession) {
  await signIn(page, session)
  await page.goto(`/dashboard/teacher/groups?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '分組', exact: true })).toBeVisible()
}

async function openAdminPage(page: Page) {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '分組總覽', exact: true })).toBeVisible()
}

async function activeAdvisor(code: string): Promise<string[]> {
  const rows = await pool.query<{ teacher_user_id: string }>(
    `select teacher_user_id from advisor_assignments where group_id = $1 and valid_to is null`,
    [groupIds.get(code)],
  )
  return rows.rows.map((r) => r.teacher_user_id)
}

async function recipientsOf(type: string, code: string): Promise<string[][]> {
  const rows = await pool.query<{ recipients: string[] }>(
    `select recipients from domain_events where type = $1 and source_id = $2 order by occurred_real_at, id`,
    [type, groupIds.get(code)],
  )
  return rows.rows.map((r) => [...r.recipients].sort())
}

const sorted = (...list: string[]) => [...list].sort()

test('老師認領產學組：按「指定為我的組別」後看到回執；重新整理後變「你指導中」；全組與老師收到通知', async ({ page }) => {
  await openTeacherPage(page, teacherA)
  const claim = page.getByRole('region', { name: '產學組認領' })
  await expect(claim.getByRole('row').filter({ hasText: 'G01' })).toContainText('可認領')
  // 一般組不在認領表裡，也沒有認領按鈕。
  await expect(claim).not.toContainText('G02')
  await claim.getByRole('button', { name: '認領 G01' }).click()
  const dialog = page.getByRole('dialog', { name: '認領 G01' })
  await expect(dialog).toContainText('先按先得')
  await dialog.getByRole('button', { name: '指定為我的組別' }).click()
  await expect(dialog.getByRole('status')).toContainText('G01 已指定為你的組別')

  await page.reload()
  await expect(page.getByRole('region', { name: '產學組認領' }).getByRole('row').filter({ hasText: 'G01' })).toContainText('你指導中')
  await expect(page.getByRole('region', { name: '全部組別' }).getByRole('row').filter({ hasText: 'G01' })).toContainText(`${NAME_A}（你）`)
  expect(await activeAdvisor('G01')).toEqual([teacherA.userId])
  expect(await recipientsOf('advisor.assigned', 'G01')).toEqual([sorted(...memberIds.get('G01')!, teacherA.userId)])

  await page.goto('/dashboard/teacher')
  await expect(page.getByTestId('home-advised')).toContainText('我的 1 組')
})

async function claimPage(browser: Browser, session: TestSession) {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  await openTeacherPage(page, session)
  await page.getByRole('region', { name: '產學組認領' }).getByRole('button', { name: '認領 G04' }).click()
  const dialog = page.getByRole('dialog', { name: '認領 G04' })
  await expect(dialog.getByRole('button', { name: '指定為我的組別' })).toBeEnabled()
  return { context, dialog }
}

test('兩位老師同時認領同一組：只有一位成功，另一位看到「已被其他老師認領」與是誰', async ({ browser }) => {
  const a = await claimPage(browser, teacherA)
  const b = await claimPage(browser, teacherB)
  try {
    await Promise.all([
      a.dialog.getByRole('button', { name: '指定為我的組別' }).click(),
      b.dialog.getByRole('button', { name: '指定為我的組別' }).click(),
    ])
    const won = async (dialog: typeof a.dialog) => {
      await expect(dialog.getByRole('status').or(dialog.getByRole('alert'))).toBeVisible()
      return (await dialog.getByRole('status').count()) > 0
    }
    const aWon = await won(a.dialog)
    const bWon = await won(b.dialog)
    expect([aWon, bWon].filter(Boolean)).toHaveLength(1)
    const loser = aWon ? b.dialog : a.dialog
    await expect(loser).toContainText('已被其他老師認領')
    await expect(loser.getByRole('alert')).toContainText(`剛由 ${aWon ? NAME_A : NAME_B} 老師認領成功`)
    expect(await activeAdvisor('G04')).toEqual([aWon ? teacherA.userId : teacherB.userId])
  } finally {
    await a.context.close()
    await b.context.close()
  }
})

test('管理員逐組指派 → 重派（先列原老師的評分指派，清單是空的）→ 解除；理由必填；原老師另收通知', async ({ page }) => {
  await openAdminPage(page)
  const table = page.getByRole('region', { name: '全部組別' })
  const row = () => table.getByRole('row').filter({ hasText: 'G02' })
  await expect(row()).toContainText('尚未指派')

  await row().getByRole('button', { name: '指派指導老師：G02' }).click()
  let dialog = page.getByRole('dialog', { name: '指派 G02 的指導老師' })
  await dialog.getByLabel('指導老師').selectOption({ label: `${NAME_A}（${teacherA.email}）` })
  await dialog.getByRole('button', { name: '確認指派' }).click()
  await expect(dialog.getByRole('alert')).toContainText('一定要填理由')
  await dialog.getByLabel('理由（必填）').fill('115 抽籤結果')
  await dialog.getByRole('button', { name: '確認指派' }).click()
  await expect(row().getByRole('status')).toContainText(`已指派 ${NAME_A} 老師指導 G02`)
  await expect(row()).toContainText(NAME_A)
  expect(await recipientsOf('advisor.assigned', 'G02')).toEqual([sorted(...memberIds.get('G02')!, teacherA.userId)])

  await page.reload()
  await row().getByRole('button', { name: '重派指導老師：G02' }).click()
  dialog = page.getByRole('dialog', { name: '重派 G02 的指導老師' })
  await expect(dialog).toContainText(`目前：${NAME_A}`)
  const grading = dialog.getByRole('region', { name: '原老師在本組的評分指派' })
  await expect(grading.getByTestId('grading-assignments-empty')).toContainText('目前沒有評分指派')
  await expect(grading.getByRole('checkbox')).toHaveCount(0)
  // 原老師不在選項裡。
  await expect(dialog.getByLabel('指導老師').locator('option', { hasText: teacherA.email })).toHaveCount(0)
  await dialog.getByLabel('指導老師').selectOption({ label: `${NAME_B}（${teacherB.email}）` })
  await dialog.getByLabel('理由（必填）').fill(`${NAME_A}休假`)
  await dialog.getByRole('button', { name: '確認重派' }).click()
  await expect(row().getByRole('status')).toContainText(`G02 的指導老師已從 ${NAME_A} 換成 ${NAME_B}`)
  expect(await activeAdvisor('G02')).toEqual([teacherB.userId])
  expect((await recipientsOf('advisor.assigned', 'G02')).at(-1)).toEqual(sorted(...memberIds.get('G02')!, teacherB.userId))
  expect(await recipientsOf('advisor.replaced', 'G02')).toEqual([[teacherA.userId]])

  await page.reload()
  const detail = page.getByRole('dialog', { name: 'G02 詳情' })
  await row().getByRole('button', { name: 'G02 詳情' }).click()
  const history = detail.getByRole('region', { name: '異動歷程' })
  await expect(history).toContainText(`指導老師 ${NAME_A} → ${NAME_B}`)
  await expect(history).toContainText(`理由：${NAME_A}休假`)
  await detail.getByRole('button', { name: '關閉' }).click()

  await row().getByRole('button', { name: '解除指導老師：G02' }).click()
  dialog = page.getByRole('dialog', { name: '解除 G02 的指導老師？' })
  await dialog.getByLabel('理由（必填）').fill('抽籤更正')
  await dialog.getByRole('button', { name: '確定解除' }).click()
  await expect(row().getByRole('status')).toContainText(`已解除 ${NAME_B} 老師對 G02 的指導`)
  await expect(row()).toContainText('尚未指派')
  expect(await recipientsOf('advisor.unassigned', 'G02')).toEqual([sorted(...memberIds.get('G02')!, teacherB.userId)])
})

test('學生的「我的組別」看得到指導老師與指派歷程（看不到理由）', async ({ page }) => {
  // 上一案最後解除了；再用畫面指派一次，學生才有老師可看。
  await openAdminPage(page)
  const row = page.getByRole('region', { name: '全部組別' }).getByRole('row').filter({ hasText: 'G02' })
  await row.getByRole('button', { name: '指派指導老師：G02' }).click()
  const dialog = page.getByRole('dialog', { name: '指派 G02 的指導老師' })
  await dialog.getByLabel('指導老師').selectOption({ label: `${NAME_A}（${teacherA.email}）` })
  await dialog.getByLabel('理由（必填）').fill('重新抽籤')
  await dialog.getByRole('button', { name: '確認指派' }).click()
  await expect(row.getByRole('status')).toContainText(`已指派 ${NAME_A} 老師指導 G02`)

  await signIn(page, viewer)
  await page.goto('/dashboard/student/groups')
  await expect(page.getByTestId('my-advisor')).toContainText(NAME_A)
  const history = page.getByRole('list', { name: '組別異動' })
  await expect(history).toContainText(`指導老師 ${NAME_A} → ${NAME_B}`)
  await expect(history).toContainText(`解除指導老師 ${NAME_B}`)
  await expect(page.getByRole('region', { name: '我的組別狀態' })).not.toContainText('抽籤更正')
})

async function uploadBatch(page: Page, name: string, csv: string) {
  await page.getByRole('button', { name: '批次指派（CSV）' }).click()
  const dialog = page.getByRole('dialog', { name: '批次指派指導老師' })
  await dialog.getByLabel('選擇批次指派 CSV 檔').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') })
  await expect(dialog.getByRole('heading', { name: `預覽・${name}` })).toBeVisible()
  return dialog
}

test('批次指派 CSV：六類預覽、有錯不能執行；修正後填理由、確認重派，逐列執行；重新整理後表格更新', async ({ page }) => {
  await openAdminPage(page)
  const messy = [
    'group_code,teacher_login_email',
    `G05,${teacherA.email}`, // 可新增
    `G02,${teacherA.email}`, // 已是同一位（上一案指派的）
    `G01,${teacherB.email}`, // 已有不同老師 → 重派
    `G99,${teacherA.email}`, // 組別不存在
    `G06,nobody-${stamp.toLowerCase()}@example.com`, // 老師不存在
    `G05,${teacherB.email}`, // 與第一列同組 → 重複
  ].join('\n')
  let dialog = await uploadBatch(page, 'advisors-messy.csv', messy)
  await expect(dialog.getByTestId('advisor-batch-count-new')).toHaveText('0')
  await expect(dialog.getByTestId('advisor-batch-count-unchanged')).toHaveText('1')
  await expect(dialog.getByTestId('advisor-batch-count-reassign')).toHaveText('1')
  await expect(dialog.getByTestId('advisor-batch-count-group_missing')).toHaveText('1')
  await expect(dialog.getByTestId('advisor-batch-count-teacher_missing')).toHaveText('1')
  await expect(dialog.getByTestId('advisor-batch-count-duplicate')).toHaveText('2')
  await expect(dialog.getByTestId('advisor-batch-row-2')).toContainText('重複')
  await expect(dialog.getByTestId('advisor-batch-row-5')).toContainText('組別不存在')
  await dialog.getByLabel('理由（必填，整批共用）').fill('115 抽籤結果')
  await expect(dialog.getByRole('button', { name: /確認執行/ })).toBeDisabled()
  await dialog.getByRole('button', { name: '關閉' }).click()

  const fixed = ['group_code,teacher_login_email', `G05,${teacherA.email}`, `G02,${teacherA.email}`, `G01,${teacherB.email}`, `G06,${teacherB.email}`].join(
    '\n',
  )
  dialog = await uploadBatch(page, 'advisors-fixed.csv', fixed)
  await expect(dialog.getByTestId('advisor-batch-count-new')).toHaveText('2')
  await expect(dialog.getByTestId('advisor-batch-count-reassign')).toHaveText('1')
  await dialog.getByLabel('理由（必填，整批共用）').fill('115 抽籤結果')
  const execute = dialog.getByRole('button', { name: '確認執行（3 組）' })
  await expect(execute).toBeDisabled()
  await dialog.getByRole('checkbox', { name: /確認重派 1 組/ }).check()
  await execute.click()
  await expect(dialog.getByRole('status')).toContainText('批次指派完成：新增 2 組、重派 1 組')
  await expect(dialog.getByTestId('advisor-batch-result-4')).toContainText('已重派')
  await expect(dialog.getByTestId('advisor-batch-result-3')).toContainText('不需變更')

  expect(await activeAdvisor('G05')).toEqual([teacherA.userId])
  expect(await activeAdvisor('G06')).toEqual([teacherB.userId])
  expect(await activeAdvisor('G01')).toEqual([teacherB.userId])
  expect(await recipientsOf('advisor.replaced', 'G01')).toEqual([[teacherA.userId]])
  // 不需變更的 G02 沒有多一則通知。
  expect(await recipientsOf('advisor.assigned', 'G02')).toHaveLength(3)

  await page.reload()
  const table = page.getByRole('region', { name: '全部組別' })
  await expect(table.getByRole('row').filter({ hasText: 'G06' })).toContainText(NAME_B)
  await expect(page.getByTestId('advisor-summary')).toContainText('0 組尚未指派')
})
