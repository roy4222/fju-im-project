import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 第三波 W12（AC-40）：收件可一鍵套用「專題需求表」欄位。
 *
 * 1. 系辦在完整編輯器建收件，按「套用專題需求表欄位」：出現 7 個欄位，收件單位預設「整組一份」；再按一次不會多一份。
 * 2. 發布後組長填妥五個必填（指導老師、組長、專題名稱（英文）、開發軟體、硬體需求），中文名稱與其他硬體留空，可以送出。
 * 3. 五個必填任一欄留空送出都被拒，並指出是哪一欄。
 *
 * 屆別、組別用 owner 連線直接建；系辦與學生全程用真的畫面操作，資料庫核對用 owner 連線。業務鐘拉回真實時間。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `W12-${stamp}`
const GROUP = `R${stamp.slice(-4)}`
const TITLE = `${CODE} 專題需求表`
const DAY = 86_400_000

const REQUIRED = ['指導老師', '組長', '專題名稱（英文）', '開發軟體', '硬體需求'] as const
const OPTIONAL = ['專題名稱（中文）', '其他硬體'] as const
const ANSWER: Record<(typeof REQUIRED)[number], string> = {
  指導老師: '示範老師',
  組長: '需求表組長',
  '專題名稱（英文）': 'Campus Guide',
  開發軟體: 'VS Code、Android Studio',
  硬體需求: '無',
}

let pool: Pool
let cohortId: string
let leader: TestSession
let member: TestSession
let itemId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

/** `datetime-local` 用的臺灣時間。 */
function localMinute(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16)
}

async function newStudent(i: number): Promise<TestSession> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const session = await createTestSession(context, 'student')
  await context.dispose()
  const studentNo = `412${String(Date.now()).slice(-5)}${i}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [session.userId, `需求表學生${i}`, studentNo, cohortId, `w12-${i}-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, session.userId])
  return session
}

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

/** 學生表單的欄位：標籤開頭是欄名（後面可能接必填星號或說明）。 */
function answerBox(page: Page, label: string) {
  return page.getByRole('textbox', { name: new RegExp(`^${label}`) })
}

async function versions() {
  return (
    await pool.query<{ answers: Record<string, string> }>(
      `select answers from submission_versions where item_id = $1 and receiver_kind = 'group' order by version_no`,
      [itemId],
    )
  ).rows
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e W12：回到真實時間')`,
    [admin.userId],
  )
  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
      [CODE, ymd(new Date(Date.now() + 300 * DAY))],
    )
  ).rows[0]!.id
  await pool.query(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '成組期', $2, 'system')`,
    [cohortId, ymd(new Date(Date.now() - 10 * DAY))],
  )

  leader = await newStudent(1)
  member = await newStudent(2)
  const groupId = (
    await pool.query<{ id: string }>(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
      [cohortId, GROUP],
    )
  ).rows[0]!.id
  for (const m of [leader, member]) {
    await pool.query(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [groupId, cohortId, m.userId],
    )
  }
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now(), $2)`,
    [groupId, leader.userId],
  )
})

test.afterAll(async () => {
  await pool?.end()
})

test('系辦建收件：按「套用專題需求表欄位」出現 7 個欄位、收件單位預設整組一份；再按一次不重複；發布', async ({ page }) => {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.getByLabel('標題', { exact: true }).fill(TITLE)
  await page.getByLabel('正文').fill('請組長填寫專題需求表。')
  await page.getByLabel('顯示在哪一區', { exact: true }).selectOption('submission')
  // 先選個人一份，證明套用範本會改回整組一份。
  await page.getByRole('radio', { name: '個人一份', exact: true }).check()

  const fields = page.locator('section[aria-labelledby="sec-fields"]')
  await page.getByRole('button', { name: '套用專題需求表欄位' }).click()
  await expect(fields.locator('li[data-field-type]')).toHaveCount(7)
  for (const label of [...REQUIRED, ...OPTIONAL]) {
    await expect(fields.getByRole('button', { name: `編輯欄位：${label}`, exact: true })).toBeVisible()
  }
  await expect(page.getByTestId('template-note')).toContainText('已加入 7 個欄位')
  await expect(page.getByRole('radio', { name: '整組一份', exact: true })).toBeChecked()

  await page.getByRole('button', { name: '套用專題需求表欄位' }).click()
  await expect(fields.locator('li[data-field-type]')).toHaveCount(7)
  await expect(page.getByTestId('template-note')).toContainText('沒有重複加入')

  await page.getByLabel('誰看得到').selectOption('groups')
  await page.getByRole('checkbox', { name: new RegExp(GROUP) }).check()
  await page.getByLabel('所屬階段').selectOption({ index: 1 })
  await page.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(new Date(Date.now() + 20 * DAY)))

  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await expect(check.locator('[data-ok="no"]')).toHaveCount(0)
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toContainText('需要繳交的名單 1 組')

  const item = await pool.query<{ id: string; receiver_unit: string; draft_schema: { fields: { key: string; label: string; required: boolean }[] } }>(
    `select id, receiver_unit, draft_schema from managed_items where cohort_id = $1 and title = $2`,
    [cohortId, TITLE],
  )
  expect(item.rows).toHaveLength(1)
  itemId = item.rows[0]!.id
  expect(item.rows[0]!.receiver_unit).toBe('group')
  expect(item.rows[0]!.draft_schema.fields.map((f) => [f.label, f.required])).toEqual([
    ['指導老師', true],
    ['組長', true],
    ['專題名稱（英文）', true],
    ['專題名稱（中文）', false],
    ['開發軟體', true],
    ['硬體需求', true],
    ['其他硬體', false],
  ])
})

test('組長：五個必填任一欄留空送出都被拒並指出是哪一欄；填妥五欄、兩個選填留空可以送出', async ({ page }) => {
  await signIn(page, leader)
  await page.goto(`/dashboard/student/affairs/${itemId}`)
  const submit = page.getByRole('button', { name: '代表全組正式送出' })

  for (const blank of REQUIRED) {
    for (const label of REQUIRED) await answerBox(page, label).fill(label === blank ? '' : ANSWER[label])
    await submit.click()
    await expect(page.getByRole('alert').filter({ hasText: `請填寫「${blank}」` })).toBeVisible()
    await expect(answerBox(page, blank)).toHaveAttribute('aria-invalid', 'true')
    expect(await versions(), `${blank} 留空不能送出`).toHaveLength(0)
  }

  for (const label of REQUIRED) await answerBox(page, label).fill(ANSWER[label])
  for (const label of OPTIONAL) await expect(answerBox(page, label)).toHaveValue('')
  await submit.click()
  const receipt = page.getByTestId('receipt')
  await expect(receipt).toBeVisible()
  await expect(receipt).toContainText('已送出')

  const rows = await versions()
  expect(rows).toHaveLength(1)
  expect(rows[0]!.answers).toMatchObject({
    advisor: ANSWER['指導老師'],
    leader: ANSWER['組長'],
    title_en: ANSWER['專題名稱（英文）'],
    software: ANSWER['開發軟體'],
    hardware: ANSWER['硬體需求'],
  })
  expect(rows[0]!.answers.title_zh ?? '').toBe('')
  expect(rows[0]!.answers.hardware_other ?? '').toBe('')
})
