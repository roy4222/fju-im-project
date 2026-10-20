import { expect, request as playwrightRequest, test, type Locator, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createItemOnPage } from './create-item'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestRole, type TestSession } from './session'

/**
 * 學生規格 ST-6：前台「專題時程」`/timeline`（AC-ST-20、21、22、28；規格③ AC-C3-41 改成唯讀甘特＋清單）。
 *
 * 1. 學生（1280 寬）：前台外殼（頂部導覽有「專題時程」，C3-17）、屆別字、階段軌四段（現在＋還有 N 天＋說明）、
 *    唯讀甘特（`mode=view`：沒有把手、橫條是連到清單的 `<a>`、沒有右鍵選單；只給老師的不出現；自己組的截止菱形
 *    連到作業）、活動清單（依月份分組，已取消的劃掉）；沒有整月行事曆。390 寬：沒有甘特、甘特 chunk 不下載，只有清單。
 * 2. 訪客導登入頁；老師與系辦看到預設工作屆別的階段軌與活動（含只給老師的）與「學生截止」。
 * 3. 本屆沒有時程：一句「本屆時程還沒設定」，沒有甘特、清單仍在。
 * 4. 改期、取消、改截止：同一來源，只出現在新日期、不重複；取消的甘特不畫、清單裡劃掉標「已取消」。
 *
 * 日期都從「現在」往後算（不撥模擬鐘）。
 * 老師視角要把「後台預設查看的屆別」暫時指到本檔的屆別，結束時還原——這是全域旗標，跟 `timeline.spec`、
 * `cohorts.spec` 平行跑會互踩，本機請單獨跑這個檔（CI 是 1 個 worker）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `ST6-${stamp}`
const COHORT_NAME = `${CODE} 114 學年度（2026–2027）`
const EMPTY_CODE = `ST6E-${stamp}`
const ACTIVITY_A = `${CODE} 專題說明會 A`
const ACTIVITY_B = `${CODE} 老師會議 B`
const ACTIVITY_D = `${CODE} 已取消的工作坊 D`
const SUBMISSION = `${CODE} 期中報告`
const STAGES = ['分組階段', '期中', '期末', '成果'] as const
const DAY = 86_400_000

/** 從現在算第 n 天（臺灣日期）。 */
const at = (n: number) => new Date(Date.now() + n * DAY)
function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}
function localMinute(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16)
}
/** `2026-08-26` → `8 月`（活動清單每個月份那一組的名字）。 */
const monthLabel = (date: string) => `${Number(date.slice(5, 7))} 月`
/** `2026-08-26` → `8/26`（甘特的 aria-label 寫法）。 */
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`

let pool: Pool
let cohortId = ''
let emptyCohortId = ''
let student: TestSession
let emptyStudent: TestSession
let itemId = ''
const activityIds: Record<string, string> = {}
/** 活動 A +3 天、D +5 天、期中報告 +9 天截止（改期／改截止在 AC-ST-28 再往後推）。 */
const A_DAY = 3
const D_DAY = 5
const DUE_DAY = 9
let previousDefaultWorking: string | null = null
let defaultTouched = false

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function signInAs(page: Page, role: TestRole) {
  await page.context().clearCookies()
  const session = await sharedTestSession(page.request, role)
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function enrol(session: TestSession, cohort: string, name: string) {
  const studentNo = `417${String(Date.now()).slice(-6)}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set student_no = excluded.student_no, cohort_id = excluded.cohort_id`,
    [session.userId, name, studentNo, cohort, `st6-${studentNo}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohort, studentNo, session.userId])
}

async function newCohort(code: string, name: string): Promise<string> {
  return String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $2, 'active', $3, 'system') returning id`,
        [code, name, ymd(at(300))],
      )
    ).rows[0]!.id,
  )
}

/** 活動清單裡 `date` 那個月份的一組中，標題是 `title` 的列。 */
function monthRow(page: Page, date: string, title: string) {
  return activityList(page).getByRole('list', { name: monthLabel(date), exact: true }).getByRole('listitem').filter({ hasText: title })
}

function activityList(page: Page): Locator {
  return page.getByRole('region', { name: '活動清單' })
}

function ganttBar(page: Page, title: string): Locator {
  return page.getByTestId('gantt').getByTestId('gantt-bar').filter({ hasText: title })
}

/** 記下這頁載過的 JS／CSS 裡有沒有甘特（`gantt-today` 只出現在甘特元件與它的 stylesheet）。 */
function watchGanttAssets(page: Page): () => Promise<boolean> {
  const bodies: Promise<string>[] = []
  page.on('response', (response) => {
    const type = response.request().resourceType()
    if (type === 'script' || type === 'stylesheet') bodies.push(response.text().catch(() => ''))
  })
  return async () => (await Promise.all(bodies)).some((body) => body.includes('gantt-today'))
}

test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e ST-6：回到真實時間')`,
    [admin.userId],
  )

  cohortId = await newCohort(CODE, COHORT_NAME)
  // 第 1 段從 10 天前開始、第 2 段在第 19 天開始 → 第 1 段的最後一天是第 18 天：「還有 18 天」。
  for (const [i, d] of [-10, 19, 90, 150].entries()) {
    await pool.query(
      `insert into cohort_stages (id, cohort_id, seq, name, description, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, 'system')`,
      [cohortId, i + 1, STAGES[i], `${STAGES[i]}的說明`, ymd(at(d))],
    )
  }
  emptyCohortId = await newCohort(EMPTY_CODE, `${EMPTY_CODE} 沒有時程`)

  // 一人一個 context：帶著上一位的 session cookie 去註冊會被 Better Auth 當跨站請求擋掉。
  for (const which of ['student', 'empty'] as const) {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    const session = await createTestSession(context, 'student')
    await context.dispose()
    if (which === 'student') student = session
    else emptyStudent = session
  }
  await enrol(student, cohortId, '時程學生')
  await enrol(emptyStudent, emptyCohortId, '沒有時程的學生')
  const groupId = String(
    (
      await pool.query<{ id: string }>(
        `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
         values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
        [cohortId],
      )
    ).rows[0]!.id,
  )
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
     values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
    [groupId, cohortId, student.userId],
  )

  // 活動 A（所有登入的人）、B（只給老師）、D（已取消）。活動的建立與改期 UI 是系辦的範圍（timeline.spec），這裡直接插。
  for (const [title, day, audience, status] of [
    [ACTIVITY_A, A_DAY, 'signed_in', 'scheduled'],
    [ACTIVITY_B, A_DAY, 'teachers', 'scheduled'],
    [ACTIVITY_D, D_DAY, 'cohort_students', 'cancelled'],
  ] as const) {
    activityIds[title] = String(
      (
        await pool.query<{ id: string }>(
          `insert into project_events (id, cohort_id, title, starts_at, all_day, audience_kind, status, created_by_kind, created_at, updated_at)
           values (gen_random_uuid(), $1, $2, $3, false, $4, $5, 'system', now(), now()) returning id`,
          [cohortId, title, at(day), audience, status],
        )
      ).rows[0]!.id,
    )
  }
})

test.afterAll(async () => {
  if (defaultTouched) {
    await pool.query('update cohorts set is_default_working = false where id = $1', [cohortId])
    if (previousDefaultWorking) await pool.query('update cohorts set is_default_working = true where id = $1', [previousDefaultWorking])
  }
  await pool?.end()
})

test('系辦發一份 G01 要交的「期中報告」（9 天後截止）', async ({ page }) => {
  test.setTimeout(120_000)
  await signInAs(page, 'admin')
  // C1-06 共用表單：沒有所屬階段；預設已有一個檔案欄。
  itemId = await createItemOnPage(page, cohortId, {
    placement: 'submission',
    title: SUBMISSION,
    body: '請上傳期中報告 PDF。',
    unit: '整組一份',
    audience: 'groups',
    groups: ['G01'],
    dueAt: localMinute(at(DUE_DAY)),
  })
})

test('AC-ST-20／AC-C3-41 學生 1280：前台外殼、屆別、階段軌、唯讀甘特（只給老師的不出現、自己的截止）、活動清單', async ({ page }) => {
  await signIn(page, student)
  await page.setViewportSize({ width: 1280, height: 900 })
  const ganttLoaded = watchGanttAssets(page)
  const response = await page.goto('/timeline')
  expect(response?.status()).toBe(200)

  // 前台外殼（不是後台側欄），頂部導覽有「專題時程」（C3 AC-C3-42 取代 Q125）。
  await expect(page.getByRole('navigation', { name: '後台導覽' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '主導覽' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主導覽' })).toContainText('專題時程')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('專題時程')
  await expect(page.getByRole('navigation', { name: '麵包屑' })).toContainText('專題時程')
  await expect(page.getByRole('main')).toContainText(COHORT_NAME)

  // 階段軌：四段，第 1 段「現在」＋「還有 18 天」，每段有說明。
  const rail = page.getByRole('list', { name: '本屆階段' })
  await expect(rail.getByRole('listitem')).toHaveCount(4)
  const current = rail.getByRole('listitem').filter({ hasText: STAGES[0] })
  await expect(current).toContainText('現在')
  await expect(current).toContainText('還有 18 天')
  for (const name of STAGES) await expect(rail.getByRole('listitem').filter({ hasText: name })).toContainText(`${name}的說明`)

  // 唯讀甘特：mode=view、沒有把手、沒有整月行事曆與翻月。
  const gantt = page.getByTestId('gantt')
  await expect(gantt).toHaveAttribute('data-mode', 'view')
  await expect(gantt.getByTestId('gantt-handle')).toHaveCount(0)
  await expect(page.getByTestId('student-calendar')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '下個月' })).toHaveCount(0)
  expect(await ganttLoaded()).toBe(true)
  // 階段卡在甘特上面，甘特在清單上面。
  const top = async (locator: Locator) => (await locator.boundingBox())!.y
  expect(await top(rail)).toBeLessThan(await top(gantt))
  expect(await top(gantt)).toBeLessThan(await top(activityList(page)))

  // A：橫條是連到清單那一列的 <a>；右鍵沒有選單。D 已取消：甘特不畫，清單劃掉標「已取消」。B 不出現。
  const aDay = ymd(at(A_DAY))
  const barA = ganttBar(page, ACTIVITY_A)
  await expect(barA).toHaveCount(1)
  expect(await barA.evaluate((el) => el.tagName)).toBe('A')
  await expect(barA).toHaveAttribute('href', `#activity-${activityIds[ACTIVITY_A]}`)
  await expect(barA).toHaveAttribute('aria-label', new RegExp(`^${ACTIVITY_A}，${md(aDay)} `))
  await barA.click({ button: 'right' })
  await expect(page.getByTestId('gantt-menu')).toHaveCount(0)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await barA.click()
  await expect(page).toHaveURL(new RegExp(`#activity-${activityIds[ACTIVITY_A]}$`))
  await expect(monthRow(page, aDay, ACTIVITY_A)).toHaveCount(1)
  await expect(monthRow(page, aDay, ACTIVITY_A)).toContainText('活動')
  await expect(monthRow(page, aDay, ACTIVITY_A)).toHaveAttribute('id', `activity-${activityIds[ACTIVITY_A]}`)
  await expect(page.getByRole('main')).not.toContainText(ACTIVITY_B)
  const dDay = ymd(at(D_DAY))
  await expect(ganttBar(page, ACTIVITY_D)).toHaveCount(0)
  await expect(monthRow(page, dDay, ACTIVITY_D)).toContainText('已取消')
  await expect(monthRow(page, dDay, ACTIVITY_D).getByText(ACTIVITY_D)).toHaveCSS('text-decoration-line', 'line-through')

  // 截止：甘特的菱形連到自己那份作業；清單那個月有「期中報告」標「截止」。
  const dueDay = ymd(at(DUE_DAY))
  const diamond = gantt.getByRole('link', { name: `作業截止：${SUBMISSION}，${md(dueDay)}`, exact: true })
  await expect(diamond).toHaveAttribute('data-testid', 'gantt-deadline')
  await expect(diamond).toHaveAttribute('href', `/dashboard/student/affairs/${itemId}`)
  await expect(monthRow(page, dueDay, SUBMISSION)).toContainText('截止')
  await expect(monthRow(page, dueDay, SUBMISSION).getByRole('link')).toHaveAttribute('href', `/dashboard/student/affairs/${itemId}`)
})

test('AC-C3-41 學生 390（手機）：沒有甘特、甘特 chunk 不下載；階段卡＋依月份分組的清單', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  try {
    const page = await context.newPage()
    await signIn(page, student)
    const ganttLoaded = watchGanttAssets(page)
    const response = await page.goto('/timeline')
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('list', { name: '本屆階段' }).getByRole('listitem')).toHaveCount(4)
    const aDay = ymd(at(A_DAY))
    const dueDay = ymd(at(DUE_DAY))
    await expect(activityList(page).getByRole('heading', { name: monthLabel(aDay), exact: true })).toBeVisible()
    await expect(monthRow(page, aDay, ACTIVITY_A)).toHaveCount(1)
    await expect(monthRow(page, dueDay, SUBMISSION)).toContainText('截止')
    await expect(page.getByRole('main')).not.toContainText(ACTIVITY_B)
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('gantt')).toHaveCount(0)
    expect(await ganttLoaded()).toBe(false)
  } finally {
    await context.close()
  }
})

test('AC-C3-42 主導覽「專題時程」連 /timeline、排在「專題規則」之後；手機抽屜同；訪客沒有', async ({ page }) => {
  const topLinks = (name: string) => page.getByRole('navigation', { name, exact: true }).locator(':scope > div > a')
  await signIn(page, student)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  const labels = await topLinks('主導覽').allTextContents()
  expect(labels.indexOf('專題時程')).toBe(labels.indexOf('專題規則') + 1)
  await expect(topLinks('主導覽').filter({ hasText: '專題時程' })).toHaveAttribute('href', '/timeline')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '開啟選單' }).click()
  const drawer = page.getByRole('navigation', { name: '主導覽（手機）' })
  const drawerLabels = await drawer.getByRole('link').allTextContents()
  expect(drawerLabels.indexOf('專題時程')).toBe(drawerLabels.indexOf('專題規則') + 1)
  await expect(drawer.getByRole('link', { name: '專題時程', exact: true })).toHaveAttribute('href', '/timeline')

  await page.context().clearCookies()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '主導覽', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主導覽', exact: true })).not.toContainText('專題時程')
})

test('AC-ST-21／AC-C3-41 訪客導登入頁；老師與系辦看到預設工作屆別的階段軌、甘特與清單（含只給老師的）與學生截止', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/timeline')
  await expect(page).toHaveURL(/\/login\?next=%2Ftimeline$/)

  previousDefaultWorking = (await pool.query<{ id: string }>('select id from cohorts where is_default_working')).rows[0]?.id ?? null
  defaultTouched = true
  await pool.query('update cohorts set is_default_working = false where is_default_working')
  await pool.query('update cohorts set is_default_working = true where id = $1', [cohortId])

  const aDay = ymd(at(A_DAY))
  await page.setViewportSize({ width: 1280, height: 900 })
  for (const role of ['teacher', 'admin'] as const) {
    await signInAs(page, role)
    const response = await page.goto('/timeline')
    expect(response?.status(), role).toBe(200)
    await expect(page.getByRole('main')).toContainText(COHORT_NAME)
    await expect(page.getByRole('list', { name: '本屆階段' }).getByRole('listitem')).toHaveCount(4)
    await expect(page.getByTestId('gantt')).toHaveAttribute('data-mode', 'view')
    await expect(page.getByTestId('gantt-handle')).toHaveCount(0)
    await expect(ganttBar(page, ACTIVITY_A)).toHaveCount(1)
    await expect(ganttBar(page, ACTIVITY_B)).toHaveCount(1)
    await expect(monthRow(page, aDay, ACTIVITY_A)).toHaveCount(1)
    await expect(monthRow(page, aDay, ACTIVITY_B)).toContainText('只給老師')
    // 學生截止（Q125 B 案、B15）：甘特的「學生截止」列有菱形；清單截止那個月有期中報告、標「學生截止」，連到老師／系辦的公告與作業列表。
    const dueDay = ymd(at(DUE_DAY))
    const href = role === 'admin' ? `/dashboard/admin/affairs?cohort=${cohortId}&placement=all` : '/dashboard/teacher/affairs'
    await expect(page.getByTestId('gantt')).toContainText('學生截止')
    await expect(page.getByTestId('gantt').getByRole('link', { name: `作業截止：${SUBMISSION}，${md(dueDay)}`, exact: true })).toHaveAttribute('href', href)
    await expect(monthRow(page, dueDay, SUBMISSION)).toContainText('學生截止')
    await expect(monthRow(page, dueDay, SUBMISSION).getByRole('link')).toHaveAttribute('href', href)
  }
})

test('AC-ST-22 本屆沒有時程：一句「本屆時程還沒設定」，沒有甘特、清單仍在', async ({ page }) => {
  await signIn(page, emptyStudent)
  await page.setViewportSize({ width: 1280, height: 900 })
  const response = await page.goto('/timeline')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('main')).toContainText('本屆時程還沒設定')
  await expect(page.getByRole('list', { name: '本屆階段' })).toHaveCount(0)
  await expect(activityList(page)).toBeVisible()
  await expect(activityList(page)).toContainText('目前沒有活動或截止。')
  await page.waitForLoadState('networkidle')
  await expect(page.getByTestId('gantt')).toHaveCount(0)
})

test('AC-ST-28 改期、取消、改截止：同一來源只出現在新日期；取消的甘特不畫、清單劃掉標「已取消」；首頁下一件同步', async ({ page }) => {
  await signIn(page, student)
  await page.setViewportSize({ width: 1280, height: 900 })
  const oldDay = ymd(at(A_DAY))
  const newDay = ymd(at(A_DAY + 7))

  // 1. 系辦把 A 改期（同一筆活動、revision 加一）：甘特橫條只在新日期，清單只有一列、在新日期那個月。
  await pool.query('update project_events set starts_at = $2, revision = revision + 1, updated_at = now() where id = $1', [
    activityIds[ACTIVITY_A],
    at(A_DAY + 7),
  ])
  await page.goto('/timeline')
  await expect(ganttBar(page, ACTIVITY_A)).toHaveCount(1)
  await expect(ganttBar(page, ACTIVITY_A)).toHaveAttribute('aria-label', new RegExp(`^${ACTIVITY_A}，${md(newDay)} `))
  await expect(activityList(page).getByRole('listitem').filter({ hasText: ACTIVITY_A })).toHaveCount(1)
  await expect(monthRow(page, newDay, ACTIVITY_A)).toContainText(newDay)
  await expect(monthRow(page, newDay, ACTIVITY_A)).not.toContainText(oldDay)

  // 2. 系辦把 A 取消：甘特不畫；清單仍在新日期、標「已取消」、劃掉。
  await pool.query("update project_events set status = 'cancelled', revision = revision + 1, updated_at = now() where id = $1", [
    activityIds[ACTIVITY_A],
  ])
  await page.goto('/timeline')
  await expect(page.getByTestId('gantt')).toBeVisible()
  await expect(ganttBar(page, ACTIVITY_A)).toHaveCount(0)
  await expect(activityList(page).getByRole('listitem').filter({ hasText: ACTIVITY_A })).toHaveCount(1)
  await expect(monthRow(page, newDay, ACTIVITY_A)).toContainText('已取消')
  await expect(monthRow(page, newDay, ACTIVITY_A).getByText(ACTIVITY_A)).toHaveCSS('text-decoration-line', 'line-through')

  // 3. 系辦把期中報告截止往後兩天：甘特菱形與清單都只在新日期；首頁「下一件」同步。
  const oldDue = ymd(at(DUE_DAY))
  const newDueAt = at(DUE_DAY + 2)
  const newDue = ymd(newDueAt)
  await pool.query('update managed_items set due_at = $2, deadline_version = deadline_version + 1 where id = $1', [itemId, newDueAt])
  await page.goto('/timeline')
  const gantt = page.getByTestId('gantt')
  await expect(gantt.getByRole('link', { name: `作業截止：${SUBMISSION}，${md(newDue)}`, exact: true })).toHaveCount(1)
  await expect(gantt.getByRole('link', { name: `作業截止：${SUBMISSION}，${md(oldDue)}`, exact: true })).toHaveCount(0)
  await expect(activityList(page).getByRole('listitem').filter({ hasText: SUBMISSION })).toHaveCount(1)
  await expect(monthRow(page, newDue, SUBMISSION)).toContainText(newDue)

  // 首頁現在寫 `10-27 截止`，ST-2 換新橫幅後是 `10/27 截止`：兩種寫法都認，只看日期跟著變。
  await page.goto('/dashboard/student')
  const [, mm, dd] = newDue.split('-').map(Number)
  await expect(page.getByTestId('hero-next')).toContainText(new RegExp(`0?${mm}[/-]0?${dd} 截止`))
})
