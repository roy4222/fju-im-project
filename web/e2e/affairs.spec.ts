import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 15（#226）：專題事務建立與發布。「做完的樣子」逐條走：
 *
 * 1. 管理員三步驟快速建立（類型→內容→發布），或在完整編輯器編輯正文、欄位、附件、對象、所屬階段、截止。
 * 2. 發布位置單選：公告、資源、文件繳交（個人一份或整組一份）。
 * 3. 發布前檢查擋不完整的收件；發布前可以展開看實際的組與人；發布同一筆交易建名單、排到期工作、發事件。
 * 4. 小幅修改已發布內容可以選不通知。（有人作答後收件單位鎖定：畫面上的鎖定在 personal-submit.spec 走，伺服器拒絕在 pg-submissions 整合測試。）
 * 5. 附件用共用上傳能力，誰能下載依對象決定。
 *
 * 全程用真的表單與按鈕；資料庫核對用 owner 連線直接查。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T15-${stamp}`
const PDF = Buffer.from('%PDF-1.4\n% e2e 票 15 附件\n')

type Student = TestSession & { name: string; studentNo: string }

let pool: Pool
let cohortId: string
let otherCohortId: string
const students: Student[] = []
let outsider: Student
const groupIds: string[] = []

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

/** `datetime-local` 用的臺灣時間。 */
function localMinute(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16)
}

async function newStudent(cohort: string, i: number): Promise<Student> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const session = await createTestSession(context, 'student')
  await context.dispose()
  const studentNo = `415${String(Date.now()).slice(-5)}${i}`
  const name = `事務學生${i}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [session.userId, name, studentNo, cohort, `t15-${i}-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [
    cohort,
    studentNo,
    session.userId,
  ])
  return { ...session, name, studentNo }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const now = new Date()
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e 票 15：回到真實時間')`,
    [admin.userId],
  )
  const insertCohort = async (code: string) =>
    String(
      (
        await pool.query<{ id: string }>(
          `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
           values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
          [code, ymd(new Date(now.getTime() + 300 * 86_400_000))],
        )
      ).rows[0]!.id,
    )
  cohortId = await insertCohort(CODE)
  otherCohortId = await insertCohort(`${CODE}-X`)
  const starts = [-10, 30, 90, 150].map((d) => ymd(new Date(now.getTime() + d * 86_400_000)))
  for (const [i, start] of starts.entries()) {
    await pool.query(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, ['成組期', '期中', '期末', '成果'][i], start],
    )
  }

  for (let i = 1; i <= 3; i += 1) students.push(await newStudent(cohortId, i))
  outsider = await newStudent(otherCohortId, 9)

  // 兩個已成立的組：G01（學生 1、2）、G02（學生 3）。
  for (const [code, members] of [
    ['G01', [students[0]!, students[1]!]],
    ['G02', [students[2]!]],
  ] as const) {
    const group = await pool.query<{ id: string }>(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
      [cohortId, code],
    )
    groupIds.push(group.rows[0]!.id)
    for (const m of members) {
      await pool.query(
        `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
         values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
        [group.rows[0]!.id, cohortId, m.userId],
      )
    }
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

async function itemByTitle(title: string) {
  const found = await pool.query(
    `select id, status, actual_opened_at, receiver_unit, audience_kind, body_html, current_content_version_id
       from managed_items where cohort_id = $1 and title = $2`,
    [cohortId, title],
  )
  expect(found.rows, `找不到「${title}」`).toHaveLength(1)
  return found.rows[0] as {
    id: string
    status: string
    actual_opened_at: Date | null
    receiver_unit: string
    audience_kind: string
    body_html: string
  }
}

test('學生與老師打不開專題事務工作台與編輯器', async ({ page }) => {
  await signIn(page, students[0]!)
  await page.goto('/dashboard/admin/affairs')
  await expect(page).toHaveURL(/\/403$/)
  await page.goto('/dashboard/admin/editor/new')
  await expect(page).toHaveURL(/\/403$/)
})

test('三步驟快速建立公告：附件、清理正文、發布；細調欄位進同一筆；下載依對象', async ({ page }) => {
  const title = `${CODE} 專題說明會`
  const alerts: string[] = []
  page.on('dialog', async (d) => {
    alerts.push(d.message())
    await d.dismiss()
  })

  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '專題事務', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation').getByRole('link', { name: '專題事務' })).toBeVisible()

  await page.getByRole('button', { name: '新增項目' }).click()
  const dialog = page.getByRole('dialog', { name: '新增項目' })
  await dialog.getByRole('radio', { name: /公告/ }).check()
  await dialog.getByLabel('標題').fill(title)
  await dialog.getByLabel('發布對象').selectOption('cohort_students')
  await dialog.getByRole('button', { name: '下一步' }).click()

  // 第 2 步：說明（含危險 HTML）、附件。
  await dialog.getByLabel('說明', { exact: true }).fill('<p>週五下午兩點在 LM503。</p><img src=x onerror="alert(1)"><script>alert(2)</script>')
  await dialog.locator('input[type=file]').setInputFiles({ name: '說明會簡章.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(dialog.getByRole('link', { name: '說明會簡章.pdf' })).toBeVisible()
  await dialog.getByRole('button', { name: '下一步' }).click()

  // 第 3 步：發布前檢查全過、學生看到的樣子是清理過的正文。
  await expect(dialog.getByRole('list', { name: '發布前檢查' })).toBeVisible()
  await expect(dialog.locator('[data-ok="no"]')).toHaveCount(0)
  await expect(dialog.getByRole('article', { name: '學生看到的樣子' })).toContainText('週五下午兩點在 LM503。')
  await expect(dialog.getByTestId('recipient-preview')).toContainText('通知會寫給 3 位')
  await dialog.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText(`「${title}」已發布到公告`)
  expect(alerts, '正文裡的腳本不能執行').toEqual([])

  const item = await itemByTitle(title)
  expect(item.status).toBe('published')
  expect(item.actual_opened_at).not.toBeNull()
  expect(item.body_html).toBe('<p>週五下午兩點在 LM503。</p>')

  // 細調欄位：進完整編輯器，是同一個項目 ID（PUB-02）。
  await dialog.getByRole('link', { name: '細調欄位' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/editor/${item.id}$`))
  await expect(page.getByLabel('標題', { exact: true })).toHaveValue(title)
  await expect(page.getByTestId('item-status')).toHaveText('發布中')
  expect(Number((await pool.query('select count(*) from managed_items where title = $1', [title])).rows[0].count)).toBe(1)

  // 下載依對象：本屆學生可以、別屆學生不行、沒登入不行。
  const fileId = (
    await pool.query<{ file_id: string }>('select file_id from item_attachments where item_id = $1', [item.id])
  ).rows[0]!.file_id
  const mine = await page.request.get(`/api/files/${fileId}`, { headers: { cookie: students[0]!.cookie } })
  expect(mine.status()).toBe(200)
  expect(mine.headers()['content-disposition']).toContain('attachment')
  const stranger = await page.request.get(`/api/files/${fileId}`, { headers: { cookie: outsider.cookie } })
  expect(stranger.status()).toBe(403)
  const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL })
  expect((await anonymous.get(`/api/files/${fileId}`)).status()).toBe(401)
  await anonymous.dispose()

  // 列表看得到這一筆。
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await expect(page.getByTestId('affair-row').filter({ hasText: title })).toContainText('發布中')
})

test('完整編輯器建立整組收件：空收件擋下；展開名單看到實際組員；發布建名單、排截止、發事件', async ({ page }) => {
  const title = `${CODE} 期中報告`
  const due = new Date(Date.now() + 20 * 86_400_000)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.getByLabel('標題', { exact: true }).fill(title)
  await page.getByLabel('正文').fill('請上傳期中報告 PDF。')
  await page.getByLabel('發布位置', { exact: true }).selectOption('submission')
  await page.getByRole('radio', { name: '整組一份', exact: true }).check()
  await page.getByLabel('發布對象').selectOption('groups')
  await page.getByRole('checkbox', { name: /G01/ }).check()
  await page.getByLabel('所屬階段').selectOption({ index: 2 })
  await page.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(due))

  // 還沒有任何欄位：發布前檢查擋下，文案固定（PUB-13）。
  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await expect(check.locator('[data-check="fields"]')).toContainText('新增填寫欄位或上傳要求，或改用公告／資源')
  await expect(check.getByRole('button', { name: '還缺 1 項' })).toBeDisabled()
  await check.getByRole('button', { name: '取消' }).click()

  // 加一個上傳要求就能發布（只有上傳要求、沒有填寫欄位也可以）。
  await page.getByLabel('要新增的欄位類型').selectOption('file')
  await page.getByRole('button', { name: '新增欄位' }).click()
  await page.getByRole('button', { name: '存草稿' }).click()
  await expect(page.getByRole('status')).toContainText('已存成草稿')
  const draft = await itemByTitle(title)
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/editor/${draft.id}$`))
  expect(draft.status).toBe('draft')

  await page.getByRole('button', { name: '發布', exact: true }).click()
  await expect(check.locator('[data-ok="no"]')).toHaveCount(0)
  // 名單預覽：展開看得到實際的組與組員，不只總數；沒選的 G02 不在裡面。
  const preview = check.getByTestId('recipient-preview')
  await expect(preview).toContainText('收件名單：1 組')
  await preview.locator('summary').click()
  await expect(preview).toContainText('G01')
  await expect(preview).toContainText(students[0]!.name)
  await expect(preview).toContainText(students[1]!.name)
  await expect(preview).not.toContainText('G02')
  await expect(check).toContainText('（含此分鐘，臺灣時間）')
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toContainText('收件名單 1 組')
  await expect(page.getByTestId('item-status')).toHaveText('發布中')

  const item = await itemByTitle(title)
  const roster = await pool.query(
    `select receiver_kind, receiver_id from response_rosters where item_id = $1 and eligible_to_business_at is null`,
    [item.id],
  )
  expect(roster.rows).toEqual([{ receiver_kind: 'group', receiver_id: groupIds[0] }])
  const due_work = await pool.query(`select state from due_work where kind = 'deadline_snapshot' and subject_id = $1`, [item.id])
  expect(due_work.rows).toEqual([{ state: 'pending' }])
  const event = await pool.query<{ recipients: string[] }>(
    `select recipients from domain_events where type = 'item.published' and source_id = $1`,
    [item.id],
  )
  expect([...event.rows[0]!.recipients].sort()).toEqual([students[0]!.userId, students[1]!.userId].sort())

  // 重新整理：存在資料庫裡。
  await page.reload()
  await expect(page.getByTestId('item-status')).toHaveText('發布中')
  await expect(page.getByRole('radio', { name: '整組一份', exact: true })).toBeChecked()
})

test('發布更新：小幅修改選不通知就不發事件；還沒人作答時可以切換收件單位，名單跟著重算', async ({ page }) => {
  const title = `${CODE} 期中報告`
  const item = await itemByTitle(title)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${item.id}`)
  await page.getByLabel('摘要').fill('補充：檔名請用組別代碼開頭')
  await page.getByRole('button', { name: '發布更新' }).click()
  const check = page.getByRole('dialog', { name: '發布更新前檢查' })
  await check.getByRole('checkbox', { name: /通知對象這次的修改/ }).uncheck()
  await check.getByRole('button', { name: '確認更新' }).click()
  await expect(check.getByRole('status')).toContainText('沒有發通知')
  await check.getByRole('button', { name: '繼續編輯' }).click()

  expect(Number((await pool.query('select count(*) from item_versions where item_id = $1', [item.id])).rows[0].count)).toBe(2)
  expect(
    Number((await pool.query(`select count(*) from domain_events where type = 'item.updated' and source_id = $1`, [item.id])).rows[0].count),
  ).toBe(0)
  const opened = (await itemByTitle(title)).actual_opened_at

  // 切成個人一份：名單從 1 組變成 G01 的 2 位；舊列留著、寫了結束時間。
  await page.getByRole('radio', { name: '個人一份', exact: true }).check()
  await page.getByRole('button', { name: '發布更新' }).click()
  await check.getByRole('button', { name: '確認更新' }).click()
  await expect(check.getByRole('status')).toContainText('收件名單加入 2、移出 1')

  const rows = await pool.query(
    `select receiver_kind, eligible_to_business_at is null as current from response_rosters where item_id = $1 order by receiver_kind`,
    [item.id],
  )
  expect(rows.rows).toEqual([
    { receiver_kind: 'group', current: false },
    { receiver_kind: 'user', current: true },
    { receiver_kind: 'user', current: true },
  ])
  // 實際開放時間不因為修改而重設。
  expect((await itemByTitle(title)).actual_opened_at).toEqual(opened)
})

test('截止早於開放：存草稿就被擋下，給明確的錯誤', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.getByLabel('標題', { exact: true }).fill(`${CODE} 時間錯誤`)
  await page.getByLabel('發布位置', { exact: true }).selectOption('submission')
  const later = new Date(Date.now() + 10 * 86_400_000)
  const earlier = new Date(Date.now() + 5 * 86_400_000)
  await page.getByLabel('開放時間（選填）').fill(localMinute(later))
  await page.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(earlier))
  await page.getByRole('button', { name: '存草稿' }).click()
  await expect(page.getByRole('main').getByRole('alert')).toContainText('截止時間不能早於開放時間')
  expect(Number((await pool.query('select count(*) from managed_items where title = $1', [`${CODE} 時間錯誤`])).rows[0].count)).toBe(0)
})
