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

test('系辦首頁：橫幅有像素拖尾 hero-trail（Roy 10/18 新增）', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const hero = await openHome(page, 'admin')
  await expect(hero.getByTestId('hero-trail')).toHaveCount(1)
  await expect(hero.locator('canvas')).toHaveCount(1)
})

test('系辦沒有預設屆別：橫幅只說「還沒有設定後台預設查看的屆別。」，不再叫人去「屆別」頁（AC-SH-68）', async ({ page }) => {
  await pool.query('update cohorts set is_default_working = false where is_default_working')
  const hero = await openHome(page, 'admin')
  await expect(hero).toContainText('還沒有設定後台預設查看的屆別。')
  await expect(hero).not.toContainText('「屆別」頁')
  await expect(hero.getByTestId('stage-text')).toHaveCount(0)
})

test('老師首頁：三種待辦都在時，1280 寬四欄的卡片標題不截斷（C2-18）', async ({ page }) => {
  const { userId } = sessions.get('teacher')!
  const [gid, scheme, version, pack, pv, item, iv, fv] = await Promise.all(Array.from({ length: 8 }, () => pool.query<{ id: string }>('select gen_random_uuid() id').then((r) => r.rows[0]!.id)))
  const run = async (sql: string, params: unknown[]) => void (await pool.query(sql, params))
  const stageId = (await pool.query<{ id: string }>('select id from cohort_stages where cohort_id = $1 and seq = 1', [cohortId])).rows[0]!.id
  await run(`insert into groups(id,cohort_id,code,group_type,established_real_at,established_business_at,created_by_kind) values($1,$2,'T01','general',now(),now(),'system')`, [gid, cohortId])
  await run(`insert into advisor_assignments(id,group_id,teacher_user_id,source,valid_from,assigned_by_user_id,reason) values(gen_random_uuid(),$1,$2,'admin',now(),$2,'C2-18 fixture')`, [gid, userId])
  await run(`insert into grading_schemes(id,cohort_id,name,created_by_kind) values($1,$2,'C2-18','system')`, [scheme, cohortId])
  await run(`insert into grading_scheme_versions(id,scheme_id,version_no,stages,status,created_by_user_id) values($1,$2,1,$3::jsonb,'published',$4)`, [version, scheme, JSON.stringify([{ key: 'final', name: '期末', weight: 100, items: [{ key: 'report', name: '報告', type: 'number', max: 100, weight: 100 }] }]), userId])
  await run('update grading_schemes set current_version_id=$2 where id=$1', [scheme, version])
  await run(`insert into evaluator_assignments(id,group_id,stage_key,teacher_user_id,valid_from,assigned_by_user_id) values(gen_random_uuid(),$1,'final',$2,now(),$2)`, [gid, userId])
  await run(`insert into signoff_packages(id,group_id,cohort_id,purpose,created_by_user_id) values($1,$2,$3,'result_confirmation',$4)`, [pack, gid, cohortId, userId])
  await run(`insert into signoff_package_versions(id,package_id,version_no,content_text,content_checksum,participants,created_by_user_id,created_real_at,created_business_at) values($1,$2,1,'C2-18',encode(sha256(convert_to('C2-18','UTF8')),'hex'),$3::jsonb,$4,now(),now())`, [pv, pack, JSON.stringify({ students: [], advisor: { userId, displayName: 'C2-18 老師' } }), userId])
  await run(`insert into signoff_version_status(version_id,state) values($1,'collecting')`, [pv])
  await run('update signoff_packages set current_version_id=$2 where id=$1', [pack, pv])
  await run(`update signoff_version_status set state='teacher_pending' where version_id=$1`, [pv])
  await run(`insert into managed_items(id,cohort_id,placement,audience_kind,receiver_unit,stage_id,title,created_by_kind) values($1,$2,'submission','cohort_students','group',$3,'期末報告','system')`, [item, cohortId, stageId])
  await run(`insert into item_versions(id,item_id,version_no,title,summary,body_html,created_by_user_id) values($1,$2,1,'期末報告','','',$3)`, [iv, item, userId])
  await run(`insert into form_schema_versions(id,item_id,version_no,schema,created_by_user_id) values($1,$2,1,'{"fields":[]}',$3)`, [fv, item, userId])
  await run(`update managed_items set status='published', actual_opened_at='2020-01-01', due_at='2021-01-01', current_content_version_id=$2, current_schema_version_id=$3 where id=$1`, [item, iv, fv])
  await run(`insert into response_rosters(id,item_id,cohort_id,receiver_kind,receiver_id,eligible_from_business_at,source,created_by_kind) values(gen_random_uuid(),$1,$2,'group',$3,'2020-01-01','auto','system')`, [item, cohortId, gid])

  await page.setViewportSize({ width: 1280, height: 800 })
  await openHome(page, 'teacher')
  for (const id of ['todo-grading', 'todo-signoff', 'todo-missing']) await expect(page.getByTestId(id)).toBeVisible()
  const clipped = await page.locator('section[aria-label="待辦"] h2').evaluateAll((els) =>
    els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => `${el.textContent} ${el.scrollWidth}>${el.clientWidth}`),
  )
  expect(clipped).toEqual([])
})
