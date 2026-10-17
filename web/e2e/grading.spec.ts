import { expect, request as playwrightRequest, test, type Page, type Route } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 23（#234）：評分方案、指派與老師評分。「做完的樣子」逐條走：
 *
 * 1. 管理員建評分方案版本（階段、項目、滿分、權重）；權重不合 100 不能建立、不能發布。
 * 2. 管理員設每組每階段要幾份評分並指派老師，老師收到通知；票 19 重派對話框列出原老師在本組的評分指派。
 * 3. 老師工作台只看到自己的指派；填 0–100 暫存（只有本人與管理員看得到）；正式送出後仍可改、重新送出（B 階段 TE-B1）。
 *    方案在第一位老師開始填（第一份暫存）時鎖定結構（產品 06 §4「7.5」）。
 * 3b. B 階段 A-02：送出紀錄、正式送出後的草稿（「有尚未送出的修改」）、評語 500 字前端擋、系辦結算後唯讀。
 * 3c. Review #584 的十個反例（r1 ①②、r2 ①②③、r3 ①～⑤）：多分頁重送、結算後被拒存、回應中斷後同編號重試、
 *     等回應時續打、未存就被動結算；第 4 輪：重試原樣送凍結的 payload、舊收據不清未存、改用伺服器內容後是新的一次、
 *     未存內容依版本保存成列表、較舊／相同時間戳的 RSC 快照整包丟掉不崩。用 page.route 攔 Server Action 的 POST 模擬延遲
 *     與中斷、攔 RSC GET 重放舊快照。這個檔是 serial：一條失敗其餘就略過，所以要在舊版重現「每一條都紅」時，
 *     用 `GRADING_E2E_SKIP=r1-2,r2-1` 這類 tag 跳過已證明的反例再跑一次；正常驗收不設。
 * 4. 學生的「成績」頁只有一句說明；學生零可見的全面掃描在 student-zero-visibility.spec.ts。
 *
 * 併發只一筆採計、同請求編號重送、學生呼叫任何評分用例 FORBIDDEN、資料庫 trigger 由整合測試證明
 * （pg-grading.integration.test.ts、s10-grading.integration.test.ts）。
 *
 * 組別與主指導直接用 owner 連線建好（成組、指派指導是票 13、19 的事）；票 23 的動作全程用真的畫面與按鈕。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
/** 只在舊版重現紅燈時用：跳過已證明的反例（見檔頭 3c）。 */
const skipped = (tag: string) => (process.env.GRADING_E2E_SKIP ?? '').split(',').includes(tag)

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T23-${stamp}`

let pool: Pool
let cohortId: string
let adminId: string
let t1: TestSession
let t2: TestSession
let t3: TestSession
let student: TestSession
const NAME_1 = `評一老師${stamp.slice(-3)}`
const NAME_2 = `評二老師${stamp.slice(-3)}`
const NAME_3 = `評三老師${stamp.slice(-3)}`
const groupIds = new Map<string, string>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

let seq = 0
async function insertStudent(userId: string | null): Promise<string> {
  seq += 1
  const studentNo = `423${String(Date.now()).slice(-5)}${seq}`
  let id = userId
  if (!id) {
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [`組員${seq}`, `t23-${stamp.toLowerCase()}-${seq}@example.com`],
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
    [id, `組員${seq}`, studentNo, cohortId, `t23-${seq}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return id
}

async function insertGroup(code: string, firstMember: string | null, advisor: string | null) {
  const members = [await insertStudent(firstMember), await insertStudent(null)]
  const at = new Date(Date.now() - 86_400_000)
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
  if (advisor) {
    await pool.query(
      `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
       values (gen_random_uuid(), $1, $2, 'admin', $3, $4, '抽籤結果')`,
      [id, advisor, at, adminId],
    )
  }
  groupIds.set(code, id)
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
  t1 = await fresh('teacher')
  t2 = await fresh('teacher')
  t3 = await fresh('teacher')
  student = await fresh('student')
  for (const [session, name] of [
    [t1, NAME_1],
    [t2, NAME_2],
    [t3, NAME_3],
  ] as const) {
    await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [session.userId, name])
  }

  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 'system') returning id`,
    [CODE, `${CODE} 評分測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id
  await insertGroup('G01', student.userId, t1.userId)
  await insertGroup('G02', null, null)
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

/** AD-08：評分規則、版本紀錄、評分要求與指派搬到子頁 `/dashboard/admin/grading/rules`。 */
async function openRules(page: Page) {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/grading/rules?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '評分規則', exact: true })).toBeVisible()
}

const row = (page: Page, code: string) => page.getByTestId(`grading-row-${code}`)

/** 評分要求與指派、版本紀錄在子頁是頁內區塊（AD-08）。 */
async function openAssign(page: Page) {
  await openRules(page)
  await expect(page.getByRole('region', { name: '評分要求與指派' })).toBeVisible()
}
async function openVersions(page: Page) {
  await expect(page.getByRole('region', { name: '版本紀錄' })).toBeVisible()
}
const versionCard = (page: Page, n: number) =>
  page.getByRole('region', { name: '版本紀錄' }).getByRole('article').filter({ hasText: `第 ${n} 版` })

test('管理員建方案：階段 60／50 被擋、沒有建立任何版本；改成 60／40、項目 50／50 建成 v1 草稿，發布後重新整理仍是已發布', async ({ page }) => {
  await openRules(page)
  await expect(page.getByTestId('scheme-status')).toHaveText('還沒有發布的評分規則')

  await page.getByRole('button', { name: '建立新版評分規則' }).click()
  const dialog = page.getByRole('dialog', { name: '建立新版評分規則' })
  await dialog.getByLabel('占總成績 %').nth(1).fill('50')
  await expect(dialog.getByTestId('weight-sum').first()).toContainText('階段合計 110%（要 100%）')
  await dialog.getByRole('button', { name: '建立草稿' }).click()
  await expect(dialog.getByRole('alert')).toContainText('各階段占總成績的合計是 110%，要剛好 100% 才能建立')
  const versions = await pool.query(
    `select count(*)::int as n from grading_scheme_versions v join grading_schemes s on s.id = v.scheme_id where s.cohort_id = $1`,
    [cohortId],
  )
  expect(versions.rows[0]!.n).toBe(0)

  await dialog.getByLabel('占總成績 %').nth(1).fill('40')
  await dialog.getByLabel('第 1 階段第 1 項權重').fill('50')
  await expect(dialog.getByTestId('weight-sum').nth(1)).toContainText('項目合計 50%（要 100%）')
  await dialog.getByRole('button', { name: '＋ 新增項目' }).first().click()
  await dialog.getByLabel('第 1 階段第 2 項名稱').fill('文件')
  await dialog.getByLabel('第 1 階段第 2 項權重').fill('50')
  await expect(dialog.getByTestId('weight-sum').nth(1)).toContainText('項目合計 100%')
  await dialog.getByRole('button', { name: '建立草稿' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已建立評分規則第 1 版（草稿）' })).toBeVisible()

  await openVersions(page)
  const card = versionCard(page, 1)
  await expect(card).toContainText('草稿')
  await card.getByRole('button', { name: '發布第 1 版' }).click()
  await expect(page.getByTestId('scheme-status')).toHaveText('第 1 版・已發布')
  await expect(page.getByTestId('scheme-formula')).toContainText('系統驗收 × 60% ＋ 專題發表 × 40%')

  await page.reload()
  await expect(page.getByTestId('scheme-status')).toHaveText('第 1 版・已發布')
})

test('設要求份數並指派：G01「系統驗收」要 2 份、指派評一與評二；G02 指派評三；老師收到評分指派通知', async ({ page }) => {
  await openAssign(page)
  await expect(page.getByRole('navigation', { name: '選擇階段' }).getByRole('link', { name: '系統驗收' })).toHaveAttribute('aria-current', 'page')

  await row(page, 'G01').getByLabel('G01「系統驗收」需要幾位老師評分').fill('2')
  await row(page, 'G01').getByRole('button', { name: '儲存' }).click()
  await expect(row(page, 'G01')).toContainText('已正式送出 0／2 份')

  for (const name of [NAME_1, NAME_2]) {
    await row(page, 'G01').getByLabel('G01「系統驗收」評分老師').selectOption({ label: name })
    await row(page, 'G01').getByRole('button', { name: '指派' }).click()
    await expect(row(page, 'G01').getByRole('status')).toContainText(`已指派 ${name} 老師評 G01「系統驗收」`)
  }
  await row(page, 'G02').getByLabel('G02「系統驗收」評分老師').selectOption({ label: NAME_3 })
  await row(page, 'G02').getByRole('button', { name: '指派' }).click()
  await expect(row(page, 'G02').getByRole('status')).toContainText(`已指派 ${NAME_3} 老師評 G02「系統驗收」`)

  await page.reload()
  await expect(page.getByRole('region', { name: '評分要求與指派' })).toBeVisible()
  await expect(row(page, 'G01').getByTestId('evaluator')).toHaveCount(2)
  await expect(row(page, 'G01')).toContainText(`${NAME_1}未開始`)
  // 已指派的老師不在下拉裡，不能重複指派（伺服器另外也擋，見整合測試）。
  await expect(row(page, 'G01').getByLabel('G01「系統驗收」評分老師').locator('option', { hasText: NAME_1 })).toHaveCount(0)

  const events = await pool.query<{ recipients: string[] }>(
    `select e.recipients from domain_events e join evaluator_assignments a on a.id = e.source_id
      where e.type = 'grading.assigned' and a.group_id = $1 order by e.occurred_real_at`,
    [groupIds.get('G01')],
  )
  expect(events.rows.map((r) => r.recipients)).toEqual([[t1.userId], [t2.userId]])

  // 老師的通知匣（背景工作投影）。
  await signIn(page, t1)
  await expect(async () => {
    await page.goto('/dashboard/teacher/inbox')
    await expect(page.getByText('你被指派評分：G01「系統驗收」')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
})

test('重派對話框：列出原老師（評一）在 G01 的評分指派，只列不移轉', async ({ page }) => {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const groupRow = page.getByRole('region', { name: '全部組別' }).getByRole('row').filter({ hasText: 'G01' })
  await groupRow.getByRole('button', { name: '重派指導老師：G01' }).click()
  const dialog = page.getByRole('dialog', { name: '重派 G01 的指導老師' })
  const grading = dialog.getByRole('region', { name: '原老師在本組的評分指派' })
  await expect(grading.getByTestId('grading-assignments')).toContainText('系統驗收')
  await expect(grading.getByTestId('grading-assignments')).toContainText('未填')
  await expect(grading.getByRole('checkbox')).toHaveCount(0)
  await expect(grading).toContainText('新老師不會自動取得評分權限')
})

test('老師工作台只看到自己的指派；101 標紅擋住；合法分數暫存後重新整理還在；管理員看到「未正式」、方案鎖定；評三開 G01 被拒', async ({ page }) => {
  await signIn(page, t1)
  await page.goto('/dashboard/teacher/grading')
  const queue = page.getByRole('list', { name: '評分清單' })
  await expect(queue).toContainText('G01')
  await expect(queue).not.toContainText('G02')

  await queue.getByRole('link', { name: /G01/ }).click()
  const bench = page.getByRole('region', { name: 'G01「系統驗收」評分表' })
  await bench.getByLabel('1. 功能完整度').fill('101')
  await expect(bench).toContainText('第 1 項要填 0–100 的數字')
  await bench.getByRole('button', { name: '儲存草稿' }).click()
  await expect(bench.getByRole('alert')).toContainText('修正後才能儲存草稿')
  await expect(bench.getByRole('button', { name: '正式送出' })).toBeDisabled()

  await bench.getByLabel('1. 功能完整度').fill('80')
  await expect(bench.getByTestId('score-preview')).toContainText('40.00')
  await expect(bench).toContainText('還有 1 項沒填')
  await bench.getByRole('button', { name: '儲存草稿' }).click()
  await expect(bench.getByTestId('save-status')).toContainText('已儲存')
  await expect(bench.getByTestId('save-status')).toContainText('系統記錄的儲存時間')

  await page.reload()
  await expect(page.getByRole('region', { name: 'G01「系統驗收」評分表' }).getByLabel('1. 功能完整度')).toHaveValue('80')

  // 管理員：這一格是暫存、未正式；第一位老師開始填，方案就鎖定（產品 7.5）。
  await openRules(page)
  await expect(page.getByTestId('scheme-status')).toHaveText('第 1 版・已鎖定')
  await expect(row(page, 'G01')).toContainText('評分草稿（未送出）・1／2 項')
  await expect(row(page, 'G01')).toContainText('40.00（未正式）')
  await expect(row(page, 'G01')).toContainText('已正式送出 0／2 份')

  // 評三沒有被指派 G01：直接開網址只看到「找不到這個頁面」（不說原因），沒有任何分數。
  await signIn(page, t3)
  await page.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}`)
  await expect(page.getByRole('heading', { name: '找不到這個頁面' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText('40.00')
})

test('正式送出：收件章回執；欄位仍可改、出現「重新送出」與送出紀錄 1 次；方案 v1 已鎖定，新版本不能直接發布', async ({ page }) => {
  await signIn(page, t1)
  const bench = await openBench(page)
  await bench.getByLabel('2. 文件').fill('88.58')
  await expect(bench.getByTestId('score-preview')).toContainText('84.29')
  await bench.getByRole('button', { name: '正式送出' }).click()
  const confirm = page.getByRole('dialog', { name: '確認正式送出' })
  await expect(confirm).toContainText('84.29')
  await confirm.getByRole('button', { name: '確認送出' }).click()
  const receipt = page.getByRole('dialog', { name: '已送出' })
  await expect(receipt).toContainText('G01・系統驗收')
  await expect(receipt).toContainText('84.29')
  await expect(receipt).toContainText('已計入階段成績')
  await receipt.getByRole('button', { name: '知道了' }).click()
  // B 階段 TE-B1：送出後欄位仍可改，按鈕換成「重新送出」。
  await expect(bench.getByLabel('1. 功能完整度')).toBeEnabled()
  await expect(bench.getByTestId('resubmit')).toBeVisible()

  await page.reload()
  const sent = await benchReady(page)
  await expect(sent.getByTestId('save-status')).toContainText('已正式送出（第 1 次）')
  await expect(sent.getByLabel('2. 文件')).toBeEnabled()
  await expect(sent.getByTestId('resubmit')).toBeVisible()
  await expect(sent.getByRole('button', { name: '正式送出' })).toHaveCount(0)
  // 「送出紀錄」是摺疊區：打開才看得到每一次送出。
  await sent.getByTestId('submit-history').getByText('送出紀錄（1 次）').click()
  await expect(sent.getByTestId('submit-history').getByRole('listitem')).toHaveCount(1)
  const counted = await pool.query(
    `select count(*)::int as n from evaluation_status s join evaluator_assignments a on a.id = s.assignment_id
      where a.group_id = $1 and a.teacher_user_id = $2 and s.state = 'counted'`,
    [groupIds.get('G01'), t1.userId],
  )
  expect(counted.rows[0]!.n).toBe(1)

  await openRules(page)
  await expect(page.getByTestId('scheme-status')).toHaveText('第 1 版・已鎖定')
  await expect(row(page, 'G01')).toContainText('已正式送出 1／2 份')
  await expect(row(page, 'G01')).toContainText(`${NAME_1}已正式送出84.29`)

  // 鎖定後建新版本可以（草稿），但不能直接發布換掉。
  await page.getByRole('button', { name: '建立新版評分規則' }).click()
  const dialog = page.getByRole('dialog', { name: '建立新版評分規則' })
  await expect(dialog).toContainText('從第 1 版複製起草')
  await dialog.getByRole('button', { name: '建立草稿' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已建立評分規則第 2 版（草稿）' })).toBeVisible()
  await openVersions(page)
  const v2 = versionCard(page, 2)
  // 票 24：鎖定後的新版本不能直接發布，只能「查看重算影響（尚不套用）」（先看重算預覽再確認）。
  await expect(v2.getByRole('button', { name: '發布第 2 版' })).toHaveCount(0)
  await expect(v2.getByRole('link', { name: '查看第 2 版重算影響（尚不套用）' })).toBeVisible()
})

/** 評分卡；`page` 已經是 t1。 */
/**
 * 評分卡的 region，等 hydration 完成（`data-hydrated`）才回傳：在那之前按鈕還沒掛事件，而且 React 接手 textarea 時會把
 * Playwright `fill` 剛設好的全選重設到開頭，貼進去的字就變成前置貼入（Review #584 用攔住 JS chunk 的探針證實，舊版新版都一樣）。
 */
async function benchReady(page: Page) {
  const bench = page.getByRole('region', { name: 'G01「系統驗收」評分表' })
  await expect(bench).toHaveAttribute('data-hydrated', '')
  return bench
}

async function openBench(page: Page) {
  await page.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}`)
  return benchReady(page)
}

/** G01 評一正式送出過的評分：採計幾筆、歷史幾筆（草稿不算）。 */
async function evaluationStates() {
  const states = await pool.query<{ state: string; n: number }>(
    `select s.state, count(*)::int as n from evaluation_status s join evaluator_assignments a on a.id = s.assignment_id
      where a.group_id = $1 and a.teacher_user_id = $2 and s.state in ('counted', 'historical') group by s.state`,
    [groupIds.get('G01'), t1.userId],
  )
  return Object.fromEntries(states.rows.map((r) => [r.state, r.n]))
}

test('AC-A-2：正式送出後只「儲存草稿」→ 出現「有尚未送出的修改」、總覽卡標「有未送出修改」；系辦看到的採計分數仍是 84.29', async ({ page }) => {
  await signIn(page, t1)
  const bench = await openBench(page)
  await bench.getByLabel('1. 功能完整度').fill('90')
  await bench.getByLabel('評語（選填，最多 500 字）').fill('第二次：功能補齊')
  await expect(bench.getByTestId('score-preview')).toContainText('89.29')
  await bench.getByRole('button', { name: '儲存草稿' }).click()
  await expect(bench.getByTestId('draft-after-final')).toHaveText('有尚未送出的修改')

  await page.reload()
  const again = await benchReady(page)
  await expect(again.getByTestId('draft-after-final')).toBeVisible()
  await expect(again.getByLabel('1. 功能完整度')).toHaveValue('90')
  await expect(again.getByLabel('評語（選填，最多 500 字）')).toHaveValue('第二次：功能補齊')
  await expect(again.getByTestId('save-status')).toContainText('已正式送出（第 1 次）')
  expect(await evaluationStates()).toEqual({ counted: 1 })

  await page.goto('/dashboard/teacher/grading')
  const card = page.getByRole('list', { name: '評分清單' }).getByTestId('grading-card').filter({ hasText: 'G01' })
  await expect(card).toContainText('已送出')
  await expect(card.getByTestId('card-draft-after-final')).toHaveText('有未送出修改')

  await openRules(page)
  await expect(row(page, 'G01')).toContainText(`${NAME_1}已正式送出84.29`)
})

test('AC-A-3（前端）：評語 501 字 → 表單擋下「評語最多 500 字」、不送請求；刪到 500 字就能存', async ({ page }) => {
  await signIn(page, t1)
  const bench = await openBench(page)
  await expect(bench.getByTestId('draft-after-final')).toBeVisible()
  const comment = bench.getByLabel('評語（選填，最多 500 字）')
  await comment.fill('評'.repeat(501))
  await expect(bench.getByTestId('comment-error')).toHaveText('評語最多 500 字')
  await expect(bench).toContainText('501／500')
  await expect(bench.getByTestId('resubmit')).toBeDisabled()

  const posts: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST') posts.push(r.url())
  })
  await bench.getByRole('button', { name: '儲存草稿' }).click()
  await expect(bench.getByRole('alert')).toContainText('評語最多 500 字，修正後才能儲存草稿')
  expect(posts).toEqual([])

  await comment.fill('評'.repeat(500))
  await expect(bench.getByTestId('comment-error')).toHaveCount(0)
  await bench.getByRole('button', { name: '儲存草稿' }).click()
  // 「有尚未送出的修改」Pill 是伺服器事實（上一條就已經有草稿），不能拿它等這次儲存；等儲存成功的訊息。
  await expect(bench.getByRole('status').filter({ hasText: '已儲存草稿' })).toBeVisible()
  await expect(bench.getByTestId('draft-after-final')).toBeVisible()
  const saved = await pool.query<{ len: number }>(
    `select char_length(e.comment)::int as len from evaluations e join evaluator_assignments a on a.id = e.assignment_id
      where a.group_id = $1 and a.teacher_user_id = $2 order by e.submitted_real_at desc limit 1`,
    [groupIds.get('G01'), t1.userId],
  )
  expect(saved.rows[0]!.len).toBe(500)
})

test('AC-A-1：改分數與評語後「重新送出」→ 第 2 次、送出紀錄兩筆；counted 1、historical 1（resubmitted）；系辦沒有新通知', async ({ page }) => {
  await signIn(page, t1)
  const bench = await openBench(page)
  await bench.getByLabel('評語（選填，最多 500 字）').fill('重送：功能補齊，文件維持')
  const before = new Date()
  await bench.getByTestId('resubmit').click()
  const confirm = page.getByRole('dialog', { name: '確認重新送出' })
  await expect(confirm).toContainText('89.29')
  await expect(confirm).toContainText('上一次送出的分數改列為歷史紀錄')
  await confirm.getByRole('button', { name: '確認送出' }).click()
  const receipt = page.getByRole('dialog', { name: '已送出' })
  await expect(receipt).toContainText('89.29')
  await receipt.getByRole('button', { name: '知道了' }).click()
  await expect(bench.getByTestId('save-status')).toContainText('已正式送出（第 2 次）')
  await expect(bench.getByTestId('draft-after-final')).toHaveCount(0)

  await page.reload()
  const again = await benchReady(page)
  await expect(again.getByTestId('save-status')).toContainText('已正式送出（第 2 次）')
  const history = again.getByTestId('submit-history')
  await history.getByText('送出紀錄（2 次）').click()
  await expect(history.getByRole('listitem')).toHaveCount(2)
  await expect(history.getByRole('listitem').nth(0)).toContainText('第 1 次送出')
  await expect(history.getByRole('listitem').nth(1)).toContainText('第 2 次送出')
  await expect(history.getByRole('listitem').nth(1)).toContainText('（目前採計）')
  await expect(again.getByTestId('score-preview')).toContainText('計入成績的分數')
  await expect(again.getByTestId('score-preview')).toContainText('89.29')

  expect(await evaluationStates()).toEqual({ counted: 1, historical: 1 })
  const reason = await pool.query<{ reason: string | null }>(
    `select ev.reason from evaluation_status_events ev
       join evaluation_status s on s.evaluation_id = ev.evaluation_id
       join evaluator_assignments a on a.id = s.assignment_id
      where a.group_id = $1 and a.teacher_user_id = $2 and s.state = 'historical'
      order by ev.real_at desc limit 1`,
    [groupIds.get('G01'), t1.userId],
  )
  expect(reason.rows[0]?.reason).toBe('resubmitted')
  const adminEvents = await pool.query<{ n: number }>(
    `select count(*)::int as n from domain_events where occurred_real_at >= $1 and $2 = any(recipients)`,
    [before, adminId],
  )
  expect(adminEvents.rows[0]!.n).toBe(0)

  await openRules(page)
  await expect(row(page, 'G01')).toContainText(`${NAME_1}已正式送出89.29`)
})

test('Review #584 r1 反例②：兩個分頁先後重送 → 後送的分頁顯示第 4 次、紀錄 4 筆；先送的分頁回到前景後也更新成第 4 次並提示', async ({ page, context }) => {
  test.skip(skipped('r1-2'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await signIn(page, t1)
  const benchA = await openBench(page)
  const other = await context.newPage()
  await other.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}`)
  const benchB = await benchReady(other)
  await expect(benchA.getByTestId('save-status')).toContainText('已正式送出（第 2 次）')
  await expect(benchB.getByTestId('save-status')).toContainText('已正式送出（第 2 次）')

  async function resubmit(target: Page, bench: typeof benchA, text: string) {
    await bench.getByLabel('評語（選填，最多 500 字）').fill(text)
    await bench.getByTestId('resubmit').click()
    await target.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
    await target.getByRole('dialog', { name: '已送出' }).getByRole('button', { name: '知道了' }).click()
  }

  await resubmit(page, benchA, '分頁 A 的第三次')
  await expect(benchA.getByTestId('save-status')).toContainText('已正式送出（第 3 次）')

  // 分頁 B 還停在第 2 次的畫面就重送：伺服器是第 4 次，畫面要跟伺服器，不是自己加一。
  await resubmit(other, benchB, '分頁 B 的第四次')
  await expect(benchB.getByTestId('save-status')).toContainText('已正式送出（第 4 次）')
  await expect(benchB.getByTestId('bench-stale')).toContainText('第 4 次')
  await benchB.getByTestId('submit-history').getByText('送出紀錄（4 次）').click()
  await expect(benchB.getByTestId('submit-history').getByRole('listitem')).toHaveCount(4)
  expect(await evaluationStates()).toEqual({ counted: 1, historical: 3 })

  // 分頁 A 回到前景（focus）→ 重抓，跟上第 4 次與分頁 B 的評語。
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(benchA.getByTestId('save-status')).toContainText('已正式送出（第 4 次）')
  await expect(benchA.getByTestId('bench-stale')).toContainText('第 4 次')
  await expect(benchA.getByLabel('評語（選填，最多 500 字）')).toHaveValue('分頁 B 的第四次')
  await benchA.getByTestId('submit-history').getByText('送出紀錄（4 次）').click()
  await expect(benchA.getByTestId('submit-history').getByRole('listitem')).toHaveCount(4)
  await other.close()
})

test('AC-A-6／Review #584 r1 反例①：系辦結算「系統驗收」後，老師舊頁按「儲存草稿」被擋（CONFLICT 含「已結算」）、被拒的分數與評語不留在畫面；重新整理全唯讀、「已結算」Pill、沒有按鈕；總覽卡標「已結算」', async ({ page }) => {
  test.skip(skipped('r1-1'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await signIn(page, t1)
  const bench = await openBench(page)
  await expect(bench.getByTestId('resubmit')).toBeVisible()
  // 伺服器目前存的（前一條沒跑時也不寫死）：被拒後畫面要換回這些。
  const storedScore = await bench.getByLabel('1. 功能完整度').inputValue()
  const storedComment = await bench.getByLabel('評語（選填，最多 500 字）').inputValue()
  const storedStatus = (await bench.getByTestId('save-status').innerText()).match(/第 \d+ 次/)![0]
  const storedStates = await evaluationStates()
  await expect(bench.getByTestId('score-preview')).toContainText('計入成績的分數')
  const storedCounted = (await bench.getByTestId('score-preview').innerText()).match(/\d+\.\d{2}/)![0]

  // 結算的畫面是 A-03 的；這裡直接寫一筆現行結算（跟 settleStage 寫的同一張表、同一個欄位組合）。
  const assignment = await pool.query<{ stage_key: string }>(
    `select stage_key from evaluator_assignments where group_id = $1 and teacher_user_id = $2 and valid_to is null`,
    [groupIds.get('G01'), t1.userId],
  )
  await pool.query(
    `insert into grade_settlements (id, cohort_id, stage_key, settled_at, settled_by_user_id, reason, counted_evaluations, request_id)
     values (gen_random_uuid(), $1, $2, now(), $3, 'e2e 結算', 1, gen_random_uuid()::text)`,
    [cohortId, assignment.rows[0]!.stage_key, adminId],
  )

  await bench.getByLabel('1. 功能完整度').fill('70')
  await bench.getByLabel('評語（選填，最多 500 字）').fill('結算後才改的評語')
  await bench.getByRole('button', { name: '儲存草稿' }).click()
  await expect(bench.getByRole('alert')).toContainText('已結算')
  // Review #584 r1 反例①：被拒存的 70 與評語不能留在畫面上被鎖成唯讀；不重新整理就換回伺服器存的。
  await expect(bench.getByLabel('1. 功能完整度')).toBeDisabled()
  await expect(bench.getByLabel('1. 功能完整度')).toHaveValue(storedScore)
  await expect(bench.getByLabel('評語（選填，最多 500 字）')).toHaveValue(storedComment)
  await expect(bench.getByTestId('score-preview')).toContainText('計入成績的分數')
  await expect(bench.getByTestId('score-preview')).toContainText(storedCounted)
  await expect(bench.getByRole('button', { name: '儲存草稿' })).toHaveCount(0)

  await page.reload()
  const settled = await benchReady(page)
  await expect(settled.getByTestId('settled-pill')).toHaveText('已結算')
  await expect(settled.getByTestId('settled-notice')).toContainText('這個階段成績已由系辦結算，如需修改請聯絡系辦')
  await expect(settled.getByLabel('1. 功能完整度')).toBeDisabled()
  await expect(settled.getByLabel('1. 功能完整度')).toHaveValue(storedScore)
  await expect(settled.getByLabel('評語（選填，最多 500 字）')).toBeDisabled()
  await expect(settled.getByRole('button', { name: '儲存草稿' })).toHaveCount(0)
  await expect(settled.getByTestId('resubmit')).toHaveCount(0)
  await expect(settled.getByTestId('save-status')).toContainText(`已正式送出（${storedStatus}）`)
  await expect(settled.getByTestId('save-status')).not.toContainText('可再修改')
  expect(await evaluationStates()).toEqual(storedStates)

  await page.goto('/dashboard/teacher/grading')
  const card = page.getByRole('list', { name: '評分清單' }).getByTestId('grading-card').filter({ hasText: 'G01' })
  await expect(card.getByTestId('card-settled')).toHaveText('已結算')
})

test('學生：「成績」頁只有一句說明；直接開評分管理、工作台網址都被擋', async ({ page }) => {
  await signIn(page, student)
  await page.goto('/dashboard/student/grading')
  await expect(page).toHaveURL(/\/dashboard\/student$/)
  await expect(page.locator('body')).not.toContainText('84.29')

  for (const path of ['/dashboard/admin/grading', '/dashboard/teacher/grading', `/dashboard/teacher/grading/${groupIds.get('G01')}`]) {
    const response = await page.request.get(path, { maxRedirects: 0 })
    expect([302, 303, 307, 308], path).toContain(response.status())
    expect(response.headers()['location'], path).toContain('/403')
    expect(await response.text(), path).not.toContain('84.29')
  }
})

// ───────────── Review #584 第 2 輪的三個反例：用 page.route 攔 Server Action 模擬延遲與中斷 ─────────────

/** G01 評一正式送出過幾次（採計＋歷史）。 */
async function submissionCount() {
  const states = await evaluationStates()
  return (states['counted'] ?? 0) + (states['historical'] ?? 0)
}

/** G01 評一在 DB 裡最新的一筆（指定狀態）的分數與評語。 */
async function storedEvaluation(state: 'draft' | 'counted') {
  const rows = await pool.query<{ scores: Record<string, string>; comment: string | null }>(
    `select e.scores, e.comment from evaluations e
       join evaluation_status s on s.evaluation_id = e.id
       join evaluator_assignments a on a.id = e.assignment_id
      where a.group_id = $1 and a.teacher_user_id = $2 and s.state = $3
      order by e.submitted_real_at desc limit 1`,
    [groupIds.get('G01'), t1.userId, state],
  )
  return rows.rows[0] ?? null
}

/** 評一在 G01 的有效指派屬於哪個階段（結算是整個階段）。 */
async function stageKeyOfG01() {
  const assignment = await pool.query<{ stage_key: string }>(
    `select stage_key from evaluator_assignments where group_id = $1 and teacher_user_id = $2 and valid_to is null`,
    [groupIds.get('G01'), t1.userId],
  )
  return assignment.rows[0]!.stage_key
}

/** 結算畫面是 A-03 的；直接寫同一張表（跟 settleStage 同欄位）。 */
async function settleG01Stage() {
  await pool.query(
    `insert into grade_settlements (id, cohort_id, stage_key, settled_at, settled_by_user_id, reason, counted_evaluations, request_id)
     values (gen_random_uuid(), $1, $2, now(), $3, 'e2e 結算', 1, gen_random_uuid()::text)`,
    [cohortId, await stageKeyOfG01(), adminId],
  )
}

/** 解除目前的結算（跟 releaseSettlement 同欄位）。 */
async function releaseG01Stage() {
  await pool.query(
    `update grade_settlements set released_at = now(), released_by_user_id = $2, release_reason = 'e2e 解除'
      where cohort_id = $1 and released_at is null`,
    [cohortId, adminId],
  )
}

/**
 * 攔下一個 Server Action 的 POST（帶 `next-action` header）：先讓伺服器真的處理完（`route.fetch`），
 * 回應停在路上，等測試決定要放行（`release`）還是當成斷線（`drop`）。
 */
async function holdNextAction(page: Page) {
  let release!: () => void
  let drop!: () => void
  let ready!: () => void
  const verdict = new Promise<'release' | 'drop'>((resolve) => {
    release = () => resolve('release')
    drop = () => resolve('drop')
  })
  const received = new Promise<void>((resolve) => {
    ready = resolve
  })
  let matched = false
  const pattern = '**/dashboard/teacher/grading/**'
  const handler = async (route: Route) => {
    const request = route.request()
    if (matched || request.method() !== 'POST' || !request.headers()['next-action']) return route.continue()
    matched = true
    const response = await route.fetch()
    await response.body()
    ready()
    if ((await verdict) === 'drop') await route.abort('internetdisconnected')
    else await route.fulfill({ response })
    await page.unroute(pattern, handler)
  }
  await page.route(pattern, handler)
  return { received, release, drop }
}

/** 模擬切回這個分頁：送 focus，等這一次重抓（RSC GET）的回應回來並套用。 */
async function refocus(page: Page, bench: ReturnType<Page['getByRole']>) {
  const before = await bench.getAttribute('data-server-time')
  const synced = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.request().headers()['rsc'] === '1' && r.url().includes('/dashboard/teacher/grading/'),
    { timeout: 15_000 },
  )
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await synced
  // 新版把這份 props 的伺服器時間放在 data-server-time：變了就是套用完；舊版沒有這個屬性，等一下再看。
  if (before !== null) await expect(bench).not.toHaveAttribute('data-server-time', before)
  else await page.waitForTimeout(500)
}

test('Review #584 r2 反例①：送出已寫入但回應中斷 → 切回前景同步 → 同一個請求編號重試：次數跟 DB 一致、不會多 1', async ({ page }) => {
  test.skip(skipped('r2-1'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await releaseG01Stage()
  await signIn(page, t1)
  const bench = await openBench(page)
  await expect(bench.getByTestId('resubmit')).toBeVisible()
  const before = await submissionCount()
  await expect(bench.getByTestId('save-status')).toContainText(`第 ${before} 次`)

  await bench.getByLabel('1. 功能完整度').fill('74')
  const held = await holdNextAction(page)
  await bench.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await held.received
  held.drop()
  await expect(bench.getByRole('alert')).toContainText('連線中斷')
  // 伺服器其實已經寫入了。
  expect(await submissionCount()).toBe(before + 1)

  // 切回前景：次數跟上伺服器。
  await refocus(page, bench)
  await expect(bench.getByTestId('save-status')).toContainText(`第 ${before + 1} 次`)

  // 照提示再按一次（內容沒改，請求編號一樣）：伺服器回同一張回執，畫面仍是第 before+1 次，DB 也沒多一筆。
  await bench.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await page.getByRole('dialog', { name: '已送出' }).getByRole('button', { name: '知道了' }).click()
  await refocus(page, bench)
  await expect(bench.getByTestId('save-status')).toContainText(`第 ${before + 1} 次`)
  await bench.getByTestId('submit-history').getByText(`送出紀錄（${before + 1} 次）`).click()
  await expect(bench.getByTestId('submit-history').getByRole('listitem')).toHaveCount(before + 1)
  expect(await submissionCount()).toBe(before + 1)
  await expect(bench.getByLabel('1. 功能完整度')).toHaveValue('74')
  await expect(bench.getByTestId('edit-status')).toHaveCount(0)
  await expect(bench.getByTestId('bench-stale')).toContainText('其實已經送達')
})

test('Review #584 r2 反例②：等伺服器回應時續改分數與評語 → 成功回應不清掉續打的內容，切回前景也不蓋回；儲存草稿與重新送出兩條路徑', async ({ page }) => {
  test.skip(skipped('r2-2'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await releaseG01Stage() // 上一條若被跳過，階段還在結算中；先解除才有可改的評分卡
  await signIn(page, t1)
  const bench = await openBench(page)
  const score = bench.getByLabel('1. 功能完整度')
  const comment = bench.getByLabel('評語（選填，最多 500 字）')
  const before = await submissionCount()

  // 儲存草稿：回應在路上時續打 81 與新評語。
  await score.fill('70')
  await comment.fill('送出儲存時的評語')
  const save = await holdNextAction(page)
  await bench.getByRole('button', { name: '儲存草稿' }).click()
  await save.received
  await score.fill('81')
  await comment.fill('儲存等待中續打的評語')
  save.release()
  await expect(bench.getByTestId('draft-after-final')).toBeVisible()
  await expect(score).toHaveValue('81')
  await expect(comment).toHaveValue('儲存等待中續打的評語')
  await expect(bench.getByTestId('edit-status')).toContainText('有尚未儲存的修改')
  await refocus(page, bench)
  await expect(score).toHaveValue('81')
  await expect(comment).toHaveValue('儲存等待中續打的評語')
  const draft = await storedEvaluation('draft')
  expect(draft!.scores[await firstItemKey()]).toBe('70')
  expect(draft!.comment).toBe('送出儲存時的評語')
  await expect(bench.getByTestId('bench-message')).toContainText('之後改的還沒存')

  // 重新送出：回應在路上時續打 82 與新評語。
  await score.fill('72')
  await comment.fill('送出時的評語')
  const submit = await holdNextAction(page)
  await bench.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await submit.received
  await score.fill('82')
  await comment.fill('重送等待中續打的評語')
  submit.release()
  await page.getByRole('dialog', { name: '已送出' }).getByRole('button', { name: '知道了' }).click()
  await expect(bench.getByTestId('save-status')).toContainText(`第 ${before + 1} 次`)
  await expect(score).toHaveValue('82')
  await expect(comment).toHaveValue('重送等待中續打的評語')
  await expect(bench.getByTestId('edit-status')).toContainText('有尚未儲存的修改')
  await refocus(page, bench)
  await expect(score).toHaveValue('82')
  await expect(comment).toHaveValue('重送等待中續打的評語')
  const counted = await storedEvaluation('counted')
  expect(counted!.scores[await firstItemKey()]).toBe('72')
  expect(counted!.comment).toBe('送出時的評語')
  await expect(bench.getByTestId('bench-message')).toContainText('之後改的還沒存')
})

test('Review #584 r2 反例③：還沒儲存的修改＋系辦在別處結算 → 切回前景：唯讀欄顯示伺服器存的值、未存內容保留在提示區可複製；解除結算後可恢復；結算後被拒存也一樣保留', async ({ page }) => {
  test.skip(skipped('r2-3'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await releaseG01Stage() // 上一條若被跳過，階段還在結算中；先解除才有可改的評分卡
  await signIn(page, t1)
  const bench = await openBench(page)
  const score = bench.getByLabel('1. 功能完整度')
  const comment = bench.getByLabel('評語（選填，最多 500 字）')
  await expect(bench.getByTestId('resubmit')).toBeVisible()
  const storedScore = await score.inputValue()
  const storedComment = await comment.inputValue()

  await score.fill('83')
  await comment.fill('結算前還沒存的評語')
  await settleG01Stage()
  await refocus(page, bench)
  await expect(score).toBeDisabled()
  await expect(bench.getByTestId('settled-pill')).toHaveText('已結算')
  // 唯讀欄顯示伺服器存的值；沒存成功的 83 與評語不鎖進欄位，而是保留在提示區。
  await expect(score).toHaveValue(storedScore)
  await expect(comment).toHaveValue(storedComment)
  const stash = bench.getByTestId('bench-stash')
  await expect(stash).toContainText('功能完整度：83')
  await expect(stash).toContainText('結算前還沒存的評語')
  await expect(stash.getByRole('button', { name: '複製未儲存的內容' })).toBeVisible()
  await expect(bench.getByRole('button', { name: '儲存草稿' })).toHaveCount(0)
  await expect(bench.getByTestId('resubmit')).toHaveCount(0)
  expect((await storedEvaluation('counted'))!.scores[await firstItemKey()]).toBe(storedScore)

  // 系辦解除結算 → 切回前景：可以再改，按「恢復」把沒存的內容填回表單。
  await releaseG01Stage()
  await refocus(page, bench)
  await expect(score).toBeEnabled()
  await stash.getByRole('button', { name: '恢復未儲存的內容' }).click()
  await expect(score).toHaveValue('83')
  await expect(comment).toHaveValue('結算前還沒存的評語')
  await expect(bench.getByTestId('edit-status')).toContainText('有尚未儲存的修改')
  await expect(stash).toHaveCount(0)

  // 再被結算、這次是主動按「儲存草稿」被拒（r1 反例①的路徑）：同樣換回伺服器值、未存內容進提示區。
  await settleG01Stage()
  await bench.getByRole('button', { name: '儲存草稿' }).click()
  await expect(bench.getByRole('alert')).toContainText('已結算')
  await expect(score).toBeDisabled()
  await expect(score).toHaveValue(storedScore)
  await expect(bench.getByTestId('bench-stash')).toContainText('功能完整度：83')
  await expect(bench.getByTestId('bench-stash')).toContainText('結算前還沒存的評語')
})

// ───────────── Review #584 第 4 輪（Astra r3）的五個反例：凍結 payload、舊收據、新操作、stash 列表、舊快照 ─────────────

/** 從現在起收集這個分頁送出的 Server Action POST 原文（含請求編號；同一次操作重試必須一字不差）。 */
function collectActionBodies(page: Page) {
  const bodies: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.headers()['next-action']) bodies.push(r.postData() ?? '')
  })
  return bodies
}

/** Server Action POST 的參數陣列：`[assignmentId, scores, comment, requestId]`。 */
function actionArgs(body: string): [string, Record<string, string>, string, string] {
  return JSON.parse(body) as [string, Record<string, string>, string, string]
}

const isRscGet = (r: { method(): string; headers(): Record<string, string>; url(): string }) =>
  r.method() === 'GET' && r.headers()['rsc'] === '1' && r.url().includes('/dashboard/teacher/grading/')

/** 送 focus 讓評分卡重抓一次，只等 RSC 回應回來（不要求畫面套用——重放舊快照時就是要它不套用）。 */
async function focusAndWaitRsc(page: Page) {
  const synced = page.waitForResponse((r) => isRscGet(r.request()), { timeout: 15_000 })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await synced
  await page.waitForTimeout(400)
}

/** 另一個分頁（同一位老師）把第一項改成 `value` 並重新送出，等 DB 採計變成它。 */
async function otherTabResubmit(other: Page, value: string) {
  const b = await benchReady(other)
  await b.getByLabel('1. 功能完整度').fill(value)
  await b.getByTestId('resubmit').click()
  await other.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await other.getByRole('dialog', { name: '已送出' }).getByRole('button', { name: '知道了' }).click()
  await expect.poll(async () => (await storedEvaluation('counted'))?.scores[await firstItemKey()]).toBe(value)
}

test('Review #584 r3 反例①：送出 74.00 回應中斷 → 重抓對上（伺服器存 74）→ 再按一次送的是凍結的原 payload 與同一個請求編號：拿到同一張回執、不是 REQUEST_MISMATCH、DB 不多一筆', async ({ page }) => {
  test.skip(skipped('r3-1'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await releaseG01Stage()
  await signIn(page, t1)
  const bench = await openBench(page)
  const score = bench.getByLabel('1. 功能完整度')
  await expect(bench.getByTestId('resubmit')).toBeVisible()
  const before = await submissionCount()
  const bodies = collectActionBodies(page)

  await score.fill('74.00')
  const held = await holdNextAction(page)
  await bench.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await held.received
  held.drop()
  await expect(bench.getByRole('alert')).toContainText('連線中斷')
  expect(await submissionCount()).toBe(before + 1)

  // 切回前景：伺服器存的是正規化後的 74，對得上這次送的內容 → 其實已送達；欄位裡老師打的原值不動。
  await refocus(page, bench)
  await expect(bench.getByTestId('bench-stale')).toContainText('其實已經送達')
  await expect(bench.getByTestId('save-status')).toContainText(`第 ${before + 1} 次`)

  // 再按一次：送的必須是凍結的 `{requestId, payload}`（74.00），不是從欄位重讀或正規化後的 74 → 伺服器回同一張回執。
  await bench.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await expect(page.getByRole('dialog', { name: '已送出' })).toBeVisible()
  await page.getByRole('dialog', { name: '已送出' }).getByRole('button', { name: '知道了' }).click()
  await expect(bench.getByRole('alert')).toHaveCount(0)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toBe(bodies[0])
  expect(actionArgs(bodies[0]!)[1][await firstItemKey()]).toBe('74.00')
  await refocus(page, bench)
  expect(await submissionCount()).toBe(before + 1)
  await expect(bench.getByTestId('save-status')).toContainText(`第 ${before + 1} 次`)
  await expect(score).toHaveValue('74.00')
  expect((await storedEvaluation('counted'))!.scores[await firstItemKey()]).toBe('74')
})

test('Review #584 r3 反例②：A 送 81 回應中斷、B 再送 91 → A 切回前景看到衝突、選「保留我的修改」後重試 → 拿回的是舊收據：不清未存、不開收件章、欄位仍是 81，DB 仍是 91；之後結算 → 唯讀欄顯示 91、81 進未存清單', async ({ page, context }) => {
  test.skip(skipped('r3-2'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await releaseG01Stage()
  await signIn(page, t1)
  const benchA = await openBench(page)
  const scoreA = benchA.getByLabel('1. 功能完整度')
  await expect(benchA.getByTestId('resubmit')).toBeVisible()
  const other = await context.newPage()
  await other.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}`)
  await benchReady(other)
  const key = await firstItemKey()
  const before = await submissionCount()

  await scoreA.fill('81')
  const held = await holdNextAction(page)
  await benchA.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await held.received
  await otherTabResubmit(other, '91')
  held.drop()
  await expect(benchA.getByRole('alert')).toContainText('連線中斷')
  expect(await submissionCount()).toBe(before + 2)

  // 切回前景：伺服器是 B 的 91，A 還有未存的 81 → 衝突區讓老師選。
  await refocus(page, benchA)
  await expect(benchA.getByTestId('bench-conflict')).toBeVisible()
  await expect(scoreA).toHaveValue('81')
  await expect(benchA.getByTestId('save-status')).toContainText(`第 ${before + 2} 次`)
  await benchA.getByRole('button', { name: '保留我的修改' }).click()

  // 重試：伺服器回 81 那一次的舊收據（版本比已知的 91 舊）→ 不能把 81 當成已存、不開收件章；老師仍可選。
  await benchA.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await expect(benchA.getByTestId('edit-status')).toContainText('有尚未儲存的修改')
  await expect(page.getByRole('dialog', { name: '已送出' })).not.toBeVisible()
  await expect(benchA.getByRole('alert')).toContainText('已被別的分頁或裝置的送出取代')
  await expect(benchA.getByTestId('bench-conflict')).toBeVisible()
  await expect(scoreA).toHaveValue('81')
  await expect(benchA.getByTestId('score-preview')).not.toContainText('計入成績的分數')
  expect((await storedEvaluation('counted'))!.scores[key]).toBe('91')
  expect(await submissionCount()).toBe(before + 2)

  // 系辦結算 → 切回前景：唯讀欄顯示伺服器的 91，沒存成功的 81 保留在未存清單。
  await settleG01Stage()
  await refocus(page, benchA)
  await expect(scoreA).toBeDisabled()
  await expect(scoreA).toHaveValue('91')
  await expect(benchA.getByTestId('bench-stash')).toContainText('功能完整度：81')
  await expect(benchA.getByTestId('bench-conflict')).toHaveCount(0)
  await other.close()
})

test('Review #584 r3 反例③：A 送 82 回應中斷、B 再送 92 → A 切回前景選「改用伺服器的內容」→ 再按「重新送出」是新的一次：新請求編號、payload 是 92，拿到收件章、不是 REQUEST_MISMATCH', async ({ page, context }) => {
  test.skip(skipped('r3-3'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await releaseG01Stage()
  await signIn(page, t1)
  const benchA = await openBench(page)
  const scoreA = benchA.getByLabel('1. 功能完整度')
  await expect(benchA.getByTestId('resubmit')).toBeVisible()
  const other = await context.newPage()
  await other.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}`)
  await benchReady(other)
  const key = await firstItemKey()
  const before = await submissionCount()
  const bodies = collectActionBodies(page)

  await scoreA.fill('82')
  const held = await holdNextAction(page)
  await benchA.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await held.received
  await otherTabResubmit(other, '92')
  held.drop()
  await expect(benchA.getByRole('alert')).toContainText('連線中斷')

  await refocus(page, benchA)
  await expect(benchA.getByTestId('bench-conflict')).toBeVisible()
  await benchA.getByRole('button', { name: '改用伺服器的內容' }).click()
  await expect(scoreA).toHaveValue('92')
  await expect(benchA.getByTestId('bench-conflict')).toHaveCount(0)
  await expect(benchA.getByTestId('edit-status')).toHaveCount(0)

  // 內容已換成伺服器的：這一按是新的一次操作，不能沿用 82 那次的請求編號。
  await benchA.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await expect(page.getByRole('dialog', { name: '已送出' })).toBeVisible()
  await page.getByRole('dialog', { name: '已送出' }).getByRole('button', { name: '知道了' }).click()
  await expect(benchA.getByRole('alert')).toHaveCount(0)
  expect(bodies).toHaveLength(2)
  const [first, second] = [actionArgs(bodies[0]!), actionArgs(bodies[1]!)]
  expect(first[1][key]).toBe('82')
  expect(second[1][key]).toBe('92')
  expect(second[3]).not.toBe(first[3])
  await refocus(page, benchA)
  expect(await submissionCount()).toBe(before + 3)
  await expect(benchA.getByTestId('save-status')).toContainText(`第 ${before + 3} 次`)
  expect((await storedEvaluation('counted'))!.scores[key]).toBe('92')
  await other.close()
})

test('Review #584 r3 反例④：未存 83／評語 → 結算 → 解除 → 不恢復也不丟棄、再改 84／新評語 → 再結算：兩份未存內容都保留；解除後只恢復第二份、第一份仍在，按「不用了」才消失', async ({ page }) => {
  test.skip(skipped('r3-4'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await releaseG01Stage()
  await signIn(page, t1)
  const bench = await openBench(page)
  const score = bench.getByLabel('1. 功能完整度')
  const comment = bench.getByLabel('評語（選填，最多 500 字）')
  await expect(bench.getByTestId('resubmit')).toBeVisible()
  const storedScore = await score.inputValue()
  const stash = bench.getByTestId('bench-stash')
  const entries = stash.getByTestId('bench-stash-entry')

  await score.fill('83')
  await comment.fill('第一份未存的評語')
  await settleG01Stage()
  await refocus(page, bench)
  await expect(score).toBeDisabled()
  await expect(stash).toContainText('功能完整度：83')
  await expect(stash).toContainText('第一份未存的評語')

  // 解除結算：不恢復、不丟棄，直接再改、再被結算 → 第一份不能被第二份蓋掉。
  await releaseG01Stage()
  await refocus(page, bench)
  await expect(score).toBeEnabled()
  await expect(score).toHaveValue(storedScore)
  await score.fill('84')
  await comment.fill('第二份未存的評語')
  await settleG01Stage()
  await refocus(page, bench)
  await expect(score).toBeDisabled()
  await expect(stash).toContainText('第一份未存的評語')
  await expect(stash).toContainText('第二份未存的評語')
  await expect(entries).toHaveCount(2)
  await expect(entries.nth(0)).toContainText('功能完整度：83')
  await expect(entries.nth(1)).toContainText('功能完整度：84')

  // 解除後只恢復第二份：第一份仍在清單；按第一份的「不用了」才消失。
  await releaseG01Stage()
  await refocus(page, bench)
  await expect(score).toBeEnabled()
  await entries.nth(1).getByRole('button', { name: '恢復未儲存的內容' }).click()
  await expect(score).toHaveValue('84')
  await expect(comment).toHaveValue('第二份未存的評語')
  await expect(bench.getByTestId('edit-status')).toContainText('有尚未儲存的修改')
  await expect(entries).toHaveCount(1)
  await expect(entries.nth(0)).toContainText('功能完整度：83')
  await expect(entries.nth(0)).toContainText('第一份未存的評語')
  await entries.nth(0).getByRole('button', { name: '不用了' }).click()
  await expect(stash).toHaveCount(0)
  await expect(score).toHaveValue('84')
  expect((await storedEvaluation('counted'))!.scores[await firstItemKey()]).toBe(storedScore)
})

test('Review #584 r3 反例⑤：B 重送後，A 重放較舊的 RSC 快照（原時間戳、以及偽造成相同時間戳）→ 整包丟掉：沒有 React 錯誤、畫面仍是 B 的分數與新次數；下一次正常重抓照常接受', async ({ page, context }) => {
  test.skip(skipped('r3-5'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await releaseG01Stage()
  await signIn(page, t1)
  const benchA = await openBench(page)
  const scoreA = benchA.getByLabel('1. 功能完整度')
  await expect(benchA.getByTestId('resubmit')).toBeVisible()
  const other = await context.newPage()
  await other.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}`)
  await benchReady(other)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // 錄下一份真的（較舊的）RSC 快照。
  let oldBody: Buffer | null = null
  let oldHeaders: Record<string, string> = {}
  const capture = async (route: Route) => {
    if (!isRscGet(route.request())) return route.continue()
    const response = await route.fetch()
    oldBody = await response.body()
    oldHeaders = response.headers()
    return route.fulfill({ response })
  }
  await page.route('**/dashboard/teacher/grading/**', capture)
  await refocus(page, benchA)
  await page.unroute('**/dashboard/teacher/grading/**', capture)
  expect(oldBody).not.toBeNull()
  const oldTime = (await benchA.getAttribute('data-server-time'))!
  const oldStatus = (await benchA.getByTestId('save-status').innerText()).match(/第 \d+ 次/)![0]
  const before = await submissionCount()

  // B 重送 77 → A 切回前景跟上。
  await otherTabResubmit(other, '77')
  await refocus(page, benchA)
  await expect(scoreA).toHaveValue('77')
  const newTime = (await benchA.getAttribute('data-server-time'))!
  const newStatus = `第 ${before + 1} 次`
  await expect(benchA.getByTestId('save-status')).toContainText(newStatus)
  expect(newStatus).not.toBe(oldStatus)

  // 1. 重放較舊的快照（原時間戳）：版本比已接受的舊 → 整包丟掉，畫面不動、不崩。
  const replayOld = (route: Route) => (isRscGet(route.request()) ? route.fulfill({ status: 200, headers: oldHeaders, body: oldBody! }) : route.continue())
  await page.route('**/dashboard/teacher/grading/**', replayOld)
  await focusAndWaitRsc(page)
  await expect(scoreA).toHaveValue('77')
  await expect(benchA.getByTestId('save-status')).toContainText(newStatus)
  await expect(benchA).toHaveAttribute('data-server-time', newTime)
  await page.unroute('**/dashboard/teacher/grading/**', replayOld)

  // 2. 把舊快照的時間戳偽造成跟目前接受的一樣：排序鍵是資料庫寫入版本不是時間，舊版本一樣丟掉。
  const tied = oldBody!.toString().split(oldTime).join(newTime)
  expect(tied).not.toBe(oldBody!.toString())
  const replayTied = (route: Route) => (isRscGet(route.request()) ? route.fulfill({ status: 200, headers: oldHeaders, body: tied }) : route.continue())
  await page.route('**/dashboard/teacher/grading/**', replayTied)
  await focusAndWaitRsc(page)
  await expect(scoreA).toHaveValue('77')
  await expect(benchA.getByTestId('save-status')).toContainText(newStatus)
  await page.unroute('**/dashboard/teacher/grading/**', replayTied)
  expect(pageErrors).toEqual([])
  await expect(page.getByText('This page couldn’t load')).toHaveCount(0)

  // 3. 下一次正常重抓照常接受（時間戳變新），畫面仍是 77。
  await refocus(page, benchA)
  await expect(scoreA).toHaveValue('77')
  await expect(benchA.getByTestId('save-status')).toContainText(newStatus)
  expect(await submissionCount()).toBe(before + 1)
  await other.close()
})

/** 階段第一項（功能完整度）的 key：DB 裡的分數用 key 存；照評一最新一筆評分所用的方案版本查。 */
async function firstItemKey() {
  const row = await pool.query<{ stages: { key: string; items: { key: string }[] }[] }>(
    `select v.stages from grading_scheme_versions v
       join evaluations e on e.scheme_version_id = v.id
       join evaluator_assignments a on a.id = e.assignment_id
      where a.group_id = $1 and a.teacher_user_id = $2
      order by e.submitted_real_at desc limit 1`,
    [groupIds.get('G01'), t1.userId],
  )
  const stageKey = await stageKeyOfG01()
  return row.rows[0]!.stages.find((st) => st.key === stageKey)!.items[0]!.key
}
