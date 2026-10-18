import { expect, request as playwrightRequest, test, type Locator, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { fillItemBody } from './item-body'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestRole, type TestSession } from './session'

/**
 * 學生規格 ST-6：前台「專題時程」`/timeline`（AC-ST-20、21、22、28）。
 *
 * 1. 學生：前台外殼（頂部導覽沒有「專題時程」）、屆別字、階段軌四段（現在＋還有 N 天＋說明）、整月行事曆
 *    （活動、已取消、截止；只給老師的不出現）、右欄「M 月」清單與「這天的行程」、翻月。
 * 2. 訪客導登入頁；老師與系辦看到預設工作屆別的階段軌與活動（含只給老師的），沒有任何截止。
 * 3. 本屆沒有時程：一句「本屆時程還沒設定」，月曆仍可翻。
 * 4. 改期、取消、改截止：同一來源，只出現在新日期、不重複；取消的留在原日期標「已取消」。
 *
 * 日期都從「現在」往後算（不撥模擬鐘）；翻月一律讀畫面上的年月再算差。
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
/** `2026-08-26` → `8 月`（右欄清單的名字）。 */
const monthLabel = (date: string) => `${Number(date.slice(5, 7))} 月`

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

/** 月曆翻到 `date` 那個月（讀畫面上的年月再算差，不假設從哪個月開始）。 */
async function showMonth(calendar: Locator, date: string) {
  const heading = calendar.getByText(/^\d{4} 年 \d{1,2} 月$/)
  const [shownY, shownM] = ((await heading.innerText()).match(/\d+/g) ?? []).map(Number)
  const [y, m] = date.split('-').map(Number)
  const diff = (y! - shownY!) * 12 + (m! - shownM!)
  for (let i = 0; i < Math.abs(diff); i += 1) await calendar.getByRole('button', { name: diff > 0 ? '下個月' : '上個月' }).click()
  await expect(heading).toHaveText(`${y} 年 ${m} 月`)
}

/** 右欄「M 月」清單裡標題是 `title` 的列。 */
function monthRow(calendar: Locator, date: string, title: string) {
  return calendar.getByRole('list', { name: monthLabel(date), exact: true }).getByRole('listitem').filter({ hasText: title })
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
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.getByLabel('標題', { exact: true }).fill(SUBMISSION)
  await fillItemBody(page, '請上傳期中報告 PDF。')
  await page.getByLabel('顯示在哪一區', { exact: true }).selectOption('submission')
  await page.getByRole('radio', { name: '整組一份', exact: true }).check()
  await page.getByLabel('誰看得到').selectOption('groups')
  await page.getByRole('checkbox', { name: /G01/ }).check()
  await page.getByLabel('所屬階段').selectOption({ index: 1 })
  await page.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(at(DUE_DAY)))
  await page.getByLabel('要新增的欄位類型').selectOption('file')
  await page.getByRole('button', { name: '新增欄位' }).click()
  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await expect(check.locator('[data-ok="no"]')).toHaveCount(0)
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toContainText('需要繳交的名單 1 組')
  itemId = String((await pool.query<{ id: string }>('select id from managed_items where title = $1', [SUBMISSION])).rows[0]!.id)
})

test('AC-ST-20 學生：前台外殼、屆別、階段軌、整月行事曆（活動／已取消／截止，只給老師的不出現）', async ({ page }) => {
  await signIn(page, student)
  const response = await page.goto('/timeline')
  expect(response?.status()).toBe(200)

  // 前台外殼（不是後台側欄），頂部導覽沒有「專題時程」（Q125）。
  await expect(page.getByRole('navigation', { name: '後台導覽' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '主導覽' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主導覽' })).not.toContainText('專題時程')
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

  // 月曆一開始是今天那個月。
  const calendar = page.getByTestId('student-calendar')
  const today = ymd(new Date())
  await expect(calendar.getByText(/^\d{4} 年 \d{1,2} 月$/)).toHaveText(`${Number(today.slice(0, 4))} 年 ${Number(today.slice(5, 7))} 月`)
  await expect(calendar).toContainText('截止')
  await expect(calendar).toContainText('活動')
  await expect(calendar).toContainText('競賽')

  // A：活動標記與右欄「活動」；D：灰色標記與「已取消」；B 不出現。
  const aDay = ymd(at(A_DAY))
  await showMonth(calendar, aDay)
  await expect(monthRow(calendar, aDay, ACTIVITY_A)).toHaveCount(1)
  await expect(monthRow(calendar, aDay, ACTIVITY_A)).toContainText('活動')
  await expect(calendar.getByRole('button', { name: new RegExp(`^${aDay}`) }).locator('[data-tone="event"]')).toHaveCount(1)
  // B 跟 A 同一天：在 A 那個月顯示中驗，否定斷言才不會空轉。
  await expect(page.getByRole('main')).not.toContainText(ACTIVITY_B)
  const dDay = ymd(at(D_DAY))
  await showMonth(calendar, dDay)
  await expect(monthRow(calendar, dDay, ACTIVITY_D)).toContainText('已取消')
  await expect(calendar.getByRole('button', { name: new RegExp(`^${dDay}`) }).locator('[data-tone="canceled"]')).toHaveCount(1)

  // 截止：那個月的右欄有「期中報告」標「截止」；點那天，「這天的行程」只列當天。
  const dueDay = ymd(at(DUE_DAY))
  await showMonth(calendar, dueDay)
  await expect(monthRow(calendar, dueDay, SUBMISSION)).toContainText('截止')
  await expect(calendar.getByRole('button', { name: new RegExp(`^${dueDay}`) }).locator('[data-tone="deadline"]')).toHaveCount(1)
  await calendar.getByRole('button', { name: new RegExp(`^${dueDay}`) }).click()
  const day = calendar.getByRole('list', { name: '這天的行程' })
  await expect(day.getByRole('listitem')).toHaveCount(1)
  await expect(day).toContainText(SUBMISSION)
  await expect(day).not.toContainText(ACTIVITY_A)
  await expect(day.getByRole('link')).toHaveAttribute('href', `/dashboard/student/affairs/${itemId}`)

  // 下個月：格子換月、右欄換月份名、選的那天收起來。
  const [y, m] = dueDay.split('-').map(Number) as [number, number]
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }
  await calendar.getByRole('button', { name: '下個月' }).click()
  await expect(calendar.getByText(/^\d{4} 年 \d{1,2} 月$/)).toHaveText(`${next.y} 年 ${next.m} 月`)
  await expect(calendar.getByRole('heading', { name: `${next.m} 月`, exact: true })).toBeVisible()
  await expect(calendar.getByRole('list', { name: '這天的行程' })).toHaveCount(0)
})

test('AC-ST-21 訪客導登入頁；老師與系辦看到預設工作屆別的階段軌與活動（含只給老師的），沒有截止', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/timeline')
  await expect(page).toHaveURL(/\/login\?next=%2Ftimeline$/)

  previousDefaultWorking = (await pool.query<{ id: string }>('select id from cohorts where is_default_working')).rows[0]?.id ?? null
  defaultTouched = true
  await pool.query('update cohorts set is_default_working = false where is_default_working')
  await pool.query('update cohorts set is_default_working = true where id = $1', [cohortId])

  const aDay = ymd(at(A_DAY))
  for (const role of ['teacher', 'admin'] as const) {
    await signInAs(page, role)
    const response = await page.goto('/timeline')
    expect(response?.status(), role).toBe(200)
    await expect(page.getByRole('main')).toContainText(COHORT_NAME)
    await expect(page.getByRole('list', { name: '本屆階段' }).getByRole('listitem')).toHaveCount(4)
    const calendar = page.getByTestId('student-calendar')
    await showMonth(calendar, aDay)
    await expect(monthRow(calendar, aDay, ACTIVITY_A)).toHaveCount(1)
    await expect(monthRow(calendar, aDay, ACTIVITY_B)).toHaveCount(1)
    // 學生截止（Q125 B 案、B15）：截止那個月有期中報告、標「學生截止」，連到老師／系辦的公告與作業列表。
    const dueDay = ymd(at(DUE_DAY))
    await showMonth(calendar, dueDay)
    await expect(monthRow(calendar, dueDay, SUBMISSION)).toContainText('學生截止')
    await expect(monthRow(calendar, dueDay, SUBMISSION).getByRole('link')).toHaveAttribute('href', role === 'admin' ? `/dashboard/admin/affairs?cohort=${cohortId}&placement=all` : '/dashboard/teacher/affairs')
  }
})

test('AC-ST-22 本屆沒有時程：一句「本屆時程還沒設定」，月曆仍可翻', async ({ page }) => {
  await signIn(page, emptyStudent)
  const response = await page.goto('/timeline')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('main')).toContainText('本屆時程還沒設定')
  await expect(page.getByRole('list', { name: '本屆階段' })).toHaveCount(0)
  const calendar = page.getByTestId('student-calendar')
  const heading = calendar.getByText(/^\d{4} 年 \d{1,2} 月$/)
  const before = await heading.innerText()
  await calendar.getByRole('button', { name: '下個月' }).click()
  await expect(heading).not.toHaveText(before)
  await calendar.getByRole('button', { name: '上個月' }).click()
  await expect(heading).toHaveText(before)
})

test('AC-ST-28 改期、取消、改截止：同一來源只出現在新日期，取消的留原日期標「已取消」；首頁下一件同步', async ({ page }) => {
  await signIn(page, student)
  const calendar = page.getByTestId('student-calendar')
  const oldDay = ymd(at(A_DAY))
  const newDay = ymd(at(A_DAY + 7))

  // 1. 系辦把 A 改期（同一筆活動、revision 加一）。
  await pool.query('update project_events set starts_at = $2, revision = revision + 1, updated_at = now() where id = $1', [
    activityIds[ACTIVITY_A],
    at(A_DAY + 7),
  ])
  await page.goto('/timeline')
  await showMonth(calendar, newDay)
  await expect(monthRow(calendar, newDay, ACTIVITY_A)).toHaveCount(1)
  await calendar.getByRole('button', { name: new RegExp(`^${newDay}`) }).click()
  await expect(calendar.getByRole('list', { name: '這天的行程' })).toContainText(ACTIVITY_A)
  await showMonth(calendar, oldDay)
  await calendar.getByRole('button', { name: new RegExp(`^${oldDay}`) }).click()
  await expect(calendar.getByRole('list', { name: '這天的行程' })).toHaveCount(0)
  await expect(calendar).toContainText('這天沒有截止或活動。')

  // 2. 系辦把 A 取消：仍在新日期、標「已取消」、灰色。
  await pool.query("update project_events set status = 'cancelled', revision = revision + 1, updated_at = now() where id = $1", [
    activityIds[ACTIVITY_A],
  ])
  await page.goto('/timeline')
  await showMonth(calendar, newDay)
  await expect(monthRow(calendar, newDay, ACTIVITY_A)).toHaveCount(1)
  await expect(monthRow(calendar, newDay, ACTIVITY_A)).toContainText('已取消')
  await expect(calendar.getByRole('button', { name: new RegExp(`^${newDay}`) }).locator('[data-tone="canceled"]')).toHaveCount(1)
  await calendar.getByRole('button', { name: new RegExp(`^${newDay}`) }).click()
  await expect(calendar.getByRole('list', { name: '這天的行程' })).toContainText('已取消')

  // 3. 系辦把期中報告截止往後兩天：只在新日期，原日期沒有；首頁「下一件」同步。
  const oldDue = ymd(at(DUE_DAY))
  const newDueAt = at(DUE_DAY + 2)
  const newDue = ymd(newDueAt)
  await pool.query('update managed_items set due_at = $2, deadline_version = deadline_version + 1 where id = $1', [itemId, newDueAt])
  await page.goto('/timeline')
  await showMonth(calendar, newDue)
  await expect(monthRow(calendar, newDue, SUBMISSION)).toHaveCount(1)
  await calendar.getByRole('button', { name: new RegExp(`^${newDue}`) }).click()
  await expect(calendar.getByRole('list', { name: '這天的行程' })).toContainText(SUBMISSION)
  await showMonth(calendar, oldDue)
  await calendar.getByRole('button', { name: new RegExp(`^${oldDue}`) }).click()
  await expect(calendar.getByRole('list', { name: '這天的行程' })).toHaveCount(0)

  // 首頁現在寫 `10-27 截止`，ST-2 換新橫幅後是 `10/27 截止`：兩種寫法都認，只看日期跟著變。
  await page.goto('/dashboard/student')
  const [, mm, dd] = newDue.split('-').map(Number)
  await expect(page.getByTestId('hero-next')).toContainText(new RegExp(`0?${mm}[/-]0?${dd} 截止`))
})
