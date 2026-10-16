import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 專題事務項目的刪除（第三波 W1；AC-3、AC-4、AC-5、AC-6）：
 *
 * 1. 草稿：編輯器底部「危險操作」區按「刪除這則公告」→ 確認視窗寫清楚後果 → 回到專題事務清單、該則不見、稽核多一筆 `item.deleted`。
 * 2. 發布中：刪除鈕停用，旁邊寫「發布中的要先撤回或下架才能刪除」。
 * 3. 已下架的公開公告刪掉後：訪客與系辦開原網址都是「找不到這個頁面」（不是「已下架」）。
 * 4. 已下架、沒人交件的收件刪掉後：學生的「新收件」通知還在、點得開，點進去是「找不到這個頁面」（要背景工作投影通知）。
 *
 * 已有人交件擋下（AC-7）與附件下載、檔案管理（AC-5 後半）由 `pg-items.integration.test.ts` 的刪除案例驗。
 * 全程用真的表單與按鈕；屆別用 owner 連線直接建。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `W1D-${stamp}`

let pool: Pool
let cohortId: string
let student: TestSession

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  cohortId = String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
        [CODE, ymd(new Date(Date.now() + 300 * 86_400_000))],
      )
    ).rows[0]!.id,
  )
  await pool.query(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '成組期', $2, 'system')`,
    [cohortId, ymd(new Date())],
  )
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

/** 完整編輯器新建一則公開公告並存草稿，回傳項目 ID。 */
async function draftNews(page: Page, title: string): Promise<string> {
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.locator('#ed-title').fill(title)
  await page.locator('#ed-body').fill('刪除測試用的公告。')
  await page.getByLabel('誰看得到').selectOption('public')
  await page.getByRole('button', { name: '存草稿' }).click()
  await expect(page.getByRole('status')).toContainText('已存成草稿')
  await expect(page).toHaveURL(/\/dashboard\/admin\/editor\/[0-9a-f-]{36}$/)
  return page.url().split('/').pop()!
}

async function publishFromEditor(page: Page) {
  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toBeVisible()
  await check.getByRole('button', { name: '繼續編輯' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('發布中')
}

test('草稿：危險操作區按「刪除這則公告」→ 確認後回到清單，該則不見，稽核多一筆 item.deleted', async ({ page }) => {
  const title = `${CODE} 要刪的草稿`
  await asAdmin(page)
  const itemId = await draftNews(page, title)

  const danger = page.getByRole('region', { name: '危險操作' })
  await expect(danger).toContainText('撤回')
  await expect(danger).toContainText('下架')
  await danger.getByRole('button', { name: '刪除這則公告' }).click()
  const confirm = page.getByRole('dialog', { name: '刪除這則公告？' })
  await expect(confirm).toContainText(title)
  await expect(confirm).toContainText('刪除後後台清單也看不到、不能恢復；已寄的通知不會收回。')
  await confirm.getByRole('button', { name: '刪除這則公告' }).click()

  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/affairs\\?cohort=${cohortId}$`))
  await expect(page.getByRole('main')).not.toContainText(title)
  const audit = await pool.query(`select 1 from audit_events where target_id = $1 and action = 'item.deleted'`, [itemId])
  expect(audit.rowCount).toBe(1)
  // 編輯器網址也當作不存在。
  const response = await page.goto(`/dashboard/admin/editor/${itemId}`)
  expect(response?.status()).toBe(404)
})

test('發布中：刪除鈕停用，旁邊寫要先撤回或下架', async ({ page }) => {
  await asAdmin(page)
  await draftNews(page, `${CODE} 發布中的公告`)
  await publishFromEditor(page)

  const danger = page.getByRole('region', { name: '危險操作' })
  await expect(danger.getByRole('button', { name: '刪除這則公告' })).toBeDisabled()
  await expect(danger.getByTestId('delete-blocked')).toHaveText('發布中的要先撤回或下架才能刪除。')
})

test('已下架的公開公告刪掉後：訪客與系辦開原網址都是「找不到這個頁面」', async ({ page, browser }) => {
  const title = `${CODE} 已下架再刪`
  await asAdmin(page)
  const itemId = await draftNews(page, title)
  await publishFromEditor(page)
  // 重新開編輯器（發布對話框關掉時會刷新頁面，跟既有 e2e 一樣重新進來再按）。
  await page.goto(`/dashboard/admin/editor/${itemId}`)
  await page.getByRole('button', { name: '下架', exact: true }).click()
  await page.getByRole('dialog', { name: '下架這個項目？' }).getByRole('button', { name: '確認下架' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('已下架')

  const guest = await browser.newContext({ baseURL: BASE_URL })
  const visitor = await guest.newPage()
  await visitor.goto(`/news/${itemId}`)
  await expect(visitor.getByRole('main')).toContainText('已下架')

  await page.getByRole('region', { name: '危險操作' }).getByRole('button', { name: '刪除這則公告' }).click()
  await page.getByRole('dialog', { name: '刪除這則公告？' }).getByRole('button', { name: '刪除這則公告' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/affairs\\?cohort=${cohortId}$`))

  const gone = await visitor.goto(`/news/${itemId}`)
  expect(gone?.status()).toBe(404)
  await expect(visitor.getByText('找不到這個頁面').first()).toBeVisible()
  await expect(visitor.getByRole('main')).not.toContainText('已下架')
  await guest.close()

  const mine = await page.goto(`/news/${itemId}`)
  expect(mine?.status()).toBe(404)
  await expect(page.getByText('找不到這個頁面').first()).toBeVisible()
})

test('已下架、沒人交件的收件刪掉後：學生的通知還在、點得開，點進去是「找不到這個頁面」', async ({ page }) => {
  // 本屆一位學生：「本屆學生」個人收件的名單與通知對象就是他。
  student = await sharedTestSession(page.request, 'student')
  const studentNo = `417${String(Date.now()).slice(-5)}1`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, '刪除測試學生', '刪除測試學生', $2, $3, $4)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [student.userId, studentNo, cohortId, `w1d-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [
    cohortId,
    studentNo,
    student.userId,
  ])

  const title = `${CODE} 要刪的收件`
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.locator('#ed-title').fill(title)
  await page.locator('#ed-body').fill('請上傳 PDF。')
  await page.getByLabel('顯示在哪一區', { exact: true }).selectOption('submission')
  await page.getByRole('radio', { name: '個人一份', exact: true }).check()
  await page.getByLabel('誰看得到').selectOption('cohort_students')
  await page.getByLabel('所屬階段').selectOption({ index: 1 })
  await page
    .getByLabel('截止時間（臺灣時間，含這一分鐘）')
    .fill(new Date(Date.now() + 20 * 86_400_000 + 8 * 3600_000).toISOString().slice(0, 16))
  await page.getByLabel('要新增的欄位類型').selectOption('file')
  await page.getByRole('button', { name: '新增欄位' }).click()
  await page.getByRole('button', { name: '存草稿' }).click()
  await expect(page.getByRole('status')).toContainText('已存成草稿')
  const itemId = page.url().split('/').pop()!
  await publishFromEditor(page)
  await page.goto(`/dashboard/admin/editor/${itemId}`)
  await page.getByRole('button', { name: '下架', exact: true }).click()
  await page.getByRole('dialog', { name: '下架這個項目？' }).getByRole('button', { name: '確認下架' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('已下架')
  await page.getByRole('region', { name: '危險操作' }).getByRole('button', { name: '刪除這個作業' }).click()
  await page.getByRole('dialog', { name: '刪除這個作業？' }).getByRole('button', { name: '刪除這個作業' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/affairs\\?cohort=${cohortId}$`))

  // 學生：通知匣裡那一則（背景工作每 5 秒投影一輪）仍是連結，點進去是中文 404。
  await signIn(page, student)
  const link = page.locator(`a[href="/dashboard/student/affairs/${itemId}"]`)
  await expect
    .poll(
      async () => {
        await page.goto('/dashboard/student/inbox')
        return link.count()
      },
      { timeout: 30_000, intervals: [1_000, 2_000] },
    )
    .toBe(1)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/student/affairs/${itemId}$`))
  await expect(page.getByText('找不到這個頁面').first()).toBeVisible()
  // 作業區也不再列它。
  await page.goto('/dashboard/student/affairs')
  await expect(page.getByRole('main')).not.toContainText(title)
})
