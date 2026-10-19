import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium, expect, request as playwrightRequest, test, type Page, type Route } from '@playwright/test'
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
 * 3c. Review #584 的十三個反例（r1 ①②、r2 ①②③、r3 ①～⑤、r4 ①～③）：多分頁重送、結算後被拒存、回應中斷後同編號重試、
 *     等回應時續打、未存就被動結算；第 4 輪：重試原樣送凍結的 payload、舊收據不清未存、改用伺服器內容後是新的一次、
 *     較舊／相同時間戳的 RSC 快照整包丟掉不崩；第 5 輪（S1～S3，拿掉推論路徑）：中斷後只靠「再送一次」拿收據、不從重抓判定送達；
 *     未存只看內容；結算是單向鎖（解除後要按「重新整理」，未存內容在重載前可複製）。用 page.route 攔 Server Action 的 POST 模擬延遲
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
  const queue = page.getByRole('table', { name: '系統驗收評分清單' })
  await expect(queue).toContainText('G01')
  await expect(queue).not.toContainText('G02')

  await queue.getByRole('link', { name: '批改：G01' }).click()
  const bench = page.getByRole('region', { name: 'G01「系統驗收」評分表' })
  await bench.getByLabel('1. 功能完整度').fill('101')
  await expect(bench).toContainText('第 1 項要填 0–100 的數字')
  await bench.getByRole('button', { name: '儲存草稿' }).click()
  await expect(bench.getByRole('alert')).toContainText('修正後才能儲存草稿')
  await expect(bench.getByRole('button', { name: '送出', exact: true })).toBeDisabled()

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
  await bench.getByRole('button', { name: '送出', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '確認送出' })
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
  await expect(sent.getByRole('button', { name: '送出', exact: true })).toHaveCount(0)
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
  const card = page.getByRole('table', { name: '系統驗收評分清單' }).getByTestId('grading-entry').filter({ hasText: 'G01' })
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
  const card = page.getByRole('table', { name: '系統驗收評分清單' }).getByTestId('grading-entry').filter({ hasText: 'G01' })
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

/** S3：按唯讀區的「重新整理」整頁重載，等新頁掛好（本地 state 跟著消失）。 */
async function reloadViaButton(page: Page, bench: ReturnType<Page['getByRole']>) {
  const loaded = page.waitForEvent('load')
  await bench.getByRole('button', { name: '重新整理' }).click()
  await loaded
  return benchReady(page)
}

test('Review #584 r2 反例①：送出已寫入但回應中斷 → 切回前景同步 → 「再送一次」同一個請求編號：拿到同一張回執、次數跟 DB 一致、不會多 1', async ({ page }) => {
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

  // 切回前景：次數跟上伺服器；欄位內容跟伺服器一樣就不算未存（S2）。有沒有送到仍只看收據（S1）：畫面不說「其實已經送達」，只給「再送一次」。
  await refocus(page, bench)
  await expect(bench.getByTestId('save-status')).toContainText(`第 ${before + 1} 次`)
  await expect(bench.getByTestId('edit-status')).toHaveCount(0)
  await expect(bench.getByText('其實已經送達')).toHaveCount(0)
  await expect(bench.getByTestId('resubmit')).toHaveCount(0)

  // 「再送一次」（同一個請求編號、同 payload）：伺服器回同一張回執 → 收件章，畫面仍是第 before+1 次，DB 也沒多一筆。
  await bench.getByTestId('resend').click()
  await page.getByRole('dialog', { name: '已送出' }).getByRole('button', { name: '知道了' }).click()
  await expect(bench.getByTestId('resend')).toHaveCount(0)
  await expect(bench.getByTestId('resubmit')).toBeVisible()
  await refocus(page, bench)
  await expect(bench.getByTestId('save-status')).toContainText(`第 ${before + 1} 次`)
  await bench.getByTestId('submit-history').getByText(`送出紀錄（${before + 1} 次）`).click()
  await expect(bench.getByTestId('submit-history').getByRole('listitem')).toHaveCount(before + 1)
  expect(await submissionCount()).toBe(before + 1)
  await expect(bench.getByLabel('1. 功能完整度')).toHaveValue('74')
  await expect(bench.getByTestId('edit-status')).toHaveCount(0)
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
  // 伺服器存的就是收據確認的那一份：不是別人改的，不能出衝突區。
  await expect(bench.getByTestId('bench-conflict')).toHaveCount(0)
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

test('Review #584 r2 反例③：還沒儲存的修改＋系辦在別處結算 → 切回前景：唯讀欄顯示伺服器存的值、未存內容保留在提示區可複製；解除結算不自動解鎖（S3），按「重新整理」才能再改；結算後被拒存也一樣保留', async ({ page }) => {
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

  // 系辦解除結算 → 切回前景：S3 單向鎖——仍唯讀、Pill 仍在、未存內容仍在可複製；唯讀區有「重新整理」。
  await releaseG01Stage()
  await refocus(page, bench)
  await expect(score).toBeDisabled()
  await expect(bench.getByTestId('settled-pill')).toHaveText('已結算')
  await expect(stash).toContainText('功能完整度：83')
  await expect(stash.getByRole('button', { name: '複製未儲存的內容' })).toBeVisible()
  await expect(bench.getByRole('button', { name: '恢復未儲存的內容' })).toHaveCount(0)
  await expect(bench.getByTestId('settled-notice')).toContainText('請重新整理')

  // 按「重新整理」整頁重載：可以再改；本地的未存內容隨頁面消失（提示區已請老師先複製）。
  const reloaded = await reloadViaButton(page, bench)
  await expect(score).toBeEnabled()
  await expect(reloaded.getByTestId('settled-pill')).toHaveCount(0)
  await expect(reloaded.getByTestId('bench-stash')).toHaveCount(0)
  await expect(score).toHaveValue(storedScore)

  // 再被結算、這次是主動按「儲存草稿」被拒（r1 反例①的路徑）：同樣換回伺服器值、未存內容進提示區。
  await score.fill('83')
  await comment.fill('結算前還沒存的評語')
  await settleG01Stage()
  await reloaded.getByRole('button', { name: '儲存草稿' }).click()
  await expect(reloaded.getByRole('alert')).toContainText('已結算')
  await expect(score).toBeDisabled()
  await expect(score).toHaveValue(storedScore)
  await expect(reloaded.getByTestId('bench-stash')).toContainText('功能完整度：83')
  await expect(reloaded.getByTestId('bench-stash')).toContainText('結算前還沒存的評語')
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

test('Review #584 r3 反例①：送出 74.00 回應中斷 → 重抓（伺服器存 74，欄位原值不動、不算未存）→ 「再送一次」送的是凍結的原 payload 與同一個請求編號：拿到同一張回執、不是 REQUEST_MISMATCH、DB 不多一筆', async ({ page }) => {
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

  // 切回前景：伺服器存的是正規化後的 74；欄位裡老師打的 74.00 原值不動、正規化後相同所以不算未存（S2）。
  // 有沒有送到不從重抓判（S1）：不說「其實已經送達」，只給「再送一次」。
  await refocus(page, bench)
  await expect(bench.getByTestId('save-status')).toContainText(`第 ${before + 1} 次`)
  await expect(score).toHaveValue('74.00')
  await expect(bench.getByTestId('edit-status')).toHaveCount(0)
  await expect(bench.getByText('其實已經送達')).toHaveCount(0)

  // 再送一次：送的必須是凍結的 `{requestId, payload}`（74.00），不是從欄位重讀或正規化後的 74 → 伺服器回同一張回執。
  await bench.getByTestId('resend').click()
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

  // 「再送一次」：伺服器回 81 那一次的舊收據（版本比已知的 91 舊）→ 不能把 81 當成已存、不開收件章；老師仍可選。
  await benchA.getByTestId('resend').click()
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

test('Review #584 r3 反例④／S3：未存 83／評語 → 結算 → 解除：不自動解鎖，未存內容在重新整理前一直保留、按「不用了」才消失；重新整理後可再改，再被結算時新的未存內容另收一筆', async ({ page }) => {
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
  await expect(entries).toHaveCount(1)
  await expect(entries.nth(0)).toContainText('功能完整度：83')
  await expect(entries.nth(0)).toContainText('第一份未存的評語')

  // 解除結算、切回前景兩次：S3 仍唯讀，未存內容不會被重抓沖掉；沒有「恢復」。
  await releaseG01Stage()
  await refocus(page, bench)
  await refocus(page, bench)
  await expect(score).toBeDisabled()
  await expect(score).toHaveValue(storedScore)
  await expect(entries).toHaveCount(1)
  await expect(entries.nth(0)).toContainText('第一份未存的評語')
  await expect(bench.getByRole('button', { name: '恢復未儲存的內容' })).toHaveCount(0)

  // 按「重新整理」：可以再改；本地未存內容隨頁面消失（提示區已請老師先複製）。
  const reloaded = await reloadViaButton(page, bench)
  await expect(score).toBeEnabled()
  await expect(score).toHaveValue(storedScore)
  await expect(reloaded.getByTestId('bench-stash')).toHaveCount(0)

  // 再改 84／新評語、再被結算：新的未存內容收成一筆；按「不用了」才消失。
  await score.fill('84')
  await comment.fill('第二份未存的評語')
  await settleG01Stage()
  await refocus(page, reloaded)
  await expect(score).toBeDisabled()
  await expect(entries).toHaveCount(1)
  await expect(entries.nth(0)).toContainText('功能完整度：84')
  await expect(entries.nth(0)).toContainText('第二份未存的評語')
  await entries.nth(0).getByRole('button', { name: '不用了' }).click()
  await expect(stash).toHaveCount(0)
  await expect(score).toHaveValue(storedScore)
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

// ───────────── Review #584 第 5 輪（Sol r4）的三個反例：S1 送達只靠收據、S2 未存看內容、S3 結算單向鎖 ─────────────

test('Review #584 r4 反例①／S1：重新送出的 POST 沒到伺服器、另一分頁只存了相同內容的草稿 → 切回前景不說「其實已經送達」、正式紀錄沒增加；按「再送一次」才真的送出一次', async ({ page, context }) => {
  test.skip(skipped('r4-1'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await releaseG01Stage()
  await signIn(page, t1)
  const bench = await openBench(page)
  await expect(bench.getByTestId('resubmit')).toBeVisible()
  const before = await submissionCount()
  const other = await context.newPage()
  await other.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}`)
  const otherBench = await benchReady(other)
  const bodies = collectActionBodies(page)

  // 攔下第一個 Server Action POST 直接中斷：伺服器完全沒收到。
  let aborted = false
  const abortPost = async (route: Route) => {
    const r = route.request()
    if (!aborted && r.method() === 'POST' && r.headers()['next-action']) {
      aborted = true
      return route.abort('failed')
    }
    return route.continue()
  }
  await page.route('**/dashboard/teacher/grading/**', abortPost)
  await bench.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await expect(bench.getByRole('alert')).toContainText('連線中斷')
  expect(aborted).toBe(true)
  await page.unroute('**/dashboard/teacher/grading/**', abortPost)
  expect(await submissionCount()).toBe(before)

  // 另一分頁只「儲存草稿」，內容跟 A 送的一字不差：伺服器唯一的新寫入是一筆草稿。
  await otherBench.getByRole('button', { name: '儲存草稿', exact: true }).click()
  await expect(otherBench.getByTestId('bench-message')).toContainText('已儲存草稿')
  await refocus(page, bench)
  expect(await submissionCount()).toBe(before)
  await expect(bench.getByTestId('draft-after-final')).toBeVisible()
  await expect(bench.getByTestId('save-status')).toContainText(`第 ${before} 次`)
  // 舊版在這裡誤報「上一次重新送出其實已經送達」。
  await expect(bench.getByText('其實已經送達')).toHaveCount(0)

  // S1：只有「再送一次」；用同一個請求編號、同 payload 重送，這次才真的送到 → 收件章、正式紀錄 +1。
  await expect(bench.getByTestId('resubmit')).toHaveCount(0)
  await bench.getByTestId('resend').click()
  await expect(page.getByRole('dialog', { name: '已送出' })).toBeVisible()
  await page.getByRole('dialog', { name: '已送出' }).getByRole('button', { name: '知道了' }).click()
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toBe(bodies[0])
  await refocus(page, bench)
  expect(await submissionCount()).toBe(before + 1)
  await expect(bench.getByTestId('save-status')).toContainText(`第 ${before + 1} 次`)
  await expect(bench.getByTestId('draft-after-final')).toHaveCount(0)
  await expect(bench.getByTestId('resubmit')).toBeVisible()
  await other.close()
})

test('Review #584 r4 反例②／S2：儲存 74 成功 → 改 75 → 改回 74 → 再儲存：未存只看內容，改回去就不算未存；儲存成功後不會永遠顯示未儲存', async ({ page }) => {
  test.skip(skipped('r4-2'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await releaseG01Stage()
  await signIn(page, t1)
  const bench = await openBench(page)
  const score = bench.getByLabel('1. 功能完整度')
  const bodies = collectActionBodies(page)

  await score.fill('74')
  await bench.getByRole('button', { name: '儲存草稿', exact: true }).click()
  await expect(bench.getByTestId('bench-message')).toContainText('已儲存草稿')
  await expect(bench.getByTestId('edit-status')).toHaveCount(0)
  await refocus(page, bench)
  await score.fill('75')
  await expect(bench.getByTestId('edit-status')).toContainText('有尚未儲存的修改')
  await score.fill('74')
  // S2：內容跟最後確認的一樣就不是未存（舊版用編輯計數，這裡仍顯示未儲存）。
  await expect(bench.getByTestId('edit-status')).toHaveCount(0)

  // 再按一次儲存（新的一次、新的請求編號）：成功後乾淨，沒有「之後改的還沒存」。
  await bench.getByRole('button', { name: '儲存草稿', exact: true }).click()
  await expect.poll(() => bodies.length).toBe(2)
  await expect(bench.getByRole('button', { name: '儲存草稿', exact: true })).toBeEnabled()
  await expect(bench.getByTestId('edit-status')).toHaveCount(0)
  await expect(bench.getByText('之後改的還沒存')).toHaveCount(0)
  expect(actionArgs(bodies[1]!)[3]).not.toBe(actionArgs(bodies[0]!)[3])
  expect((await storedEvaluation('draft'))!.scores[await firstItemKey()]).toBe('74')
})

test('Review #584 r4 反例③／S3：錄一份未結算的快照 → 系辦結算、切回前景上鎖 → 重放舊快照並把讀取時間改成比結算快照更晚：仍唯讀、Pill 仍在；解除結算後也不自動解鎖，按「重新整理」才能改', async ({ page }) => {
  test.skip(skipped('r4-3'), '重現舊版紅燈時用 GRADING_E2E_SKIP 跳過')
  await releaseG01Stage()
  await signIn(page, t1)
  const bench = await openBench(page)
  const score = bench.getByLabel('1. 功能完整度')
  await expect(score).toBeEnabled()
  const pattern = '**/dashboard/teacher/grading/**'

  // 錄下一份真的、未結算的 RSC 快照（版本 V、讀取時間 T0）。
  let oldBody: Buffer | null = null
  let oldHeaders: Record<string, string> = {}
  const capture = async (route: Route) => {
    if (!isRscGet(route.request())) return route.continue()
    const response = await route.fetch()
    oldBody = await response.body()
    oldHeaders = response.headers()
    return route.fulfill({ response })
  }
  await page.route(pattern, capture)
  await refocus(page, bench)
  await page.unroute(pattern, capture)
  expect(oldBody).not.toBeNull()
  const oldTime = (await bench.getAttribute('data-server-time'))!
  const version = (await bench.getAttribute('data-version'))!

  // 系辦結算 → 切回前景：上鎖。評分列沒有新寫入，版本仍是 V。
  await settleG01Stage()
  await refocus(page, bench)
  await expect(score).toBeDisabled()
  await expect(bench.getByTestId('settled-pill')).toBeVisible()
  const freshTime = (await bench.getAttribute('data-server-time'))!
  expect(await bench.getAttribute('data-version')).toBe(version)

  // Sol r4 反例③：較早發出、較晚完成的讀取——讀到的是未結算，但 serverTime 比結算快照晚。這裡把錄下的舊快照時間改成晚 20 毫秒原樣重放
  // （只差一點點，之後真的重抓才會比它新）。快照會被接受（時間戳跟上），但唯讀不能被它解開。
  const laterTime = new Date(new Date(freshTime).getTime() + 20).toISOString()
  const replayed = oldBody!.toString().split(oldTime).join(laterTime)
  expect(replayed).not.toBe(oldBody!.toString())
  const replay = (route: Route) => (isRscGet(route.request()) ? route.fulfill({ status: 200, headers: oldHeaders, body: replayed }) : route.continue())
  await page.route(pattern, replay)
  await focusAndWaitRsc(page)
  await page.unroute(pattern, replay)
  await expect(bench).toHaveAttribute('data-server-time', laterTime)
  // 舊版在這裡解鎖、Pill 消失；S3：結算是單向鎖。
  await expect(score).toBeDisabled()
  await expect(bench.getByTestId('settled-pill')).toBeVisible()
  await expect(bench.getByRole('button', { name: '儲存草稿' })).toHaveCount(0)
  await expect(bench.getByTestId('resubmit')).toHaveCount(0)

  // 系辦真的解除結算 → 切回前景：仍鎖，唯讀區提示重新整理；按下後才可編輯。
  await releaseG01Stage()
  await refocus(page, bench)
  await expect(score).toBeDisabled()
  await expect(bench.getByTestId('settled-pill')).toBeVisible()
  await expect(bench.getByTestId('settled-notice')).toContainText('請重新整理')
  const reloaded = await reloadViaButton(page, bench)
  await expect(score).toBeEnabled()
  await expect(reloaded.getByTestId('settled-pill')).toHaveCount(0)
  await expect(reloaded.getByTestId('resubmit')).toBeVisible()
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

// ───────────── A-07（B 設計方案 §5，TE-B5）：評分頁「在頁內檢視」PDF／圖片 ─────────────

/** 一頁、印一行 Helvetica 字的最小 PDF（xref 位移照實算），人工截圖時看得到這行字。 */
function textPdf(line: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = `BT /F1 28 Tf 72 760 Td (${line}) Tj ET`
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const PREVIEW_FILES = {
  pdf: { name: '期末報告.pdf', mime: 'application/pdf', extension: 'pdf', bytes: textPdf('TE-11B test page') },
  png: {
    name: '系統架構圖.png',
    mime: 'image/png',
    extension: 'png',
    bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAD0lEQVR4nGNgME5DIJwcAIc5By0Ywt6kAAAAAElFTkSuQmCC', 'base64'),
  },
  svg: {
    name: '流程圖.svg',
    mime: 'image/svg+xml',
    extension: 'svg',
    bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>document.title="pwned"</script><rect width="10" height="10"/></svg>'),
  },
  docx: {
    name: '會議紀錄.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
    bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]),
  },
} as const

/**
 * G01 一份已發布的整組作業「期末報告」與一次正式送出（附 PDF、PNG、SVG、docx）。繳交流程是別張票的事，
 * 跟 file-download-pages.spec 的 A-06 區塊一樣直接用 owner 連線建；檔案本體寫進 app 的 `FILES_ROOT`。
 * 上傳收檔不收 SVG，「有人交了 SVG」只能這樣模擬（頁面看的是 `mime_detected`）。回傳各檔的 id。
 */
async function seedG01Attachments(filesRoot: string): Promise<Record<keyof typeof PREVIEW_FILES, string>> {
  const groupId = groupIds.get('G01')!
  const stage = await pool.query<{ id: string }>(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '期末', $2, 'system') returning id`,
    [cohortId, ymd(new Date(Date.now() - 30 * 86_400_000))],
  )
  const title = `${CODE} 期末報告`
  const item = await pool.query<{ id: string }>(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, due_at,
        title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
     values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'group', $2, 'draft', now() + interval '10 days',
             $3, 'A-07 e2e', '<p>請繳交。</p>', '{"fields":[]}'::jsonb, 'user', $4, $4)
     returning id`,
    [cohortId, stage.rows[0]!.id, title, adminId],
  )
  const itemId = item.rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, 'A-07 e2e', '<p>請繳交。</p>', $3) returning id`,
    [itemId, title, adminId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
    [itemId, adminId],
  )
  await pool.query(
    `update managed_items set status = 'published', actual_opened_at = now() - interval '1 day', current_content_version_id = $2, current_schema_version_id = $3
      where id = $1`,
    [itemId, content.rows[0]!.id, schema.rows[0]!.id],
  )
  const version = await pool.query<{ id: string }>(
    `insert into submission_versions
       (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
        received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
     values (gen_random_uuid(), $1, 'group', $2, 1, $3, '{}'::jsonb, $4, now(), now(), gen_random_uuid(), '[]'::jsonb, 1) returning id`,
    [itemId, groupId, schema.rows[0]!.id, student.userId],
  )
  const versionId = version.rows[0]!.id
  const ids = {} as Record<keyof typeof PREVIEW_FILES, string>
  for (const [field, f] of Object.entries(PREVIEW_FILES) as [keyof typeof PREVIEW_FILES, (typeof PREVIEW_FILES)[keyof typeof PREVIEW_FILES]][]) {
    const id = randomUUID()
    const storageKey = `e2e-a07/${stamp}/${id}`
    await fs.mkdir(path.join(filesRoot, path.dirname(storageKey)), { recursive: true })
    await fs.writeFile(path.join(filesRoot, storageKey), f.bytes)
    const checksum = createHash('sha256').update(f.bytes).digest('hex')
    await pool.query(
      `insert into stored_files (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared, mime_detected,
                                 extension, checksum, status, storage_key, uploaded_real_at, finalized_at)
       values ($1, $2, 'cohort', $3, 'submission', $4, $5, $6, $6, $7, $8, 'stored', $9, now(), now())`,
      [id, student.userId, cohortId, f.name, f.bytes.length, f.mime, f.extension, checksum, storageKey],
    )
    await pool.query(`insert into submission_files (submission_version_id, file_id, field_key, checksum) values ($1, $2, $3, $4)`, [
      versionId,
      id,
      field,
      checksum,
    ])
    await pool.query(`insert into file_references (id, file_id, ref_type, ref_id) values (gen_random_uuid(), $1, 'submission_version', $2)`, [id, versionId])
    ids[field] = id
  }
  // C1-04：批改頁只列「這個評分項目對應作業」的版本（沒連結不退回整組全部繳交），所以把這份作業連到 s1（系統驗收）。
  await pool.query(
    `insert into grading_stage_settings (cohort_id, stage_key, item_id, updated_by_user_id) values ($1, 's1', $2, $3)
     on conflict (cohort_id, stage_key) do update set item_id = excluded.item_id`,
    [cohortId, itemId, adminId],
  )
  return ids
}

/** 附件列按鈕／連結的無障礙名稱（圖示與 sr-only 檔名之間會多一個空白）。 */
const fileAction = (word: string, file: string) => new RegExp(`^${word}\\s*：${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

test('A-07 AC-A-16／AC-TE-11B（顯示段；C1-12 改成三欄）：左欄點 PDF → 中欄 iframe 指向 /preview、沒有 sandbox，回應 200＋inline＋SAMEORIGIN；PNG 嵌入有 sandbox 且顯示成圖片；SVG、docx 只說請下載、不嵌入', async ({ page }) => {
  const filesRoot = process.env.FILES_ROOT
  test.skip(!filesRoot, '要把檔案本體寫進 app 的 FILES_ROOT（verify 與 CI 都會設）')
  const ids = await seedG01Attachments(filesRoot!)
  await signIn(page, t1)
  // 中欄一開頁就預覽第一個能嵌入的檔案；先掛好 PDF 預覽的回應等待（不管它是預設的、還是點了才載入）。
  const pdfLoaded = page.waitForResponse((r) => r.url().endsWith(`/api/files/${ids.pdf}/preview`))
  await openBench(page)
  const picker = page.getByTestId('submission-picker')
  await expect(picker).toHaveAttribute('data-hydrated', '')
  await expect(picker).toContainText(`${CODE} 期末報告`)
  await expect(picker.getByLabel('繳交版本')).toHaveValue('1')
  const list = picker.getByRole('list', { name: '檔案' })
  const row = (name: string) => list.getByTestId('attachment').filter({ hasText: name })
  const pane = page.getByRole('region', { name: '文件預覽' })
  await expect(row(PREVIEW_FILES.pdf.name).getByRole('link', { name: fileAction('下載', PREVIEW_FILES.pdf.name) })).toHaveAttribute('href', `/api/files/${ids.pdf}`)

  // PDF：中欄 iframe 指向預覽端點、不加 sandbox（Chromium 在 sandbox 屬性下顯示不了 PDF）。
  await row(PREVIEW_FILES.pdf.name).getByRole('button', { name: PREVIEW_FILES.pdf.name }).click()
  await expect(row(PREVIEW_FILES.pdf.name).getByRole('button', { name: PREVIEW_FILES.pdf.name })).toHaveAttribute('aria-pressed', 'true')
  const pdfFrame = pane.locator('iframe')
  await expect(pdfFrame).toHaveAttribute('src', `/api/files/${ids.pdf}/preview`)
  await expect(pdfFrame).toHaveAttribute('title', PREVIEW_FILES.pdf.name)
  expect(await pdfFrame.getAttribute('sandbox')).toBeNull()
  const pdf = await pdfLoaded
  expect(pdf.status()).toBe(200)
  expect(pdf.headers()['content-type']).toBe('application/pdf')
  expect(pdf.headers()['content-disposition']).toMatch(/^inline/)
  expect(pdf.headers()['x-frame-options']).toBe('SAMEORIGIN')
  expect(pdf.headers()['content-security-policy']).toContain("frame-ancestors 'self'")

  // PNG：嵌入時加 sandbox（全部限制），照樣顯示成圖片（4×3）。
  const pngLoaded = page.waitForResponse((r) => r.url().endsWith(`/api/files/${ids.png}/preview`))
  await row(PREVIEW_FILES.png.name).getByRole('button', { name: PREVIEW_FILES.png.name }).click()
  const pngFrame = pane.locator('iframe')
  await expect(pngFrame).toHaveAttribute('src', `/api/files/${ids.png}/preview`)
  await expect(pngFrame).toHaveAttribute('sandbox', '')
  const png = await pngLoaded
  expect(png.status()).toBe(200)
  expect(png.headers()['content-disposition']).toMatch(/^inline/)
  expect(png.headers()['x-frame-options']).toBe('SAMEORIGIN')
  await expect
    .poll(async () => {
      const frame = page.frames().find((f) => f.url().endsWith(`/api/files/${ids.png}/preview`))
      return frame ? frame.evaluate(() => document.querySelector('img')?.naturalWidth ?? 0).catch(() => -2) : -1
    })
    .toBe(4)

  // SVG：是圖片但不在預覽白名單（預覽端點會 302 導下載）→ 中欄只說請下載，不嵌入、不打預覽端點。
  const svgRequests: string[] = []
  page.on('request', (r) => {
    if (r.url().includes(`/api/files/${ids.svg}`)) svgRequests.push(r.url())
  })
  await row(PREVIEW_FILES.svg.name).getByRole('button', { name: PREVIEW_FILES.svg.name }).click()
  await expect(pane).toContainText('這種檔案不能在頁內檢視，請下載')
  await expect(pane.locator('iframe')).toHaveCount(0)
  expect(svgRequests).toEqual([])

  // docx：也只說請下載；左欄有下載連結。
  await row(PREVIEW_FILES.docx.name).getByRole('button', { name: PREVIEW_FILES.docx.name }).click()
  await expect(pane.getByTestId('preview-pane')).toContainText(PREVIEW_FILES.docx.name)
  await expect(pane).toContainText('這種檔案不能在頁內檢視，請下載')
  await expect(pane.locator('iframe')).toHaveCount(0)
  await expect(row(PREVIEW_FILES.docx.name).getByRole('link', { name: fileAction('下載', PREVIEW_FILES.docx.name) })).toHaveAttribute('href', `/api/files/${ids.docx}`)

  // PDF 實際顯示是人工驗收（預設的 headless shell 沒有 PDF 檢視器）：設 A07_SCREENSHOT_DIR 時另開完整版 Chromium
  //（`channel: 'chromium'`，有內建 PDF 檢視器）以 T1 打開同一頁、點 PDF，截一張證據圖。
  const shotDir = process.env.A07_SCREENSHOT_DIR
  if (shotDir) {
    const browser = await chromium.launch({ channel: 'chromium' })
    try {
      const desktop = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 1000 } })
      await desktop.addCookies([toPlaywrightCookie(t1.cookie, BASE_URL)])
      const shot = await desktop.newPage()
      await openBench(shot)
      const shotPicker = shot.getByTestId('submission-picker')
      await expect(shotPicker).toHaveAttribute('data-hydrated', '')
      await shotPicker.getByRole('button', { name: PREVIEW_FILES.pdf.name }).click()
      await expect.poll(() => shot.frames().some((f) => f.url().startsWith('chrome-extension://'))).toBe(true)
      await shot.waitForTimeout(2_000)
      await shot.screenshot({ path: path.join(shotDir, 'a07-grading-inline-pdf.png') })
    } finally {
      await browser.close()
    }
  }
})

/** 攔下一個 Server Action 的 POST 直接中斷：伺服器完全沒收到（同 r4 反例①）。回傳解除攔截的函式。 */
async function abortNextAction(page: Page) {
  let aborted = false
  const pattern = '**/dashboard/teacher/grading/**'
  const handler = async (route: Route) => {
    const r = route.request()
    if (!aborted && r.method() === 'POST' && r.headers()['next-action']) {
      aborted = true
      return route.abort('failed')
    }
    return route.continue()
  }
  await page.route(pattern, handler)
  return async () => {
    expect(aborted).toBe(true)
    await page.unroute(pattern, handler)
  }
}

test('A-07 收尾（A-02 r5 ①③）：重新送出 86 的 POST 沒到伺服器 → 別的分頁送出 96 → 切回前景出現衝突區 → 直接按「再送一次」成功：收件章、衝突區消失、不再說有未存；「再送一次」旁註明送的是中斷當時的內容', async ({ page, context }) => {
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

  await scoreA.fill('86')
  const unroute = await abortNextAction(page)
  await benchA.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await expect(benchA.getByRole('alert')).toContainText('連線中斷')
  await unroute()
  await expect(benchA.getByTestId('resend-note')).toHaveText('送出的是中斷當時的內容')
  expect(await submissionCount()).toBe(before)

  await otherTabResubmit(other, '96')
  await refocus(page, benchA)
  await expect(benchA.getByTestId('bench-conflict')).toBeVisible()
  await expect(scoreA).toHaveValue('86')

  // 不選衝突區，直接「再送一次」：原請求沒到過伺服器 → 這次寫入、版本比 96 新 → 收據確認，衝突區不再成立。
  await benchA.getByTestId('resend').click()
  await expect(page.getByRole('dialog', { name: '已送出' })).toBeVisible()
  await page.getByRole('dialog', { name: '已送出' }).getByRole('button', { name: '知道了' }).click()
  await expect(benchA.getByTestId('bench-conflict')).toHaveCount(0)
  await expect(benchA.getByText('你這裡還有尚未儲存的修改')).toHaveCount(0)
  await expect(benchA.getByTestId('edit-status')).toHaveCount(0)
  await expect(benchA.getByTestId('resend')).toHaveCount(0)
  expect((await storedEvaluation('counted'))!.scores[key]).toBe('86')
  expect(await submissionCount()).toBe(before + 2)
  await other.close()
})

test('A-07 收尾（A-02 r5 ②）：送 87 回應中斷（伺服器已寫）→ 別的分頁送出 97 → 切回前景把欄位改成 97 → 「再送一次」拿到舊收據：訊息不說「仍未送出」、改說畫面已是伺服器的內容，衝突區消失', async ({ page, context }) => {
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

  await scoreA.fill('87')
  const held = await holdNextAction(page)
  await benchA.getByTestId('resubmit').click()
  await page.getByRole('dialog', { name: '確認重新送出' }).getByRole('button', { name: '確認送出' }).click()
  await held.received
  await otherTabResubmit(other, '97')
  held.drop()
  await expect(benchA.getByRole('alert')).toContainText('連線中斷')
  await refocus(page, benchA)
  await expect(benchA.getByTestId('bench-conflict')).toBeVisible()

  // 自己把欄位改成跟伺服器一樣：沒有未存了，但上一次（87）的結果仍不明，動作列仍只有「再送一次」。
  await scoreA.fill('97')
  await expect(benchA.getByTestId('edit-status')).toHaveCount(0)
  await benchA.getByTestId('resend').click()
  const alert = benchA.getByRole('alert')
  await expect(alert).toContainText('已被別的分頁或裝置的送出取代')
  await expect(alert).toContainText('畫面已是伺服器上的內容，沒有尚未儲存的修改')
  await expect(alert).not.toContainText('仍未送出')
  await expect(benchA.getByTestId('bench-conflict')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: '已送出' })).not.toBeVisible()
  expect((await storedEvaluation('counted'))!.scores[key]).toBe('97')
  expect(await submissionCount()).toBe(before + 2)
  await other.close()
})
