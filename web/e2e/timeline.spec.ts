import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

/**
 * 票 11（#222）：年度階段、活動與模擬時鐘。「做完的樣子」逐條走：
 *
 * 1. 管理員替屆別設四個階段的開始日（嚴格遞增）與年度結束日；建立、改期、取消活動。
 * 2. 屆別從籌備中變進行中留下紀錄；三角色首頁顯示「尚未開始／階段 n／年度階段已結束」。
 * 3. 測試站的管理員可把「今天」設成任意時間（到秒、可前進可倒退），每次留操作者、原因、前後時間。
 *    （正式站沒有入口：CI 的 e2e 跑的是測試站設定；正式站拒絕由整合測試證明。）
 * 4. 「發事件」與業務動作同一筆交易：活動異動與轉進行中都在事件表留一筆。
 *
 * 全程用真的表單與按鈕；重新整理後再看，確認是存進資料庫。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T11-${stamp}`

let pool: Pool

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
})

test.afterAll(async () => {
  await pool?.end()
})

async function signInAs(page: Page, role: TestRole) {
  const session = await sharedTestSession(page.request, role)
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  return session
}

/** 伺服器回來的回饋。限定在 `<main>`：Next 的換頁播報器也用 `role="alert"`。 */
function feedback(page: Page, role: 'status' | 'alert') {
  return page.getByRole('main').getByRole(role)
}

async function cohortId(): Promise<string> {
  const found = await pool.query<{ id: string }>('select id from cohorts where code = $1', [CODE])
  return found.rows[0]!.id
}

async function stageText(page: Page, path: string) {
  await page.goto(path)
  return page.getByRole('region', { name: '現在階段' }).getByTestId('stage-text')
}

/**
 * 設模擬業務鐘。`local` 是臺灣時間；秒數是 0 時要寫成 `HH:mm`——瀏覽器會把 `:00` 秒省略，
 * Playwright 填 `HH:mm:00` 會判定值被改掉。要驗「到秒」就填非 0 的秒數。
 */
async function setClock(page: Page, local: string, reason: string) {
  await page.goto('/dashboard/admin/clock')
  await page.getByLabel('業務時間（臺灣時間，到秒）').fill(local)
  await page.getByLabel('原因').fill(reason)
  await page.getByRole('button', { name: '設定業務時間' }).click()
  await expect(feedback(page, 'status')).toContainText('已設定業務時間')
}

test('建屆別、設為預設工作屆別；還沒設階段就轉進行中會被擋下', async ({ page }) => {
  await signInAs(page, 'admin')
  await page.goto('/dashboard/admin/cohorts')
  await page.getByLabel('代碼').fill(CODE)
  await page.getByLabel('名稱').fill(`${CODE} 年度測試`)
  await page.getByRole('button', { name: '新增屆別' }).click()
  await expect(feedback(page, 'status')).toContainText(`已新增屆別 ${CODE}`)

  // 重新整理：新增表單的回饋不留在畫面上，下面才只會有一句回饋。
  await page.reload()
  await page.getByRole('button', { name: `把 ${CODE} 設為預設工作屆別` }).click()
  await expect(feedback(page, 'status')).toContainText(`已把 ${CODE} 設為預設工作屆別`)

  await page.getByRole('button', { name: `把 ${CODE} 轉為進行中` }).click()
  await expect(feedback(page, 'alert')).toContainText('還沒設定階段與年度結束日')
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: CODE, exact: true }) })
  await expect(row).toContainText('籌備中')
})

test('時間軸：填四個階段開始日與年度結束日；不遞增被拒，原日期保留', async ({ page }) => {
  await signInAs(page, 'admin')
  await page.goto('/dashboard/admin/timeline')
  await expect(page.getByRole('heading', { name: '時間軸設定', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '時間軸' })).toContainText(CODE)
  await expect(page.getByText('這一屆還沒設定階段')).toBeVisible()

  await page.getByRole('button', { name: '編輯階段與日期', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `編輯 ${CODE} 的階段與日期` })
  const stages = [
    ['成組期', '2026-09-15'],
    ['期中', '2026-11-01'],
    ['期末', '2027-01-10'],
    ['成果', '2027-03-01'],
  ]
  for (const [i, [name, date]] of stages.entries()) {
    await dialog.getByLabel(`第 ${i + 1} 階段名稱`).fill(name!)
    await dialog.getByLabel(`第 ${i + 1} 階段開始日`).fill(date!)
  }
  await dialog.getByLabel('年度結束日').fill('2027-06-30')
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(feedback(page, 'status')).toContainText(`已儲存 ${CODE} 的階段與日期`)
  await expect(dialog).toBeHidden()

  const list = page.getByRole('list', { name: '本屆階段' })
  await expect(list).toContainText('成組期')
  await expect(list).toContainText('2026/11/01 – 2027/01/09')
  await expect(list).toContainText('2027/03/01 – 2027/06/30')

  // 第三階段改成早於第二階段 → 被拒，對話框留著、原日期不變。
  await page.getByRole('button', { name: '編輯階段與日期', exact: true }).click()
  await dialog.getByLabel('第 3 階段開始日').fill('2026-10-01')
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog.getByRole('alert')).toContainText('第 3 階段的開始日')
  await expect(dialog.getByRole('alert')).toContainText('要晚於第 2 階段')
  await dialog.getByRole('button', { name: '先不改' }).click()

  await page.reload()
  await expect(page.getByRole('list', { name: '本屆階段' })).toContainText('2027/01/10 – 2027/02/28')
})

test('活動：新增、改期、取消；取消後留在「已取消」、不在已排定清單', async ({ page }) => {
  await signInAs(page, 'admin')
  await page.goto('/dashboard/admin/timeline')

  await page.getByLabel('活動名稱').fill('期中發表會')
  await page.getByLabel('日期', { exact: true }).fill('2026-12-20')
  await page.getByLabel('開始時間').fill('14:00')
  await page.getByLabel('結束時間（可不填）').fill('16:00')
  await page.getByRole('button', { name: '新增活動' }).click()
  await expect(feedback(page, 'status')).toContainText('已新增活動「期中發表會」')

  const scheduled = page.getByRole('region', { name: '已排定的活動' })
  await expect(scheduled).toContainText('2026/12/20 14:00–16:00')

  await scheduled.getByRole('button', { name: '改期：期中發表會' }).click()
  const edit = page.getByRole('dialog', { name: '改期：期中發表會' })
  await edit.getByLabel('日期', { exact: true }).fill('2026-12-22')
  await edit.getByRole('button', { name: '儲存改期' }).click()
  await expect(edit).toBeHidden()
  await expect(scheduled).toContainText('2026/12/22 14:00–16:00')

  await scheduled.getByRole('button', { name: '取消活動：期中發表會' }).click()
  await page.getByRole('dialog', { name: '取消「期中發表會」？' }).getByRole('button', { name: '確定取消' }).click()
  const cancelledList = page.getByRole('region', { name: '已取消的活動' })
  await expect(cancelledList).toContainText('期中發表會')
  await expect(cancelledList).toContainText('已取消')
  await expect(scheduled).not.toContainText('期中發表會')

  // 重新整理仍然一樣；三個動作都在同一筆交易發了 calendar.changed 事件。
  await page.reload()
  await expect(page.getByRole('region', { name: '已取消的活動' })).toContainText('期中發表會')
  const events = await pool.query(
    `select payload->>'action' as action from domain_events
      where type = 'calendar.changed' and cohort_id = $1 order by occurred_real_at, id`,
    [await cohortId()],
  )
  expect(events.rows.map((r) => r.action)).toEqual(['created', 'updated', 'cancelled'])
})

test('設好階段後轉進行中：狀態變進行中，狀態紀錄多一列', async ({ page }) => {
  await signInAs(page, 'admin')
  await page.goto('/dashboard/admin/cohorts')
  await page.getByRole('button', { name: `把 ${CODE} 轉為進行中` }).click()
  await expect(feedback(page, 'status')).toContainText(`已把 ${CODE} 轉為進行中`)
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: CODE, exact: true }) })
  await expect(row).toContainText('進行中')
  await expect(page.getByRole('button', { name: `把 ${CODE} 轉為進行中` })).toHaveCount(0)

  const events = await pool.query(
    `select from_status, to_status from cohort_status_events where cohort_id = $1 order by real_at, id`,
    [await cohortId()],
  )
  expect(events.rows).toEqual([
    { from_status: null, to_status: 'preparing' },
    { from_status: 'preparing', to_status: 'active' },
  ])
})

test('模擬業務鐘：原因必填；推到各個時間點，三角色首頁的階段文字一起變', async ({ page, request }) => {
  // 學生要歸屬這一屆，首頁才看得到它（老師與管理員看預設工作屆別）。
  // 兩個帳號各用一個還沒有任何 cookie 的 request 註冊：註冊回應會留下 session cookie，
  // 帶著 cookie 又沒有 Origin 的第二次 POST 會被 Better Auth 當成 CSRF 擋下。
  const student = await sharedTestSession(request, 'student')
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email, cohort_id)
     values ($1, 'e2e 學生', 'e2e', $2, $3)
     on conflict (user_id) do update set cohort_id = excluded.cohort_id`,
    [student.userId, student.email, await cohortId()],
  )
  await sharedTestSession(page.request, 'teacher')

  await signInAs(page, 'admin')
  await page.goto('/dashboard/admin/clock')
  await expect(page.getByRole('heading', { name: '模擬業務鐘' })).toBeVisible()
  await page.getByLabel('業務時間（臺灣時間，到秒）').fill('2027-03-01T10:00')
  await page.getByRole('button', { name: '設定業務時間' }).click()
  await expect(feedback(page, 'alert')).toContainText('請填原因')

  // 第一階段開始日的前一晚：尚未開始。（設定後業務鐘會繼續走，所以不設在最後一秒；
  // 秒級邊界由單元測試證明。）
  await setClock(page, '2026-09-14T23:00:05', 'e2e：第一階段前一晚')
  await expect(page.getByLabel('目前業務時間')).toContainText('2026/09/14 23:00:')
  await expect(await stageText(page, '/dashboard/admin')).toHaveText('尚未開始')

  // 第二階段開始日 00:00:00：三個角色都是階段 2。
  await setClock(page, '2026-11-01T00:00', 'e2e：第二階段第一秒')
  await expect(await stageText(page, '/dashboard/admin')).toHaveText('階段 2：期中')
  await signInAs(page, 'teacher')
  await expect(await stageText(page, '/dashboard/teacher')).toHaveText('階段 2：期中')
  await signInAs(page, 'student')
  await expect(await stageText(page, '/dashboard/student')).toHaveText('階段 2：期中')
  await expect(page.getByRole('list', { name: '本屆階段' })).toContainText('期末')

  // 年度結束日當天：仍是最後一段；隔天：年度階段已結束。倒退也可以。
  await signInAs(page, 'admin')
  await setClock(page, '2027-06-30T12:00', 'e2e：年度結束日當天')
  await expect(await stageText(page, '/dashboard/admin')).toHaveText('階段 4：成果')
  await setClock(page, '2027-07-01T00:00', 'e2e：年度結束隔天')
  await expect(await stageText(page, '/dashboard/admin')).toHaveText('年度階段已結束')
  await signInAs(page, 'student')
  await expect(await stageText(page, '/dashboard/student')).toHaveText('年度階段已結束')

  // 紀錄：每次都有操作者、原因、前後時間；最新的在最上面。
  await signInAs(page, 'admin')
  await page.goto('/dashboard/admin/clock')
  const history = page.getByRole('region', { name: '設定紀錄' })
  await expect(history.getByRole('row').nth(1)).toContainText('e2e：年度結束隔天')
  await expect(history.getByRole('row').nth(1)).toContainText('2027/07/01 00:00:00')
  await expect(history.getByRole('row').nth(1)).toContainText('2027/06/30 12:00:')
  const rows = await pool.query(
    `select count(*)::int as n from business_clock_overrides where reason like 'e2e：%' and previous_business_at is not null`,
  )
  expect(rows.rows[0].n).toBeGreaterThanOrEqual(4)
})

test.afterAll(async ({ browser }) => {
  // 模擬鐘是全站狀態：跑完撥回接近真實時間，免得影響之後手動測試的人。
  const page = await browser.newPage()
  try {
    await signInAs(page, 'admin')
    const now = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16)
    await setClock(page, now, 'e2e 結束：撥回真實時間')
  } finally {
    await page.close()
  }
})
