import { randomUUID } from 'node:crypto'
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 學生規格 ST-3：交作業列表（AC-ST-09、10、13 列表段、15）。
 *
 * - AC-ST-09：S 在 G07，有待交（20 天後）、快到期（3 天後）、尚未開放（5 天後開）各一、逾期兩件（一件整組一份）、
 *   已交一件、一份輪到 S 的同意書（期中結果確認） → 「待交 4」「已交 1」「逾期 2」；預設待交四張卡、同意書卡「沒有截止日」「待你同意」。
 * - AC-ST-10：逾期／已交篩選的卡、「已交第 2 次」、「以前的紀錄」只在已交下方（含被移出名單那件）、`?tab=all` 當待交、空狀態一句。
 * - AC-ST-13：免繳的作業在「已交」、膠囊「免繳」，不在「待交」。
 * - AC-ST-15：不在任何組別的學生沒有同意書卡、沒有「請聯絡系辦」。
 *
 * 作業、名單、繳交、組別、同意書都直接用 owner 連線建好（流程本身由 personal-submit／group-submit／signoff 等 spec 走過畫面）。
 * 側欄徽章的新口徑歸共用 SH-1-ST，這裡不驗。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const DAY = 86_400_000
const stamp = Date.now().toString(36).toUpperCase()
const CODE = `ST3-${stamp}`
const AFFAIRS = '/dashboard/student/affairs'

let pool: Pool
let adminId: string
let cohortId: string
let stageId: string
let groupId: string
/** S：在 G07、資料照 AC-ST-02／09。 */
let viewer: TestSession
/** U：不在任何組別、有一件免繳。 */
let loner: TestSession
let consentId: string
const ids = {
  open: '',
  soon: '',
  notOpen: '',
  overdue: '',
  groupOverdue: '',
  done: '',
  removed: '',
  exempt: '',
}
const title = (key: keyof typeof ids) => `${CODE} ${key}`
const now = new Date()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 截止與開放只到分鐘。 */
function minute(offsetMs: number): Date {
  return new Date(Math.floor((now.getTime() + offsetMs) / 60_000) * 60_000)
}

async function insertStudent(userId: string | null, index: number): Promise<string> {
  const studentNo = `413${String(Date.now()).slice(-5)}${index}`
  const name = `交作業生${index}號`
  let id = userId
  if (!id) {
    id = (
      await pool.query<{ id: string }>(
        `insert into users (id, name, email, email_verified, updated_at, status)
         values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
        [name, `st3-${stamp.toLowerCase()}-${index}@example.com`],
      )
    ).rows[0]!.id
    await pool.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, adminId],
    )
  }
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [id, name, studentNo, cohortId, `st3-${index}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return id
}

/** 一份已發布的作業（名單一個收件者），回項目與欄位版本 id。 */
async function item(options: {
  key: keyof typeof ids
  opensAt: Date | null
  dueAt: Date
  unit?: 'individual' | 'group'
  receiver: string
  exempt?: boolean
}): Promise<{ itemId: string; schemaId: string }> {
  const fields = [{ key: 'note', type: 'text', label: '說明', required: true }]
  // 實際開放時間＝發布時間（十天前）；設了開放時間而且已過的用它。開放時間在未來的仍是「尚未開放」。
  const actualOpenedAt = options.opensAt && options.opensAt.getTime() < now.getTime() ? options.opensAt : minute(-10 * DAY)
  const itemId = (
    await pool.query<{ id: string }>(
      `insert into managed_items
         (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, actual_opened_at, due_at,
          title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
       values (gen_random_uuid(), $1, 'submission', 'cohort_students', $2, $3, 'draft', $4, $5, $6,
               $7, '一句話摘要', '<p>請在截止前交。</p>', $8::jsonb, 'user', $9, $9)
       returning id`,
      [cohortId, options.unit ?? 'individual', stageId, options.opensAt, actualOpenedAt, options.dueAt, title(options.key), JSON.stringify({ fields }), adminId],
    )
  ).rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前交。</p>', $3) returning id`,
    [itemId, title(options.key), adminId],
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
       (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id, exempt, exempt_reason)
     values (gen_random_uuid(), $1, $2, $3, $4, now() - interval '10 days', 'auto', 'user', $5, $6, $7)`,
    [itemId, cohortId, options.unit === 'group' ? 'group' : 'user', options.receiver, adminId, options.exempt ?? false, options.exempt ? '休學中' : null],
  )
  ids[options.key] = itemId
  return { itemId, schemaId }
}

/** 本人個人一份的正式送出（`n` 次，最後一次在昨天）。 */
async function submit(itemId: string, schemaId: string, userId: string, n: number) {
  for (let no = 1; no <= n; no += 1) {
    const at = new Date(now.getTime() - (n - no + 1) * DAY)
    await pool.query(
      `insert into submission_versions (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers,
                                        submitted_by_user_id, received_real_at, received_business_at, request_id, deadline_version_at_submit)
       values (gen_random_uuid(), $1, 'user', $2, $3, $4, $5::jsonb, $2, $6, $6, $7, 1)`,
      [itemId, userId, no, schemaId, JSON.stringify({ note: `第 ${no} 版` }), at, randomUUID()],
    )
  }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  // 每個帳號各用一個 request context：同一個 context 帶著上一個帳號的 cookie 再註冊會被 Origin 檢查擋。
  const fresh = async <T>(run: (context: Awaited<ReturnType<typeof playwrightRequest.newContext>>) => Promise<T>): Promise<T> => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await run(context)
    } finally {
      await context.dispose()
    }
  }
  adminId = (await fresh((c) => sharedTestSession(c, 'admin'))).userId
  viewer = await fresh((c) => createTestSession(c, 'student'))
  loner = await fresh((c) => createTestSession(c, 'student'))
  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e ST-3：回到真實時間')`,
    [adminId],
  )

  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
      [CODE, ymd(new Date(now.getTime() + 300 * DAY))],
    )
  ).rows[0]!.id
  stageId = (
    await pool.query<{ id: string }>(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, 1, '成組期', $2, 'system') returning id`,
      [cohortId, ymd(new Date(now.getTime() - 30 * DAY))],
    )
  ).rows[0]!.id

  const members = [await insertStudent(viewer.userId, 1), await insertStudent(null, 2)]
  await insertStudent(loner.userId, 3)

  groupId = (
    await pool.query<{ id: string }>(
      `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, 'G07', 'general', 'active', now() - interval '20 days', now() - interval '20 days', 'system') returning id`,
      [cohortId],
    )
  ).rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, created_at, updated_at)
     select gen_random_uuid(), $1, $2, u, now() - interval '20 days', 'system', now(), now() from unnest($3::uuid[]) as u`,
    [groupId, cohortId, members],
  )

  const me = viewer.userId
  await item({ key: 'open', opensAt: null, dueAt: minute(20 * DAY), receiver: me })
  await item({ key: 'soon', opensAt: null, dueAt: minute(3 * DAY), receiver: me })
  await item({ key: 'notOpen', opensAt: minute(5 * DAY), dueAt: minute(25 * DAY), receiver: me })
  await item({ key: 'overdue', opensAt: minute(-10 * DAY), dueAt: minute(-2 * DAY), receiver: me })
  await item({ key: 'groupOverdue', opensAt: minute(-10 * DAY), dueAt: minute(-1 * DAY), unit: 'group', receiver: groupId })
  const done = await item({ key: 'done', opensAt: null, dueAt: minute(15 * DAY), receiver: me })
  await submit(done.itemId, done.schemaId, me, 2)
  // 在名單內時送過 2 版、之後被系辦移出名單：只出現在「以前的紀錄」。
  const removed = await item({ key: 'removed', opensAt: null, dueAt: minute(15 * DAY), receiver: me })
  await submit(removed.itemId, removed.schemaId, me, 2)
  await pool.query(
    `update response_rosters set eligible_to_business_at = now(), removed_reason = '轉到別屆' where item_id = $1 and receiver_id = $2`,
    [removed.itemId, me],
  )
  await item({ key: 'exempt', opensAt: null, dueAt: minute(10 * DAY), receiver: loner.userId, exempt: true })

  // G07 一份收集中的「期中結果確認」（最終文件授權要帶精選草稿凍結的授權範圍，這裡不需要），S 還沒表態。
  const packageId = randomUUID()
  consentId = randomUUID()
  await pool.query(`insert into signoff_packages (id, group_id, cohort_id, purpose, created_by_user_id) values ($1, $2, $3, 'result_confirmation', $4)`, [
    packageId,
    groupId,
    cohortId,
    adminId,
  ])
  const students = members.map((userId, i) => ({ userId, displayName: `交作業生${i + 1}號`, studentNo: `4130000${i}` }))
  await pool.query(
    `insert into signoff_package_versions (id, package_id, version_no, content_text, content_checksum, participants,
                                           created_by_user_id, created_real_at, created_business_at)
     values ($1, $2, 1, $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'), $4::jsonb, $5, now(), now())`,
    [consentId, packageId, 'e2e ST-3 同意書全文', JSON.stringify({ students, advisor: { userId: adminId, displayName: 'e2e 老師' } }), adminId],
  )
  await pool.query(`insert into signoff_version_status (version_id, state) values ($1, 'collecting')`, [consentId])
  await pool.query(`update signoff_packages set current_version_id = $2 where id = $1`, [packageId, consentId])
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

const filters = (page: Page) => page.getByRole('navigation', { name: '篩選作業' })
const cards = (page: Page) => page.getByRole('list', { name: '作業列表' }).getByRole('listitem')

test('AC-ST-09 預設「待交」：標題、三個篩選與數字、四張卡（含尚未開放與同意書）', async ({ page }) => {
  await signIn(page, viewer)
  await page.goto(AFFAIRS)
  await expect(page.getByRole('heading', { level: 1, name: '交作業', exact: true })).toBeVisible()
  await expect(page.getByRole('main').getByText('G07', { exact: true })).toBeVisible()

  const nav = filters(page)
  await expect(nav.getByRole('link')).toHaveCount(3)
  await expect(nav.getByRole('link', { name: /待交\s*4/ })).toHaveAttribute('href', `${AFFAIRS}?tab=open`)
  await expect(nav.getByRole('link', { name: /已交\s*1/ })).toHaveAttribute('href', `${AFFAIRS}?tab=done`)
  await expect(nav.getByRole('link', { name: /逾期\s*2/ })).toHaveAttribute('href', `${AFFAIRS}?tab=overdue`)
  await expect(nav.getByRole('link', { name: /待交/ })).toHaveAttribute('aria-current', 'page')

  await expect(cards(page)).toHaveCount(4)
  for (const key of ['open', 'soon', 'notOpen'] as const) {
    await expect(page.getByTestId(`affair-${ids[key]}`)).toContainText(title(key))
    await expect(page.getByTestId(`affair-${ids[key]}`)).toContainText('作業')
  }
  await expect(page.getByTestId(`affair-${ids.open}`)).toContainText('待交')
  await expect(page.getByTestId(`affair-${ids.open}`)).toContainText(/截止・剩 \d+ 天/)
  await expect(page.getByTestId(`affair-${ids.soon}`)).toContainText('快到期')
  await expect(page.getByTestId(`affair-${ids.notOpen}`)).toContainText('尚未開放')
  await expect(page.getByTestId(`affair-${ids.notOpen}`).locator('[data-tone="neutral"]').first()).toBeVisible()

  const consent = page.getByTestId(`consent-${consentId}`)
  await expect(consent).toContainText('同意書')
  await expect(consent).toContainText('期中結果確認')
  await expect(consent).toContainText('沒有截止日')
  await expect(consent).toContainText('待你同意')
  await expect(consent).toHaveAttribute('href', `/dashboard/student/signoff?version=${consentId}`)

  // 卡片只有種類、標題、截止字、膠囊：沒有表格的「形式」「動作」欄。
  await expect(page.locator('main table')).toHaveCount(0)
  await expect(page.getByRole('main')).not.toContainText('形式')

  // 整組一份的逾期作業：標「整組」。
  await page.goto(`${AFFAIRS}?tab=overdue`)
  await expect(page.getByTestId(`affair-${ids.groupOverdue}`)).toContainText('整組')
  await expect(page.getByTestId(`affair-${ids.overdue}`)).not.toContainText('整組')
})

test('AC-ST-10 逾期／已交篩選、「以前的紀錄」只在已交下方、?tab=all 當待交、空狀態一句', async ({ page }) => {
  await signIn(page, viewer)

  await page.goto(`${AFFAIRS}?tab=overdue`)
  await expect(cards(page)).toHaveCount(2)
  for (const key of ['overdue', 'groupOverdue'] as const) {
    const card = page.getByTestId(`affair-${ids[key]}`)
    await expect(card.locator('.status-pill')).toHaveText('逾期')
    await expect(card.locator('.status-pill')).toHaveAttribute('data-tone', 'overdue')
    await expect(card).toContainText(/逾期 \d+ 天/)
  }
  await expect(page.getByTestId('my-records')).toHaveCount(0)

  await page.goto(`${AFFAIRS}?tab=done`)
  await expect(cards(page)).toHaveCount(1)
  const done = page.getByTestId(`affair-${ids.done}`)
  await expect(done.locator('.status-pill')).toHaveText('已交')
  await expect(done.locator('.status-pill')).toHaveAttribute('data-tone', 'done')
  await expect(done).toContainText('已交第 2 次')
  await expect(page.getByRole('heading', { name: '以前的紀錄' })).toBeVisible()
  await expect(page.getByTestId('my-records')).toContainText(title('removed'))
  await expect(page.getByTestId(`affair-${ids.removed}`)).toHaveCount(0)
  // 「以前的紀錄」在卡片格下方。
  const listBox = await page.getByRole('list', { name: '作業列表' }).boundingBox()
  const recordsBox = await page.getByTestId('my-records').boundingBox()
  expect(recordsBox!.y).toBeGreaterThan(listBox!.y + listBox!.height)

  await page.goto(`${AFFAIRS}?tab=all`)
  await expect(cards(page)).toHaveCount(4)
  await expect(page.getByTestId(`affair-${ids.open}`)).toBeVisible()
  await expect(filters(page).getByRole('link', { name: /待交/ })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('my-records')).toHaveCount(0)

  await page.goto(`${AFFAIRS}?tab=open`)
  await expect(cards(page)).toHaveCount(4)
  await expect(page.getByTestId('my-records')).toHaveCount(0)

  // 空的篩選只有一句。
  await signIn(page, loner)
  await page.goto(`${AFFAIRS}?tab=overdue`)
  await expect(page.getByText('沒有逾期的作業', { exact: true })).toBeVisible()
  await expect(page.getByRole('list', { name: '作業列表' })).toHaveCount(0)
})

test('AC-ST-13 免繳的作業在「已交」、膠囊「免繳」，不在「待交」', async ({ page }) => {
  await signIn(page, loner)
  await page.goto(`${AFFAIRS}?tab=done`)
  await expect(page.getByTestId(`affair-${ids.exempt}`).locator('.status-pill')).toHaveText('免繳')
  await expect(filters(page).getByRole('link', { name: /已交\s*1/ })).toBeVisible()

  await page.goto(`${AFFAIRS}?tab=open`)
  await expect(page.getByTestId(`affair-${ids.exempt}`)).toHaveCount(0)
  await expect(filters(page).getByRole('link', { name: /待交\s*0/ })).toBeVisible()
  await expect(page.getByText('沒有待交的作業', { exact: true })).toBeVisible()
})

test('AC-ST-15 不在任何組別：沒有同意書卡、沒有「請聯絡系辦」、沒有副標組別', async ({ page }) => {
  await signIn(page, loner)
  for (const tab of ['open', 'done', 'overdue']) {
    await page.goto(`${AFFAIRS}?tab=${tab}`)
    await expect(page.locator('[data-testid^="consent-"]')).toHaveCount(0)
    await expect(page.getByRole('main')).not.toContainText('請聯絡系辦')
  }
  await expect(page.getByRole('main').getByText('G07', { exact: true })).toHaveCount(0)
})
