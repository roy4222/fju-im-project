import { expect, request as playwrightRequest, test, type Locator } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 第 1 批 V5（AC-V27 ④⑤、`/projects/featured` 與 `/projects` 卡片）：其他頁的 `<img>` 屬性。
 *
 * - 列表卡片（優秀專題、歷屆一覽）：`loading="lazy"`＋`width`＋`height`；
 * - 公告內頁文章首圖、優秀專題 dialog 大圖：**沒有** `loading`（不 lazy），但有 `width`＋`height`。
 *
 * 只斷言 V5 三個檔（`news/[id]/page.tsx`、`_ui/photo-dialog-grid.tsx`、`projects/page.tsx`）的頁面；
 * 首頁、`/news`、`/competitions`、作品頁歸 V1／V2／V3。資料用 owner 連線直接寫（同 `public-projects.spec.ts`），
 * 每筆帶這次的戳記，只找自己的。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const COHORT = `IA${stamp}`
const TITLE = `${stamp} 圖片屬性作品`
const NEWS = `${stamp} 圖片屬性公告`

let pool: Pool
let entryId: string
let newsId: string

async function one(sql: string, values: unknown[] = []): Promise<string> {
  return String((await pool.query(sql, values)).rows[0]!.id)
}

async function expectAttrs(img: Locator, want: { lazy: boolean }) {
  await expect(img).toHaveAttribute('width', '1280')
  await expect(img).toHaveAttribute('height', '720')
  if (want.lazy) await expect(img).toHaveAttribute('loading', 'lazy')
  else expect(await img.getAttribute('loading')).toBeNull()
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const adminId = await one(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '系辦', $1, true, now(), 'active') returning id`,
    [`ia-${stamp.toLowerCase()}@example.com`],
  )
  const cohortId = await one(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [COHORT],
  )
  const groupId = await one(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
    [cohortId],
  )

  // 已發布、標了獎項等級的作品：優秀專題（訪客）與歷屆一覽（登入）都看得到。
  entryId = await one(
    `insert into showcase_entries (id, cohort_id, group_id, status, created_by_user_id) values (gen_random_uuid(), $1, $2, 'draft', $3) returning id`,
    [cohortId, groupId, adminId],
  )
  await pool.query(
    `insert into showcase_drafts (entry_id, title, summary, summary_checksum, video_url)
     values ($1, $2, '圖片屬性', encode(sha256(convert_to('圖片屬性', 'UTF8')), 'hex'), null)`,
    [entryId, TITLE],
  )
  const versionId = await one(
    `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, video_url, authorization_kind,
                                    authorization_ref, pii_check, created_by_user_id, created_real_at)
     select gen_random_uuid(), entry_id, 1, title, summary, summary_checksum, video_url, 'external', gen_random_uuid(),
            '{"passed": true}'::jsonb, $2, now()
       from showcase_drafts where entry_id = $1 returning id`,
    [entryId, adminId],
  )
  await pool.query(
    `update showcase_entries set status = 'published', current_version_id = $2, award_level = 'excellent', award_label = '校級優秀專題'
      where id = $1`,
    [entryId, versionId],
  )

  // 公開公告（沒有上傳封面時首圖是示意照片，一樣是文章首圖那張 `<img>`）。
  newsId = await one(
    `insert into managed_items (id, cohort_id, placement, audience_kind, title, summary, category, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, 'news', 'public', $2, '示範摘要', '系務公告', 'user', $3) returning id`,
    [cohortId, NEWS, adminId],
  )
  const contentId = await one(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, category, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '示範摘要', '', '系務公告', $3) returning id`,
    [newsId, NEWS, adminId],
  )
  const schemaId = await one(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[]}', $2) returning id`,
    [newsId, adminId],
  )
  await pool.query(
    `update managed_items set status = 'published', actual_opened_at = now(), current_content_version_id = $2, current_schema_version_id = $3
      where id = $1`,
    [newsId, contentId, schemaId],
  )
})

test.afterAll(async () => {
  await pool?.end()
})

test('訪客：公告內頁的文章首圖不 lazy、有寬高（AC-V27 ④）', async ({ page }) => {
  await page.goto(`/news/${newsId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NEWS)
  const cover = page.getByRole('article').locator('img').first()
  await expect(cover).toBeVisible()
  await expectAttrs(cover, { lazy: false })
})

test('訪客：優秀專題卡片 lazy＋寬高；dialog 打開後的大圖不 lazy、有寬高（AC-V27 ①⑤）', async ({ page }) => {
  await page.goto(`/projects/featured?q=${encodeURIComponent(stamp)}`)
  const card = page.getByTestId('photo-card').filter({ hasText: TITLE })
  await expect(card).toHaveCount(1)
  await expectAttrs(card.locator('img'), { lazy: true })

  const dialog = page.getByRole('dialog')
  // 卡片是 client component：水合完成前的點擊不會開 dialog，重點到開為止。
  await expect(async () => {
    await card.click()
    await expect(dialog.getByRole('heading', { name: TITLE })).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
  const big = dialog.getByRole('img', { name: TITLE })
  await expect(big).toBeVisible()
  await expectAttrs(big, { lazy: false })
})

test('登入：歷屆專題一覽卡片 lazy＋寬高（AC-V27 ①）', async ({ page, context }) => {
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const student = await sharedTestSession(api, 'student')
  await api.dispose()
  await context.addCookies([toPlaywrightCookie(student.cookie, BASE_URL)])
  await page.goto(`/projects?q=${encodeURIComponent(stamp)}`)
  const card = page.getByTestId('project-card').filter({ hasText: TITLE })
  await expect(card).toHaveCount(1)
  await expectAttrs(card.locator('img'), { lazy: true })
})
