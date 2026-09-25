import { createHash } from 'node:crypto'
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 25（#236）：精選草稿與簽核建版。「做完的樣子」逐條走：
 *
 * 1. 管理員替一組建精選草稿：題目、摘要、海報上傳、影片連結（只存草稿，不發布）；非圖片的海報被拒、原海報保留；
 *    兩位管理員同時改，後存的被要求重新載入。
 * 2. 管理員建簽核版本：貼全文、選附件、快照參與者（實際有效成員＋主指導）；最終文件授權範圍從精選草稿凍結——
 *    全文空、沒選草稿都被拒；之後改草稿，版本頁的範圍不變；同用途再建一版，舊版失效。參與學生收到「輪到你同意」。
 * 3. 三個角色的簽核頁有入口、空狀態與權限邊界（未登入導登入、角色不對 403 在 pages.spec 逐條驗）。
 * 另：票 14 的掛點——管理員加入組員後，這一組目前的簽核版本失效，學生頁顯示原因與「等待管理員建立新版」。
 *
 * 組別、成員、主指導、正式送出的附件直接用 owner 連線建好（那是票 13、19、21 的事）；票 25 的動作全程用真的畫面與按鈕。
 * 參與者快照、授權範圍凍結、同交易失效、同請求編號重送、讀取邊界由整合測試逐條證明（pg-signoff／pg-showcase）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T25-${stamp}`
const TEACHER_NAME = `指導老師${stamp.slice(-3)}`
const NEWCOMER_NAME = `轉學生${stamp.slice(-3)}`
const TITLE_1 = `智慧校園導覽 ${stamp}`
const SUMMARY_1 = '用室內定位帶新生認識校園，找得到教室與行政單位。'
const CONTENT_1 = `本組同意將最終文件與下列內容公開展示（${stamp}）。`

/** 1×1 的真 PNG（瀏覽器畫得出來，用來確認海報預覽不是破圖）。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

let pool: Pool
let cohortId: string
let groupId: string
let adminId: string
let teacher: TestSession
let otherTeacher: TestSession
let s01: TestSession
let loner: TestSession
let newcomerNo: string
let finalV1: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

let seq = 0
async function insertStudent(userId: string | null, name: string, cohort: string): Promise<{ id: string; studentNo: string }> {
  seq += 1
  const studentNo = `425${String(Date.now()).slice(-5)}${seq}`
  let id = userId
  if (!id) {
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [name, `t25-${stamp.toLowerCase()}-${seq}@example.com`],
    )
    id = user.rows[0]!.id
    await pool.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, adminId],
    )
  }
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no, cohort_id = excluded.cohort_id`,
    [id, name, studentNo, cohort, `t25-${seq}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohort, studentNo, id])
  return { id, studentNo }
}

/** 這一組正式送出過一個 PDF（票 21 的結果）。檔案本體不需要在磁碟上：本票只綁引用與 checksum。 */
async function insertSubmittedFile(group: string, submitter: string, name: string) {
  const item = await pool.query<{ id: string }>(
    `insert into managed_items (id, cohort_id, placement, audience_kind, title, created_by_kind)
     values (gen_random_uuid(), $1, 'news', 'public', '期末報告繳交', 'system') returning id`,
    [cohortId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id) values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
    [item.rows[0]!.id, adminId],
  )
  const version = await pool.query<{ id: string }>(
    `insert into submission_versions
       (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
        received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
     values (gen_random_uuid(), $1, 'group', $2, 1, $3, '{}'::jsonb, $4, now(), now(), gen_random_uuid(), '[]'::jsonb, 1) returning id`,
    [item.rows[0]!.id, group, schema.rows[0]!.id, submitter],
  )
  const checksum = createHash('sha256').update(`${name}-${stamp}`).digest('hex')
  const file = await pool.query<{ id: string }>(
    `insert into stored_files (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared, mime_detected,
                               extension, checksum, status, storage_key, uploaded_real_at, finalized_at)
     values (gen_random_uuid(), $1, 'cohort', $2, 'submission', $3, 100, 'application/pdf', 'application/pdf', 'pdf', $4,
             'stored', $5, now(), now()) returning id`,
    [submitter, cohortId, name, checksum, `e2e-t25-${stamp}-${seq}`],
  )
  await pool.query(`insert into submission_files (submission_version_id, file_id, field_key, checksum) values ($1, $2, 'report', $3)`, [
    version.rows[0]!.id,
    file.rows[0]!.id,
    checksum,
  ])
  await pool.query(`insert into file_references (id, file_id, ref_type, ref_id) values (gen_random_uuid(), $1, 'submission_version', $2)`, [
    file.rows[0]!.id,
    version.rows[0]!.id,
  ])
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  const fresh = async (role: 'teacher' | 'student') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  teacher = await fresh('teacher')
  otherTeacher = await fresh('teacher')
  s01 = await fresh('student')
  loner = await fresh('student')
  await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [teacher.userId, TEACHER_NAME])

  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, group_size_min, group_size_max, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 3, 5, 'system') returning id`,
    [CODE, `${CODE} 簽核測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id
  const members = [
    (await insertStudent(s01.userId, `組員甲${stamp.slice(-3)}`, cohortId)).id,
    (await insertStudent(null, `組員乙${stamp.slice(-3)}`, cohortId)).id,
    (await insertStudent(null, `組員丙${stamp.slice(-3)}`, cohortId)).id,
  ]
  newcomerNo = (await insertStudent(null, NEWCOMER_NAME, cohortId)).studentNo
  // loner 是學生，但不在任何組別（學生頁的空狀態）。
  await insertStudent(loner.userId, `沒有組別${stamp.slice(-3)}`, cohortId)

  const at = new Date(Date.now() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', 'active', $2, $2, 'system') returning id`,
    [cohortId, at],
  )
  groupId = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
     select gen_random_uuid(), $1, $2, u, $3, 'system' from unnest($4::uuid[]) as u`,
    [groupId, cohortId, at, members],
  )
  await pool.query(`insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, $3, $2)`, [
    groupId,
    members[0],
    at,
  ])
  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', $3, $4, '抽籤結果')`,
    [groupId, teacher.userId, at, adminId],
  )
  await insertSubmittedFile(groupId, members[0]!, '期末報告.pdf')
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

const draftCard = (page: Page) => page.getByTestId('showcase-draft').filter({ hasText: 'G01' })

test('空狀態與入口：四頁在側欄、還沒資料時各自說明現況與下一步；學生直接開管理員頁被擋', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff?cohort=${cohortId}`)
  await expect(page.getByRole('link', { name: '簽核', exact: true })).toHaveAttribute('href', '/dashboard/admin/signoff')
  await expect(page.getByRole('link', { name: '精選', exact: true })).toHaveAttribute('href', '/dashboard/admin/showcase')
  await expect(page.getByText('尚未建立簽核')).toBeVisible()
  await page.getByRole('button', { name: '新增簽核' }).click()
  await expect(page.getByRole('dialog', { name: '新增簽核' }).getByRole('form', { name: '建立簽核版本' })).toBeVisible()
  await page.keyboard.press('Escape')
  // 系辦沒有任何替人同意的入口。
  await expect(page.getByRole('button', { name: /同意/ })).toHaveCount(0)

  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  await expect(page.getByText('尚無精選草稿')).toBeVisible()

  await signIn(page, loner)
  await page.goto('/dashboard/student/signoff')
  // 學生側欄照原型叫「同意書」（票 38）。
  await expect(page.getByRole('link', { name: '同意書', exact: true })).toHaveAttribute('href', '/dashboard/student/signoff')
  await expect(page.getByText('目前沒有待處理的簽核')).toBeVisible()
  await expect(page.getByText('你目前不在任何組別裡')).toBeVisible()

  await signIn(page, otherTeacher)
  await page.goto('/dashboard/teacher/signoff')
  await expect(page.getByRole('link', { name: '簽核', exact: true })).toHaveAttribute('href', '/dashboard/teacher/signoff')
  await expect(page.getByText('目前沒有待處理的簽核')).toBeVisible()

  await signIn(page, s01)
  await page.goto('/dashboard/admin/showcase')
  await expect(page).toHaveURL(/\/403/)
  await page.goto('/dashboard/admin/signoff')
  await expect(page).toHaveURL(/\/403/)
})

test('精選草稿：建立、填題目摘要影片、上傳 PNG 海報、儲存；重新整理都在；閘門「尚無授權」、沒有發布按鈕', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  const create = page.getByRole('form', { name: '建立精選草稿' })
  await create.getByLabel('組別').selectOption({ label: 'G01' })
  await create.getByRole('button', { name: '建立草稿' }).click()
  await expect(create.getByRole('status')).toContainText('已替 G01 建立精選草稿')

  const card = draftCard(page)
  await card.getByLabel('題目').fill(TITLE_1)
  await card.getByLabel('摘要').fill(SUMMARY_1)
  await card.getByLabel('影片連結').fill('https://youtu.be/t25-demo')
  await card.getByLabel('選擇海報圖檔').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: PNG })
  await expect(card.getByTestId('poster-name')).toContainText('poster.png')
  await card.getByRole('button', { name: '儲存草稿' }).click()
  await expect(card.getByRole('status')).toContainText('G01 的精選草稿已儲存（第 2 版），海報已更新。草稿不會公開。')

  await page.reload()
  const again = draftCard(page)
  await expect(again.getByLabel('題目')).toHaveValue(TITLE_1)
  await expect(again.getByLabel('摘要')).toHaveValue(SUMMARY_1)
  await expect(again.getByLabel('影片連結')).toHaveValue('https://youtu.be/t25-demo')
  await expect(again.getByTestId('poster-name')).toHaveText('poster.png')
  await expect(again.getByTestId('gate')).toHaveText('尚無授權')
  await expect(page.getByRole('button', { name: /發布/ })).toHaveCount(0)
  // 已存的海報經下載授權顯示得出來（不是破圖）。
  await expect(again.getByRole('img', { name: 'G01 海報' })).toHaveJSProperty('naturalWidth', 1)
  // 一組只有一份：建立草稿的下拉已經沒有 G01。
  await expect(page.getByText('這一屆每一組都已經有精選草稿了')).toBeVisible()
})

test('精選草稿：海報換成非圖片被拒、原海報保留；兩個分頁同時改，後存的被要求重新載入', async ({ page, context }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  const card = draftCard(page)
  await card.getByLabel('選擇海報圖檔').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(card.getByRole('alert')).toContainText('只接受 .png、.jpg、.jpeg 檔')
  await card.getByLabel('選擇海報圖檔').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: PDF })
  await expect(card.getByRole('alert')).toBeVisible()
  await expect(card.getByTestId('poster-name')).toHaveText('poster.png')

  // A2 在另一個分頁先存；A1 用舊的版本再存 → 被拒。
  const other = await context.newPage()
  await other.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  await draftCard(other).getByLabel('影片連結').fill('https://youtu.be/t25-second')
  await draftCard(other).getByRole('button', { name: '儲存草稿' }).click()
  await expect(draftCard(other).getByRole('status')).toContainText('第 3 版')
  await other.close()

  await card.getByLabel('影片連結').fill('https://youtu.be/t25-stale')
  await card.getByRole('button', { name: '儲存草稿' }).click()
  await expect(card.getByRole('alert').filter({ hasText: '被別人更新' })).toContainText('剛剛已經被別人更新了，請重新載入')
  await page.reload()
  await expect(draftCard(page).getByLabel('影片連結')).toHaveValue('https://youtu.be/t25-second')
})

test('建簽核版本：全文空、沒選精選草稿被拒；選好後回執含參與者；版本頁全文後列授權範圍與採認待確認標示', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增簽核' }).click()
  const form = page.getByRole('dialog', { name: '新增簽核' }).getByRole('form', { name: '建立簽核版本' })
  await form.getByLabel('組別').selectOption({ label: 'G01' })
  await form.getByText('最終文件授權', { exact: true }).click()
  await expect(form.getByTestId('impact-preview')).toContainText(`參與者：3 位學生＋主指導 ${TEACHER_NAME}`)

  await form.getByRole('button', { name: '建立簽核版本' }).click()
  await expect(form.getByRole('alert')).toContainText('全文必填')

  await form.getByLabel('全文').fill(CONTENT_1)
  await form.getByLabel(/期末報告\.pdf/).check()
  await form.getByTestId('showcase-pick').getByRole('checkbox').uncheck()
  await form.getByRole('button', { name: '建立簽核版本' }).click()
  await expect(form.getByRole('alert')).toContainText('最終文件授權要選這一組的精選草稿')
  await expect(form.getByLabel('全文')).toHaveValue(CONTENT_1)

  await form.getByTestId('showcase-pick').getByRole('checkbox').check()
  await form.getByLabel(/期末報告\.pdf/).check()
  await form.getByRole('button', { name: '建立簽核版本' }).click()
  await expect(form.getByRole('status')).toContainText(`已建立 G01「最終文件授權」v1：參與者 3 位學生＋主指導 ${TEACHER_NAME}`)
  await form.getByRole('link', { name: '看剛建立的版本' }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/signoff\/[0-9a-f-]{36}$/)
  finalV1 = page.url().split('/').at(-1)!

  await expect(page.getByTestId('signoff-content')).toContainText(CONTENT_1)
  await expect(page.getByTestId('signoff-attachment')).toContainText('期末報告.pdf')
  await expect(page.getByTestId('scope-title')).toHaveText(TITLE_1)
  await expect(page.getByTestId('scope-summary')).toHaveText(SUMMARY_1)
  await expect(page.getByTestId('signoff-scope')).toContainText('poster.png')
  await expect(page.getByTestId('signoff-scope')).toContainText('https://youtu.be/t25-second')
  await expect(page.getByText('站內內容確認與同意紀錄，行政採認待確認')).toBeVisible()
  await expect(page.getByTestId('signoff-participants')).toContainText(TEACHER_NAME)
  await expect(page.getByTestId('signoff-state')).toHaveText('收集學生同意中')
  // 授權範圍列在全文之後。
  const contentBox = await page.getByTestId('signoff-content').boundingBox()
  const scopeBox = await page.getByTestId('signoff-scope').boundingBox()
  expect(scopeBox!.y).toBeGreaterThan(contentBox!.y)
})

test('通知：參與學生收到「輪到你同意」，主指導沒有', async ({ page }) => {
  await signIn(page, s01)
  await expect(async () => {
    await page.goto('/dashboard/student/inbox')
    await expect(page.getByText('G01「最終文件授權」v1 輪到你閱讀並同意')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
  await page.getByText('G01「最終文件授權」v1 輪到你閱讀並同意').click()
  await expect(page).toHaveURL(/\/dashboard\/student\/signoff/)

  await signIn(page, teacher)
  await page.goto('/dashboard/teacher/inbox')
  await expect(page.getByText('輪到你閱讀並同意')).toHaveCount(0)
})

test('改草稿不影響已凍結的範圍；同用途再建一版，v1 標「已失效（內容變更）」、v2 收集中', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
  await draftCard(page).getByLabel('題目').fill('改過的題目')
  await draftCard(page).getByRole('button', { name: '儲存草稿' }).click()
  await expect(draftCard(page).getByRole('status')).toContainText('已儲存')

  await page.goto(`/dashboard/admin/signoff/${finalV1}`)
  await expect(page.getByTestId('scope-title')).toHaveText(TITLE_1)

  await page.goto(`/dashboard/admin/signoff?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增簽核' }).click()
  const form = page.getByRole('dialog', { name: '新增簽核' }).getByRole('form', { name: '建立簽核版本' })
  await form.getByText('最終文件授權', { exact: true }).click()
  await expect(form.getByTestId('impact-preview')).toContainText('目前的 v1 會失效')
  await form.getByLabel('全文').fill(`${CONTENT_1}（第二版）`)
  await form.getByRole('button', { name: '建立簽核版本' }).click()
  await expect(form.getByRole('status')).toContainText('v2')
  await expect(form.getByRole('status')).toContainText('原本的 v1 已失效')

  await page.goto(`/dashboard/admin/signoff/${finalV1}`)
  await expect(page.getByTestId('signoff-state').first()).toHaveText('已失效')
  await expect(page.getByTestId('signoff-invalidated')).toContainText('內容變更')
  await expect(page.getByRole('region', { name: '版本歷史' })).toContainText('v2')
  // 新版的範圍是改過之後的草稿。
  await page.getByRole('region', { name: '版本歷史' }).getByRole('link', { name: 'v2' }).click()
  await expect(page.getByTestId('scope-title')).toHaveText('改過的題目')
  await expect(page.getByTestId('signoff-state').first()).toHaveText('收集學生同意中')
})

test('三個角色看同一份：學生頁有全文與授權範圍、老師卡片點進版本頁；別的老師開網址「無法存取」', async ({ page }) => {
  await signIn(page, s01)
  await page.goto('/dashboard/student/signoff')
  await expect(page.getByRole('article', { name: 'G01 最終文件授權 v2' })).toBeVisible()
  await expect(page.getByTestId('signoff-content')).toContainText('（第二版）')
  await expect(page.getByTestId('scope-title')).toHaveText('改過的題目')
  await expect(page.getByTestId('signoff-participants')).toContainText(`組員甲${stamp.slice(-3)}`)
  // 票 26 起學生頁有本人的表態按鈕（逐人同意的完整流程在 signoff-approvals.spec）；學生不能開管理員的版本頁。
  await expect(page.getByRole('button', { name: '我已閱讀並同意' })).toBeDisabled()
  await page.goto(`/dashboard/admin/signoff/${finalV1}`)
  await expect(page).toHaveURL(/\/403/)

  await signIn(page, teacher)
  await page.goto('/dashboard/teacher/signoff')
  const card = page.getByTestId('teacher-signoff-card').filter({ hasText: 'G01・最終文件授權' })
  await expect(card).toContainText('收集學生同意中')
  await card.getByRole('link', { name: '閱讀全文與進度' }).click()
  await expect(page.getByTestId('signoff-content')).toContainText('（第二版）')
  const versionUrl = page.url()

  await signIn(page, otherTeacher)
  await page.goto(versionUrl)
  await expect(page.getByText('無法存取')).toBeVisible()
  await expect(page.getByTestId('signoff-content')).toHaveCount(0)
})

test('票 14 掛點：管理員加入組員後，目前版本同時失效；學生頁顯示原因與「等待管理員建立新版」', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const ungrouped = page.getByRole('region', { name: '未分組學生' })
  await ungrouped.getByRole('button', { name: `加入某組：${NEWCOMER_NAME}` }).click()
  const dialog = page.getByRole('dialog', { name: `把 ${NEWCOMER_NAME} 加入組別` })
  await dialog.getByLabel('組別').selectOption(groupId)
  await dialog.getByLabel('理由（必填）').fill('轉學生，系上安排加入')
  await dialog.getByRole('button', { name: '確認加入' }).click()
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: '已把' })).toContainText(`已把 ${NEWCOMER_NAME} 加入 G01`)

  await page.goto(`/dashboard/admin/signoff?cohort=${cohortId}`)
  await expect(page.getByRole('region', { name: '各組簽核' })).toContainText('組員變更，待建新版')

  await signIn(page, s01)
  await page.goto('/dashboard/student/signoff')
  await expect(page.getByTestId('signoff-invalidated')).toContainText('此版本已失效（組員變更），等待管理員建立新版')
  const versions = await pool.query<{ n: number }>(
    `select count(*)::int as n from signoff_package_versions v join signoff_packages p on p.id = v.package_id where p.group_id = $1`,
    [groupId],
  )
  // 不自動建新版：還是 v1、v2 兩列。
  expect(versions.rows[0]!.n).toBe(2)
  expect(newcomerNo).toBeTruthy()
})
