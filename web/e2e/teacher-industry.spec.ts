import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 老師規格 TE-01（網站問題 #1）：新建合作案後**不重新載入**，同一頁接著下架、重新發布都按得動。
 *
 * 曾經 `useDialog()` 每次 render 回新物件，新增對話框的 effect 依賴它，新建成功後 `setVersion` → 再 render →
 * 新的 dialog → effect 再跑 → 無限迴圈，頁面卡死、console 出現 "Maximum update depth exceeded"。
 * 老師頁（`teacher/industry/opportunity-forms.tsx`）與系辦頁（`_industry/opportunity-forms.tsx`）各一份，都走一遍
 * （AC-TE-23、AC-TE-24）。`industry.spec.ts` 的建案流程在發布前會重新載入，所以抓不到這個問題。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()

let pool: Pool
let teacher: TestSession
let admin: TestSession

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const fresh = async (role: 'teacher' | 'admin') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  teacher = await fresh('teacher')
  admin = await fresh('admin')
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function revisionOf(company: string): Promise<number> {
  const rows = await pool.query<{ revision: number }>('select revision from industry_opportunities where company_name = $1', [company])
  return rows.rows[0]!.revision
}

/** 收 console 的錯誤與警告：React 的 "Maximum update depth exceeded" 是 console.error。 */
function watchConsole(page: Page): string[] {
  const messages: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') messages.push(msg.text())
  })
  page.on('pageerror', (error) => messages.push(error.message))
  return messages
}

/** 新增 → 儲存並發布；不重新載入，同一列下架、重新發布。每一步 2 秒內看到新狀態，版本號一步加一。 */
async function createThenToggle(page: Page, path: string, company: string, pickOwner?: string) {
  const messages = watchConsole(page)
  const name = `${company}・資訊部`
  await page.goto(path)
  const dialog = page.getByRole('dialog', { name: '新增合作案' })
  // 剛載入時按鈕可能還沒接上事件，「按鈕→對話框打開」整段重試到成功為止。
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.getByRole('button', { name: '新增合作案' }).click()
    await expect(dialog).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  if (pickOwner) await dialog.getByRole('combobox', { name: /負責老師/ }).selectOption(pickOwner)
  await dialog.getByLabel('公司名稱').fill(company)
  await dialog.getByLabel('需求部門').fill('資訊部')
  await dialog.getByLabel('專題／合作內容').fill('門市補貨預測')
  await dialog.getByRole('button', { name: '儲存並發布' }).click()

  // 狀態看列上的標籤（完全等於那幾個字）：關著的確認對話框也在列裡，說明句裡就有「已下架」。
  const row = page.getByTestId('managed-opportunity').filter({ hasText: company })
  const status = (label: string) => row.getByText(label, { exact: true })
  await expect(dialog).toBeHidden({ timeout: 2_000 })
  await expect(status('已發布')).toBeVisible({ timeout: 2_000 })
  await expect.poll(() => revisionOf(company)).toBe(1)

  // 頁面沒卡住：下架鈕按得下去、確認後對話框關掉、列變「已下架」。
  await row.getByRole('button', { name: `下架：${name}` }).click({ timeout: 2_000 })
  const withdraw = page.getByRole('dialog', { name: `下架「${name}」` })
  await withdraw.getByRole('button', { name: '確認下架' }).click({ timeout: 2_000 })
  await expect(withdraw).toBeHidden({ timeout: 2_000 })
  await expect(status('已下架')).toBeVisible({ timeout: 2_000 })
  await expect.poll(() => revisionOf(company)).toBe(2)

  await row.getByRole('button', { name: `重新發布：${name}` }).click({ timeout: 2_000 })
  const republish = page.getByRole('dialog', { name: `重新發布「${name}」` })
  await republish.getByRole('button', { name: '確認重新發布' }).click({ timeout: 2_000 })
  await expect(republish).toBeHidden({ timeout: 2_000 })
  await expect(status('已發布')).toBeVisible({ timeout: 2_000 })
  await expect.poll(() => revisionOf(company)).toBe(3)

  // 主執行緒還在回應（迴圈時這裡等不到）。
  await page.waitForFunction(() => true, undefined, { timeout: 2_000 })
  expect(messages.filter((m) => m.includes('Maximum update depth'))).toEqual([])
}

test('老師新建合作案後不重新載入，同一列下架、重新發布都按得動（AC-TE-23）', async ({ page }) => {
  await signIn(page, teacher)
  await createThenToggle(page, '/dashboard/teacher/industry', `老師連按${stamp}`)
})

test('系辦新建合作案後不重新載入，同一列下架、重新發布都按得動（AC-TE-24）', async ({ page }) => {
  await signIn(page, admin)
  await createThenToggle(page, '/dashboard/admin/industry', `系辦連按${stamp}`, teacher.userId)
})

/**
 * 老師規格 TE-08（Q81）：說明句、對話框提示不再叫老師「去找系辦」；只有被擋下的錯誤訊息可以留（AC-TE-31）。
 * 主內容區（含還沒打開的新增、發布、下架對話框）的文字都掃一遍；頁面一開始沒有被擋訊息，所以一句都不該有。
 * 「只有你與系辦看得到」是誰看得到的說明，不是叫人去找系辦，不在這裡擋。
 */
test('老師的合作案頁與對話框沒有「請洽系辦」這類說明句（AC-TE-31）', async ({ page }) => {
  await signIn(page, teacher)
  await page.goto('/dashboard/teacher/industry')
  const dialog = page.getByRole('dialog', { name: '新增合作案' })
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.getByRole('button', { name: '新增合作案' }).click()
    await expect(dialog).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  await expect(dialog.getByText('只有我與系辦', { exact: true })).toBeVisible()

  // 只掃主內容區：body 的 textContent 會連 <script> 裡的 RSC 資料（前台頁尾那句聯絡資訊）一起算進來。
  const text = (await page.locator('main').textContent()) ?? ''
  expect(text).toContain('專題／合作內容') // 對話框裡的表單也掃到了
  expect(text).not.toMatch(/洽系辦|系辦退回|交系辦|聯絡系辦/)
})

/**
 * 老師規格 TE-05（Q77、Q52）：分組總覽分成「我的組別｜合作案」兩個分頁；舊網址 `/dashboard/teacher/industry`
 * 先過老師角色檢查再轉到「合作案」分頁（AC-TE-19、AC-TE-29、AC-TE-30）。
 * 下面三條各自建資料，不依賴上面幾條的順序。
 */
async function freshSession(role: 'teacher' | 'student'): Promise<TestSession> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  try {
    return await createTestSession(context, role)
  } finally {
    await context.dispose()
  }
}

const tabsOf = (page: Page) => page.getByRole('navigation', { name: '分組總覽分頁' })

test('TE-05：舊網址「合作案」轉到分組總覽的合作案分頁；學生打同網址仍是 403（角色檢查在轉頁之前）', async ({ page }) => {
  const owner = await freshSession('teacher')
  const student = await freshSession('student')
  const company = `轉頁${stamp}`
  await signIn(page, owner)
  await createThenToggle(page, '/dashboard/teacher/groups?tab=cases', company)

  await page.goto('/dashboard/teacher/industry')
  await expect(page).toHaveURL(/\/dashboard\/teacher\/groups\?tab=cases$/)
  await expect(tabsOf(page).getByRole('link', { name: '合作案', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('managed-opportunity').filter({ hasText: company })).toBeVisible()
  // 「全部」照舊帶過去。
  await page.goto('/dashboard/teacher/industry?scope=all')
  await expect(page).toHaveURL(/\/dashboard\/teacher\/groups\?tab=cases&scope=all$/)
  await expect(page.getByRole('navigation', { name: '合作案範圍' }).getByRole('link', { name: /^全部/ })).toHaveAttribute('aria-current', 'page')

  await signIn(page, student)
  await page.goto('/dashboard/teacher/industry')
  await expect(page).toHaveURL(/\/403/)
})

test('TE-05：合作案分頁只有自己的案能編輯；「全部」看得到別人的案但沒有編輯鍵（AC-TE-30）', async ({ page }) => {
  const mine = await freshSession('teacher')
  const other = await freshSession('teacher')
  const myCompany = `案主甲${stamp}`
  const otherCompany = `案主乙${stamp}`
  await signIn(page, other)
  await createThenToggle(page, '/dashboard/teacher/groups?tab=cases', otherCompany)
  await signIn(page, mine)
  await createThenToggle(page, '/dashboard/teacher/groups?tab=cases', myCompany)

  const myRow = page.getByTestId('managed-opportunity').filter({ hasText: myCompany })
  await expect(myRow.getByRole('button', { name: `編輯：${myCompany}・資訊部` })).toBeVisible()
  await expect(myRow.getByRole('button', { name: `下架：${myCompany}・資訊部` })).toBeVisible()
  await expect(page.getByTestId('managed-opportunity').filter({ hasText: otherCompany })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '新增合作案' })).toBeVisible()
  expect((await page.getByRole('main').textContent()) ?? '').not.toMatch(/洽系辦|系辦退回|交系辦|聯絡系辦/)

  await page.goto('/dashboard/teacher/groups?tab=cases&scope=all')
  const all = page.getByRole('list', { name: '全部合作案' })
  await expect(all.getByRole('listitem').filter({ hasText: otherCompany })).toContainText('只有負責老師能編輯')
  await expect(all.getByRole('listitem').filter({ hasText: otherCompany }).getByRole('button')).toHaveCount(0)
  await expect(all.getByRole('listitem').filter({ hasText: myCompany })).toContainText('在「我的」管理')
})

test('TE-05：我的組別分頁有「我指導的組」卡片、擔任產學組、全部組別；擔任後重新整理多一張卡（AC-TE-19、AC-TE-29）', async ({ page }) => {
  test.setTimeout(120_000)
  const t1 = await freshSession('teacher')
  const code = `TE05-${stamp}`
  const day = (offset: number) => new Date(Date.now() + 8 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10)
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 'system') returning id`,
    [code, `${code} 分組總覽`, day(300)],
  )
  const cohortId = cohort.rows[0]!.id
  let seq = 0
  const at = new Date(Date.now() - 86_400_000)
  const leaders = new Map<string, string>()
  async function student(): Promise<{ id: string; name: string }> {
    seq += 1
    const name = `TE05組員${seq}`
    const studentNo = `405${String(Date.now()).slice(-5)}${seq}`
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [name, `te05-${stamp.toLowerCase()}-${seq}@example.com`],
    )
    const id = user.rows[0]!.id
    await pool.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, admin.userId],
    )
    await pool.query(
      `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
       values ($1, $2, $2, $3, $4, '0912000000', $5)`,
      [id, name, studentNo, cohortId, `te05-${seq}@contact.example.com`],
    )
    await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
    return { id, name }
  }
  async function group(groupCode: string, type: 'general' | 'industry', advisor: string | null) {
    const members = [await student(), await student()]
    const ids = members.map((m) => m.id)
    const row = await pool.query<{ id: string }>(
      `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                           created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
       values (gen_random_uuid(), $1, $2, $3, 'active', $5, $5, $5, 'user', $4, $5, $4) returning id`,
      [cohortId, groupCode, type, ids[0], at],
    )
    const groupId = row.rows[0]!.id
    await pool.query(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
       select gen_random_uuid(), $1, $2, u, $4, 'user', $3, $4, $4 from unnest($5::uuid[]) as u`,
      [groupId, cohortId, ids[0], at, ids],
    )
    await pool.query(
      `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at) values (gen_random_uuid(), $1, $2, $3, $2, $3)`,
      [groupId, ids[0], at],
    )
    if (advisor) {
      await pool.query(
        `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
         values (gen_random_uuid(), $1, $2, 'admin', $3, $4, '抽籤結果')`,
        [groupId, advisor, at, admin.userId],
      )
    }
    leaders.set(groupCode, members[0]!.name)
  }
  await group('G01', 'industry', t1.userId)
  await group('G02', 'general', t1.userId)
  await group('G04', 'industry', null)

  await signIn(page, t1)
  await page.goto(`/dashboard/teacher/groups?cohort=${cohortId}`)
  const tabs = tabsOf(page)
  await expect(tabs.getByRole('link')).toHaveText(['我的組別', '合作案'])
  await expect(tabs.getByRole('link', { name: '我的組別', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('main')).toContainText('一般組由系辦指派。')

  const myGroups = page.getByRole('region', { name: '我指導的組' })
  await expect(myGroups.getByRole('listitem')).toHaveCount(2)
  const g01 = myGroups.getByTestId('my-group-G01')
  await expect(g01).toContainText(`G01・${leaders.get('G01')}`)
  await expect(g01).toContainText('產學合作')
  await expect(myGroups.getByTestId('my-group-G02')).toContainText('一般專題')
  await expect(g01.getByRole('link')).toHaveAttribute('href', '/dashboard/teacher/affairs')

  const claim = page.getByRole('region', { name: '擔任產學組指導老師' })
  await expect(claim.getByRole('row').filter({ hasText: 'G04' })).toContainText('可擔任')
  await expect(page.getByRole('region', { name: '全部組別' }).getByPlaceholder('搜尋組別或組員…')).toBeVisible()
  const text = (await page.getByRole('main').textContent()) ?? ''
  expect(text).not.toContain('認領')
  expect(text).not.toMatch(/洽系辦|系辦重派/)

  await claim.getByRole('button', { name: '擔任 G04 的指導老師' }).click()
  const dialog = page.getByRole('dialog', { name: '擔任 G04 的指導老師' })
  await dialog.getByRole('button', { name: '指定為我的組別' }).click()
  await expect(dialog.getByRole('status')).toContainText('G04 已指定為你的組別')
  await page.reload()
  await expect(page.getByRole('region', { name: '我指導的組' }).getByTestId('my-group-G04')).toBeVisible()
  await expect(page.getByRole('region', { name: '擔任產學組指導老師' }).getByRole('row').filter({ hasText: 'G04' })).toContainText('你指導中')
})
