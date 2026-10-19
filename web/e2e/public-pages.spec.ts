import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createItemOnPage, fillItemForm, formReady, openAdvanced } from './create-item'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 16（#227）：撤回下架、前台內容頁與行事曆。「做完的樣子」逐條走：
 *
 * 1. 管理員可撤回（沒有任何回答時）、下架、重新發布；重新發布不重設原本的開放時間。
 * 2. 訪客在前台看到已發布的公告與規則；登入者多看到資源與「登入可見」的公告；下架後打開網址會被告知下一步，不是 404。
 * 3. 學生首頁行事曆顯示屆別活動與收件截止（來源就是票 11、15 的資料，不另外維護）。
 *
 * 內容全部用真的後台表單建立與發布；活動用 owner 連線直接插（活動的建立是票 11 的範圍，已有自己的 e2e）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
/** 訪客被導到的登入頁網址（next 帶原路徑，登入後回來）。 */
const loginUrl = (path: string) => new RegExp(`/login\\?next=${encodeURIComponent(path)}$`)
const CODE = `T16-${stamp}`
const PDF = Buffer.from('%PDF-1.4\n% e2e 票 16 公開附件\n')

const PUBLIC_NEWS = `${CODE} 公開說明會`
const MEMBER_NEWS = `${CODE} 登入可見公告`
const RULE = `${CODE} 第一章 課程目的`
const RESOURCE = `${CODE} 報告範本`
const SUBMISSION = `${CODE} 期中報告`
const ACTIVITY = `${CODE} 專題說明會`
const TEACHER_ACTIVITY = `${CODE} 老師會議`

type Student = TestSession & { name: string }

let pool: Pool
let cohortId: string
let student: Student
let groupId: string
const itemIds: Record<string, string> = {}
let publicFileId: string
let due: Date

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function localMinute(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16)
}

test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const now = new Date()
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e 票 16：回到真實時間')`,
    [admin.userId],
  )
  cohortId = String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
        [CODE, ymd(new Date(now.getTime() + 300 * 86_400_000))],
      )
    ).rows[0]!.id,
  )
  for (const [i, d] of [-10, 30, 90, 150].entries()) {
    await pool.query(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, ['成組期', '期中', '期末', '成果'][i], ymd(new Date(now.getTime() + d * 86_400_000))],
    )
  }

  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const session = await createTestSession(context, 'student')
  await context.dispose()
  const studentNo = `416${String(Date.now()).slice(-6)}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, '前台學生', '前台學生', $2, $3, $4)
     on conflict (user_id) do update set student_no = excluded.student_no, cohort_id = excluded.cohort_id`,
    [session.userId, studentNo, cohortId, `t16-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [
    cohortId,
    studentNo,
    session.userId,
  ])
  student = { ...session, name: '前台學生' }
  groupId = String(
    (
      await pool.query<{ id: string }>(
        `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
         values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
        [cohortId],
      )
    ).rows[0]!.id,
  )
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
     values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
    [groupId, cohortId, student.userId],
  )

  // 屆別活動（票 11 的資料）：一個給本屆學生、一個只給老師（學生的行事曆不該出現）。
  for (const [title, audience] of [
    [ACTIVITY, 'cohort_students'],
    [TEACHER_ACTIVITY, 'teachers'],
  ] as const) {
    await pool.query(
      `insert into project_events (id, cohort_id, title, starts_at, all_day, audience_kind, status, created_by_kind, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, $3, false, $4, 'scheduled', 'system', now(), now())`,
      [cohortId, title, new Date(now.getTime() + 3 * 86_400_000), audience],
    )
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

async function asVisitor(page: Page) {
  await page.context().clearCookies()
}

async function itemByTitle(title: string) {
  const found = await pool.query<{ id: string; status: string; actual_opened_at: Date | null }>(
    'select id, status, actual_opened_at from managed_items where cohort_id = $1 and title = $2',
    [cohortId, title],
  )
  expect(found.rows, `找不到「${title}」`).toHaveLength(1)
  return found.rows[0]!
}

/** 那一類分頁的「新增」→ 一頁式共用表單（C1-06）→ 發布。正文用原始 HTML 填（要測前台淨化與排版）。 */
async function quickPublish(
  page: Page,
  options: {
    placement: RegExp
    title: string
    audience: string
    body: string
    file?: { name: string; buffer: Buffer }
    /** 勾「重要公告」逐人通知（Roy 2026-09-25）；公開與所有登入者預設不勾。 */
    important?: boolean
  },
) {
  // C1-07：各分頁的「新增」直接開那一類的表單（不再先選類型）。
  const tab = options.placement.test('專題規則')
    ? { path: 'affairs/rules', button: '新增規則' }
    : options.placement.test('資源下載')
      ? { path: 'affairs/resources', button: '新增資源' }
      : { path: 'affairs', button: '新增公告' }
  await page.goto(`/dashboard/admin/${tab.path}?cohort=${cohortId}`)
  await page.getByRole('button', { name: tab.button }).click()
  const dialog = page.getByRole('dialog', { name: tab.button })
  const form = await formReady(dialog)
  await fillItemForm(page, form, { title: options.title, audience: options.audience, html: options.body, file: options.file })
  // 「重要公告」在進階設定（公告、資源才有）：公開、所有登入者的公告預設不逐人通知；其他對象預設通知。
  await openAdvanced(form)
  const important = form.getByRole('checkbox', { name: /重要公告/ })
  if (await important.count()) {
    await expect(important.locator('xpath=..')).toContainText('勾選後將通知')
    if (options.audience === 'public' || options.audience === 'signed_in') await expect(important).not.toBeChecked()
    await important.setChecked(options.important === true)
  }
  await form.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('item-toast')).toHaveText('已發布')
  const item = await itemByTitle(options.title)
  itemIds[options.title] = item.id
  return item
}

test('管理員發布公開公告、登入可見公告、專題規則、資源與一份組別收件', async ({ page }) => {
  test.setTimeout(180_000)
  await asAdmin(page)
  await quickPublish(page, {
    placement: /公告/,
    title: PUBLIC_NEWS,
    audience: 'public',
    body: '<p>週五下午兩點在 LM503。</p><img src=x onerror="alert(1)"><script>alert(2)</script>',
    file: { name: '說明會簡章.pdf', buffer: PDF },
  })
  publicFileId = (
    await pool.query<{ file_id: string }>('select file_id from item_attachments where item_id = $1', [itemIds[PUBLIC_NEWS]])
  ).rows[0]!.file_id
  await quickPublish(page, {
    placement: /公告/,
    title: MEMBER_NEWS,
    audience: 'signed_in',
    body: '只給本系成員看的公告內容。',
    important: true,
  })
  // 重要公告逐人通知（Roy 2026-09-25）：登入可見＋重要 → 全站有效帳號各一則（背景工作投影）；
  // 沒勾重要的公開公告只留發布紀錄、不發事件。
  const announced = async (itemId: string) =>
    (
      await pool.query<{ recipients: string[] }>(
        `select recipients from domain_events where source_type = 'item' and source_id = $1 and type = 'item.announced'`,
        [itemId],
      )
    ).rows
  expect(await announced(itemIds[PUBLIC_NEWS]!)).toHaveLength(0)
  const [memberEvent] = await announced(itemIds[MEMBER_NEWS]!)
  expect(memberEvent!.recipients).toContain(student.userId)
  await expect
    .poll(
      async () =>
        Number(
          (
            await pool.query<{ n: string }>(
              `select count(*) as n from notifications where recipient_user_id = $1 and source_ref->>'id' = $2`,
              [student.userId, itemIds[MEMBER_NEWS]],
            )
          ).rows[0]!.n,
        ),
      { timeout: 30_000 },
    )
    .toBe(1)
  await quickPublish(page, {
    placement: /專題規則/,
    title: RULE,
    audience: 'public',
    // 原型 /rules 的內文：段落、編號清單、灰底註解框（<blockquote>）。
    body: '<p>專題是資管系的畢業門檻課程。</p><ol><li>整合所學</li><li>培養團隊合作</li></ol><blockquote><p>註一：依系上公告辦理。</p></blockquote>',
  })
  await quickPublish(page, {
    placement: /資源下載/,
    title: RESOURCE,
    audience: 'signed_in',
    body: '期中報告的格式範本。',
    file: { name: '報告範本.pdf', buffer: PDF },
  })

  // 組別收件（全頁共用表單，C1-06；沒有所屬階段、預設一個檔案欄）：截止在 20 天後。
  due = new Date(Date.now() + 20 * 86_400_000)
  await createItemOnPage(page, cohortId, {
    placement: 'submission',
    title: SUBMISSION,
    body: '請上傳期中報告 PDF。',
    unit: '整組一份',
    audience: 'groups',
    groups: ['G01'],
    dueAt: localMinute(due),
  })
  itemIds[SUBMISSION] = (await itemByTitle(SUBMISSION)).id
})

test('訪客：公告列表只有公開的；內容頁的正文是清理過的；公開附件可以直接下載；登入可見的要先登入', async ({ page }) => {
  const alerts: string[] = []
  page.on('dialog', async (d) => {
    alerts.push(d.message())
    await d.dismiss()
  })
  await asVisitor(page)

  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('輔仁大學資訊管理學系專題管理平台')
  await expect(page.getByRole('region', { name: '最新公告' })).toContainText(PUBLIC_NEWS)

  await page.goto(`/news?q=${encodeURIComponent(CODE)}`)
  const cards = page.getByTestId('news-card')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText(PUBLIC_NEWS)
  await expect(page.getByRole('main')).not.toContainText(MEMBER_NEWS)

  await cards.first().click()
  await expect(page).toHaveURL(new RegExp(`/news/${itemIds[PUBLIC_NEWS]}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(PUBLIC_NEWS)
  await expect(page.getByRole('article')).toContainText('週五下午兩點在 LM503。')
  expect(await page.locator('article script, article img[onerror]').count()).toBe(0)
  expect(alerts, '正文裡的腳本不能執行').toEqual([])

  // 公開附件：沒登入也拿得到（票 16 開放「公開」政策給訪客）。
  const link = page.getByRole('link', { name: '說明會簡章.pdf' })
  await expect(link).toHaveAttribute('href', `/api/files/${publicFileId}`)
  const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const download = await anonymous.get(`/api/files/${publicFileId}`)
  expect(download.status()).toBe(200)
  expect(download.headers()['content-disposition']).toContain('attachment')
  // 登入可見資源的附件：訪客一律 401。
  const resourceFile = (
    await pool.query<{ file_id: string }>('select file_id from item_attachments where item_id = $1', [itemIds[RESOURCE]])
  ).rows[0]!.file_id
  expect((await anonymous.get(`/api/files/${resourceFile}`)).status()).toBe(401)

  // 登入可見的公告（訪1）：直接導到登入頁、帶 next 回到原頁；伺服器回的是真的 3xx，回應裡沒有標題。
  const memberNewsPath = `/news/${itemIds[MEMBER_NEWS]}`
  const redirected = await anonymous.get(memberNewsPath, { maxRedirects: 0 })
  expect([302, 303, 307, 308]).toContain(redirected.status())
  expect(redirected.headers()['location']).toContain(`/login?next=${encodeURIComponent(memberNewsPath)}`)
  expect(await redirected.text()).not.toContain(MEMBER_NEWS)
  await page.goto(memberNewsPath)
  await expect(page).toHaveURL(loginUrl(memberNewsPath))
  await expect(page.locator('body')).not.toContainText(MEMBER_NEWS)

  // 規則：訪客看得到公開的規則全文與目錄。
  await page.goto('/rules')
  await expect(page.getByRole('navigation', { name: '規則目錄' })).toContainText(RULE)
  await expect(page.getByRole('region', { name: RULE })).toContainText('專題是資管系的畢業門檻課程。')
  // 照原型：編號清單是數字、註解是灰底框（消毒後標籤還在，規則頁給樣子）。
  const rule = page.getByRole('region', { name: RULE })
  await expect(rule.locator('ol > li')).toHaveCount(2)
  expect(await rule.locator('ol').evaluate((el) => getComputedStyle(el).listStyleType)).toBe('decimal')
  const note = rule.locator('blockquote')
  await expect(note).toContainText('註一：依系上公告辦理。')
  expect(await note.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  expect(await note.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('0px')

  // 檔案下載：這一頁要登入（訪1）：3xx 到登入頁，回應裡沒有資源。
  const files = await anonymous.get('/files', { maxRedirects: 0 })
  expect([302, 303, 307, 308]).toContain(files.status())
  expect(files.headers()['location']).toContain(`/login?next=${encodeURIComponent('/files')}`)
  expect(await files.text()).not.toContain(RESOURCE)
  await page.goto('/files')
  await expect(page).toHaveURL(loginUrl('/files'))
  await expect(page.locator('body')).not.toContainText(RESOURCE)
  await anonymous.dispose()

  // 不存在的公告與打錯的網址（訪2）：狀態碼仍是 404，畫面是中文的「找不到這個頁面」，有回首頁、頁首頁尾照常。
  for (const path of ['/news/00000000-0000-4000-8000-000000000000', '/this-page-does-not-exist']) {
    const missing = await page.goto(path)
    expect(missing?.status(), path).toBe(404)
    await expect(page.getByTestId('not-found')).toContainText('找不到這個頁面')
    await expect(page.getByTestId('not-found').getByRole('link', { name: '回首頁' })).toHaveAttribute('href', '/')
    await expect(page.locator('footer')).toContainText('輔仁大學資訊管理學系')
  }

  // 公告列表的訪客文案（訪3）：不再說「部分公告登入後才看得到」。
  // 正向的「目前沒有公開公告」只在全站沒有公開公告時出現，e2e 有種子公開公告，留給測試站驗收（features.json V3）。
  await page.goto('/news')
  await expect(page.getByRole('main')).not.toContainText('登入後才看得到')

  // 榮譽榜說明（訪6）：給訪客的收錄範圍，不是給設計的註記。
  await page.goto('/honors')
  await expect(page.getByRole('main')).toContainText('得獎紀錄')
  // 訪客進不了歷屆專題，說明就不放這個入口（Q47／AC-VI-36）；登入者那句由 honors-entry.spec.ts 驗。
  await expect(page.getByRole('main').getByRole('link', { name: '歷屆專題', exact: true })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('人物照不裁切')

  // 業界合作洽詢（D-1）：首頁系辦聯絡卡與頁尾各一句。
  await page.goto('/')
  await expect(page.getByRole('region', { name: '快速入口' })).toContainText('業界合作或產學洽詢，也請直接聯絡系辦。')
  await expect(page.locator('footer')).toContainText('業界合作或產學洽詢，也請直接聯絡系辦。')
})

test('待審核帳號打開檔案下載：帶到申請進度頁，不是要他再登入一次', async ({ request }) => {
  const pending = await sharedTestSession(request, null)
  const response = await request.get('/files', { headers: { cookie: pending.cookie }, maxRedirects: 0 })
  expect([302, 303, 307, 308]).toContain(response.status())
  expect(response.headers()['location']).toContain('/register/pending')
  expect(await response.text()).not.toContain(RESOURCE)
})

test('登入的學生：多看到登入可見的公告（有標示）與資源下載', async ({ page }) => {
  await signIn(page, student)
  await page.goto(`/news?q=${encodeURIComponent(CODE)}`)
  await expect(page.getByTestId('news-card')).toHaveCount(2)
  const member = page.getByTestId('news-card').filter({ hasText: MEMBER_NEWS })
  await expect(member).toContainText('登入可見')
  await member.click()
  await expect(page.getByRole('article')).toContainText('只給本系成員看的公告內容。')

  await page.goto('/files')
  const resource = page.getByTestId('resource').filter({ hasText: RESOURCE })
  await expect(resource).toBeVisible()
  const href = await resource.getByRole('link', { name: '報告範本.pdf' }).getAttribute('href')
  const download = await page.request.get(href!, { headers: { cookie: student.cookie } })
  expect(download.status()).toBe(200)

  // 手機版分類照原型直列（不是橫排 pill）。
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('navigation', { name: '檔案分類' })).toHaveCSS('flex-direction', 'column')
})

test('下架：網址顯示「已下架」與下一步（不是 404）、附件收回；重新發布恢復，實際開放時間不變', async ({ page }) => {
  const before = await itemByTitle(PUBLIC_NEWS)
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${before.id}`)
  await page.getByRole('button', { name: '下架', exact: true }).click()
  const confirmArchive = page.getByRole('dialog', { name: '下架這個項目？' })
  await confirmArchive.getByRole('button', { name: '確認下架' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('已下架')
  await expect(page.getByRole('main').getByRole('status')).toContainText('已下架')
  expect((await itemByTitle(PUBLIC_NEWS)).status).toBe('archived')

  await asVisitor(page)
  const response = await page.goto(`/news/${before.id}`)
  expect(response?.status()).toBe(200)
  await expect(page.getByTestId('gone-notice')).toContainText('這則公告已下架')
  await expect(page.getByRole('link', { name: '看其他公告' })).toHaveAttribute('href', '/news')
  await expect(page.getByRole('main')).not.toContainText(PUBLIC_NEWS)
  await page.goto(`/news?q=${encodeURIComponent(CODE)}`)
  await expect(page.getByTestId('news-card')).toHaveCount(0)
  const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL })
  expect((await anonymous.get(`/api/files/${publicFileId}`)).status()).toBe(401)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${before.id}`)
  await page.getByRole('button', { name: '重新發布', exact: true }).click()
  await page.getByRole('dialog', { name: '重新發布？' }).getByRole('button', { name: '確認重新發布' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('發布中')
  const after = await itemByTitle(PUBLIC_NEWS)
  expect(after.status).toBe('published')
  expect(after.actual_opened_at).toEqual(before.actual_opened_at)
  // 發布紀錄在進階設定最下方（C1-06）。
  const form = await formReady(page)
  await openAdvanced(form)
  await form.locator('summary', { hasText: '發布紀錄' }).click()
  await expect(form.getByRole('list', { name: '發布紀錄' })).toContainText('重新發布')
  await expect(form.getByRole('list', { name: '發布紀錄' })).toContainText('下架')

  await asVisitor(page)
  await page.goto(`/news/${before.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(PUBLIC_NEWS)
  expect((await anonymous.get(`/api/files/${publicFileId}`)).status()).toBe(200)
  await anonymous.dispose()
})

test('撤回（還沒有人作答；畫面沒有撤回鈕，資料直接改）：回到草稿，學生打開網址看到「已撤回」；再按發布恢復同一個項目', async ({ page }) => {
  const before = await itemByTitle(MEMBER_NEWS)
  await asAdmin(page)
  // C1-06 起畫面上沒有「撤回」（API 保留，`lifecycle.ts` 規則不變）：直接把資料改成撤回後的樣子（回到草稿、revision＋1、取消置頂）。
  await pool.query(`update managed_items set status = 'draft', revision = revision + 1, pinned_at = null where id = $1`, [before.id])
  await page.goto(`/dashboard/admin/editor/${before.id}`)
  await expect(page.getByTestId('item-status')).toHaveText('草稿')
  await expect(page.getByRole('button', { name: '撤回' })).toHaveCount(0)
  expect((await itemByTitle(MEMBER_NEWS)).status).toBe('draft')

  await signIn(page, student)
  await page.goto(`/news/${before.id}`)
  await expect(page.getByTestId('gone-notice')).toContainText('這則公告已撤回')
  await expect(page.getByRole('main')).not.toContainText(MEMBER_NEWS)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${before.id}`)
  await (await formReady(page)).getByRole('button', { name: '發布', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
  const after = await itemByTitle(MEMBER_NEWS)
  expect(after.status).toBe('published')
  expect(after.id).toBe(before.id)
  expect(after.actual_opened_at).toEqual(before.actual_opened_at)

  await signIn(page, student)
  await page.goto(`/news/${before.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(MEMBER_NEWS)
})

test('前台「專題時程」行事曆：屆別活動與收件截止（臺灣日期），只給老師的活動不出現', async ({ page }) => {
  await signIn(page, student)
  await page.goto('/timeline')

  // 活動（現在＋3 天）與截止（現在＋20 天）可能跨月：各自翻到那個月（讀畫面上的年月再算差），驗右欄「M 月」清單。
  const calendar = page.getByTestId('student-calendar')
  const heading = calendar.getByText(/^\d{4} 年 \d{1,2} 月$/)
  const showMonth = async (day: string) => {
    const [shownY, shownM] = ((await heading.innerText()).match(/\d+/g) ?? []).map(Number)
    const [y, m] = day.split('-').map(Number)
    const diff = (y! - shownY!) * 12 + (m! - shownM!)
    for (let i = 0; i < Math.abs(diff); i += 1) await calendar.getByRole('button', { name: diff > 0 ? '下個月' : '上個月' }).click()
    await expect(heading).toHaveText(`${y} 年 ${m} 月`)
    return calendar.getByRole('list', { name: `${m} 月`, exact: true })
  }
  const activityDay = ymd(new Date(Date.now() + 3 * 86_400_000))
  await expect(await showMonth(activityDay)).toContainText(ACTIVITY)
  // 老師活動跟 ACTIVITY 同一天：翻到那個月再驗，否則它本來就不在畫面上、否定斷言會空轉。
  await expect(page.getByRole('main')).not.toContainText(TEACHER_ACTIVITY)
  const dueDay = ymd(due)
  const month = await showMonth(dueDay)
  await expect(month.getByRole('listitem').filter({ hasText: SUBMISSION })).toContainText('截止')

  // 點截止那一天，看到這份收件的截止。
  await calendar.getByRole('button', { name: new RegExp(`^${dueDay}`) }).click()
  const day = calendar.getByRole('list', { name: '這天的行程' })
  await expect(day).toContainText(SUBMISSION)
  await expect(day).toContainText('截止')
})

test('公開首頁沒有「我的工作」：學生有要交的收件，首頁也不列（工作都在後台，C2-14）', async ({ page }) => {
  await signIn(page, student)
  await page.goto('/')
  await expect(page.getByRole('region', { name: '我的工作' })).toHaveCount(0)
  await expect(page.getByRole('main')).not.toContainText(SUBMISSION)
  await expect(page.getByTestId('home-deadlines')).toHaveCount(0)
  await expect(page.getByTestId('home-work-pending')).toHaveCount(0)
})
