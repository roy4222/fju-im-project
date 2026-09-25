import { expect, request as playwrightRequest, test } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 前台補頁（票 34）的煙霧：優秀專題、專題詳情、歷屆一覽、榮譽榜、競賽資訊、忘記密碼、導覽列。
 *
 * 「發布」精選還沒有用例（S12），所以資料照 PR 內文的資料契約用 owner 連線直接寫：
 * 已發布＝`showcase_entries.status='published'` 且 `current_version_id` 指向一列 `showcase_versions`；
 * 榮譽＝`managed_items.placement='honor'`；競賽＝`placement='news'`、分類「競賽資訊」。
 * 另外放一份**草稿**，證明它不會出現在任何一頁。每筆資料都帶這次的戳記，只找自己的。
 *
 * 票 39（0011）：優秀專題只有標了獎項等級的（`TITLE` 標優秀專題）；另一件已發布、沒標等級的（`PLAIN`）
 * 訪客在優秀專題看不到、打開詳情要登入，登入後在歷屆一覽看得到。競賽帶報名截止／活動日（狀態 pill），
 * 榮譽帶得獎日期（年份篩選）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const COHORT = `PP${stamp}`
const TITLE = `${stamp} 城市微光`
const DRAFT = `${stamp} 機密草稿`
const PLAIN = `${stamp} 沒得獎作品`
const HONOR = `${stamp} 全國競賽 優等`
const COMPETITION = `${stamp} 資訊應用服務創新競賽`
const MEMBER = `${stamp}組員`
const ADVISOR = `${stamp}老師`

let pool: Pool
let entryId: string
let draftId: string
let plainId: string

async function one(sql: string, values: unknown[] = []): Promise<string> {
  return String((await pool.query(sql, values)).rows[0]!.id)
}

async function newUser(name: string): Promise<string> {
  return one(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `pp-${stamp}-${Math.random().toString(36).slice(2, 8)}@example.com`],
  )
}

async function publishedItem(
  cohortId: string,
  adminId: string,
  placement: string,
  title: string,
  category: string,
  dates: { registrationDeadline?: string; eventDate?: string; awardedOn?: string } = {},
) {
  const itemId = await one(
    `insert into managed_items (id, cohort_id, placement, audience_kind, title, summary, category, created_by_kind, created_by_user_id,
                                registration_deadline, event_date, awarded_on)
     values (gen_random_uuid(), $1, $2, 'public', $3, '示範摘要', $4, 'user', $5, $6, $7, $8) returning id`,
    [cohortId, placement, title, category, adminId, dates.registrationDeadline ?? null, dates.eventDate ?? null, dates.awardedOn ?? null],
  )
  const versionId = await one(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, category, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '示範摘要', '', $3, $4) returning id`,
    [itemId, title, category, adminId],
  )
  const schemaId = await one(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[]}', $2) returning id`,
    [itemId, adminId],
  )
  await pool.query(
    `update managed_items set status = 'published', actual_opened_at = now(), current_content_version_id = $2, current_schema_version_id = $3
      where id = $1`,
    [itemId, versionId, schemaId],
  )
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const adminId = await newUser('系辦')
  const cohortId = await one(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [COHORT],
  )
  const group = async (code: string) =>
    one(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
      [cohortId, code],
    )
  const g1 = await group('G01')
  const g2 = await group('G02')
  const member = await newUser(MEMBER)
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
    [g1, cohortId, member],
  )
  const teacher = await newUser(ADVISOR)
  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $3, 'e2e')`,
    [g1, teacher, adminId],
  )

  const entry = async (groupId: string, title: string) => {
    const id = await one(
      `insert into showcase_entries (id, cohort_id, group_id, status, created_by_user_id) values (gen_random_uuid(), $1, $2, 'draft', $3) returning id`,
      [cohortId, groupId, adminId],
    )
    await pool.query(
      `insert into showcase_drafts (entry_id, title, summary, summary_checksum, video_url)
       values ($1, $2, '公共資訊可讀性改善', encode(sha256(convert_to('公共資訊可讀性改善', 'UTF8')), 'hex'), 'https://youtu.be/e2e')`,
      [id, title],
    )
    return id
  }
  const publish = async (id: string) => {
    const versionId = await one(
      `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, video_url, authorization_kind,
                                      authorization_ref, pii_check, created_by_user_id, created_real_at)
       select gen_random_uuid(), entry_id, 1, title, summary, summary_checksum, video_url, 'external', gen_random_uuid(),
              '{"passed": true}'::jsonb, $2, now()
         from showcase_drafts where entry_id = $1 returning id`,
      [id, adminId],
    )
    await pool.query(`update showcase_entries set status = 'published', current_version_id = $2 where id = $1`, [id, versionId])
  }
  entryId = await entry(g1, TITLE)
  await publish(entryId)
  await pool.query(`update showcase_entries set award_level = 'excellent', award_label = '校級優秀專題' where id = $1`, [entryId])
  draftId = await entry(g2, DRAFT)
  const g3 = await group('G03')
  plainId = await entry(g3, PLAIN)
  await publish(plainId)

  // 得獎日期 2019（不是今天的年份），年份篩選要看它、不是看發布日。
  await publishedItem(cohortId, adminId, 'honor', HONOR, '校外競賽', { awardedOn: '2019-06-15' })
  // 報名截止在很久以後＝報名中。
  await publishedItem(cohortId, adminId, 'news', COMPETITION, '競賽資訊', { registrationDeadline: '2099-12-31' })
})

test.afterAll(async () => {
  await pool?.end()
})

test('訪客：優秀專題看得到已發布的、看不到草稿；點開一圖一文 dialog 再進詳情；詳情不帶組員與老師', async ({ page }) => {
  await page.goto(`/projects/featured?q=${encodeURIComponent(stamp)}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('優秀專題')
  const cards = page.getByTestId('photo-card')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText(TITLE)
  await expect(cards.first().getByTestId('award-badge')).toHaveText('優秀專題')
  await expect(page.locator('body')).not.toContainText(DRAFT)
  await expect(page.locator('body')).not.toContainText(PLAIN)

  const dialog = page.getByRole('dialog')
  // 卡片是 client component：水合完成前的點擊不會開 dialog，重點到開為止。
  await expect(async () => {
    await cards.first().click()
    await expect(dialog.getByRole('heading', { name: TITLE })).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
  await dialog.getByRole('link', { name: /查看完整資料/ }).click()

  await expect(page).toHaveURL(new RegExp(`/projects/${entryId}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE)
  await expect(page.getByText('登入後顯示')).toBeVisible()
  const html = await page.content()
  expect(html).not.toContain(MEMBER)
  expect(html).not.toContain(ADVISOR)

  // 草稿的網址和不存在一樣是 404。
  const draft = await page.goto(`/projects/${draftId}`)
  expect(draft?.status()).toBe(404)

  // 沒得獎的作品只在登入後的歷屆一覽：訪客直接開網址是「需要登入」，題目不出現。
  await page.goto(`/projects/${plainId}`)
  await expect(page.getByTestId('need-login')).toContainText('這件作品需要登入')
  expect(await page.content()).not.toContain(PLAIN)
})

test('訪客：歷屆專題一覽要登入；登入的學生看到組員與指導老師', async ({ page, context }) => {
  await page.goto('/projects')
  await expect(page.getByTestId('need-login')).toContainText('歷屆專題一覽需要登入')
  await expect(page.locator('body')).not.toContainText(TITLE)

  const api = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const student = await sharedTestSession(api, 'student')
  await api.dispose()
  await context.addCookies([toPlaywrightCookie(student.cookie, BASE_URL)])
  await page.goto(`/projects?q=${encodeURIComponent(stamp)}`)
  const card = page.getByTestId('project-card').filter({ hasText: TITLE })
  await expect(card).toContainText(`指導老師 ${ADVISOR}`)
  await expect(page.locator('body')).not.toContainText(DRAFT)
  // 歷屆一覽是全部已發布的（含沒得獎的）；「只看得獎」就剩得獎的。
  await expect(page.getByTestId('project-card').filter({ hasText: PLAIN })).toBeVisible()
  await page.goto(`/projects?award=1&q=${encodeURIComponent(stamp)}`)
  await expect(page.getByTestId('project-card')).toHaveCount(1)
  await expect(page.getByTestId('project-card').first()).toContainText(TITLE)
  await page.goto(`/projects/${entryId}`)
  await expect(page.locator('aside')).toContainText(MEMBER)
})

test('榮譽榜與競賽資訊列出已發布的公開項目；忘記密碼頁不收 Email、不假稱寄信', async ({ page }) => {
  await page.goto(`/honors?q=${encodeURIComponent(stamp)}`)
  await expect(page.getByTestId('photo-card').filter({ hasText: HONOR })).toBeVisible()
  // 年份看得獎日期（2019），不是發布日。
  await page.goto(`/honors?year=2019&q=${encodeURIComponent(stamp)}`)
  await expect(page.getByTestId('photo-card').filter({ hasText: HONOR })).toContainText('2019-06-15')

  await page.goto(`/competitions?status=open&q=${encodeURIComponent(stamp)}`)
  const competition = page.getByTestId('competition-card').filter({ hasText: COMPETITION })
  await expect(competition).toBeVisible()
  await expect(competition).toContainText('報名中')
  await expect(competition).toContainText('截止 2099-12-31')
  await page.goto(`/competitions?status=closed&q=${encodeURIComponent(stamp)}`)
  await expect(page.getByTestId('competition-card')).toHaveCount(0)
  await page.goto(`/competitions?q=${encodeURIComponent(stamp)}`)
  await competition.getByRole('link', { name: /競賽詳情與報名/ }).click()
  await expect(page).toHaveURL(/\/news\/[0-9a-f-]{36}$/)

  await page.goto('/forgot-password')
  await expect(page.getByTestId('forgot-password')).toContainText('系辦')
  await expect(page.locator('input[type="email"]')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('已寄出')
})

test('訪客導覽：最新公告（含競賽資訊）、專題規則、優秀專題、榮譽榜；登入頁連到忘記密碼', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const nav = page.getByRole('navigation', { name: '主導覽' })
  for (const name of ['最新公告', '專題規則', '優秀專題', '榮譽榜']) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible()
  // 下拉平常是隱藏的（不在無障礙樹裡），滑過「最新公告」才展開。
  await nav.getByRole('link', { name: '最新公告', exact: true }).hover()
  await expect(nav.getByRole('link', { name: '競賽資訊' })).toHaveAttribute('href', '/competitions')
  await page.goto('/login')
  await expect(page.getByRole('link', { name: '忘記密碼？' })).toHaveAttribute('href', '/forgot-password')
})
