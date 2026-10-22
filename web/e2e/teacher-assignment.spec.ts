import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * C 階段規格① §5.1、§5.3（C1-10）：老師「作業區 › 我的作業」與學生「交作業」同一套畫面。
 *
 * - AC-20：系辦發給老師的作業 → 名單上的老師在「我的作業」看到它 → 開 → 寫作業 → 上傳 → 繳交作業 → 繳交歷史一列、
 *   繳交人是老師本人（頭像＋姓名）；系辦名單頁該老師列變已繳；**不在名單上**的老師直接打開該作業網址 → 403。
 * - AC-24（學生面）：「下載 PDF 再上傳」的同意書（`consent_mode='upload'`）在學生清單形式寫「同意書」，流程同一般作業。
 * - 老師作業區分頁：預設「我的作業」；「指導組別的繳交」切到別屆再切回進行中的屆別仍停在那個分頁（屆別下拉）。
 *
 * 作業、名單、屆別用 owner 連線直接建成「已發布」的樣子（發布流程由 affairs.spec 走過；老師收件名單由 C1-02 整合測試證明）；
 * 老師與學生這邊全程用真的畫面操作（含真的上傳），資料庫核對用 owner 連線。業務鐘拉回真實時間。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `C110-${stamp}`
const TEACHER_ITEM = `${CODE} 指導老師期初資料`
const CONSENT_ITEM = `${CODE} 個資同意書（簽名上傳）`
const DAY = 86_400_000

type Person = TestSession & { name: string }

let pool: Pool
let adminId: string
let admin: TestSession
let cohortId: string
let teacherItemId: string
let consentItemId: string
let onRoster: Person
let offRoster: Person
let student: Person

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'utf8')

const TEACHER_FIELDS = [{ key: 'cv', type: 'file', label: '個人簡歷', required: true, fileRules: { allowedTypes: ['pdf'], maxMiB: 20 } }]
const CONSENT_FIELDS = [
  { key: 'signed', type: 'file', label: '簽好的同意書', required: true, fileRules: { allowedTypes: ['pdf', 'jpg', 'png'], maxMiB: 20 } },
]

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function minute(offsetMs: number): Date {
  return new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000)
}

async function newPerson(role: 'student' | 'teacher', name: string, avatarPreset: number | null): Promise<Person> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const session = await createTestSession(context, role)
  await context.dispose()
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email, avatar_preset, cohort_id)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set display_name = excluded.display_name, avatar_preset = excluded.avatar_preset,
       cohort_id = excluded.cohort_id`,
    [session.userId, name, `c110-${session.userId.slice(-6)}@contact.example.com`, avatarPreset, role === 'student' ? cohortId : null],
  )
  return { ...session, name }
}

/** 一份已發布的個人收件（內容版本、欄位版本、名單）。 */
async function publishedItem(options: {
  title: string
  audience: 'teachers' | 'cohort_students'
  consentMode: 'upload' | null
  fields: readonly object[]
  roster: readonly string[]
}): Promise<string> {
  const item = await pool.query<{ id: string }>(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, consent_mode, status, actual_opened_at, due_at,
        title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
     values (gen_random_uuid(), $1, 'submission', $2, 'individual', $3, 'draft', $4, $5,
             $6, '一句話摘要', '<p>請在截止前上傳。</p>', $7::jsonb, 'user', $8, $8)
     returning id`,
    [cohortId, options.audience, options.consentMode, minute(-DAY), minute(10 * DAY), options.title, JSON.stringify({ fields: options.fields }), adminId],
  )
  const id = item.rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前上傳。</p>', $3) returning id`,
    [id, options.title, adminId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
    [id, JSON.stringify({ fields: options.fields }), adminId],
  )
  await pool.query(
    `update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`,
    [id, content.rows[0]!.id, schema.rows[0]!.id],
  )
  for (const receiverId of options.roster) {
    await pool.query(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, 'user', $3, now(), 'auto', 'user', $4)`,
      [id, cohortId, receiverId, adminId],
    )
  }
  return id
}

async function versions(itemId: string, userId: string) {
  return (
    await pool.query<{ version_no: number; submitted_by_user_id: string }>(
      `select version_no, submitted_by_user_id from submission_versions
        where item_id = $1 and receiver_kind = 'user' and receiver_id = $2 order by version_no`,
      [itemId, userId],
    )
  ).rows
}

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
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
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e C1-10：回到真實時間')`,
    [adminId],
  )
  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
      [CODE, ymd(new Date(Date.now() + 300 * DAY))],
    )
  ).rows[0]!.id

  onRoster = await newPerson('teacher', '名單上老師', 7)
  offRoster = await newPerson('teacher', '名單外老師', null)
  student = await newPerson('student', '簽名學生', null)
  teacherItemId = await publishedItem({ title: TEACHER_ITEM, audience: 'teachers', consentMode: null, fields: TEACHER_FIELDS, roster: [onRoster.userId] })
  consentItemId = await publishedItem({
    title: CONSENT_ITEM,
    audience: 'cohort_students',
    consentMode: 'upload',
    fields: CONSENT_FIELDS,
    roster: [student.userId],
  })
})

test.afterAll(async () => {
  await pool?.end()
})

test('AC-20：名單上的老師在「我的作業」開作業 → 寫作業 → 上傳 → 繳交作業；繳交歷史一列、繳交人是老師本人', async ({ page }) => {
  await signIn(page, onRoster)
  await page.goto('/dashboard/teacher/affairs')
  await expect(page.getByRole('navigation', { name: '作業區分頁' }).getByRole('link', { name: '我的作業' })).toHaveAttribute('aria-current', 'page')
  const row = page.getByTestId(`affair-${teacherItemId}`)
  await expect(row).toContainText(TEACHER_ITEM)
  await expect(row.getByTestId('affair-form')).toHaveText('檔案')
  await expect(row).toContainText(/待交|快到期/)
  await expect(page.getByRole('table', { name: '我的作業' })).not.toContainText('成績')
  await row.getByRole('link', { name: '交作業' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/teacher/affairs/${teacherItemId}$`))
  await expect(page.getByRole('heading', { level: 1, name: TEACHER_ITEM })).toBeVisible()

  await page.getByRole('link', { name: /繳交歷史/ }).click()
  await expect(page.getByTestId('file-limit')).toHaveText('檔案上限：PDF・20 MB 以內')
  await expect(page.getByText('還沒有繳交過。')).toBeVisible()
  await page.getByRole('link', { name: '寫作業' }).click()
  await expect(page.getByRole('button', { name: '儲存草稿' })).toHaveCount(0)
  await page.getByTestId('file-field-cv').locator('input[type=file]').first().setInputFiles({ name: '簡歷.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(page.getByText('「簡歷.pdf」已上傳。按「繳交作業」才算交出。')).toBeVisible()
  await page.getByRole('button', { name: '繳交作業' }).click()
  const receipt = page.getByTestId('receipt')
  await expect(receipt.getByRole('heading', { level: 2 })).toHaveText('已送出第 1 次')
  await expect(receipt).toContainText(onRoster.name)
  await receipt.getByRole('button', { name: '關閉' }).click()

  await expect(page).toHaveURL(new RegExp(`/dashboard/teacher/affairs/${teacherItemId}\\?tab=history$`))
  const history = page.getByRole('table', { name: '繳交歷史' })
  await expect(history.getByTestId('history-row')).toHaveCount(1)
  await expect(history.getByTestId('history-row')).toContainText(onRoster.name)
  // 頭像照本人設定的預設圖（avatar_preset 7）。
  await expect(history.getByTestId('history-row').locator('img')).toHaveAttribute('src', '/avatars/007.webp')
  expect(await versions(teacherItemId, onRoster.userId)).toEqual([{ version_no: 1, submitted_by_user_id: onRoster.userId }])

  // 清單狀態跟著變：已交、按鈕「查看」。
  await page.goto('/dashboard/teacher/affairs')
  await expect(page.getByTestId(`affair-${teacherItemId}`)).toContainText('已交第 1 次')
  await expect(page.getByTestId(`affair-${teacherItemId}`).getByRole('link', { name: '查看' })).toBeVisible()

  // 系辦繳交狀況：該老師列已繳。
  await signIn(page, admin)
  await page.goto(`/dashboard/admin/affairs/${teacherItemId}`)
  await expect(page.getByTestId('completion-rate')).toHaveText('1／1')
  const rosterRow = page.getByTestId('roster-current').getByTestId('roster-row').filter({ hasText: onRoster.name })
  await expect(rosterRow.getByTestId('roster-status')).toHaveText('已繳第 1 次')
})

test('AC-20：不在名單上的老師直接打開老師作業的網址 → 403；「我的作業」也沒有這一份', async ({ page }) => {
  await signIn(page, offRoster)
  await page.goto('/dashboard/teacher/affairs')
  await expect(page.getByRole('main')).not.toContainText(TEACHER_ITEM)
  await page.goto(`/dashboard/teacher/affairs/${teacherItemId}`)
  await expect(page).toHaveURL(/\/403$/)
  await expect(page.getByRole('main')).not.toContainText(TEACHER_ITEM)
  // 不是老師對象的作業（或亂打的 id）照舊 404，不透露存在。
  expect((await page.goto(`/dashboard/teacher/affairs/${consentItemId}`))?.status()).toBe(404)
  // 寫入也被用例擋：名單外的老師拿不到這一頁的表單，直接打學生網址是 403（角色不對）。
  await page.goto(`/dashboard/student/affairs/${teacherItemId}`)
  await expect(page).toHaveURL(/\/403$/)
})

test('AC-24（學生面）：上傳簽名檔的同意書形式寫「同意書」，流程同一般作業（寫作業 → 上傳 → 繳交作業）', async ({ page }) => {
  await signIn(page, student)
  await page.goto('/dashboard/student/affairs')
  const row = page.getByTestId(`affair-${consentItemId}`)
  await expect(row.getByTestId('affair-form')).toHaveText('同意書')
  await row.getByRole('link', { name: '交作業' }).click()
  await page.getByRole('link', { name: /繳交歷史/ }).click()
  await expect(page.getByTestId('file-limit')).toHaveText('檔案上限：PDF、JPG、PNG・20 MB 以內')
  await page.getByRole('link', { name: '寫作業' }).click()
  await page.getByTestId('file-field-signed').locator('input[type=file]').first().setInputFiles({ name: '同意書.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(page.getByText('「同意書.pdf」已上傳。按「繳交作業」才算交出。')).toBeVisible()
  await page.getByRole('button', { name: '繳交作業' }).click()
  await expect(page.getByTestId('receipt').getByRole('heading', { level: 2 })).toHaveText('已送出第 1 次')
  expect(await versions(consentItemId, student.userId)).toHaveLength(1)

  // 系辦繳交狀況以人計。
  await signIn(page, admin)
  await page.goto(`/dashboard/admin/affairs/${consentItemId}`)
  await expect(page.getByTestId('completion-rate')).toHaveText('1／1')
})
