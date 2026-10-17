import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 第三波 W14b（AC-38）：系辦首頁與老師頁的指路，逐條走真的畫面：
 *
 * 1. 系辦首頁「逾期未繳」磚：數字照舊，標示拆成「欠繳 N 人、M 組」與「發布中 K 個收件項目」（母數照舊），不再寫「N 份收件」（N-58、N-139）。
 * 2. 有一筆成績更正待復核時，系辦首頁出現提示與「去復核」入口（N-61）。
 * 3. 檔案管理說明「要新增檔案請到專題事務」並附前往連結（N-138）。
 * 4. 老師打開沒被指派的評分頁：中文說明＋「回到自己的首頁」（N-24）。
 * 5. 老師暫存一組後，左側待評分清單立刻顯示「草稿 已填/總數」，不用切頁或重新整理（N-154）。
 *
 * 系辦首頁看「預設工作屆別」：這裡建一屆並設成預設，結束時把原本的預設還回去。
 * 收件、名單、評分與更正都用 owner 連線直接種好（流程本身各有自己的 e2e），畫面全程照真的操作。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `W14B-${stamp}`
const DAY = 86_400_000

const STAGES = [
  {
    key: 'mid',
    name: '期中',
    weight: 100,
    letterMap: null,
    items: [
      { key: 'i1', name: '技術', type: 'number', max: 100, weight: 50 },
      { key: 'i2', name: '簡報', type: 'number', max: 100, weight: 50 },
    ],
  },
]

let pool: Pool
let adminId: string
let cohortId: string
let previousDefault: string[] = []
let grader: TestSession
let stranger: TestSession
const groupIds = new Map<string, string>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function minute(offsetMs: number): Date {
  return new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000)
}

let seq = 0
async function insertStudent(): Promise<string> {
  seq += 1
  const studentNo = `41${String(Date.now()).slice(-6)}${seq}`
  const user = await pool.query<{ id: string }>(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [`首頁學生${seq}`, `w14b-${stamp.toLowerCase()}-${seq}@example.com`],
  )
  const id = user.rows[0]!.id
  await pool.query(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)`,
    [id, `首頁學生${seq}`, studentNo, cohortId, `w14b-${seq}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return id
}

async function insertGroup(code: string, members: readonly string[]): Promise<string> {
  const at = new Date(Date.now() - DAY)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', 'active', $3, $3, 'system') returning id`,
    [cohortId, code, at],
  )
  const id = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
     select gen_random_uuid(), $1, $2, u, $3, 'system' from unnest($4::uuid[]) as u`,
    [id, cohortId, at, members],
  )
  await pool.query(`insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, $3, $2)`, [
    id,
    members[0],
    at,
  ])
  groupIds.set(code, id)
  return id
}

/** 建一份「已發布」的收件（內容版本、欄位版本、名單），回項目 id。 */
async function publishedItem(options: { stage: string; title: string; dueAt: Date; unit: 'individual' | 'group'; roster: readonly string[] }) {
  const fields = [{ key: 'note', type: 'text', label: '說明', required: true }]
  const item = await pool.query<{ id: string }>(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, actual_opened_at, due_at,
        title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
     values (gen_random_uuid(), $1, 'submission', 'cohort_students', $2, $3, 'draft', null, $4, $5,
             $6, '一句話摘要', '<p>請在截止前交。</p>', $7::jsonb, 'user', $8, $8)
     returning id`,
    [cohortId, options.unit, options.stage, minute(-10 * DAY), options.dueAt, options.title, JSON.stringify({ fields }), adminId],
  )
  const itemId = item.rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前交。</p>', $3) returning id`,
    [itemId, options.title, adminId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
    [itemId, JSON.stringify({ fields }), adminId],
  )
  await pool.query(`update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`, [
    itemId,
    content.rows[0]!.id,
    schema.rows[0]!.id,
  ])
  for (const receiverId of options.roster) {
    await pool.query(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, $3, $4, now() - interval '10 days', 'auto', 'user', $5)`,
      [itemId, cohortId, options.unit === 'group' ? 'group' : 'user', receiverId, adminId],
    )
  }
  return itemId
}

async function assign(groupId: string, teacherId: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
     values (gen_random_uuid(), $1, 'mid', $2, now() - interval '1 hour', $3) returning id`,
    [groupId, teacherId, adminId],
  )
  return row.rows[0]!.id
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  const fresh = async () => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, 'teacher')
    } finally {
      await context.dispose()
    }
  }
  grader = await fresh()
  stranger = await fresh()

  // 逾期要照真實時間算：業務鐘拉回現在（別的測試可能把它撥到未來）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e W14b：回到真實時間')`,
    [adminId],
  )

  const now = new Date()
  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
      [CODE, ymd(new Date(now.getTime() + 300 * DAY))],
    )
  ).rows[0]!.id
  // 系辦首頁只看「預設工作屆別」，沒有不動全域的寫法；記下原本的預設，afterAll 一定還原。
  // CI 是單一 worker；本機多 worker 時，這支與 cohorts.spec、timeline.spec 都會改這個旗標，請用 --workers=1 跑。
  previousDefault = (await pool.query<{ id: string }>('select id from cohorts where is_default_working')).rows.map((r) => r.id)
  await pool.query('update cohorts set is_default_working = false where is_default_working')
  await pool.query('update cohorts set is_default_working = true where id = $1', [cohortId])
  const stageId = (
    await pool.query<{ id: string }>(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, 1, '成組期', $2, 'system') returning id`,
      [cohortId, ymd(new Date(now.getTime() - 30 * DAY))],
    )
  ).rows[0]!.id

  // 三位學生欠繳一份個人收件、一組欠繳一份整組收件；另一份還沒截止的不算逾期。
  const students = [await insertStudent(), await insertStudent(), await insertStudent()]
  const g1 = await insertGroup('G01', [students[0]!, students[1]!])
  const g2 = await insertGroup('G02', [students[2]!])
  await publishedItem({ stage: stageId, title: `${CODE} 個人心得`, dueAt: minute(-DAY), unit: 'individual', roster: students })
  await publishedItem({ stage: stageId, title: `${CODE} 期中報告`, dueAt: minute(-2 * DAY), unit: 'group', roster: [g1] })
  await publishedItem({ stage: stageId, title: `${CODE} 期末報告`, dueAt: minute(20 * DAY), unit: 'group', roster: [g1, g2] })

  // 評分：評分老師評 G01（已正式送出）與 G02（還沒開始）；G01 有一筆更正待復核。
  const scheme = await pool.query<{ id: string }>(
    `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
    [cohortId, `${CODE} 評分方案`],
  )
  const versionId = (
    await pool.query<{ id: string }>(
      `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id)
       values (gen_random_uuid(), $1, 1, $2::jsonb, 'published', $3) returning id`,
      [scheme.rows[0]!.id, JSON.stringify(STAGES), adminId],
    )
  ).rows[0]!.id
  await pool.query('update grading_schemes set current_version_id = $2 where id = $1', [scheme.rows[0]!.id, versionId])
  for (const groupId of [g1, g2]) {
    await pool.query(`insert into stage_requirements (group_id, stage_key, required_count, created_by_user_id) values ($1, 'mid', 1, $2)`, [
      groupId,
      adminId,
    ])
  }
  const a1 = await assign(g1, grader.userId)
  const evaluation = await pool.query<{ id: string }>(
    `insert into evaluations (id, assignment_id, kind, scheme_version_id, scores, submitted_real_at, submitted_business_at, request_id)
     values (gen_random_uuid(), $1, 'final', $2, $3::jsonb, now(), now(), gen_random_uuid()) returning id`,
    [a1, versionId, JSON.stringify({ i1: '80', i2: '80' })],
  )
  await pool.query(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [evaluation.rows[0]!.id, a1])
  await assign(g2, grader.userId)
  await pool.query(`update grading_scheme_versions set status = 'locked', locked_at = now() where id = $1`, [versionId])
  const override = await pool.query<{ id: string }>(
    `insert into grade_overrides (id, group_id, scheme_version_id, original_value, new_value, basis_hash, reason, actor_user_id, real_at)
     values (gen_random_uuid(), $1, $2, 80, 85, 'e2e-old-basis', '口試補考', $3, now()) returning id`,
    [g1, versionId, adminId],
  )
  await pool.query(`insert into override_review_state (override_id, state) values ($1, 'pending_review')`, [override.rows[0]!.id])
})

test.afterAll(async () => {
  if (pool && cohortId) {
    await pool.query('update cohorts set is_default_working = false where id = $1', [cohortId])
    if (previousDefault.length > 0) await pool.query('update cohorts set is_default_working = true where id = any($1::uuid[])', [previousDefault])
  }
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function asAdmin(page: Page) {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
}

test('系辦首頁：逾期卡分開寫「欠繳 3 人、1 組」與「發布中 3 個作業」；有更正待復核的提示與入口', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin')

  const tile = page.getByRole('link').filter({ hasText: '逾期未繳' })
  await expect(tile).toContainText('4')
  await expect(tile).toContainText('欠繳 3 人、1 組')
  await expect(tile).toContainText('發布中 3 個作業')
  await expect(tile).not.toContainText('份收件')
  // 驗收 P-05：評分卡寫「評分還差」（AD-02），不寫像催繳的「缺評老師」。
  await expect(page.getByRole('link').filter({ hasText: '評分還差' })).toBeVisible()
  await expect(page.getByText('缺評老師')).toHaveCount(0)

  const notice = page.getByTestId('pending-review-notice')
  await expect(notice).toContainText('成績更正需要重新確認 1 筆')
  await expect(notice).toContainText('G01')
  await notice.getByRole('link', { name: '去確認' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/grading/${groupIds.get('G01')}$`))
  await expect(page.getByRole('heading', { name: 'G01 計算明細' })).toBeVisible()
})

test('系辦首頁待審帳號卡（AC-A-35）：有待審寫「N 位待審・最早 X 天前送出」；兩筆（3 天前、今天）→「2 位待審・最早 3 天前送出」', async ({ page }) => {
  // 待審是全站的數字：先看這個資料庫原本有沒有待審（獨立跑時是 0），沒有就驗「不顯示那句」與 AC 的原句。
  const pendingSql = `select count(*)::int as n
                        from registration_applications ra join users x on x.id = ra.user_id
                       where ra.state = 'pending' and x.status = 'pending'`
  const before = (await pool.query<{ n: number }>(pendingSql)).rows[0]!
  await asAdmin(page)
  const card = page.getByTestId('todo-accounts')
  if (before.n === 0) {
    await page.goto('/dashboard/admin')
    await expect(card).toContainText('待審帳號 0')
    await expect(card).not.toContainText('位待審')
  }

  const created: string[] = []
  try {
    // 時刻都以資料庫的 now() 為準（beforeAll 已把業務鐘拉回現在），不用測試機的 Date.now() 推算；
    // 「3 天前」那筆再往前 12 小時、「今天」那筆在 1 小時前，避開整天切點，時鐘差幾分鐘也不會變成 2 天或跨日。
    for (const [i, ago] of ['3 days 12 hours', '1 hour'].entries()) {
      const email = `a12-${stamp.toLowerCase()}-${i}@example.com`
      const user = await pool.query<{ id: string }>(
        `insert into users (id, name, email, email_verified, updated_at, status)
         values (gen_random_uuid(), $1, $2, true, now(), 'pending') returning id`,
        [`待審申請${i}`, email],
      )
      const userId = user.rows[0]!.id
      created.push(userId)
      await pool.query(
        `insert into registration_applications
           (id, user_id, applied_name, student_no, phone, contact_email, login_email, created_at, created_by_kind, created_by_user_id)
         values (gen_random_uuid(), $1, $2, $3, '0912-000-000', $4, $4, now() - $5::interval, 'user', $1)`,
        [userId, `待審申請${i}`, `4129${String(Date.now()).slice(-5)}${i}`, email, ago],
      )
    }
    const after = (await pool.query<{ n: number }>(pendingSql)).rows[0]!
    await page.goto('/dashboard/admin')
    await expect(card).toContainText(`待審帳號 ${after.n}`)
    if (before.n === 0) {
      await expect(card).toContainText('2 位待審・最早 3 天前送出')
    } else {
      // 共用庫裡還有別人的待審（最早那筆不是這裡建的）：只驗句型與人數。
      await expect(card).toContainText(`${after.n} 位待審・`)
    }
  } finally {
    if (created.length > 0) {
      await pool.query('delete from registration_applications where user_id = any($1::uuid[])', [created])
      await pool.query('delete from users where id = any($1::uuid[])', [created])
    }
  }
})

test('系辦首頁逾期卡連到「公告與作業」的「逾期」篩選（AD-B7）', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin')
  await page.getByTestId('todo-overdue').click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?placement=overdue$/)
})

test('檔案管理：說明要新增檔案請到專題事務，並附前往連結', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin/files')
  const hint = page.getByTestId('files-add-hint')
  await expect(hint).toContainText('去「公告與作業」的編輯器加附件')
  await hint.getByRole('link', { name: '去編輯器' }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/editor\/new$/)
})

test('老師打開沒被指派的評分頁：「找不到這個頁面」（不說原因）＋回到自己的首頁', async ({ page }) => {
  await signIn(page, stranger)
  await page.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}`)
  await expect(page.getByRole('heading', { name: '找不到這個頁面' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText('80.00')
  await page.getByRole('link', { name: '回到自己的首頁' }).click()
  await expect(page).toHaveURL(/\/dashboard\/teacher$/)
})

test('老師儲存草稿後，頁首自己的狀態立刻變成「草稿 1／2」，不用重新整理', async ({ page }) => {
  await signIn(page, grader)
  await page.goto(`/dashboard/teacher/grading/${groupIds.get('G02')}?stage=mid`)
  const myStatus = page.getByTestId('my-status')
  await expect(myStatus).toHaveText('待評')

  const bench = page.getByRole('region', { name: 'G02「期中」評分表' })
  await bench.getByLabel('1. 技術').fill('88')
  await bench.getByRole('button', { name: '儲存草稿' }).click()
  await expect(bench.getByRole('status').filter({ hasText: '已儲存' }).first()).toBeVisible()
  await expect(myStatus).toHaveText('草稿 1／2')
  // 重抓佇列不會把表單洗掉。
  await expect(bench.getByLabel('1. 技術')).toHaveValue('88')
})
