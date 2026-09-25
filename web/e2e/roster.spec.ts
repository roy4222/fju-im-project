import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 18（#229）：收件名單頁與完成率。「做完的樣子」逐條走：
 *
 * 1. 管理員看名單頁：目前名單、免填、已移出三類分開；完成率＝已正式送出／應交數。
 * 2. 點任一人看回答明細與版本。
 * 3. 學生首頁待辦數與名單頁一致（同一個學生：首頁「待繳交」＝作業區「待繳」；送出後首頁少一件、名單頁多一位已繳）。
 * 另外：學生、老師打不開名單頁；學生通知匣裡的收件通知點得進作業區那一份（票 16 遺留）。
 *
 * 收件用 owner 連線直接建成「已發布」的樣子（發布流程由 affairs.spec 走過）；免填與移出的「操作」在之後的票，
 * 這裡也用 owner 連線寫成那個樣子。學生的正式送出走真的畫面。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T18-${stamp}`
const TITLE = `${CODE} 分組意向登記`
const DAY = 86_400_000

type Student = TestSession & { name: string; studentNo: string }

let pool: Pool
let admin: TestSession
let teacher: TestSession
let cohortId: string
let itemId: string
let doer: Student
let waiter: Student
let exempted: Student
let removed: Student

const FIELDS = [
  { key: 'topic', type: 'text', label: '想做的題目', required: true },
  { key: 'kind', type: 'radio', label: '專題類型', required: true, options: ['一般專題', '產學合作'] },
]

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function minute(offsetMs: number): Date {
  return new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000)
}

async function newStudent(i: number): Promise<Student> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const session = await createTestSession(context, 'student')
  await context.dispose()
  const studentNo = `418${String(Date.now()).slice(-5)}${i}`
  const name = `名單學生${i}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [session.userId, name, studentNo, cohortId, `t18-${i}-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, session.userId])
  return { ...session, name, studentNo }
}

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

const rosterPath = () => `/dashboard/admin/affairs/${itemId}`

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  // 一個角色一個 request context：同一個 context 第二次註冊會帶著第一個人的 cookie，被來源檢查擋下。
  for (const role of ['admin', 'teacher'] as const) {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    const session = await sharedTestSession(context, role)
    if (role === 'admin') admin = session
    else teacher = session
    await context.dispose()
  }
  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e 票 18：回到真實時間')`,
    [admin.userId],
  )
  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
      [CODE, ymd(new Date(Date.now() + 300 * DAY))],
    )
  ).rows[0]!.id
  const stageId = (
    await pool.query<{ id: string }>(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, 1, '成組期', $2, 'system') returning id`,
      [cohortId, ymd(new Date(Date.now() - 30 * DAY))],
    )
  ).rows[0]!.id

  doer = await newStudent(1)
  waiter = await newStudent(2)
  exempted = await newStudent(3)
  removed = await newStudent(4)

  // 已發布的個人收件＋名單（四個人）。
  itemId = (
    await pool.query<{ id: string }>(
      `insert into managed_items
         (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, actual_opened_at, due_at,
          title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
       values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'individual', $2, 'draft', null, $3, $4,
               $5, '一句話摘要', '<p>請在截止前填好。</p>', $6::jsonb, 'user', $7, $7)
       returning id`,
      [cohortId, stageId, minute(-DAY), minute(10 * DAY), TITLE, JSON.stringify({ fields: FIELDS }), admin.userId],
    )
  ).rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前填好。</p>', $3) returning id`,
    [itemId, TITLE, admin.userId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
    [itemId, JSON.stringify({ fields: FIELDS }), admin.userId],
  )
  await pool.query(
    `update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`,
    [itemId, content.rows[0]!.id, schema.rows[0]!.id],
  )
  for (const s of [doer, waiter, exempted, removed]) {
    await pool.query(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, 'user', $3, now() - interval '1 day', 'auto', 'user', $4)`,
      [itemId, cohortId, s.userId, admin.userId],
    )
  }
  // 免填與移出（操作在之後的票；這裡直接寫成那個樣子）。
  await pool.query(`update response_rosters set exempt = true, exempt_reason = '休學中' where item_id = $1 and receiver_id = $2`, [
    itemId,
    exempted.userId,
  ])
  await pool.query(
    `update response_rosters set eligible_to_business_at = now(), removed_reason = '轉到別屆'
      where item_id = $1 and receiver_id = $2`,
    [itemId, removed.userId],
  )
  // 收件通知（票 15 發布時由背景工作投影；這裡直接寫一則，驗通知匣的連結）。事件不掛投影列，背景工作不會碰它。
  await pool.query(
    `with event as (
       insert into domain_events (id, type, scope, cohort_id, source_type, source_id, actor_kind, occurred_real_at, occurred_business_at)
       values (gen_random_uuid(), 'item.published', 'cohort', $2, 'item', $4, 'system', now(), now()) returning id
     )
     insert into notifications (id, event_id, recipient_user_id, scope, cohort_id, kind, title, source_ref, created_at)
     select gen_random_uuid(), event.id, $1, 'cohort', $2, 'item.published', $3, $5::jsonb, now() from event`,
    [waiter.userId, cohortId, `新的收件：${TITLE}`, itemId, JSON.stringify({ type: 'item', id: itemId })],
  )
})

test.afterAll(async () => {
  await pool?.end()
})

async function homePending(page: Page): Promise<string> {
  await page.goto('/dashboard/student')
  return (await page.getByTestId('home-pending').textContent()) ?? ''
}

/** 側欄「作業區」的數字徽章（票 30）；0 時不顯示。 */
const affairsBadge = (page: Page) => page.getByTestId('nav-badge-/dashboard/student/affairs')

test('名單頁三類分開；完成率＝已正式送出／應交數（免填與已移出不算）', async ({ page }) => {
  await signIn(page, admin)
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  // 工作台的「收件名單」欄是應交數（不含免填與已移出，跟名單頁「目前名單」、完成率分母同一個口徑），點得進名單頁。
  await page.getByTestId('affair-row').filter({ hasText: TITLE }).getByRole('link', { name: /應交 2 位/ }).click()
  await expect(page).toHaveURL(new RegExp(`${rosterPath()}$`))
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()

  const tabs = page.getByRole('navigation', { name: '名單分類' })
  await expect(tabs.getByRole('link', { name: /目前名單\s*2/ })).toBeVisible()
  await expect(tabs.getByRole('link', { name: /免填\s*1/ })).toBeVisible()
  await expect(tabs.getByRole('link', { name: /已移出\s*1/ })).toBeVisible()
  await expect(page.getByTestId('completion-rate')).toHaveText('0／2')

  const current = page.getByTestId('roster-current')
  await expect(current.getByTestId('roster-row')).toHaveCount(2)
  await expect(current).toContainText(doer.name)
  await expect(current).toContainText(waiter.studentNo)
  await expect(current).not.toContainText(exempted.name)
  await expect(current.getByTestId('roster-status').first()).toHaveText('未繳')

  await tabs.getByRole('link', { name: /免填/ }).click()
  await expect(page.getByTestId('roster-exempt')).toContainText(exempted.name)
  await expect(page.getByTestId('roster-exempt')).toContainText('休學中')
  await tabs.getByRole('link', { name: /已移出/ }).click()
  await expect(page.getByTestId('roster-removed')).toContainText(removed.name)
  await expect(page.getByTestId('roster-removed')).toContainText('轉到別屆')
  // 分母不因切換分頁改變。
  await expect(page.getByTestId('completion-rate')).toHaveText('0／2')
})

test('學生首頁待繳數＝作業區待繳；送出後首頁少一件、名單頁完成率 1／2 且那個人顯示已繳', async ({ page }) => {
  await signIn(page, doer)
  expect(await homePending(page)).toBe('1 件')
  // 側欄徽章（票 30）跟首頁待繳同一個數。
  await expect(affairsBadge(page)).toHaveText('1')
  await page.goto('/dashboard/student/affairs')
  await expect(page.getByRole('navigation', { name: '篩選' }).getByRole('link', { name: /待繳\s*1/ })).toBeVisible()

  await page.goto(`/dashboard/student/affairs/${itemId}`)
  await page.getByLabel('想做的題目').fill('校園導覽 App')
  await page.getByLabel('一般專題').check()
  await page.getByRole('button', { name: '正式送出' }).click()
  await expect(page.getByTestId('receipt')).toContainText('v1')
  await page.getByRole('button', { name: '關閉' }).click()

  expect(await homePending(page)).toBe('0 件')
  // 送出後是 0：徽章不顯示。
  await expect(affairsBadge(page)).toHaveCount(0)
  // 被免填的人首頁也是 0，不會被算進待繳。
  await signIn(page, exempted)
  expect(await homePending(page)).toBe('0 件')
  await expect(affairsBadge(page)).toHaveCount(0)
  // 別人送出不影響自己的數字：還沒交的人仍是 1（看不到別人的數）。
  await signIn(page, waiter)
  expect(await homePending(page)).toBe('1 件')
  await expect(affairsBadge(page)).toHaveText('1')
  // waiter 有一則未讀的收件通知：側欄「通知」也有徽章。
  await expect(page.getByTestId('nav-badge-/dashboard/student/inbox')).toBeVisible()

  await signIn(page, admin)
  await page.goto(rosterPath())
  await expect(page.getByTestId('completion-rate')).toHaveText('1／2')
  const rows = page.getByTestId('roster-current').getByTestId('roster-row')
  await expect(rows.filter({ hasText: doer.name }).getByTestId('roster-status')).toHaveText('已繳 v1')
  await expect(rows.filter({ hasText: waiter.name }).getByTestId('roster-status')).toHaveText('未繳')
})

test('點一個人看每一次正式送出與那一次的回答；已移出的人也點得進去', async ({ page }) => {
  await signIn(page, admin)
  await page.goto(rosterPath())
  await page.getByRole('link', { name: `查看 ${doer.name} 的回答` }).click()
  const view = page.getByTestId('receiver-view')
  await expect(view).toContainText(doer.name)
  await expect(view).toContainText('已繳 v1')
  await expect(view.getByRole('table', { name: '正式送出的版本' })).toContainText('第 1 次')
  await view.getByRole('link', { name: '看回答' }).click()

  const version = page.getByTestId('version-view')
  await expect(version).toContainText('想做的題目')
  await expect(version).toContainText('校園導覽 App')
  await expect(version).toContainText('一般專題')
  await expect(version).toContainText('採計')

  await page.goto(`${rosterPath()}?list=removed`)
  await page.getByRole('link', { name: `查看 ${removed.name} 的回答` }).click()
  await expect(page.getByTestId('receiver-view')).toContainText('已移出（轉到別屆）・回答保留')
  await expect(page.getByTestId('receiver-view')).toContainText('還沒有正式送出過。')
})

test('學生（連名單上的本人）與老師打不開名單頁與別人的回答', async ({ page }) => {
  for (const who of [doer, teacher]) {
    await signIn(page, who)
    for (const path of [rosterPath(), `${rosterPath()}?person=${doer.userId}&version=1`]) {
      await page.goto(path)
      await expect(page).toHaveURL(/\/403$/)
      await expect(page.getByText('校園導覽 App')).toHaveCount(0)
    }
  }
})

test('學生通知匣：收件通知點得進作業區那一份', async ({ page }) => {
  await signIn(page, waiter)
  await page.goto('/dashboard/student/inbox')
  const item = page.getByTestId('inbox-item').filter({ hasText: TITLE })
  await expect(item.getByRole('link')).toHaveAttribute('href', `/dashboard/student/affairs/${itemId}`)
})
