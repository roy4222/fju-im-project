import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 學生規格 ST-2：學生首頁（AC-ST-03～07、24）。
 *
 * - AC-ST-03：橫幅「現在階段」：階段字、還有 N 天、「看完整時程」→ `/timeline`（實際點過去）、`hero-next` 下一件要交的。
 * - AC-ST-04：沒有要交的：`hero-next` 一句「目前沒有要交的」、已交的卡補滿；什麼都沒有時一行空狀態；沒有「請聯絡系辦」。
 * - AC-ST-05：恰好 5 張待辦卡，逾期（久的在前）→ 快到期 → 待交依截止日；第 6 件以後（含尚未開放、同意書）不出現。
 * - AC-ST-06：公告區 5 則、置頂的在第一則；舊的行事曆、「接下來」、小標籤、階段四格、進度條都不在。
 * - AC-ST-07：本屆沒有時程：橫幅顯示無時程句、「看完整時程」仍在，待辦與公告照常。
 * - AC-ST-24：Pixel Trail 只掛在首頁橫幅（只驗掛載位置；元件行為由共用 AC-SH-27～32 驗）。
 *
 * 日期都從「現在」往後算（業務鐘先拉回真實時間，不撥模擬鐘）。資料直接寫庫：作業的發布 UI 是系辦的範圍。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `ST2-${stamp}`
const EMPTY_CODE = `ST2E-${stamp}`
const STAGES = ['分組階段', '期中', '期末', '成果'] as const
const DAY = 86_400_000
const HOME = '/dashboard/student'

const at = (n: number) => new Date(Date.now() + n * DAY)
function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}
/** 臺灣日期的 `M/D`（不補零），跟 `dueText` 同一個寫法。 */
function monthDay(date: Date): string {
  const [, m, d] = ymd(date).split('-').map(Number)
  return `${m}/${d}`
}

let pool: Pool
let adminId = ''
let cohortId = ''
let emptyCohortId = ''
/** 甲：AC-ST-03、24（整組一份的「期中報告」、有草稿）。乙：AC-ST-04（只有 2 件已交）。丙：AC-ST-05（7 件未完成＋同意書）。丁：沒時程的屆、什麼都沒有。 */
const people: Record<'a' | 'b' | 'c' | 'd', { session: TestSession; name: string }> = {} as never
const ids: Record<string, string> = {}

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function newCohort(code: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
    [code, ymd(at(300))],
  )
  return row.rows[0]!.id
}

async function enrol(session: TestSession, cohort: string, name: string) {
  const studentNo = `418${String(Date.now()).slice(-6)}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set display_name = excluded.display_name, name_normalized = excluded.name_normalized,
       student_no = excluded.student_no, cohort_id = excluded.cohort_id`,
    [session.userId, name, studentNo, cohort, `st2-${studentNo}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohort, studentNo, session.userId])
}

async function newGroup(code: string, members: readonly string[]): Promise<string> {
  const groupId = (
    await pool.query<{ id: string }>(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
      [cohortId, code],
    )
  ).rows[0]!.id
  for (const userId of members) {
    await pool.query(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [groupId, cohortId, userId],
    )
  }
  return groupId
}

/** 一份已發布的收件（內容版本、欄位版本、名單）；回 `[項目 id, 欄位版本 id]`。 */
async function publishedItem(options: {
  title: string
  dueAt: Date
  opensAt?: Date
  unit: 'individual' | 'group'
  receiver: string
}): Promise<[string, string]> {
  const fields = [{ key: 'note', type: 'text', label: '說明', required: true }]
  // 發布時間一律在過去（發布檢查要有）；「尚未開放」只看 opens_at。
  const opened = at(-20)
  const itemId = (
    await pool.query<{ id: string }>(
      `insert into managed_items
         (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, actual_opened_at, due_at,
          title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
       values (gen_random_uuid(), $1, 'submission', 'cohort_students', $2,
               (select id from cohort_stages where cohort_id = $1 order by seq limit 1), 'draft', $3, $4, $5,
               $6, '一句話摘要', '<p>請在截止前交。</p>', $7::jsonb, 'user', $8, $8)
       returning id`,
      [cohortId, options.unit, options.opensAt ?? null, opened, options.dueAt, options.title, JSON.stringify({ fields }), adminId],
    )
  ).rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前交。</p>', $3) returning id`,
    [itemId, options.title, adminId],
  )
  const schemaId = (
    await pool.query<{ id: string }>(
      `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
       values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
      [itemId, JSON.stringify({ fields }), adminId],
    )
  ).rows[0]!.id
  await pool.query(`update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`, [
    itemId,
    content.rows[0]!.id,
    schemaId,
  ])
  await pool.query(
    `insert into response_rosters
       (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, $4, now() - interval '30 days', 'auto', 'user', $5)`,
    [itemId, cohortId, options.unit === 'group' ? 'group' : 'user', options.receiver, adminId],
  )
  return [itemId, schemaId]
}

/** 學生本人已經正式送出一版（個人作業）。 */
async function submitted(itemId: string, schemaId: string, userId: string, daysAgo: number) {
  await pool.query(
    `insert into submission_versions
       (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
        received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
     values (gen_random_uuid(), $1, 'user', $2, 1, $3, '{"note":"交了"}'::jsonb, $2, $4, $4, gen_random_uuid(), null, 1)`,
    [itemId, userId, schemaId, at(-daysAgo)],
  )
}

/** 一則公告（對象「所有登入的人」）；`pinned` 時置頂。 */
async function news(title: string, publishedDaysAgo: number, pinned: boolean) {
  const itemId = (
    await pool.query<{ id: string }>(
      `insert into managed_items
         (id, cohort_id, placement, audience_kind, status, actual_opened_at, title, summary, body_html, pinned_at,
          created_by_kind, created_by_user_id, updated_by_user_id)
       values (gen_random_uuid(), $1, 'news', 'signed_in', 'draft', $2, $3, '摘要', '<p>內容</p>', $4, 'user', $5, $5)
       returning id`,
      [cohortId, at(-publishedDaysAgo), title, pinned ? new Date() : null, adminId],
    )
  ).rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '摘要', '<p>內容</p>', $3) returning id`,
    [itemId, title, adminId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id) values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
    [itemId, adminId],
  )
  await pool.query(`update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`, [
    itemId,
    content.rows[0]!.id,
    schema.rows[0]!.id,
  ])
}

test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e ST-2：回到真實時間')`,
    [adminId],
  )

  cohortId = await newCohort(CODE)
  // 第 1 段從 10 天前開始、第 2 段在第 19 天開始 → 第 1 段最後一天是第 18 天：「還有 18 天」。
  for (const [i, d] of [-10, 19, 90, 150].entries()) {
    await pool.query(
      `insert into cohort_stages (id, cohort_id, seq, name, description, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, 'system')`,
      [cohortId, i + 1, STAGES[i], `${STAGES[i]}的說明`, ymd(at(d))],
    )
  }
  emptyCohortId = await newCohort(EMPTY_CODE)

  // 一人一個 context：帶著上一位的 session cookie 去註冊會被 Better Auth 當跨站請求擋掉。
  for (const [key, name] of [
    ['a', '首頁學生甲'],
    ['b', '首頁學生乙'],
    ['c', '首頁學生丙'],
    ['d', '首頁學生丁'],
  ] as const) {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    const session = await createTestSession(context, 'student')
    await context.dispose()
    people[key] = { session, name }
    await enrol(session, key === 'd' ? emptyCohortId : cohortId, name)
  }
  const a = people.a.session.userId
  const c = people.c.session.userId

  // 甲：G01 整組一份的「期中報告」9 天後截止，已存草稿 → 草稿是隱形的，按鈕一律「去交」（C 階段規格① §5.2）。
  const g01 = await newGroup('G01', [a])
  const [midterm, midtermSchema] = await publishedItem({ title: `${CODE} 期中報告`, dueAt: at(9), unit: 'group', receiver: g01 })
  ids.midterm = midterm
  await pool.query(
    `insert into submission_drafts (id, item_id, receiver_kind, receiver_id, schema_version_id, answers, created_by_kind)
     values (gen_random_uuid(), $1, 'group', $2, $3, '{"note":"草稿"}'::jsonb, 'system')`,
    [midterm, g01, midtermSchema],
  )

  // 乙：兩件都交了。
  for (const [title, days] of [
    ['乙 已交一', 4],
    ['乙 已交二', 2],
  ] as const) {
    const [itemId, schemaId] = await publishedItem({ title: `${CODE} ${title}`, dueAt: at(15), unit: 'individual', receiver: people.b.session.userId })
    await submitted(itemId, schemaId, people.b.session.userId, days)
    ids[title] = itemId
  }

  // 丙：逾期 5 天、逾期 2 天、剩 3 天、剩 20／30／40 天、尚未開放（5 天後開放）＋一份待你同意的同意書。
  for (const [key, due, opens] of [
    ['overdue5', -5, undefined],
    ['overdue2', -2, undefined],
    ['soon3', 3, undefined],
    ['open20', 20, undefined],
    ['open30', 30, undefined],
    ['open40', 40, undefined],
    ['notOpen', 50, 5],
  ] as const) {
    const [itemId] = await publishedItem({
      title: `${CODE} 丙 ${key}`,
      dueAt: at(due),
      opensAt: opens === undefined ? undefined : at(opens),
      unit: 'individual',
      receiver: c,
    })
    ids[key] = itemId
  }
  const g02 = await newGroup('G02', [c])
  const packageId = crypto.randomUUID()
  ids.consent = crypto.randomUUID()
  await pool.query(
    `insert into signoff_packages (id, group_id, cohort_id, purpose, created_by_user_id) values ($1, $2, $3, 'result_confirmation', $4)`,
    [packageId, g02, cohortId, adminId],
  )
  await pool.query(
    `insert into signoff_package_versions (id, package_id, version_no, content_text, content_checksum, participants,
                                           created_by_user_id, created_real_at, created_business_at)
     values ($1, $2, 1, $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'), $4::jsonb, $5, now(), now())`,
    [ids.consent, packageId, 'e2e ST-2 同意書全文', JSON.stringify({ students: [{ userId: c, displayName: people.c.name, studentNo: '418000' }] }), adminId],
  )
  await pool.query(`insert into signoff_version_status (version_id, state) values ($1, 'collecting')`, [ids.consent])
  await pool.query(`update signoff_packages set current_version_id = $2 where id = $1`, [packageId, ids.consent])

  // 公告：6 則對象含學生的，其中最舊的一則置頂（置頂優先，所以它仍在第一則）。
  await news(`${CODE} 置頂公告`, 9, true)
  for (let i = 1; i <= 5; i += 1) await news(`${CODE} 公告 ${i}`, 6 - i, false)
})

test.afterAll(async () => {
  // 置頂是全站的：拿掉，免得別的 spec 的「置頂第一則」被本檔的公告佔走。
  await pool?.query(`update managed_items set pinned_at = null where title = $1`, [`${CODE} 置頂公告`])
  await pool?.end()
})

test('AC-ST-03：橫幅「現在階段」：階段字、還有 18 天、看完整時程 → /timeline；下一件要交的「去交」', async ({ page }) => {
  await signIn(page, people.a.session)
  const response = await page.goto(HOME)
  expect(response?.status()).toBe(200)

  const hero = page.getByRole('region', { name: '現在階段' })
  await expect(hero.getByRole('heading', { level: 1 })).toHaveText(`歡迎回來，${people.a.name}`)
  await expect(hero.getByTestId('stage-text')).toContainText('分組階段')
  await expect(hero).toContainText('還有 18 天')
  const timeline = hero.getByRole('link', { name: '看完整時程' })
  await expect(timeline).toHaveAttribute('href', '/timeline')

  const next = hero.getByTestId('hero-next')
  await expect(next).toContainText(`${CODE} 期中報告`)
  await expect(next).toContainText(`${monthDay(at(9))} 截止・剩 9 天`)
  await expect(next.getByRole('link', { name: '去交' })).toHaveAttribute('href', `${HOME}/affairs/${ids.midterm}`)

  // 整組一份的卡在小字標「整組」（Q128）。
  const card = page.getByTestId(`todo-${ids.midterm}`)
  await expect(card).toContainText('整組')
  // 剩 9 天在「快到期」門檻（Q118：10 天）內。
  await expect(card).toHaveAttribute('data-tone', 'soon')

  // SH-1-ST 的前置：從學生首頁實際點「看完整時程」到得了 /timeline。
  await timeline.click()
  await expect(page).toHaveURL(/\/timeline$/)
  await expect(page.getByRole('heading', { level: 1, name: '專題時程' })).toBeVisible()
})

test('AC-ST-04：沒有要交的：hero-next 只寫「目前沒有要交的」、已交的卡補滿；什麼都沒有時一行空狀態', async ({ page }) => {
  await signIn(page, people.b.session)
  await page.goto(HOME)
  await expect(page.getByTestId('hero-next')).toHaveText('目前沒有要交的')
  const todos = page.getByRole('region', { name: '待辦' })
  const cards = todos.locator('[data-testid^="todo-"]')
  await expect(cards).toHaveCount(2)
  // 已完成的照送出時間：最近送出的在前。
  await expect(cards.nth(0)).toHaveAttribute('data-testid', `todo-${ids['乙 已交二']}`)
  await expect(cards.nth(1)).toHaveAttribute('data-testid', `todo-${ids['乙 已交一']}`)
  for (const i of [0, 1]) {
    await expect(cards.nth(i)).toHaveAttribute('data-tone', 'done')
    await expect(cards.nth(i)).toContainText('已交')
  }
  const body = await page.locator('main').innerText()
  expect(body).not.toContain('請聯絡系辦')
  expect(body).not.toContain('洽系辦')

  await signIn(page, people.d.session)
  await page.goto(HOME)
  await expect(page.getByRole('region', { name: '待辦' })).toContainText('目前沒有要交的作業')
  await expect(page.locator('[data-testid^="todo-"]')).toHaveCount(0)
})

test('AC-ST-05：恰好 5 張待辦卡：逾期（久的在前）→ 快到期 → 待交 20 天 → 待交 30 天；其餘不出現；卡片沒有 inline style', async ({ page }) => {
  await signIn(page, people.c.session)
  await page.goto(HOME)
  const todos = page.getByRole('region', { name: '待辦' })
  const cards = todos.locator('[data-testid^="todo-"]')
  await expect(cards).toHaveCount(5)

  const expected = [
    ['overdue5', 'overdue', '逾期', '逾期 5 天'],
    ['overdue2', 'overdue', '逾期', '逾期 2 天'],
    ['soon3', 'soon', '快到期', '剩 3 天'],
    ['open20', 'open', '待交', '剩 20 天'],
    ['open30', 'open', '待交', '剩 30 天'],
  ] as const
  for (const [i, [key, tone, pill, due]] of expected.entries()) {
    const card = cards.nth(i)
    await expect(card).toHaveAttribute('data-testid', `todo-${ids[key]}`)
    await expect(card).toHaveAttribute('data-tone', tone)
    await expect(card.locator('.status-pill')).toHaveText(pill)
    await expect(card).toContainText(due)
  }
  for (const key of ['open40', 'notOpen', 'consent']) await expect(page.getByTestId(`todo-${ids[key]}`)).toHaveCount(0)

  await expect(todos.getByRole('link', { name: '全部作業' })).toHaveAttribute('href', `${HOME}/affairs`)
  expect(await page.evaluate(() => document.querySelectorAll('[data-testid^="todo-"][style]').length)).toBe(0)

  // 每張卡是連結：點逾期那張進作業頁。
  await cards.nth(0).click()
  await expect(page).toHaveURL(new RegExp(`${HOME}/affairs/${ids.overdue5}$`))
})

test('AC-ST-06：公告區 5 則、置頂第一；舊的行事曆、接下來、小標籤、階段四格、進度條都不在', async ({ page }) => {
  await signIn(page, people.a.session)
  await page.goto(HOME)
  const region = page.getByRole('region', { name: '公告' })
  const rows = region.getByRole('listitem')
  await expect(rows).toHaveCount(5)
  await expect(rows.nth(0)).toContainText(`${CODE} 置頂公告`)
  await expect(rows.nth(0).getByTestId('pinned-tag')).toHaveText('置頂')
  for (let i = 0; i < 5; i += 1) await expect(rows.nth(i).getByRole('link')).toHaveAttribute('href', /^\/news\//)
  await expect(region.getByRole('link', { name: '全部公告' })).toHaveAttribute('href', '/news')

  for (const testId of ['student-calendar', 'upcoming', 'home-pending']) await expect(page.getByTestId(testId)).toHaveCount(0)
  await expect(page.getByRole('list', { name: '本屆階段' })).toHaveCount(0)
  await expect(page.getByRole('img', { name: /本屆進度/ })).toHaveCount(0)
  await expect(page.getByText('專題行事曆')).toHaveCount(0)
})

test('AC-ST-07：本屆沒有時程：橫幅顯示無時程句、看完整時程仍可點；待辦與公告照常', async ({ page }) => {
  await signIn(page, people.d.session)
  const response = await page.goto(HOME)
  expect(response?.status()).toBe(200)
  const hero = page.getByRole('region', { name: '現在階段' })
  await expect(hero.getByTestId('stage-text')).toBeVisible()
  await expect(hero.getByTestId('stage-text')).not.toContainText('分組階段')
  await expect(hero.getByRole('link', { name: '看完整時程' })).toHaveAttribute('href', '/timeline')
  await expect(page.getByRole('region', { name: '待辦' })).toBeVisible()
  await expect(page.getByRole('region', { name: '公告' })).toBeVisible()
  await hero.getByRole('link', { name: '看完整時程' }).click()
  await expect(page).toHaveURL(/\/timeline$/)
})

/** 開一頁、等網路靜下來，回傳這頁要過的 JS chunk。 */
async function chunksOf(page: Page, path: string): Promise<string[]> {
  const urls: string[] = []
  const listener = (r: { url(): string }) => {
    if (r.url().includes('/_next/static/chunks/')) urls.push(new URL(r.url()).pathname)
  }
  page.on('request', listener)
  await page.goto(path)
  await page.waitForLoadState('networkidle')
  page.off('request', listener)
  return urls
}

test('AC-ST-24（規格④ C4-02 改 Pixel Card）：Pixel Card 掛在首頁「現在階段」橫幅；移入後 pulse、按鈕仍可點；交作業、組別、/timeline 沒有', async ({ browser }) => {
  async function freshPage(reducedMotion: 'reduce' | 'no-preference') {
    const context = await browser.newContext()
    await context.addCookies([toPlaywrightCookie(people.a.session.cookie, BASE_URL)])
    const page = await context.newPage()
    await page.emulateMedia({ reducedMotion })
    return page
  }
  // Pixel 引擎的 chunk＝首頁「會動」比「減少動態」多要的那幾個（chunk 名是雜湊，不寫死）。
  const still = await freshPage('reduce')
  const withoutTrail = await chunksOf(still, HOME)
  await expect(still.getByRole('region', { name: '現在階段' }).getByTestId('hero-pixel')).toHaveCount(0)
  await expect(still.getByRole('region', { name: '現在階段' }).locator('canvas')).toHaveCount(0)
  await still.context().close()

  const page = await freshPage('no-preference')
  const withTrail = await chunksOf(page, HOME)
  const hero = page.getByRole('region', { name: '現在階段' })
  const pixel = hero.getByTestId('hero-pixel')
  await expect(pixel).toHaveAttribute('data-state', 'idle')
  await expect(hero.locator('canvas')).toHaveCount(1)
  const trailChunks = withTrail.filter((url) => !withoutTrail.includes(url))
  expect(trailChunks.length).toBeGreaterThan(0)

  const box = (await hero.boundingBox())!
  await page.mouse.move(box.x + 40, box.y + 40)
  await expect(pixel).toHaveAttribute('data-state', 'pulse')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
  await hero.getByTestId('hero-next').getByRole('link', { name: '去交' }).click()
  await expect(page).toHaveURL(new RegExp(`${HOME}/affairs/${ids.midterm}$`))
  await page.goto(HOME)
  await page.mouse.move(box.x + 60, box.y + 60, { steps: 5 })
  await page.getByRole('region', { name: '現在階段' }).getByRole('link', { name: '看完整時程' }).click()
  await expect(page).toHaveURL(/\/timeline$/)
  await page.context().close()

  for (const path of [`${HOME}/affairs`, `${HOME}/groups`, '/timeline']) {
    const other = await freshPage('no-preference')
    const loaded = await chunksOf(other, path)
    await expect(other.locator('canvas')).toHaveCount(0)
    expect(loaded.filter((url) => trailChunks.includes(url)), `${path} 不該下載 Pixel 引擎 chunk`).toEqual([])
    await other.context().close()
  }
})
