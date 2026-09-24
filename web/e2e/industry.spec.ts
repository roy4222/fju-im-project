import { readFile } from 'node:fs/promises'
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 20（#231）：合作案與組別名單匯出（含複製本組信箱）。「做完的樣子」逐條走：
 *
 * 1. 老師建立、發布、下架、重新發布合作案；登入者看公開欄位，聯絡資訊只有案主與系辦看得到（連 HTML 原始碼裡都沒有）。
 * 2. 產學組組長把組別連結到合作案、換案（理由必填）；案主解除連結並通知。
 * 3. 組長在三個條件內自行改組別類型，否則畫面說明原因、交系辦處理（系辦改類型保留既有關聯）。
 * 4. 管理員篩選、排序本屆組別名單；每組有組員信箱欄與「複製本組信箱」；匯出 CSV／XLSX 帶登入信箱。
 * 查詢層的欄位白名單、並發與版本衝突由整合測試 pg-opportunities.integration.test.ts 證明。
 *
 * 組別直接用 owner 連線建好（成組流程是票 13 的事）；票 20 的動作全程用真的畫面與按鈕。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T20-${stamp}`
const COMPANY = `輔仁零售${stamp.slice(-4)}`
const COMPANY_B = `新莊物流${stamp.slice(-4)}`
const SECRET_PHONE = `02-2905-${String(Date.now()).slice(-4)}`
const SECRET_EMAIL = `secret-${stamp.toLowerCase()}@company.example.com`

let pool: Pool
let cohortId: string
let adminId: string
let owner: TestSession
let ownerB: TestSession
let leader: TestSession
let generalLeader: TestSession
let outsider: TestSession
const groupIds = new Map<string, string>()
const memberIds = new Map<string, string[]>()
const memberEmails = new Map<string, string[]>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

let studentSeq = 0
async function insertStudent(session: TestSession | null): Promise<{ id: string; email: string }> {
  studentSeq += 1
  const studentNo = `0412${String(Date.now()).slice(-4)}${studentSeq}`
  const name = `T20組員${studentSeq}號`
  let id = session?.userId ?? null
  let email = session?.email ?? `t20-${stamp.toLowerCase()}-${studentSeq}@school.example.org`
  if (!id) {
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [name, email],
    )
    id = user.rows[0]!.id
    await pool.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, adminId],
    )
  } else {
    email = session!.email
  }
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [id, name, studentNo, cohortId, `t20-${studentSeq}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { id, email }
}

async function insertGroup(code: string, type: 'general' | 'industry', first: TestSession | null = null) {
  const members = [await insertStudent(first), await insertStudent(null)]
  const at = new Date(Date.now() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                         created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, 'active', $5, $5, $5, 'user', $4, $5, $4) returning id`,
    [cohortId, code, type, members[0]!.id, at],
  )
  const id = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
     select gen_random_uuid(), $1, $2, u, $4, 'user', $3, $4, $4 from unnest($5::uuid[]) as u`,
    [id, cohortId, members[0]!.id, at, members.map((m) => m.id)],
  )
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at)
     values (gen_random_uuid(), $1, $2, $3, $2, $3)`,
    [id, members[0]!.id, at],
  )
  groupIds.set(code, id)
  memberIds.set(code, members.map((m) => m.id))
  memberEmails.set(code, members.map((m) => m.email))
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
  owner = await fresh('teacher')
  ownerB = await fresh('teacher')
  leader = await fresh('student')
  generalLeader = await fresh('student')
  outsider = await fresh('student')
  await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [owner.userId, `案主甲${stamp.slice(-3)}`])
  await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [ownerB.userId, `案主乙${stamp.slice(-3)}`])

  // 成組期：第 1 階段 10 天前開始、第 2 階段 20 天後開始（組長改類型的條件之一）。
  const now = new Date()
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 'system') returning id`,
    [CODE, `${CODE} 產學測試`, ymd(new Date(now.getTime() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id
  for (const [seq, offset] of [
    [1, -10],
    [2, 20],
    [3, 60],
    [4, 120],
  ] as const) {
    await pool.query(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, seq, `第 ${seq} 階段`, ymd(new Date(now.getTime() + offset * 86_400_000))],
    )
  }
  await insertGroup('G01', 'industry', leader)
  await insertGroup('G02', 'general', generalLeader)
  await insertGroup('G03', 'industry')
  await insertStudent(outsider)
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function signInAdmin(page: Page) {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
}

async function opportunityId(company: string): Promise<string> {
  const rows = await pool.query<{ id: string }>('select id from industry_opportunities where company_name = $1', [company])
  return rows.rows[0]!.id
}

async function recipientsOf(type: string, groupCode: string): Promise<string[][]> {
  const rows = await pool.query<{ recipients: string[] }>(
    `select recipients from domain_events where type = $1 and payload->>'groupId' = $2 order by occurred_real_at, id`,
    [type, groupIds.get(groupCode)],
  )
  return rows.rows.map((r) => [...r.recipients].sort())
}

const sorted = (...list: string[]) => [...list].sort()

async function createOpportunity(page: Page, session: TestSession, company: string, publish: boolean) {
  await signIn(page, session)
  await page.goto('/dashboard/teacher/industry')
  await page.getByRole('button', { name: '新增合作案' }).click()
  const dialog = page.getByRole('dialog', { name: '新增合作案' })
  await dialog.getByLabel('公司名稱').fill(company)
  await dialog.getByLabel('需求部門').fill('資訊部')
  // 先不填內容：伺服器擋下、焦點移到那一欄，已經打的字不會不見。
  await dialog.getByRole('button', { name: '儲存並發布' }).click()
  await expect(dialog.getByRole('alert')).toContainText('請填專題／合作內容')
  await expect(dialog.getByLabel('公司名稱')).toHaveValue(company)
  await dialog.getByLabel('專題／合作內容').fill('門市補貨預測\n\n<script>alert(1)</script>用資料找出缺貨')
  await dialog.getByLabel('對學生的條件／需求').fill('會 Python')
  await dialog.getByLabel('聯絡電話').fill(SECRET_PHONE)
  await dialog.getByLabel('聯絡 Email').fill(SECRET_EMAIL)
  await dialog.getByLabel('聯絡人').fill('王經理')
  await dialog.getByRole('button', { name: publish ? '儲存並發布' : '儲存草稿' }).click()
  await expect(page.getByRole('status').filter({ hasText: publish ? `已發布「${company}・資訊部」` : `已儲存草稿「${company}・資訊部」` })).toBeAttached()
}

test('老師建立合作案（先存草稿再發布）；下架、重新發布；聯絡資訊只有案主與系辦看得到', async ({ page }) => {
  await createOpportunity(page, owner, COMPANY, false)
  const item = page.getByTestId('managed-opportunity').filter({ hasText: COMPANY })
  await expect(item).toContainText('草稿')

  // 草稿：別的學生打開是 404（不透露存在）。
  const id = await opportunityId(COMPANY)
  await signIn(page, outsider)
  expect((await page.goto(`/industry/${id}`))?.status()).toBe(404)

  await signIn(page, owner)
  await page.goto('/dashboard/teacher/industry')
  await item.getByRole('button', { name: `發布：${COMPANY}・資訊部` }).click()
  await page.getByRole('dialog', { name: `發布「${COMPANY}・資訊部」` }).getByRole('button', { name: '確認發布' }).click()
  await expect(item).toContainText('已發布')

  // 案主看詳情：聯絡資訊在。
  await page.goto(`/industry/${id}`)
  await expect(page.getByTestId('opportunity-contact')).toContainText(SECRET_PHONE)
  await expect(page.getByTestId('opportunity-contact')).toContainText(SECRET_EMAIL)
  // 內容裡的 HTML 被清洗：script 不會出現在頁面上。
  await expect(page.getByRole('heading', { name: '專題／合作內容' }).locator('..')).toContainText('用資料找出缺貨')
  expect(await page.content()).not.toContain('<script>alert(1)</script>')

  // 其他學生：列表與詳情看得到公開欄位，聯絡資訊一個字都不在 HTML 裡。
  await signIn(page, outsider)
  await page.goto('/industry')
  await expect(page.getByTestId('opportunity-card').filter({ hasText: COMPANY })).toContainText('門市補貨預測')
  await page.getByTestId('opportunity-card').filter({ hasText: COMPANY }).click()
  await expect(page.getByTestId('opportunity-contact')).toContainText('只有負責老師與系辦看得到')
  const html = await page.content()
  expect(html).not.toContain(SECRET_PHONE)
  expect(html).not.toContain(SECRET_EMAIL)
  expect(html).not.toContain('王經理')

  // 另一位老師也看不到；系辦看得到。
  await signIn(page, ownerB)
  await page.goto(`/industry/${id}`)
  expect(await page.content()).not.toContain(SECRET_PHONE)
  await signInAdmin(page)
  await page.goto(`/industry/${id}`)
  await expect(page.getByTestId('opportunity-contact')).toContainText(SECRET_PHONE)

  // 訪客：要登入。
  await page.context().clearCookies()
  await page.goto('/industry')
  await expect(page.getByTestId('need-login')).toContainText('產學合作列表需要登入')
  await page.goto(`/industry/${id}`)
  await expect(page.getByTestId('need-login')).toBeVisible()
  expect(await page.content()).not.toContain(COMPANY)

  // 下架 → 列表不見 → 重新發布 → 回來。
  await signIn(page, owner)
  await page.goto('/dashboard/teacher/industry')
  await item.getByRole('button', { name: `下架：${COMPANY}・資訊部` }).click()
  await page.getByRole('dialog', { name: `下架「${COMPANY}・資訊部」` }).getByRole('button', { name: '確認下架' }).click()
  await expect(item).toContainText('已下架')
  await expect(item.getByRole('button', { name: `編輯：${COMPANY}・資訊部` })).toHaveCount(0)
  await signIn(page, outsider)
  await page.goto('/industry')
  await expect(page.getByTestId('opportunity-card').filter({ hasText: COMPANY })).toHaveCount(0)
  await signIn(page, owner)
  await page.goto('/dashboard/teacher/industry')
  await item.getByRole('button', { name: `重新發布：${COMPANY}・資訊部` }).click()
  await page.getByRole('dialog', { name: `重新發布「${COMPANY}・資訊部」` }).getByRole('button', { name: '確認重新發布' }).click()
  await expect(item).toContainText('已發布')
})

test('組長把產學組連結到合作案、換案（理由必填，全組與兩位案主收到通知）；非組長與一般組看不到連結表單', async ({ page }) => {
  await createOpportunity(page, ownerB, COMPANY_B, true)
  const a = await opportunityId(COMPANY)
  const b = await opportunityId(COMPANY_B)

  // 從合作案詳情頁的「連結到這個合作案」進來，選單已經預選好。
  await signIn(page, leader)
  await page.goto(`/industry/${a}`)
  await page.getByRole('link', { name: '把 G01 連結到這個合作案' }).click()
  const panel = page.locator('#industry-link')
  await expect(panel.getByLabel('選一個已發布的合作案')).toHaveValue(a)
  await panel.getByRole('button', { name: '把 G01 連結到這個合作案' }).click()
  await expect(panel.getByRole('status')).toContainText(`G01 已連結「${COMPANY}・資訊部」`)
  await page.reload()
  await expect(page.getByTestId('linked-opportunity')).toContainText(`${COMPANY}・資訊部`)
  // 有合作案之後，組長不能自己改類型。
  await expect(page.getByTestId('type-change-blocked')).toContainText('已經連結合作案')

  // 換案：沒填理由被擋，填了才換。
  await panel.getByLabel('換到另一個合作案').selectOption(b)
  await panel.getByRole('button', { name: '確認換案' }).click()
  await expect(panel.getByRole('alert')).toContainText('換案一定要填理由')
  await panel.getByLabel('換案理由（必填）').fill('和企業討論後改做物流題目')
  await panel.getByRole('button', { name: '確認換案' }).click()
  await expect(panel.getByRole('status')).toContainText(`G01 已從「${COMPANY}・資訊部」換到「${COMPANY_B}・資訊部」`)
  expect(await recipientsOf('opportunity.switched', 'G01')).toEqual([sorted(...memberIds.get('G01')!, owner.userId, ownerB.userId)])
  await page.reload()
  await expect(page.getByRole('list', { name: '組別異動' })).toContainText(`合作案 ${COMPANY}・資訊部 → ${COMPANY_B}・資訊部`)
  await expect(page.getByRole('region', { name: '我的組別狀態' })).not.toContainText('和企業討論後')

  // 一般組組長：沒有連結表單。
  await signIn(page, generalLeader)
  await page.goto('/dashboard/student/groups')
  await expect(page.getByTestId('linked-opportunity')).toContainText('一般專題不連結合作案')
  await expect(page.locator('#industry-link').getByRole('button')).toHaveCount(0)
})

test('案主解除連結：理由必填，該組與案主收到通知；組員的頁面顯示還沒有連結', async ({ page }) => {
  await signIn(page, ownerB)
  await page.goto('/dashboard/teacher/industry')
  const item = page.getByTestId('managed-opportunity').filter({ hasText: COMPANY_B })
  await expect(item).toContainText(`${CODE}・G01`)
  await item.getByRole('button', { name: '解除連結：G01' }).click()
  const dialog = page.getByRole('dialog', { name: '解除 G01 的連結' })
  await dialog.getByRole('button', { name: '確認解除' }).click()
  await expect(dialog.getByRole('alert')).toContainText('解除連結一定要填理由')
  await dialog.getByLabel('理由（必填）').fill('企業暫停這個題目')
  await dialog.getByRole('button', { name: '確認解除' }).click()
  await expect(item.getByRole('status')).toContainText(`已解除 G01 與「${COMPANY_B}・資訊部」的連結`)
  expect(await recipientsOf('opportunity.unlinked', 'G01')).toEqual([sorted(...memberIds.get('G01')!, ownerB.userId)])

  await signIn(page, leader)
  await page.goto('/dashboard/student/groups')
  await expect(page.getByTestId('linked-opportunity')).toContainText('還沒有連結合作案')
  await expect(page.getByRole('list', { name: '組別異動' })).toContainText(`解除合作案連結：${COMPANY_B}・資訊部`)
  // 通知匣看得到（背景工作投影），點進去是合作案頁。
  await expect(async () => {
    await page.goto('/dashboard/student/inbox')
    await expect(page.getByRole('link', { name: `組別 G01 與「${COMPANY_B}・資訊部」的連結已解除` })).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 30_000 })
  await page.getByRole('link', { name: `組別 G01 與「${COMPANY_B}・資訊部」的連結已解除` }).click()
  await expect(page).toHaveURL(new RegExp(`/industry/${await opportunityId(COMPANY_B)}$`))
})

test('組長在成組期內、沒有指導老師與合作案時自己改組別類型；有指導老師後畫面說明原因、交系辦處理', async ({ page }) => {
  await signIn(page, generalLeader)
  await page.goto('/dashboard/student/groups')
  await expect(page.getByTestId('group-type')).toContainText('一般專題')
  await page.getByRole('button', { name: '改成產學合作' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'G02 的組別類型已從「一般專題」改成「產學合作」' })).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('group-type')).toContainText('產學合作')
  await expect(page.getByRole('list', { name: '組別異動' })).toContainText('組別類型 一般專題 → 產學合作')

  // 指派指導老師之後：組長不能自己改，畫面說明原因。
  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '抽籤')`,
    [groupIds.get('G02'), owner.userId, adminId],
  )
  await page.reload()
  await expect(page.getByTestId('type-change-blocked')).toContainText('已經有指導老師')
  await expect(page.getByTestId('type-change-blocked')).toContainText('請聯絡系辦處理')
  await expect(page.getByRole('button', { name: /改成/ })).toHaveCount(0)

  // 系辦處理：對話框列出保留的關聯，理由必填。
  await signInAdmin(page)
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const row = page.getByRole('region', { name: '全部組別' }).getByRole('row').filter({ hasText: 'G02' })
  await row.getByRole('button', { name: '改組別類型：G02' }).click()
  const dialog = page.getByRole('dialog', { name: '改 G02 的組別類型' })
  await expect(dialog.getByRole('region', { name: '改類型的影響' })).toContainText('指導老師：案主甲')
  await dialog.getByRole('button', { name: '確認改成一般專題' }).click()
  await expect(dialog.getByRole('alert')).toContainText('一定要填理由')
  await dialog.getByLabel('理由（必填）').fill('組長申請改回一般專題')
  await dialog.getByRole('button', { name: '確認改成一般專題' }).click()
  await expect(row.getByRole('status')).toContainText('保留：指導老師 案主甲')
})

test('管理員組別名單：篩選、排序、組員信箱欄與「複製本組信箱」；匯出 CSV／XLSX 帶登入信箱；老師與學生打匯出被拒', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL })
  await signInAdmin(page)
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const table = page.getByRole('region', { name: '全部組別' })
  await expect(page.getByTestId('roster-count')).toContainText('顯示 3／3 組')

  // 信箱欄：登入信箱（不限 gmail）。
  const g1 = table.getByRole('row').filter({ hasText: 'G01' })
  for (const email of memberEmails.get('G01')!) await expect(g1.getByRole('list', { name: 'G01 組員信箱' })).toContainText(email)
  await g1.getByRole('button', { name: '複製本組信箱：G01' }).click()
  await expect(g1.getByRole('status').filter({ hasText: '已複製 2 個信箱' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(memberEmails.get('G01')!.join(', '))

  // 篩選：只看產學組（G02 剛被改回一般）。
  const filter = page.getByRole('search', { name: '篩選組別' })
  await filter.getByLabel('類型').selectOption('industry')
  await filter.getByRole('button', { name: '套用' }).click()
  await expect(page.getByTestId('roster-count')).toContainText('顯示 2／3 組')
  await expect(table.getByTestId('roster-row')).toHaveCount(2)
  // 排序：組別代碼反向。
  await table.getByRole('link', { name: /組別/ }).click()
  await table.getByRole('link', { name: /組別/ }).click()
  await expect(page).toHaveURL(/dir=desc/)
  await expect(table.getByTestId('roster-row').first()).toHaveAttribute('data-code', 'G03')

  // 匯出篩選結果（CSV）：兩組、每位組員一列、帶登入信箱。
  const csvDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '匯出篩選結果（CSV）' }).click()
  const csvFile = await csvDownload
  expect(csvFile.suggestedFilename()).toMatch(new RegExp(`^組別名單-${CODE}-\\d{8}-\\d{4}\\.csv$`))
  const csv = await readFile((await csvFile.path())!, 'utf8')
  expect(csv.charCodeAt(0)).toBe(0xfeff)
  const lines = csv.slice(1).trim().split('\r\n')
  expect(lines).toHaveLength(1 + 4)
  expect(lines[0]).toContain('"登入信箱"')
  for (const email of [...memberEmails.get('G01')!, ...memberEmails.get('G03')!]) expect(csv).toContain(email)
  expect(csv).not.toContain(memberEmails.get('G02')![0]!)

  // 勾選一組匯出 XLSX：只有那一組，學號是文字。
  await table.getByRole('checkbox', { name: '勾選 G03' }).check()
  await expect(page.getByTestId('roster-count')).toContainText('已勾選 1 組')
  const xlsxDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '匯出勾選（XLSX）' }).click()
  const xlsxFile = await xlsxDownload
  expect(xlsxFile.suggestedFilename()).toMatch(/\.xlsx$/)
  const sheet = strFromU8(unzipSync(new Uint8Array(await readFile((await xlsxFile.path())!)))['xl/worksheets/sheet1.xml']!)
  for (const email of memberEmails.get('G03')!) expect(sheet).toContain(email)
  expect(sheet).not.toContain(memberEmails.get('G01')![0]!)
  expect(sheet).toMatch(/<c r="G2" t="inlineStr"><is><t xml:space="preserve">0412\d+<\/t><\/is><\/c>/)
  await expect(page.getByRole('status').filter({ hasText: '已匯出 1 組、2 位組員' })).toBeVisible()

  // 老師、學生直接打匯出網址：403；沒登入：401。
  for (const session of [owner, leader]) {
    const response = await page.request.post('/api/admin/groups/export', {
      headers: { cookie: session.cookie, origin: BASE_URL, 'content-type': 'application/json' },
      data: { cohortId, format: 'csv', kind: 'filter', filter: {} },
    })
    expect(response.status()).toBe(403)
    expect(await response.text()).not.toContain('@')
  }
  const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const response = await anonymous.post('/api/admin/groups/export', {
    headers: { origin: BASE_URL, 'content-type': 'application/json' },
    data: { cohortId, format: 'csv', kind: 'filter', filter: {} },
  })
  expect(response.status()).toBe(401)
  await anonymous.dispose()

  // 稽核：兩次匯出，只記範圍與筆數。
  const audits = await pool.query(`select payload from audit_events where action = 'group.export' and cohort_id = $1`, [cohortId])
  expect(audits.rows).toHaveLength(2)
})

test('老師與學生看不到組員登入信箱（只有管理員的名單有）', async ({ page }) => {
  await signIn(page, owner)
  await page.goto(`/dashboard/teacher/groups?cohort=${cohortId}`)
  await expect(page.getByRole('region', { name: '全部組別' })).toContainText('G01')
  expect(await page.content()).not.toContain(memberEmails.get('G01')![1]!)
  await signIn(page, leader)
  await page.goto('/dashboard/student/groups')
  expect(await page.content()).not.toContain(memberEmails.get('G01')![1]!)
})
