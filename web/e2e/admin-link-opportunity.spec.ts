import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie } from './session'

/**
 * AD-06（設計方案 §3.3.1、Q73）：系辦在「全部組別」把產學組連到合作案。
 *
 * - AC-AD-11：首次連結理由選填、換案理由必填（後端原字）、過期版本照後端 `staleRevision()` 的字；
 *   下拉只有已發布的案（草稿、下架不出現）。
 * - AC-AD-12：一般組那一列與詳情都沒有連結入口。
 * - AC-AD-37：合作案超過 50 筆時，搜尋與「下一頁」選得到第 51 筆。
 *
 * `linkOptions` 不分屆別，而 e2e 資料庫是各 spec 共用的（別的 spec 也留著已發布合作案）：
 * 本檔的合作案都帶本次的戳記，要看「只有哪幾筆」時先用搜尋框縮到本次的案。
 * AC-AD-37 的 51 筆只在它自己的 `describe` 內種、跑完刪掉，排在 AC-AD-11 之後（不然會擠進 AC-AD-11 的下拉）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `AD06-${stamp}`
/** AC-AD-11 合作案名稱都帶這個戳記，搜尋它就只剩本次的案。 */
const TAG = `Q73${stamp}`
const 甲 = `甲公司${TAG}`
const 乙 = `乙公司${TAG}`
const 丙 = `丙公司${TAG}`
const 丁 = `丁公司${TAG}`

let pool: Pool
let adminId: string
let teacherLee: string
let teacherWang: string
const groupIds = new Map<string, string>()
const opportunityIds = new Map<string, string>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function teacher(name: string): Promise<string> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  try {
    const session = await createTestSession(context, 'teacher')
    await pool.query(`update user_profiles set display_name = $2, name_normalized = $2 where user_id = $1`, [session.userId, name])
    return session.userId
  } finally {
    await context.dispose()
  }
}

async function insertOpportunity(
  company: string,
  department: string,
  owner: string,
  status: 'published' | 'draft' | 'withdrawn',
): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into industry_opportunities
       (id, owner_teacher_user_id, company_name, department, content, requirements, status,
        published_business_at, withdrawn_business_at, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, 'AD-06 測試的合作內容', '會 Python', $4,
             case when $4 = 'draft' then null else now() end, case when $4 = 'withdrawn' then now() else null end, 'user', $1)
     returning id`,
    [owner, company, department, status],
  )
  opportunityIds.set(company, row.rows[0]!.id)
  return row.rows[0]!.id
}

async function insertCohort(code: string): Promise<string> {
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 'system') returning id`,
    [code, `${code} 連結合作案測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  return cohort.rows[0]!.id
}

async function insertGroup(cohortId: string, code: string, type: 'general' | 'industry'): Promise<string> {
  const at = new Date(Date.now() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                         created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, 'active', $5, $5, $5, 'user', $4, $5, $4) returning id`,
    [cohortId, code, type, adminId, at],
  )
  return group.rows[0]!.id
}

let cohortId: string

test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備合作案與組別')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  teacherLee = await teacher('李老師')
  teacherWang = await teacher('王老師')

  cohortId = await insertCohort(CODE)
  groupIds.set('G01', await insertGroup(cohortId, 'G01', 'general'))
  groupIds.set('G03', await insertGroup(cohortId, 'G03', 'industry'))

  await insertOpportunity(甲, '研發部', teacherLee, 'published')
  await insertOpportunity(丙, '資訊部', teacherWang, 'published')
  await insertOpportunity(乙, '研發部', teacherLee, 'draft')
  await insertOpportunity(丁, '資訊部', teacherWang, 'withdrawn')
})

test.afterAll(async () => {
  await pool?.end()
})

async function openGroups(page: Page, cohort: string) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
  await page.goto(`/dashboard/admin/groups?cohort=${cohort}`)
  await expect(page.getByRole('heading', { name: '分組', exact: true })).toBeVisible()
  return page.getByRole('region', { name: '全部組別' })
}

/** 縮到本次的案：搜尋框打戳記，等下拉換成搜尋結果。 */
async function narrowTo(dialog: ReturnType<Page['getByRole']>, term: string, expected: number) {
  await dialog.getByLabel('搜尋公司名').fill(term)
  // 等這個查詢真的回來（初始清單筆數剛好相同時，只看筆數等於沒等）。
  await expect(dialog.getByTestId('link-options')).toHaveAttribute('data-query', term.trim())
  await expect(dialog.getByTestId('link-options')).toHaveAttribute('aria-busy', 'false')
  await expect(dialog.getByLabel('合作案').locator('option')).toHaveCount(expected)
}

async function audits(action: string, groupId: string) {
  const rows = await pool.query<{ reason: string | null }>(
    `select reason from audit_events where action = $1 and target_id = $2 order by real_at`,
    [action, groupId],
  )
  return rows.rows
}

test('AC-AD-11 首次連結：下拉只有已發布的案、理由可留空；列上顯示合作案與「改連結」，合作案頁看得到 G03，稽核理由空白', async ({ page }) => {
  const groups = await openGroups(page, cohortId)
  await groups.getByRole('button', { name: '連結合作案 G03' }).click()
  const dialog = page.getByRole('dialog', { name: '把 G03 連到合作案' })
  await expect(dialog.getByRole('heading', { name: '把 G03 連到合作案' })).toBeVisible()
  await expect(dialog.getByText('可留空')).toBeVisible()

  // 本次種了四筆（甲丙已發布、乙草稿、丁下架）：搜尋戳記只剩甲、丙。
  await narrowTo(dialog, TAG, 2)
  const options = dialog.getByLabel('合作案').locator('option')
  expect((await options.allTextContents()).sort()).toEqual([`${甲}・研發部・李老師`, `${丙}・資訊部・王老師`].sort())

  await dialog.getByLabel('合作案').selectOption({ label: `${甲}・研發部・李老師` })
  await dialog.getByRole('button', { name: '連結', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(groups.getByRole('status')).toContainText(`G03 已連結「${甲}・研發部」`)

  await page.reload()
  const row = page.getByRole('region', { name: '全部組別' })
  await expect(row.getByRole('link', { name: `${甲}・研發部` })).toBeVisible()
  await expect(row.getByRole('button', { name: '改連結 G03' })).toBeVisible()

  await page.goto('/dashboard/admin/industry')
  await expect(page.getByTestId('managed-opportunity').filter({ hasText: 甲 })).toContainText('G03')

  expect(await audits('opportunity.link', groupIds.get('G03')!)).toEqual([{ reason: null }])
})

test('AC-AD-11 換案：理由空白照後端原字擋下；填了理由才換成，稽核 opportunity.switch 帶理由', async ({ page }) => {
  const groups = await openGroups(page, cohortId)
  await groups.getByRole('button', { name: '改連結 G03' }).click()
  const dialog = page.getByRole('dialog', { name: '把 G03 改連到別的合作案' })
  await expect(dialog).toContainText(`目前連結：${甲}・研發部`)
  await expect(dialog.getByText('換案必填')).toBeVisible()

  await narrowTo(dialog, TAG, 2)
  await dialog.getByLabel('合作案').selectOption({ label: `${丙}・資訊部・王老師` })
  await dialog.getByRole('button', { name: '連結', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('換案一定要填理由。')

  await dialog.getByLabel('理由').fill('業師更換')
  await dialog.getByRole('button', { name: '連結', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(groups.getByRole('status')).toContainText(`G03 已從「${甲}・研發部」換到「${丙}・資訊部」`)
  await page.reload()
  await expect(page.getByRole('region', { name: '全部組別' }).getByRole('link', { name: `${丙}・資訊部` })).toBeVisible()

  expect(await audits('opportunity.switch', groupIds.get('G03')!)).toEqual([{ reason: '業師更換' }])
})

test('AC-AD-11 過期：兩個分頁同時開，A 先換成功，B 再送看到後端的過期字、不覆蓋 A', async ({ page, browser }) => {
  const pageB = await (await browser.newContext()).newPage()
  const open = async (p: Page) => {
    const groups = await openGroups(p, cohortId)
    await groups.getByRole('button', { name: '改連結 G03' }).click()
    const dialog = p.getByRole('dialog', { name: '把 G03 改連到別的合作案' })
    await narrowTo(dialog, TAG, 2)
    await dialog.getByLabel('合作案').selectOption({ label: `${甲}・研發部・李老師` })
    return dialog
  }
  const dialogA = await open(page)
  const dialogB = await open(pageB)

  await dialogA.getByLabel('理由').fill('A 換回甲')
  await dialogA.getByRole('button', { name: '連結', exact: true }).click()
  await expect(dialogA).toBeHidden()

  await dialogB.getByLabel('理由').fill('B 也想換')
  await dialogB.getByRole('button', { name: '連結', exact: true }).click()
  await expect(dialogB.getByRole('alert')).toHaveText('剛剛有人改過這份資料，請重新整理頁面看最新的內容再改。')

  expect((await audits('opportunity.switch', groupIds.get('G03')!)).map((a) => a.reason)).toEqual(['業師更換', 'A 換回甲'])
  await pageB.context().close()
})

test('搜尋結果回來時，原本選的案還在清單裡就保留選取；查詢中下拉與「連結」鎖住（Review FIX）', async ({ page }) => {
  const groups = await openGroups(page, cohortId)
  await groups.getByRole('button', { name: '改連結 G03' }).click()
  const dialog = page.getByRole('dialog', { name: '把 G03 改連到別的合作案' })
  await narrowTo(dialog, TAG, 2)
  const pick = dialog.getByLabel('合作案')
  // 選「不是第一筆」的那一案：舊版查詢回來會把下拉改回第一筆。
  const [first, second] = await pick.locator('option').allTextContents()
  expect(second).toBeTruthy()
  await pick.selectOption({ label: second! })

  // 讓下一次選項查詢晚 1.5 秒回來（Server Action 是帶 next-action 標頭的 POST）。
  await page.route('**/dashboard/admin/groups**', async (route) => {
    if (route.request().method() === 'POST' && route.request().headers()['next-action']) {
      await new Promise((r) => setTimeout(r, 1_500))
    }
    await route.continue()
  })
  await dialog.getByLabel('搜尋公司名').fill(`${TAG} `)
  await expect(dialog.getByTestId('link-options')).toHaveAttribute('aria-busy', 'true')
  await expect(pick).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '連結', exact: true })).toBeDisabled()

  await expect(dialog.getByTestId('link-options')).toHaveAttribute('aria-busy', 'false')
  await expect(pick.locator('option')).toHaveCount(2)
  await expect(pick).toBeEnabled()
  await expect(pick.locator('option:checked')).toHaveText(second!)
  expect(first).not.toBe(second)
  await page.unroute('**/dashboard/admin/groups**')
  await dialog.getByRole('button', { name: '取消' }).click()
})

test('AC-AD-12 一般組 G01：列上與詳情都沒有連結入口', async ({ page }) => {
  const groups = await openGroups(page, cohortId)
  await expect(groups.getByRole('button', { name: '連結合作案 G03' })).toHaveCount(0) // G03 已連結，入口是「改連結」
  await expect(groups.getByRole('button', { name: /連結合作案 G01|改連結 G01/ })).toHaveCount(0)
  await groups.getByRole('button', { name: 'G01 詳情' }).click()
  const detail = page.getByRole('dialog', { name: 'G01 詳情' })
  await expect(detail).toBeVisible()
  await expect(detail).not.toContainText('連結合作案')
})

test.describe('AC-AD-37 合作案超過 50 筆', () => {
  // 51 筆只在這個 describe 種、跑完刪掉；用另一屆的 G03（未連結），不動上面那屆。
  const DEPT = `AD06 第51筆 ${stamp}`
  const name = (n: number) => `合作案 ${String(n).padStart(2, '0')}`
  const label = (n: number) => `${name(n)}・${DEPT}・李老師`
  let otherCohort: string
  let g03: string
  const seeded: string[] = []

  test.beforeAll(async () => {
    otherCohort = await insertCohort(`${CODE}-51`)
    g03 = await insertGroup(otherCohort, 'G03', 'industry')
    for (let n = 1; n <= 51; n += 1) seeded.push(await insertOpportunity(name(n), DEPT, teacherLee, 'published'))
    seeded.push(await insertOpportunity(`乙公司${stamp}`, DEPT, teacherLee, 'draft'))
  })

  test.afterAll(async () => {
    await pool.query(`delete from opportunity_links where opportunity_id = any($1::uuid[])`, [seeded])
    await pool.query(`delete from industry_opportunities where id = any($1::uuid[])`, [seeded])
  })

  test('搜尋框常駐；下一頁看得到第 51 筆；打字回到第一頁只剩它；選它連結成功', async ({ page }) => {
    const groups = await openGroups(page, otherCohort)
    await groups.getByRole('button', { name: '連結合作案 G03' }).click()
    const dialog = page.getByRole('dialog', { name: '把 G03 連到合作案' })
    const options = dialog.getByLabel('合作案').locator('option')

    // 步驟 1：沒打字就有搜尋框；下拉 50 筆，沒有第 51 筆、沒有草稿。
    await expect(dialog.getByLabel('搜尋公司名')).toBeVisible()
    await expect(options).toHaveCount(50)
    await expect(options.filter({ hasText: label(51) })).toHaveCount(0)
    await expect(options.filter({ hasText: `乙公司${stamp}` })).toHaveCount(0)

    // 步驟 2：按「下一頁」直到看到第 51 筆（共用資料庫可能有別的已發布案排在前面）。
    for (let i = 0; i < 20 && (await options.filter({ hasText: label(51) }).count()) === 0; i += 1) {
      const first = await options.first().textContent()
      await dialog.getByRole('button', { name: '下一頁' }).click()
      await expect(options.first()).not.toHaveText(first ?? '')
    }
    await expect(options.filter({ hasText: label(51) })).toHaveCount(1)
    await expect(dialog.getByRole('button', { name: '上一頁' })).toBeVisible()
    // 這一頁不足 50 筆時「下一頁」不再出現（隔離資料庫裡就是只剩「合作案 51」這一筆）。
    const count = await options.count()
    await expect(dialog.getByRole('button', { name: '下一頁' })).toHaveCount(count === 50 ? 1 : 0)

    // 步驟 3：打「51」，回到第一頁，本次種的只剩「合作案 51」。
    await dialog.getByLabel('搜尋公司名').fill('51')
    await expect(dialog.getByRole('button', { name: '上一頁' })).toHaveCount(0)
    await expect(options.filter({ hasText: DEPT })).toHaveText([label(51)])

    // 步驟 4：選它、理由留空，連結成功。
    await dialog.getByLabel('合作案').selectOption({ label: label(51) })
    await dialog.getByRole('button', { name: '連結', exact: true }).click()
    await expect(dialog).toBeHidden()
    await page.reload()
    const row = page.getByRole('region', { name: '全部組別' })
    await expect(row.getByRole('link', { name: `${name(51)}・${DEPT}` })).toBeVisible()
    await expect(row.getByRole('button', { name: '改連結 G03' })).toBeVisible()
    expect(await audits('opportunity.link', g03)).toEqual([{ reason: null }])
  })
})
