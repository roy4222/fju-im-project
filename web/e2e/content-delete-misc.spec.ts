import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 第三波 W11（AC-36）：時間軸活動與合作案可以刪除；系辦可以新增合作案並指定負責老師。
 *
 * 1. 純系辦帳號（沒有老師角色）在「合作案」頁按「新增合作案」、從選單指定負責老師並發布；
 *    前台 `/industry` 看得到，負責老師的「我的合作案」列出它。
 * 2. 發布中的合作案被擋（要先下架）；下架後還連著組別也被擋（要先解除連結）；解除後刪得掉，
 *    後台清單與前台詳情都消失（詳情變 404）。
 * 3. 排定中的活動被擋（要先取消）；已取消的刪得掉，從「已取消」清單消失。
 * 刪除入口只在頁面底部的「危險操作」區（§9 規則 1）：日常清單的列上沒有刪除鈕。
 * 刪除的資料層規則（刪除標記、稽核、重送、權限）由 pg-timeline／pg-opportunities 的整合測試證明。
 *
 * 屆別、組別、活動與組別連結直接用 owner 連線準備；W11 的動作全程用真的畫面與按鈕。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `W11-${stamp}`
const GROUP = `G${stamp.slice(-3)}`
const COMPANY = `系辦建案${stamp.slice(-4)}`
const NAME = `${COMPANY}・資訊部`
const SCHEDULED = `W11 發表會 ${stamp.slice(-4)}`
const CANCELLED = `W11 說明會 ${stamp.slice(-4)}`

let pool: Pool
let admin: TestSession
let teacher: TestSession
let cohortId: string
let groupId: string

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function opportunityId(): Promise<string> {
  const rows = await pool.query<{ id: string }>('select id from industry_opportunities where company_name = $1', [COMPANY])
  return rows.rows[0]!.id
}

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const fresh = async (role: 'admin' | 'teacher') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  // 純系辦帳號：只有管理員角色（AC-36 指定沒有老師角色）。
  admin = await fresh('admin')
  teacher = await fresh('teacher')
  await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [teacher.userId, `負責老師${stamp.slice(-3)}`])

  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', '2099-06-30', false, 'system') returning id`,
    [CODE, `${CODE} 刪除測試`],
  )
  cohortId = cohort.rows[0]!.id
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'industry', now(), now(), 'system') returning id`,
    [cohortId, GROUP],
  )
  groupId = group.rows[0]!.id

  for (const [title, status] of [
    [SCHEDULED, 'scheduled'],
    [CANCELLED, 'cancelled'],
  ] as const) {
    await pool.query(
      `insert into project_events
         (id, cohort_id, title, starts_at, all_day, audience_kind, status,
          created_by_kind, created_by_user_id, created_at, updated_at, updated_by_user_id)
       values (gen_random_uuid(), $1, $2, '2099-03-01T06:00:00Z', false, 'public', $3, 'user', $4, now(), now(), $4)`,
      [cohortId, title, status, admin.userId],
    )
  }
})

test.afterAll(async () => {
  await pool?.end()
})

test('純系辦帳號新增合作案並指定負責老師；前台看得到，負責老師的「我的合作案」列出它', async ({ page }) => {
  await signIn(page, admin)
  await page.goto('/dashboard/admin/industry')
  await page.getByRole('button', { name: '新增合作案' }).click()
  const dialog = page.getByRole('dialog', { name: '新增合作案' })
  await dialog.getByLabel('公司名稱').fill(COMPANY)
  await dialog.getByLabel('需求部門').fill('資訊部')
  await dialog.getByLabel('專題／合作內容').fill('門市補貨預測')
  // 沒選負責老師：伺服器擋下、指出負責老師欄，已經打的字還在。
  await dialog.getByRole('button', { name: '儲存並發布' }).click()
  await expect(dialog.getByRole('alert')).toContainText('請選負責老師')
  await expect(dialog.getByLabel('公司名稱')).toHaveValue(COMPANY)

  await dialog.getByLabel('負責老師').selectOption(teacher.userId)
  await dialog.getByRole('button', { name: '儲存並發布' }).click()
  await expect(page.getByRole('status').filter({ hasText: `已發布「${NAME}」` })).toBeAttached()
  const row = page.getByTestId('managed-opportunity').filter({ hasText: COMPANY })
  await expect(row).toContainText('已發布')
  await expect(row).toContainText(`負責老師${stamp.slice(-3)} 老師`)

  const owner = await pool.query('select owner_teacher_user_id, created_by_user_id from industry_opportunities where company_name = $1', [
    COMPANY,
  ])
  expect(owner.rows[0]).toEqual({ owner_teacher_user_id: teacher.userId, created_by_user_id: admin.userId })

  await signIn(page, teacher)
  await page.goto('/dashboard/teacher/industry')
  await expect(page.getByTestId('managed-opportunity').filter({ hasText: COMPANY })).toContainText('已發布')
  await page.goto('/industry')
  await expect(page.getByTestId('opportunity-card').filter({ hasText: COMPANY })).toContainText('門市補貨預測')
})

test('合作案：發布中要先下架、連著組別要先解除；解除後刪得掉，後台與前台都消失', async ({ page }) => {
  const id = await opportunityId()
  await signIn(page, admin)
  await page.goto('/dashboard/admin/industry')
  const row = page.getByTestId('managed-opportunity').filter({ hasText: COMPANY })
  // 刪除入口在頁面底部的「危險操作」區，不跟編輯、下架並列（§9 規則 1）。
  const danger = page.getByRole('region', { name: '危險操作' })
  await expect(row).toBeVisible()
  await expect(row.getByRole('button', { name: /^刪除/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: `刪除：${NAME}` })).toHaveCount(1)
  await expect(danger.getByRole('button', { name: `刪除：${NAME}` })).toBeVisible()
  await expect(danger.getByTestId('danger-opportunity').filter({ hasText: NAME })).toContainText('要先「下架」')

  // 發布中：對話框只說明原因，沒有刪除鈕。
  await danger.getByRole('button', { name: `刪除：${NAME}` }).click()
  const blocked = page.getByRole('dialog', { name: `還不能刪除「${NAME}」` })
  await expect(blocked).toContainText('要先「下架」才能刪除')
  await expect(blocked.getByRole('button', { name: '刪除這個合作案' })).toHaveCount(0)
  await blocked.getByRole('button', { name: '知道了' }).click()

  // 連著組別、下架後：還是被擋，說明要先解除連結，並列出是哪一組。
  await pool.query(
    `insert into opportunity_links (id, group_id, opportunity_id, valid_from, linked_by_user_id, created_at)
     values (gen_random_uuid(), $1, $2, now(), $3, now())`,
    [groupId, id, admin.userId],
  )
  await page.reload()
  await row.getByRole('button', { name: `下架：${NAME}` }).click()
  await page.getByRole('dialog', { name: `下架「${NAME}」` }).getByRole('button', { name: '確認下架' }).click()
  await expect(row).toContainText('已下架')
  await danger.getByRole('button', { name: `刪除：${NAME}` }).click()
  const linked = page.getByRole('dialog', { name: `還不能刪除「${NAME}」` })
  await expect(linked).toContainText('要先「解除」連結才能刪除')
  await expect(linked).toContainText(GROUP)
  await linked.getByRole('button', { name: '知道了' }).click()

  // 解除連結後就能刪：危險操作的確認視窗寫清楚對象、後果、不能恢復。
  await row.getByRole('button', { name: `解除連結：${GROUP}` }).click()
  const unlink = page.getByRole('dialog', { name: `解除 ${GROUP} 的連結` })
  await unlink.getByLabel('理由（必填）').fill('題目取消')
  await unlink.getByRole('button', { name: '確認解除' }).click()
  await expect(row).toContainText('尚無組別連結')

  await danger.getByRole('button', { name: `刪除：${NAME}` }).click()
  const confirm = page.getByRole('dialog', { name: `刪除「${NAME}」` })
  await expect(confirm).toContainText('已下架')
  await expect(confirm).toContainText('不能。')
  await confirm.getByRole('button', { name: '刪除這個合作案' }).click()
  await expect(danger.getByRole('status').filter({ hasText: `已刪除「${NAME}」` })).toBeVisible()
  await expect(page.getByTestId('managed-opportunity').filter({ hasText: COMPANY })).toHaveCount(0)
  await expect(page.getByTestId('danger-opportunity').filter({ hasText: NAME })).toHaveCount(0)
  // 危險操作區不會因為刪掉的是最後一件就整區消失（成功句子掛在這一區；CI 的資料庫只有這一件時曾經看不到句子）。
  await expect(danger).toBeVisible()

  // 重新整理仍然不在；前台詳情是 404（不是「已下架」）；負責老師的清單也沒有了。
  await page.reload()
  await expect(page.getByTestId('managed-opportunity').filter({ hasText: COMPANY })).toHaveCount(0)
  expect((await page.goto(`/industry/${id}`))?.status()).toBe(404)
  await signIn(page, teacher)
  await page.goto('/dashboard/teacher/industry')
  await expect(page.getByTestId('managed-opportunity').filter({ hasText: COMPANY })).toHaveCount(0)
  const audit = await pool.query(`select payload->>'status' as status from audit_events where action = 'opportunity.deleted' and target_id = $1`, [id])
  expect(audit.rows).toEqual([{ status: 'withdrawn' }])
})

test('活動：排定中要先取消；已取消的刪得掉，從「已取消」清單消失', async ({ page }) => {
  await signIn(page, admin)
  await page.goto(`/dashboard/admin/timeline?cohort=${cohortId}`)

  const scheduled = page.getByRole('region', { name: '已排定的活動' })
  const cancelled = page.getByRole('region', { name: '已取消的活動' })
  const danger = page.getByRole('region', { name: '危險操作' })
  // 刪除入口只在頁面底部的「危險操作」區：已排定、已取消清單的列上沒有刪除鈕（§9 規則 1）。
  await expect(scheduled).toContainText(SCHEDULED)
  await expect(cancelled).toContainText(CANCELLED)
  await expect(scheduled.getByRole('button', { name: /^刪除/ })).toHaveCount(0)
  await expect(cancelled.getByRole('button', { name: /^刪除/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: `刪除活動：${CANCELLED}` })).toHaveCount(1)
  await expect(danger.getByTestId('danger-activity').filter({ hasText: SCHEDULED })).toContainText('要先「取消活動」')

  await danger.getByRole('button', { name: `刪除活動：${SCHEDULED}` }).click()
  const blocked = page.getByRole('dialog', { name: `還不能刪除「${SCHEDULED}」` })
  await expect(blocked).toContainText('要先「取消活動」才能刪除')
  await expect(blocked.getByRole('button', { name: '刪除這個活動' })).toHaveCount(0)
  await blocked.getByRole('button', { name: '知道了' }).click()

  await danger.getByRole('button', { name: `刪除活動：${CANCELLED}` }).click()
  const confirm = page.getByRole('dialog', { name: `刪除「${CANCELLED}」？` })
  await expect(confirm).toContainText('不能。')
  await confirm.getByRole('button', { name: '刪除這個活動' }).click()
  await expect(danger.getByRole('status').filter({ hasText: `已刪除活動「${CANCELLED}」` })).toBeVisible()
  await expect(cancelled).toHaveCount(0)
  await expect(danger.getByTestId('danger-activity').filter({ hasText: CANCELLED })).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('main')).not.toContainText(CANCELLED)
  await expect(page.getByRole('region', { name: '已排定的活動' })).toContainText(SCHEDULED)
  const rows = await pool.query<{ title: string; deleted: boolean }>(
    `select title, deleted_at is not null as deleted from project_events where cohort_id = $1`,
    [cohortId],
  )
  expect(Object.fromEntries(rows.rows.map((r) => [r.title, r.deleted]))).toEqual({ [SCHEDULED]: false, [CANCELLED]: true })
})
