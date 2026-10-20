import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * C3-07：名片卡（C3 設計方案 §4；AC-C3-06～10）。
 *
 * 多數案例走找隊員分頁（`/dashboard/student/groups?tab=team`）的「編輯我的名片」；`/account` 掛上名片卡（C3-17）
 * 用的是同一個視窗，另驗卡片位置、即時更新與老師／系辦沒有這張卡。伺服器端的擋法（直接呼叫用例、老師呼叫回 FORBIDDEN）在 `profile-card-command.integration.test.ts`。
 *
 * - AC-C3-08：同屆 A（公開、有自介與技能）、B（公開、沒自介）、C（未公開）、D（已成組）；E 未分組看名單：只有 A、B 兩張卡，A 在前；
 *   搜尋學號 → 只剩 A、網址有 `?q=`；技能膠囊「前端」→ 網址有 `?skill=`；老師與系辦 403。
 * - AC-C3-06、07：E 編輯名片（即時字數、技能上限、重複技能、太長的技能），存好後卡上與資料庫都更新。
 * - AC-C3-10：D 已成組，能改名片，「公開找隊員」disabled 並寫原因。
 * - AC-C3-09：「邀請加入」連到 `?tab=mine&invite=`，連按累加；E 送出建立組別後每張卡的按鈕 disabled 並寫原因。
 *   「建立組別」表單預填 `invite=` 是 C3-11（「我的組」區塊）的事，這裡只驗連結。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const GROUPS = '/dashboard/student/groups'
const TEAM = `${GROUPS}?tab=team`
const DAY = 86_400_000
const PHONE = '0912000999'

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const now = new Date()

type Student = { userId: string; name: string; studentNo: string; contactEmail: string }

let pool: Pool
let cohortId: string
let adminId: string
let admin: TestSession
let teacher: TestSession
let seeker: TestSession
let grouped: TestSession
let peer: TestSession
let a: Student
let b: Student
let c: Student
let d: Student
let e: Student

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function insertStudent(
  userId: string | null,
  index: number,
  card: { openToJoin?: boolean; bio?: string; skills?: string[] } = {},
): Promise<Student> {
  const studentNo = `416${String(Date.now()).slice(-5)}${index}`
  // 姓名照筆畫排序時 A 本來在 B 後面：A 排第一靠的是「有自介」。
  const name = ['', '黃名片', '王名片', '丙名片', '丁名片', '甲名片'][index]!
  const contactEmail = `card-${stamp.toLowerCase()}-${index}@contact.example.com`
  let id = userId
  if (!id) {
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [name, `card-${stamp.toLowerCase()}-${index}@example.com`],
    )
    id = user.rows[0]!.id
    await pool.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, adminId],
    )
  }
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email, open_to_join,
                                bio, skills, department_class)
     values ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '資管三甲')
     on conflict (user_id) do update set display_name = excluded.display_name, name_normalized = excluded.name_normalized,
       student_no = excluded.student_no, cohort_id = excluded.cohort_id, phone = excluded.phone,
       contact_email = excluded.contact_email, open_to_join = excluded.open_to_join, bio = excluded.bio,
       skills = excluded.skills, department_class = excluded.department_class`,
    [id, name, studentNo, cohortId, PHONE, contactEmail, card.openToJoin ?? false, card.bio ?? '', JSON.stringify(card.skills ?? [])],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { userId: id, name, studentNo, contactEmail }
}

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function setClock(at: Date, reason: string) {
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', $1, now(), $2, $3)`,
    [at, adminId, reason],
  )
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const fresh = async <T,>(run: (context: Awaited<ReturnType<typeof playwrightRequest.newContext>>) => Promise<T>): Promise<T> => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await run(context)
    } finally {
      await context.dispose()
    }
  }
  admin = await fresh((ctx) => sharedTestSession(ctx, 'admin'))
  adminId = admin.userId
  teacher = await fresh((ctx) => createTestSession(ctx, 'teacher'))
  seeker = await fresh((ctx) => createTestSession(ctx, 'student'))
  grouped = await fresh((ctx) => createTestSession(ctx, 'student'))
  peer = await fresh((ctx) => createTestSession(ctx, 'student'))
  await setClock(now, 'e2e C3-07：回到真實時間')

  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind, group_size_min, group_size_max)
     values (gen_random_uuid(), $1, $1, 'active', $2, 'system', 2, 5) returning id`,
    [`C307-${stamp}`, ymd(new Date(now.getTime() + 300 * DAY))],
  )
  cohortId = cohort.rows[0]!.id
  for (const [i, start] of [-10, 30, 90, 150].map((n) => ymd(new Date(now.getTime() + n * DAY))).entries()) {
    await pool.query(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind) values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, ['成組期', '期中', '期末', '成果'][i], start],
    )
  }

  a = await insertStudent(peer.userId, 1, { openToJoin: true, bio: '做過三個 Next.js 專案', skills: ['前端', '資料庫'] })
  b = await insertStudent(null, 2, { openToJoin: true, skills: ['後端'] })
  c = await insertStudent(null, 3, { openToJoin: false, bio: '沒公開', skills: ['前端'] })
  d = await insertStudent(grouped.userId, 4, { openToJoin: true, bio: '已經有組了', skills: ['前端'] })
  e = await insertStudent(seeker.userId, 5)

  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
    [cohortId],
  )
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, now(), 'system', now(), now())`,
    [group.rows[0]!.id, cohortId, d.userId],
  )
})

test.afterAll(async () => {
  if (pool && adminId) await setClock(new Date(), 'e2e C3-07：回到真實時間')
  await pool?.end()
})

async function profileOf(userId: string) {
  const rows = await pool.query<{ bio: string; skills: string[]; open_to_join: boolean; contact_email: string }>(
    'select bio, skills, open_to_join, contact_email from user_profiles where user_id = $1',
    [userId],
  )
  return rows.rows[0]!
}

test('AC-C3-08：名單是名片卡（A、B；C 未公開、D 已成組不在）；有自介的在前；搜尋 ?q=、技能 ?skill=；老師與系辦 403', async ({ page }) => {
  await signIn(page, seeker)
  await page.goto(TEAM)
  const list = page.getByRole('region', { name: '找隊員名單' })
  const cards = list.getByRole('article')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toHaveAccessibleName(a.name)
  await expect(cards.nth(1)).toHaveAccessibleName(b.name)
  await expect(list).not.toContainText(c.name)
  await expect(list).not.toContainText(d.name)

  const cardA = list.getByRole('article', { name: a.name })
  await expect(cardA.locator('img')).toHaveAttribute('width', '64')
  for (const text of [a.studentNo, '資管三甲', '做過三個 Next.js 專案']) await expect(cardA).toContainText(text)
  await expect(cardA.getByRole('list', { name: '技能' }).getByRole('listitem')).toHaveText(['前端', '資料庫'])
  await expect(cardA.getByRole('link', { name: a.contactEmail })).toHaveAttribute('href', `mailto:${a.contactEmail}`)
  await expect(cardA.getByRole('link', { name: '邀請加入' })).toBeVisible()
  await expect(list.getByRole('article', { name: b.name })).toContainText('還沒寫自介')
  expect(await page.content()).not.toContain(PHONE)

  await page.getByRole('searchbox', { name: '搜尋姓名、學號或技能' }).fill(a.studentNo)
  await page.getByRole('button', { name: '搜尋', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`[?&]q=${a.studentNo}`))
  await expect(cards).toHaveCount(1)
  await expect(cards.nth(0)).toHaveAccessibleName(a.name)

  await page.getByRole('searchbox', { name: '搜尋姓名、學號或技能' }).fill('')
  await page.getByRole('navigation', { name: '技能篩選' }).getByRole('link', { name: '前端' }).click()
  await expect(page).toHaveURL(/[?&]skill=%E5%89%8D%E7%AB%AF/)
  await expect(page).not.toHaveURL(/[?&]q=/)
  await expect(cards).toHaveCount(1)
  await expect(cards.nth(0)).toHaveAccessibleName(a.name)
  await page.getByRole('navigation', { name: '技能篩選' }).getByRole('link', { name: '全部' }).click()
  await expect(cards).toHaveCount(2)

  for (const staff of [teacher, admin]) {
    await signIn(page, staff)
    await page.goto(TEAM)
    await expect(page).toHaveURL(/\/403$/)
  }
})

test('AC-C3-07：即時字數、技能上限、重複技能不新增、太長的技能；自介太長送出被擋，資料庫不變', async ({ page }) => {
  await signIn(page, seeker)
  await page.goto(TEAM)
  await page.getByRole('button', { name: '編輯我的名片' }).click()
  const dialog = page.getByRole('dialog', { name: '編輯我的名片' })

  // (a) 51 字：即時字數、送出被擋。
  await dialog.getByLabel('一句話自我介紹').fill('字'.repeat(51))
  await expect(dialog).toContainText('51／50')
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog.getByRole('alert')).toContainText('自介最多 50 字')
  expect((await profileOf(e.userId)).bio).toBe('')
  await dialog.getByLabel('一句話自我介紹').fill('')

  // (c) 跟預設重複、帶空白：不新增、不報錯，只是勾起來。
  const custom = dialog.getByRole('textbox', { name: '自訂技能' })
  const checkboxes = dialog.getByRole('group', { name: /我會什麼/ }).getByRole('checkbox')
  const before = await checkboxes.count()
  await custom.fill(' 前端 ')
  await dialog.getByRole('button', { name: '新增' }).click()
  await expect(checkboxes).toHaveCount(before)
  await expect(dialog.getByRole('checkbox', { name: '前端', exact: true })).toBeChecked()
  await expect(dialog).not.toContainText('最多 8 個技能')
  await dialog.getByRole('checkbox', { name: '前端', exact: true }).uncheck()

  // (d) 13 字。
  await custom.fill('一'.repeat(13))
  await dialog.getByRole('button', { name: '新增' }).click()
  await expect(dialog).toContainText('每個技能最多 12 字')

  // (b) 勾滿 8 個再自訂第 9 個。
  for (const name of ['前端', '後端', '資料庫', '資料分析', 'AI', 'UI 設計', '簡報', '企劃']) await dialog.getByRole('checkbox', { name, exact: true }).check()
  await custom.fill('Figma2')
  await dialog.getByRole('button', { name: '新增' }).click()
  await expect(dialog).toContainText('最多 8 個技能')
  await dialog.getByRole('checkbox', { name: 'Python', exact: true }).click()
  await expect(dialog.getByRole('checkbox', { name: 'Python', exact: true })).not.toBeChecked()
  expect((await profileOf(e.userId)).skills).toEqual([])
})

test('AC-C3-06：存名片（自介、勾「前端」「資料庫」、自訂「Figma」、開公開）→「名片已更新」，開關與資料庫一起更新', async ({ page }) => {
  await signIn(page, seeker)
  await page.goto(TEAM)
  await expect(page.getByText('公開找隊員：未公開')).toBeVisible()
  await page.getByRole('button', { name: '編輯我的名片' }).click()
  const dialog = page.getByRole('dialog', { name: '編輯我的名片' })
  await expect(dialog.getByRole('img', { name: e.name })).toBeVisible()
  await expect(dialog.getByRole('link', { name: '更換頭像' })).toHaveAttribute('href', '/account')
  await dialog.getByLabel('一句話自我介紹').fill('做過三個 Next.js 專案')
  await expect(dialog).toContainText('15／50')
  await dialog.getByRole('checkbox', { name: '前端', exact: true }).check()
  await dialog.getByRole('checkbox', { name: '資料庫', exact: true }).check()
  await dialog.getByRole('textbox', { name: '自訂技能' }).fill('Figma')
  await dialog.getByRole('button', { name: '新增' }).click()
  await expect(dialog.getByRole('checkbox', { name: 'Figma', exact: true })).toBeChecked()
  await expect(dialog.getByLabel('聯絡 Email')).toHaveValue(e.contactEmail)
  await dialog.getByRole('checkbox', { name: '公開找隊員' }).check()
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog.getByRole('status')).toHaveText('名片已更新')
  await expect(page.getByText('公開找隊員：已公開')).toBeVisible()

  expect(await profileOf(e.userId)).toEqual({
    bio: '做過三個 Next.js 專案',
    skills: ['前端', '資料庫', 'Figma'],
    open_to_join: true,
    contact_email: e.contactEmail,
  })

  // 同屆的 A 看得到 E 的新名片。
  await signIn(page, peer)
  await page.goto(TEAM)
  const cardE = page.getByRole('region', { name: '找隊員名單' }).getByRole('article', { name: e.name })
  await expect(cardE).toContainText('做過三個 Next.js 專案')
  await expect(cardE.getByRole('list', { name: '技能' }).getByRole('listitem')).toHaveText(['前端', '資料庫', 'Figma'])
})

test('r1：先按「公開找隊員」開關、再開名片視窗只改自介儲存，公開狀態不變', async ({ page }) => {
  // 頁面載入時是未公開（視窗以未公開的狀態掛上），再按開關打開。
  await pool.query('update user_profiles set open_to_join = false where user_id = $1', [e.userId])
  await signIn(page, seeker)
  await page.goto(TEAM)
  await expect(page.getByText('公開找隊員：未公開')).toBeVisible()
  await page.getByRole('button', { name: '公開找隊員' }).click()
  await expect(page.getByText('公開找隊員：已公開')).toBeVisible()

  await page.getByRole('button', { name: '編輯我的名片' }).click()
  const dialog = page.getByRole('dialog', { name: '編輯我的名片' })
  await expect(dialog.getByRole('checkbox', { name: '公開找隊員' })).toBeChecked()
  await dialog.getByLabel('一句話自我介紹').fill('只改自介')
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog.getByRole('status')).toHaveText('名片已更新')
  expect(await profileOf(e.userId)).toMatchObject({ bio: '只改自介', open_to_join: true })
  await page.reload()
  await expect(page.getByText('公開找隊員：已公開')).toBeVisible()
})

test('AC-C3-10：已成組的 D 能改名片，「公開找隊員」disabled 並寫原因', async ({ page }) => {
  await signIn(page, grouped)
  await page.goto(TEAM)
  await expect(page.getByRole('main')).toContainText('組別已成立，名單在「我的組」')
  await page.getByRole('button', { name: '編輯我的名片' }).click()
  const dialog = page.getByRole('dialog', { name: '編輯我的名片' })
  await expect(dialog.getByRole('checkbox', { name: '公開找隊員' })).toBeDisabled()
  await expect(dialog).toContainText('已經有組別，不會出現在找隊員名單')
  await dialog.getByLabel('一句話自我介紹').fill('換組時再找我')
  await dialog.getByRole('checkbox', { name: '後端', exact: true }).check()
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog.getByRole('status')).toHaveText('名片已更新')
  expect(await profileOf(d.userId)).toMatchObject({ bio: '換組時再找我', skills: ['前端', '後端'], open_to_join: false })
})

test('AC-C3-06（/account）：學生「我的名片」在「基本資料」之後，改完卡上即時更新；老師、系辦沒有這張卡', async ({ page }) => {
  await signIn(page, seeker)
  await page.goto('/account')
  const card = page.getByRole('region', { name: '我的名片' })
  await expect(card).toBeVisible()
  // 卡片順序：頭像 → 基本資料 → 我的名片 → 登入方式。
  const order = await page
    .getByRole('main')
    .locator('section')
    .evaluateAll((els) => els.map((el) => el.querySelector('h2')?.textContent?.trim() ?? ''))
  expect(order.filter((n) => ['頭像', '基本資料', '我的名片', '登入方式'].includes(n))).toEqual(['頭像', '基本資料', '我的名片', '登入方式'])
  await expect(card.getByRole('article', { name: e.name }).locator('img')).toHaveAttribute('width', '64')
  for (const text of [e.name, '資管三甲', e.contactEmail, '公開找隊員：已公開']) await expect(card).toContainText(text)

  // 聯絡 Email 只在「基本資料」改（C3-17 ESCALATE 2）：整頁只有一個這個標籤的欄位，名片視窗只放一行說明。
  await expect(page.getByLabel('聯絡 Email', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('region', { name: '基本資料' }).getByLabel('聯絡 Email', { exact: true })).toHaveValue(e.contactEmail)

  await card.getByRole('button', { name: '編輯我的名片' }).click()
  const dialog = page.getByRole('dialog', { name: '編輯我的名片' })
  await expect(dialog).toContainText('聯絡 Email 在上面「基本資料」改')
  await expect(dialog.getByRole('textbox', { name: '聯絡 Email' })).toHaveCount(0)
  await dialog.getByLabel('一句話自我介紹').fill('在帳號頁改的')
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog.getByRole('status')).toHaveText('名片已更新')
  await page.keyboard.press('Escape')
  await expect(card).toContainText('在帳號頁改的')
  expect(await profileOf(e.userId)).toMatchObject({ bio: '在帳號頁改的', contact_email: e.contactEmail })

  for (const staff of [teacher, admin]) {
    await signIn(page, staff)
    await page.goto('/account')
    await expect(page.getByRole('heading', { name: '我的帳號' })).toBeVisible()
    await expect(page.getByRole('region', { name: '我的名片' })).toHaveCount(0)
  }
})

test('AC-C3-09：「邀請加入」連到 ?tab=mine&invite=，連按累加；送出建立組別後每張卡 disabled 並寫原因', async ({ page }) => {
  await signIn(page, seeker)
  await page.goto(TEAM)
  const list = page.getByRole('region', { name: '找隊員名單' })
  await list.getByRole('article', { name: a.name }).getByRole('link', { name: '邀請加入' }).click()
  await expect(page).toHaveURL(new RegExp(`\\?tab=mine&invite=${a.studentNo}$`))

  await page.goto(`${TEAM}&invite=${a.studentNo}`)
  await expect(list.getByRole('article', { name: b.name }).getByRole('link', { name: '邀請加入' })).toHaveAttribute(
    'href',
    `${GROUPS}?tab=mine&invite=${a.studentNo},${b.studentNo}`,
  )
  // 已經在清單裡的人：連結不重複加。
  await expect(list.getByRole('article', { name: a.name }).getByRole('link', { name: '邀請加入' })).toHaveAttribute(
    'href',
    `${GROUPS}?tab=mine&invite=${a.studentNo}`,
  )

  // E 送出建立組別（C3-11 起表單在「我的組」）。
  await page.goto(`${GROUPS}?tab=mine`)
  const status = page.getByRole('region', { name: '我的組別狀態' })
  await status.getByRole('radio', { name: '一般專題' }).check()
  await page.getByLabel(/^同學 1 的學號/).fill(a.studentNo)
  await status.getByRole('button', { name: '送出邀請' }).click()
  await expect(status).toContainText('建立中（等全員確認）')

  await page.goto(TEAM)
  const cards = list.getByRole('article')
  await expect(cards).toHaveCount(2)
  for (const card of await cards.all()) {
    await expect(card.getByRole('button', { name: '邀請加入' })).toBeDisabled()
    await expect(card).toContainText('你已送出建立組別，等大家確認後再邀請')
    await expect(card.getByRole('link', { name: '邀請加入' })).toHaveCount(0)
  }
})
