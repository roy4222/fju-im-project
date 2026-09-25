import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 26（#237）：逐人同意、老師同意與簽核管理。「做完的樣子」逐條走，全程用真的畫面與按鈕：
 *
 * 1. 學生逐人閱讀後同意（勾「已完整閱讀」→ 確認框「只代表你自己的一票」），或不同意並填理由；全員同意後才輪到老師，
 *    老師提前時沒有按鈕、只寫還差幾位（伺服器也擋，整合測試證明 `STUDENTS_PENDING`）。
 * 2. 老師同意即完成，或退回（填理由）回到修正中。
 * 3. 管理員看整體進度與缺誰、重置或作廢（理由必填）、重開＝建新版；管理員頁沒有任何替人同意的按鈕。
 * 4. 主指導改變時目前版本自動失效、不自動建新版；舊頁顯示原因等系辦建新版；失效通知只給系辦。
 * 5. 匯出可列印頁與 CSV 明細；提醒未同意者，24 小時內不重複。
 *
 * 組別、成員、主指導直接用 owner 連線建好（票 13、19 的事）。不可代簽的每一條反例、並發、同交易失效由整合測試
 * `pg-signoff-approvals.integration.test.ts` 逐條證明。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T26-${stamp}`
const T1_NAME = `甲老師${stamp.slice(-3)}`
const T2_NAME = `乙老師${stamp.slice(-3)}`
const CONTENT = `本組確認期中結果（${stamp}）。`

let pool: Pool
let cohortId: string
let adminId: string
let t1: TestSession
let t2: TestSession
/** G01 的三位學生、G02 的三位學生。 */
const g1: TestSession[] = []
const g2: TestSession[] = []
const names = new Map<string, string>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

let seq = 0
async function makeStudent(session: TestSession, name: string) {
  seq += 1
  const studentNo = `426${String(Date.now()).slice(-5)}${seq}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no, cohort_id = excluded.cohort_id`,
    [session.userId, name, studentNo, cohortId, `t26-${seq}-${stamp}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, session.userId])
  names.set(session.userId, name)
}

async function makeGroup(code: string, members: TestSession[], teacher: TestSession): Promise<string> {
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
  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', $3, $4, '抽籤結果')`,
    [groupId, teacher.userId, at, adminId],
  )
  return groupId
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
  t1 = await fresh('teacher')
  t2 = await fresh('teacher')
  for (let i = 0; i < 3; i += 1) g1.push(await fresh('student'))
  for (let i = 0; i < 3; i += 1) g2.push(await fresh('student'))
  await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [t1.userId, T1_NAME])
  await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [t2.userId, T2_NAME])

  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, group_size_min, group_size_max, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 3, 5, 'system') returning id`,
    [CODE, `${CODE} 簽核同意測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id
  for (const [i, s] of g1.entries()) await makeStudent(s, `一組${'甲乙丙'[i]}${stamp.slice(-3)}`)
  for (const [i, s] of g2.entries()) await makeStudent(s, `二組${'甲乙丙'[i]}${stamp.slice(-3)}`)
  await makeGroup('G01', g1, t1)
  await makeGroup('G02', g2, t1)
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

async function createVersion(page: Page, groupCode: string) {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增簽核' }).click()
  const form = page.getByRole('dialog', { name: '新增簽核' }).getByRole('form', { name: '建立簽核版本' })
  await form.getByLabel('組別').selectOption({ label: groupCode })
  await form.getByLabel('全文').fill(`${CONTENT}${groupCode}`)
  await form.getByRole('button', { name: '建立簽核版本' }).click()
  await expect(form.getByRole('status')).toContainText(`已建立 ${groupCode}「期中結果確認」`)
  await form.getByRole('link', { name: '看剛建立的版本' }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/signoff\/[0-9a-f-]{36}$/)
  return page.url().split('/').at(-1)!
}

/** 學生在自己的簽核頁同意：勾已閱讀 → 按同意 → 確認框 → 確認。 */
async function studentAgrees(page: Page, session: TestSession) {
  await signIn(page, session)
  await page.goto('/dashboard/student/signoff')
  const form = page.getByTestId('respond-form')
  const agree = form.getByRole('button', { name: '我已閱讀並同意' })
  await expect(agree).toBeDisabled()
  await form.getByRole('checkbox').check()
  await agree.click()
  const dialog = page.getByRole('dialog', { name: '確認同意' })
  await expect(dialog).toContainText('只代表你自己')
  await dialog.getByRole('button', { name: '我已閱讀並同意' }).click()
  await expect(page.getByTestId('my-response')).toContainText('你已同意')
}

let g1v1 = ''
let g1v2 = ''
let g2v1 = ''

test('逐人同意：勾已閱讀才按得下去、確認框只代表自己一票；老師提前沒有按鈕；管理員頁看得到缺誰、沒有任何替人同意的按鈕', async ({ page }) => {
  g1v1 = await createVersion(page, 'G01')
  // 管理員版本頁：沒有替人同意的按鈕。
  await expect(page.getByRole('button', { name: '我已閱讀並同意' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '以指導老師身分同意' })).toHaveCount(0)

  await studentAgrees(page, g1[0]!)
  await expect(page.getByTestId('signoff-agreed')).toHaveText('學生 1／3 已同意')
  await expect(page.getByTestId('respond-form')).toHaveCount(0)
  // 重新整理仍是已同意、時間不變。
  const mine = await page.getByTestId('my-response').textContent()
  await page.reload()
  await expect(page.getByTestId('my-response')).toHaveText(mine!)

  await signIn(page, t1)
  await page.goto(`/dashboard/teacher/signoff/${g1v1}`)
  await expect(page.getByTestId('my-response')).toContainText('還有 2 位學生沒同意；全部學生同意後才輪到你')
  await expect(page.getByRole('button', { name: '以指導老師身分同意' })).toHaveCount(0)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff?cohort=${cohortId}`)
  const cell = page.getByTestId('package-cell').filter({ hasText: 'v1' }).first()
  await expect(cell).toContainText('1／3')
  await cell.getByText('缺 3 位').click()
  await expect(cell.getByTestId('missing-details')).toContainText(names.get(g1[1]!.userId)!)
  await expect(cell.getByTestId('missing-details')).toContainText(`${T1_NAME}（主指導）`)
})

test('重置：對話框列出將失效的簽署、理由必填；舊頁再按被拒；新版 v2 大家重新同意（舊同意留歷史）', async ({ page, context }) => {
  // 學生乙先開著舊頁（v1）。
  await signIn(page, g1[1]!)
  await page.goto('/dashboard/student/signoff')
  await expect(page.getByTestId('respond-form')).toBeVisible()

  const admin = await context.browser()!.newContext()
  const adminPage = await admin.newPage()
  await admin.addCookies([toPlaywrightCookie((await sharedTestSession(adminPage.request, 'admin')).cookie, BASE_URL)])
  await adminPage.goto(`/dashboard/admin/signoff/${g1v1}`)
  await adminPage.getByRole('button', { name: '重置', exact: true }).click()
  const dialog = adminPage.getByRole('dialog', { name: '重置？' })
  await expect(dialog.getByTestId('restart-affected')).toContainText(`${names.get(g1[0]!.userId)}（同意）`)
  await dialog.getByRole('button', { name: '確定重置' }).click()
  await expect(dialog.getByRole('alert')).toContainText('請填寫重置的理由')
  await dialog.getByLabel('理由（必填）').fill('附件放錯版本')
  await dialog.getByRole('button', { name: '確定重置' }).click()
  // 成功後直接帶到新版，上方是回執。
  await expect(adminPage.getByRole('status').filter({ hasText: '已重置' })).toContainText('這是新建的 v2（內容與 v1 相同）')
  await expect(adminPage).not.toHaveURL(new RegExp(g1v1))
  g1v2 = new URL(adminPage.url()).pathname.split('/').at(-1)!
  await expect(adminPage.getByTestId('signoff-agreed')).toHaveText('學生 0／3 已同意')
  await admin.close()

  // 舊頁（v1）按同意：伺服器拒絕，說版本已失效。
  await page.getByTestId('respond-form').getByRole('checkbox').check()
  await page.getByTestId('respond-form').getByRole('button', { name: '我已閱讀並同意' }).click()
  const confirm = page.getByRole('dialog', { name: '確認同意' })
  await confirm.getByRole('button', { name: '我已閱讀並同意' }).click()
  await expect(confirm.getByRole('alert')).toContainText('已失效')

  await page.reload()
  await expect(page.getByRole('article', { name: 'G01 期中結果確認 v2' })).toBeVisible()
  await expect(page.getByTestId('signoff-agreed')).toHaveText('學生 0／3 已同意')

  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${g1v1}`)
  await expect(page.getByTestId('signoff-invalidated')).toContainText('系辦重置')
  await expect(page.getByTestId('signoff-participants')).toContainText('同意・')
})

test('全員同意後輪到老師（通知「輪到你」）、老師同意即完成；三個角色看到一致的完成狀態', async ({ page }) => {
  for (const s of g1) await studentAgrees(page, s)
  await expect(page.getByTestId('signoff-agreed')).toHaveText('學生 3／3 已同意')
  await expect(page.getByTestId('signoff-state').first()).toHaveText('等待指導老師')

  await signIn(page, t1)
  await expect(async () => {
    await page.goto('/dashboard/teacher/inbox')
    await expect(page.getByText('G01「期中結果確認」v2：3 位學生都已同意，輪到你閱讀並同意')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
  await page.goto('/dashboard/teacher/signoff')
  const card = page.getByTestId('teacher-signoff-card').filter({ hasText: 'G01・期中結果確認' })
  await expect(card.getByTestId('teacher-card-status')).toHaveText('輪到你')
  await card.getByRole('link', { name: '閱讀全文並表態' }).click()
  const form = page.getByTestId('respond-form')
  await form.getByRole('checkbox').check()
  await form.getByRole('button', { name: '以指導老師身分同意' }).click()
  await page.getByRole('dialog', { name: '確認同意' }).getByRole('button', { name: '以指導老師身分同意' }).click()
  await expect(page.getByTestId('my-response')).toContainText('你已同意')
  await expect(page.getByTestId('signoff-state').first()).toHaveText('已完成')

  await signIn(page, g1[2]!)
  await page.goto('/dashboard/student/signoff')
  await expect(page.getByTestId('signoff-state').first()).toHaveText('已完成')
  await expect(page.getByTestId('progress-advisor')).toContainText('同意・')
  await expect(async () => {
    await page.goto('/dashboard/student/inbox')
    await expect(page.getByText(/此版本站內簽核已完成/)).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })

  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff?cohort=${cohortId}`)
  await expect(page.getByTestId('package-cell').filter({ hasText: 'v2' }).first()).toContainText('3／3')
})

test('匯出：可列印頁（新分頁）與 CSV 明細；每次匯出都留紀錄；學生拿不到、別站送不進來', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${g1v2}`)
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: '匯出可列印頁' }).click()
  const printable = await popup
  await expect(printable.getByText('站內內容確認與同意紀錄，行政採認待確認')).toBeVisible()
  await expect(printable.getByText(`${CONTENT}G01`)).toBeVisible()
  await expect(printable.locator('body')).toContainText('以指導老師身分同意')
  await expect(printable.locator('body')).toContainText('已完成')
  await printable.close()

  const csv = await page.request.post(`/api/admin/signoff/${g1v2}/export`, {
    form: { format: 'csv' },
    headers: { origin: BASE_URL },
  })
  expect(csv.status()).toBe(200)
  expect(csv.headers()['content-type']).toContain('text/csv')
  expect(csv.headers()['content-disposition']).toContain('attachment')
  const text = await csv.text()
  expect(text).toContain('"這次登入方式"')
  expect(text).toContain('"按鈕原文"')
  expect(text).toContain(`"${names.get(g1[0]!.userId)}"`)
  // 只看標題列：資料列裡有隨機屆別代碼（`T26-<base36>`，例如 T26-MUGIPQBF），碰巧含 "IP" 就會誤判。
  const header = text.replace(/^\uFEFF/, '').split('\r\n')[0]!
  expect(header).toContain('"按鈕原文"')
  expect(header).not.toMatch(/IP|User-Agent|瀏覽器/i)

  await page.reload()
  await expect(page.getByTestId('signoff-exports').getByRole('listitem')).toHaveCount(2)

  // 別站送來的：同源檢查擋掉。學生：403。沒登入：401。
  const cross = await page.request.post(`/api/admin/signoff/${g1v2}/export`, {
    form: { format: 'csv' },
    headers: { origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' },
  })
  expect(cross.status()).toBe(403)
  const studentContext = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { cookie: g1[0]!.cookie, origin: BASE_URL } })
  expect((await studentContext.post(`/api/admin/signoff/${g1v2}/export`, { form: { format: 'csv' } })).status()).toBe(403)
  await studentContext.dispose()
  const anon = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } })
  expect((await anon.post(`/api/admin/signoff/${g1v2}/export`, { form: { format: 'csv' } })).status()).toBe(401)
  await anon.dispose()
  const rows = await pool.query<{ n: number }>(`select count(*)::int as n from signoff_exports where version_id = $1`, [g1v2])
  expect(rows.rows[0]!.n).toBe(2)
})

test('提醒未同意者：收件人是還沒表態的人；24 小時內按鈕不可用並寫上次時間；已完成的版本不能提醒', async ({ page }) => {
  g2v1 = await createVersion(page, 'G02')
  await page.getByRole('button', { name: '提醒未同意者' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已提醒' })).toContainText('已提醒 G02 v1 還沒表態的 3 位學生與指導老師')
  await page.reload()
  await expect(page.getByRole('button', { name: '提醒未同意者' })).toBeDisabled()
  await expect(page.getByTestId('remind-blocked')).toContainText('已於')

  await signIn(page, g2[1]!)
  await expect(async () => {
    await page.goto('/dashboard/student/inbox')
    await expect(page.getByText('提醒：G02「期中結果確認」v1 還等你閱讀並表態')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })

  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${g1v2}`)
  await expect(page.getByRole('button', { name: '提醒未同意者' })).toBeDisabled()
  await expect(page.getByTestId('remind-blocked')).toContainText('只有收集中或等老師的目前版本可以提醒')
})

test('不同意：理由必填、送出後退回修正中，其他組員看到理由；系辦「重開新版」＝建新版', async ({ page }) => {
  await signIn(page, g2[0]!)
  await page.goto('/dashboard/student/signoff')
  await page.getByTestId('respond-form').getByRole('button', { name: '不同意並退回修正' }).click()
  const dialog = page.getByRole('dialog', { name: '不同意並退回修正' })
  await dialog.getByRole('button', { name: '確定不同意並退回修正' }).click()
  await expect(dialog.getByRole('alert')).toContainText('理由')
  await dialog.getByLabel('理由（必填）').fill('第三章的數據要更新')
  await dialog.getByRole('button', { name: '確定不同意並退回修正' }).click()
  await expect(page.getByTestId('signoff-state').first()).toHaveText('退回修正中')

  await signIn(page, g2[2]!)
  await page.goto('/dashboard/student/signoff')
  await expect(page.getByTestId('signoff-invalidated')).toContainText('第三章的數據要更新')
  await expect(page.getByTestId('respond-form')).toHaveCount(0)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${g2v1}`)
  await page.getByRole('button', { name: '重開新版' }).click()
  const reopen = page.getByRole('dialog', { name: '重開新版？' })
  await reopen.getByLabel('理由（必填）').fill('第三章已更新，重新簽核')
  await reopen.getByRole('button', { name: '確定重開新版' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已重開新版' })).toContainText('這是新建的 v2')
  await expect(page.getByTestId('signoff-state').first()).toHaveText('收集學生同意中')
  await expect(page.getByRole('region', { name: '版本歷史' })).toContainText('v1')
})

test('主指導改派：目前版本同時失效、不自動建新版；學生舊頁顯示原因等系辦建新版；失效通知只給系辦；作廢要理由', async ({ page }) => {
  await studentAgrees(page, g2[0]!)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const row = page.getByRole('region', { name: '全部組別' }).getByRole('row').filter({ hasText: 'G02' })
  await row.getByRole('button', { name: '重派指導老師：G02' }).click()
  const dialog = page.getByRole('dialog', { name: '重派 G02 的指導老師' })
  await dialog.getByLabel('指導老師').selectOption({ label: `${T2_NAME}（${t2.email}）` })
  await dialog.getByLabel('理由（必填）').fill(`${T1_NAME}休假`)
  await dialog.getByRole('button', { name: '確認重派' }).click()
  await expect(row.getByRole('status')).toContainText('簽核目前版本已失效（指導老師變更），請到「簽核」建立新版')

  const versions = await pool.query<{ n: number }>(
    `select count(*)::int as n from signoff_package_versions v join signoff_packages p on p.id = v.package_id
      join groups g on g.id = p.group_id where g.cohort_id = $1 and g.code = 'G02'`,
    [cohortId],
  )
  expect(versions.rows[0]!.n).toBe(2)

  await signIn(page, g2[1]!)
  await page.goto('/dashboard/student/signoff')
  await expect(page.getByTestId('signoff-invalidated')).toContainText('此版本已失效（指導老師變更），等待管理員建立新版')
  await expect(page.getByTestId('respond-form')).toHaveCount(0)

  // 失效通知：系辦收到，學生沒有。
  await asAdmin(page)
  await expect(async () => {
    await page.goto('/dashboard/admin/inbox')
    await expect(page.getByText('G02「期中結果確認」v2 因指導老師變更已失效，請建立新版')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
  await signIn(page, g2[1]!)
  await page.goto('/dashboard/student/inbox')
  await expect(page.getByText('因指導老師變更已失效')).toHaveCount(0)

  // 舊老師：版本頁不能再表態；系辦重開新版後新老師是參與者。
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff?cohort=${cohortId}`)
  await expect(page.getByRole('region', { name: '各組簽核' })).toContainText('指導老師變更，待建新版')
  const current = page.getByTestId('package-cell').filter({ hasText: '指導老師變更' }).first()
  await current.getByRole('link', { name: 'v2' }).click()
  await page.getByRole('button', { name: '重開新版' }).click()
  const reopen = page.getByRole('dialog', { name: '重開新版？' })
  await reopen.getByLabel('理由（必填）').fill('換老師後重新簽核')
  await reopen.getByRole('button', { name: '確定重開新版' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已重開新版' })).toContainText('這是新建的 v3')
  await expect(page.getByTestId('progress-advisor')).toContainText(T2_NAME)
  const v3 = new URL(page.url()).pathname.split('/').at(-1)!

  await signIn(page, t1)
  await page.goto(`/dashboard/teacher/signoff/${v3}`)
  await expect(page.getByText('無法存取')).toBeVisible()

  // 作廢：理由必填；作廢後學生頁寫已作廢、沒有按鈕。
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${v3}`)
  await page.getByRole('button', { name: '作廢', exact: true }).click()
  const voidDialog = page.getByRole('dialog', { name: '作廢這一版？' })
  await voidDialog.getByRole('button', { name: '確定作廢' }).click()
  await expect(voidDialog.getByRole('alert')).toContainText('請填寫作廢的理由')
  await voidDialog.getByLabel('理由（必填）').fill('本學期不做期中確認')
  await voidDialog.getByRole('button', { name: '確定作廢' }).click()
  await expect(page.getByTestId('signoff-state').first()).toHaveText('已作廢')

  await signIn(page, g2[2]!)
  await page.goto('/dashboard/student/signoff')
  await expect(page.getByTestId('signoff-invalidated')).toContainText('此版本已作廢（本學期不做期中確認）')
  await expect(page.getByTestId('respond-form')).toHaveCount(0)
})
