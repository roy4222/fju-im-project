import { request as playwrightRequest, expect, test, type Locator, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie } from './session'

/**
 * C3-08：系辦專題時程頁換成甘特（規格③《設計方案》§9.3、§9.4；AC-C3-31、32、33、34、35、36、40、48）。
 *
 * 一屆四段、年度結束日都設好，今天落在第 2 段；第 3 段裡放「說明會」（全天單日）與跟它重疊的「工作坊」、
 * 「面談」（非全天、沒寫結束時間）；兩份已發布、有截止的作業。日期都從今天（臺灣）往前後推，不動模擬時鐘。
 * 甘特一律切到「週」（每天 26px），拖拉的像素才好算。
 *
 * C3-13（AC-C3-38、39、47）：拖階段分界放開先跳確認框（取消回彈、確定才存），存了發 `timeline.stage_changed`，
 * 截止落在變動段裡的整組作業的有效名單組員收到通知、點進 `/timeline`。這幾個案例放在最後（會改階段日期）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const DAY = 86_400_000
const DAY_PX = 26
const CONFLICT = '剛剛有人改過這份資料，請重新整理頁面看最新的內容再改。'

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `GNT-${stamp}`

/** 臺灣日期 `YYYY-MM-DD`。 */
const ymd = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const diffDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY)
/** 畫面上的「3/8」。 */
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`
const taipei = (date: string, time = '00:00') => new Date(`${date}T${time}:00+08:00`)

const TODAY = ymd(new Date())
const STAGES = [
  { seq: 1, name: '分組', start: addDays(TODAY, -40) },
  { seq: 2, name: '題目與計畫書', start: addDays(TODAY, -10) },
  { seq: 3, name: '系統開發', start: addDays(TODAY, 20) },
  { seq: 4, name: '成果', start: addDays(TODAY, 60) },
]
const YEAR_END = addDays(TODAY, 150)
const BRIEFING = addDays(STAGES[2]!.start, 5) // 說明會（全天單日）
const INTERVIEW = addDays(STAGES[2]!.start, 15) // 面談（09:00、沒寫結束時間）

let pool: Pool
let cohortId: string
let adminId: string
const ids: Record<string, string> = {}

async function insertActivity(title: string, startsAt: Date, endsAt: Date | null, allDay: boolean, audience = 'cohort_students') {
  const row = await pool.query<{ id: string }>(
    `insert into project_events (id, cohort_id, title, starts_at, ends_at, all_day, audience_kind, created_by_kind)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'system') returning id`,
    [cohortId, title, startsAt, endsAt, allDay, audience],
  )
  return row.rows[0]!.id
}

/** 一份已發布、有截止的作業（同 admin-affairs-overdue.spec 的做法，內容版本與欄位版本都齊）。 */
async function publishedItem(title: string, dueAt: Date, stageId: string | null) {
  const fields = [{ key: 'note', type: 'text', label: '說明', required: true }]
  const item = await pool.query<{ id: string }>(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, actual_opened_at, due_at,
        title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
     values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'individual', $2, 'draft', null, now() - interval '10 days', $3,
             $4, '一句話摘要', '<p>請在截止前交。</p>', $5::jsonb, 'user', $6, $6)
     returning id`,
    [cohortId, stageId, dueAt, title, JSON.stringify({ fields }), adminId],
  )
  const itemId = item.rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前交。</p>', $3) returning id`,
    [itemId, title, adminId],
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
  return itemId
}

test.beforeAll(async ({ request }) => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  adminId = (await sharedTestSession(request, 'admin')).userId
  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
      [CODE, YEAR_END],
    )
  ).rows[0]!.id
  const stageIds: string[] = []
  for (const s of STAGES) {
    const row = await pool.query<{ id: string }>(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system') returning id`,
      [cohortId, s.seq, s.name, s.start],
    )
    stageIds.push(row.rows[0]!.id)
  }
  ids.briefing = await insertActivity('說明會', taipei(BRIEFING), taipei(addDays(BRIEFING, 1)), true)
  ids.workshop = await insertActivity('工作坊', taipei(addDays(BRIEFING, -1)), taipei(addDays(BRIEFING, 2)), true)
  ids.interview = await insertActivity('面談', taipei(INTERVIEW, '09:00'), null, false)
  ids.item1 = await publishedItem('期中進度表', taipei(addDays(TODAY, 5), '23:59'), stageIds[1]!)
  ids.item2 = await publishedItem('系統規格書', taipei(addDays(STAGES[2]!.start, 10), '23:59'), stageIds[2]!)
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page) {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

function watchCsp(page: Page) {
  return page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] }
    w.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
}
const cspViolations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)

const url = () => `/dashboard/admin/timeline?cohort=${cohortId}`

/** 開系辦時程頁、等甘特畫好、切到「週」。 */
async function openGantt(page: Page) {
  await page.goto(url())
  const gantt = page.getByTestId('gantt')
  await expect(gantt).toBeVisible()
  await gantt.getByRole('button', { name: '週', exact: true }).click()
  await expect(gantt.getByRole('button', { name: '週', exact: true })).toHaveAttribute('aria-pressed', 'true')
  return gantt
}

const bar = (scope: Page | Locator, title: string) => scope.getByRole('button', { name: new RegExp(`^${title}，`) })
const edge = (page: Page, id: string, which: 'start' | 'end') =>
  page.locator(`[data-testid="gantt-handle"][data-kind="activity-${which}"][data-id="${id}"]`)

async function eventRow(id: string) {
  const row = await pool.query<{ starts_at: Date; ends_at: Date | null; revision: number; deleted: boolean }>(
    'select starts_at, ends_at, revision, deleted_at is not null as deleted from project_events where id = $1',
    [id],
  )
  return row.rows[0]!
}

/** 從元件中央往右拖 `dx` 像素（分兩段移動，過拖拉門檻）；`during` 在放開前跑。 */
async function drag(page: Page, target: Locator, dx: number, during?: () => Promise<void>) {
  await target.scrollIntoViewIfNeeded()
  const box = (await target.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 4 })
  await page.mouse.move(x + dx, y, { steps: 4 })
  if (during) await during()
  await page.mouse.up()
}

/** 某段那一列、某一天的空白處（用那一段色塊的左緣當基準算像素）。 */
async function clickBlankDay(page: Page, seq: number, date: string) {
  const stageStart = STAGES[seq - 1]!.start
  await page.locator('.gantt-scroll').evaluate((el, s) => {
    const block = el.querySelector<HTMLElement>(`[data-testid="gantt-stage"][data-seq="${s}"]`)!
    el.scrollLeft = block.offsetLeft - 40
  }, seq)
  const block = (await page.locator(`[data-testid="gantt-stage"][data-seq="${seq}"]`).boundingBox())!
  const track = page.locator('.gantt-row').filter({ has: page.locator('.gantt-label-seq', { hasText: `第 ${seq} 段` }) }).locator('.gantt-lane-track')
  const row = (await track.boundingBox())!
  await page.mouse.click(block.x + (diffDays(stageStart, date) + 0.5) * DAY_PX, row.y + row.height - 6)
}

test('AC-C3-31／33 版面：分頁列只有「新增活動」、甘特四段色塊與把手、橫條、車道、作業截止、今天線、活動清單；SSR 沒有甘特也沒有 style=', async ({ page }) => {
  await watchCsp(page)
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 900 })

  // AC-C3-33：SSR 的 HTML 沒有甘特（ssr:false），只有同高度骨架；沒有任何 style= 屬性。
  const html = await (await page.request.get(url())).text()
  expect(html).not.toContain('gantt-bar')
  expect(html).toContain('gantt-skeleton')
  expect(html.match(/style=/g) ?? []).toHaveLength(0)

  const gantt = await openGantt(page)
  const tabs = page.getByRole('navigation', { name: '設定分頁' })
  await expect(tabs).toBeVisible()
  await expect(page.getByRole('button', { name: '新增活動' })).toHaveCount(1)
  for (const gone of ['階段日期', '還原', '編輯階段與日期', '設定階段與日期']) {
    await expect(page.getByRole('button', { name: gone, exact: true })).toHaveCount(0)
  }
  await expect(page.getByRole('region', { name: '危險操作' })).toHaveCount(0)
  await expect(page.locator('.tl-wrap')).toHaveCount(0)

  // 左欄：月份、階段、每段一列、學生截止。
  await expect(gantt.locator('.gantt-label')).toHaveText(['月份', '階段', /第 1 段/, /第 2 段/, /第 3 段/, /第 4 段/, '學生截止'])
  // 四條階段色塊（button，aria-label 含名稱與日期）、三條分界＋年度結束日把手。
  const stages = gantt.getByTestId('gantt-stage')
  await expect(stages).toHaveCount(4)
  for (const s of STAGES) {
    const block = gantt.locator(`[data-testid="gantt-stage"][data-seq="${s.seq}"]`)
    await expect(block).toHaveJSProperty('tagName', 'BUTTON')
    await expect(block).toHaveAttribute('aria-label', new RegExp(`第 ${s.seq} 階段「${s.name}」${md(s.start)}–`))
  }
  await expect(gantt.locator('[data-testid="gantt-handle"][data-kind="stage"]')).toHaveCount(3)
  await expect(gantt.locator('[data-testid="gantt-handle"][data-kind="year-end"]')).toHaveCount(1)

  // 活動橫條：button，aria-label 含名稱與日期範圍；跟「說明會」重疊的「工作坊」在不同車道。
  await expect(bar(gantt, '說明會')).toHaveAttribute('aria-label', `說明會，${md(BRIEFING)}`)
  await expect(bar(gantt, '工作坊')).toHaveAttribute('aria-label', `工作坊，${md(addDays(BRIEFING, -1))}–${md(addDays(BRIEFING, 1))}`)
  await expect(bar(gantt, '面談')).toHaveAttribute('aria-label', `面談，${md(INTERVIEW)} 09:00`)
  const lane = (l: Locator) => l.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--lane'))
  expect(await lane(bar(gantt, '說明會'))).not.toBe(await lane(bar(gantt, '工作坊')))

  // 作業截止菱形：滑過有名稱、連到①的作業頁。
  const deadlines = gantt.getByTestId('gantt-deadline')
  await expect(deadlines).toHaveCount(2)
  await expect(gantt.locator(`a[data-testid="gantt-deadline"][href="/dashboard/admin/affairs/${ids.item1}"]`)).toHaveAttribute(
    'title',
    `作業截止：期中進度表，${md(addDays(TODAY, 5))}`,
  )
  await expect(gantt.locator(`a[data-testid="gantt-deadline"][href="/dashboard/admin/affairs/${ids.item2}"]`)).toHaveCount(1)

  // 今天線；初次捲到今天前兩週（今天線在捲動區看得到的範圍裡）。
  const todayLine = gantt.getByTestId('gantt-today')
  await expect(todayLine).toHaveAttribute('aria-label', `今天 ${md(TODAY)}`)
  await page.reload()
  await expect(page.getByTestId('gantt')).toBeVisible()
  const scroller = (await page.locator('.gantt-scroll').boundingBox())!
  const line = (await page.getByTestId('gantt-today').boundingBox())!
  expect(line.x).toBeGreaterThan(scroller.x)
  expect(line.x).toBeLessThan(scroller.x + scroller.width)

  // 下方活動清單：每列日期、名稱、對象、「編輯」「刪除」；本屆階段清單仍在。
  const list = page.getByRole('region', { name: '活動清單' })
  const row = list.getByTestId('activity-row').filter({ hasText: '說明會' })
  await expect(row).toContainText(`${BRIEFING}（全天）・本屆學生`)
  await expect(row.getByRole('button', { name: '編輯：說明會' })).toBeVisible()
  await expect(row.getByRole('button', { name: '刪除：說明會' })).toBeVisible()
  await expect(page.getByRole('list', { name: '本屆階段' }).getByRole('listitem')).toHaveCount(4)

  // AC-C3-33：開右鍵選單、三個視窗，全程 CSP 違規 0。
  await bar(page, '說明會').click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await bar(page, '說明會').click()
  await page.getByRole('dialog', { name: '編輯：說明會' }).getByRole('button', { name: '先不改' }).click()
  await page.getByRole('button', { name: /^第 2 階段「[^」]+」\d/ }).click()
  await page.getByRole('dialog', { name: '編輯第 2 階段' }).getByRole('button', { name: '先不改' }).click()
  await page.getByRole('button', { name: '新增活動' }).click()
  await page.getByRole('dialog', { name: '新增活動' }).getByRole('button', { name: '先不加' }).click()
  expect(await cspViolations(page)).toEqual([])
})

test('AC-C3-32 點列的空白處新增（預填那天、全天），再用「新增活動」建非全天跨日；結束日早於開始日被擋', async ({ page }) => {
  await watchCsp(page)
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await openGantt(page)

  const day = addDays(STAGES[2]!.start, 25)
  await clickBlankDay(page, 3, day)
  const create = page.getByRole('dialog', { name: '新增活動' })
  await expect(create.getByLabel('開始日')).toHaveValue(day)
  await expect(create.getByLabel('結束日')).toHaveValue(day)
  await expect(create.getByLabel('全天')).toBeChecked()
  await expect(create.getByText('所屬階段')).toHaveCount(0)
  await create.getByLabel('活動名稱').fill('期中展')
  await create.getByLabel('結束日').fill(addDays(day, 2))
  await create.getByRole('button', { name: '建立活動' }).click()
  await expect(create).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: '已新增活動「期中展」' })).toBeVisible()
  await expect(bar(page, '期中展')).toHaveAttribute('aria-label', `期中展，${md(day)}–${md(addDays(day, 2))}`)
  const list = page.getByRole('region', { name: '活動清單' })
  await expect(list.getByTestId('activity-row').filter({ hasText: '期中展' })).toContainText(`${md(day)}–${md(addDays(day, 2))}`)
  const saved = await pool.query<{ starts_at: Date; ends_at: Date }>(
    `select starts_at, ends_at from project_events where cohort_id = $1 and title = '期中展'`,
    [cohortId],
  )
  expect(saved.rows[0]!.starts_at.toISOString()).toBe(taipei(day).toISOString())
  expect(saved.rows[0]!.ends_at.toISOString()).toBe(taipei(addDays(day, 3)).toISOString())

  // 「新增活動」：日期預填今天；非全天跨日 09:00–隔天 17:00。
  await page.getByRole('button', { name: '新增活動' }).click()
  const form = page.getByRole('dialog', { name: '新增活動' })
  await expect(form.getByLabel('開始日')).toHaveValue(TODAY)
  const start = addDays(STAGES[3]!.start, 3)
  await form.getByLabel('活動名稱').fill('實地參訪')
  await form.getByLabel('開始日').fill(start)
  await form.getByLabel('結束日').fill(addDays(start, -1))
  await form.getByLabel('開始時間').fill('09:00')
  await form.getByLabel(/^結束時間/).fill('17:00')
  await form.getByRole('button', { name: '建立活動' }).click()
  await expect(form.getByRole('alert')).toContainText('結束日不能早於開始日')
  await form.getByLabel('結束日').fill(addDays(start, 1))
  await form.getByRole('button', { name: '建立活動' }).click()
  await expect(form).toBeHidden()
  await expect(list.getByTestId('activity-row').filter({ hasText: '實地參訪' })).toContainText(
    new RegExp(`${md(start)}（.）09:00–${md(addDays(start, 1))}（.）17:00`),
  )

  // 公開的跨日活動在整段期間都列在前台首頁「近期活動」（昨天到明天，今天仍在）。
  await clickBlankDay(page, 2, addDays(TODAY, -1))
  await create.getByLabel('活動名稱').fill('系展週')
  await create.getByLabel('結束日').fill(addDays(TODAY, 1))
  await create.getByLabel('誰看得到').selectOption('public')
  await create.getByRole('button', { name: '建立活動' }).click()
  await expect(create).toHaveCount(0)
  await expect(bar(page, '系展週')).toBeVisible()
  await page.goto('/')
  await expect(page.getByTestId('home-activities-list')).toContainText('系展週')
  expect(await cspViolations(page)).toEqual([])
})

test('AC-C3-34 拖橫條整段平移：即時日期、放開就存；過期版本回彈並顯示既有錯誤句', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await openGantt(page)
  const moved = addDays(BRIEFING, 3)

  await drag(page, bar(page, '說明會'), 3 * DAY_PX, async () => {
    await expect(bar(page, '說明會').locator('.gantt-chip')).toHaveText(md(moved))
    await expect(page.getByTestId('gantt').locator('[aria-live="polite"]')).toHaveText(md(moved))
  })
  await expect(page.getByTestId('gantt').getByRole('status')).toHaveText(`已把「說明會」改到 ${md(moved)}`)
  await expect(bar(page, '說明會')).toHaveAttribute('aria-label', `說明會，${md(moved)}`)
  await expect(page.getByRole('region', { name: '活動清單' }).getByTestId('activity-row').filter({ hasText: '說明會' })).toContainText(`${moved}（全天）`)
  await expect.poll(async () => (await eventRow(ids.briefing!)).revision).toBe(2)
  const after = await eventRow(ids.briefing!)
  expect(after.starts_at.toISOString()).toBe(taipei(moved).toISOString())
  expect(after.ends_at!.toISOString()).toBe(taipei(addDays(moved, 1)).toISOString())

  // 另一個分頁改過同一筆（revision 往上加）：這邊再拖就回彈＋既有錯誤句。
  await pool.query('update project_events set revision = revision + 1 where id = $1', [ids.briefing])
  await drag(page, bar(page, '說明會'), 2 * DAY_PX)
  await expect(page.getByTestId('gantt').getByRole('alert')).toHaveText(CONFLICT)
  await expect(bar(page, '說明會')).toHaveAttribute('aria-label', `說明會，${md(moved)}`)
  expect((await eventRow(ids.briefing!)).starts_at.toISOString()).toBe(taipei(moved).toISOString())
})

test('AC-C3-35 拉兩端把手改起訖；鍵盤 →、Shift+→、Alt+→、Alt+Shift+←、Enter、Delete', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await openGantt(page)
  const status = page.getByTestId('gantt').getByRole('status')
  let start = addDays(BRIEFING, 3)
  let end = start
  const expectSaved = async () => {
    await expect(bar(page, '說明會')).toHaveAttribute('aria-label', start === end ? `說明會，${md(start)}` : `說明會，${md(start)}–${md(end)}`)
    await expect
      .poll(async () => {
        const row = await eventRow(ids.briefing!)
        return [row.starts_at.toISOString(), row.ends_at!.toISOString()]
      })
      .toEqual([taipei(start).toISOString(), taipei(addDays(end, 1)).toISOString()])
  }

  // 把手 aria-label 寫現值。
  await expect(edge(page, ids.briefing!, 'start')).toHaveAttribute('aria-label', `「說明會」開始日 ${md(start)}（左右鍵調整）`)
  await expect(edge(page, ids.briefing!, 'end')).toHaveAttribute('aria-label', `「說明會」結束日 ${md(end)}（左右鍵調整）`)

  // 右端往右 2 天：結束日 +2、開始日不變。
  await drag(page, edge(page, ids.briefing!, 'end'), 2 * DAY_PX)
  end = addDays(end, 2)
  await expectSaved()
  // 左端往左 1 天：開始日 −1、結束日不變。
  await drag(page, edge(page, ids.briefing!, 'start'), -DAY_PX)
  start = addDays(start, -1)
  await expectSaved()
  await expect(edge(page, ids.briefing!, 'end')).toHaveAttribute('aria-label', `「說明會」結束日 ${md(end)}（左右鍵調整）`)

  // 鍵盤：每次放開鍵就存，status 一次。
  const steps: [string, number, number][] = [
    ['ArrowRight', 1, 1],
    ['Shift+ArrowRight', 7, 7],
    ['Alt+ArrowRight', 0, 1],
    ['Alt+Shift+ArrowLeft', -1, 0],
  ]
  for (const [key, ds, de] of steps) {
    await bar(page, '說明會').focus()
    await page.keyboard.press(key)
    start = addDays(start, ds)
    end = addDays(end, de)
    await expect(status).toHaveText(`已把「說明會」改到 ${md(start)}–${md(end)}`)
    await expectSaved()
  }

  // Enter 開編輯視窗；Delete 開刪除確認。
  await bar(page, '說明會').focus()
  await page.keyboard.press('Enter')
  const edit = page.getByRole('dialog', { name: '編輯：說明會' })
  await expect(edit.getByLabel('開始日')).toHaveValue(start)
  await edit.getByRole('button', { name: '先不改' }).click()
  await bar(page, '說明會').focus()
  await page.keyboard.press('Delete')
  const confirm = page.getByRole('dialog', { name: '刪除「說明會」' })
  await expect(confirm).toContainText('確定刪除『說明會』？學生的時程上會直接消失。')
  await confirm.getByRole('button', { name: '取消' }).click()
  expect((await eventRow(ids.briefing!)).deleted).toBe(false)
})

test('AC-C3-36 右鍵、長按 700ms、Shift+F10 開自製選單；Esc 關閉焦點回橫條；選「刪除」開確認框', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await openGantt(page)
  const target = bar(page, '工作坊')
  await target.scrollIntoViewIfNeeded()

  // 瀏覽器原生選單被擋（contextmenu 被 preventDefault）。
  expect(
    await target.evaluate((el) => !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }))),
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  const box = (await target.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['編輯', '刪除'])
  const at = (await menu.boundingBox())!
  expect(Math.abs(at.x - (box.x + box.width / 2))).toBeLessThan(40)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(target).toBeFocused()

  // 長按 700ms。
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(700)
  await expect(menu).toBeVisible()
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Shift+F10；選「刪除」→ 確認框。
  await target.focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: '刪除' }).click()
  const confirm = page.getByRole('dialog', { name: '刪除「工作坊」' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '取消' }).click()
})

test('AC-C3-48 沒寫結束時間的活動：整段平移成功；拉成跨日不送出、開編輯視窗補結束時間', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await openGantt(page)

  // (d) 整段平移 2 天：開始 09:00 不變、ends_at 仍 NULL、revision +1。
  const day = addDays(INTERVIEW, 2)
  await drag(page, bar(page, '面談'), 2 * DAY_PX)
  await expect(page.getByTestId('gantt').getByRole('status')).toHaveText(`已把「面談」改到 ${md(day)}`)
  await expect.poll(async () => (await eventRow(ids.interview!)).revision).toBe(2)
  let row = await eventRow(ids.interview!)
  expect(row.starts_at.toISOString()).toBe(taipei(day, '09:00').toISOString())
  expect(row.ends_at).toBeNull()

  // (b) 拉右端到隔天放開：不送出、回彈，開「編輯：面談」，起訖已預填、結束時間標必填；「先不改」資料不變。
  await drag(page, edge(page, ids.interview!, 'end'), DAY_PX)
  const edit = page.getByRole('dialog', { name: '編輯：面談' })
  await expect(edit.getByLabel('開始日')).toHaveValue(day)
  await expect(edit.getByLabel('結束日')).toHaveValue(addDays(day, 1))
  await expect(edit.getByLabel(/^結束時間/)).toHaveAttribute('aria-required', 'true')
  await expect(bar(page, '面談')).toHaveAttribute('aria-label', `面談，${md(day)} 09:00`)
  await edit.getByRole('button', { name: '先不改' }).click()
  await expect(edit).toHaveCount(0)
  row = await eventRow(ids.interview!)
  expect(row.revision).toBe(2)
  expect(row.ends_at).toBeNull()

  // 再拉一次、填結束時間 17:00、儲存：ends_at＝隔天 17:00、revision 3、橫條跨兩天。
  await drag(page, edge(page, ids.interview!, 'end'), DAY_PX)
  await edit.getByLabel(/^結束時間/).fill('17:00')
  await edit.getByRole('button', { name: '儲存' }).click()
  await expect(edit).toHaveCount(0)
  await expect(bar(page, '面談')).toHaveAttribute('aria-label', `面談，${md(day)}–${md(addDays(day, 1))} 09:00–17:00`)
  row = await eventRow(ids.interview!)
  expect(row.revision).toBe(3)
  expect(row.ends_at!.toISOString()).toBe(taipei(addDays(day, 1), '17:00').toISOString())

  // (a) 新增：非全天跨日、結束時間空白被擋；改成單日留空可以建立，ends_at NULL。
  await page.getByRole('button', { name: '新增活動' }).click()
  const create = page.getByRole('dialog', { name: '新增活動' })
  const start = addDays(STAGES[3]!.start, 10)
  await create.getByLabel('活動名稱').fill('口試')
  await create.getByLabel('開始日').fill(start)
  await create.getByLabel('結束日').fill(addDays(start, 1))
  await create.getByLabel('開始時間').fill('09:00')
  await create.getByRole('button', { name: '建立活動' }).click()
  await expect(create.getByRole('alert')).toContainText('跨日的活動要填結束時間')
  expect((await pool.query(`select 1 from project_events where cohort_id = $1 and title = '口試'`, [cohortId])).rowCount).toBe(0)
  await create.getByLabel('結束日').fill(start)
  await create.getByRole('button', { name: '建立活動' }).click()
  await expect(create).toBeHidden()
  const created = await pool.query<{ ends_at: Date | null }>(`select ends_at from project_events where cohort_id = $1 and title = '口試'`, [cohortId])
  expect(created.rows).toEqual([{ ends_at: null }])
})

test('AC-C3-40 手機（390 寬）：甘特載入但沒有把手、橫條 aria-disabled；點橫條開編輯；清單「編輯」「刪除」仍在；色塊開「編輯第 n 階段」', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  try {
    await watchCsp(page)
    await signIn(page)
    await page.goto(url())
    const gantt = page.getByTestId('gantt')
    await expect(gantt).toBeVisible()
    await expect(gantt.getByTestId('gantt-handle')).toHaveCount(0)
    const target = bar(gantt, '工作坊')
    await expect(target).toHaveAttribute('aria-disabled', 'true')
    // Playwright 的 click() 把 aria-disabled 當成不可點（gantt README）：直接送 click 事件。
    await target.dispatchEvent('click')
    const edit = page.getByRole('dialog', { name: '編輯：工作坊' })
    await expect(edit).toBeVisible()
    await edit.getByRole('button', { name: '先不改' }).click()
    const row = page.getByRole('region', { name: '活動清單' }).getByTestId('activity-row').filter({ hasText: '工作坊' })
    await expect(row.getByRole('button', { name: '編輯：工作坊' })).toBeVisible()
    await expect(row.getByRole('button', { name: '刪除：工作坊' })).toBeVisible()
    await gantt.locator('[data-testid="gantt-stage"][data-seq="3"]').dispatchEvent('click')
    const stage = page.getByRole('dialog', { name: '編輯第 3 階段' })
    await expect(stage.getByLabel('第 3 階段開始日')).toHaveValue(STAGES[2]!.start)
    await stage.getByRole('button', { name: '先不改' }).click()
    expect(await cspViolations(page)).toEqual([])
  } finally {
    await context.close()
  }
})

// ── C3-13：階段分界的確認框與通知（AC-C3-38、39、47） ──────────────────────────────

const stageHandle = (page: Page, seq: number) => page.locator(`[data-testid="gantt-handle"][data-kind="stage"][data-seq="${seq}"]`)
const confirmBox = (page: Page) => page.getByRole('dialog', { name: '調整階段日期' })
const NEW_S2 = addDays(STAGES[1]!.start, -7)
const NEW_S4 = addDays(STAGES[3]!.start, -7)

type Person = { id: string; cookie: string }
const people: Record<string, Person[]> = {}
const groupIds: Record<string, string> = {}
let groupItemId: string
let g03ItemId: string

/** 新學生（各自的 request context 註冊，Better Auth 才不會當成跨站），掛在這一屆。 */
async function newStudent(): Promise<Person> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  try {
    const session = await createTestSession(context, 'student')
    const no = `4${Date.now().toString().slice(-8)}`
    await pool.query(
      `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
       values ($1, 'e2e 學生', 'e2e 學生', $2, $3, $4)`,
      [session.userId, no, cohortId, session.email],
    )
    await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, no, session.userId])
    return { id: session.userId, cookie: session.cookie }
  } finally {
    await context.dispose()
  }
}

async function newGroup(code: string, size: number): Promise<void> {
  const g = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortId, `${code}-${stamp}`],
  )
  groupIds[code] = g.rows[0]!.id
  people[code] = []
  for (let i = 0; i < size; i += 1) {
    const p = await newStudent()
    await pool.query(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [groupIds[code], cohortId, p.id],
    )
    people[code]!.push(p)
  }
}

/** 已發布的收件，名單直接種（整組：組 id；個人：學生 id）。 */
async function rosterItem(title: string, dueAt: Date, unit: 'group' | 'individual', receivers: string[]) {
  const id = await publishedItem(title, dueAt, null)
  await pool.query(`update managed_items set receiver_unit = $2 where id = $1`, [id, unit])
  for (const receiver of receivers) {
    await pool.query(
      `insert into response_rosters (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, now() - interval '10 days', 'auto', 'system')`,
      [id, cohortId, unit === 'group' ? 'group' : 'user', receiver],
    )
  }
  return id
}

async function stageEvents() {
  const rows = await pool.query<{ recipients: string[]; recipient_basis: { groupIds: string[] }; payload: { title: string; changedStages: number[] }; source_type: string; source_id: string }>(
    `select recipients, recipient_basis, payload, source_type, source_id from domain_events
      where type = 'timeline.stage_changed' and cohort_id = $1 order by occurred_real_at`,
    [cohortId],
  )
  return rows.rows
}

async function noteCount(userId: string) {
  const row = await pool.query<{ n: string }>(
    `select count(*) as n from notifications where recipient_user_id = $1 and source_ref->>'type' = 'timeline'`,
    [userId],
  )
  return Number(row.rows[0]!.n)
}

const ids_ = (list: Person[]) => list.map((p) => p.id).sort()

test('AC-C3-38 拖第 1／2 段分界：放開不直接存、確認框句子；取消回彈；確定才存（期限版本、revision、稽核）；超過邊界夾到第 1 段開始日 +1 天', async ({ page }) => {
  test.setTimeout(120_000)
  await newGroup('G01', 2)
  await newGroup('G02', 1)
  people.X = [await newStudent()]
  // 第 2 段裡一個整組作業，有效名單只有 G01。
  groupItemId = await rosterItem('整組計畫書', taipei(addDays(TODAY, 3), '23:59'), 'group', [groupIds.G01!])

  await watchCsp(page)
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await openGantt(page)
  const before = await pool.query<{ revision: number }>('select revision from cohorts where id = $1', [cohortId])
  const revision = before.rows[0]!.revision
  const handle = stageHandle(page, 2)
  await expect(handle).toHaveAttribute('aria-label', new RegExp(` ${md(STAGES[1]!.start)}（`))

  const message = `第 2 階段『題目與計畫書』開始日 ${md(STAGES[1]!.start)} → ${md(NEW_S2)}（第 1 階段跟著變短）。有 1 個整組作業在這兩段裡，會重新提醒相關的組。`
  // 放開：不直接存，跳確認框。
  await drag(page, handle, -7 * DAY_PX)
  await expect(confirmBox(page)).toBeVisible()
  await expect(confirmBox(page)).toContainText(message)
  expect((await pool.query('select revision from cohorts where id = $1', [cohortId])).rows[0]!.revision).toBe(revision)
  // 取消：把手回彈、資料不變、沒有錯誤句。
  await confirmBox(page).getByRole('button', { name: '取消' }).click()
  await expect(confirmBox(page)).toHaveCount(0)
  await expect(handle).toHaveAttribute('aria-label', new RegExp(` ${md(STAGES[1]!.start)}（`))
  await expect(page.getByTestId('gantt').getByRole('alert')).toHaveCount(0)
  expect((await pool.query('select revision from cohorts where id = $1', [cohortId])).rows[0]!.revision).toBe(revision)
  expect(await stageEvents()).toEqual([])

  // 再拖一次、確定：存了。
  await drag(page, handle, -7 * DAY_PX)
  await expect(confirmBox(page)).toContainText(message)
  await confirmBox(page).getByRole('button', { name: '確定' }).click()
  await expect(confirmBox(page)).toHaveCount(0)
  await expect(page.getByTestId('gantt').getByRole('status').filter({ hasText: '的階段與日期' })).toContainText(new RegExp(`已儲存.*（${CODE}）的階段與日期`))
  await expect(handle).toHaveAttribute('aria-label', new RegExp(` ${md(NEW_S2)}（`))
  const stages = await pool.query<{ seq: number; start: string; deadline_version: number }>(
    `select seq, to_char(start_date, 'YYYY-MM-DD') as start, deadline_version from cohort_stages where cohort_id = $1 order by seq`,
    [cohortId],
  )
  expect(stages.rows.map((r) => [r.seq, r.start, r.deadline_version])).toEqual([
    [1, STAGES[0]!.start, 2],
    [2, NEW_S2, 2],
    [3, STAGES[2]!.start, 1],
    [4, STAGES[3]!.start, 1],
  ])
  expect((await pool.query('select revision from cohorts where id = $1', [cohortId])).rows[0]!.revision).toBe(revision + 1)
  expect(
    Number((await pool.query(`select count(*) as n from audit_events where action = 'cohort.save_schedule' and target_id = $1`, [cohortId])).rows[0]!.n),
  ).toBe(1)

  // 超過第 1 段開始日：夾到第 1 段開始日 +1 天（嚴格遞增）；這次取消。往左拖一千多像素會出畫面，改用把手鍵盤（Shift+← 一週、Enter 送出）。
  await page.reload()
  await openGantt(page)
  await stageHandle(page, 2).focus()
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Enter')
  await expect(confirmBox(page)).toContainText(`開始日 ${md(NEW_S2)} → ${md(addDays(STAGES[0]!.start, 1))}（第 1 階段跟著變短）`)
  await confirmBox(page).getByRole('button', { name: '取消' }).click()
  await expect(stageHandle(page, 2)).toHaveAttribute('aria-label', new RegExp(` ${md(NEW_S2)}（`))
  expect(await cspViolations(page)).toEqual([])
})

test('AC-C3-39 只有 G01 的現任組員收到；G02、未分組、老師沒有；收件匣標題、點進 /timeline；只改名稱不發', async ({ page }) => {
  test.setTimeout(120_000)
  const events = await stageEvents()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    source_type: 'timeline',
    source_id: cohortId,
    recipient_basis: { groupIds: [groupIds.G01] },
    payload: { changedStages: [1, 2] },
  })
  expect([...events[0]!.recipients].sort()).toEqual(ids_(people.G01!))
  const title = `專題時程更新：第 2 階段『題目與計畫書』改為 ${md(NEW_S2)}–${md(addDays(STAGES[2]!.start, -1))}`
  expect(events[0]!.payload.title).toBe(title)

  // worker 投影：G01 每人一則；其他人 0。
  await expect.poll(async () => Promise.all(people.G01!.map((p) => noteCount(p.id))), { timeout: 30_000 }).toEqual([1, 1])
  for (const p of [...people.G02!, ...people.X!]) expect(await noteCount(p.id)).toBe(0)
  expect(await noteCount(adminId)).toBe(0)
  const teacher = await sharedTestSession(page.request, 'teacher')
  expect(await noteCount(teacher.userId)).toBe(0)

  // G01 學生的收件匣：標題、來源可點、連到 /timeline（不是「無法存取」）。
  await page.context().addCookies([toPlaywrightCookie(people.G01![0]!.cookie, BASE_URL)])
  await page.goto('/dashboard/student/inbox')
  const item = page.getByTestId('inbox-item').filter({ hasText: title })
  await expect(item).toHaveCount(1)
  await expect(item).not.toContainText('無法存取')
  await item.getByRole('button', { name: title }).click()
  await expect(page).toHaveURL(/\/timeline(\?|$)/)

  // 只改第 2 段名稱（點色塊開「編輯第 2 階段」）：存了，但不發事件。
  await page.context().clearCookies()
  await signIn(page)
  await openGantt(page)
  await page.getByTestId('gantt').locator('[data-testid="gantt-stage"][data-seq="2"]').click()
  const dialog = page.getByRole('dialog', { name: '編輯第 2 階段' })
  await dialog.getByLabel('第 2 階段名稱').fill('題目與計畫')
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await pool.query(`select name from cohort_stages where cohort_id = $1 and seq = 2`, [cohortId])).rows[0]!.name).toBe('題目與計畫')
  expect(await stageEvents()).toHaveLength(1)
})

test('AC-C3-47 個人作業、別組的整組作業都不算：拖第 3／4 段分界，只有 G03 的現任組員收到', async ({ page }) => {
  test.setTimeout(120_000)
  await newGroup('G03', 2)
  // 第 3 段裡：個人作業（名單含 G01、G02 全部學生）、整組作業但有效名單只有 G03。
  await rosterItem('個人心得', taipei(addDays(TODAY, 30), '23:59'), 'individual', [...ids_(people.G01!), ...ids_(people.G02!)])
  g03ItemId = await rosterItem('G03 期中報告', taipei(addDays(TODAY, 35), '23:59'), 'group', [groupIds.G03!])

  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await openGantt(page)
  await drag(page, stageHandle(page, 4), -7 * DAY_PX)
  await expect(confirmBox(page)).toContainText(`第 4 階段『成果』開始日 ${md(STAGES[3]!.start)} → ${md(NEW_S4)}（第 3 階段跟著變短）。有 1 個整組作業在這兩段裡`)
  await confirmBox(page).getByRole('button', { name: '確定' }).click()
  await expect(page.getByTestId('gantt').getByRole('status').filter({ hasText: '的階段與日期' })).toBeVisible()

  const events = await stageEvents()
  expect(events).toHaveLength(2)
  expect([...events[1]!.recipients].sort()).toEqual(ids_(people.G03!))
  expect(events[1]!.recipient_basis).toMatchObject({ groupIds: [groupIds.G03], itemIds: [g03ItemId] })
  expect(events[1]!.payload.changedStages).toEqual([3, 4])
  await expect.poll(async () => Promise.all(people.G03!.map((p) => noteCount(p.id))), { timeout: 30_000 }).toEqual([1, 1])
  // G01 只有上一則（第 2 段那次）、G02 仍 0。
  for (const p of people.G01!) expect(await noteCount(p.id)).toBe(1)
  for (const p of people.G02!) expect(await noteCount(p.id)).toBe(0)
  expect(groupItemId).toBeTruthy()
})

// ── C3-13 Review FIX：延遲／斷線時的確認流程（server action 是帶 `next-action` 標頭的 POST） ──────────

/**
 * 攔截這一頁的 server action。`plan(n)` 回第 n 個（0 起）action 請求要怎麼處理：延遲幾毫秒後照送、或直接斷線。
 * 拖階段放開的第 1 個 action 是預覽、按「確定」後的下一個是儲存。
 */
async function routeActions(page: Page, plan: (n: number) => { delay?: number; abort?: boolean } | undefined) {
  let n = 0
  await page.route('**/dashboard/admin/timeline**', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST' || !request.headers()['next-action']) return route.continue()
    const step = plan(n++) ?? {}
    if (step.delay) await new Promise((r) => setTimeout(r, step.delay))
    if (step.abort) return route.abort('failed')
    return route.continue()
  })
}

const stageRow = async (seq: number) =>
  (await pool.query<{ start: string }>(`select to_char(start_date, 'YYYY-MM-DD') as start from cohort_stages where cohort_id = $1 and seq = $2`, [cohortId, seq]))
    .rows[0]!.start
const cohortRevision = async () => (await pool.query<{ revision: number }>('select revision from cohorts where id = $1', [cohortId])).rows[0]!.revision
const NO_RESPONSE = '沒有收到伺服器回應，請重新整理頁面看看。'
/** 把把手捲到甘特可視區正中間（滑鼠往左拖才不會拖出甘特）。 */
async function centerHandle(page: Page, handle: Locator) {
  const box = (await handle.boundingBox())!
  await page.locator('.gantt-scroll').evaluate((el, x) => {
    const rect = el.getBoundingClientRect()
    el.scrollLeft += x - (rect.left + rect.width / 2)
  }, box.x)
}

/** 把手鍵盤：← 一天、Enter 送出（跟拖拉放開同一條 `saveSchedule`；把手常被捲到可視區邊緣，滑鼠往左拖會拖出甘特）。 */
async function nudge(handle: Locator, days: number) {
  await handle.focus()
  for (let i = 0; i < days; i += 1) await handle.press('ArrowLeft')
  await handle.press('Enter')
}

test('FIX-1 預覽還沒回來時又拖一次：第二次不接；確認框取消 → 回到最初的位置，資料不變', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  // 兩次放開的預覽都慢（Review 的重現：11/19 → 11/12 → 11/5 再取消）。
  await routeActions(page, (n) => (n <= 1 ? { delay: 2_000 } : undefined))
  await openGantt(page)
  const origin = await stageRow(3)
  const revision = await cohortRevision()
  const handle = stageHandle(page, 3)
  await expect(handle).toHaveAttribute('aria-label', new RegExp(` ${md(origin)}（`))

  // 滑鼠連拖兩次（鍵盤調整在 gantt 裡本來就會等前一次，Review 是用滑鼠重現的）。
  await centerHandle(page, handle)
  await drag(page, handle, -7 * DAY_PX) // 預覽延遲中
  await expect(handle).toHaveAttribute('aria-label', new RegExp(` ${md(addDays(origin, -7))}（`))
  await drag(page, handle, -7 * DAY_PX) // 再拖一次
  // 第二次不接：彈回並提示（不默默丟掉）。
  await expect(page.getByTestId('gantt').getByRole('alert')).toHaveText('上一次的調整還在處理，請等確認框出現再拖。')
  // 等兩次預覽都回來再取消（Review 的情境）。Next 的 server action 會排隊一個一個送，各延遲 2 秒，
  // 第二次最晚約 4.5 秒才回來，所以等 6 秒。
  await page.waitForTimeout(6_000)
  await expect(confirmBox(page)).toBeVisible()
  await confirmBox(page).getByRole('button', { name: '取消' }).click()
  await expect(confirmBox(page)).toHaveCount(0)
  await expect(handle).toHaveAttribute('aria-label', new RegExp(` ${md(origin)}（`))
  expect(await stageRow(3)).toBe(origin)
  expect(await cohortRevision()).toBe(revision)
})

test('FIX-2 按「確定」後儲存還在跑：「取消」停用、Esc 關不掉；存完才關', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await routeActions(page, (n) => (n === 1 ? { delay: 2_000 } : undefined))
  await openGantt(page)
  const origin = await stageRow(3)
  const revision = await cohortRevision()
  await nudge(stageHandle(page, 3), 7)
  await expect(confirmBox(page)).toBeVisible()
  await confirmBox(page).getByRole('button', { name: '確定' }).click()
  await expect(confirmBox(page).getByRole('button', { name: '儲存中…' })).toBeDisabled()
  await expect(confirmBox(page).getByRole('button', { name: '取消' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(confirmBox(page)).toBeVisible()
  await expect(confirmBox(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByTestId('gantt').getByRole('status').filter({ hasText: '的階段與日期' })).toBeVisible()
  expect(await stageRow(3)).toBe(addDays(origin, -7))
  expect(await cohortRevision()).toBe(revision + 1)
})

test('FIX-3 斷線：預覽或儲存的請求失敗 → 回彈、錯誤句、不卡在「儲存中…」，資料不變', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await routeActions(page, (n) => (n === 0 || n === 2 ? { abort: true } : undefined))
  await openGantt(page)
  const origin = await stageRow(3)
  const revision = await cohortRevision()
  const handle = stageHandle(page, 3)
  const alert = page.getByTestId('gantt').getByRole('alert')

  // 預覽斷線：不開確認框，回彈＋錯誤句。
  await nudge(handle, 7)
  await expect(alert).toHaveText(NO_RESPONSE)
  await expect(confirmBox(page)).toHaveCount(0)
  await expect(handle).toHaveAttribute('aria-label', new RegExp(` ${md(origin)}（`))

  // 預覽成功、儲存斷線：關框、回彈＋錯誤句。
  await nudge(handle, 7)
  await expect(confirmBox(page)).toBeVisible()
  await confirmBox(page).getByRole('button', { name: '確定' }).click()
  await expect(confirmBox(page)).toHaveCount(0)
  await expect(alert).toHaveText(NO_RESPONSE)
  await expect(handle).toHaveAttribute('aria-label', new RegExp(` ${md(origin)}（`))
  expect(await stageRow(3)).toBe(origin)
  expect(await cohortRevision()).toBe(revision)
})
