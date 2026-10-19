import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { formReady, openAdvanced } from './create-item'
import { fillItemBody, rawHtml } from './item-body'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 15（#226）：專題事務建立與發布。「做完的樣子」逐條走：
 *
 * 1. C 階段規格① C1-06：新增與編輯共用一頁式表單（AC-1）：左邊由上到下「對象、開放、截止、標題、內容、附件、繳交欄位、▸ 進階設定」，
 *    右邊「即時預覽：學生看到的樣子」（伺服器淨化，AC-3），底部「儲存（先不發布）」「發布」；沒有所屬階段、沒有步驟、沒有完整編輯器連結。
 * 2. 必填當下就擋（AC-2）：blur 紅字、按「發布」頂部「還缺 N 項」並捲到第一個紅字，不跳視窗；
 *    展開名單看到實際的組與人；發布同一筆交易建名單、排到期工作、發事件。
 * 3. 拖拉表單產生器（AC-4）：原生拖曳＋上移／下移，預覽與學生「寫作業」同一個順序；有人交過結構鎖住（AC-5）。
 * 4. 發布中的項目：「儲存更新」「下架」，沒有撤回、沒有危險操作區（AC-6）；小幅修改可以不通知。
 * 5. 同意書（下載 PDF 再上傳）：預設一個不能刪的「簽好的同意書」檔案欄（AC-24 表單面）。
 * 6. 附件用共用上傳能力，誰能下載依對象決定。
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

test('AC-AD-06：公告與作業、成果展示、檔案三頁整個 main（含頂列標題）都沒有「專題事務」（SH-1-AD 換側欄後）', async ({ page }) => {
  await asAdmin(page)
  for (const path of ['/dashboard/admin/affairs', '/dashboard/admin/showcase', '/dashboard/admin/files']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: '公告與作業', exact: true })).toBeVisible()
    await expect(page.getByRole('main')).not.toContainText('專題事務')
  }
})

test('AC-1／AC-3：新增 › 公告開一頁式表單；正文即時預覽是伺服器清理過的（無 CSP 違規）；附件、發布、下載依對象', async ({ page }) => {
  const title = `${CODE} 專題說明會`
  const alerts: string[] = []
  page.on('dialog', async (d) => {
    alerts.push(d.message())
    await d.dismiss()
  })
  const csp: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text())
  })

  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '公告與作業', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '公告與作業', exact: true })).toHaveAttribute('aria-current', 'page')

  await page.getByRole('button', { name: '新增公告' }).click()
  const picker = page.getByRole('dialog', { name: '新增公告' })
  await picker.getByRole('radio', { name: /公告/ }).check()
  await picker.getByRole('button', { name: '下一步' }).click()
  const dialog = page.getByRole('dialog', { name: '新增公告' })
  const form = await formReady(dialog)

  // AC-1：一頁式；沒有所屬階段、沒有步驟指示、沒有完整編輯器連結；右邊即時預覽；底部兩顆鈕。
  await expect(form.getByLabel('所屬階段')).toHaveCount(0)
  await expect(dialog.getByRole('list', { name: '步驟' })).toHaveCount(0)
  await expect(dialog.getByRole('link', { name: '完整編輯器' })).toHaveCount(0)
  await expect(dialog.getByRole('heading', { name: '即時預覽：學生看到的樣子' })).toBeVisible()
  await expect(form.getByTestId('item-form-actions').getByRole('button')).toHaveText(['取消', '儲存（先不發布）', '發布'])

  await form.getByLabel('對象（誰看得到）').selectOption('cohort_students')
  await form.getByLabel('標題', { exact: true }).fill(title)
  // AC-3：原始 HTML 打危險內容，停手後右欄只出現清理過的正文（伺服器淨化），沒有 script、沒有 CSP 違規。
  const raw = await rawHtml(page)
  await raw.fill('<p>哈囉</p><img src=x onerror="alert(1)"><script>alert(2)</script>')
  const preview = dialog.getByTestId('live-preview')
  await expect(preview.getByTestId('body-preview')).toHaveText('哈囉')
  await expect(preview.locator('script, img')).toHaveCount(0)
  await expect(preview.getByTestId('preview-title')).toHaveText(title)
  await expect(preview.getByTestId('preview-meta')).toContainText('本屆學生')
  await form.getByLabel('加入附件').setInputFiles({ name: '說明會簡章.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(form.getByRole('list', { name: '附件' }).getByRole('link', { name: '說明會簡章.pdf' })).toBeVisible()
  await expect(preview).toContainText('說明會簡章.pdf')
  await expect(dialog.getByTestId('recipient-preview')).toContainText('若勾選「重要公告」，會通知 3 位')
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('item-toast')).toHaveText('已發布')
  expect(alerts, '正文裡的腳本不能執行').toEqual([])
  expect(csp, 'CSP 違規').toEqual([])

  const item = await itemByTitle(title)
  expect(item.status).toBe('published')
  expect(item.actual_opened_at).not.toBeNull()
  expect(item.body_html).toBe('<p>哈囉</p>')

  // 編輯頁是同一個項目 ID（PUB-02）。
  await page.goto(`/dashboard/admin/editor/${item.id}`)
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

test('AC-2：作業標題與截止留空 → blur 紅字、按「發布」頂部「還缺 2 項」不離開表單；補齊後展開名單、發布建名單、排截止、發事件', async ({ page }) => {
  const title = `${CODE} 期中報告`
  const due = new Date(Date.now() + 20 * 86_400_000)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}&placement=submission`)
  const form = await formReady(page)
  // 標題留空直接點到下一欄：當下就紅字。
  await form.getByLabel('標題', { exact: true }).click()
  await form.getByLabel('加入附件').focus()
  await expect(form.locator('[data-error="title"]')).toHaveText('請填標題')
  // 按「發布」：頂部「還缺 2 項」、捲到第一個紅字、不跳視窗、不離開表單、沒有建任何資料。
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(page.getByTestId('form-error-summary')).toContainText('還缺 2 項')
  await expect(form.locator('[data-error="dueAt"]')).toHaveText('請填截止時間')
  await expect(form.getByLabel('截止時間（臺灣時間，含這一分鐘）')).toBeInViewport()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(/\/editor\/new\?/)

  await form.getByLabel('標題', { exact: true }).fill(title)
  await fillItemBody(page, '請上傳期中報告 PDF。')
  await form.getByRole('radio', { name: '整組一份', exact: true }).check()
  await form.getByLabel('對象（誰看得到）').selectOption('groups')
  await form.getByRole('checkbox', { name: /G01/ }).check()
  await form.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(due))
  await expect(form.locator('[data-error]')).toHaveCount(0)

  // 把預設的檔案欄刪掉：還沒有任何欄位，發布擋下，文案固定（PUB-13）。
  const fields = form.locator('section[aria-labelledby="sec-fields"]')
  await fields.getByRole('button', { name: '刪除 上傳檔案' }).click()
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(page.getByTestId('form-error-summary')).toContainText('還缺 1 項：繳交欄位')
  await expect(form.locator('[data-error="fields"]')).toHaveText('新增填寫欄位或上傳要求，或改用公告／資源')

  // 加一個上傳要求就能發布（只有上傳要求、沒有填寫欄位也可以）。
  await form.getByLabel('要新增的欄位類型').selectOption('file')
  await form.getByRole('button', { name: '新增欄位' }).click()
  // 名單預覽：展開看得到實際的組與組員，不只總數；沒選的 G02 不在裡面。預覽寫截止。
  const preview = page.getByTestId('recipient-preview')
  await expect(preview).toContainText('需要繳交的名單：1 組')
  await preview.locator('summary').click()
  await expect(preview).toContainText('G01')
  await expect(preview).toContainText(students[0]!.name)
  await expect(preview).toContainText(students[1]!.name)
  await expect(preview).not.toContainText('G02')
  await expect(page.getByTestId('preview-meta')).toContainText('（含此分鐘，臺灣時間）')
  await expect(page.getByTestId('preview-meta')).toContainText('指定組別：G01')

  await form.getByRole('button', { name: '儲存（先不發布）' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已存成草稿' })).toBeVisible()
  const draft = await itemByTitle(title)
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/editor/${draft.id}$`))
  expect(draft.status).toBe('draft')

  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/affairs\\?cohort=${cohortId}&placement=all$`))
  await expect(page.getByTestId('item-toast')).toHaveText('已發布')

  const item = await itemByTitle(title)
  expect(item.status).toBe('published')
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

  // 重新打開：存在資料庫裡。
  await page.goto(`/dashboard/admin/editor/${item.id}`)
  await expect(page.getByTestId('item-status')).toHaveText('發布中')
  await expect(page.getByRole('radio', { name: '整組一份', exact: true })).toBeChecked()
})

test('從編輯頁返回列表：原本的作業還在列表上（返回連結帶 placement=all）', async ({ page }) => {
  const title = `${CODE} 期中報告`
  const item = await itemByTitle(title)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${item.id}`)
  await page.getByRole('main').getByRole('link', { name: '公告與作業', exact: true }).click()
  await expect(page).toHaveURL(/placement=all/)
  await expect(page.getByTestId('affair-row').filter({ hasText: title })).toHaveCount(1)
})

test('儲存更新：小幅修改選不通知就不發事件；還沒人作答時可以切換收件單位，名單跟著重算', async ({ page }) => {
  const title = `${CODE} 期中報告`
  const item = await itemByTitle(title)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${item.id}`)
  let form = await formReady(page)
  await openAdvanced(form)
  await form.getByLabel('摘要', { exact: false }).fill('補充：檔名請用組別代碼開頭')
  await form.getByRole('checkbox', { name: /通知對象這次的修改/ }).uncheck()
  await form.getByRole('button', { name: '儲存更新' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/affairs\\?cohort=${cohortId}&placement=all$`))
  await expect(page.getByTestId('item-toast')).toHaveText('已更新')

  expect(Number((await pool.query('select count(*) from item_versions where item_id = $1', [item.id])).rows[0].count)).toBe(2)
  expect(
    Number((await pool.query(`select count(*) from domain_events where type = 'item.updated' and source_id = $1`, [item.id])).rows[0].count),
  ).toBe(0)
  const opened = (await itemByTitle(title)).actual_opened_at

  // 切成個人一份：名單從 1 組變成 G01 的 2 位；舊列留著、寫了結束時間。
  await page.goto(`/dashboard/admin/editor/${item.id}`)
  form = await formReady(page)
  await form.getByRole('radio', { name: '個人一份', exact: true }).check()
  await form.getByRole('button', { name: '儲存更新' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/affairs\\?cohort=${cohortId}&placement=all$`))

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

test('AC-6：發布中的公告只有「儲存更新」「下架」，沒有撤回、沒有危險操作區；改標題按「儲存更新」→ 回清單、提示「已更新」', async ({ page }) => {
  const item = await itemByTitle(`${CODE} 專題說明會`)
  const renamed = `${CODE} 專題說明會（改地點）`

  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${item.id}`)
  const form = await formReady(page)
  await expect(form.getByTestId('item-form-actions').getByRole('button')).toHaveText(['下架', '儲存更新'])
  await expect(page.getByRole('button', { name: '撤回' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '危險操作' })).toHaveCount(0)
  await expect(page.getByRole('main')).not.toContainText('危險操作')
  await form.getByLabel('標題', { exact: true }).fill(renamed)
  await form.getByRole('button', { name: '儲存更新' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/affairs\\?cohort=${cohortId}&placement=all$`))
  await expect(page.getByTestId('item-toast')).toHaveText('已更新')
  await expect(page.getByTestId('affair-row').filter({ hasText: renamed })).toContainText('發布中')
})

test('AC-4：表單產生器加三欄，拖曳＋上移排成 B、C、A；預覽即時跟著變，學生「寫作業」也是 B、C、A', async ({ page }) => {
  const title = `${CODE} 欄位排序`
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}&placement=submission`)
  const form = await formReady(page)
  await form.getByLabel('對象（誰看得到）').selectOption('groups')
  await form.getByRole('checkbox', { name: /G01/ }).check()
  await form.getByRole('radio', { name: '整組一份', exact: true }).check()
  await form.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(new Date(Date.now() + 15 * 86_400_000)))
  await form.getByLabel('標題', { exact: true }).fill(title)
  await fillItemBody(page, '照順序填。')

  const fields = form.locator('section[aria-labelledby="sec-fields"]')
  await fields.getByRole('button', { name: '刪除 上傳檔案' }).click()
  for (const [type, label] of [['text', '短文字 A'], ['file', '檔案 B'], ['radio', '單選 C']] as const) {
    await form.getByLabel('要新增的欄位類型').selectOption(type)
    await form.getByRole('button', { name: '新增欄位' }).click()
    await fields.locator('li[data-field-type]').last().getByLabel(/欄位的欄名$/).fill(label)
  }
  const rows = fields.locator('li[data-field-type]')
  const order = () => rows.locator('input[id^="field-label-"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
  await expect.poll(order).toEqual(['短文字 A', '檔案 B', '單選 C'])

  // 拖柄（原生 HTML5 drag）：把 C 拖到最上面。
  await rows.nth(2).getByTestId('drag-handle').dragTo(rows.nth(0))
  await expect.poll(order).toEqual(['單選 C', '短文字 A', '檔案 B'])
  // 鍵盤：focus「上移」再按 Enter，B 往上兩格到第一。
  const up = rows.nth(2).getByRole('button', { name: '上移 檔案 B' })
  await up.focus()
  await page.keyboard.press('Enter')
  await rows.nth(1).getByRole('button', { name: '上移 檔案 B' }).click()
  await expect.poll(order).toEqual(['檔案 B', '單選 C', '短文字 A'])

  // 右欄預覽即時同順序。
  const inOrder = (text: string, labels: readonly string[]) =>
    labels.every((label, i) => text.indexOf(label) > -1 && (i === 0 || text.indexOf(labels[i - 1]!) < text.indexOf(label)))
  await expect.poll(async () => inOrder(await page.getByTestId('preview-fields').innerText(), ['檔案 B', '單選 C', '短文字 A'])).toBe(true)

  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
  const item = await itemByTitle(title)
  const schema = await pool.query<{ fields: { label: string }[] }>(`select draft_schema->'fields' as fields from managed_items where id = $1`, [item.id])
  expect(schema.rows[0]!.fields.map((f) => f.label)).toEqual(['檔案 B', '單選 C', '短文字 A'])

  // 學生「寫作業」同一個順序。
  await signIn(page, students[0]!)
  await page.goto(`/dashboard/student/affairs/${item.id}?tab=history&write=1`)
  const write = page.locator('form').filter({ has: page.getByRole('button', { name: '繳交作業' }) })
  await expect(write).toBeVisible()
  expect(inOrder(await write.innerText(), ['檔案 B', '單選 C', '短文字 A'])).toBe(true)
  // 交一份：給 AC-5 用。
  await write.locator('input[type=file]').first().setInputFiles({ name: 'B.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(page.getByText('「B.pdf」已上傳。按「繳交作業」才算交出。')).toBeVisible()
  await page.getByRole('button', { name: '繳交作業' }).click()
  await expect(page.getByTestId('receipt')).toBeVisible()
})

test('AC-5：已有一組交件的整組作業：欄位區寫「已有 1 組交過，欄位結構不能改」，型別與刪除停用、欄名仍可改；繳交方式鎖住；改欄名與說明按「儲存更新」存得起來', async ({ page }) => {
  const item = await itemByTitle(`${CODE} 欄位排序`)
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${item.id}`)
  const form = await formReady(page)
  const fields = form.locator('section[aria-labelledby="sec-fields"]')
  await expect(fields.getByTestId('fields-locked')).toHaveText('已有 1 組交過，欄位結構不能改')
  const first = fields.locator('li[data-field-type]').first()
  await expect(first.getByLabel(/欄位的型別$/)).toBeDisabled()
  await expect(first.getByRole('button', { name: /^刪除 / })).toBeDisabled()
  await expect(fields.locator('li[data-field-type]').nth(1).getByRole('button', { name: /^上移 / })).toBeDisabled()
  await expect(fields.locator('li[data-field-type]').first()).toHaveAttribute('draggable', 'false')
  await expect(first.getByLabel(/欄位的欄名$/)).toBeEnabled()
  await expect(form.getByRole('button', { name: '新增欄位' })).toHaveCount(0)
  await expect(form.getByRole('radio', { name: '整組一份', exact: true })).toBeDisabled()
  await expect(form.getByText('已經有人作答，繳交方式鎖定、不能再切換。')).toBeVisible()

  // 只改欄名與說明（不動結構）：按「儲存更新」成功回清單；重開是新欄名與說明。
  await first.getByLabel(/欄位的欄名$/).fill('期中報告 PDF')
  await first.getByRole('button', { name: '編輯欄位：期中報告 PDF' }).click()
  await first.getByLabel('說明', { exact: true }).fill('一組交一份 PDF')
  await form.getByRole('button', { name: '儲存更新' }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
  await expect(page.getByTestId('item-toast')).toHaveText('已更新')
  await page.goto(`/dashboard/admin/editor/${item.id}`)
  const reopened = (await formReady(page)).locator('section[aria-labelledby="sec-fields"]').locator('li[data-field-type]').first()
  await expect(reopened.getByLabel(/欄位的欄名$/)).toHaveValue('期中報告 PDF')
  await reopened.getByRole('button', { name: '編輯欄位：期中報告 PDF' }).click()
  await expect(reopened.getByLabel('說明', { exact: true })).toHaveValue('一組交一份 PDF')
})

test('AC-24（表單面）：新增 › 同意書（下載 PDF 再上傳）預設一個不能刪的「簽好的同意書」檔案欄；發布後學生看到形式「同意書」', async ({ page }) => {
  const title = `${CODE} 授權同意書`
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs/assignments?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增作業' }).click()
  await page.getByRole('dialog', { name: '新增作業' }).getByRole('radio', { name: /同意書（下載 PDF 再上傳）/ }).check()
  await page.getByRole('dialog', { name: '新增作業' }).getByRole('button', { name: '下一步' }).click()
  const dialog = page.getByRole('dialog', { name: '新增作業' })
  const form = await formReady(dialog)
  const fields = form.locator('section[aria-labelledby="sec-fields"]')
  const only = fields.locator('li[data-field-type]')
  await expect(only).toHaveCount(1)
  await expect(only.getByLabel(/欄位的欄名$/)).toHaveValue('簽好的同意書')
  await expect(only.getByLabel(/欄位的型別$/)).toHaveValue('file')
  await expect(only.getByRole('button', { name: '刪除 簽好的同意書' })).toBeDisabled()
  await only.getByRole('button', { name: '編輯欄位：簽好的同意書' }).click()
  for (const t of ['pdf', 'jpg', 'png']) await expect(only.getByRole('checkbox', { name: t, exact: true })).toBeChecked()
  await expect(only.getByRole('spinbutton')).toHaveValue('20')
  // 同意書是個人一份，沒有繳交方式可選。
  await expect(form.getByRole('radio', { name: '整組一份', exact: true })).toHaveCount(0)

  await form.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(new Date(Date.now() + 10 * 86_400_000)))
  await form.getByLabel('標題', { exact: true }).fill(title)
  await form.getByLabel('加入附件').setInputFiles({ name: '空白同意書.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(form.getByRole('list', { name: '附件' }).getByRole('link', { name: '空白同意書.pdf' })).toBeVisible()
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('item-toast')).toHaveText('已發布')
  const item = await itemByTitle(title)
  const mode = await pool.query(`select consent_mode, receiver_unit from managed_items where id = $1`, [item.id])
  expect(mode.rows).toEqual([{ consent_mode: 'upload', receiver_unit: 'individual' }])

  await signIn(page, students[2]!)
  await page.goto('/dashboard/student/affairs')
  await expect(page.getByTestId(`affair-${item.id}`).getByTestId('affair-form')).toContainText('同意書')
})

test('預覽連線失敗：說連線中斷，不會一直停在載入中', async ({ page }) => {
  await asAdmin(page)
  // 只擋 Server Action（即時預覽走 reviewItemAction）；頁面本身照常載入。
  await page.route('**/dashboard/admin/editor/new**', (route) =>
    route.request().method() === 'POST' && route.request().headers()['next-action'] ? route.abort('failed') : route.continue(),
  )
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await formReady(page)
  await expect(page.getByTestId('body-preview')).toContainText('預覽連線中斷；停手後會再試一次。')
})

test('截止早於開放：儲存就被擋下，給明確的錯誤，沒有建資料', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  const form = await formReady(page)
  await form.getByLabel('標題', { exact: true }).fill(`${CODE} 時間錯誤`)
  await form.getByLabel('顯示在哪一區', { exact: true }).selectOption('submission')
  const later = new Date(Date.now() + 10 * 86_400_000)
  const earlier = new Date(Date.now() + 5 * 86_400_000)
  await form.getByLabel('開放時間（選填）').fill(localMinute(later))
  await form.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(earlier))
  await form.getByRole('button', { name: '儲存（先不發布）' }).click()
  await expect(form.locator('[data-error="dueAt"]')).toHaveText('截止不能早於開放時間')
  await expect(page.getByTestId('form-error-summary')).toContainText('還缺 1 項')
  expect(Number((await pool.query('select count(*) from managed_items where title = $1', [`${CODE} 時間錯誤`])).rows[0].count)).toBe(0)
})
