import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 公告通知與編輯器返回（設計方案 2026-10-08 §7 系7、系8、§13-2）：
 *
 * 1. 發布過的公告撤回成草稿再發布，通知預設不勾（對象第一次已經收過了）。
 * 2. 勾通知前看得到會寄給幾個人；更新已發布的公告並勾通知時，確認鈕寫「確認更新並通知 N 人」。
 * 3. 在非預設屆別編輯公告後按「專題事務」返回，仍停在那一屆（網址帶 ?cohort=）。
 *
 * 全程用真的表單與按鈕；資料準備用 owner 連線直接寫。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T7-${stamp}`
const TITLE = `${CODE} 期中說明會`

let pool: Pool
let cohortId: string
let itemId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  // 非預設工作屆別（不設旗標），名稱與代碼不同，才看得出返回後停在哪一屆。
  cohortId = String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $2, 'active', $3, 'system') returning id`,
        [CODE, `第 44 屆 ${stamp}`, ymd(new Date(Date.now() + 300 * 86_400_000))],
      )
    ).rows[0]!.id,
  )

  // 本屆一位學生：「本屆學生」公告的通知對象就是他。
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const student = await createTestSession(context, 'student')
  await context.dispose()
  const studentNo = `416${String(Date.now()).slice(-5)}1`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [student.userId, '通知學生', studentNo, cohortId, `t7-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [
    cohortId,
    studentNo,
    student.userId,
  ])
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

test('第一次發布「本屆學生」公告：通知預設勾', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增項目' }).click()
  const dialog = page.getByRole('dialog', { name: '新增項目' })
  await dialog.getByRole('radio', { name: /公告/ }).check()
  await dialog.getByLabel('標題').fill(TITLE)
  await dialog.getByLabel('發布對象').selectOption('cohort_students')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByLabel('說明', { exact: true }).fill('週五下午兩點在 LM503。')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await expect(dialog.getByRole('list', { name: '發布前檢查' })).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: /重要公告/ })).toBeChecked()
  await dialog.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText(`「${TITLE}」已發布`)

  const found = await pool.query<{ id: string }>('select id from managed_items where cohort_id = $1 and title = $2', [cohortId, TITLE])
  itemId = found.rows[0]!.id
})

test('撤回成草稿再發布：通知預設不勾，旁邊寫會通知幾個人', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${itemId}`)
  await page.getByRole('button', { name: '撤回', exact: true }).click()
  await page.getByRole('dialog', { name: '撤回成草稿？' }).getByRole('button', { name: '確認撤回' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('草稿')

  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  const important = check.getByRole('checkbox', { name: /重要公告/ })
  await expect(important).not.toBeChecked()
  await expect(check).toContainText('勾選後將通知 1 人')
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toBeVisible()
  await check.getByRole('button', { name: '繼續編輯' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('發布中')
})

test('更新已發布的公告並勾通知：確認鈕寫「確認更新並通知 N 人」', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${itemId}`)
  await page.getByLabel('摘要').fill('改到 LM504')
  await page.getByRole('button', { name: '發布更新' }).click()
  const check = page.getByRole('dialog', { name: '發布更新前檢查' })
  const notify = check.getByRole('checkbox', { name: /通知對象這次的修改/ })
  await notify.uncheck()
  await expect(check.getByRole('button', { name: '確認更新', exact: true })).toBeVisible()
  await notify.check()
  await expect(check).toContainText('勾選後將通知 1 人')
  await expect(check.getByRole('button', { name: '確認更新並通知 1 人' })).toBeEnabled()
  await check.getByRole('button', { name: '取消' }).click()
})

test('在非預設屆別編輯後按「專題事務」返回，仍停在那一屆', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${itemId}`)
  // 頁內左上角的返回連結（側欄也有一個「專題事務」，那個不帶屆別）。
  await page.getByRole('main').getByRole('link', { name: '專題事務', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/affairs\\?cohort=${cohortId}$`))
  await expect(page.getByRole('navigation', { name: '選擇屆別' }).getByRole('link', { name: CODE, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByRole('main')).toContainText(TITLE)
})
