import { expect, request as playwrightRequest, test, type Page, type Route } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 換頁載入骨架（C4-06，設計方案 §7；驗收案例 AC-44、AC-45、AC-47、AC-48、AC-66～AC-69）。
 *
 * - 慢：用 `page.route` 把目的頁的 RSC 回應（`rsc` 標頭，含預取）延後，看骨架何時出現、何時清掉。
 *   要在開頁**之前**掛：連結一出現 Next 就預取，預取先回來的話點下去是瞬間換頁。
 * - 「從未出現」：頁面裡掛 MutationObserver 記下每次 `html[data-nav-pending]` 出現的時間（`window.__navSeen`）。
 * - AC-46（訪客打後台仍 3xx）由 `pages.spec.ts` 的 PROTECTED 守門，這裡不重複。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const HOME = '/dashboard/student'
const AFFAIRS = '/dashboard/student/affairs'
const GROUPS = '/dashboard/student/groups'

test.describe.configure({ mode: 'serial' })

let student: TestSession
let admin: TestSession

test.beforeAll(async () => {
  // 每個帳號各用一個 request context：同一個 context 帶著上一個帳號的 cookie 再註冊會被 Origin 檢查擋。
  const fresh = async (role: 'student' | 'admin') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await sharedTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  student = await fresh('student')
  admin = await fresh('admin')
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

const isRsc = (route: Route) => Boolean(route.request().headers()['rsc'])

/** 把 `pathname`（可加 search 條件）的 RSC 回應延後 `ms`；頁面關掉或導覽取消時不報錯。 */
async function delayRsc(page: Page, pathname: string, ms: number, match: (url: URL) => boolean = () => true) {
  await page.route(
    (url) => url.pathname === pathname && match(url),
    async (route) => {
      if (!isRsc(route)) return route.fallback()
      await new Promise((resolve) => setTimeout(resolve, ms))
      await route.fallback().catch(() => {})
    },
  )
}

/**
 * 等這份文件 hydrate 完、主執行緒閒下來再操作。`goto`／`reload` 只等到 load，慢機器上這時 React 常還沒接手：
 * 骨架的點擊／popstate 監聽還沒掛（點了或返回都不出骨架）、Link 還是一般連結（整頁換頁）、
 * 塞進 `main` 的測試連結會被 hydration 洗掉、hydration 佔著主執行緒讓 150 ms 計時器晚觸發。
 * 先等骨架節點被 React 接手（`__reactFiber$`），再等一次 `requestIdleCallback`（排在 hydration 與 effect 之後）。
 */
async function hydrated(page: Page) {
  await expect
    .poll(() => skeleton(page).evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactFiber$'))))
    .toBe(true)
  await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 2000 })))
}

/** 記下 `data-nav-pending` 每次出現的時間與最近一次點擊／返回的時間（同一份文件內的換頁都記得到）。 */
async function watchPending(page: Page) {
  await hydrated(page)
  await page.evaluate(() => {
    const w = window as unknown as { __navSeen: number[]; __navClick: number }
    w.__navSeen = []
    w.__navClick = 0
    document.addEventListener('click', () => (w.__navClick = performance.now()), true)
    window.addEventListener('popstate', () => (w.__navClick = performance.now()))
    new MutationObserver(() => {
      if (document.documentElement.dataset.navPending) w.__navSeen.push(performance.now())
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-nav-pending'] })
  })
}

const seen = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __navSeen: number[]; __navClick: number }
    return { seen: w.__navSeen, click: w.__navClick }
  })

const sidebarLink = (page: Page, name: string) =>
  page.locator('[data-slot="sidebar"]').getByRole('link', { name, exact: true })
const pending = (page: Page) => page.locator('html[data-nav-pending="1"]')
const skeleton = (page: Page) => page.locator('.nav-skeleton')

async function expectShownWithin300ms(page: Page) {
  await expect(pending(page)).toHaveCount(1)
  const { seen: times, click } = await seen(page)
  expect(times.length).toBeGreaterThan(0)
  expect(times[0]! - click).toBeLessThan(300)
}

test('AC-44 慢的換頁：300 ms 內出現內容骨架，頂列與側欄還在；到了就清掉', async ({ page }) => {
  await signIn(page, student)
  await delayRsc(page, AFFAIRS, 1500)
  await page.goto(HOME)
  await watchPending(page)

  await sidebarLink(page, '交作業').click()
  await expectShownWithin300ms(page)
  await expect(skeleton(page)).toBeVisible()
  await expect(skeleton(page)).toHaveAttribute('role', 'status')
  await expect(skeleton(page).locator('.sr-only')).toHaveText('載入中')
  await expect(page.locator('.dash-header')).toBeVisible()
  await expect(sidebarLink(page, '組別')).toBeVisible()
  expect(await skeleton(page).locator('.nav-skeleton-bars > span').first().evaluate((el) => getComputedStyle(el).animationName)).toBe(
    'nav-skeleton-pulse',
  )
  await page.screenshot({ path: test.info().outputPath('skeleton-dashboard.png') })

  await page.waitForURL(`**${AFFAIRS}`)
  await expect(pending(page)).toHaveCount(0)
  await expect(skeleton(page)).toBeHidden()
})

test('AC-45 快的換頁（150 ms 內完成）：骨架從未出現', async ({ page }) => {
  await signIn(page, student)
  // 先走一次把 RSC 回應存起來，第二次直接回放：換頁時間不受伺服器快慢影響。
  const cached = new Map<string, { status: number; headers: Record<string, string>; body: Buffer }>()
  await page.route(
    (url) => url.pathname === AFFAIRS,
    async (route) => {
      if (!isRsc(route)) return route.fallback()
      const key = route.request().headers()['next-router-prefetch'] ? 'prefetch' : 'nav'
      const hit = cached.get(key)
      if (hit) return route.fulfill(hit)
      const response = await route.fetch()
      const entry = { status: response.status(), headers: response.headers(), body: await response.body() }
      cached.set(key, entry)
      await route.fulfill(entry)
    },
  )
  await page.goto(HOME)
  await hydrated(page)
  await sidebarLink(page, '交作業').click()
  await page.waitForURL(`**${AFFAIRS}`)
  // 第一次要是前端換頁（有 RSC 請求）才存得到；沒存到的話第二次會打到伺服器，就不是「快的換頁」了。
  expect(cached.has('nav')).toBe(true)

  await page.goto(HOME)
  await watchPending(page)
  await sidebarLink(page, '交作業').click()
  await page.waitForURL(`**${AFFAIRS}`)
  await page.waitForTimeout(500)
  expect((await seen(page)).seen).toEqual([])
  await expect(skeleton(page)).toBeHidden()
})

test('AC-47 減少動態：骨架照樣出現，但灰色塊不閃（animation-name: none）', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await signIn(page, student)
  await delayRsc(page, AFFAIRS, 1500)
  await page.goto(HOME)
  await watchPending(page)

  await sidebarLink(page, '交作業').click()
  await expectShownWithin300ms(page)
  await expect(skeleton(page)).toBeVisible()
  const names = await skeleton(page)
    .locator('.nav-skeleton-bars > span')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName))
  expect(names).toEqual(['none', 'none', 'none'])
  await page.waitForURL(`**${AFFAIRS}`)
  await expect(pending(page)).toHaveCount(0)
})

test('AC-48 另開分頁、按住修飾鍵、純 # 錨：都不出現骨架', async ({ page, context }) => {
  await signIn(page, student)
  await delayRsc(page, GROUPS, 1500)
  await page.goto(HOME)
  await watchPending(page)
  await page.evaluate((href) => {
    const blank = document.createElement('a')
    blank.href = href
    blank.target = '_blank'
    blank.id = 'e2e-blank'
    blank.textContent = '另開分頁'
    const hash = document.createElement('a')
    hash.href = '#e2e-anchor'
    hash.id = 'e2e-hash'
    hash.textContent = '頁內錨點'
    document.querySelector('main')!.prepend(blank, hash)
  }, GROUPS)

  const popup1 = context.waitForEvent('page')
  await page.locator('#e2e-blank').click()
  await (await popup1).close()

  const popup2 = context.waitForEvent('page')
  await sidebarLink(page, '組別').click({ modifiers: ['ControlOrMeta'] })
  await (await popup2).close()

  await page.locator('#e2e-hash').click()
  await expect(page).toHaveURL(/#e2e-anchor$/)

  await page.waitForTimeout(1000)
  expect((await seen(page)).seen).toEqual([])
  expect(new URL(page.url()).pathname).toBe(HOME)
})

test.describe('AC-66 同頁只換 ?page=', () => {
  const stamp = `navsk${Date.now().toString(36)}`
  let pool: Pool

  test.beforeAll(async () => {
    if (!ownerUrl) throw new Error('需要 DATABASE_URL_OWNER')
    pool = new Pool({ connectionString: ownerUrl, max: 1 })
    // 名單每頁 50 筆：造 55 個名字帶 stamp 的帳號，`?q=` 篩出來剛好兩頁。
    for (let i = 0; i < 55; i += 1) {
      await pool.query(
        `insert into users (id, name, email, email_verified, updated_at, status)
         values (gen_random_uuid(), $1, $2, true, now(), 'active')`,
        [`${stamp} ${i}`, `${stamp}-${i}@example.com`],
      )
    }
  })

  test.afterAll(async () => {
    await pool.query(`delete from users where email like $1`, [`${stamp}-%`])
    await pool.end()
  })

  test('系辦按「下一頁」：300 ms 內出現骨架，到 ?page=2 清掉', async ({ page }) => {
    await signIn(page, admin)
    await delayRsc(page, '/dashboard/admin/accounts', 1500, (url) => url.searchParams.get('page') === '2')
    await page.goto(`/dashboard/admin/accounts?q=${stamp}`)
    const next = page.getByRole('link', { name: '下一頁' })
    await expect(next).toBeVisible()
    await watchPending(page)

    await next.click()
    await expectShownWithin300ms(page)
    await expect(skeleton(page)).toBeVisible()
    await page.waitForURL(/[?&]page=2/)
    await expect(pending(page)).toHaveCount(0)
    await expect(skeleton(page)).toBeHidden()
  })
})

test('AC-67a 返回／前進命中快取：全程不閃骨架', async ({ page }) => {
  await signIn(page, student)
  await page.goto(HOME)
  await hydrated(page)
  await sidebarLink(page, '交作業').click()
  await page.waitForURL(`**${AFFAIRS}`)
  await expect(page.locator('main')).toBeVisible()

  await watchPending(page)
  await page.goBack()
  await page.waitForURL((url) => url.pathname === HOME)
  await page.goForward()
  await page.waitForURL(`**${AFFAIRS}`)
  await page.waitForTimeout(1000)
  expect((await seen(page)).seen).toEqual([])
})

test('AC-67b 重新載入後返回（快取未命中）：300 ms 內出現骨架，到了清掉，之後 2 秒不再出現', async ({ page }) => {
  await signIn(page, student)
  await page.goto(HOME)
  await hydrated(page)
  await sidebarLink(page, '交作業').click()
  await page.waitForURL(`**${AFFAIRS}`)
  await delayRsc(page, HOME, 1500)
  await page.reload()
  await watchPending(page)

  await page.goBack({ waitUntil: 'commit' })
  await expectShownWithin300ms(page)
  await expect(skeleton(page)).toBeVisible()

  await expect(page.locator('.dash-header')).toBeVisible()
  await expect(pending(page)).toHaveCount(0, { timeout: 5000 })
  expect(new URL(page.url()).pathname).toBe(HOME)
  const settled = (await seen(page)).seen.length
  await page.waitForTimeout(2000)
  expect((await seen(page)).seen.length).toBe(settled)
  await expect(skeleton(page)).toBeHidden()
})

test('AC-68 超過 8 秒：骨架留著並出現「仍在載入」與重新整理連結；回應到了才清', async ({ page }) => {
  test.setTimeout(60_000)
  await signIn(page, student)
  await delayRsc(page, AFFAIRS, 10_000)
  await page.goto(HOME)
  await watchPending(page)

  await sidebarLink(page, '交作業').click()
  await expect(pending(page)).toHaveCount(1)
  await expect(skeleton(page).getByText('仍在載入……')).toHaveCount(0)
  await page.waitForTimeout(9000)
  await expect(pending(page)).toHaveCount(1)
  await expect(skeleton(page)).toBeVisible()
  await expect(skeleton(page)).toContainText('仍在載入……')
  const reload = skeleton(page).getByRole('link', { name: '重新整理' })
  await expect(reload).toBeVisible()
  expect(await reload.getAttribute('href')).toBe(await page.evaluate(() => window.location.href))

  await page.waitForURL(`**${AFFAIRS}`, { timeout: 10_000 })
  await expect(pending(page)).toHaveCount(0)
  await expect(skeleton(page)).toBeHidden()
  await expect(skeleton(page).getByText('仍在載入……')).toHaveCount(0)
})

test('AC-69 快速連點：只有一個骨架，到第二頁就清，舊計時器不再讓它出現', async ({ page }) => {
  await signIn(page, student)
  await delayRsc(page, AFFAIRS, 1500)
  await page.goto(HOME)
  await watchPending(page)

  await sidebarLink(page, '交作業').click()
  await sidebarLink(page, '組別').click({ delay: 0 })
  await page.waitForURL(`**${GROUPS}`)
  await expect(pending(page)).toHaveCount(0)
  expect(await skeleton(page).count()).toBe(1)
  const settled = (await seen(page)).seen.length
  await page.waitForTimeout(2000)
  expect((await seen(page)).seen.length).toBe(settled)
  await expect(pending(page)).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe(GROUPS)
})

test('前台：訪客點主導覽，慢的換頁也出現內容骨架（頂列還在）', async ({ page }) => {
  await page.context().clearCookies()
  await delayRsc(page, '/rules', 1500)
  await page.goto('/')
  await watchPending(page)

  await page.getByRole('navigation', { name: '主導覽', exact: true }).getByRole('link', { name: '專題規則' }).click()
  await expectShownWithin300ms(page)
  await expect(skeleton(page)).toBeVisible()
  await expect(page.locator('header').first()).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('skeleton-front.png') })
  await page.waitForURL('**/rules')
  await expect(pending(page)).toHaveCount(0)
})

/**
 * 取消回歸（Review 第 1 輪）：慢的換頁還沒到就點回目前這一頁 → Next 取消那次導覽、網址不變，
 * 骨架不能留著（2.5 秒、8.5 秒都不能有，也不能冒出「仍在載入」）。
 */
async function expectCancelledClean(page: Page, here: string) {
  await page.waitForTimeout(2500)
  expect(new URL(page.url()).pathname).toBe(here)
  await expect(pending(page)).toHaveCount(0)
  await expect(skeleton(page)).toBeHidden()
  await page.waitForTimeout(6000)
  expect(new URL(page.url()).pathname).toBe(here)
  await expect(pending(page)).toHaveCount(0)
  await expect(skeleton(page)).toBeHidden()
  await expect(skeleton(page).getByText('仍在載入……')).toHaveCount(0)
}

test.describe('取消：慢的換頁途中點回目前這一頁，骨架不殘留', () => {
  test.setTimeout(60_000)

  test('學生：慢點「交作業」→ 立刻點「首頁」', async ({ page }) => {
    await signIn(page, student)
    await delayRsc(page, AFFAIRS, 10_000)
    await page.goto(HOME)
    await hydrated(page)
    await sidebarLink(page, '交作業').click()
    await page.waitForTimeout(100)
    await sidebarLink(page, '首頁').click()
    await expectCancelledClean(page, HOME)
  })

  test('前台：慢點「專題規則」→ 立刻點 logo', async ({ page }) => {
    await page.context().clearCookies()
    await delayRsc(page, '/rules', 10_000)
    await page.goto('/')
    await hydrated(page)
    await page.getByRole('navigation', { name: '主導覽', exact: true }).getByRole('link', { name: '專題規則' }).click()
    await page.waitForTimeout(100)
    await page.locator('header a[href="/"]').first().click()
    await expectCancelledClean(page, '/')
  })

  test('系辦：慢點「公告與作業」→ 立刻點「首頁」', async ({ page }) => {
    await signIn(page, admin)
    await delayRsc(page, '/dashboard/admin/affairs', 10_000)
    await page.goto('/dashboard/admin')
    await hydrated(page)
    await sidebarLink(page, '公告與作業').click()
    await page.waitForTimeout(100)
    await sidebarLink(page, '首頁').click()
    await expectCancelledClean(page, '/dashboard/admin')
  })
})
