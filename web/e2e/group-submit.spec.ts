import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 21（#232）：組別共用草稿、上傳與正式送出。「做完的樣子」逐條走：
 *
 * 1. 同組任一人儲存草稿，其他人打開看到同一份；兩人同時改會被要求重新載入。
 * 2. 組員上傳附件並附到草稿：合法檔案收、偽裝副檔名與超過上限的擋、中斷的殘留留給回收（中斷在整合測試用斷線串流證明）。
 * 3. 任一組員代表全組正式送出，拿到收件章回執，其他有效組員收到通知；未成組不能送出。
 * 4. 截止前可重送新版本，第 1 版不動。
 * 另外：附件下載只有本組有效組員、目前主指導、系辦拿得到；名單頁的組別完成率以組為單位。
 *
 * 組別、主指導、收件項目用 owner 連線直接建成「已成立／已指派／已發布」的樣子（那些流程在票 13／19／15 的 spec 走過）；
 * 學生這邊全程用真的畫面操作（含真的上傳），資料庫核對用 owner 連線。業務鐘拉回真實時間。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T21-${stamp}`
const G1 = `G1${stamp.slice(-4)}`
const G2 = `G2${stamp.slice(-4)}`

type Person = TestSession & { name: string }

let pool: Pool
let adminId: string
let cohortId: string
let stageId: string
let itemId: string
let g1: string
let s1: Person
let s2: Person
let s6: Person
let s9: Person
let t1: TestSession
let t3: TestSession
let admin: TestSession

const DAY = 86_400_000

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function minute(offsetMs: number): Date {
  return new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000)
}

const FIELDS = [
  { key: 'topic', type: 'text', label: '專題題目', required: true },
  { key: 'report', type: 'file', label: '期中報告', required: true, fileRules: { allowedTypes: ['pdf'], maxMiB: 1 } },
]

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'utf8')
const PDF_V2 = Buffer.from('%PDF-1.7\n% second version\n%%EOF\n', 'utf8')
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff])

async function newSession(role: 'student' | 'teacher'): Promise<TestSession> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const session = await createTestSession(context, role)
  await context.dispose()
  return session
}

async function newStudent(i: number, name: string): Promise<Person> {
  const session = await newSession('student')
  const studentNo = `421${String(Date.now()).slice(-5)}${i}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [session.userId, name, studentNo, cohortId, `t21-${i}-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, session.userId])
  return { ...session, name }
}

async function newGroup(code: string, members: Person[], advisor?: string): Promise<string> {
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortId, code],
  )
  const groupId = group.rows[0]!.id
  for (const m of members) {
    await pool.query(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [groupId, cohortId, m.userId],
    )
  }
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now(), $2)`,
    [groupId, members[0]!.userId],
  )
  if (advisor) {
    await pool.query(
      `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
       values (gen_random_uuid(), $1, $2, 'admin', now(), $3, 'e2e 指派')`,
      [groupId, advisor, adminId],
    )
  }
  return groupId
}

/** 一份已發布的整組收件（內容版本、欄位版本、兩組的名單）。 */
async function publishedGroupItem(title: string, groupIds: readonly string[]): Promise<string> {
  const item = await pool.query<{ id: string }>(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, actual_opened_at, due_at,
        title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
     values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'group', $7, 'draft', $2, $3,
             $4, '上傳期中報告', '<p>請整組上傳一份 PDF。</p>', $5::jsonb, 'user', $6, $6)
     returning id`,
    [cohortId, minute(-DAY), minute(10 * DAY), title, JSON.stringify({ fields: FIELDS }), adminId, stageId],
  )
  const id = item.rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '上傳期中報告', '<p>請整組上傳一份 PDF。</p>', $3) returning id`,
    [id, title, adminId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
    [id, JSON.stringify({ fields: FIELDS }), adminId],
  )
  await pool.query(
    `update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`,
    [id, content.rows[0]!.id, schema.rows[0]!.id],
  )
  for (const groupId of groupIds) {
    await pool.query(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, 'group', $3, now(), 'auto', 'user', $4)`,
      [id, cohortId, groupId, adminId],
    )
  }
  return id
}

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

const itemPath = () => `/dashboard/student/affairs/${itemId}`

async function versions() {
  return (
    await pool.query<{ id: string; version_no: number; submitted_by_user_id: string; membership_snapshot: string[]; advisor_snapshot: { teacherUserId: string | null } }>(
      `select id, version_no, submitted_by_user_id, membership_snapshot, advisor_snapshot from submission_versions
        where item_id = $1 and receiver_kind = 'group' and receiver_id = $2 order by version_no`,
      [itemId, g1],
    )
  ).rows
}

async function draftFileId(): Promise<string> {
  const row = await pool.query<{ answers: Record<string, string> }>(
    `select answers from submission_drafts where item_id = $1 and receiver_kind = 'group' and receiver_id = $2`,
    [itemId, g1],
  )
  return row.rows[0]!.answers.report!
}

function reportInput(page: Page) {
  return page.getByTestId('file-field-report').locator('input[type=file]').first()
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  adminId = admin.userId
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e 票 21：回到真實時間')`,
    [adminId],
  )
  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
      [CODE, ymd(new Date(Date.now() + 300 * DAY))],
    )
  ).rows[0]!.id
  stageId = (
    await pool.query<{ id: string }>(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, 1, '期中', $2, 'system') returning id`,
      [cohortId, ymd(new Date(Date.now() - 30 * DAY))],
    )
  ).rows[0]!.id

  t1 = await newSession('teacher')
  t3 = await newSession('teacher')
  s1 = await newStudent(1, '組長一號')
  s2 = await newStudent(2, '組員二號')
  s6 = await newStudent(6, '別組六號')
  s9 = await newStudent(9, '沒組九號')
  g1 = await newGroup(G1, [s1, s2], t1.userId)
  const g2 = await newGroup(G2, [s6])
  itemId = await publishedGroupItem(`${CODE} 期中報告`, [g1, g2])
})

test.afterAll(async () => {
  await pool?.end()
})

test('1. 同組任一人存草稿，另一位打開看到同一份；未成組的人看不到這份收件', async ({ page }) => {
  await signIn(page, s1)
  await page.goto('/dashboard/student/affairs')
  const row = page.getByTestId(`affair-${itemId}`)
  await expect(row).toContainText(`整組一份（${G1}）`)
  await row.getByRole('link', { name: `${CODE} 期中報告` }).click()
  await expect(page.getByTestId('group-bar')).toContainText(G1)
  await expect(page.getByTestId('group-bar')).toContainText('組長 組長一號')
  await expect(page.getByTestId('group-bar')).toContainText('指導老師')

  await page.getByLabel('專題題目').fill('智慧校園導覽')
  await page.getByRole('button', { name: '儲存草稿' }).click()
  await expect(page.getByText('共用草稿已存到伺服器；同組的人打開會看到同一份。')).toBeVisible()

  await signIn(page, s2)
  await page.goto(itemPath())
  await expect(page.getByLabel('專題題目')).toHaveValue('智慧校園導覽')
  await expect(page.getByTestId('draft-updated-by')).toContainText('組長一號')

  // 沒有組別：作業區不列，直接打網址 404。
  await signIn(page, s9)
  await page.goto('/dashboard/student/affairs')
  await expect(page.getByText(`${CODE} 期中報告`)).toHaveCount(0)
  expect((await page.goto(itemPath()))?.status()).toBe(404)
})

test('1. 兩位組員同時改：後存的那一位被要求重新載入，先存的內容沒有被蓋掉', async ({ browser }) => {
  const a = await (await browser.newContext({ baseURL: BASE_URL })).newPage()
  const b = await (await browser.newContext({ baseURL: BASE_URL })).newPage()
  await signIn(a, s1)
  await signIn(b, s2)
  await a.goto(itemPath())
  await b.goto(itemPath())

  await b.getByLabel('專題題目').fill('組員二號的題目')
  await b.getByRole('button', { name: '儲存草稿' }).click()
  await expect(b.getByTestId('save-status')).toContainText('已儲存')

  await a.getByLabel('專題題目').fill('組長一號的舊題目')
  await a.getByRole('button', { name: '儲存草稿' }).click()
  await expect(a.getByText(/這份共用草稿剛剛被組員存過了/)).toBeVisible()
  await expect(a.getByRole('button', { name: '重新載入' })).toBeVisible()

  await a.getByRole('button', { name: '重新載入' }).click()
  await expect(a.getByLabel('專題題目')).toHaveValue('組員二號的題目')
  await a.context().close()
  await b.context().close()
})

test('2. 上傳：偽裝副檔名與超過上限被擋、不會顯示成已附上；合法 PDF 顯示進度後附到共用草稿', async ({ page }) => {
  await signIn(page, s1)
  await page.goto(itemPath())

  await reportInput(page).setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: EXE })
  await expect(page.getByTestId('upload-error-report')).toContainText('檔案內容與副檔名不符')
  await expect(page.getByTestId('file-field-report').getByRole('link')).toHaveCount(0)

  const big = Buffer.alloc(1024 * 1024 + 10, 0x20)
  PDF.copy(big)
  await reportInput(page).setInputFiles({ name: 'big.pdf', mimeType: 'application/pdf', buffer: big })
  await expect(page.getByTestId('upload-error-report')).toContainText('超過上限')

  await reportInput(page).setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PDF })
  await expect(page.getByTestId('upload-error-report')).toContainText('只接受 .pdf')

  await reportInput(page).setInputFiles({ name: '期中報告.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(page.getByText('「期中報告.pdf」已上傳並附到草稿。')).toBeVisible()
  await expect(page.getByTestId('file-field-report').getByRole('link', { name: '期中報告.pdf' })).toBeVisible()
  const fileId = await draftFileId()
  expect((await pool.query(`select status from stored_files where id = $1`, [fileId])).rows[0]!.status).toBe('stored')

  // 被擋下的三個檔都沒有附到任何地方：偽裝檔傳完才被內容檢查擋下，列留在 uploading 給回收；
  // 超量與副檔名不對的在發 ticket 時就擋，不建列。
  const rejected = await pool.query<{ status: string; n: string }>(
    `select status, count(*) as n from stored_files where owner_user_id = $1 and purpose = 'submission' group by status order by status`,
    [s1.userId],
  )
  expect(rejected.rows).toEqual([
    { status: 'stored', n: '1' },
    { status: 'uploading', n: '1' },
  ])

  // 另一位組員打開看到同一個附件，也下載得到。
  await signIn(page, s2)
  await page.goto(itemPath())
  const link = page.getByTestId('file-field-report').getByRole('link', { name: '期中報告.pdf' })
  await expect(link).toBeVisible()
  const response = await page.request.get(`/api/files/${fileId}`)
  expect(response.status()).toBe(200)
  expect((await response.body()).equals(PDF)).toBe(true)
})

test('3. 任一組員代表全組送出：收件章回執、另一位組員收到通知、全組同步已繳；連點只算一次', async ({ page }) => {
  await signIn(page, s2)
  await page.goto(itemPath())
  await expect(page.getByLabel('專題題目')).toHaveValue('組員二號的題目')
  await page.getByRole('button', { name: '代表全組正式送出' }).dblclick()

  const receipt = page.getByTestId('receipt')
  await expect(receipt).toBeVisible()
  await expect(receipt).toContainText('已收件')
  await expect(receipt).toContainText('v1')
  await expect(receipt).toContainText(`組員二號（代表 ${G1} 全組）`)
  await expect(receipt).toContainText('期中報告.pdf')
  await expect(receipt).toContainText('其他組員會收到一則通知')

  const rows = await versions()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ version_no: 1, submitted_by_user_id: s2.userId, advisor_snapshot: { teacherUserId: t1.userId } })
  expect([...rows[0]!.membership_snapshot].sort()).toEqual([s1.userId, s2.userId].sort())
  const events = await pool.query<{ recipients: string[] }>(
    `select recipients from domain_events where type = 'submission.submitted' and source_id = $1`,
    [itemId],
  )
  expect(events.rows).toEqual([{ recipients: [s1.userId] }])

  await receipt.getByRole('button', { name: '關閉' }).click()
  await expect(page.getByTestId('affair-banner')).toContainText('已繳 v1')

  // 另一位組員：作業區同步打勾、通知匣有一則（背景工作投影）。
  await signIn(page, s1)
  await page.goto('/dashboard/student/affairs')
  await expect(page.getByTestId(`affair-${itemId}`)).toContainText('已繳 v1')
  await expect
    .poll(
      async () =>
        (await pool.query(`select count(*) as n from notifications where recipient_user_id = $1 and source_ref->>'id' = $2`, [s1.userId, itemId]))
          .rows[0]!.n,
      { timeout: 45_000 },
    )
    .toBe('1')
  await page.goto('/dashboard/student/inbox')
  await expect(page.getByText(`組員二號 代表 ${G1} 組正式送出了「${CODE} 期中報告」（第 1 次）`)).toBeVisible()
})

test('4. 截止前換檔重送：第 2 版採計，第 1 版的附件與 checksum 不動、仍下載得到', async ({ page }) => {
  const [v1] = await versions()
  const v1Files = (await pool.query(`select file_id, checksum from submission_files where submission_version_id = $1`, [v1!.id])).rows

  await signIn(page, s1)
  await page.goto(itemPath())
  await page.getByTestId('file-field-report').locator('input[type=file]').setInputFiles({ name: '期中報告-修正.pdf', mimeType: 'application/pdf', buffer: PDF_V2 })
  await expect(page.getByText('「期中報告-修正.pdf」已上傳並附到草稿。')).toBeVisible()
  await page.getByRole('button', { name: '重新送出' }).click()
  await expect(page.getByTestId('receipt')).toContainText('v2')
  await expect(page.getByTestId('receipt')).toContainText('組長一號（代表')

  const rows = await versions()
  expect(rows.map((r) => r.version_no)).toEqual([1, 2])
  expect((await pool.query(`select file_id, checksum from submission_files where submission_version_id = $1`, [v1!.id])).rows).toEqual(v1Files)

  await page.getByTestId('receipt').getByRole('button', { name: '關閉' }).click()
  await page.goto(`${itemPath()}?tab=history`)
  await expect(page.getByRole('table', { name: '繳交歷史' })).toContainText('組員二號')
  await page.goto(`${itemPath()}?tab=history&version=1`)
  const old = page.getByTestId('version-view')
  await expect(old).toContainText('已被後來的版本取代')
  await expect(old.getByRole('link', { name: '期中報告.pdf' })).toBeVisible()
  expect((await page.request.get(`/api/files/${v1Files[0]!.file_id}`)).status()).toBe(200)
})

test('下載授權：本組組員、目前主指導、系辦拿得到；別組、其他老師 403，沒登入 401', async ({ page, playwright }) => {
  const [v1] = await versions()
  const fileId = (await pool.query<{ file_id: string }>(`select file_id from submission_files where submission_version_id = $1`, [v1!.id])).rows[0]!.file_id
  const url = `/api/files/${fileId}`

  const statusAs = async (session: TestSession) => {
    await signIn(page, session)
    return (await page.request.get(url)).status()
  }
  expect(await statusAs(s2)).toBe(200)
  expect(await statusAs(t1)).toBe(200)
  expect(await statusAs(admin)).toBe(200)
  expect(await statusAs(s6)).toBe(403)
  expect(await statusAs(t3)).toBe(403)
  expect(await statusAs(s9)).toBe(403)
  const anonymous = await playwright.request.newContext({ baseURL: BASE_URL })
  expect((await anonymous.get(url)).status()).toBe(401)
  await anonymous.dispose()
})

test('名單頁：整組一份的完成率以組為單位（同組送兩次也只算一份）；點進組別看得到版本與附件', async ({ page }) => {
  await signIn(page, admin)
  await page.goto(`/dashboard/admin/affairs/${itemId}`)
  await expect(page.getByTestId('completion-rate')).toHaveText('1／2')
  await expect(page.getByTestId('completion')).toContainText('已正式送出／應交組數')
  await page.getByRole('link', { name: `查看 ${G1} 組的繳交` }).click()
  await expect(page.getByTestId('receiver-view')).toContainText('正式送出的版本（2）')
  await page.getByRole('link', { name: '看回答' }).last().click()
  await expect(page.getByTestId('version-view').getByRole('link', { name: '期中報告.pdf' })).toBeVisible()
})
