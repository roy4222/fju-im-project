import { expect, request as playwrightRequest, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * C2-16 前台編輯模式框架（規格② 設計方案 §6；AC-C2-38、39、41 檔案部分、42）。
 *
 * - 訪客與學生：HTML 沒有 `data-fe-`、沒有 `fju_office` cookie、下載的 JS／CSS 沒有編輯層、回應沒有改寫標頭（AC-C2-38）。
 * - 系辦用登入頁真的登入（`hooks.after` 設提示 cookie）：右下「編輯頁面」開關、虛線框、每則的編輯／刪除、
 *   頁尾只有編輯、完成編輯全部消失、重新整理保持開著、整段沒有 CSP 違規（AC-C2-39）。
 * - `/files`：檔案「刪除」跳「確定刪除『檔名』？」；分類的刪除 disabled 寫「有 3 個檔案，先移走」（AC-C2-41 檔案部分）。
 *   真的刪除走①的 `resource` 表單模組（C1-06 登錄進 `forms.ts`）；發布中的檔案照 `deleteCheck` 拒絕，框架把原因顯示在確認框、那則留著。
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
const featuredIds: string[] = []

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
  // 首頁「優秀專題」4 張（手機上是可橫滑的一列；Review 第 1 輪：畫面外的卡片按鈕撐寬頁面）。afterAll 拿掉得獎，不影響別的 spec。
  for (const n of [1, 2, 3, 4]) {
    const groupId = await one(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
      [cohortId, `G0${n}`],
    )
    const entryId = await one(
      `insert into showcase_entries (id, cohort_id, group_id, status, created_by_user_id) values (gen_random_uuid(), $1, $2, 'draft', $3) returning id`,
      [cohortId, groupId, admin.userId],
    )
    const versionId = await one(
      `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, video_url, authorization_kind,
                                      authorization_ref, pii_check, created_by_user_id, created_real_at)
       values (gen_random_uuid(), $1, 1, $2, '摘要', encode(sha256(convert_to('摘要', 'UTF8')), 'hex'), null, 'external', gen_random_uuid(),
               '{"passed": true}'::jsonb, $3, now()) returning id`,
      [entryId, `${stamp} 優秀專題 ${n}`, admin.userId],
    )
    await pool.query(
      `update showcase_entries set status = 'published', current_version_id = $2, award_level = 'excellent' where id = $1`,
      [entryId, versionId],
    )
    featuredIds.push(entryId)
  }
  await publishedItem(cohortId, 'rules', RULE, null)
})

test.afterAll(async () => {
  if (featuredIds.length) await pool?.query(`update showcase_entries set award_level = null where id = any($1)`, [featuredIds])
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

/** main 裡每個區塊的名稱（aria-label 或 aria-labelledby 指到的標題）。 */
function sectionNames(page: Page) {
  return page.locator('main section').evaluateAll((sections) =>
    sections.map((s) => s.getAttribute('aria-label') ?? document.getElementById(s.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''),
  )
}

/** 訪客開 / ：HTML 沒有標記、下載的 JS／CSS 沒有編輯層。 */
async function expectVisitorHome(browser: Browser) {
  const visitor = await browser.newContext()
  const page = await visitor.newPage()
  const assets = watchAssets(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  expect((await page.content()).includes('data-fe-')).toBe(false)
  await expect(page.getByRole('button', { name: '編輯頁面' })).toHaveCount(0)
  expect(assets).toEqual([])
  await visitor.close()
}

const scrollWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth)

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

  test('AC-C2-39 開關：按之前跟原頁同畫面只多一顆按鈕；按之後框與按鈕；完成編輯全消失；重新整理保持；CSP 0', async ({ page, context, browser }) => {
    const csp = watchCsp(page)
    await signIn(page, admin.email)
    await page.goto('/')

    // 按之前：同一個系辦 session，編輯版（有提示 cookie）跟公開版（拿掉 cookie）的 main 內容一字不差，只多右下角一顆按鈕。
    const mainText = (p: Page) => p.locator('main').innerText()
    const editVersion = await mainText(page)
    const hint = (await officeCookie(context))!
    await context.clearCookies({ name: 'fju_office' })
    await page.goto('/')
    await expect(page.getByRole('button', { name: '編輯頁面' })).toHaveCount(0)
    expect(await mainText(page)).toBe(editVersion)
    await context.addCookies([hint])
    await page.goto('/')

    // 跨角色只比區塊結構（受眾不同的內容本來就可以不同）：main 的區塊名稱跟學生登入後一樣。
    const studentContext = await browser.newContext()
    await studentContext.addCookies([toPlaywrightCookie(student.cookie, BASE_URL)])
    const studentPage = await studentContext.newPage()
    await studentPage.goto('/')
    expect(await sectionNames(page)).toEqual(await sectionNames(studentPage))
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
    // 「最新公告」那顆（進行中的競賽區塊也可新增公告，有競賽資料時會多一顆「新增公告（進行中的競賽）」）。
    await expect(layer.getByRole('button', { name: '新增公告（最新公告）', exact: true })).toBeVisible()
    const items = await page.locator('[data-fe-item]').count()
    await expect(layer.locator('.fe-item')).toHaveCount(items)
    await expect(layer.getByRole('button', { name: /^編輯/ })).toHaveCount(items)
    const footer = layer.locator('.fe-item[data-fe-for="footer_contact"]')
    await expect(footer.getByRole('button', { name: /^編輯/ })).toHaveCount(1)
    await expect(footer.getByRole('button', { name: /刪除/ })).toHaveCount(0)
    await expect(layer.locator('.fe-item[data-fe-for="quick_card"]')).toHaveCount(3)
    await page.screenshot({ path: test.info().outputPath('on.png'), fullPage: true })

    // 還沒有表單的 kind（①的優秀專題；②的四種 C2-17 已登錄）：開窗說明，不壞。
    await layer.locator('.fe-item[data-fe-for="showcase"]').first().getByRole('button', { name: /^編輯/ }).click()
    const dialog = page.getByRole('dialog', { name: '編輯優秀專題' })
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

    // 按確定：①的 resource 模組（C1-06 登錄）照 `deleteCheck` 拒絕發布中的檔案，框架把原因顯示在確認框、不關窗、那則還在。
    await layer.getByRole('button', { name: `刪除「${FILES[0]}」` }).click()
    await confirm.getByRole('button', { name: '確定刪除' }).click()
    await expect(confirm.getByRole('alert')).toHaveText('發布中的項目不能刪除；要先撤回或下架才能刪除。')
    await confirm.getByRole('button', { name: '取消' }).click()
    await expect(page.getByTestId('resource').filter({ hasText: FILES[0]! })).toHaveCount(1)
  })

  test('AC-C2-39 手機 390 寬：橫滑卡片開編輯後頁面不會被撐寬，滑動後按鈕跟著卡片', async ({ browser }) => {
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await mobile.newPage()
    await signIn(page, admin.email)
    await page.goto('/')
    const list = page.getByTestId('home-featured-list')
    await expect(list.getByRole('listitem')).toHaveCount(4)
    expect(await scrollWidth(page)).toBeLessThanOrEqual(390)

    await page.getByRole('button', { name: '編輯頁面' }).click()
    const layer = page.getByTestId('front-edit-layer')
    await expect(layer.locator('.fe-item[data-fe-for="showcase"]').first()).toBeAttached()
    // 每個框與按鈕都在 390 以內（畫面外、被橫滑列裁掉的卡片不放），頁面寬度不變。
    const allInside = () =>
      layer.locator('.fe-item, .fe-section, .fe-tools button').evaluateAll((els) =>
        els.every((el) => {
          const r = el.getBoundingClientRect()
          return r.left >= -8 && r.right <= 390
        }),
      )
    expect(await allInside()).toBe(true)
    expect(await scrollWidth(page)).toBeLessThanOrEqual(390)

    // 橫滑到下一張：重算位置，第二張卡的按鈕出現在畫面內、頁面仍不變寬。
    const secondTitle = (await list.getByRole('listitem').nth(1).locator('.type-card-title').innerText()).trim()
    await list.evaluate((el) => el.scrollBy({ left: el.clientWidth }))
    await expect.poll(async () => (await list.getByRole('listitem').nth(1).boundingBox())?.x ?? 999).toBeLessThan(50)
    // 同一則也會出現在「歷屆專題一覽」，所以只看落在橫滑列那一帶的按鈕。
    const listBox = (await list.boundingBox())!
    await expect
      .poll(async () => {
        for (const button of await layer.getByRole('button', { name: `編輯「${secondTitle}」` }).all()) {
          const box = await button.boundingBox()
          if (box && box.y >= listBox.y && box.y <= listBox.y + listBox.height && box.x >= 0 && box.x + box.width <= 390) return true
        }
        return false
      })
      .toBe(true)
    await expect.poll(allInside).toBe(true)
    expect(await scrollWidth(page)).toBeLessThanOrEqual(390)
    await mobile.close()
  })

  test('登出清掉提示 cookie：後台登出鈕', async ({ page, context, browser }) => {
    await signIn(page, admin.email)
    expect((await officeCookie(context))?.value).toBe('1')
    await page.goto('/dashboard/admin')
    await page.getByRole('button', { name: '帳號選單' }).click()
    await page.getByRole('menuitem', { name: '登出' }).click()
    await expect(page).toHaveURL(/\/login$/)
    expect(await officeCookie(context)).toBeUndefined()
    await page.goto('/')
    expect((await page.content()).includes('data-fe-')).toBe(false)
    await expectVisitorHome(browser)
  })

  test('登出清掉提示 cookie：「重新登入確認身分」', async ({ page, context, browser }) => {
    await signIn(page, admin.email)
    expect((await officeCookie(context))?.value).toBe('1')
    // 登入超過 10 分鐘才會出現這顆（同 google.spec 的做法）。
    await pool.query(`update sessions set created_at = now() - interval '11 minutes' where user_id = $1`, [admin.userId])
    await page.goto('/account')
    await page.getByRole('button', { name: '重新登入確認身分' }).click()
    await expect(page).toHaveURL(/\/login\?next=%2Faccount$/)
    expect(await officeCookie(context)).toBeUndefined()
    const assets = watchAssets(page)
    await page.goto('/')
    expect((await page.content()).includes('data-fe-')).toBe(false)
    expect(assets).toEqual([])
    await expectVisitorHome(browser)
  })

  test('登出清掉提示 cookie：直接打 POST /api/auth/sign-out', async ({ page, context, browser }) => {
    await signIn(page, admin.email)
    expect((await officeCookie(context))?.value).toBe('1')
    const response = await context.request.post('/api/auth/sign-out', { headers: { origin: new URL(BASE_URL).origin }, data: {} })
    expect(response.status()).toBe(200)
    expect(await officeCookie(context)).toBeUndefined()
    const assets = watchAssets(page)
    await page.goto('/')
    expect((await page.content()).includes('data-fe-')).toBe(false)
    expect(assets).toEqual([])
    await expectVisitorHome(browser)
  })
})
