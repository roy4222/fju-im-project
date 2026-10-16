import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 第 1 批 V6（Q51）：優秀專題預設照「系辦指定順序」（跟首頁輪播同一個順序）、獎項改成篩選、排序與獎項都是 pill。
 *
 * - AC-V28：首頁輪播與 `/projects/featured`（無參數）同序；網址不帶 `sort`。
 * - AC-V29：系辦改首頁順序後，兩頁一起變。
 * - AC-V30：獎項 pill（全部／優秀專題／佳作）篩選，可與屆別、搜尋疊加。
 * - AC-V31：排序是兩顆 pill、頁上沒有 `<select>`；「屆別（新到舊）」→ `?sort=cohort`。
 * - AC-V33：`?award=xxx&sort=excellent` 當成無篩選、預設排序，不報錯。
 * - AC-V34 第 6 步：首頁順序 1 的優秀專題在列表第一個前面、點「優秀專題」pill 仍在。
 *
 * 資料：三個屆別（X 最舊、Z 最新）各一件已發布作品，X 優秀專題、Y 佳作、Z 優秀專題；首頁順序 X=1、Y=2、Z 沒填。
 * 照 `public-projects.spec.ts` 的資料契約以 owner 連線直接寫，題目都帶這次的戳記，用 `?q=戳記` 只看自己的。
 * 共用的 e2e 資料庫裡別的作品也可能有首頁順序（例如 AC-39 設的 1），所以「兩頁同序」比的是整份前幾筆，
 * X／Y／Z 的相對順序在 `?q=戳記` 下比。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const X = `${stamp} 甲作品`
const Y = `${stamp} 乙作品`
const Z = `${stamp} 丙作品`
// 屆別代碼新到舊是 C > B > A：X 最舊、Z 最新。
const CODE = { X: `F6${stamp}A`, Y: `F6${stamp}B`, Z: `F6${stamp}C` }

let pool: Pool
const ids: Record<'X' | 'Y' | 'Z', string> = { X: '', Y: '', Z: '' }
const cohortIds: Record<'X' | 'Y' | 'Z', string> = { X: '', Y: '', Z: '' }

async function one(sql: string, values: unknown[] = []): Promise<string> {
  return String((await pool.query(sql, values)).rows[0]!.id)
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  await sharedTestSession(context, 'admin')
  await context.dispose()
  const adminId = await one(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '系辦', $1, true, now(), 'active') returning id`,
    [`ff-${stamp.toLowerCase()}@example.com`],
  )
  const make = async (key: 'X' | 'Y' | 'Z', title: string, award: 'excellent' | 'merit', homePosition: number | null) => {
    const cohortId = await one(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', '2099-06-30', 'system') returning id`,
      [CODE[key]],
    )
    const groupId = await one(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
      [cohortId],
    )
    const id = await one(
      `insert into showcase_entries (id, cohort_id, group_id, status, created_by_user_id) values (gen_random_uuid(), $1, $2, 'draft', $3) returning id`,
      [cohortId, groupId, adminId],
    )
    await pool.query(
      `insert into showcase_drafts (entry_id, title, summary, summary_checksum, video_url)
       values ($1, $2, '示範摘要', encode(sha256(convert_to('示範摘要', 'UTF8')), 'hex'), null)`,
      [id, title],
    )
    const versionId = await one(
      `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, video_url, authorization_kind,
                                      authorization_ref, pii_check, created_by_user_id, created_real_at)
       select gen_random_uuid(), entry_id, 1, title, summary, summary_checksum, video_url, 'external', gen_random_uuid(),
              '{"passed": true}'::jsonb, $2, now()
         from showcase_drafts where entry_id = $1 returning id`,
      [id, adminId],
    )
    await pool.query(
      `update showcase_entries set status = 'published', current_version_id = $2, award_level = $3, home_position = $4 where id = $1`,
      [id, versionId, award, homePosition],
    )
    ids[key] = id
    cohortIds[key] = cohortId
  }
  await make('X', X, 'excellent', 1)
  await make('Y', Y, 'merit', 2)
  await make('Z', Z, 'excellent', null)
})

test.afterAll(async () => {
  // 首頁順序清掉，免得之後同一個資料庫跑的首頁斷言被這幾件插隊。
  await pool?.query(`update showcase_entries set home_position = null where id = any($1::uuid[])`, [Object.values(ids).filter(Boolean)])
  await pool?.end()
})

const cardTitles = (page: Page) => page.getByTestId('photo-card').locator('.type-card-title').allTextContents()
const mine = (titles: string[]) => titles.filter((t) => t.startsWith(stamp))

async function homeTitles(page: Page): Promise<string[]> {
  await page.goto('/')
  return page.getByTestId('home-featured-list').locator('.type-card-title').allTextContents()
}

async function featuredTitles(page: Page, path = '/projects/featured'): Promise<string[]> {
  await page.goto(path)
  await expect(page.getByTestId('photo-card').first()).toBeVisible()
  return cardTitles(page)
}

test('AC-V28：首頁輪播與優秀專題（無參數）同序，X、Y、Z；網址沒有 sort', async ({ page }) => {
  const home = await homeTitles(page)
  const list = await featuredTitles(page)
  expect(new URL(page.url()).search).toBe('')
  expect(list.slice(0, home.length)).toEqual(home)
  expect(mine(list)).toEqual([X, Y, Z])
  // AC-V34 第 6 步：首頁順序 1 的優秀專題排在沒填順序的前面；點「優秀專題」pill 仍在、仍在 Z 前面。
  await page.getByRole('navigation', { name: '獎項篩選' }).getByRole('link', { name: '優秀專題' }).click()
  await expect(page).toHaveURL(/[?&]award=excellent/)
  expect(mine(await cardTitles(page))).toEqual([X, Z])
})

test('AC-V29：系辦把 Y 改 1、X 改 2，訪客重整兩頁都變 Y、X、Z', async ({ page }) => {
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
  const setHome = async (key: 'X' | 'Y', title: string, value: string) => {
    await page.goto(`/dashboard/admin/showcase?cohort=${cohortIds[key]}`)
    const form = page.getByTestId('showcase-draft').filter({ hasText: title }).getByRole('form', { name: /的首頁順序/ })
    await form.getByLabel(/首頁順序/).fill(value)
    await form.getByRole('button', { name: '儲存順序' }).click()
    await expect(form.getByRole('status')).toContainText(`首頁順序已設為 ${value}`)
  }
  await setHome('Y', Y, '1')
  await setHome('X', X, '2')

  await page.context().clearCookies()
  const home = await homeTitles(page)
  const list = await featuredTitles(page)
  expect(list.slice(0, home.length)).toEqual(home)
  expect(mine(list)).toEqual([Y, X, Z])
  expect(mine(home)).toEqual(mine(list).slice(0, mine(home).length))
  // 後面的案例照 AC-V28 的順序。
  await pool.query(`update showcase_entries set home_position = $2 where id = $1`, [ids.X, 1])
  await pool.query(`update showcase_entries set home_position = $2 where id = $1`, [ids.Y, 2])
})

test('AC-V30：獎項 pill 篩選，可以跟屆別、搜尋疊加取交集', async ({ page }) => {
  await page.goto(`/projects/featured?q=${encodeURIComponent(stamp)}`)
  const awards = page.getByRole('navigation', { name: '獎項篩選' })
  await expect(awards.getByRole('link', { name: '全部獎項' })).toHaveAttribute('aria-current', 'page')
  expect(mine(await cardTitles(page))).toEqual([X, Y, Z])

  await awards.getByRole('link', { name: '優秀專題' }).click()
  await expect(page).toHaveURL(/[?&]award=excellent/)
  await expect(awards.getByRole('link', { name: '優秀專題' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('photo-card')).toHaveCount(2)
  expect(mine(await cardTitles(page))).toEqual([X, Z])

  await awards.getByRole('link', { name: '佳作' }).click()
  await expect(page).toHaveURL(/[?&]award=merit/)
  await expect(awards.getByRole('link', { name: '佳作' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('photo-card')).toHaveCount(1)
  expect(await cardTitles(page)).toEqual([Y])

  await awards.getByRole('link', { name: '全部獎項' }).click()
  await expect(page.getByTestId('photo-card')).toHaveCount(3)
  expect(new URL(page.url()).searchParams.has('award')).toBe(false)

  // 「佳作」下再點屆別 pill：網址同時帶 award、cohort、q，結果是交集。
  await awards.getByRole('link', { name: '佳作' }).click()
  await expect(page.getByTestId('photo-card')).toHaveCount(1)
  await page.getByRole('navigation', { name: '屆別篩選' }).getByRole('link', { name: `${CODE.Y}（${CODE.Y}）` }).click()
  await expect(page).toHaveURL(new RegExp(`cohort=${CODE.Y}`))
  const url = new URL(page.url())
  expect([url.searchParams.get('award'), url.searchParams.get('cohort'), url.searchParams.get('q')]).toEqual(['merit', CODE.Y, stamp])
  expect(await cardTitles(page)).toEqual([Y])
  // 換成別屆（X 是優秀專題，沒有佳作）：交集是空的。
  await page.getByRole('navigation', { name: '屆別篩選' }).getByRole('link', { name: `${CODE.X}（${CODE.X}）` }).click()
  await expect(page.getByText('找不到符合的作品')).toBeVisible()
  // 換搜尋字：award、cohort 都還在。
  await page.goto(`/projects/featured?award=merit&cohort=${CODE.Y}`)
  await page.getByRole('searchbox', { name: '搜尋題目、摘要、組別' }).fill(`${stamp} 乙`)
  await expect(page).toHaveURL(/[?&]q=/)
  const after = new URL(page.url())
  expect([after.searchParams.get('award'), after.searchParams.get('cohort')]).toEqual(['merit', CODE.Y])
  expect(await cardTitles(page)).toEqual([Y])
})

test('AC-V31：排序是兩顆 pill、沒有下拉；屆別（新到舊）→ Z、Y、X；系辦指定順序 → 網址沒有 sort、回 X、Y、Z', async ({ page }) => {
  await page.goto(`/projects/featured?q=${encodeURIComponent(stamp)}`)
  const sorts = page.getByRole('navigation', { name: '排序' })
  await expect(sorts.getByRole('link')).toHaveText(['系辦指定順序', '屆別（新到舊）'])
  await expect(sorts.getByRole('link', { name: '系辦指定順序' })).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('select')).toHaveCount(0)
  await expect(page.getByRole('searchbox', { name: '搜尋題目、摘要、組別' })).toBeVisible()

  await sorts.getByRole('link', { name: '屆別（新到舊）' }).click()
  await expect(page).toHaveURL(/[?&]sort=cohort/)
  await expect(sorts.getByRole('link', { name: '屆別（新到舊）' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('photo-card').first()).toContainText(Z)
  expect(mine(await cardTitles(page))).toEqual([Z, Y, X])

  await sorts.getByRole('link', { name: '系辦指定順序' }).click()
  await expect(page).not.toHaveURL(/[?&]sort=/)
  await expect(page.getByTestId('photo-card').first()).toContainText(X)
  expect(mine(await cardTitles(page))).toEqual([X, Y, Z])
  await expect(page.getByRole('searchbox', { name: '搜尋題目、摘要、組別' })).toHaveValue(stamp)
})

test('AC-V33：看不懂的獎項與舊的排序值當作無篩選、預設排序，不報錯', async ({ page }) => {
  const clean = await featuredTitles(page)
  const response = await page.goto('/projects/featured?award=xxx&sort=excellent')
  expect(response?.status()).toBe(200)
  expect(await cardTitles(page)).toEqual(clean)
  await expect(page.getByRole('navigation', { name: '獎項篩選' }).getByRole('link', { name: '全部獎項' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation', { name: '排序' }).getByRole('link', { name: '系辦指定順序' })).toHaveAttribute('aria-current', 'page')

  await page.goto(`/projects/featured?award=xxx&sort=excellent&q=${encodeURIComponent(stamp)}`)
  expect(mine(await cardTitles(page))).toEqual([X, Y, Z])
})
