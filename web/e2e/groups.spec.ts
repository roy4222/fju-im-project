import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 13（#224）：找組員、提案與成組。「做完的樣子」逐條走：
 *
 * 1. 學生打開「公開找組員」，同屆同學在名單看到姓名、學號、聯絡 Email（電話不公開）；關掉就消失。
 * 2. 學生輸入四位同學學號發起五人提案（人數照屆別設定，預設 5）；五人都被占住、收到邀請，頁面顯示到期時間。
 * 3. 五人各自確認，最後一位確認的瞬間組別成立、占用釋放、全員收到成立事件；提案人是組長。
 * 4. 拒絕、管理員作廢（理由必填）就整份終止並釋放；重新發起是新提案。
 *    （成員撤回、提案人撤回、到期由整合測試逐一證明：pg-groups.integration.test.ts。）
 * 5. 同一人同時只能在一個進行中提案、並發確認不會雙重成員：由整合測試的並發案例證明。
 * 另外：管理員在分組總覽改每組人數。
 *
 * 全程用真的表單與按鈕；重新整理後再看，確認是存進資料庫。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T13-${stamp}`
const PHONE = '0987654321'

type Student = TestSession & { name: string; studentNo: string; contactEmail: string }

let pool: Pool
let cohortId: string
const students: Student[] = []

function ymd(date: Date): string {
  // 臺灣日期（UTC+8）。
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

test.beforeAll(async () => {
  // 最多等一個 Better Auth 限速視窗（見 session.ts）。
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處），成組期＝十天前到三十天後。
  const now = new Date()
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e 票 13：回到真實時間')`,
    [admin.userId],
  )
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, 'system') returning id`,
    [CODE, `${CODE} 分組測試`, ymd(new Date(now.getTime() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id
  const starts = [-10, 30, 90, 150].map((d) => ymd(new Date(now.getTime() + d * 86_400_000)))
  for (const [i, start] of starts.entries()) {
    await pool.query(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, ['成組期', '期中', '期末', '成果'][i], start],
    )
  }

  // 五位同屆、已核准的學生。每位用一個沒有 cookie 的 request 註冊（見 timeline.spec 的說明）。
  for (let i = 1; i <= 5; i += 1) {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    const session = await createTestSession(context, 'student')
    await context.dispose()
    const studentNo = `413${String(Date.now()).slice(-5)}${i}`
    const name = `學生${i}號`
    const contactEmail = `s${i}-${stamp.toLowerCase()}@contact.example.com`
    await pool.query(
      `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
       values ($1, $2, $2, $3, $4, $5, $6)
       on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
         cohort_id = excluded.cohort_id, phone = excluded.phone, contact_email = excluded.contact_email`,
      [session.userId, name, studentNo, cohortId, PHONE, contactEmail],
    )
    await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [
      cohortId,
      studentNo,
      session.userId,
    ])
    students.push({ ...session, name, studentNo, contactEmail })
  }
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

/** 伺服器回來的回饋。限定在 `<main>`：Next 的換頁播報器也用 `role="alert"`。 */
function feedback(page: Page, role: 'status' | 'alert') {
  return page.getByRole('main').getByRole(role)
}

async function openStudentPage(page: Page, index: number) {
  await signIn(page, students[index]!)
  await page.goto('/dashboard/student/groups')
  await expect(page.getByRole('heading', { name: '我的組別', exact: true })).toBeVisible()
}

async function proposeAll(page: Page) {
  await openStudentPage(page, 0)
  for (const [i, s] of students.slice(1).entries()) {
    await page.getByLabel(`同學 ${i + 1} 的學號`).fill(s.studentNo)
  }
  await page.getByRole('button', { name: '發起提案' }).click()
  await expect(page.getByRole('region', { name: '我的組別狀態' })).toContainText('0／5 已確認')
}

async function openProposalId(): Promise<string> {
  const found = await pool.query<{ id: string }>(
    `select id from group_proposals where cohort_id = $1 and state = 'open'`,
    [cohortId],
  )
  expect(found.rows).toHaveLength(1)
  return found.rows[0]!.id
}

test('學生從側欄進「我的組別」；老師與管理員打不開學生頁、學生打不開分組總覽', async ({ page }) => {
  await openStudentPage(page, 0)
  await expect(page.getByRole('navigation').getByRole('link', { name: '我的組別' })).toBeVisible()
  await expect(page.getByText('本屆每組 5 人（含你自己）')).toBeVisible()

  await page.goto('/dashboard/admin/groups')
  await expect(page).toHaveURL(/\/403$/)
})

test('找組員：打開公開後同屆同學看到姓名、學號、聯絡 Email（沒有電話）；關掉就消失', async ({ page }) => {
  await openStudentPage(page, 1)
  await page.getByRole('button', { name: '公開找組員' }).click()
  await expect(feedback(page, 'status')).toContainText('已公開找組員')

  await openStudentPage(page, 0)
  const list = page.getByRole('region', { name: '找組員名單' })
  const row = list.getByRole('row').filter({ hasText: students[1]!.name })
  await expect(row).toContainText(students[1]!.studentNo)
  await expect(row).toContainText(students[1]!.contactEmail)
  expect(await page.content()).not.toContain(PHONE)

  await openStudentPage(page, 1)
  await page.getByRole('button', { name: '關閉公開' }).click()
  await expect(feedback(page, 'status')).toContainText('已關閉公開找組員')

  await openStudentPage(page, 0)
  await expect(page.getByRole('region', { name: '找組員名單' })).not.toContainText(students[1]!.name)
})

test('發起五人提案：五人都被占住、各有邀請；頁面顯示到期時間；被邀請的人看到同一份提案', async ({ page }) => {
  await proposeAll(page)
  const status = page.getByRole('region', { name: '我的組別狀態' })
  await expect(status).toContainText('到期時間')
  await page.reload()
  await expect(status).toContainText('0／5 已確認')

  const proposalId = await openProposalId()
  const occupied = await pool.query('select count(*)::int as n from proposal_occupancy where proposal_id = $1', [proposalId])
  expect(occupied.rows[0].n).toBe(5)
  const invited = await pool.query(
    `select cardinality(recipients) as n from domain_events where type = 'proposal.invited' and source_id = $1`,
    [proposalId],
  )
  expect(invited.rows[0].n).toBe(5)

  await openStudentPage(page, 3)
  await expect(page.getByRole('region', { name: '我的組別狀態' })).toContainText(`提案人 ${students[0]!.name}`)
  await expect(page.getByRole('button', { name: '確認加入' })).toBeVisible()
})

test('管理員作廢：理由留空被拒；填理由後終止並釋放，學生的紀錄只寫「管理員作廢」', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const open = page.getByRole('region', { name: '進行中的提案' })
  await expect(open).toContainText(students[0]!.name)

  await open.getByRole('button', { name: `作廢：${students[0]!.name}的提案` }).click()
  const dialog = page.getByRole('dialog', { name: `作廢${students[0]!.name}的提案？` })
  await dialog.getByRole('button', { name: '確定作廢' }).click()
  await expect(dialog.getByRole('alert')).toContainText('作廢一定要填理由')

  await dialog.getByLabel('理由（必填）').fill('名單有誤，請重新發起（系辦內部）')
  await dialog.getByRole('button', { name: '確定作廢' }).click()
  const closed = page.getByRole('region', { name: '最近終止的提案' })
  await expect(closed).toContainText('管理員作廢')
  await expect(closed).toContainText('名單有誤，請重新發起（系辦內部）')
  await expect(open).toContainText('沒有等待確認的提案')

  expect((await pool.query('select count(*)::int as n from proposal_occupancy o join group_proposals p on p.id = o.proposal_id where p.cohort_id = $1', [cohortId])).rows[0].n).toBe(0)

  await openStudentPage(page, 2)
  const history = page.getByRole('region', { name: '提案紀錄' })
  await expect(history).toContainText('已終止：管理員作廢')
  await expect(history).not.toContainText('系辦內部')
})

test('拒絕：整份終止、全員釋放；重新發起是新提案，所有人要重新確認', async ({ page }) => {
  await proposeAll(page)
  await openStudentPage(page, 2)
  await page.getByRole('button', { name: '拒絕' }).click()
  await page.getByRole('dialog', { name: '拒絕這份提案？' }).getByRole('button', { name: '確定拒絕' }).click()
  await expect(feedback(page, 'status')).toContainText('提案已終止（被拒絕）')
  await expect(page.getByRole('region', { name: '提案紀錄' })).toContainText('已終止：被拒絕')
  await expect(page.getByRole('button', { name: '發起提案' })).toBeVisible()
})

test('五人各自確認：1／5…4／5，最後一位確認的瞬間成立；提案人是組長；占用釋放、全員收到成立事件', async ({ page }) => {
  await proposeAll(page)
  const proposalId = await openProposalId()

  for (const [i] of students.entries()) {
    await openStudentPage(page, i)
    await page.getByRole('button', { name: '確認加入' }).click()
    if (i < students.length - 1) {
      await expect(feedback(page, 'status')).toContainText(`已確認（${i + 1}／5 已確認）`)
    } else {
      await expect(feedback(page, 'status')).toContainText('組別 G01 成立了')
    }
  }

  const status = page.getByRole('region', { name: '我的組別狀態' })
  await expect(status).toContainText('組別 G01')
  const leader = page.getByRole('list', { name: '組員' }).getByRole('listitem').filter({ hasText: '組長' })
  await expect(leader).toContainText(students[0]!.name)

  // 重新整理仍在；另一位組員看到的一樣。
  await openStudentPage(page, 2)
  await expect(page.getByRole('region', { name: '我的組別狀態' })).toContainText('組別 G01')
  await expect(page.getByRole('button', { name: '公開找組員' })).toHaveCount(0)

  const occupied = await pool.query('select count(*)::int as n from proposal_occupancy where proposal_id = $1', [proposalId])
  expect(occupied.rows[0].n).toBe(0)
  const members = await pool.query(
    `select count(*)::int as n from group_memberships where cohort_id = $1 and valid_to is null`,
    [cohortId],
  )
  expect(members.rows[0].n).toBe(5)
  const established = await pool.query(
    `select cardinality(e.recipients) as n from domain_events e
       join group_proposals p on p.established_group_id = e.source_id
      where e.type = 'group.established' and p.id = $1`,
    [proposalId],
  )
  expect(established.rows[0].n).toBe(5)
})

test('管理員：分組總覽列出這一組與組長；改每組人數後摘要跟著變', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const groups = page.getByRole('region', { name: '全部組別' })
  await expect(groups).toContainText('G01')
  await expect(groups).toContainText(`${students[0]!.name}（組長）`)
  await expect(groups).toContainText('5 人')
  await expect(page.getByTestId('grouping-settings')).toContainText('每組 5 人')

  await page.getByRole('button', { name: '分組設定' }).click()
  const dialog = page.getByRole('dialog', { name: `${CODE} 的分組設定` })
  await dialog.getByLabel('每組最少人數').fill('6')
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog.getByRole('alert')).toContainText('不能比最多人數')

  await dialog.getByLabel('每組最少人數').fill('3')
  await dialog.getByLabel('提案預設天數').fill('5')
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(feedback(page, 'status')).toContainText('每組 3–5 人')
  await page.reload()
  await expect(page.getByTestId('grouping-settings')).toContainText('每組 3–5 人・提案 5 天內')
})
