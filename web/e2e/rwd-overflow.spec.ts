import { expect, request as playwrightRequest, test, type Browser, type Locator, type Page, type Route } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie, type TestRole, type TestSession } from './session'

/**
 * RWD 走查（規格④ C4-11，設計方案 §8.6；驗收案例 AC-62、AC-73）。
 *
 * - AC-62：360／390／440／768／1024 五種寬度 × 清單頁，關掉遮罩後 `document.documentElement.scrollWidth ≤ clientWidth＋1`。
 *   「遮罩」只有 `html`、`body` 的 `overflow-x: clip` 與 `main.overflow-x-clip`；`table-container` 的 `overflow-x-auto`
 *   是故意的捲動，不關。關法用 CSSOM（`style.setProperty`）：nonce-only CSP 會擋 `page.addStyleTag`。
 *   每頁印一列 `scrollWidth`（PR 的表從這裡抄）；溢位時印出最寬的幾個元素，方便找是誰撐開的。
 * - AC-73：④全部合進後的端到端走一次，再用 `reducedMotion: 'reduce'` 走一次（每個效果走退路、功能一樣）。
 *   設 `RWD_SHOT_DIR` 才存連拍。
 * - 等 hydrate 完再量／再操作（同 nav-skeleton.spec 的 `hydrated()`）：慢機器上 load 時 React 還沒接手，
 *   延遲載入的特效、選單都還沒掛，量到的不是最後的版面。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const SHOT_DIR = process.env.RWD_SHOT_DIR

const WIDTHS = [360, 390, 440, 768, 1024] as const
const MISSING = '/rwd-c4-11-no-such-page'
const EGG = '恭喜發現彩蛋！資管系祝你專題順利 🎉'
const stamp = Date.now().toString(36).toUpperCase()
const CODE = `RWDO-${stamp}`

test.describe.configure({ mode: 'serial' })

const sessions = {} as Record<TestRole, TestSession>
let teacherItemId: string

async function shot(page: Page, name: string) {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png` })
}

function minute(offsetMs: number): Date {
  return new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000)
}

test.beforeAll(async () => {
  // 每個角色各用一個 request context：同一個 context 帶著上一個帳號的 cookie 再註冊會被 Origin 檢查擋。
  for (const role of ['admin', 'teacher', 'student'] as const) {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      sessions[role] = await sharedTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }

  // 老師的作業頁（`/dashboard/teacher/affairs/<id>`）：一份發給老師、名單上有這位老師的已發布作業。
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    const yearEnd = new Date(Date.now() + 300 * 86_400_000 + 8 * 3600_000).toISOString().slice(0, 10)
    const cohortId = (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
        [CODE, yearEnd],
      )
    ).rows[0]!.id
    const adminId = sessions.admin.userId
    const title = `${CODE} 指導老師期初資料（一段很長的標題，看手機版會不會被撐開）`
    const fields = [{ key: 'cv', type: 'file', label: '個人簡歷', required: true, fileRules: { allowedTypes: ['pdf'], maxMiB: 20 } }]
    teacherItemId = (
      await pool.query<{ id: string }>(
        `insert into managed_items
           (id, cohort_id, placement, audience_kind, receiver_unit, status, actual_opened_at, due_at,
            title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
         values (gen_random_uuid(), $1, 'submission', 'teachers', 'individual', 'draft', $2, $3,
                 $4, '一句話摘要', '<p>請在截止前上傳。</p>', $5::jsonb, 'user', $6, $6)
         returning id`,
        [cohortId, minute(-86_400_000), minute(10 * 86_400_000), title, JSON.stringify({ fields }), adminId],
      )
    ).rows[0]!.id
    const content = await pool.query<{ id: string }>(
      `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
       values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前上傳。</p>', $3) returning id`,
      [teacherItemId, title, adminId],
    )
    const schema = await pool.query<{ id: string }>(
      `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
       values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
      [teacherItemId, JSON.stringify({ fields }), adminId],
    )
    await pool.query(
      `update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`,
      [teacherItemId, content.rows[0]!.id, schema.rows[0]!.id],
    )
    await pool.query(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, 'user', $3, now(), 'auto', 'user', $4)`,
      [teacherItemId, cohortId, sessions.teacher.userId, adminId],
    )
  } finally {
    await pool.end()
  }
})

async function signIn(page: Page, role: TestRole | null) {
  await page.context().clearCookies()
  if (role) await page.context().addCookies([toPlaywrightCookie(sessions[role].cookie, BASE_URL)])
}

/**
 * 等這份文件 hydrate 完、主執行緒閒下來（同 nav-skeleton.spec）：根 layout 的換頁骨架掛好監聽後標 `data-ready`；
 * 再等兩次 `requestIdleCallback`（上限 2 秒：CI 機器忙時不會一直等不到閒置），讓 hydration 後才掛的延遲特效與選單先排好版面。
 */
async function hydrated(page: Page) {
  await expect(page.locator('.nav-skeleton'), '根 layout 還沒 hydrate（.nav-skeleton 沒有 data-ready）').toHaveAttribute('data-ready', '', {
    timeout: 15_000,
  })
  for (let i = 0; i < 2; i++) await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 2000 })))
}

/** 關掉三處遮罩後量整頁寬度；溢位時順便列出右緣最遠的幾個元素。 */
async function measure(page: Page) {
  return page.evaluate(() => {
    for (const el of [document.documentElement, document.body, ...document.querySelectorAll('main')]) {
      ;(el as HTMLElement).style.setProperty('overflow-x', 'visible')
    }
    const root = document.documentElement
    const result = { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, culprits: [] as string[] }
    if (result.scrollWidth > result.clientWidth + 1) {
      result.culprits = [...document.body.querySelectorAll<HTMLElement>('*')]
        .map((el) => ({ el, right: el.getBoundingClientRect().right }))
        .filter((x) => x.right > result.clientWidth + 1)
        .sort((a, b) => b.right - a.right)
        .slice(0, 5)
        .map(({ el, right }) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join('.')} → ${Math.round(right)}`)
    }
    return result
  })
}

type Target = { name: string; role: TestRole | null; path: () => string; status?: number }

/** 設計方案 §8.6 的清單頁（`/404` 用不存在的網址；`/` 另量一次登入後的樣子，AC-73 的「1024 寬不溢位」）。 */
const TARGETS: Target[] = [
  { name: '/', role: null, path: () => '/' },
  { name: '/（學生登入）', role: 'student', path: () => '/' },
  { name: '/competitions', role: null, path: () => '/competitions' },
  { name: '/login', role: null, path: () => '/login' },
  { name: '/register', role: null, path: () => '/register' },
  { name: '/timeline', role: null, path: () => '/timeline' },
  { name: '/404', role: null, path: () => MISSING, status: 404 },
  { name: '/dashboard/admin', role: 'admin', path: () => '/dashboard/admin' },
  { name: '/dashboard/admin/accounts', role: 'admin', path: () => '/dashboard/admin/accounts' },
  { name: '/dashboard/admin/groups', role: 'admin', path: () => '/dashboard/admin/groups' },
  { name: '/dashboard/admin/affairs', role: 'admin', path: () => '/dashboard/admin/affairs' },
  { name: '/dashboard/admin/files', role: 'admin', path: () => '/dashboard/admin/files' },
  { name: '/dashboard/teacher', role: 'teacher', path: () => '/dashboard/teacher' },
  { name: '/dashboard/teacher/affairs/<id>', role: 'teacher', path: () => `/dashboard/teacher/affairs/${teacherItemId}` },
  { name: '/dashboard/student', role: 'student', path: () => '/dashboard/student' },
  { name: '/dashboard/student/affairs', role: 'student', path: () => '/dashboard/student/affairs' },
]

const table: string[] = []

test.afterAll(() => {
  if (table.length === 0) return
  console.log(['AC-62 scrollWidth（關遮罩；格內是 scrollWidth／clientWidth）', `| 頁面 | ${WIDTHS.join(' | ')} |`, `|---|${WIDTHS.map(() => '---').join('|')}|`, ...table].join('\n'))
})

test.describe('AC-62：五種寬度關掉遮罩沒有真溢位', () => {
  for (const target of TARGETS) {
    test(target.name, async ({ page }) => {
      test.setTimeout(120_000)
      await signIn(page, target.role)
      const cells: string[] = []
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width >= 768 ? 1024 : 844 })
        const response = await page.goto(target.path())
        expect(response?.status(), `${target.name} 的 HTTP 狀態`).toBe(target.status ?? 200)
        // 登入後的頁不能被導去別處（例如被導回登入頁，量到的就不是那一頁）。
        if (target.role) expect(new URL(page.url()).pathname).toBe(target.path().split('?')[0])
        await hydrated(page)
        const m = await measure(page)
        cells.push(`${m.scrollWidth}／${m.clientWidth}`)
        expect.soft(m.scrollWidth, `${target.name} @${width}：${m.culprits.join('、')}`).toBeLessThanOrEqual(m.clientWidth + 1)
        await shot(page, `overflow-${width}-${target.name.replace(/[^a-z0-9]+/gi, '_')}-${target.role ?? 'guest'}`)
      }
      table.push(`| ${target.name} | ${cells.join(' | ')} |`)
    })
  }
})

// ── AC-73：端到端 ───────────────────────────────────────────────────────────

const isRsc = (route: Route) => Boolean(route.request().headers()['rsc'])

/** 任何 CSS 顏色（含 oklch）轉成 `rgb(r, g, b)`（同 auth-look.spec）：畫到 1×1 canvas 再讀回來。 */
async function bgRgb(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const ctx = c.getContext('2d')!
    ctx.fillStyle = getComputedStyle(el).backgroundColor
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `rgb(${r}, ${g}, ${b})`
  })
}

async function journey(browser: Browser, reduce: boolean) {
  const tag = reduce ? 'reduce' : 'motion'
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 390, height: 844 }, reducedMotion: reduce ? 'reduce' : 'no-preference' })
  const page = await context.newPage()
  const csp: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) csp.push(msg.text())
  })
  try {
    // 1. 訪客 390 開首頁：照片＋淡 Pixel（減少動態不掛 canvas）。
    await page.goto('/')
    await hydrated(page)
    const homeHero = page.locator('section[aria-label="專題管理平台"]')
    await expect(homeHero.locator('img[data-testid=home-hero-image]')).toHaveCount(1)
    await expect(homeHero.locator('[data-testid=home-hero-pixel] canvas')).toHaveCount(reduce ? 0 : 1)
    await shot(page, `ac73-${tag}-01-home-390`)

    // 2. 漢堡：三層色塊（減少動態只淡入面板）。
    await page.getByRole('button', { name: '開啟選單' }).click()
    const menu = page.locator('dialog[open]')
    await expect(menu.locator('.sm-panel')).toBeVisible()
    await expect(menu.locator('.sm-layer')).toHaveCount(reduce ? 0 : 3)
    // 等滑入動畫跑完再拍，連拍才看得到停好的面板。
    await expect.poll(() => menu.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length)).toBe(0)
    await shot(page, `ac73-${tag}-02-menu`)

    // 3. 選單裡點「登入」：Glitch 背景、白卡、橘鈕、無頁尾。
    await menu.getByRole('link', { name: '登入', exact: true }).click()
    await expect(page).toHaveURL(/\/login$/)
    await hydrated(page)
    await expect(page.locator(reduce ? '.auth-glitch-static' : '[data-testid=letter-glitch] canvas')).toHaveCount(1)
    expect(await bgRgb(page.getByTestId('login-card').locator('> div').first())).toBe('rgb(255, 255, 255)')
    expect(await bgRgb(page.getByTestId('login-card').getByRole('button', { name: '登入', exact: true }))).toBe('rgb(229, 110, 0)')
    await expect(page.locator('footer')).toHaveCount(0)
    await shot(page, `ac73-${tag}-03-login`)

    // 4. 登入學生（登入表單本身由 login-*.spec 測；這裡直接帶 session）→ 回首頁，1024 寬不溢位。
    await context.addCookies([toPlaywrightCookie(sessions.student.cookie, BASE_URL)])
    await page.setViewportSize({ width: 1024, height: 900 })
    await page.goto('/')
    await hydrated(page)
    const banner = page.getByRole('banner')
    const home = await measure(page)
    expect(home.scrollWidth, home.culprits.join('、')).toBeLessThanOrEqual(home.clientWidth + 1)
    await shot(page, `ac73-${tag}-04-home-1024-student`)

    // 5. 從選單進學生後台（1024 登入後「我的後台」收在選單裡，C4-09）：回應延遲時看到骨架、頂列不消失。
    await page.route(
      (url) => url.pathname === '/dashboard/student',
      async (route) => {
        if (!isRsc(route)) return route.fallback()
        await new Promise((resolve) => setTimeout(resolve, 1500))
        await route.fallback().catch(() => {})
      },
    )
    await page.getByRole('button', { name: '開啟選單' }).click()
    await page.locator('dialog[open]').getByRole('link', { name: '我的後台' }).click()
    await expect(page.locator('.nav-skeleton')).toBeVisible()
    await expect(banner).toBeVisible()
    await shot(page, `ac73-${tag}-05-skeleton`)
    await expect(page).toHaveURL(/\/dashboard\/student$/)
    await expect(page.locator('html[data-nav-pending]')).toHaveCount(0, { timeout: 15_000 })
    await page.unroute((url) => url.pathname === '/dashboard/student')
    await hydrated(page)

    // 6. 橫幅 Pixel：常駐閃（相隔 1 秒畫面不同）、移入漣漪；減少動態不掛。
    const hero = page.getByRole('region', { name: '現在階段' })
    if (reduce) {
      await expect(hero.locator('canvas')).toHaveCount(0)
    } else {
      const pixel = hero.getByTestId('hero-pixel')
      await expect(pixel).toHaveAttribute('data-state', 'idle')
      const frame = () => page.locator('section.hero canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL())
      const first = await frame()
      await page.waitForTimeout(1000)
      expect(await frame()).not.toBe(first)
      const box = (await hero.boundingBox())!
      await page.mouse.move(box.x + box.width * 0.6, box.y + 12)
      await expect(pixel).toHaveAttribute('data-state', 'pulse', { timeout: 1000 })
    }
    await shot(page, `ac73-${tag}-06-dashboard`)

    // 7. 切深色：頁面 #1E2B40、側欄 #13305C、卡片 #2B4266。
    await page.getByRole('button', { name: '切換為深色' }).click()
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(30, 43, 64)')
    await expect(page.locator('[data-slot=sidebar-inner]').first()).toHaveCSS('background-color', 'rgb(19, 48, 92)')
    await expect(page.locator('.dash-card').first()).toHaveCSS('background-color', 'rgb(43, 66, 102)')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
    // 圓形擴開是 View Transition：跑完前截圖拍到的是舊（淺色）快照。
    await expect
      .poll(() => page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition')).length))
      .toBe(0)
    await shot(page, `ac73-${tag}-07-dark`)

    // 8. 768：側欄收起（「側欄選單」鈕叫出）、橫幅單欄。
    await page.setViewportSize({ width: 768, height: 1024 })
    await expect(page.getByRole('button', { name: '側欄選單' })).toBeVisible()
    await expect(page.locator('nav[aria-label="後台導覽"]')).toBeHidden()
    await expect
      .poll(() => page.locator('section.hero > div.grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length))
      .toBe(1)
    await shot(page, `ac73-${tag}-08-dashboard-768`)

    // 9. 不存在的網址：404、深藍、三段字（動態時抖動 canvas，減少動態是靜態漸層字）、回首頁可點。
    expect((await page.goto(MISSING))?.status()).toBe(404)
    await hydrated(page)
    await expect(page.getByTestId('not-found')).toBeVisible()
    await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(19, 48, 92)')
    await expect(page.getByTestId('fuzzy-text')).toHaveCount(3)
    await expect(page.locator('[data-testid=fuzzy-text] canvas')).toHaveCount(reduce ? 0 : 3)
    await shot(page, `ac73-${tag}-09-404`)
    await page.getByTestId('not-found').getByRole('link', { name: '回首頁' }).click()
    await expect(page).toHaveURL(`${BASE_URL}/`)

    // 10. 首頁連點 logo 10 次：訊息＋起飛（減少動態只有訊息）。
    await hydrated(page)
    const logo = page.locator('header a[data-egg-count]')
    for (let i = 1; i <= 10; i++) await logo.click()
    await expect(page.getByTestId('easter-egg')).toHaveText(EGG)
    await expect(page.locator('[data-fx=flying-button] canvas')).toHaveCount(reduce ? 0 : 1)
    await expect(page).toHaveURL(`${BASE_URL}/`)
    await shot(page, `ac73-${tag}-10-egg`)

    expect(csp).toEqual([])
  } finally {
    await context.close()
  }
}

test.describe('AC-73：端到端走一次', () => {
  test('動態', async ({ browser }) => {
    test.setTimeout(180_000)
    await journey(browser, false)
  })

  test('減少動態：每個效果走退路，功能一樣', async ({ browser }) => {
    test.setTimeout(180_000)
    await journey(browser, true)
  })
})
