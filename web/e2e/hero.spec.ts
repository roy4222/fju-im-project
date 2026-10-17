import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie, type TestRole, type TestSession } from './session'

/**
 * 共用 SH-4「現在」橫幅（AC-SH-24a 的正式路由段、AC-SH-68）。
 *
 * 只驗不依賴角色首頁接線的部分：三角色首頁還在傳舊 props（chips、showStages、showProgress、icon、compact），
 * 合併後畫面已是新橫幅——有 `section[aria-label=現在階段]`、`stage-text`、`h1`，沒有階段四格、小格、進度條。
 * `timelineHref`、`trail`、`cta` 要等角色首頁票傳了才驗（AC-SH-24、27～31）。
 *
 * 首頁看「預設工作屆別」（學生看自己所屬的屆別）：這裡建一屆並設成預設，結束時把原本的預設還回去。
 * 本機多 worker 時這支與 cohorts／timeline／admin-home-tiles 都會改這個旗標，請用 --workers=1 跑（CI 是單一 worker）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const CODE = `SH4-${Date.now().toString(36).toUpperCase()}`
const DAY = 86_400_000
const HOMES: Record<TestRole, string> = {
  student: '/dashboard/student',
  teacher: '/dashboard/teacher',
  admin: '/dashboard/admin',
}

let pool: Pool
let cohortId = ''
let previousDefault: string[] = []
const sessions = new Map<TestRole, TestSession>()

/** 臺灣日期 `YYYY-MM-DD`。 */
function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  // 每個角色各用一個沒有 cookie 的 request 註冊（帶著上一個 session cookie 的 POST 會被當跨站請求擋掉）。
  for (const role of ['student', 'teacher', 'admin'] as const) {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    sessions.set(role, await createTestSession(context, role))
    await context.dispose()
  }

  // 一屆、兩個階段（一段在過去、一段在很久以後），不管模擬鐘撥到哪都有「現在」可以說。
  const now = Date.now()
  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
      [CODE, ymd(new Date(now + 3000 * DAY))],
    )
  ).rows[0]!.id
  await pool.query(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '提案', $2, 'system'), (gen_random_uuid(), $1, 2, '期末', $3, 'system')`,
    [cohortId, ymd(new Date(now - 3000 * DAY)), ymd(new Date(now + 1500 * DAY))],
  )
  previousDefault = (await pool.query<{ id: string }>('select id from cohorts where is_default_working')).rows.map((r) => r.id)
  await pool.query('update cohorts set is_default_working = false where is_default_working')
  await pool.query('update cohorts set is_default_working = true where id = $1', [cohortId])

  // 學生要歸屬這一屆，首頁才看得到它。
  const student = sessions.get('student')!
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email, cohort_id)
     values ($1, 'e2e 學生', 'e2e', $2, $3)
     on conflict (user_id) do update set cohort_id = excluded.cohort_id`,
    [student.userId, student.email, cohortId],
  )
})

test.afterAll(async () => {
  if (pool && cohortId) {
    await pool.query('update cohorts set is_default_working = false where id = $1', [cohortId])
    if (previousDefault.length > 0) await pool.query('update cohorts set is_default_working = true where id = any($1::uuid[])', [previousDefault])
  }
  await pool?.end()
})

async function openHome(page: Page, role: TestRole) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(sessions.get(role)!.cookie, BASE_URL)])
  const response = await page.goto(HOMES[role])
  expect(response?.status()).toBe(200)
  return page.getByRole('region', { name: '現在階段' })
}

for (const role of ['student', 'teacher', 'admin'] as const) {
  test(`${role} 首頁：新橫幅的固定鉤子都在，舊的四格、小格、進度條都不見（AC-SH-24a）`, async ({ page }) => {
    const hero = await openHome(page, role)
    await expect(hero).toBeVisible()
    await expect(hero).toHaveClass(/\bhero\b/)
    await expect(hero.getByRole('heading', { level: 1, name: /^歡迎回來，/ })).toBeVisible()
    await expect(hero.getByText('現在', { exact: true })).toBeVisible()
    await expect(hero.getByTestId('stage-text')).toBeVisible()
    await expect(hero.getByTestId('stage-text')).not.toBeEmpty()

    await expect(page.getByRole('list', { name: '本屆階段' })).toHaveCount(0)
    await expect(page.getByTestId('home-pending')).toHaveCount(0)
    await expect(page.getByRole('img', { name: /本屆進度/ })).toHaveCount(0)
    await expect(hero.locator('[style]')).toHaveCount(0)
  })
}

test('老師首頁：橫幅有「看完整時程」→ /timeline 與像素拖尾 hero-trail（AC-SH-55①、AC-TE-09）', async ({ page }) => {
  // 拖尾只在桌機、非觸控、沒開減少動態時掛（預設的 Desktop Chrome 符合）。
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const hero = await openHome(page, 'teacher')
  const timeline = hero.getByRole('link', { name: '看完整時程' })
  await expect(timeline).toHaveAttribute('href', '/timeline')
  await expect(hero.getByTestId('hero-trail')).toHaveCount(1)
  await expect(hero.locator('canvas')).toHaveCount(1)

  // 老師側欄與前台導覽都沒有時程入口：從橫幅實際點得到 /timeline。
  await timeline.click()
  await expect(page).toHaveURL(/\/timeline$/)
  await expect(page.getByRole('heading', { level: 1, name: '專題時程' })).toBeVisible()
})

test('系辦沒有預設屆別：橫幅只說「還沒有設定後台預設查看的屆別。」，不再叫人去「屆別」頁（AC-SH-68）', async ({ page }) => {
  await pool.query('update cohorts set is_default_working = false where is_default_working')
  const hero = await openHome(page, 'admin')
  await expect(hero).toContainText('還沒有設定後台預設查看的屆別。')
  await expect(hero).not.toContainText('「屆別」頁')
  await expect(hero.getByTestId('stage-text')).toHaveCount(0)
})
