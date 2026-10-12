import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 第三波 W4（Q7②⑦、Q13、Q14；AC-31～AC-34）：指導老師看得到自己那屆的公告與範本、組別公告也給指導老師並通知、
 * 老師首頁有公告區、卡片不截斷。
 *
 * 四位老師：指導本屆 G01、指導本屆 G02、只指導別屆、沒指導任何組。公告與資源用真的「新增項目」對話框發布，
 * 收件用完整編輯器；活動、組別、指導關係、收集中的簽核版本用 owner 連線直接寫（那些有自己的 e2e）。
 *
 * 老師首頁的「本屆活動」看的是老師**自己指導的屆別**（不是系辦的工作屆別），所以這支不動工作屆別。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `W4-${stamp}`
const PDF = Buffer.from('%PDF-1.4\n% e2e W4 本屆範本\n')

const TEACHERS_NEWS = `${CODE} 全部老師公告`
const SIGNED_IN_NEWS = `${CODE} 所有登入者公告`
const GROUP_NEWS = `${CODE} G01 組別公告`
const COHORT_NEWS = `${CODE} 本屆學生公告`
const PUBLIC_NEWS = `${CODE} 公開公告`
const RESOURCE = `${CODE} 本屆報告範本`
const SUBMISSION = `${CODE} 期中報告`
const ACTIVITY = `${CODE} 專題說明會`
const OTHER_ACTIVITY = `${CODE}-X 別屆期中發表`

let pool: Pool
let cohortId: string
let advisor1: TestSession
let advisor2: TestSession
let otherCohortAdvisor: TestSession
let plainTeacher: TestSession
const groupIds: Record<string, string> = {}
const itemIds: Record<string, string> = {}
let resourceFileId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function localMinute(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16)
}

async function newCohort(code: string, now: Date): Promise<string> {
  const id = String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
        [code, ymd(new Date(now.getTime() + 300 * 86_400_000))],
      )
    ).rows[0]!.id,
  )
  for (const [i, d] of [-10, 30, 90, 150].entries()) {
    await pool.query(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [id, i + 1, ['成組期', '期中', '期末', '成果'][i], ymd(new Date(now.getTime() + d * 86_400_000))],
    )
  }
  return id
}

/** 一組（一位學生組員）＋目前的指導老師。 */
async function groupWithAdvisor(cohort: string, code: string, teacher: TestSession, adminId: string): Promise<string> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const student = await createTestSession(context, 'student')
  await context.dispose()
  const studentNo = `417${String(Date.now()).slice(-6)}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set student_no = excluded.student_no, cohort_id = excluded.cohort_id`,
    [student.userId, `${code} 組員`, studentNo, cohort, `w4-${code.toLowerCase()}-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohort, studentNo, student.userId])
  const groupId = String(
    (
      await pool.query<{ id: string }>(
        `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
         values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
        [cohort, code],
      )
    ).rows[0]!.id,
  )
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
     values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
    [groupId, cohort, student.userId],
  )
  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $3, 'e2e W4 指派')`,
    [groupId, teacher.userId, adminId],
  )
  return groupId
}

test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const now = new Date()
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處）：「本屆活動」只列今天以後的。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e W4：回到真實時間')`,
    [admin.userId],
  )

  cohortId = await newCohort(CODE, now)
  const otherCohort = await newCohort(`${CODE}-X`, now)

  const fresh = async () => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, 'teacher')
    } finally {
      await context.dispose()
    }
  }
  advisor1 = await fresh()
  advisor2 = await fresh()
  otherCohortAdvisor = await fresh()
  plainTeacher = await fresh()

  groupIds.G01 = await groupWithAdvisor(cohortId, 'G01', advisor1, admin.userId)
  groupIds.G02 = await groupWithAdvisor(cohortId, 'G02', advisor2, admin.userId)
  groupIds.G09 = await groupWithAdvisor(otherCohort, 'G09', otherCohortAdvisor, admin.userId)

  // 兩屆各一個給本屆學生的活動：老師首頁只列自己指導那一屆的（Q13），跟工作屆別是哪一屆無關。
  for (const [cohort, title] of [
    [cohortId, ACTIVITY],
    [otherCohort, OTHER_ACTIVITY],
  ] as const) {
    await pool.query(
      `insert into project_events (id, cohort_id, title, starts_at, all_day, audience_kind, status, created_by_kind, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3, false, 'cohort_students', 'scheduled', 'system', now(), now())`,
      [cohort, title, new Date(now.getTime() + 3 * 86_400_000)],
    )
  }

  // G01 一份收集中的同意書（三位學生都還沒表態）：老師首頁「同意書」寫「還有 3 位同學未同意」。
  const students = [0, 1, 2].map((i) => ({ userId: crypto.randomUUID(), displayName: `W4 同學${i + 1}`, studentNo: `41799${i}` }))
  const packageId = crypto.randomUUID()
  const versionId = crypto.randomUUID()
  await pool.query(
    `insert into signoff_packages (id, group_id, cohort_id, purpose, created_by_user_id) values ($1, $2, $3, 'result_confirmation', $4)`,
    [packageId, groupIds.G01, cohortId, admin.userId],
  )
  await pool.query(
    `insert into signoff_package_versions (id, package_id, version_no, content_text, content_checksum, participants,
                                           created_by_user_id, created_real_at, created_business_at)
     values ($1, $2, 1, $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'), $4::jsonb, $5, now(), now())`,
    [versionId, packageId, 'e2e W4 同意書全文', JSON.stringify({ students, advisor: { userId: advisor1.userId, displayName: 'e2e 老師' } }), admin.userId],
  )
  await pool.query(`insert into signoff_version_status (version_id, state) values ($1, 'collecting')`, [versionId])
  await pool.query(`update signoff_packages set current_version_id = $2 where id = $1`, [packageId, versionId])
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function quickPublish(
  page: Page,
  options: { placement: RegExp; title: string; audience: string; group?: string; important: boolean; file?: Buffer },
) {
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增項目' }).click()
  const dialog = page.getByRole('dialog', { name: '新增項目' })
  await dialog.getByRole('radio', { name: options.placement }).check()
  await dialog.getByLabel('標題').fill(options.title)
  await dialog.getByLabel('誰看得到').selectOption(options.audience)
  if (options.group) await dialog.getByRole('checkbox', { name: new RegExp(options.group) }).check()
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByLabel('說明', { exact: true }).fill('第三波 W4 驗收用。')
  if (options.file) {
    await dialog.locator('input[type=file]').setInputFiles({ name: '報告範本.pdf', mimeType: 'application/pdf', buffer: options.file })
    await expect(dialog.getByRole('link', { name: '報告範本.pdf' })).toBeVisible()
  }
  await dialog.getByRole('button', { name: '下一步' }).click()
  await expect(dialog.getByRole('list', { name: '發布前檢查' })).toBeVisible()
  await expect(dialog.locator('[data-ok="no"]')).toHaveCount(0)
  const important = dialog.getByRole('checkbox', { name: /重要公告/ })
  if (await important.count()) await important.setChecked(options.important)
  await dialog.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText(`「${options.title}」已發布`)
  const row = await pool.query<{ id: string }>('select id from managed_items where cohort_id = $1 and title = $2', [cohortId, options.title])
  itemIds[options.title] = row.rows[0]!.id
}

async function recipientsOf(title: string): Promise<string[]> {
  const rows = await pool.query<{ recipients: string[] }>(
    `select recipients from domain_events where type = 'item.announced' and source_id = $1`,
    [itemIds[title]],
  )
  return rows.rows.flatMap((r) => r.recipients)
}

test('系辦發布五種對象的公告（組別與本屆勾「重要」）、一份本屆範本（附檔）與一份本屆收件', async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  // 依序發布：首頁「新到舊」看得出順序。
  await quickPublish(page, { placement: /公告/, title: TEACHERS_NEWS, audience: 'teachers', important: false })
  await quickPublish(page, { placement: /公告/, title: SIGNED_IN_NEWS, audience: 'signed_in', important: false })
  await quickPublish(page, { placement: /公告/, title: GROUP_NEWS, audience: 'groups', group: 'G01', important: true })
  await quickPublish(page, { placement: /公告/, title: COHORT_NEWS, audience: 'cohort_students', important: true })
  await quickPublish(page, { placement: /公告/, title: PUBLIC_NEWS, audience: 'public', important: false })
  await quickPublish(page, { placement: /資源/, title: RESOURCE, audience: 'cohort_students', important: false, file: PDF })
  resourceFileId = String(
    (await pool.query<{ file_id: string }>('select file_id from item_attachments where item_id = $1', [itemIds[RESOURCE]])).rows[0]!.file_id,
  )

  // 本屆學生、個人一份的收件（完整編輯器）。
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.getByLabel('標題', { exact: true }).fill(SUBMISSION)
  await page.getByLabel('正文').fill('請上傳期中報告 PDF。')
  await page.getByLabel('顯示在哪一區', { exact: true }).selectOption('submission')
  await page.getByRole('radio', { name: '個人一份', exact: true }).check()
  await page.getByLabel('誰看得到').selectOption('cohort_students')
  await page.getByLabel('所屬階段').selectOption({ index: 2 })
  await page.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(new Date(Date.now() + 20 * 86_400_000)))
  await page.getByLabel('要新增的欄位類型').selectOption('file')
  await page.getByRole('button', { name: '新增欄位' }).click()
  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await expect(check.locator('[data-ok="no"]')).toHaveCount(0)
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toBeVisible()
  itemIds[SUBMISSION] = (await pool.query<{ id: string }>('select id from managed_items where title = $1', [SUBMISSION])).rows[0]!.id
})

test('AC-31：老師首頁「給老師的公告」列全部老師、所有登入者、我指導的組三種，新到舊；不列本屆學生與公開', async ({ page }) => {
  await signIn(page, advisor1)
  await page.goto('/dashboard/teacher')
  const panel = page.getByTestId('home-teacher-news')
  await expect(panel.getByRole('heading', { name: '給老師的公告' })).toBeVisible()
  await expect(panel.getByRole('listitem').filter({ hasText: CODE })).toHaveText([
    new RegExp(GROUP_NEWS),
    new RegExp(SIGNED_IN_NEWS),
    new RegExp(TEACHERS_NEWS),
  ])
  await expect(panel).not.toContainText(COHORT_NEWS)
  await expect(panel).not.toContainText(PUBLIC_NEWS)
  await expect(panel.getByRole('link', { name: '看全部公告' })).toHaveAttribute('href', '/news')

  // 別組的指導老師：沒有 G01 的組別公告。
  await signIn(page, advisor2)
  await page.goto('/dashboard/teacher')
  await expect(page.getByTestId('home-teacher-news').getByRole('listitem').filter({ hasText: CODE })).toHaveText([
    new RegExp(SIGNED_IN_NEWS),
    new RegExp(TEACHERS_NEWS),
  ])
})

test('AC-32：指導本屆的老師看得到本屆公告、範本與附件、本屆活動，看不到收件；沒指導的與只指導別屆的都看不到', async ({ page }) => {
  const newsTitles = async () => page.getByTestId('news-card').filter({ hasText: CODE }).allInnerTexts()
  const download = async (session: TestSession) => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { cookie: session.cookie } })
    try {
      return (await context.get(`/api/files/${resourceFileId}`)).status()
    } finally {
      await context.dispose()
    }
  }

  await signIn(page, advisor1)
  await page.goto(`/news?q=${encodeURIComponent(CODE)}`)
  await expect(page.getByTestId('news-card').filter({ hasText: CODE })).toHaveCount(5)
  expect((await newsTitles()).join('\n')).toContain(COHORT_NEWS)
  await page.goto(`/news/${itemIds[COHORT_NEWS]}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(COHORT_NEWS)
  await page.goto(`/files?q=${encodeURIComponent(CODE)}`)
  await expect(page.getByTestId('resource').filter({ hasText: RESOURCE })).toHaveCount(1)
  expect(await download(advisor1)).toBe(200)
  await page.goto('/dashboard/teacher')
  await expect(page.getByTestId('home-cohort-activities')).toContainText(ACTIVITY)
  await expect(page.getByTestId('home-cohort-activities')).not.toContainText(OTHER_ACTIVITY)
  // 收件：學生作業區的網址老師進不去。
  await page.goto(`/dashboard/student/affairs/${itemIds[SUBMISSION]}`)
  await expect(page).toHaveURL(/\/403$/)
  await expect(page.getByRole('main')).not.toContainText(SUBMISSION)

  for (const teacher of [plainTeacher, otherCohortAdvisor]) {
    await signIn(page, teacher)
    await page.goto(`/news?q=${encodeURIComponent(CODE)}`)
    await expect(page.getByTestId('news-card').filter({ hasText: CODE })).toHaveCount(3)
    const titles = (await newsTitles()).join('\n')
    expect(titles).not.toContain(COHORT_NEWS)
    expect(titles).not.toContain(GROUP_NEWS)
    await page.goto(`/news/${itemIds[COHORT_NEWS]}`)
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(COHORT_NEWS)
    await expect(page.getByRole('main')).not.toContainText(COHORT_NEWS)
    await page.goto(`/files?q=${encodeURIComponent(CODE)}`)
    await expect(page.getByRole('main')).not.toContainText(RESOURCE)
    expect(await download(teacher)).not.toBe(200)
    await page.goto('/dashboard/teacher')
    await expect(page.getByTestId('home-cohort-activities')).toBeVisible()
    await expect(page.getByTestId('home-cohort-activities')).not.toContainText(ACTIVITY)
    // 只指導別屆的老師：列的是他指導那一屆的活動（不是工作屆別）；沒指導的老師兩邊都沒有。
    if (teacher === otherCohortAdvisor) await expect(page.getByTestId('home-cohort-activities')).toContainText(OTHER_ACTIVITY)
    else await expect(page.getByTestId('home-cohort-activities')).not.toContainText(OTHER_ACTIVITY)
  }

  // 本屆學生的重要公告（Q13 只看不通知）：四位老師都不在收件人裡。
  const cohortRecipients = await recipientsOf(COHORT_NEWS)
  expect(cohortRecipients.length).toBeGreaterThan(0)
  for (const teacher of [advisor1, advisor2, otherCohortAdvisor, plainTeacher]) expect(cohortRecipients).not.toContain(teacher.userId)
})

test('AC-33：指定 G01 的重要公告通知 G01 的指導老師、點得開；G02 的指導老師沒收到', async ({ page }) => {
  const recipients = await recipientsOf(GROUP_NEWS)
  expect(recipients).toContain(advisor1.userId)
  expect(recipients).not.toContain(advisor2.userId)
  expect(recipients).not.toContain(plainTeacher.userId)

  await signIn(page, advisor1)
  // 等背景工作把事件投影成通知（每 5 秒一輪）。
  await expect
    .poll(
      async () => {
        await page.goto('/dashboard/teacher/inbox')
        return page.getByTestId('inbox-item').filter({ hasText: GROUP_NEWS }).count()
      },
      { timeout: 30_000, intervals: [1_000, 2_000] },
    )
    .toBe(1)
  await page.getByTestId('inbox-item').filter({ hasText: GROUP_NEWS }).getByRole('link', { name: GROUP_NEWS }).click()
  await expect(page).toHaveURL(new RegExp(`/news/${itemIds[GROUP_NEWS]}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(GROUP_NEWS)

  await signIn(page, advisor2)
  await page.goto('/dashboard/teacher/inbox')
  await expect(page.getByTestId('inbox-item').filter({ hasText: GROUP_NEWS })).toHaveCount(0)
})

test('AC-34：1280×800 老師首頁每張卡片標題完整，沒有被截成「…」；同意書等待列寫「還有 3 位同學未同意」', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, advisor1)
  await page.goto('/dashboard/teacher')
  const headings = page.getByRole('main').locator('section h2')
  await expect(headings.first()).toBeVisible()
  const clipped = await headings.evaluateAll((els) =>
    els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent ?? ''),
  )
  expect(clipped).toEqual([])
  for (const title of ['我的評分', '給老師的公告', '本屆活動', '可擔任指導老師的產學組', '同意書', '指導中的組別', '合作案']) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
  const signoff = page.locator('section').filter({ has: page.getByRole('heading', { name: '同意書', exact: true }) })
  await expect(signoff).toContainText('還有 3 位同學未同意')
  await expect(signoff).not.toContainText('等待學生同意・')
})
