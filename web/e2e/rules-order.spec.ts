import { expect, test, type Locator, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * A-14（Q198）：規則章節上下移。驗收 AC-A-38、39、40（前台半段）、50。
 *
 * 系辦在「公告與作業」的「專題規則」分頁：列依章節位置排，每列多「上移」「下移」（首尾停用）；按完前台 `/rules`
 * 的目錄跟著換。草稿章節在系辦清單裡佔位置、前台看不到，所以跟草稿交換時前台順序不變。
 *
 * 兩組資料各用自己的屆別：`FIVE` 五章（第 3 章草稿，AC-A-50、39、40）、`FOUR` 四章都發布（AC-A-38）。
 * 前台 `/rules` 會列出所有屆別的公開規則（同一個資料庫裡還有別支 spec 的），只看標題帶本檔代碼的目錄項。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const FIVE = `A14F-${stamp}`
const FOUR = `A14G-${stamp}`
const title = (code: string, n: number) => `${code} 第${n}章`

let pool: Pool
const cohorts: Record<string, string> = {}

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  for (const code of [FIVE, FOUR]) {
    cohorts[code] = String(
      (
        await pool.query<{ id: string }>(
          `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
           values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
          [code, ymd(new Date(Date.now() + 300 * 86_400_000))],
        )
      ).rows[0]!.id,
    )
  }
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
}

/** 三步驟快速建立一章公開的規則：發布，或在第 3 步「先存成草稿」。 */
async function quickRule(page: Page, code: string, n: number, publish: boolean) {
  await page.goto(`/dashboard/admin/affairs?cohort=${cohorts[code]}`)
  await page.getByRole('button', { name: '新增公告' }).click()
  const dialog = page.getByRole('dialog', { name: '新增公告' })
  await dialog.getByRole('radio', { name: /專題規則/ }).check()
  await dialog.getByLabel('標題').fill(title(code, n))
  await dialog.getByLabel('誰看得到').selectOption('public')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByLabel('說明', { exact: true }).fill(`第 ${n} 章的規則內容。`)
  await dialog.getByRole('button', { name: '下一步' }).click()
  await expect(dialog.getByRole('list', { name: '發布前檢查' })).toBeVisible()
  if (publish) {
    await expect(dialog.locator('[data-ok="no"]')).toHaveCount(0)
    await dialog.getByRole('button', { name: '發布', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText(`「${title(code, n)}」已發布`)
  } else {
    await dialog.getByRole('button', { name: '先存成草稿' }).click()
    await expect(dialog).toBeHidden()
  }
}

async function openRulesFilter(page: Page, code: string) {
  // 舊網址 `?placement=rules` 轉到「專題規則」分頁（C 階段規格② §8），屆別照帶。
  await page.goto(`/dashboard/admin/affairs?cohort=${cohorts[code]}&placement=rules`)
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/affairs/rules\\?cohort=${cohorts[code]}$`))
  await expect(
    page.getByRole('navigation', { name: '公告與作業分頁' }).getByRole('link', { name: '專題規則', exact: true }),
  ).toHaveAttribute('aria-current', 'page')
}

/** 系辦「規則」篩選的列順序（只取「第 N 章」）。 */
async function adminOrder(page: Page, code: string): Promise<string[]> {
  const rows = page.getByTestId('affair-row')
  return (await rows.getByRole('link', { name: new RegExp(`^${code} 第`) }).allTextContents()).map((t) => t.replace(`${code} `, ''))
}

/** 前台 `/rules` 目錄裡本組的章節順序。 */
async function publicOrder(page: Page, code: string): Promise<string[]> {
  await page.goto('/rules')
  const toc = page.getByRole('navigation', { name: '規則目錄' })
  await expect(toc).toBeVisible()
  return (await toc.getByRole('link').allTextContents()).filter((t) => t.startsWith(`${code} `)).map((t) => t.replace(`${code} `, ''))
}

function row(page: Page, code: string, n: number): Locator {
  return page.getByTestId('affair-row').filter({ has: page.getByRole('link', { name: title(code, n), exact: true }) })
}

async function move(page: Page, code: string, n: number, direction: 'up' | 'down', position: number) {
  const name = `${direction === 'up' ? '上移' : '下移'}「${title(code, n)}」`
  await row(page, code, n).getByRole('button', { name }).click()
  await expect(page.getByTestId('pin-feedback')).toHaveText(`「${title(code, n)}」已移到第 ${position} 章，前台專題規則的順序同步更新。`)
}

test('準備：五章（第 3 章草稿）與四章；建立時依序拿到位置 1..n', async ({ page }) => {
  test.setTimeout(240_000)
  await asAdmin(page)
  for (const n of [1, 2, 3, 4, 5]) await quickRule(page, FIVE, n, n !== 3)
  for (const n of [1, 2, 3, 4]) await quickRule(page, FOUR, n, true)
  const positions = await pool.query<{ title: string; rules_position: number }>(
    `select title, rules_position from managed_items where cohort_id = $1 order by rules_position`,
    [cohorts[FIVE]],
  )
  expect(positions.rows.map((r) => [r.title, r.rules_position])).toEqual([1, 2, 3, 4, 5].map((n) => [title(FIVE, n), n]))
})

test('AC-A-40、AC-A-50 前半：沒動過時前台照發布先後；系辦 5 列依位置排、前台只有已發布的 1、2、4、5', async ({ page }) => {
  await asAdmin(page)
  await openRulesFilter(page, FIVE)
  expect(await adminOrder(page, FIVE)).toEqual(['第1章', '第2章', '第3章', '第4章', '第5章'])
  await expect(row(page, FIVE, 3)).toContainText('草稿')
  expect(await publicOrder(page, FIVE)).toEqual(['第1章', '第2章', '第4章', '第5章'])
  // 前台順序＝實際開放時間的先後（遷移前的排法）。
  const opened = await pool.query<{ title: string }>(
    `select title from managed_items where cohort_id = $1 and status = 'published' order by actual_opened_at, id`,
    [cohorts[FIVE]],
  )
  expect(opened.rows.map((r) => r.title.replace(`${FIVE} `, ''))).toEqual(['第1章', '第2章', '第4章', '第5章'])
})

test('AC-A-39：第 1 章「上移」、最後一章「下移」停用；畫面沒更新時硬按，伺服器照樣擋「已經在最上面了。」', async ({ page }) => {
  await asAdmin(page)
  await openRulesFilter(page, FIVE)
  await expect(row(page, FIVE, 1).getByRole('button', { name: `上移「${title(FIVE, 1)}」` })).toBeDisabled()
  await expect(row(page, FIVE, 1).getByRole('button', { name: `下移「${title(FIVE, 1)}」` })).toBeEnabled()
  await expect(row(page, FIVE, 5).getByRole('button', { name: `下移「${title(FIVE, 5)}」` })).toBeDisabled()
  await expect(row(page, FIVE, 3).getByRole('button', { name: `上移「${title(FIVE, 3)}」` })).toBeEnabled()

  // 停用只是畫面上的方便；邊界由伺服器判。另一個分頁先把第 2 章移到最上面，這一頁還沒重新整理、
  // 第 2 章的「上移」還能按 → 送到伺服器（同一個 server action）被擋，順序不變。
  const other = await page.context().newPage()
  await openRulesFilter(other, FIVE)
  await move(other, FIVE, 2, 'up', 1)
  await row(page, FIVE, 2).getByRole('button', { name: `上移「${title(FIVE, 2)}」` }).click()
  await expect(page.getByTestId('pin-feedback')).toHaveText('已經在最上面了。')
  await openRulesFilter(page, FIVE)
  expect(await adminOrder(page, FIVE)).toEqual(['第2章', '第1章', '第3章', '第4章', '第5章'])
  await expect(row(page, FIVE, 2).getByRole('button', { name: `上移「${title(FIVE, 2)}」` })).toBeDisabled()

  // 移回原位，後面的案例從 1..5 開始。
  await move(page, FIVE, 2, 'down', 2)
  await expect.poll(() => adminOrder(page, FIVE)).toEqual(['第1章', '第2章', '第3章', '第4章', '第5章'])
  await other.close()
})

test('AC-A-50：第 2 章下移（鄰居是草稿）→ 系辦 1、3、2、4、5、前台不變；再下移 → 系辦 1、3、4、2、5、前台 1、4、2、5', async ({ page }) => {
  await asAdmin(page)
  await openRulesFilter(page, FIVE)
  await move(page, FIVE, 2, 'down', 3)
  await expect.poll(() => adminOrder(page, FIVE)).toEqual(['第1章', '第3章', '第2章', '第4章', '第5章'])
  expect(await publicOrder(page, FIVE)).toEqual(['第1章', '第2章', '第4章', '第5章'])

  await openRulesFilter(page, FIVE)
  await move(page, FIVE, 2, 'down', 4)
  await expect.poll(() => adminOrder(page, FIVE)).toEqual(['第1章', '第3章', '第4章', '第2章', '第5章'])
  expect(await publicOrder(page, FIVE)).toEqual(['第1章', '第4章', '第2章', '第5章'])
  await page.screenshot({ path: test.info().outputPath('rules-public-after.png'), fullPage: true })
})

test('AC-A-38：四章都已發布，第 3 章下移 → 系辦與前台第 3、4 章互換', async ({ page }) => {
  await asAdmin(page)
  await openRulesFilter(page, FOUR)
  expect(await adminOrder(page, FOUR)).toEqual(['第1章', '第2章', '第3章', '第4章'])
  expect(await publicOrder(page, FOUR)).toEqual(['第1章', '第2章', '第3章', '第4章'])

  await openRulesFilter(page, FOUR)
  await move(page, FOUR, 3, 'down', 4)
  await expect.poll(() => adminOrder(page, FOUR)).toEqual(['第1章', '第2章', '第4章', '第3章'])
  // 移到最後之後，它的「下移」停用、原本最後一章的「下移」變可按。
  await expect(row(page, FOUR, 3).getByRole('button', { name: `下移「${title(FOUR, 3)}」` })).toBeDisabled()
  await expect(row(page, FOUR, 4).getByRole('button', { name: `下移「${title(FOUR, 4)}」` })).toBeEnabled()
  await page.screenshot({ path: test.info().outputPath('rules-admin-after.png'), fullPage: true })
  expect(await publicOrder(page, FOUR)).toEqual(['第1章', '第2章', '第4章', '第3章'])
})
