import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 系辦編輯器正文旁的即時預覽（系辦 AD-16；AC-AD-28）：
 *
 * 1. 新建頁沒填標題：窗格寫「填好標題、開始打正文就會出現預覽」與檢查原因「請填標題。」，不渲染正文。
 * 2. 填好標題：窗格渲染伺服器淨化後的正文（粗體在）；正文裡的 `<script>`、`onerror` 不執行，也不出現原字。
 * 3. 標題清空：窗格寫「請填標題。」並清掉上一版預覽。
 * 4. 頂列「預覽」只開關窗格、不多打伺服器；手機寬預設收起、按了才展開。
 *
 * 屆別用 owner 連線直接建；全程用真的表單與按鈕。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `AD16-${stamp}`

let pool: Pool
let cohortId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  cohortId = String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
        [CODE, ymd(new Date(Date.now() + 300 * 86_400_000))],
      )
    ).rows[0]!.id,
  )
  await pool.query(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '成組期', $2, 'system')`,
    [cohortId, ymd(new Date())],
  )
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
}

/** 數 Server Action 請求（自動檢查 `reviewItemAction` 就是走這個）。 */
function countActions(page: Page) {
  const counter = { n: 0 }
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.headers()['next-action']) counter.n += 1
  })
  return counter
}

test('正文旁預覽：先填標題才渲染、只渲染淨化後的正文、檢查失敗清掉舊預覽、按鈕只開關窗格', async ({ page }) => {
  const alerts: string[] = []
  page.on('dialog', async (d) => {
    alerts.push(d.message())
    await d.dismiss()
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await asAdmin(page)
  const actions = countActions(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)

  const pane = page.getByRole('region', { name: '預覽', exact: true })
  const body = page.getByLabel('正文（網頁排版格式，可直接打字）', { exact: true })
  await expect(body).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: '公告與作業', exact: true })).toHaveAttribute(
    'href',
    `/dashboard/admin/affairs?cohort=${cohortId}`,
  )

  // 一開始與步驟 1：還沒有標題，只有提示句與原因，正文沒有渲染。
  await expect(pane).toContainText('填好標題、開始打正文就會出現預覽')
  await expect(pane).toContainText('請填標題。')
  await body.fill('<p>期中<strong>報告</strong></p>')
  await page.waitForTimeout(1000)
  await expect(pane).toContainText('請填標題。')
  await expect(pane.locator('strong')).toHaveCount(0)
  await expect(pane).not.toContainText('期中')

  // 1440 寬：窗格在正文右側。
  const bodyBox = (await body.boundingBox())!
  const paneBox = (await pane.boundingBox())!
  expect(paneBox.x).toBeGreaterThanOrEqual(bodyBox.x + bodyBox.width)
  expect(paneBox.y).toBeLessThan(bodyBox.y + bodyBox.height)

  // 步驟 2：填標題 → 渲染淨化後的正文。
  await page.locator('#ed-title').fill('期中報告說明')
  await expect(pane.locator('strong')).toHaveText('報告')
  await expect(pane).not.toContainText('填好標題')
  await expect(pane).not.toContainText('請填標題。')

  // 含 <script> 與 onerror：不執行、不出現原字。
  await body.fill('<p>第二版<strong>報告</strong></p><script>window.__ad16=1;alert(1)</script><img src=x onerror="window.__ad16=2;alert(2)">')
  await expect(pane).toContainText('第二版')
  await expect(pane).not.toContainText('<script')
  await expect(pane).not.toContainText('__ad16')
  expect(await pane.innerHTML()).not.toMatch(/<script|onerror/i)
  expect(await page.evaluate(() => (window as unknown as { __ad16?: number }).__ad16)).toBeUndefined()
  expect(alerts, '正文裡的腳本不能執行').toEqual([])

  // 步驟 3：清空標題 → 原因出現、上一版預覽清掉。
  await page.locator('#ed-title').fill('')
  await expect(pane).toContainText('請填標題。')
  await expect(pane).toContainText('填好標題、開始打正文就會出現預覽')
  await expect(pane).not.toContainText('第二版')
  await expect(pane.locator('strong')).toHaveCount(0)

  // 頂列「預覽」：只開關窗格，不多打伺服器。
  await page.waitForTimeout(1000)
  const before = actions.n
  const toggle = page.locator('button[aria-controls="ed-body-preview"]')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(pane).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(pane).toBeVisible()
  await page.waitForTimeout(1000)
  expect(actions.n, '按「預覽」不應多打伺服器').toBe(before)
})

test('手機寬：預覽窗格預設收起，頂列「預覽」可以展開', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.locator('#ed-title').fill('手機預覽')
  await page.locator('#ed-body').fill('<p>手機<strong>看得到</strong></p>')

  const pane = page.locator('#ed-body-preview')
  const toggle = page.locator('button[aria-controls="ed-body-preview"]')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(pane).toBeHidden()

  // 先切到別的分頁，按「預覽」也會回到窗格所在的「內容」分頁。
  await page.getByRole('navigation', { name: '編輯區段' }).getByRole('button', { name: '發布' }).click()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(pane).toBeVisible()
  await expect(pane.locator('strong')).toHaveText('看得到')
  // 窄螢幕窗格在正文下方。
  const bodyBox = (await page.locator('#ed-body').boundingBox())!
  const paneBox = (await pane.boundingBox())!
  expect(paneBox.y).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height)
})

test('成功預覽後手動「檢查與預覽」斷線：窗格寫原因、清掉舊預覽', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await page.locator('#ed-title').fill('斷線預覽')
  await page.locator('#ed-body').fill('<p>斷線前<strong>看得到</strong></p>')
  const pane = page.getByRole('region', { name: '預覽', exact: true })
  await expect(pane.locator('strong')).toHaveText('看得到')

  // 之後的 Server Action 都斷線（頁面不重新載入）。
  await page.route('**/dashboard/admin/editor/new**', (route) =>
    route.request().method() === 'POST' && route.request().headers()['next-action'] ? route.abort('failed') : route.continue(),
  )
  await page.getByRole('region', { name: '預覽確認' }).getByRole('button', { name: '檢查與預覽' }).click()
  await expect(pane).toContainText('連線中斷，請再按一次。')
  await expect(pane.locator('strong')).toHaveCount(0)
  await expect(pane).not.toContainText('斷線前')
})
