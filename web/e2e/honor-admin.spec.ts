import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
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

test('三步驟對話框選「榮譽／競賽」：對象鎖公開、沒有收件與通知、可填得獎日期；發布後出現在 /honors', async ({ page, browser }) => {
  const title = `${CODE} 校內專題競賽第一名`
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增項目' }).click()
  const dialog = page.getByRole('dialog', { name: '新增項目' })
  const honor = dialog.getByRole('radio', { name: /榮譽／競賽/ })
  await expect(dialog).toContainText('前台「榮譽榜」的一則得獎消息，可附照片')
  await honor.check()
  await expect(dialog.getByLabel('發布對象')).toBeDisabled()
  await expect(dialog.getByLabel('發布對象')).toHaveValue('public')
  await expect(dialog.getByTestId('honor-where')).toContainText('榮譽榜')
  await expect(dialog.getByText('收件單位')).toHaveCount(0)
  await dialog.getByLabel(/得獎日期/).fill('2026-09-30')
  await dialog.getByLabel('標題').fill(title)
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByLabel('說明', { exact: true }).fill('恭喜本系專題組獲獎。')
  await expect(dialog.getByText('要學生交什麼')).toHaveCount(0)
  await dialog.getByRole('button', { name: '下一步' }).click()
  await expect(dialog.getByRole('list', { name: '發布前檢查' })).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: /重要公告/ })).toHaveCount(0)
  await expect(dialog).toContainText('榮譽榜不發站內通知')
  await dialog.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText(`「${title}」已發布`)

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
  // 完整編輯器建立榮譽（`?placement=honor`），發布後再把屆別封存。
  await page.goto(`/dashboard/admin/editor/new?cohort=${historyCohortId}&placement=honor`)
  await expect(page.getByLabel('發布位置', { exact: true })).toHaveValue('honor')
  await expect(page.getByLabel('發布對象')).toBeDisabled()
  await page.locator('#ed-title').fill(title)
  await page.locator('#ed-body').fill('歷屆得獎紀錄。')
  await page.getByLabel(/得獎日期/).fill('2025-05-20')
  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await expect(check.getByRole('checkbox')).toHaveCount(0)
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toBeVisible()
  await check.getByRole('button', { name: '繼續編輯' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('發布中')
  const itemId = page.url().split('/').pop()!
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
  await page.getByRole('button', { name: '發布更新' }).click()
  const update = page.getByRole('dialog', { name: '發布更新前檢查' })
  await update.getByRole('button', { name: '確認更新' }).click()
  await expect(update.getByRole('status')).toBeVisible()
  await visitor.goto('/honors?year=2025')
  await expect(visitor.getByRole('main')).toContainText(renamed)
  await guest.close()
})
