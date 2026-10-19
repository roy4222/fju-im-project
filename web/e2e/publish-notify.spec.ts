import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { fillItemForm, formReady, openAdvanced } from './create-item'
import { fillItemBody } from './item-body'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 公告通知與編輯器返回（設計方案 2026-10-08 §7 系7、系8、§13-2）：
 *
 * 1. 發布過的公告回到草稿再發布，通知預設不勾（對象第一次已經收過了）。C1-06 起畫面沒有「撤回」，用資料直接改成撤回後的樣子。
 * 2. 勾通知前看得到會寄給幾個人（「重要公告」在進階設定；更新已發布的公告時「通知對象這次的修改」在底部按鈕旁）。
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
let emptyCohortId: string
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

  // 另一屆一個學生都沒有：「本屆學生」公告沒有人可以通知（設計方案 §14-3）。
  emptyCohortId = String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $2, 'active', $3, 'system') returning id`,
        [`${CODE}-E`, `第 45 屆 ${stamp}`, ymd(new Date(Date.now() + 300 * 86_400_000))],
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

/** 清單「新增公告」→ 一頁式共用表單（C1-06；C1-07 起直接開公告表單、不先選類型），回傳表單。 */
async function openNewsDialog(page: Page, cohort: string) {
  await page.goto(`/dashboard/admin/affairs?cohort=${cohort}`)
  await page.getByRole('button', { name: '新增公告' }).click()
  const dialog = page.getByRole('dialog', { name: '新增公告' })
  return { dialog, form: await formReady(dialog) }
}

test('第一次發布「本屆學生」公告：通知預設勾', async ({ page }) => {
  await asAdmin(page)
  const { dialog, form } = await openNewsDialog(page, cohortId)
  await fillItemForm(page, form, { title: TITLE, audience: 'cohort_students', body: '週五下午兩點在 LM503。' })
  await openAdvanced(form)
  const important = form.getByRole('checkbox', { name: /重要公告/ })
  await expect(important.locator('xpath=..')).toContainText('勾選後將通知 1 人')
  await expect(important).toBeChecked()
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('item-toast')).toHaveText('已發布')

  const found = await pool.query<{ id: string }>('select id from managed_items where cohort_id = $1 and title = $2', [cohortId, TITLE])
  itemId = found.rows[0]!.id
})

test('撤回成草稿再發布：通知預設不勾，旁邊寫會通知幾個人', async ({ page }) => {
  // C1-06 起畫面上沒有「撤回」（API 保留）：直接把資料改成撤回後的樣子；發布紀錄還在，所以算「發布過」。
  await pool.query(`update managed_items set status = 'draft', revision = revision + 1, pinned_at = null where id = $1`, [itemId])
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${itemId}`)
  const form = await formReady(page)
  await expect(page.getByTestId('item-status')).toHaveText('草稿')
  await openAdvanced(form)
  const important = form.getByRole('checkbox', { name: /重要公告/ })
  await expect(important.locator('xpath=..')).toContainText('勾選後將通知 1 人')
  await expect(important).not.toBeChecked()
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
  const after = await pool.query<{ status: string }>('select status from managed_items where id = $1', [itemId])
  expect(after.rows[0]!.status).toBe('published')
  const last = await pool.query<{ notify: boolean }>(
    `select notify from item_publications where item_id = $1 order by real_at desc, id desc limit 1`,
    [itemId],
  )
  expect(last.rows[0]!.notify).toBe(false)
})

test('更新已發布的公告：「通知對象這次的修改」旁邊寫會通知幾人', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${itemId}`)
  const form = await formReady(page)
  await openAdvanced(form)
  await form.getByLabel('摘要', { exact: false }).fill('改到 LM504')
  const notify = form.getByRole('checkbox', { name: /通知對象這次的修改/ })
  await notify.uncheck()
  await notify.check()
  await expect(notify.locator('xpath=..')).toContainText('勾選後將通知 1 人')
  await expect(form.getByRole('button', { name: '儲存更新' })).toBeEnabled()
})

test('在非預設屆別編輯後按「專題事務」返回，仍停在那一屆', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${itemId}`)
  // 頁內左上角的返回連結（側欄也有一個「專題事務」，那個不帶屆別）。
  await page.getByRole('main').getByRole('link', { name: '公告與作業', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/affairs\\?cohort=${cohortId}&placement=all$`))
  await expect(page.getByRole('navigation', { name: '選擇屆別' }).getByRole('link', { name: `第 44 屆 ${stamp}（${CODE}）`, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByRole('main')).toContainText(TITLE)
})

test('0 個學生的屆別發公告：對話框與全頁表單都預設不勾，發布紀錄寫「沒勾通知」', async ({ page }) => {
  const title = `${CODE} 沒有學生的公告`
  await asAdmin(page)
  const { dialog, form } = await openNewsDialog(page, emptyCohortId)
  await fillItemForm(page, form, { title, audience: 'cohort_students', body: '還沒有學生時發的公告。' })
  await expect(dialog.getByTestId('recipient-preview')).toContainText('這個對象目前沒有可以通知的人。')
  await openAdvanced(form)
  await expect(form.getByRole('checkbox', { name: /重要公告/ })).not.toBeChecked()
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog).toBeHidden()

  const found = await pool.query<{ id: string }>('select id from managed_items where cohort_id = $1 and title = $2', [emptyCohortId, title])
  await page.goto(`/dashboard/admin/editor/${found.rows[0]!.id}`)
  const edit = await formReady(page)
  await openAdvanced(edit)
  await edit.locator('summary', { hasText: '發布紀錄' }).click()
  const log = edit.getByRole('list', { name: '發布紀錄' })
  await expect(log).toContainText('沒勾通知')
  await expect(log).not.toContainText('有勾通知')

  // 全頁新建一則同樣對象的公告：同樣預設不勾、寫 0 人。
  await page.goto(`/dashboard/admin/editor/new?cohort=${emptyCohortId}`)
  const fresh = await formReady(page)
  await fresh.locator('#ed-title').fill(`${CODE} 全頁表單的公告`)
  await fillItemBody(page, '還沒有學生時發的公告。')
  await openAdvanced(fresh)
  const important = fresh.getByRole('checkbox', { name: /重要公告/ })
  await expect(important.locator('xpath=..')).toContainText('勾選後將通知 0 人')
  await expect(important).not.toBeChecked()
})
