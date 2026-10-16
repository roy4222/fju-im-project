import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * SH-3（AC-SH-19；網站問題 #8）：`PageTitle` 的 actions 很寬時，標題不得被擠成直排。
 *
 * 現場是系辦成績管理頁：右上有「評分要求與指派」「建立新版評分規則」兩顆按鈕，建立草稿後
 * 「建立新版評分規則」底下多一句狀態（`role="status"`）。改前標題寬 0、四個字疊成一直排。
 * 改後：標題至少 16rem 寬、最多兩行高；actions 換到標題下一列。標題 40px／900。
 *
 * 資料只種一個屆別與一份已發布的評分規則（有「目前版本」才有「評分要求與指派」）；
 * 版面以外的行為由 grading-results.spec、grading-scheme-hint.spec 負責。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `SH3-${stamp}`

const STAGES = [
  {
    key: 'mid',
    name: '期中',
    weight: 60,
    letterMap: null,
    items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }],
  },
  {
    key: 'fin',
    name: '期末',
    weight: 40,
    letterMap: null,
    items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }],
  },
]

let pool: Pool
let cohortId: string

test.beforeAll(async ({ request }) => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 1 })
  const adminId = (await sharedTestSession(request, 'admin')).userId
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', (now() + interval '300 days')::date, false, 'system') returning id`,
    [CODE, `${CODE} 標題版面測試`],
  )
  cohortId = cohort.rows[0]!.id
  const scheme = await pool.query<{ id: string }>(
    `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
    [cohortId, `${CODE} 評分方案`],
  )
  const version = await pool.query<{ id: string }>(
    `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, 'published', $3) returning id`,
    [scheme.rows[0]!.id, JSON.stringify(STAGES), adminId],
  )
  await pool.query('update grading_schemes set current_version_id = $2 where id = $1', [scheme.rows[0]!.id, version.rows[0]!.id])
})

test.afterAll(async () => {
  await pool?.end()
})

async function openAdminGrading(page: Page) {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto(`/dashboard/admin/grading?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { level: 1, name: '成績管理', exact: true })).toBeVisible()
}

type Box = { top: number; bottom: number; width: number; height: number }

async function box(page: Page, locator: ReturnType<Page['locator']>): Promise<Box> {
  const b = await locator.boundingBox()
  if (!b) throw new Error('元素沒有版面')
  return { top: b.y, bottom: b.y + b.height, width: b.width, height: b.height }
}

for (const width of [1280, 1024]) {
  test(`${width} 寬：actions 有兩顆按鈕＋狀態句時，標題不直排、actions 換到下一列`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await openAdminGrading(page)

    // 建一版草稿，讓「建立新版評分規則」底下出現狀態句（網站問題 #8 的現場）。
    await page.getByRole('button', { name: '建立新版評分規則' }).click()
    const editor = page.getByRole('dialog', { name: '建立新版評分規則' })
    await editor.getByRole('button', { name: '建立草稿' }).click()
    await expect(editor).toBeHidden()
    const status = page.getByRole('status').filter({ hasText: '（草稿）' })
    await expect(status).toBeVisible()

    const h1 = page.locator('main h1')
    await expect(h1).toHaveText('成績管理')
    const style = await h1.evaluate((el) => {
      const s = getComputedStyle(el)
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: parseFloat(s.lineHeight) }
    })
    expect(style.fontSize).toBe('40px')
    expect(style.fontWeight).toBe('900')

    const title = await box(page, h1)
    expect(title.width).toBeGreaterThanOrEqual(256)
    expect(title.height).toBeLessThanOrEqual(2 * style.lineHeight)

    // actions 整塊在標題下面，而不是跟標題搶同一列的寬度。
    for (const part of [
      page.getByRole('button', { name: '評分要求與指派' }),
      page.getByRole('button', { name: '建立新版評分規則' }),
      status,
    ]) {
      expect((await box(page, part)).top).toBeGreaterThanOrEqual(title.bottom - 1)
    }
  })
}
