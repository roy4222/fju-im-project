import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createLegacyVersion } from './legacy-signoff'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 26（#237）：逐人同意、老師同意與簽核管理。「做完的樣子」逐條走，全程用真的畫面與按鈕：
 *
 * 1. 學生逐人閱讀後同意（勾「已完整閱讀」→ 確認框「只代表你自己的一票」），或不同意並填理由；全員同意後才輪到老師，
 *    老師提前時沒有按鈕、只寫還差幾位（伺服器也擋，整合測試證明 `STUDENTS_PENDING`）。
 * 2. 老師同意即完成，或退回（填理由）回到修正中。
 * 3. 管理員看整體進度與缺誰、重置或作廢（理由選填，C1-03）、重開＝建新版；管理員頁沒有任何替人同意的按鈕。
 * 4. 主指導改變時目前版本自動失效、不自動建新版；舊頁顯示原因等系辦建新版；失效通知只給系辦。
 * 5. 匯出可列印頁與 CSV 明細；提醒未同意者，24 小時內不重複。
 *
 * 組別、成員、主指導直接用 owner 連線建好（票 13、19 的事）。舊同意書（沒連作業的簽核包）的版本也是：C2-22 起系辦舊同意書頁改成轉址、
 * 畫面上沒有建舊包的入口，由 `legacy-signoff.ts` 照正式建版寫同樣的列；同意、退回、失效、唯讀、匯出仍全程用真的畫面與按鈕。不可代簽的每一條反例、並發、同交易失效由整合測試
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
/** 組別代號 → id（建舊包用）。 */
const groupIds = new Map<string, string>()

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
  groupIds.set('G01', await makeGroup('G01', g1, t1))
  groupIds.set('G02', await makeGroup('G02', g2, t1))
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

/** 同組同用途建一版舊同意書（測試準備，見 `legacy-signoff.ts`），然後系辦開它的版本頁。 */
async function createVersion(page: Page, groupCode: string) {
  const { versionId } = await createLegacyVersion(pool, {
    groupId: groupIds.get(groupCode)!,
    purpose: 'result_confirmation',
    content: `${CONTENT}${groupCode}`,
    adminId,
  })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${versionId}`)
  await expect(page.getByTestId('signoff-content')).toContainText(`${CONTENT}${groupCode}`)
  return versionId
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
let g2v2 = ''

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

  // 管理員看得到缺誰（舊同意書頁的各組卡片 C2-22 拿掉，改在版本頁看同一份進度）。
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${g1v1}`)
  await expect(page.getByTestId('signoff-agreed')).toHaveText('學生 1／3 已同意')
  await expect(page.getByTestId('signoff-missing')).toContainText(names.get(g1[1]!.userId)!)
  await expect(page.getByTestId('signoff-missing')).toContainText(names.get(g1[2]!.userId)!)
  await expect(page.getByTestId('signoff-missing')).not.toContainText(T1_NAME)
})

test('舊同意書（沒連作業）唯讀（C1-11）：版本頁只有狀態與匯出，沒有提醒、重新收集、重開、作廢；同組再建一版後舊頁再按被拒，v2 大家重新同意', async ({ page, context }) => {
  // 學生乙先開著舊頁（v1）。
  await signIn(page, g1[1]!)
  await page.goto('/dashboard/student/signoff')
  await expect(page.getByTestId('respond-form')).toBeVisible()

  const admin = await context.browser()!.newContext()
  const adminPage = await admin.newPage()
  await admin.addCookies([toPlaywrightCookie((await sharedTestSession(adminPage.request, 'admin')).cookie, BASE_URL)])
  await adminPage.goto(`/dashboard/admin/signoff/${g1v1}`)
  await expect(adminPage.getByTestId('signoff-readonly')).toContainText('只能查看與匯出')
  await expect(adminPage.getByRole('region', { name: '危險操作' })).toHaveCount(0)
  for (const name of ['提醒未同意者', '重新收集同意（內容不變）', '重開新版', '作廢', '建立']) {
    await expect(adminPage.getByRole('button', { name, exact: true })).toHaveCount(0)
  }
  await expect(adminPage.getByRole('button', { name: '匯出CSV 明細' })).toBeVisible()
  await expect(adminPage.getByTestId('signoff-state').first()).toHaveText('收集學生同意中')
  // 舊 API 同組同用途再建一版（v2，舊版失效）。
  g1v2 = await createVersion(adminPage, 'G01')
  await admin.close()

  // 舊頁（v1）按同意：伺服器拒絕，說版本已失效。
  await page.getByTestId('respond-form').getByRole('checkbox').check()
  await page.getByTestId('respond-form').getByRole('button', { name: '我已閱讀並同意' }).click()
  const confirm = page.getByRole('dialog', { name: '確認同意' })
  await confirm.getByRole('button', { name: '我已閱讀並同意' }).click()
  await expect(confirm.getByRole('alert')).toContainText('已被新版取代')

  await page.reload()
  await expect(page.getByRole('article', { name: 'G01 期中結果確認 第 2 版' })).toBeVisible()
  await expect(page.getByTestId('signoff-agreed')).toHaveText('學生 0／3 已同意')

  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${g1v1}`)
  await expect(page.getByTestId('signoff-invalidated')).toBeVisible()
  await expect(page.getByTestId('signoff-participants')).toContainText('同意・')
})

test('全員同意後輪到老師（通知「輪到你」）、老師同意即完成；三個角色看到一致的完成狀態', async ({ page }) => {
  for (const s of g1) await studentAgrees(page, s)
  await expect(page.getByTestId('signoff-agreed')).toHaveText('學生 3／3 已同意')
  await expect(page.getByTestId('signoff-state').first()).toHaveText('等待指導老師')

  await signIn(page, t1)
  await expect(async () => {
    await page.goto('/dashboard/teacher/inbox')
    await expect(page.getByText('G01「期中結果確認」：3 位學生都已同意，輪到你閱讀並同意')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
  // C1-11：作業區的「同意書」卡片分頁拿掉（等你同意的併進「我的作業」）；舊 API 建的包直接開版本頁。
  await page.goto(`/dashboard/teacher/signoff/${g1v2}`)
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
    await expect(page.getByText(/這一版同意書全員已同意/)).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
  // 驗收 P-07：白話寫「不代表校方正式接受這份同意紀錄」，不用「校方採認」。
  await expect(page.getByText(/不代表校方正式接受這份同意紀錄/)).toBeVisible()
  await expect(page.getByText(/校方採認/)).toHaveCount(0)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${g1v2}`)
  await expect(page.getByTestId('signoff-agreed')).toHaveText('學生 3／3 已同意')
  await expect(page.getByTestId('signoff-state').first()).toHaveText('已完成')
})

test('匯出：可列印頁（新分頁）與 CSV 明細；每次匯出都留紀錄；學生拿不到、別站送不進來', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${g1v2}`)
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: '匯出可列印頁' }).click()
  const printable = await popup
  await expect(printable.getByText('站內內容確認與同意紀錄；校方是否接受這份同意紀錄：尚待確認')).toBeVisible()
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

test('舊同意書版本頁沒有「提醒未同意者」（C1-11 唯讀；提醒改在同意書看板，見 consent-item.spec）', async ({ page }) => {
  g2v1 = await createVersion(page, 'G02')
  await expect(page.getByTestId('signoff-readonly')).toBeVisible()
  await expect(page.getByRole('button', { name: '提醒未同意者' })).toHaveCount(0)
  await page.goto(`/dashboard/admin/signoff/${g1v2}`)
  await expect(page.getByRole('button', { name: '提醒未同意者' })).toHaveCount(0)
})

test('不同意：理由選填（C1-03）、送出後退回修正中，其他組員看到理由；舊同意書唯讀（C1-11），系辦同組再建一版', async ({ page }) => {
  await signIn(page, g2[0]!)
  await page.goto('/dashboard/student/signoff')
  // Q39：按鈕旁說明可以稍後再回覆、不同意會讓全組重新同意。
  await expect(page.getByTestId('respond-later-hint')).toHaveText(
    '想先確認再回覆的話，可以稍後再回來，不用按任何按鈕。按『不同意並退回』會讓全組重新同意。',
  )
  await page.getByTestId('respond-form').getByRole('button', { name: '不同意並退回修正' }).click()
  const dialog = page.getByRole('dialog', { name: '不同意並退回修正' })
  // C1-03：理由改選填，不再有「沒填被擋」那一步；有填理由時其他組員仍看得到。
  await dialog.getByLabel('理由（選填）').fill('第三章的數據要更新')
  await dialog.getByRole('button', { name: '確定不同意並退回修正' }).click()
  await expect(page.getByTestId('signoff-state').first()).toHaveText('退回修正中')

  await signIn(page, g2[2]!)
  await page.goto('/dashboard/student/signoff')
  await expect(page.getByTestId('signoff-invalidated')).toContainText('第三章的數據要更新')
  await expect(page.getByTestId('respond-form')).toHaveCount(0)

  // C1-11：舊同意書唯讀，沒有「重開新版」；系辦用舊 API 同組再建一版（第 2 版）。
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${g2v1}`)
  await expect(page.getByTestId('signoff-state').first()).toHaveText('退回修正中')
  await expect(page.getByRole('button', { name: '重開新版' })).toHaveCount(0)
  g2v2 = await createVersion(page, 'G02')
  await expect(page.getByTestId('signoff-state').first()).toHaveText('收集學生同意中')
  await expect(page.getByRole('region', { name: '版本歷史' })).toContainText('第 1 版')
})

test('主指導改派：目前版本同時失效、不自動建新版；學生舊頁顯示原因等系辦建新版；失效通知只給系辦；舊同意書沒有作廢（C1-11 唯讀）', async ({ page }) => {
  await studentAgrees(page, g2[0]!)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const row = page.getByRole('region', { name: '全部組別' }).getByRole('article', { name: 'G02', exact: true })
  if ((await row.locator('details').getAttribute('open')) === null) await row.locator('summary').click()
  await row.getByRole('button', { name: '重派指導老師：G02' }).click()
  const dialog = page.getByRole('dialog', { name: '重派 G02 的指導老師' })
  await dialog.getByLabel('指導老師').selectOption({ label: `${T2_NAME}（${t2.email}）` })
  await dialog.getByLabel('理由（可不填）').fill(`${T1_NAME}休假`)
  await dialog.getByRole('button', { name: '確認重派' }).click()
  await expect(row.getByRole('status')).toContainText('同意書目前的版本已作廢（指導老師變更），請到「同意書」建立新版')

  const versions = await pool.query<{ n: number }>(
    `select count(*)::int as n from signoff_package_versions v join signoff_packages p on p.id = v.package_id
      join groups g on g.id = p.group_id where g.cohort_id = $1 and g.code = 'G02'`,
    [cohortId],
  )
  expect(versions.rows[0]!.n).toBe(2)

  await signIn(page, g2[1]!)
  await page.goto('/dashboard/student/signoff')
  await expect(page.getByTestId('signoff-invalidated')).toContainText('這一版同意書已作廢（指導老師變更），等系辦建立新版')
  // 還沒有新版：徽章跟說明一致寫「已作廢」，不說「已被新版取代」。
  await expect(page.getByTestId('signoff-state').first()).toHaveText('已作廢（指導老師變更）')
  await expect(page.getByTestId('respond-form')).toHaveCount(0)

  // 失效通知：系辦收到，學生沒有。
  await asAdmin(page)
  await expect(async () => {
    await page.goto('/dashboard/admin/inbox')
    await expect(page.getByText('G02「期中結果確認」第 2 版因指導老師變更已作廢，請建立新版')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
  await signIn(page, g2[1]!)
  await page.goto('/dashboard/student/inbox')
  await expect(page.getByText('因指導老師變更已作廢')).toHaveCount(0)

  // 舊老師：版本頁不能再表態；系辦再建一版後新老師是參與者。
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${g2v2}`)
  await expect(page.getByTestId('signoff-state').first()).toHaveText('已作廢（指導老師變更）')
  // C1-11：舊同意書唯讀，沒有「重開新版」「作廢」；系辦用舊 API 同組再建一版（第 3 版），新老師是參與者。
  await expect(page.getByRole('button', { name: '重開新版' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '作廢', exact: true })).toHaveCount(0)
  const v3 = await createVersion(page, 'G02')
  await expect(page.getByTestId('progress-advisor')).toContainText(T2_NAME)

  await signIn(page, t1)
  await page.goto(`/dashboard/teacher/signoff/${v3}`)
  await expect(page.getByRole('heading', { name: '找不到這個頁面' })).toBeVisible()

  // 作廢在舊版本頁沒有了（C1-11 唯讀）；看板的作廢（理由選填）見 consent-item.spec AC-25。
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff/${v3}`)
  await expect(page.getByTestId('signoff-readonly')).toBeVisible()
  await expect(page.getByRole('region', { name: '危險操作' })).toHaveCount(0)
})
