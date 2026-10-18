import { expect, request as playwrightRequest, test, type BrowserContext, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * C2-16 前台編輯模式框架（規格② 設計方案 §6；AC-C2-38、39、41 檔案部分、42）。
 *
 * - 訪客與學生：HTML 沒有 `data-fe-`、沒有 `fju_office` cookie、下載的 JS／CSS 沒有編輯層、回應沒有改寫標頭（AC-C2-38）。
 * - 系辦用登入頁真的登入（`hooks.after` 設提示 cookie）：右下「編輯頁面」開關、虛線框、每則的編輯／刪除、
 *   頁尾只有編輯、完成編輯全部消失、重新整理保持開著、整段沒有 CSP 違規（AC-C2-39）。
 * - `/files`：檔案「刪除」跳「確定刪除『檔名』？」；分類的刪除 disabled 寫「有 3 個檔案，先移走」（AC-C2-41 檔案部分）。
 *   真的刪除要①的 `resource` 表單模組（C1 票登錄進 `forms.ts`）；在那之前框架顯示「這個區塊還不能在前台改」、那則留著。
 * - 系辦的 `/` 回 `cache-control: private, no-store`；直接打 `/office-edit/files` → 307 `/files`（AC-C2-42）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'E2e-Password-Correct-9'
const PAGES = ['/', '/files', '/rules', '/privacy'] as const

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const COHORT = `FE${stamp}`
const CATEGORY = `格式${stamp}`
const FILES = [1, 2, 3].map((n) => `${stamp} 範本 ${n}`)
const RULE = `${stamp} 第一章 課程目的`

let pool: Pool
let admin: TestSession
let student: TestSession

async function one(sql: string, values: unknown[] = []): Promise<string> {
  return String((await pool.query(sql, values)).rows[0]!.id)
}

/** 直接插一則已發布、公開的項目（同 `public-projects.spec.ts` 的做法；建立流程有自己的 e2e）。 */
async function publishedItem(cohortId: string, placement: string, title: string, category: string | null) {
  const itemId = await one(
    `insert into managed_items (id, cohort_id, placement, audience_kind, title, summary, category, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, $2, 'public', $3, '示範摘要', $4, 'user', $5) returning id`,
    [cohortId, placement, title, category, admin.userId],
  )
  const versionId = await one(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, category, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '示範摘要', '<p>內文</p>', $3, $4) returning id`,
    [itemId, title, category, admin.userId],
  )
  const schemaId = await one(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[]}', $2) returning id`,
    [itemId, admin.userId],
  )
  await pool.query(
    `update managed_items set status = 'published', actual_opened_at = now(), current_content_version_id = $2, current_schema_version_id = $3
      where id = $1`,
    [itemId, versionId, schemaId],
  )
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
  // 各自新註冊（不共用）：系辦要用密碼從登入頁登入，才會經過設提示 cookie 的 hooks.after。
  admin = await createTestSession(api, 'admin')
  student = await createTestSession(api, 'student')
  await api.dispose()
  const cohortId = await one(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [COHORT],
  )
  for (const title of FILES) await publishedItem(cohortId, 'resource', title, CATEGORY)
  await publishedItem(cohortId, 'rules', RULE, null)
})

test.afterAll(async () => {
  await pool?.end()
})

/** 從登入頁用密碼登入（真的 Server Action → Better Auth `/sign-in/email`）。 */
async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
}

/** 記下這個分頁下載的 JS／CSS 內容有沒有編輯層（`fju-front-edit` 是編輯層的 sessionStorage 鍵、`.fe-toggle` 是它的樣式）。 */
function watchAssets(page: Page) {
  const hits: string[] = []
  page.on('response', async (response) => {
    const type = response.request().resourceType()
    if (type !== 'script' && type !== 'stylesheet') return
    const body = await response.text().catch(() => '')
    if (body.includes('fju-front-edit') || body.includes('.fe-toggle')) hits.push(response.url())
  })
  return hits
}

/** 收 CSP 違規（console 的 Content Security Policy 訊息）。 */
function watchCsp(page: Page) {
  const violations: string[] = []
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to (apply|load|execute)/i.test(message.text())) violations.push(message.text())
  })
  return violations
}

async function officeCookie(context: BrowserContext) {
  return (await context.cookies()).find((c) => c.name === 'fju_office')
}

test.describe('AC-C2-38 訪客與學生零標記', () => {
  test('(a) 訪客：HTML 沒有 data-fe-、沒有 fju_office、沒有編輯層 chunk、沒有改寫標頭', async ({ page, context }) => {
    const assets = watchAssets(page)
    for (const path of PAGES) {
      const response = await page.goto(path)
      expect(response?.headers()['x-fju-office-rewrite'], path).toBeUndefined()
      const html = await page.content()
      expect(html.includes('data-fe-'), `${path} 不該有 data-fe-`).toBe(false)
      await expect(page.getByRole('button', { name: '編輯頁面' })).toHaveCount(0)
    }
    expect(await officeCookie(context)).toBeUndefined()
    expect(assets, '訪客不該下載編輯層').toEqual([])
  })

  test('(b) 學生（從登入頁登入）：同上，而且帶著偽造的改寫標頭也不會被標記', async ({ page, context }) => {
    await signIn(page, student.email)
    expect(await officeCookie(context), '學生登入不設提示 cookie').toBeUndefined()
    const assets = watchAssets(page)
    for (const path of PAGES) {
      const response = await page.goto(path)
      expect(response?.headers()['x-fju-office-rewrite'], path).toBeUndefined()
      expect((await page.content()).includes('data-fe-'), `${path} 不該有 data-fe-`).toBe(false)
    }
    expect(assets, '學生不該下載編輯層').toEqual([])

    // 自己送改寫標頭：proxy 先刪掉，公開頁照樣不標記。
    const raw = await context.request.get('/rules', { headers: { 'x-fju-office-rewrite': '1' } })
    expect((await raw.text()).includes('data-fe-')).toBe(false)
  })

  test('學生自己塞 fju_office=1：改寫進編輯路由也只回原頁（沒有標記、沒有開關）', async ({ page, context }) => {
    await context.addCookies([toPlaywrightCookie(student.cookie, BASE_URL), { ...toPlaywrightCookie('fju_office=1', BASE_URL) }])
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '最新公告' })).toBeVisible()
    expect((await page.content()).includes('data-fe-')).toBe(false)
    await expect(page.getByRole('button', { name: '編輯頁面' })).toHaveCount(0)
  })
})

test.describe('系辦', () => {
  test('AC-C2-42 (a) 系辦的 / 回 private, no-store；(b) 直接打 /office-edit/files → 307 /files', async ({ page, context }) => {
    await signIn(page, admin.email)
    const hint = await officeCookie(context)
    expect(hint?.value, '系辦登入後有提示 cookie').toBe('1')
    expect(hint?.httpOnly).toBe(true)
    expect(hint?.sameSite).toBe('Lax')

    const home = await page.goto('/')
    expect(home?.headers()['cache-control']).toBe('private, no-store')
    test.info().annotations.push({ type: '回應標頭', description: `GET / → cache-control: ${home?.headers()['cache-control']}` })

    const direct = await context.request.get('/office-edit/files?category=x', { maxRedirects: 0 })
    expect(direct.status()).toBe(307)
    expect(new URL(direct.headers()['location']!, BASE_URL).pathname + new URL(direct.headers()['location']!, BASE_URL).search).toBe(
      '/files?category=x',
    )
    // 訪客直接打也是同樣的 307（不是 404）。
    const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL })
    const anon = await anonymous.get('/office-edit', { maxRedirects: 0 })
    expect(anon.status()).toBe(307)
    expect(new URL(anon.headers()['location']!, BASE_URL).pathname).toBe('/')
    await anonymous.dispose()
  })

  test('AC-C2-39 開關：按之前跟學生同畫面只多一顆按鈕；按之後框與按鈕；完成編輯全消失；重新整理保持；CSP 0', async ({ page, browser }) => {
    const csp = watchCsp(page)
    await signIn(page, admin.email)
    await page.goto('/')

    // 按之前：main 的內容跟學生登入後一樣（區塊與文字），只多右下角一顆按鈕。
    const studentContext = await browser.newContext()
    await studentContext.addCookies([toPlaywrightCookie(student.cookie, BASE_URL)])
    const studentPage = await studentContext.newPage()
    await studentPage.goto('/')
    const mainText = (p: Page) => p.locator('main').innerText()
    expect(await mainText(page)).toBe(await mainText(studentPage))
    await studentContext.close()
    const toggle = page.getByRole('button', { name: '編輯頁面' })
    await expect(toggle).toBeVisible()
    await expect(page.getByTestId('front-edit-layer')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('before.png'), fullPage: false })

    // 按之後：每個區塊有框與標籤、每則有「編輯」，能刪的多「刪除」；頁尾只有「編輯」。
    await toggle.click()
    const layer = page.getByTestId('front-edit-layer')
    await expect(layer).toBeAttached()
    const sections = await page.locator('main [data-fe-section]').count()
    expect(sections).toBeGreaterThanOrEqual(3)
    await expect(layer.locator('.fe-section')).toHaveCount(await page.locator('[data-fe-section]').count())
    for (const label of ['最新公告', '優秀專題', '榮譽與競賽', '歷屆專題一覽']) {
      await expect(layer.locator('.fe-section-label', { hasText: label })).toHaveCount(1)
    }
    await expect(layer.getByRole('button', { name: /^新增公告/ })).toBeVisible()
    const items = await page.locator('[data-fe-item]').count()
    await expect(layer.locator('.fe-item')).toHaveCount(items)
    await expect(layer.getByRole('button', { name: /^編輯/ })).toHaveCount(items)
    const footer = layer.locator('.fe-item[data-fe-for="footer_contact"]')
    await expect(footer.getByRole('button', { name: /^編輯/ })).toHaveCount(1)
    await expect(footer.getByRole('button', { name: /刪除/ })).toHaveCount(0)
    await expect(layer.locator('.fe-item[data-fe-for="quick_card"]')).toHaveCount(3)
    await page.screenshot({ path: test.info().outputPath('on.png'), fullPage: true })

    // 還沒有表單的 kind：開窗說明，不壞。
    await layer.locator('.fe-item[data-fe-for="hero"]').getByRole('button', { name: /^編輯/ }).click()
    const dialog = page.getByRole('dialog', { name: '編輯首頁橫幅' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('alert')).toHaveText('這個區塊還不能在前台改')
    await dialog.getByRole('button', { name: '關閉' }).first().click()
    await expect(dialog).toHaveCount(0)

    // 重新整理：保持開著（sessionStorage），換頁也是。
    await page.reload()
    await expect(page.getByTestId('front-edit-layer')).toBeAttached()
    await expect(page.getByRole('button', { name: '完成編輯' })).toBeVisible()
    await page.goto('/rules')
    await expect(page.getByTestId('front-edit-layer')).toBeAttached()
    await expect(page.getByTestId('front-edit-layer').getByRole('button', { name: `編輯「${RULE}」` })).toBeVisible()

    // 編輯模式下點連結照常跳頁（按鈕不在連結裡）。
    await page.goto('/')
    await page.getByRole('link', { name: '查看更多' }).first().click()
    await expect(page).toHaveURL(/\/news$/)
    await page.goto('/')

    // 完成編輯：全部消失。
    await page.getByRole('button', { name: '完成編輯' }).click()
    await expect(page.getByTestId('front-edit-layer')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '編輯頁面' })).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('front-edit-layer')).toHaveCount(0)

    expect(csp, 'CSP 違規').toEqual([])
  })

  test('AC-C2-41（檔案部分）刪除確認、分類不能刪寫原因', async ({ page }) => {
    await signIn(page, admin.email)
    await page.goto(`/files?category=${encodeURIComponent(CATEGORY)}`)
    await page.getByRole('button', { name: '編輯頁面' }).click()
    const layer = page.getByTestId('front-edit-layer')

    // 分類：有 3 個檔案，刪除 disabled 寫原因。
    const category = layer.locator('.fe-item[data-fe-for="resource_category"]')
    await expect(category).toHaveCount(1)
    const blocked = category.getByRole('button', { name: /刪除/ })
    await expect(blocked).toBeDisabled()
    await expect(blocked).toContainText('有 3 個檔案，先移走')

    // 檔案：確認框寫檔名；取消不刪。
    await layer.getByRole('button', { name: `刪除「${FILES[0]}」` }).click()
    const confirm = page.getByRole('alertdialog', { name: '刪除' })
    await expect(confirm).toContainText(`確定刪除『${FILES[0]}』？`)
    await confirm.getByRole('button', { name: '取消' }).click()
    await expect(confirm).toHaveCount(0)

    // 按確定：①的 resource 模組還沒登錄（C1 票），框架說明、不關窗、那則還在。
    await layer.getByRole('button', { name: `刪除「${FILES[0]}」` }).click()
    await confirm.getByRole('button', { name: '確定刪除' }).click()
    await expect(confirm.getByRole('alert')).toHaveText('這個區塊還不能在前台改')
    await confirm.getByRole('button', { name: '取消' }).click()
    await expect(page.getByTestId('resource').filter({ hasText: FILES[0]! })).toHaveCount(1)
  })

  test('登出清掉提示 cookie', async ({ page, context }) => {
    await signIn(page, admin.email)
    expect((await officeCookie(context))?.value).toBe('1')
    await page.goto('/dashboard/admin')
    await page.getByRole('button', { name: '帳號選單' }).click()
    await page.getByRole('menuitem', { name: '登出' }).click()
    await expect(page).toHaveURL(/\/login$/)
    expect(await officeCookie(context)).toBeUndefined()
    await page.goto('/')
    expect((await page.content()).includes('data-fe-')).toBe(false)
  })
})
