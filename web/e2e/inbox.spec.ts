import { writeFileSync } from 'node:fs'
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 12（#223）：背景工作與通知匣。「做完的樣子」逐條走，**背景工作要在跑**（CI 的 e2e-smoke 會起它）：
 *
 * 1. `/api/health` 的 worker 欄有版本與最近的心跳。
 * 2. 系辦在通知匣「發一則測試通知」給 S01 → 幾秒內 S01 的鈴鐺未讀 1、通知匣有這一則；S02 什麼都沒有。
 * 3. S01 單筆標已讀 → 未讀 0；重新登入（新的 session）仍是已讀。
 * 4. 再發兩則（其中一則屬某一屆）→ 屆別篩選只看得到那一則 → 「全部標為已讀」未讀歸零。
 *
 * 全程用真的表單與按鈕；「別人的通知編號標已讀被拒」在整合測試（直接打用例）證明。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'E2e-Password-Correct-9'

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
let pool: Pool
let s01: TestSession
let s02: TestSession
let cohortCode: string

/** 每位學生用自己的 request context 註冊：共用一個的話第二次會帶著第一位的 cookie，被 Better Auth 當成跨站請求擋下。 */
async function freshStudent(role: 'student' | 'teacher' = 'student'): Promise<TestSession> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  try {
    return await createTestSession(context, role)
  } finally {
    await context.dispose()
  }
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  // 兩位全新的學生：未讀數才會從 0 開始算。
  s01 = await freshStudent()
  s02 = await freshStudent()
  cohortCode = `T12-${stamp}`
  await pool.query(`insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system')`, [
    cohortCode,
    `${cohortCode} 通知測試`,
  ])
})

test.afterAll(async () => {
  await pool?.end()
})

async function useCookie(page: Page, cookie: string) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(cookie, BASE_URL)])
}

function feedback(page: Page, role: 'status' | 'alert') {
  return page.getByRole('main').getByRole(role)
}

async function sendTestNotification(page: Page, recipient: TestSession, title: string, cohort?: string) {
  const admin = await sharedTestSession(page.request, 'admin')
  await useCookie(page, admin.cookie)
  await page.goto('/dashboard/admin/inbox')
  await page.getByLabel('收件人', { exact: true }).selectOption({ label: `e2e student（${recipient.email}）` })
  if (cohort) await page.getByLabel('屆別', { exact: true }).selectOption({ label: cohort })
  await page.getByLabel('標題', { exact: true }).fill(title)
  await page.getByRole('button', { name: '發送測試通知' }).click()
  await expect(feedback(page, 'status')).toContainText('已發給')
}

/** 等背景工作把通知投影進來（每 5 秒一輪；最多等 30 秒）。 */
async function waitForItem(page: Page, title: string) {
  await expect
    .poll(
      async () => {
        await page.goto('/dashboard/student/inbox')
        return page.getByTestId('inbox-item').filter({ hasText: title }).count()
      },
      { timeout: 30_000, intervals: [1_000, 2_000] },
    )
    .toBe(1)
}

test('背景工作在跑：/api/health 的 worker 欄有版本與最近的心跳', async ({ request }) => {
  await expect
    .poll(
      async () => {
        const body = (await (await request.get('/api/health')).json()) as { ok: boolean; worker: { version: string | null; lastTickAt: string | null } }
        return body.ok && body.worker.version !== null && body.worker.lastTickAt !== null
          ? Date.now() - Date.parse(body.worker.lastTickAt) < 60_000
          : false
      },
      { timeout: 30_000 },
    )
    .toBe(true)
})

test('系辦發測試通知給 S01：S01 鈴鐺未讀 1、通知匣有這一則；S02 看不到', async ({ page }) => {
  const title = `測試通知 ${stamp} A`
  await sendTestNotification(page, s01, title)

  await useCookie(page, s01.cookie)
  await waitForItem(page, title)
  await expect(page.getByTestId('inbox-bell')).toHaveAccessibleName('通知，1 則未讀')
  await expect(page.getByTestId('inbox-bell-count')).toHaveText('1')
  await expect(page.getByTestId('inbox-item').filter({ hasText: title })).toHaveAttribute('data-read', 'false')

  await useCookie(page, s02.cookie)
  await page.goto('/dashboard/student/inbox')
  await expect(page.getByTestId('inbox-bell')).toHaveAccessibleName('通知，沒有未讀')
  await expect(page.getByTestId('inbox-item')).toHaveCount(0)
  await expect(page.getByText('還沒有通知')).toBeVisible()
})

test('S01 單筆標已讀：未讀變 0；重新登入（新的 session）仍是已讀', async ({ page }) => {
  const title = `測試通知 ${stamp} A`
  await useCookie(page, s01.cookie)
  await page.goto('/dashboard/student/inbox')
  await page.getByRole('button', { name: `把「${title}」標為已讀` }).click()
  await expect(page.getByTestId('inbox-item').filter({ hasText: title })).toHaveAttribute('data-read', 'true')
  await expect(page.getByTestId('inbox-bell')).toHaveAccessibleName('通知，沒有未讀')

  // 真的重新登入一次（另一個乾淨的「裝置」）：拿一張新的 session cookie。
  const device = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const signIn = await device.post('/api/auth/sign-in/email', { data: { email: s01.email, password: PASSWORD } })
  expect(signIn.ok(), await signIn.text()).toBe(true)
  const fresh = (signIn.headers()['set-cookie'] ?? '').split(/,(?=[^;]+=)/)[0]!.split(';')[0]!
  await device.dispose()
  expect(fresh).not.toBe(s01.cookie)
  await useCookie(page, fresh)
  await page.goto('/dashboard/student/inbox')
  await expect(page.getByTestId('inbox-item').filter({ hasText: title })).toHaveAttribute('data-read', 'true')
  await expect(page.getByTestId('inbox-bell')).toHaveAccessibleName('通知，沒有未讀')
})

test('再發兩則（一則屬某一屆）：屆別篩選只看得到那一屆；全部標為已讀後未讀歸零', async ({ page }) => {
  const scoped = `測試通知 ${stamp} B`
  const global = `測試通知 ${stamp} C`
  // 系辦的屆別下拉寫「名稱（代碼）」（驗收 P-01）。
  await sendTestNotification(page, s01, scoped, `${cohortCode} 通知測試（${cohortCode}）`)
  await sendTestNotification(page, s01, global)

  await useCookie(page, s01.cookie)
  await waitForItem(page, scoped)
  await waitForItem(page, global)
  await expect(page.getByTestId('inbox-bell-count')).toHaveText('2')

  // 依屆別篩選。
  await page.getByRole('navigation', { name: '依屆別篩選' }).getByRole('link', { name: `${cohortCode} 通知測試（${cohortCode}）`, exact: true }).click()
  await expect(page).toHaveURL(/cohort=/)
  await expect(page.getByTestId('inbox-item')).toHaveCount(1)
  await expect(page.getByTestId('inbox-item')).toContainText(scoped)
  await page.getByRole('navigation', { name: '依屆別篩選' }).getByRole('link', { name: '全站' }).click()
  await expect(page.getByTestId('inbox-item').filter({ hasText: scoped })).toHaveCount(0)
  await expect(page.getByTestId('inbox-item').filter({ hasText: global })).toHaveCount(1)

  await page.getByRole('navigation', { name: '依屆別篩選' }).getByRole('link', { name: '全部' }).click()
  await expect(page).not.toHaveURL(/cohort=/)
  await expect(page.getByTestId('inbox-item').and(page.locator('[data-read="false"]'))).toHaveCount(2)
  await page.getByRole('button', { name: '全部標為已讀' }).click()
  await expect(feedback(page, 'status')).toContainText('已把 2 則標為已讀')
  await expect(page.getByTestId('inbox-bell')).toHaveAccessibleName('通知，沒有未讀')
  await expect(page.getByTestId('inbox-item').and(page.locator('[data-read="false"]'))).toHaveCount(0)

  // 資料庫裡是真的已讀（不是畫面自己藏起來）。
  const unread = await pool.query(`select count(*)::int as n from notifications where recipient_user_id = $1 and read_at is null`, [s01.userId])
  expect(unread.rows[0].n).toBe(0)
})

/** 一則發布中、公開的公告（通知的來源頁是 `/news/<id>`）。 */
async function publishedNews(title: string, adminId: string): Promise<string> {
  const itemId = (
    await pool.query<{ id: string }>(
      `insert into managed_items
         (id, cohort_id, placement, audience_kind, status, actual_opened_at, title, summary, body_html,
          created_by_kind, created_by_user_id, updated_by_user_id)
       values (gen_random_uuid(), (select id from cohorts where code = $1), 'news', 'public', 'draft', now(), $2, '摘要', '<p>內容</p>', 'user', $3, $3)
       returning id`,
      [cohortCode, title, adminId],
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
  return itemId
}

/** 直接寫一則未讀通知（事件不掛投影列，背景工作不會碰它）。回通知的 id。 */
async function notify(userId: string, title: string, sourceRef: { type: string; id: string }): Promise<string> {
  const rows = await pool.query<{ id: string }>(
    `with event as (
       insert into domain_events (id, type, scope, source_type, source_id, actor_kind, occurred_real_at, occurred_business_at)
       values (gen_random_uuid(), 'item.published', 'global', $3, $4, 'system', now(), now()) returning id
     )
     insert into notifications (id, event_id, recipient_user_id, scope, kind, title, source_ref, created_at)
     select gen_random_uuid(), event.id, $1, 'global', 'system', $2, $5::jsonb, now() from event returning id`,
    [userId, title, sourceRef.type, sourceRef.id, JSON.stringify(sourceRef)],
  )
  return rows.rows[0]!.id
}

async function readAt(...ids: string[]) {
  const rows = await pool.query<{ id: string; read_at: Date | null }>(`select id, read_at from notifications where id = any($1::uuid[])`, [ids])
  return Object.fromEntries(rows.rows.map((r) => [r.id, r.read_at]))
}

test('C2-15（AC-C2-36）：有來源的通知點標題就算已讀並導去來源頁；沒來源的仍要按「標為已讀」；別人的編號被導回自己的收件匣', async ({ page }) => {
  const admin = await sharedTestSession(page.request, 'admin')
  const teacher = await freshStudent('teacher')
  const newsTitle = `C2-15 公告 ${stamp}`
  const newsId = await publishedNews(newsTitle, admin.userId)
  const titleA = `C2-15 有來源 ${stamp} A`
  const titleB = `C2-15 來源已撤回 ${stamp} B`
  const noteA = await notify(s01.userId, titleA, { type: 'item', id: newsId })
  // 來源項目不在了：沒有連結，只顯示標題。
  const noteB = await notify(s01.userId, titleB, { type: 'item', id: crypto.randomUUID() })
  const noteT = await notify(teacher.userId, `C2-15 給老師 ${stamp}`, { type: 'item', id: newsId })
  const noteO = await notify(admin.userId, `C2-15 給系辦 ${stamp}`, { type: 'item', id: newsId })

  // 直接 GET 收件匣：只看不改。A 的標題是按鈕、列上沒有「標為已讀」；B 仍有「標為已讀」；「全部標為已讀」還在。
  await useCookie(page, s01.cookie)
  await page.goto('/dashboard/student/inbox')
  const rowA = page.getByTestId('inbox-item').filter({ hasText: titleA })
  const rowB = page.getByTestId('inbox-item').filter({ hasText: titleB })
  await expect(rowA).toHaveAttribute('data-read', 'false')
  await expect(rowA.getByRole('button', { name: titleA, exact: true })).toBeVisible()
  await expect(rowA.getByRole('link')).toHaveCount(0)
  await expect(rowA.getByRole('button', { name: `把「${titleA}」標為已讀` })).toHaveCount(0)
  await expect(rowB.getByRole('button', { name: `把「${titleB}」標為已讀` })).toBeVisible()
  await expect(page.getByRole('button', { name: '全部標為已讀' })).toBeVisible()
  expect(await readAt(noteA, noteB)).toEqual({ [noteA]: null, [noteB]: null })

  // (c) 換成 S02 的 session、對 A 的編號送點開動作：導回 S02 自己的收件匣，A 不變、S02 沒有多出任何列。
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(s02.cookie, BASE_URL)])
  await rowA.getByRole('button', { name: titleA, exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/student\/inbox$/)
  await expect(page.getByText('還沒有通知')).toBeVisible()
  expect((await readAt(noteA))[noteA]).toBeNull()
  const s02Rows = await pool.query(`select count(*)::int as n from notifications where recipient_user_id = $1`, [s02.userId])
  expect(s02Rows.rows[0].n).toBe(0)

  // (a) S01 點 A 的標題：落在公告頁；回收件匣 A 已讀（不再粗體、沒有「標為已讀」）。(b) B 不碰仍未讀。
  await useCookie(page, s01.cookie)
  await page.goto('/dashboard/student/inbox')
  await rowA.getByRole('button', { name: titleA, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/news/${newsId}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(newsTitle)
  await page.goto('/dashboard/student/inbox')
  await expect(rowA).toHaveAttribute('data-read', 'true')
  await expect(rowA.getByRole('button', { name: titleA, exact: true })).not.toHaveClass(/font-bold/)
  await expect(rowB).toHaveAttribute('data-read', 'false')
  const sql = await pool.query<{ id: string; read_at: Date | null }>(`select id, read_at from notifications where id in ($1, $2)`, [noteA, noteB])
  writeFileSync(test.info().outputPath('C2-15-sql-1.json'), JSON.stringify(sql.rows.map((r) => ({ note: r.id === noteA ? 'A（點過）' : 'B（沒點）', ...r })), null, 2))
  const evidence = Object.fromEntries(sql.rows.map((r) => [r.id, r.read_at]))
  expect(evidence[noteA]).not.toBeNull()
  expect(evidence[noteB]).toBeNull()

  // B 按「標為已讀」才已讀。
  await rowB.getByRole('button', { name: `把「${titleB}」標為已讀` }).click()
  await expect(rowB).toHaveAttribute('data-read', 'true')
  expect((await readAt(noteB))[noteB]).not.toBeNull()

  // (d) 老師、系辦各點自己那則：各落在來源頁、各自那則已讀。
  for (const [who, path, note] of [
    [teacher, '/dashboard/teacher/inbox', noteT],
    [admin, '/dashboard/admin/inbox', noteO],
  ] as const) {
    await useCookie(page, who.cookie)
    await page.goto(path)
    const title = who === teacher ? `C2-15 給老師 ${stamp}` : `C2-15 給系辦 ${stamp}`
    expect((await readAt(note))[note]).toBeNull()
    await page.getByTestId('inbox-item').filter({ hasText: title }).getByRole('button', { name: title, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/news/${newsId}$`))
    expect((await readAt(note))[note]).not.toBeNull()
  }
})
