import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { fillItemForm, formReady, openAdvanced } from './create-item'
import { fillItemBody } from './item-body'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * C 階段規格① §6（C1-11）：站內同意書做進作業的畫面。全程用真的畫面與按鈕，資料庫核對用 owner 連線。
 *
 * - AC-21：系辦「新增 › 同意書（站內表單）」發布 → 繳交狀況每組一列：有主指導的「收集中 0／N」、沒有的「尚未建立：沒有指導老師」＋「建立」。
 * - AC-22／AC-22a：學生「交作業」開該列 → 「說明｜狀態」→ 狀態 → 全組狀態表 → 同意；頁面沒有版本號、檢查碼、核對碼、登入方式；
 *   另一位不同意、主指導退回，理由都留空也成功（`approvals.reason` null），理由欄標「選填」。
 * - AC-21c：系辦開舊網址 `/dashboard/admin/signoff/<版本>` → 307 到該作業的繳交狀況；學生 403；沒登入到登入頁。
 * - AC-23：系辦改正文「儲存更新」→ 每組建新版；學生狀態分頁頂部黃框「同意書內容已更新（m/d）」、表格歸零、可以再同意。
 * - AC-25／AC-25a：替「尚未建立」的組指派主指導後按「建立」；「作廢」「重新收集」「重開」理由留空都成功。
 *
 * 組別、成員、主指導直接用 owner 連線建好（分組的事）；建包、改版、補建的規則由 C1-03 整合測試逐條證明。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `C111-${stamp}`
const TITLE = `${CODE} 期中結果確認書`
const BODY = `本組確認期中結果無誤（${stamp}）。`
const BODY_V2 = `本組確認期中結果無誤，第三章數據已更新（${stamp}）。`

let pool: Pool
let cohortId: string
let adminId: string
let teacher: TestSession
let itemId = ''
const g1: TestSession[] = []
const g2: TestSession[] = []
const g3: TestSession[] = []
const groupIds = new Map<string, string>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function localMinute(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16)
}

/** 今天（臺灣時間）的「m/d」。 */
function todayMd(): string {
  const [, m, d] = ymd(new Date()).split('-')
  return `${Number(m)}/${Number(d)}`
}

let seq = 0
async function makeStudent(session: TestSession, name: string) {
  seq += 1
  const studentNo = `411${String(Date.now()).slice(-5)}${seq}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no, cohort_id = excluded.cohort_id`,
    [session.userId, name, studentNo, cohortId, `c111-${seq}-${stamp}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, session.userId])
}

async function makeGroup(code: string, members: TestSession[], advisor: TestSession | null) {
  const at = new Date(Date.now() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', 'active', $3, $3, 'system') returning id`,
    [cohortId, code, at],
  )
  const groupId = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
     select gen_random_uuid(), $1, $2, u, $3, 'system' from unnest($4::uuid[]) as u`,
    [groupId, cohortId, at, members.map((m) => m.userId)],
  )
  await pool.query(`insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, $3, $2)`, [
    groupId,
    members[0]!.userId,
    at,
  ])
  if (advisor) await assignAdvisor(groupId, advisor, at)
  groupIds.set(code, groupId)
}

async function assignAdvisor(groupId: string, advisor: TestSession, at: Date) {
  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', $3, $4, '抽籤結果')`,
    [groupId, advisor.userId, at, adminId],
  )
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
  teacher = await fresh('teacher')
  await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [teacher.userId, `丙老師${stamp.slice(-3)}`])
  for (let i = 0; i < 3; i += 1) g1.push(await fresh('student'))
  for (let i = 0; i < 2; i += 1) g2.push(await fresh('student'))
  for (let i = 0; i < 2; i += 1) g3.push(await fresh('student'))
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, group_size_min, group_size_max, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 2, 5, 'system') returning id`,
    [CODE, `${CODE} 同意書作業測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id
  for (const [i, s] of g1.entries()) await makeStudent(s, `一組${'甲乙丙'[i]}${stamp.slice(-3)}`)
  for (const [i, s] of g2.entries()) await makeStudent(s, `二組${'甲乙'[i]}${stamp.slice(-3)}`)
  for (const [i, s] of g3.entries()) await makeStudent(s, `三組${'甲乙'[i]}${stamp.slice(-3)}`)
  await makeGroup('G01', g1, teacher)
  await makeGroup('G02', g2, teacher)
  await makeGroup('G03', g3, null)
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

async function currentVersion(code: string): Promise<{ id: string; versionNo: number; state: string; supersedeCause: string | null }> {
  const row = await pool.query(
    `select v.id, v.version_no, s.state, v.supersede_cause from signoff_packages p
       join signoff_package_versions v on v.id = p.current_version_id
       join signoff_version_status s on s.version_id = v.id
      where p.item_id = $1 and p.group_id = $2`,
    [itemId, groupIds.get(code)],
  )
  const r = row.rows[0]
  return { id: r.id, versionNo: r.version_no, state: r.state, supersedeCause: r.supersede_cause }
}

function boardRow(page: Page, code: string) {
  return page.getByTestId('consent-board-row').filter({ has: page.getByRole('heading', { name: code, exact: true }) })
}

/** 學生從「交作業」開這份同意書的「狀態」分頁。 */
async function openStatus(page: Page, session: TestSession) {
  await signIn(page, session)
  await page.goto('/dashboard/student/affairs')
  const row = page.getByTestId(`affair-${itemId}`)
  await expect(row.getByTestId('affair-form')).toContainText('同意書')
  await row.getByRole('link').first().click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/student/affairs/${itemId}`))
  const tabs = page.getByRole('navigation', { name: '同意書分頁' })
  await expect(tabs.getByRole('link')).toHaveText(['說明', '狀態'])
  await tabs.getByRole('link', { name: '狀態', exact: true }).click()
  await expect(page.getByTestId('group-status')).toBeVisible()
}

async function agree(page: Page) {
  const form = page.getByTestId('respond-form')
  await form.getByRole('checkbox').check()
  await form.getByRole('button', { name: '我已閱讀並同意' }).click()
  await page.getByRole('dialog', { name: '確認同意' }).getByRole('button', { name: '我已閱讀並同意' }).click()
  await expect(page.getByTestId('respond-form')).toHaveCount(0)
}

test('AC-21：系辦「新增 › 同意書（站內表單）」發布；繳交狀況每組一列，有主指導「收集中 0／N」、沒有的「尚未建立：沒有指導老師」＋「建立」', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs/assignments?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增作業' }).click()
  await page.getByRole('menu', { name: '新增哪一種' }).getByRole('menuitem', { name: /同意書（站內表單）/ }).click()
  const dialog = page.getByRole('dialog', { name: '新增同意書（站內表單）' })
  const form = await formReady(dialog)
  await fillItemForm(page, form, { title: TITLE, audience: 'cohort_students', dueAt: localMinute(new Date(Date.now() + 10 * 86_400_000)) })
  await fillItemBody(page, BODY)
  await openAdvanced(form)
  await form.getByLabel('同意書用途').selectOption('result_confirmation')
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog).toBeHidden()

  const item = await pool.query(`select id, consent_mode, consent_purpose from managed_items where cohort_id = $1 and title = $2`, [cohortId, TITLE])
  expect(item.rows).toHaveLength(1)
  expect(item.rows[0]).toMatchObject({ consent_mode: 'form', consent_purpose: 'result_confirmation' })
  itemId = item.rows[0].id
  const packages = await pool.query(`select purpose from signoff_packages where item_id = $1`, [itemId])
  expect(packages.rows).toEqual([{ purpose: 'result_confirmation' }, { purpose: 'result_confirmation' }])

  await page.goto(`/dashboard/admin/affairs/${itemId}`)
  await expect(page.getByTestId('consent-board-row')).toHaveCount(3)
  await expect(boardRow(page, 'G01').getByTestId('consent-board-state')).toHaveText('收集中 0／3')
  await expect(boardRow(page, 'G02').getByTestId('consent-board-state')).toHaveText('收集中 0／2')
  await expect(boardRow(page, 'G03').getByTestId('consent-board-state')).toHaveText('尚未建立：沒有指導老師')
  await expect(boardRow(page, 'G03').getByRole('button', { name: '建立', exact: true })).toBeVisible()
  await expect(page.getByText('同意書進度在下一票')).toHaveCount(0)
  // 版本號與檢查碼不顯示（匯出 CSV 仍有）。
  await expect(page.getByTestId('consent-board')).not.toContainText('第 1 版')
  await expect(page.getByTestId('consent-board')).not.toContainText('檢查碼')
})

test('AC-22：學生「交作業」→ 說明｜狀態 → 全組狀態表 → 同意；沒有版本號、檢查碼、核對碼、登入方式字樣', async ({ page }) => {
  await openStatus(page, g1[0]!)
  const status = page.getByTestId('group-status')
  await expect(status.getByTestId('group-status-row')).toHaveCount(3)
  await expect(status.getByTestId('group-status-advisor')).toContainText(`丙老師${stamp.slice(-3)}`)
  await expect(status.getByTestId('group-status-row').first()).toContainText('還沒表態')
  await agree(page)
  const mine = status.getByTestId('group-status-row').filter({ hasText: '（你）' })
  await expect(mine.getByTestId('group-status-result')).toHaveText(`已同意 ${todayMd()}`)
  await expect(page.getByTestId('my-response')).toContainText('你已同意')
  const main = page.getByRole('main')
  for (const word of ['第 1 版', '版本', '檢查碼', '核對碼', '登入方式']) await expect(main).not.toContainText(word)

  // 說明分頁：全文。
  await page.getByRole('navigation', { name: '同意書分頁' }).getByRole('link', { name: '說明', exact: true }).click()
  await expect(page.getByTestId('signoff-content')).toContainText(BODY)
})

test('看板「提醒未同意者」：收件人是還沒表態的組員（從舊版本頁搬過來，舊包唯讀）', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs/${itemId}`)
  const row = boardRow(page, 'G01')
  await row.getByRole('button', { name: '提醒未同意者' }).click()
  await expect(row.getByRole('status').filter({ hasText: '已提醒' })).toContainText('已提醒 G01')

  await signIn(page, g1[2]!)
  await expect(async () => {
    await page.goto('/dashboard/student/inbox')
    await expect(page.getByText(/提醒：G01「期中結果確認」第 1 版同意書還有人沒回覆/)).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
  // 已經同意的人不在收件人裡。
  await signIn(page, g1[0]!)
  await page.goto('/dashboard/student/inbox')
  await expect(page.getByText(/提醒：G01「期中結果確認」/)).toHaveCount(0)
})

test('AC-22a：學生不同意、主指導退回，理由都留空也成功；理由欄標「選填」', async ({ page }) => {
  await openStatus(page, g1[1]!)
  const form = page.getByTestId('respond-form')
  await form.getByRole('checkbox').check()
  await form.getByRole('button', { name: '不同意並退回修正' }).click()
  const dialog = page.getByRole('dialog', { name: '不同意並退回修正' })
  await expect(dialog.getByLabel('理由（選填）')).toHaveValue('')
  await dialog.getByRole('button', { name: '確定不同意並退回修正' }).click()
  await expect(page.getByTestId('group-status').getByTestId('group-status-row').filter({ hasText: '（你）' }).getByTestId('group-status-result')).toHaveText('不同意')
  const disagree = await pool.query(
    `select a.reason from approvals a where a.version_id = $1 and a.user_id = $2`,
    [(await currentVersion('G01')).id, g1[1]!.userId],
  )
  expect(disagree.rows).toEqual([{ reason: null }])

  // G02 全員同意 → 輪到老師；老師在「我的作業」看到「等你同意」，開同意書頁的狀態分頁按退回，理由留空。
  for (const s of g2) {
    await openStatus(page, s)
    await agree(page)
  }
  const g2v = await currentVersion('G02')
  expect(g2v.state).toBe('teacher_pending')
  await signIn(page, teacher)
  await page.goto('/dashboard/teacher/affairs')
  const row = page.getByTestId(`consent-${g2v.id}`)
  await expect(row).toContainText('等你同意')
  await row.getByRole('link').first().click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/teacher/signoff/${g2v.id}\\?tab=status$`))
  await expect(page.getByRole('navigation', { name: '同意書分頁' }).getByRole('link', { name: '狀態', exact: true })).toHaveAttribute('aria-current', 'page')
  const advisorForm = page.getByTestId('respond-form')
  await advisorForm.getByRole('checkbox').check()
  await advisorForm.getByRole('button', { name: '不同意並退回修正' }).click()
  const back = page.getByRole('dialog', { name: '不同意並退回修正' })
  await expect(back.getByLabel('理由（選填）')).toHaveValue('')
  await back.getByRole('button', { name: '確定不同意並退回修正' }).click()
  await expect(page.getByTestId('group-status-advisor').getByTestId('group-status-result')).toHaveText('退回')
  expect((await currentVersion('G02')).state).toBe('revision')
  const ret = await pool.query(`select reason from approvals where version_id = $1 and role = 'advisor'`, [g2v.id])
  expect(ret.rows).toEqual([{ reason: null }])

  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs/${itemId}`)
  await expect(boardRow(page, 'G02').getByTestId('consent-board-state')).toHaveText('退回修正中')
})

test('AC-21c：舊網址 /dashboard/admin/signoff/<版本> → 系辦 307 到作業繳交狀況；學生 403；沒登入到登入頁', async ({ page }) => {
  const v = await currentVersion('G01')
  await asAdmin(page)
  const raw = await page.request.get(`/dashboard/admin/signoff/${v.id}`, { maxRedirects: 0 })
  expect(raw.status()).toBe(307)
  expect(raw.headers()['location']).toContain(`/dashboard/admin/affairs/${itemId}`)
  await page.goto(`/dashboard/admin/signoff/${v.id}`)
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/affairs/${itemId}$`))
  await expect(page.getByTestId('consent-board')).toBeVisible()

  await signIn(page, g1[0]!)
  await page.goto(`/dashboard/admin/signoff/${v.id}`)
  await expect(page).toHaveURL(/\/403/)

  await page.context().clearCookies()
  await page.goto(`/dashboard/admin/signoff/${v.id}`)
  await expect(page).toHaveURL(/\/login/)
})

test('AC-25／AC-25a：指派主指導後按「建立」；作廢、重開、重新收集理由留空都成功', async ({ page }) => {
  await assignAdvisor(groupIds.get('G03')!, teacher, new Date())
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs/${itemId}`)
  await expect(boardRow(page, 'G03').getByTestId('consent-board-state')).toHaveText('尚未建立')
  await boardRow(page, 'G03').getByRole('button', { name: '建立', exact: true }).click()
  await expect(boardRow(page, 'G03').getByTestId('consent-board-state')).toHaveText('收集中 0／2')

  // 作廢 G02（退回修正中），理由留空。
  await boardRow(page, 'G02').getByRole('button', { name: '作廢', exact: true }).click()
  const voidDialog = page.getByRole('dialog', { name: '作廢這一版？' })
  await expect(voidDialog.getByLabel('理由（選填）')).toHaveValue('')
  await voidDialog.getByRole('button', { name: '確定作廢' }).click()
  await expect(boardRow(page, 'G02').getByTestId('consent-board-state')).toHaveText('已作廢')
  const voided = await pool.query(`select s.state, s.cause from signoff_version_status s where s.version_id = $1`, [(await currentVersion('G02')).id])
  expect(voided.rows).toEqual([{ state: 'void', cause: 'void' }])

  // 已作廢 → 重開（理由留空）：建新版、收集中。
  await boardRow(page, 'G02').getByRole('button', { name: '重開', exact: true }).click()
  const reopen = page.getByRole('dialog', { name: '重開新版？' })
  await expect(reopen.getByLabel('理由（選填）')).toHaveValue('')
  await reopen.getByRole('button', { name: '確定重開' }).click()
  await expect(boardRow(page, 'G02').getByTestId('consent-board-state')).toHaveText('收集中 0／2')
  expect((await currentVersion('G02')).versionNo).toBe(2)

  // 收集中 → 重新收集（理由留空）：建新版（cause reset）。
  await boardRow(page, 'G03').getByRole('button', { name: '重新收集', exact: true }).click()
  const reset = page.getByRole('dialog', { name: '重新收集同意？' })
  await reset.getByRole('button', { name: '確定重新收集' }).click()
  await expect(boardRow(page, 'G03').getByText(/已重新收集同意/)).toBeVisible()
  expect(await currentVersion('G03')).toMatchObject({ versionNo: 2, state: 'collecting', supersedeCause: 'reset' })
})

test('AC-23：系辦改正文「儲存更新」→ 每組建新版；學生狀態分頁黃框「同意書內容已更新」、全組歸零、可以再同意', async ({ page }) => {
  const before = await currentVersion('G03')
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs/assignments?cohort=${cohortId}`)
  await page.getByRole('button', { name: `編輯：${TITLE}` }).click()
  const dialog = page.getByRole('dialog', { name: `編輯：${TITLE}` })
  const form = await formReady(dialog)
  await fillItemBody(page, BODY_V2)
  await form.getByRole('button', { name: '儲存更新' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await currentVersion('G03')).versionNo).toBe(before.versionNo + 1)
  expect(await currentVersion('G03')).toMatchObject({ state: 'collecting', supersedeCause: 'content_change' })

  await openStatus(page, g3[0]!)
  await expect(page.getByTestId('consent-updated')).toHaveText(`同意書內容已更新（${todayMd()}），之前的同意不算，請重新閱讀並同意。`)
  await expect(page.getByTestId('group-status-count')).toHaveText('0／2 位組員已同意')
  // #161 流程截圖（CI 附件）。
  await test.info().attach('AC-23 同意書內容已更新', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  await agree(page)
  await page.getByRole('navigation', { name: '同意書分頁' }).getByRole('link', { name: '說明', exact: true }).click()
  await expect(page.getByTestId('signoff-content')).toContainText(BODY_V2)
})
