import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 17（#228）：個人填報與送出。「做完的樣子」逐條走：
 *
 * 1. 作業區列自己該交的項目與狀態（尚未開放／進行中／已截止／已繳 vN）；打開內容頁看到要填的欄位。
 * 2. C 階段規格① §5.2：「寫作業」開表單、只有「繳交作業」（沒有「儲存草稿」）；兩邊同時繳交會被要求重新載入，不會無聲覆蓋。
 * 3. 繳交前驗必填；繳交後拿到回執；截止前可重送，連點只算一次，斷線後回來能查回執。
 * 4. 本人看得到自己每一次繳交（繳交歷史：已交時間、繳交人頭像＋姓名、查看）。
 * 另外：有人作答後，管理員編輯器裡的收件單位真的鎖住（票 15 的接點）。
 *
 * 收件項目用 owner 連線直接建成「已發布」的樣子（發布流程本身由 affairs.spec 走過）；學生這邊全程用真的畫面操作，
 * 資料庫核對用 owner 連線。業務鐘拉回真實時間，開放與截止用相對今天的時間。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T17-${stamp}`

type Student = TestSession & { name: string }

let pool: Pool
let adminId: string
let cohortId: string
let otherCohortId: string
let stageId: string
let s1: Student
let s2: Student
let outsider: Student
const itemIds: Record<'open' | 'later' | 'overdue' | 'other' | 'group', string> = {
  open: '',
  later: '',
  overdue: '',
  other: '',
  group: '',
}

const DAY = 86_400_000

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 截止與開放只到分鐘。 */
function minute(offsetMs: number): Date {
  return new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000)
}

const FIELDS = [
  { key: 'basics', type: 'heading', label: '基本資料', required: false },
  { key: 'topic', type: 'text', label: '想做的題目', required: true },
  { key: 'mail', type: 'email', label: '聯絡信箱', required: false },
  { key: 'kind', type: 'radio', label: '專題類型', required: true, options: ['一般專題', '產學合作'] },
  { key: 'note', type: 'textarea', label: '補充說明', required: false },
]

async function newStudent(cohort: string, i: number): Promise<Student> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const session = await createTestSession(context, 'student')
  await context.dispose()
  const studentNo = `417${String(Date.now()).slice(-5)}${i}`
  const name = `填報學生${i}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [session.userId, name, studentNo, cohort, `t17-${i}-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohort, studentNo, session.userId])
  return { ...session, name }
}

/** 建一份「已發布」的收件（內容版本、欄位版本、實際開放時間、名單），回項目 id。 */
async function publishedItem(options: {
  cohort: string
  stage: string
  title: string
  opensAt: Date | null
  dueAt: Date
  unit?: 'individual' | 'group'
  roster: readonly string[]
}): Promise<string> {
  const actualOpenedAt = options.opensAt && options.opensAt.getTime() < Date.now() ? options.opensAt : minute(-DAY * 10)
  const item = await pool.query<{ id: string }>(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, actual_opened_at, due_at,
        title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
     values (gen_random_uuid(), $1, 'submission', 'cohort_students', $2, $3, 'draft', $4, $5, $6,
             $7, '一句話摘要', '<p>請在截止前填好。</p>', $8::jsonb, 'user', $9, $9)
     returning id`,
    [
      options.cohort,
      options.unit ?? 'individual',
      options.stage,
      options.opensAt,
      actualOpenedAt,
      options.dueAt,
      options.title,
      JSON.stringify({ fields: FIELDS }),
      adminId,
    ],
  )
  const itemId = item.rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前填好。</p>', $3) returning id`,
    [itemId, options.title, adminId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
    [itemId, JSON.stringify({ fields: FIELDS }), adminId],
  )
  await pool.query(
    `update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`,
    [itemId, content.rows[0]!.id, schema.rows[0]!.id],
  )
  for (const receiverId of options.roster) {
    await pool.query(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, $3, $4, now(), 'auto', 'user', $5)`,
      [itemId, options.cohort, options.unit === 'group' ? 'group' : 'user', receiverId, adminId],
    )
  }
  return itemId
}

async function versions(itemId: string, userId: string) {
  return (
    await pool.query<{ version_no: number; answers: Record<string, unknown>; request_id: string }>(
      `select version_no, answers, request_id from submission_versions
        where item_id = $1 and receiver_kind = 'user' and receiver_id = $2 order by version_no`,
      [itemId, userId],
    )
  ).rows
}

async function draftOf(itemId: string, userId: string) {
  return (
    await pool.query<{ answers: Record<string, unknown>; revision: number }>(
      `select answers, revision from submission_drafts where item_id = $1 and receiver_kind = 'user' and receiver_id = $2`,
      [itemId, userId],
    )
  ).rows[0]
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const now = new Date()
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  adminId = admin.userId
  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e 票 17：回到真實時間')`,
    [adminId],
  )
  const insertCohort = async (code: string) =>
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
        [code, ymd(new Date(now.getTime() + 300 * DAY))],
      )
    ).rows[0]!.id
  cohortId = await insertCohort(CODE)
  otherCohortId = await insertCohort(`${CODE}-X`)
  const insertStage = async (cohort: string) =>
    (
      await pool.query<{ id: string }>(
        `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
         values (gen_random_uuid(), $1, 1, '成組期', $2, 'system') returning id`,
        [cohort, ymd(new Date(now.getTime() - 30 * DAY))],
      )
    ).rows[0]!.id
  stageId = await insertStage(cohortId)
  const otherStage = await insertStage(otherCohortId)

  s1 = await newStudent(cohortId, 1)
  s2 = await newStudent(cohortId, 2)
  outsider = await newStudent(otherCohortId, 9)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
    [cohortId],
  )

  const roster = [s1.userId, s2.userId]
  itemIds.open = await publishedItem({ cohort: cohortId, stage: stageId, title: `${CODE} 分組意向登記`, opensAt: null, dueAt: minute(10 * DAY), roster })
  itemIds.later = await publishedItem({
    cohort: cohortId,
    stage: stageId,
    title: `${CODE} 期末成果登記`,
    opensAt: minute(5 * DAY),
    dueAt: minute(20 * DAY),
    roster,
  })
  itemIds.overdue = await publishedItem({
    cohort: cohortId,
    stage: stageId,
    title: `${CODE} 說明會出席`,
    opensAt: minute(-5 * DAY),
    dueAt: minute(-DAY),
    roster,
  })
  itemIds.other = await publishedItem({
    cohort: otherCohortId,
    stage: otherStage,
    title: `${CODE} 別屆的收件`,
    opensAt: null,
    dueAt: minute(10 * DAY),
    roster: [outsider.userId],
  })
  itemIds.group = await publishedItem({
    cohort: cohortId,
    stage: stageId,
    title: `${CODE} 整組一份的報告`,
    opensAt: null,
    dueAt: minute(10 * DAY),
    unit: 'group',
    roster: [group.rows[0]!.id],
  })
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

const openPath = () => `/dashboard/student/affairs/${itemIds.open}`
/** 「寫作業」打開的表單區（C 階段規格① §5.2：繳交歷史分頁頂部的「寫作業」）。 */
const writePath = () => `${openPath()}?tab=history&write=1`
/** 這一頁的 Server Action（存草稿、繳交）都 POST 到目前網址（帶查詢字串）。 */
const isOpenPage = (url: URL) => url.pathname === openPath()

test('作業區只列自己名單上的個人收件，狀態分成尚未開放／進行中／逾期未繳；欄有形式、沒有成績（AC-16）', async ({ page }) => {
  await signIn(page, s1)
  await page.goto('/dashboard/student')
  await page.getByRole('navigation').getByRole('link', { name: '交作業', exact: true }).click()
  await expect(page.getByRole('heading', { name: '交作業', exact: true })).toBeVisible()

  const list = page.getByRole('table', { name: '作業列表' })
  await expect(list.getByRole('link', { name: new RegExp(`${CODE} 分組意向登記`) })).toBeVisible()
  await expect(list.getByRole('columnheader')).toHaveText(['名稱', '形式', '狀態', '截止', '動作'])
  await expect(list).not.toContainText('成績')
  await expect(page.getByTestId(`affair-${itemIds.open}`)).toContainText(/待交|快到期/)
  await expect(page.getByTestId(`affair-${itemIds.open}`).getByTestId('affair-form')).toHaveText('表單')
  await expect(page.getByTestId(`affair-${itemIds.open}`).getByRole('link', { name: '交作業' })).toHaveAttribute('href', openPath())
  await expect(page.getByTestId(`affair-${itemIds.later}`)).toContainText('尚未開放')
  // 逾期的不在預設的「待交」篩選，在「逾期」。
  await expect(page.getByTestId(`affair-${itemIds.overdue}`)).toHaveCount(0)
  // 別屆的、自己不在的組別的整組一份都不在這裡（s1 不是 G01 的組員）。
  await expect(page.getByText(`${CODE} 別屆的收件`)).toHaveCount(0)
  await expect(page.getByText(`${CODE} 整組一份的報告`)).toHaveCount(0)

  await page.getByRole('navigation', { name: '篩選作業' }).getByRole('link', { name: /逾期/ }).click()
  await expect(page.getByTestId(`affair-${itemIds.overdue}`)).toContainText('逾期')
  await expect(page.getByTestId(`affair-${itemIds.open}`)).toHaveCount(0)
})

test('不在名單上的學生打不開別人的收件；尚未開放與已截止不能寫作業', async ({ page }) => {
  await signIn(page, outsider)
  const response = await page.goto(openPath())
  expect(response?.status()).toBe(404)

  await signIn(page, s1)
  await page.goto(`/dashboard/student/affairs/${itemIds.later}?tab=history&write=1`)
  await expect(page.getByText(/開放後才能寫作業/)).toBeVisible()
  await expect(page.getByTestId('write-button')).toHaveText('尚未開放')
  await expect(page.getByTestId('write-button')).toBeDisabled()
  await expect(page.getByRole('button', { name: '繳交作業' })).toHaveCount(0)
  await expect(page.getByLabel('想做的題目')).toHaveCount(0)

  await page.goto(`/dashboard/student/affairs/${itemIds.overdue}?tab=history&write=1`)
  await expect(page.getByTestId('affair-banner')).toContainText('逾期未繳')
  await expect(page.getByTestId('write-button')).toHaveText('已截止')
  await expect(page.getByTestId('write-button')).toBeDisabled()
  await expect(page.getByRole('main')).toContainText('可向系辦申請補交')
  await expect(page.getByRole('button', { name: '繳交作業' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '儲存草稿' })).toHaveCount(0)
})

test('作業內容看說明與繳交欄位；按「寫作業」開表單：只有「繳交作業」、沒有「儲存草稿」；離開再回來文字欄是空的（AC-18）', async ({ page }) => {
  await signIn(page, s1)
  await page.goto(openPath())
  await expect(page.getByRole('heading', { name: `${CODE} 分組意向登記` })).toBeVisible()
  await expect(page.getByText('請在截止前填好。')).toBeVisible()
  await expect(page.getByTestId('fields-brief')).toContainText('想做的題目')
  await expect(page.getByTestId('fields-brief')).toContainText('必填')
  // 作業內容分頁不能填。
  await expect(page.getByLabel('想做的題目')).toHaveCount(0)

  await page.getByRole('link', { name: '寫作業' }).click()
  await expect(page).toHaveURL(new RegExp(`${openPath()}\\?tab=history&write=1$`))
  const form = page.getByRole('form', { name: '寫作業' })
  await expect(form.getByRole('heading', { name: '基本資料' })).toBeVisible()
  await expect(form.getByLabel('想做的題目')).toBeVisible()
  await expect(form.getByRole('group', { name: /專題類型/ })).toBeVisible()
  await expect(form.getByRole('button')).toHaveText(['繳交作業'])
  await expect(page.getByRole('button', { name: '儲存草稿' })).toHaveCount(0)

  await form.getByLabel('想做的題目').fill('校園導覽 App')
  await page.getByRole('link', { name: '作業內容' }).click()
  // 等真的離開表單頁再點：表單頁自己就有「寫作業」（指向目前網址），還沒換完就點等於點回原頁、導覽被取消。
  await expect(page).not.toHaveURL(/write=1/)
  await page.getByRole('link', { name: '寫作業' }).click()
  await expect(page.getByRole('form', { name: '寫作業' }).getByLabel('想做的題目')).toHaveValue('')
  expect(await versions(itemIds.open, s1.userId)).toHaveLength(0)
})

test('兩個分頁同時寫：先繳交的成功，後繳交的那邊被要求重新載入，不會無聲覆蓋', async ({ page, context }) => {
  await signIn(page, s1)
  await page.goto(writePath())
  const other = await context.newPage()
  await other.goto(writePath())

  await other.getByLabel('想做的題目').fill('分頁 B 的題目')
  await other.getByRole('radio', { name: '一般專題' }).check()
  await other.getByRole('button', { name: '繳交作業' }).click()
  await expect(other.getByTestId('receipt')).toContainText('已送出第 1 次')

  await page.getByLabel('想做的題目').fill('分頁 A 的舊題目')
  await page.getByRole('radio', { name: '產學合作' }).check()
  await page.getByRole('button', { name: '繳交作業' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '別的分頁或裝置上存過了' })).toBeVisible()
  const rows = await versions(itemIds.open, s1.userId)
  expect(rows).toHaveLength(1)
  expect(rows[0]!.answers).toMatchObject({ topic: '分頁 B 的題目' })
  expect((await draftOf(itemIds.open, s1.userId))?.answers.topic).toBe('分頁 B 的題目')
  await other.close()
})

test('繳交前驗必填；繳交拿到回執；連點只算一次', async ({ page }) => {
  await signIn(page, s1)
  await page.goto(writePath())
  await page.getByRole('button', { name: '繳交作業' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '請填寫「想做的題目」' })).toBeVisible()
  await expect(page.getByLabel('想做的題目')).toHaveAttribute('aria-invalid', 'true')
  expect(await versions(itemIds.open, s1.userId)).toHaveLength(1)

  await page.getByLabel('想做的題目').fill('校園導覽 App')
  await page.getByLabel('聯絡信箱').fill('s1@example.com')
  await page.getByRole('radio', { name: '產學合作' }).check()
  await page.getByRole('button', { name: '繳交作業' }).dblclick()
  const receipt = page.getByTestId('receipt')
  await expect(receipt).toBeVisible()
  await expect(receipt).toContainText('已送出第 2 次')
  await expect(receipt).toContainText(s1.name)
  await expect(receipt).toContainText('臺灣時間')

  const rows = await versions(itemIds.open, s1.userId)
  expect(rows, '連點只能多一個版本').toHaveLength(2)
  expect(rows[1]!.answers).toMatchObject({ topic: '校園導覽 App', mail: 's1@example.com', kind: '產學合作' })
  await expect(receipt).toContainText(rows[1]!.request_id)

  await page.getByRole('button', { name: '關閉' }).click()
  // 關掉回執回到繳交歷史（表單收起來）；頂部「寫作業」仍可按（未截止）。
  await expect(page).toHaveURL(new RegExp(`${openPath()}\\?tab=history$`))
  await expect(page.getByTestId('affair-banner')).toContainText('已繳第 2 次')
  await expect(page.getByRole('link', { name: '寫作業' })).toBeVisible()
})

test('截止前重送；繳交途中斷線顯示結果尚未確認，查得到回執，再送一次也不會多一版', async ({ page }) => {
  await signIn(page, s1)
  await page.goto(writePath())
  await page.getByLabel('想做的題目').fill('校園導覽 App（第二版）')
  await page.getByRole('radio', { name: '產學合作' }).check()

  // 模擬斷線：「繳交作業」先存草稿（第 1 個 POST）、再送出（第 2 個）；送出那個真的送到伺服器，但回應在路上掉了。
  let posts = 0
  let dropped = 0
  await page.route(isOpenPage, async (route) => {
    if (route.request().method() === 'POST') {
      posts += 1
      if (posts === 2) {
        dropped += 1
        await route.fetch()
        await route.abort('failed')
        return
      }
    }
    await route.continue()
  })
  await page.getByRole('button', { name: '繳交作業' }).click()
  await expect(page.getByText('連線中斷；結果尚未確認。')).toBeVisible()
  expect(dropped).toBe(1)
  expect(await versions(itemIds.open, s1.userId), '伺服器其實收到了').toHaveLength(3)

  // 再送一次（同一個請求編號、同一版草稿）：拿回第 3 次的回執，不會變成第 4 次。
  await page.getByRole('button', { name: '再送一次' }).click()
  await expect(page.getByTestId('receipt')).toContainText('第 3 次')
  expect(await versions(itemIds.open, s1.userId)).toHaveLength(3)
  await page.getByRole('button', { name: '關閉' }).click()
  await page.unroute(isOpenPage)
})

test('本人看得到每一次繳交（繳交歷史：已交時間、繳交人頭像＋姓名、查看；當時的內容唯讀）', async ({ page }) => {
  await signIn(page, s1)
  await page.goto(openPath())
  await page.getByRole('link', { name: /繳交歷史（3）/ }).click()
  const history = page.getByRole('table', { name: '繳交歷史' })
  await expect(history.getByTestId('history-row')).toHaveCount(3)
  await expect(history.getByRole('columnheader')).toHaveText(['已交時間（臺灣時間）', '繳交人', '動作'])
  await expect(history.getByTestId('history-row').first()).toContainText(s1.name)
  await expect(history.getByTestId('history-row').first().locator('img')).toHaveAttribute('src', /^\/(avatars|api\/files)\//)
  await expect(history.getByRole('link', { name: '查看' })).toHaveCount(3)
  const rows = await versions(itemIds.open, s1.userId)
  // 繳交證明編號不印在歷史列表（W13b：預設收合），改在每一版的內容頁收合顯示；也沒有草稿列。
  await expect(history).not.toContainText(rows[0]!.request_id)
  await expect(history).not.toContainText('草稿')

  await page.goto(`${openPath()}?tab=history&version=2`)
  await expect(page.getByTestId('version-view').getByTestId('receipt-no')).toContainText(rows[1]!.request_id)
  await expect(page.getByTestId('version-view')).toContainText('校園導覽 App')
  await expect(page.getByTestId('version-view')).not.toContainText('第二版')
  await expect(page.getByTestId('version-view')).toContainText('已被後來的繳交取代')
  await page.goto(`${openPath()}?tab=history&version=3`)
  await expect(page.getByTestId('version-view')).toContainText('校園導覽 App（第二版）')

  // 別人看不到我的版本（同屆同學也一樣）。
  await signIn(page, s2)
  await page.goto(`${openPath()}?tab=history&version=1`)
  await expect(page.getByTestId('version-view')).toHaveCount(0)
  await expect(page.getByText('還沒有繳交過。')).toBeVisible()

  // 作業區狀態跟著變；已交的按鈕是「查看」。
  await signIn(page, s1)
  await page.goto('/dashboard/student/affairs?tab=done')
  await expect(page.getByTestId(`affair-${itemIds.open}`)).toContainText('已交')
  await expect(page.getByTestId(`affair-${itemIds.open}`)).toContainText('已交第 3 次')
  await expect(page.getByTestId(`affair-${itemIds.open}`).getByRole('link', { name: '查看' })).toBeVisible()
})

test('有人作答後，管理員編輯器裡的收件單位鎖住；沒人作答的仍可切換', async ({ page }) => {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/editor/${itemIds.open}`)
  await expect(page.getByText('已經有人作答，繳交方式鎖定、不能再切換。')).toBeVisible()
  await expect(page.getByRole('radio', { name: '整組一份', exact: true })).toBeDisabled()

  await page.goto(`/dashboard/admin/editor/${itemIds.later}`)
  await expect(page.getByRole('radio', { name: '整組一份', exact: true })).toBeEnabled()
})
