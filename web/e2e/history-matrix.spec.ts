import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 22（#233）：繳交歷史、老師繳交矩陣與下載授權。「做完的樣子」逐條走：
 *
 * 1. 全組、目前主指導、系辦看到同一份版本歷史；名單頁組別完成率（同組算一份）。
 * 2. 附件只有本組有效組員、目前主指導、系辦能下載；別組或換掉的老師被拒。
 * 3. 老師矩陣只列自己現在指導的組別與各項目的繳交狀態。
 * 4. 被移出的人只看得到自己還在組裡時的版本；個人回答老師預設看不到（系辦在名單頁開主指導閱覽才看得到）。
 *
 * 屆別、組別、主指導、收件項目用 owner 連線直接建成「已成立／已指派／已發布」的樣子（那些流程在票 13／15／19 的 spec 走過）；
 * 學生送出、老師看矩陣與版本、系辦開關主指導閱覽全程用真的畫面操作；換老師、移出組員用 owner 連線（票 14／19 的畫面另有 spec）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T22-${stamp}`
const G1 = `H1${stamp.slice(-4)}`
const G2 = `H2${stamp.slice(-4)}`
const ITEM_TITLE = `${CODE} 期中報告`
const PERSONAL_TITLE = `${CODE} 指導意向`

type Person = TestSession & { name: string }

let pool: Pool
let adminId: string
let cohortId: string
let stageId: string
let itemId: string
let personalId: string
let g1: string
let g2: string
let s1: Person
let s2: Person
let s6: Person
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

const GROUP_FIELDS = [
  { key: 'topic', type: 'text', label: '專題題目', required: true },
  { key: 'report', type: 'file', label: '期中報告', required: true, fileRules: { allowedTypes: ['pdf'], maxMiB: 1 } },
]
const PERSONAL_FIELDS = [{ key: 'wish', type: 'textarea', label: '想請老師注意的事', required: true }]

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'utf8')
const PDF_V3 = Buffer.from('%PDF-1.7\n% after removal\n%%EOF\n', 'utf8')

async function newSession(role: 'student' | 'teacher'): Promise<TestSession> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const session = await createTestSession(context, role)
  await context.dispose()
  return session
}

async function newStudent(i: number, name: string): Promise<Person> {
  const session = await newSession('student')
  const studentNo = `422${String(Date.now()).slice(-5)}${i}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [session.userId, name, studentNo, cohortId, `t22-${i}-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, session.userId])
  return { ...session, name }
}

async function assignAdvisor(groupId: string, teacherId: string) {
  // 重派＝結束舊列＋插新列（跟 pg-advisors 同一個形狀）。
  await pool.query(
    `update advisor_assignments set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2, end_reason = 'e2e 重派'
      where group_id = $1 and valid_to is null`,
    [groupId, adminId],
  )
  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $3, 'e2e 指派')`,
    [groupId, teacherId, adminId],
  )
}

async function newGroup(code: string, members: Person[], advisor: string): Promise<string> {
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
  await assignAdvisor(groupId, advisor)
  return groupId
}

/** 一份收件（草稿狀態）；`publish` 再把它變成已發布並展開名單。 */
async function newItem(title: string, unit: 'group' | 'individual', fields: unknown[]): Promise<string> {
  const item = await pool.query<{ id: string }>(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, due_at,
        title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
     values (gen_random_uuid(), $1, 'submission', 'cohort_students', $2, $3, 'draft', $4,
             $5, '票 22 e2e', '<p>請繳交。</p>', $6::jsonb, 'user', $7, $7)
     returning id`,
    [cohortId, unit, stageId, minute(10 * DAY), title, JSON.stringify({ fields }), adminId],
  )
  return item.rows[0]!.id
}

async function publish(id: string, title: string, fields: unknown[], receivers: { kind: 'user' | 'group'; id: string }[]) {
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '票 22 e2e', '<p>請繳交。</p>', $3) returning id`,
    [id, title, adminId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
    [id, JSON.stringify({ fields }), adminId],
  )
  await pool.query(
    `update managed_items set status = 'published', actual_opened_at = $4, current_content_version_id = $2, current_schema_version_id = $3
      where id = $1`,
    [id, content.rows[0]!.id, schema.rows[0]!.id, minute(-DAY)],
  )
  for (const r of receivers) {
    await pool.query(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, $3, $4, now(), 'auto', 'user', $5)`,
      [id, cohortId, r.kind, r.id, adminId],
    )
  }
}

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function versionFile(versionNo: number): Promise<string> {
  const found = await pool.query<{ file_id: string }>(
    `select sf.file_id from submission_files sf join submission_versions v on v.id = sf.submission_version_id
      where v.item_id = $1 and v.receiver_id = $2 and v.version_no = $3`,
    [itemId, g1, versionNo],
  )
  return found.rows[0]!.file_id
}

async function statusAs(page: Page, session: TestSession, url: string): Promise<number> {
  await signIn(page, session)
  return (await page.request.get(url)).status()
}

/** 版本表的每一列「第幾次＋送出者」（三個角色的表欄位順序不同，只比內容）。 */
async function versionRows(page: Page, tableName: string): Promise<string[]> {
  await expect(page.getByRole('table', { name: tableName })).toBeVisible()
  const rows = page.getByRole('table', { name: tableName }).locator('tbody tr')
  const out: string[] = []
  for (const row of await rows.all()) {
    const text = (await row.innerText()).replace(/\s+/g, ' ')
    const no = /第 (\d+) 次/.exec(text)?.[1]
    const who = ['組長一號', '組員二號'].find((n) => text.includes(n))
    out.push(`v${no}:${who}`)
  }
  return out
}

async function submitAs(page: Page, who: Person, topic: string, file?: { name: string; buffer: Buffer }) {
  await signIn(page, who)
  await page.goto(`/dashboard/student/affairs/${itemId}`)
  await page.getByLabel('專題題目').fill(topic)
  if (file) {
    await page.getByTestId('file-field-report').locator('input[type=file]').first().setInputFiles({ ...file, mimeType: 'application/pdf' })
    await expect(page.getByText(`「${file.name}」已上傳並附到草稿。`)).toBeVisible()
  }
  const button = page.getByRole('button', { name: /代表全組正式送出|重新送出/ })
  await button.click()
  await expect(page.getByTestId('receipt')).toBeVisible()
  await page.getByTestId('receipt').getByRole('button', { name: '關閉' }).click()
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
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e 票 22：回到真實時間')`,
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
  g1 = await newGroup(G1, [s1, s2], t1.userId)
  g2 = await newGroup(G2, [s6], t3.userId)
  itemId = await newItem(ITEM_TITLE, 'group', GROUP_FIELDS)
  await publish(itemId, ITEM_TITLE, GROUP_FIELDS, [
    { kind: 'group', id: g1 },
    { kind: 'group', id: g2 },
  ])
  personalId = await newItem(PERSONAL_TITLE, 'individual', PERSONAL_FIELDS)
})

test.afterAll(async () => {
  await pool?.end()
})

test('1. 全組、目前主指導、系辦看到同一份版本歷史；名單頁組別完成率同組算一份', async ({ page }) => {
  await submitAs(page, s1, '智慧校園導覽', { name: '期中報告.pdf', buffer: PDF })
  await submitAs(page, s2, '智慧校園導覽 2.0')

  // 組員：繳交歷史。
  await signIn(page, s2)
  await page.goto(`/dashboard/student/affairs/${itemId}?tab=history`)
  const byStudent = await versionRows(page, '繳交歷史')
  expect(byStudent).toEqual(['v2:組員二號', 'v1:組長一號'])

  // 目前主指導：矩陣 → 點 G1 的格子 → 同一份版本。
  await signIn(page, t1)
  await page.goto('/dashboard/teacher/affairs')
  const row = page.getByTestId(`matrix-row-${G1}`)
  await expect(row).toContainText('已繳 v2')
  await row.getByTestId('matrix-cell').first().click()
  await expect(page.getByTestId('receiver-view')).toContainText(`${G1} 組`)
  expect(await versionRows(page, '正式送出的版本')).toEqual(byStudent)
  await page.getByRole('link', { name: '查看內容' }).last().click()
  const v1 = page.getByTestId('version-view')
  await expect(v1).toContainText('智慧校園導覽')
  await expect(v1.getByRole('link', { name: '期中報告.pdf' })).toBeVisible()

  // 系辦：名單頁同一份；兩組只有 G1 交 → 1／2（G1 送兩次也只算一份）。
  await signIn(page, admin)
  await page.goto(`/dashboard/admin/affairs/${itemId}`)
  await expect(page.getByTestId('completion-rate')).toHaveText('1／2')
  await page.getByRole('link', { name: `查看 ${G1} 組的繳交` }).click()
  expect(await versionRows(page, '正式送出的版本')).toEqual(byStudent)
})

test('2＋3. 下載授權逐角色；矩陣只列自己目前指導的組；換老師後舊老師 404／403、新老師接手', async ({ page }) => {
  const url = `/api/files/${await versionFile(1)}`
  expect(await statusAs(page, s1, url)).toBe(200)
  expect(await statusAs(page, s2, url)).toBe(200)
  expect(await statusAs(page, t1, url)).toBe(200)
  expect(await statusAs(page, admin, url)).toBe(200)
  expect(await statusAs(page, s6, url)).toBe(403)
  expect(await statusAs(page, t3, url)).toBe(403)

  // T3 此刻只指導 G2：矩陣沒有 G1，直接打 G1 的網址 404。
  await signIn(page, t3)
  await page.goto('/dashboard/teacher/affairs')
  await expect(page.getByTestId(`matrix-row-${G2}`)).toContainText('未繳')
  await expect(page.getByTestId(`matrix-row-${G1}`)).toHaveCount(0)
  expect((await page.goto(`/dashboard/teacher/affairs/${itemId}?group=${g1}`))?.status()).toBe(404)

  // 系辦把 G1 改派給 T3：T1 立刻失去 G1（矩陣、版本頁、附件），T3 接手。
  await assignAdvisor(g1, t3.userId)
  await signIn(page, t1)
  await page.goto('/dashboard/teacher/affairs')
  await expect(page.getByTestId(`matrix-row-${G1}`)).toHaveCount(0)
  expect((await page.goto(`/dashboard/teacher/affairs/${itemId}?group=${g1}&version=1`))?.status()).toBe(404)
  expect((await page.request.get(url)).status()).toBe(403)

  await signIn(page, t3)
  await page.goto('/dashboard/teacher/affairs')
  await expect(page.getByTestId(`matrix-row-${G1}`)).toContainText('已繳 v2')
  expect((await page.request.get(url)).status()).toBe(200)
})

test('4. 被移出的人只看得到自己還在組裡時的版本（移出後的 v3 與附件都拿不到）', async ({ page }) => {
  await pool.query(
    `update group_memberships set valid_to = now(), removal_reason = 'e2e 轉組' where group_id = $1 and user_id = $2 and valid_to is null`,
    [g1, s2.userId],
  )
  await submitAs(page, s1, '移出之後的版本', { name: '期中報告-v3.pdf', buffer: PDF_V3 })

  await signIn(page, s2)
  await page.goto('/dashboard/student/affairs')
  await expect(page.getByTestId(`affair-${itemId}`)).toHaveCount(0)
  const records = page.getByTestId('my-records')
  await expect(records).toContainText(ITEM_TITLE)
  await expect(records).toContainText('你看得到 2 個版本')
  await records.getByRole('link', { name: '查看紀錄' }).click()
  await expect(page.getByTestId('record-banner')).toContainText('只看得到你還在組裡時送出的版本')
  expect(await versionRows(page, '繳交紀錄')).toEqual(['v2:組員二號', 'v1:組長一號'])
  await page.getByRole('link', { name: '查看內容' }).last().click()
  await expect(page.getByTestId('version-view').getByRole('link', { name: '期中報告.pdf' })).toBeVisible()

  expect((await page.goto(`/dashboard/student/affairs/${itemId}`))?.status()).toBe(404)
  expect((await page.goto(`/dashboard/student/affairs/${itemId}?record=${g1}&version=3`))?.status()).toBe(404)
  expect((await page.request.get(`/api/files/${await versionFile(1)}`)).status()).toBe(200)
  expect((await page.request.get(`/api/files/${await versionFile(3)}`)).status()).toBe(403)
  // 還在組裡的人看得到全部三版；別組的人連紀錄頁都 404。
  expect(await statusAs(page, s1, `/api/files/${await versionFile(3)}`)).toBe(200)
  await signIn(page, s6)
  expect((await page.goto(`/dashboard/student/affairs/${itemId}?record=${g1}`))?.status()).toBe(404)
})

test('4. 個人回答：老師預設看不到；系辦在名單頁開主指導閱覽後，學生看到告知、目前主指導看得到正式版本', async ({ page }) => {
  // 系辦：發布前在名單頁開主指導閱覽（有確認對話框與結果回饋）。
  await signIn(page, admin)
  await page.goto(`/dashboard/admin/affairs/${personalId}`)
  const panel = page.getByTestId('visibility-panel')
  await expect(panel.getByTestId('visibility-state')).toHaveText('不開放')
  await panel.getByRole('button', { name: '開放主指導閱覽' }).click()
  const dialog = page.getByRole('dialog', { name: '開放主指導閱覽' })
  await expect(dialog).toContainText('學生填寫頁會先出現')
  await dialog.getByRole('button', { name: '確定開放' }).click()
  const opened = page.locator('dialog[open]')
  await expect(opened.getByRole('status')).toContainText('已開放')
  await opened.getByRole('button', { name: '關閉', exact: true }).click()
  await expect(panel.getByTestId('visibility-state')).toContainText('開放中')

  await publish(personalId, PERSONAL_TITLE, PERSONAL_FIELDS, [
    { kind: 'user', id: s1.userId },
    { kind: 'user', id: s2.userId },
  ])

  // 學生填寫前看到告知，送出。
  await signIn(page, s1)
  await page.goto(`/dashboard/student/affairs/${personalId}`)
  await expect(page.getByTestId('advisor-notice')).toContainText('正式送出')
  await page.getByLabel('想請老師注意的事').fill('希望每兩週見一次面')
  await page.getByRole('button', { name: '正式送出' }).click()
  await expect(page.getByTestId('receipt')).toBeVisible()

  // S1 所在的 G1 此刻的主指導是 T3（上一個測試改派）：T3 看得到，T1 看不到。
  await signIn(page, t3)
  await page.goto('/dashboard/teacher/affairs')
  const list = page.getByTestId('individual-items')
  await expect(list).toContainText(PERSONAL_TITLE)
  await expect(list).toContainText('已繳 1／1 位')
  await list.getByRole('link', { name: '查看' }).first().click()
  await page.getByRole('link', { name: '查看 組長一號 的繳交' }).click()
  await page.getByRole('link', { name: '查看內容' }).first().click()
  await expect(page.getByTestId('version-view')).toContainText('希望每兩週見一次面')

  await signIn(page, t1)
  expect((await page.goto(`/dashboard/teacher/affairs/${personalId}?person=${s1.userId}&version=1`))?.status()).toBe(404)

  // 系辦關掉：老師馬上看不到；已經有人作答，不能再開（按鈕停用並說明原因）。
  await signIn(page, admin)
  await page.goto(`/dashboard/admin/affairs/${personalId}`)
  await panel.getByRole('button', { name: '關閉主指導閱覽' }).click()
  await page.getByRole('dialog', { name: '關閉主指導閱覽' }).getByRole('button', { name: '確定關閉' }).click()
  const closed = page.locator('dialog[open]')
  await expect(closed.getByRole('status')).toContainText('已關閉')
  await closed.getByRole('button', { name: '關閉', exact: true }).click()
  await expect(panel.getByTestId('visibility-state')).toHaveText('不開放')
  await expect(panel.getByTestId('visibility-blocked')).toContainText('已經有人作答')
  await expect(panel.getByRole('button', { name: '開放主指導閱覽' })).toBeDisabled()

  await signIn(page, t3)
  expect((await page.goto(`/dashboard/teacher/affairs/${personalId}?person=${s1.userId}&version=1`))?.status()).toBe(404)
})
