import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { fillItemForm, formReady } from './create-item'
import { sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 榮譽榜開放發布（第三波 W1；AC-8、AC-9）：
 *
 * 1. 三步驟對話框有「榮譽／競賽」：選了之後對象鎖「公開訪客」、沒有收件與通知選項、多一個選填「得獎日期」；
 *    發布後訪客在 `/honors` 看得到，年份依得獎日期。
 * 2. 屆別封存後的榮譽：下架 → 重新發布 → 改標題都可以（其他位置封存後就不能動）。
 *
 * 全程用真的表單與按鈕；屆別用 owner 連線直接建、直接封存。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `W1H-${stamp}`

let pool: Pool
let cohortId: string
let historyCohortId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function newCohort(code: string): Promise<string> {
  return String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
        [code, ymd(new Date(Date.now() + 300 * 86_400_000))],
      )
    ).rows[0]!.id,
  )
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  cohortId = await newCohort(CODE)
  historyCohortId = await newCohort(`${CODE}-H`)
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function asAdmin(page: Page) {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
}

test('清單「榮譽」篩選的「新增榮譽」：對象鎖公開、沒有收件與通知、可填得獎日期；發布後出現在 /honors', async ({ page, browser }) => {
  const title = `${CODE} 校內專題競賽第一名`
  await asAdmin(page)
  // C1-07：公告分頁的「新增」直接開公告表單（不再選類型）；榮譽從「榮譽」篩選的「新增榮譽」進一頁式共用表單（C1-09 搬到成果展示）。
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}&placement=honor`)
  await page.getByRole('link', { name: '新增榮譽' }).click()
  const dialog = page.getByRole('main')
  const form = await formReady(dialog)
  await expect(form.getByLabel('誰看得到')).toBeDisabled()
  await expect(form.getByLabel('誰看得到')).toHaveValue('public')
  await expect(form.getByTestId('honor-where')).toContainText('榮譽榜')
  await expect(form.getByText('繳交方式')).toHaveCount(0)
  await expect(form.locator('section[aria-labelledby="sec-fields"]')).toHaveCount(0)
  await fillItemForm(page, form, { title, body: '恭喜本系專題組獲獎。', awardedOn: '2026-09-30' })
  await expect(form.getByRole('checkbox', { name: /重要公告/ })).toHaveCount(0)
  await expect(dialog.getByTestId('recipient-preview')).toHaveCount(0)
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
  await expect(page.getByTestId('item-toast')).toHaveText('已發布')

  const found = await pool.query<{ awarded_on: string; audience_kind: string; receiver_unit: string }>(
    `select to_char(awarded_on, 'YYYY-MM-DD') as awarded_on, audience_kind, receiver_unit from managed_items where title = $1`,
    [title],
  )
  expect(found.rows[0]).toEqual({ awarded_on: '2026-09-30', audience_kind: 'public', receiver_unit: 'none' })

  const guest = await browser.newContext({ baseURL: BASE_URL })
  const visitor = await guest.newPage()
  await visitor.goto('/honors?year=2026')
  await expect(visitor.getByRole('main')).toContainText(title)
  await guest.close()
})

test('屆別封存後的榮譽：下架、重新發布、改標題都可以，/honors 跟著變', async ({ page, browser }) => {
  const title = `${CODE} 歷屆榮譽`
  const renamed = `${CODE} 歷屆榮譽（改過）`
  await asAdmin(page)
  // 全頁共用表單建立榮譽（`?placement=honor`），發布後再把屆別封存。
  await page.goto(`/dashboard/admin/editor/new?cohort=${historyCohortId}&placement=honor`)
  const form = await formReady(page)
  await expect(form.getByLabel('顯示在哪一區', { exact: true })).toHaveValue('honor')
  await expect(form.getByLabel('誰看得到')).toBeDisabled()
  await fillItemForm(page, form, { title, body: '歷屆得獎紀錄。', awardedOn: '2025-05-20' })
  await expect(form.getByRole('checkbox')).toHaveCount(0)
  await form.getByRole('button', { name: '儲存（先不發布）' }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/editor\/[0-9a-f-]{36}$/)
  const itemId = page.url().split('/').pop()!
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
  expect((await pool.query('select status from managed_items where id = $1', [itemId])).rows[0].status).toBe('published')
  await pool.query(`update cohorts set status = 'archived' where id = $1`, [historyCohortId])

  const guest = await browser.newContext({ baseURL: BASE_URL })
  const visitor = await guest.newPage()

  await page.goto(`/dashboard/admin/editor/${itemId}`)
  await page.getByRole('button', { name: '下架', exact: true }).click()
  await page.getByRole('dialog', { name: '下架這個項目？' }).getByRole('button', { name: '確認下架' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('已下架')
  await visitor.goto('/honors?year=2025')
  await expect(visitor.getByRole('main')).not.toContainText(title)

  await page.getByRole('button', { name: '重新發布' }).click()
  const republish = page.getByRole('dialog', { name: '重新發布？' })
  await expect(republish.getByRole('checkbox')).toHaveCount(0)
  await republish.getByRole('button', { name: '確認重新發布' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('發布中')
  await visitor.goto('/honors?year=2025')
  await expect(visitor.getByRole('main')).toContainText(title)

  await page.locator('#ed-title').fill(renamed)
  await expect(page.getByRole('checkbox', { name: /通知對象/ })).toHaveCount(0)
  await page.getByRole('button', { name: '儲存更新' }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
  await visitor.goto('/honors?year=2025')
  await expect(visitor.getByRole('main')).toContainText(renamed)
  await guest.close()
})

test('專題事務列表選「榮譽」：屆別含已封存的，點得到歷屆榮譽並進編輯器；「新增榮譽」帶對屆別（W1b）', async ({ page }) => {
  const renamed = `${CODE} 歷屆榮譽（改過）`
  await asAdmin(page)
  await page.goto('/dashboard/admin/affairs')
  // 一般篩選看不到封存屆別。
  const cohorts = page.getByRole('navigation', { name: '選擇屆別' })
  await expect(cohorts.getByRole('link', { name: new RegExp(`^${CODE}-H`) })).toHaveCount(0)

  await page.getByRole('navigation', { name: '種類' }).getByRole('link', { name: '榮譽', exact: true }).click()
  await expect(page).toHaveURL(/placement=honor/)
  await expect(page.getByTestId('honor-list-hint')).toContainText('已封存')
  const history = cohorts.getByRole('link', { name: new RegExp(`^${CODE}-H`) })
  await expect(history).toContainText('已封存')
  await history.click()
  await expect(page).toHaveURL(new RegExp(`cohort=${historyCohortId}`))
  await expect(page).toHaveURL(/placement=honor/)

  // 封存屆別只能動榮譽：沒有「新增公告」，「新增榮譽」帶這一屆。
  await expect(page.getByRole('button', { name: '新增公告' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '新增榮譽' })).toHaveAttribute(
    'href',
    `/dashboard/admin/editor/new?cohort=${historyCohortId}&placement=honor`,
  )
  const row = page.getByTestId('affair-row').filter({ hasText: renamed })
  await expect(row).toContainText('發布中')
  await row.getByRole('link', { name: renamed, exact: true }).first().click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/editor\/[0-9a-f-]{36}$/)
  await expect(page.locator('#ed-title')).toHaveValue(renamed)

  // 一般屆別的榮譽篩選：「新增榮譽」帶那一屆，一般的新增入口照舊在。
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}&placement=honor`)
  await expect(page.getByRole('link', { name: '新增榮譽' })).toHaveAttribute(
    'href',
    `/dashboard/admin/editor/new?cohort=${cohortId}&placement=honor`,
  )
  await expect(page.getByRole('button', { name: '新增公告' })).toBeVisible()
  await expect(page.getByTestId('affair-row').filter({ hasText: `${CODE} 校內專題競賽第一名` })).toBeVisible()
})
