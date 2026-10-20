import { expect, request as playwrightRequest, test, type Page, type Request } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * AD-06（設計方案 §3.3.1、Q73）：系辦在「全部組別」把產學組連到合作案。
 *
 * - AC-AD-11：首次連結與換案理由都選填（C3-05）、過期版本照後端 `staleRevision()` 的字；
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
const teacherSessions = new Map<string, TestSession>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function teacher(name: string): Promise<string> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  try {
    const session = await createTestSession(context, 'teacher')
    teacherSessions.set(session.userId, session)
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
  await page.getByRole('article', { name: 'G03', exact: true }).locator('summary').click()
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
  await expect(dialog.getByLabel('理由（可不填）')).toHaveValue('')

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
  await row.getByRole('article', { name: 'G03', exact: true }).locator('summary').click()
  await expect(row.getByRole('link', { name: `${甲}・研發部` })).toBeVisible()
  await expect(row.getByRole('button', { name: '改連結 G03' })).toBeVisible()

  await page.goto('/dashboard/admin/industry')
  await expect(page.getByTestId('managed-opportunity').filter({ hasText: 甲 })).toContainText('G03')

  expect(await audits('opportunity.link', groupIds.get('G03')!)).toEqual([{ reason: null }])
})

test('AC-AD-11 換案：填了理由換成，稽核 opportunity.switch 帶理由', async ({ page }) => {
  const groups = await openGroups(page, cohortId)
  await groups.getByRole('button', { name: '改連結 G03' }).click()
  const dialog = page.getByRole('dialog', { name: '把 G03 改連到別的合作案' })
  await expect(dialog).toContainText(`目前連結：${甲}・研發部`)
  await expect(dialog.getByLabel('理由（可不填）')).toHaveValue('')

  await narrowTo(dialog, TAG, 2)
  await dialog.getByLabel('合作案').selectOption({ label: `${丙}・資訊部・王老師` })
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
  await groups.getByRole('article', { name: 'G01', exact: true }).getByRole('link', { name: '進入小組' }).click()
  const detail = page.getByRole('main')
  await expect(detail).toBeVisible()
  await expect(detail.getByRole('region', { name: '合作案', exact: true })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: /連結合作案|改連結/ })).toHaveCount(0)
})

test('C3-12：詳情解除合作案理由留空，回執留在頁面，重整後連結已解除', async ({ page }) => {
  const groups = await openGroups(page, cohortId)
  await groups.getByRole('article', { name: 'G03', exact: true }).locator('summary').click()
  await groups.getByRole('article', { name: 'G03', exact: true }).getByRole('link', { name: '進入小組' }).click()
  await page.getByRole('button', { name: '解除合作案', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '解除 G03 的合作案' })
  await expect(dialog.getByLabel('理由（可不填）')).toHaveValue('')
  await dialog.getByRole('button', { name: '確定解除' }).click()
  await expect(page.getByRole('status')).toContainText(`已解除 G03 與「${甲}・研發部」的連結`)
  await expect(page.getByRole('region', { name: '合作案', exact: true })).toContainText('尚未連結合作案')
  await page.reload()
  await expect(page.getByRole('button', { name: '解除合作案', exact: true })).toHaveCount(0)
  expect((await audits('opportunity.unlink', groupIds.get('G03')!)).map((a) => a.reason)).toEqual([''])
})

/** 擷取真實表單的 action POST，攔下原請求，再以不同身分直接重送。 */
async function captureAction(page: Page, submit: () => Promise<void>): Promise<Request> {
  await page.route('**/dashboard/admin/groups**', async (route) => {
    if (route.request().method() === 'POST' && route.request().headers()['next-action']) await route.abort()
    else await route.continue()
  })
  const requested = page.waitForRequest((req) => req.method() === 'POST' && Boolean(req.headers()['next-action']))
  await submit()
  const request = await requested
  await page.unroute('**/dashboard/admin/groups**')
  return request
}

async function replayAction(request: Request, session: TestSession) {
  const client = await playwrightRequest.newContext({ baseURL: BASE_URL })
  try {
    const response = await client.post(request.url(), {
      headers: {
        cookie: session.cookie,
        origin: new URL(BASE_URL).origin,
        'next-action': request.headers()['next-action']!,
        'content-type': request.headers()['content-type']!,
      },
      data: request.postDataBuffer()!,
      maxRedirects: 0,
    })
    return { status: response.status(), body: await response.text() }
  } finally {
    await client.dispose()
  }
}

async function groupFootprint(id: string) {
  const result = await pool.query(
    `select to_jsonb(g) as group_row,
      (select jsonb_agg(l order by l.id) from opportunity_links l where l.group_id=g.id) as links,
      (select count(*)::int from audit_events a where a.target_id=g.id) as audits,
      (select count(*)::int from domain_events e where e.source_id=g.id) as events,
      (select count(*)::int from operation_records r where r.cohort_id=g.cohort_id) as operations
     from groups g where g.id=$1`, [id],
  )
  return result.rows[0]
}

test('R1：系辦解除 action 直接 POST，學生、必須改密系辦及案主老師皆拒絕且資料不變，正常系辦成功', async ({ page }) => {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const student = await createTestSession(context, 'student')
  await context.dispose()
  const passwordContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const mustChange = await createTestSession(passwordContext, 'admin')
  await passwordContext.dispose()
  await pool.query('update users set must_change_password=true where id=$1', [mustChange.userId])
  const ownCohort = await insertCohort(`${CODE}-R1-UNLINK`)
  const id = await insertGroup(ownCohort, 'G03', 'industry')
  await pool.query(`insert into opportunity_links (id, group_id, opportunity_id, state, valid_from, linked_by_user_id)
    values (gen_random_uuid(), $1, $2, 'active', now(), $3)`, [id, opportunityIds.get(甲), adminId])
  const admin = await sharedTestSession(page.request, 'admin')
  await page.context().addCookies([toPlaywrightCookie(admin.cookie, BASE_URL)])
  await page.goto(`/dashboard/admin/groups/${id}`)
  await page.getByRole('button', { name: '解除合作案', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '解除 G03 的合作案' })
  const request = await captureAction(page, () => dialog.getByRole('button', { name: '確定解除' }).click())
  const before = await groupFootprint(id)
  for (const [name, session] of [['學生', student], ['必須改密系辦', mustChange], ['案主老師', teacherSessions.get(teacherLee)!]] as const) {
    const response = await replayAction(request, session)
    expect(await groupFootprint(id), name).toEqual(before)
    expect(response.body, name).toContain('"ok":false')
  }
  const accepted = await replayAction(request, admin)
  expect(accepted.status).toBe(200)
  expect(accepted.body).toContain('"ok":true')
  expect((await pool.query('select valid_to from opportunity_links where group_id=$1', [id])).rows[0].valid_to).not.toBeNull()
  expect(await audits('opportunity.unlink', id)).toHaveLength(1)
})

test('R1：學生組長不能直接 POST 系辦改類型 action，資料不變；正常系辦成功', async ({ page }) => {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const leader = await createTestSession(context, 'student')
  await context.dispose()
  const ownCohort = await insertCohort(`${CODE}-R1-TYPE`)
  for (const [i, days] of [-10, 30, 90, 150].entries()) {
    await pool.query(`insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
      values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
    [ownCohort, i + 1, ['成組期', '期中', '期末', '成果'][i], ymd(new Date(Date.now() + days * 86_400_000))])
  }
  const id = await insertGroup(ownCohort, 'G01', 'general')
  await pool.query('update user_profiles set cohort_id=$2 where user_id=$1', [leader.userId, ownCohort])
  await pool.query(`insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id)
    values (gen_random_uuid(), $1, $2, $3, now(), 'user', $3)`, [id, ownCohort, leader.userId])
  await pool.query(`insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id)
    values (gen_random_uuid(), $1, $2, now(), $2)`, [id, leader.userId])
  const admin = await sharedTestSession(page.request, 'admin')
  await page.context().addCookies([toPlaywrightCookie(admin.cookie, BASE_URL)])
  await page.goto(`/dashboard/admin/groups?cohort=${ownCohort}`)
  const card = page.getByRole('article', { name: 'G01', exact: true })
  await card.locator('summary').click()
  await card.getByRole('button', { name: '改組別類型：G01' }).click()
  const request = await captureAction(page, () => page.getByRole('button', { name: '確認改成產學合作' }).click())
  const before = await groupFootprint(id)
  const denied = await replayAction(request, leader)
  expect(await groupFootprint(id)).toEqual(before)
  expect(denied.body).toContain('"ok":false')
  const accepted = await replayAction(request, admin)
  expect(accepted.status).toBe(200)
  expect(accepted.body).toContain('"ok":true')
  expect((await pool.query('select group_type from groups where id=$1', [id])).rows[0].group_type).toBe('industry')
  expect(await audits('group.type.change', id)).toHaveLength(1)
})

test('R1：觸控詳情與巢狀對話框按鈕至少 44×44，指導老師顯示既有頭像', async ({ browser }) => {
  const ownCohort = await insertCohort(`${CODE}-R1-TOUCH`)
  const id = await insertGroup(ownCohort, 'G03', 'industry')
  await pool.query(`insert into opportunity_links (id, group_id, opportunity_id, state, valid_from, linked_by_user_id)
    values (gen_random_uuid(), $1, $2, 'active', now(), $3)`, [id, opportunityIds.get(甲), adminId])
  await pool.query(`insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
    values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '')`, [id, teacherLee, adminId])
  await pool.query('update user_profiles set avatar_preset=23 where user_id=$1', [teacherLee])
  const context = await browser.newContext({ baseURL: BASE_URL, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  try {
    const admin = await sharedTestSession(context.request, 'admin')
    await context.addCookies([toPlaywrightCookie(admin.cookie, BASE_URL)])
    const page = await context.newPage()
    await page.goto(`/dashboard/admin/groups/${id}`)
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    const advisor = page.getByRole('region', { name: '指導老師', exact: true })
    const opportunity = page.getByRole('region', { name: '合作案', exact: true })
    const size = async (button: ReturnType<Page['getByRole']>) => {
      const box = await button.boundingBox()
      const label = await button.getAttribute('aria-label') ?? await button.innerText()
      expect(box, label).not.toBeNull()
      console.log(`R1 touch ${label}: ${box!.width}×${box!.height}`)
      expect.soft(box!.width, `${label} width`).toBeGreaterThanOrEqual(44)
      expect.soft(box!.height, `${label} height`).toBeGreaterThanOrEqual(44)
    }
    await size(advisor.getByRole('button', { name: '重派指導老師：G03' }))
    await size(advisor.getByRole('button', { name: '解除指導老師：G03' }))
    await size(opportunity.getByRole('button', { name: '改連結 G03' }))
    for (const [trigger, title] of [
      ['重派指導老師：G03', '重派 G03 的指導老師'],
      ['解除指導老師：G03', '解除 G03 的指導老師？'],
      ['改連結 G03', '把 G03 改連到別的合作案'],
      ['解除合作案', '解除 G03 的合作案'],
    ]) {
      await page.getByRole('button', { name: trigger, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      await expect(dialog).toBeVisible()
      for (const button of await dialog.getByRole('button').all()) await size(button)
      await dialog.getByRole('button', { name: /^(先不要|取消)$/ }).click()
    }
    await expect.soft(advisor.locator('img')).toHaveCount(1)
    await expect.soft(advisor.locator('img')).toHaveAttribute('src', '/avatars/023.webp')
  } finally {
    await context.close()
  }
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
  await row.getByRole('article', { name: 'G03', exact: true }).locator('summary').click()
    await expect(row.getByRole('link', { name: `${name(51)}・${DEPT}` })).toBeVisible()
    await expect(row.getByRole('button', { name: '改連結 G03' })).toBeVisible()
    expect(await audits('opportunity.link', g03)).toEqual([{ reason: null }])
  })
})
