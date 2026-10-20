import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { FINGERPRINTS } from './fingerprints'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * C 階段規格② C2-01：後台路由總表、分頁列、舊網址轉址（設計方案 §2、§8；AC-C2-01～09）。
 *
 * - 舊網址（`/dashboard/admin/settings`、`/dashboard/admin/affairs?placement=resource|submission|requirement|rules`、
 *   C2-07 加的 `/dashboard/admin/accounts?status=pending|disabled`、C2-22 加的 `/dashboard/admin/signoff`）每條三種回應：
 *   沒登入→登入頁、學生→`/403`、系辦→**307** 到新位置（頁面 `redirect()` 的 digest；用 `REDIRECT` 陣列斷，再斷 location），
 *   其餘 query 照帶；①C1-09 加 `?placement=honor` → 成果展示（榮譽榜同頁，AC-14a）。
 * - 五個側欄項目的分頁列：標籤、順序、href、`aria-current`、側欄那一項亮；新分頁都 200。
 * - 作業、資源下載、專題規則三個分頁接的是既有清單：列出那一類的既有項目（`affair-row`），不是空外殼。
 *
 * 接手刪掉的 `admin-settings-home.spec.ts`（設定總頁四張卡）與 `pages.spec.ts` PROTECTED 拿掉的 `/settings`、`/signoff` 兩列。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const REDIRECT = [302, 303, 307, 308]

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `C201-${stamp}`
const TITLE = {
  news: `${CODE} 公告`,
  resource: `${CODE} 範本下載`,
  submission: `${CODE} 期中報告繳交`,
  requirement: `${CODE} 專題需求表`,
  rules: `${CODE} 第一章`,
  honor: `${CODE} 競賽優等`,
} as const

let pool: Pool
let cohortId: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const yearEnd = new Date(Date.now() + 300 * 86_400_000 + 8 * 3600_000).toISOString().slice(0, 10)
  cohortId = String(
    (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
        [CODE, yearEnd],
      )
    ).rows[0]!.id,
  )
  // 每一類一筆草稿：系辦清單連草稿也列，夠證明分頁接的是既有清單。
  for (const [placement, title] of Object.entries(TITLE)) {
    await pool.query(
      `insert into managed_items (id, cohort_id, placement, audience_kind, title, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'public', $3, 'system')`,
      [cohortId, placement, title],
    )
  }
})

test.afterAll(async () => {
  await pool?.end()
})

function location(response: APIResponse): string {
  const value = response.headers()['location']
  expect(value, '轉址要帶 location').toBeTruthy()
  const url = new URL(value!, BASE_URL)
  return url.pathname + url.search
}

async function asAdmin(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: '後台導覽' })

// ── 舊網址轉址：每條三種身分（AC-C2-03、04、06） ──

const OLD_URLS = [
  { from: '/dashboard/admin/settings', to: '/dashboard/admin/cohorts' },
  { from: '/dashboard/admin/settings?cohort=115', to: '/dashboard/admin/cohorts?cohort=115' },
  { from: '/dashboard/admin/affairs?placement=resource&cohort=115', to: '/dashboard/admin/affairs/resources?cohort=115' },
  { from: '/dashboard/admin/affairs?placement=submission', to: '/dashboard/admin/affairs/assignments' },
  { from: '/dashboard/admin/affairs?placement=requirement', to: '/dashboard/admin/affairs/assignments' },
  { from: '/dashboard/admin/affairs?cohort=115&placement=rules', to: '/dashboard/admin/affairs/rules?cohort=115' },
  // C2-07（AC-C2-08）：帳號列表的舊狀態篩選轉到「待審核」「已停用」分頁。
  { from: `/dashboard/admin/accounts?status=pending&q=${encodeURIComponent('王')}`, to: `/dashboard/admin/accounts/pending?q=${encodeURIComponent('王')}` },
  { from: '/dashboard/admin/accounts?status=disabled', to: '/dashboard/admin/accounts/disabled' },
  // C2-17（AC-C2-04）：首頁設定搬到前台編輯模式，舊網址回前台首頁。
  { from: '/dashboard/admin/home-settings', to: '/' },
  // ①C1-09（AC-14a）：「榮譽」篩選搬到成果展示分頁的榮譽榜區。
  { from: '/dashboard/admin/affairs?placement=honor', to: '/dashboard/admin/showcase' },
  // C2-22（AC-C2-07）：舊同意書頁轉到作業分頁（同意書做進作業，C1-11）；接手 `pages.spec.ts` PROTECTED 拿掉的 `/signoff` 一列。
  { from: '/dashboard/admin/signoff', to: '/dashboard/admin/affairs/assignments' },
  { from: '/dashboard/admin/signoff?cohort=115', to: '/dashboard/admin/affairs/assignments?cohort=115' },
] as const

for (const { from, to } of OLD_URLS) {
  test(`${from}：系辦 307 到 ${to}`, async ({ request }) => {
    const { cookie } = await sharedTestSession(request, 'admin')
    const response = await request.get(from, { headers: { cookie }, maxRedirects: 0 })
    expect(REDIRECT).toContain(response.status())
    expect(response.status()).toBe(307)
    expect(location(response)).toBe(to)
  })

  test(`${from}：學生到 /403，不會先被轉走`, async ({ request }) => {
    const { cookie } = await sharedTestSession(request, 'student')
    const response = await request.get(from, { headers: { cookie }, maxRedirects: 0 })
    expect(REDIRECT).toContain(response.status())
    expect(location(response)).toBe('/403')
  })

  test(`${from}：沒登入到登入頁`, async ({ request }) => {
    const response = await request.get(from, { maxRedirects: 0 })
    expect(REDIRECT).toContain(response.status())
    expect(location(response)).toMatch(/^\/login\?next=/)
  })
}

test('AC-14a：公告頁「種類」沒有「榮譽」、沒有榮譽說明與「新增榮譽」「管理歷屆榮譽」；榮譽在成果展示的榮譽榜區', async ({ page }) => {
  await asAdmin(page)
  const response = await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('navigation', { name: '種類' }).getByRole('link', { name: '公告', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation', { name: '種類' }).getByRole('link', { name: '榮譽', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('honor-list-hint')).toHaveCount(0)
  await expect(page.getByRole('link', { name: '新增榮譽' })).toHaveCount(0)
  await expect(page.getByText('管理歷屆榮譽')).toHaveCount(0)
  await page.goto(`/dashboard/admin/showcase?honor=${cohortId}`)
  await expect(page.getByTestId('honor-row').filter({ hasText: TITLE.honor })).toHaveCount(1)
})

test('帳號列表還在用的 ?status=active 不轉：200 留在全部帳號', async ({ request }) => {
  const { cookie } = await sharedTestSession(request, 'admin')
  const response = await request.get('/dashboard/admin/accounts?status=active', { headers: { cookie }, maxRedirects: 0 })
  expect(response.status()).toBe(200)
})

test('?placement= 是物件繼承來的屬性名（toString、constructor、__proto__）：不轉，200 留在公告頁', async ({ request }) => {
  const { cookie } = await sharedTestSession(request, 'admin')
  for (const placement of ['toString', 'constructor', '__proto__']) {
    const response = await request.get(`/dashboard/admin/affairs?placement=${placement}`, { headers: { cookie }, maxRedirects: 0 })
    expect(response.status(), placement).toBe(200)
  }
})

// ── 側欄與設定（AC-C2-01、02、03） ──

test('側欄六項不變；「設定」直接連屆別，點下去分頁列只有三個、「屆別」是目前頁', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin')
  const links = sidebar(page).getByRole('link')
  await expect(links).toHaveText(['首頁', '公告與作業', '分組', '成績', '帳號', '設定'])
  const settings = sidebar(page).getByRole('link', { name: '設定', exact: true })
  await expect(settings).toHaveAttribute('href', '/dashboard/admin/cohorts')

  await settings.click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/cohorts$/)
  const tabs = page.getByRole('navigation', { name: '設定分頁' }).getByRole('link')
  await expect(tabs).toHaveText(['屆別', '專題時程', '操作紀錄'])
  await expect(tabs.filter({ hasText: '屆別' })).toHaveAttribute('aria-current', 'page')
  await expect(sidebar(page).getByRole('link', { name: '設定', exact: true })).toHaveAttribute('aria-current', 'page')
})

test('打舊設定入口頁，瀏覽器落在屆別', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin/settings')
  expect(new URL(page.url()).pathname).toBe('/dashboard/admin/cohorts')
  await expect(page.getByTestId('tab-intro')).toContainText('每一屆的開始、旗標與狀態')
  await expect(page.getByRole('navigation', { name: '設定分頁' }).getByRole('link', { name: '屆別', exact: true })).toHaveAttribute('aria-current', 'page')
})

// ── 分頁列（AC-C2-05、07、08） ──

const TAB_GROUPS = [
  {
    nav: '公告與作業',
    tabs: [
      ['公告', '/dashboard/admin/affairs'],
      ['作業', '/dashboard/admin/affairs/assignments'],
      ['資源下載', '/dashboard/admin/affairs/resources'],
      ['專題規則', '/dashboard/admin/affairs/rules'],
      ['成果展示', '/dashboard/admin/showcase'],
      ['檔案', '/dashboard/admin/files'],
    ],
  },
  {
    nav: '分組',
    tabs: [
      ['全部組別', '/dashboard/admin/groups'],
      ['未分組學生', '/dashboard/admin/groups/unassigned'],
      ['產學合作', '/dashboard/admin/industry'],
    ],
  },
  {
    nav: '成績',
    tabs: [
      ['成績表', '/dashboard/admin/grading'],
      ['評分規則', '/dashboard/admin/grading/rules'],
      ['評分老師', '/dashboard/admin/grading/teachers'],
      ['結算', '/dashboard/admin/grading/settle'],
    ],
  },
] as const

for (const { nav, tabs } of TAB_GROUPS) {
  test(`「${nav}分頁」：${tabs.length} 個分頁依序、每頁 200、側欄「${nav}」亮、目前頁標 aria-current`, async ({ page }) => {
    await asAdmin(page)
    for (const [label, href] of tabs) {
      const response = await page.goto(`${href}?cohort=${cohortId}`)
      expect(response?.status(), href).toBe(200)
      const links = page.getByRole('navigation', { name: `${nav}分頁` }).getByRole('link')
      await expect(links).toHaveText(tabs.map(([l]) => l))
      for (const [i, [, h]] of tabs.entries()) await expect(links.nth(i)).toHaveAttribute('href', h)
      await expect(links.and(page.locator('[aria-current="page"]'))).toHaveText([label])
      await expect(sidebar(page).getByRole('link', { name: nav, exact: true })).toHaveAttribute('aria-current', 'page')
      await expect(page.getByTestId('tab-intro')).toHaveCount(1)
    }
  })
}

test('「帳號分頁」：四個分頁都 200、四個連結依序、側欄「帳號」亮、目前頁標 aria-current（AC-C2-08）', async ({ page }) => {
  await asAdmin(page)
  const tabs = [
    ['全部帳號', '/dashboard/admin/accounts'],
    ['待審核', '/dashboard/admin/accounts/pending'],
    ['已停用', '/dashboard/admin/accounts/disabled'],
    ['名單匯入', '/dashboard/admin/accounts/roster'],
  ] as const
  for (const [label, href] of tabs) {
    const response = await page.goto(href)
    expect(response?.status(), href).toBe(200)
    const links = page.getByRole('navigation', { name: '帳號分頁' }).getByRole('link')
    await expect(links).toHaveText(tabs.map(([l]) => l))
    for (const [i, [, h]] of tabs.entries()) await expect(links.nth(i)).toHaveAttribute('href', h)
    await expect(links.and(page.locator('[aria-current="page"]'))).toHaveText([label])
    await expect(sidebar(page).getByRole('link', { name: '帳號', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('tab-intro')).toContainText(FINGERPRINTS[href]!)
  }
})

test('打舊同意書網址（C2-22；AC-C2-07）：系辦落在作業分頁（分頁列「作業」是目前頁）；老師也到 /403', async ({ page, request }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/signoff?cohort=${cohortId}`)
  await expect(page).toHaveURL(`/dashboard/admin/affairs/assignments?cohort=${cohortId}`)
  await expect(page.getByTestId('tab-intro')).toContainText(FINGERPRINTS['/dashboard/admin/affairs/assignments']!)
  await expect(page.getByRole('navigation', { name: '公告與作業分頁' }).getByRole('link', { name: '作業', exact: true })).toHaveAttribute('aria-current', 'page')

  const { cookie } = await sharedTestSession(request, 'teacher')
  const response = await request.get('/dashboard/admin/signoff', { headers: { cookie }, maxRedirects: 0 })
  expect(REDIRECT).toContain(response.status())
  expect(location(response)).toBe('/403')
})

// ── 三個公告分頁接既有清單（AC-C2-05） ──

const PLACEMENT_TABS = [
  { path: '/dashboard/admin/affairs/assignments', shown: [TITLE.submission, TITLE.requirement] },
  { path: '/dashboard/admin/affairs/resources', shown: [TITLE.resource] },
  { path: '/dashboard/admin/affairs/rules', shown: [TITLE.rules] },
] as const

for (const { path, shown } of PLACEMENT_TABS) {
  test(`${path} 列出那一類的既有項目，別類不列`, async ({ page }) => {
    await asAdmin(page)
    await page.goto(`${path}?cohort=${cohortId}`)
    const rows = page.getByTestId('affair-row').filter({ hasText: CODE })
    await expect(rows).toHaveCount(shown.length)
    for (const title of shown) await expect(rows.filter({ hasText: title })).toHaveCount(1)
  })
}

test('專題規則分頁每列有上移、下移（只有一章時都停用）', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs/rules?cohort=${cohortId}`)
  const row = page.getByTestId('affair-row').filter({ hasText: TITLE.rules })
  await expect(row.getByRole('button', { name: `上移「${TITLE.rules}」` })).toBeDisabled()
  await expect(row.getByRole('button', { name: `下移「${TITLE.rules}」` })).toBeDisabled()
})

test('公告頁的「種類」只剩 全部／公告／逾期（榮譽搬到成果展示，C1-09）', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await expect(page.getByRole('navigation', { name: '種類' }).getByRole('link')).toHaveText(['全部', '公告', '逾期'])
})
