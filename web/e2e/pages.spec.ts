import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { FINGERPRINTS } from './fingerprints'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

/**
 * S01-04：頁面骨架、側欄與授權導向（票 #47 第 3 節那張表）。
 *
 * 這裡測的是**導向與可達性**，不是功能：每一頁都還是空狀態。
 * 身分用真的註冊 API 拿真的 session cookie，再把角色直接寫進資料庫（見 `session.ts`）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

/**
 * 整個檔案跑在同一個 worker 裡。
 *
 * 理由不是「測試會互相干擾」，而是 Better Auth 內建的限速對 `/api/auth/*` 是全域的
 * （正式模式預設開著）：每個 worker 各自註冊一輪測試帳號很快就會撞到 429。
 * 同一個 worker 才共用得到 `sharedTestSession` 的快取，全檔只註冊四個帳號。
 */
test.describe.configure({ mode: 'serial' })

async function signInAs(page: Page, role: TestRole | null) {
  const session = await sharedTestSession(page.request, role)
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  return session
}

test.describe('不登入', () => {
  const publicRoutes = ['/', '/login', '/register', '/403']

  for (const route of publicRoutes) {
    test(`${route} 打得開`, async ({ page }) => {
      const response = await page.goto(route)
      expect(response?.status()).toBe(200)
      await expect(page.locator('h1, h2, h3').first()).toBeVisible()
    })
  }

  test('三個後台都被導到登入頁，而且記得原本要去哪', async ({ page }) => {
    for (const route of ['/dashboard/admin', '/dashboard/teacher', '/dashboard/student']) {
      await page.goto(route)
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(route).replace(/%/g, '%')}`))
    }
  })

  test('後台的子頁一樣被導到登入頁（不是只有首頁有保護）', async ({ page }) => {
    await page.goto('/dashboard/admin/accounts')
    await expect(page).toHaveURL(/\/login\?next=/)
  })

  test('/account 需要登入', async ({ page }) => {
    await page.goto('/account')
    await expect(page).toHaveURL(/\/login\?next=/)
  })

  test('/register/pending 需要登入（票 7：看的是自己的申請）', async ({ page }) => {
    await page.goto('/register/pending')
    await expect(page).toHaveURL(/\/login\?next=%2Fregister%2Fpending/)
  })

  test('/register/verify、/register/apply 需要登入（VB-3：註冊第 2、3 步是本人的帳號）', async ({ page }) => {
    await page.goto('/register/verify')
    await expect(page).toHaveURL(/\/login\?next=%2Fregister%2Fverify/)
    await page.goto('/register/apply')
    await expect(page).toHaveURL(/\/login\?next=%2Fregister%2Fapply/)
  })
})

test.describe('以 A1（管理員）', () => {
  test('看得到管理員首頁與側欄，側欄有「帳號」「設定」', async ({ page }) => {
    await signInAs(page, 'admin')
    const response = await page.goto('/dashboard/admin')
    expect(response?.status()).toBe(200)

    // 首頁頂端是歡迎色塊（2026-09-25 對齊原型），h1 是「歡迎回來，<姓名>」。
    await expect(page.getByRole('heading', { name: /^歡迎回來，/ })).toBeVisible()
    // 桌機視窗下只有展開的那份側欄在可及性樹裡；分頁列有同名連結，所以 scope 到「後台導覽」（SH-1-AD）。
    const nav = page.getByRole('navigation', { name: '後台導覽' })
    await expect(nav.getByRole('link', { name: '帳號', exact: true })).toHaveAttribute(
      'href',
      '/dashboard/admin/accounts',
    )
    // 「設定」直接進「屆別」分頁（C 階段規格② §2.3；舊入口頁 `/settings` 轉過去，見 admin-redirects.spec）。
    await expect(nav.getByRole('link', { name: '設定', exact: true })).toHaveAttribute(
      'href',
      '/dashboard/admin/cohorts',
    )
  })

  test('側欄不分組；「首頁設定」不在側欄（SH-1-AD）', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.goto('/dashboard/admin')
    const nav = page.getByRole('navigation', { name: '後台導覽' })
    await expect(nav.getByRole('link', { name: '首頁', exact: true })).toBeVisible()
    await expect(nav.locator('[data-sidebar="group-label"]')).toHaveCount(0)
    await expect(nav.getByRole('link', { name: '首頁設定', exact: true })).toHaveCount(0)
  })

  test('點進「帳號」與「屆別」打得開，是真的列表而不是假資料', async ({ page }) => {
    await signInAs(page, 'admin')

    // 帳號頁在票 9 已經是真功能（見 accounts.spec.ts）；這裡只確認打得開、有真的列表。
    await page.goto('/dashboard/admin/accounts')
    await expect(page.getByRole('heading', { name: '帳號', exact: true })).toBeVisible()
    await expect(page.getByRole('table', { name: '帳號列表' })).toBeVisible()

    // 屆別頁在票 5 已經是真功能（見 cohorts.spec.ts）；這裡只確認打得開、沒有假資料。
    await page.goto('/dashboard/admin/cohorts')
    await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '新增屆別' })).toBeVisible()
  })

  test('開老師與學生的後台會被帶到 403，下一步指回自己的首頁', async ({ page }) => {
    await signInAs(page, 'admin')
    for (const route of ['/dashboard/teacher', '/dashboard/student']) {
      await page.goto(route)
      await expect(page).toHaveURL(/\/403$/)
      await expect(page.getByRole('link', { name: '回到自己的首頁' })).toHaveAttribute(
        'href',
        '/dashboard/admin',
      )
    }
  })
})

test.describe('以 S01（學生）', () => {
  test('開 /dashboard/admin/accounts 會被帶到 403，下一步指回學生首頁', async ({ page }) => {
    await signInAs(page, 'student')
    await page.goto('/dashboard/admin/accounts')

    await expect(page).toHaveURL(/\/403$/)
    await expect(page.getByRole('link', { name: '回到自己的首頁' })).toHaveAttribute(
      'href',
      '/dashboard/student',
    )
  })

  test('側欄沒有「成績」；直接開成績網址看到說明，不是死路（第三波 Q7③）', async ({ page }) => {
    await signInAs(page, 'student')
    await page.goto('/dashboard/student')
    const nav = page.getByRole('navigation', { name: '後台導覽' })
    await expect(nav.getByRole('link', { name: '交作業', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: '成績', exact: true })).toHaveCount(0)

    const grading = await page.request.get('/dashboard/student/grading', { maxRedirects: 0 })
    expect([302, 303, 307, 308]).toContain(grading.status())
    expect(grading.headers()['location']).toMatch(/\/dashboard\/student$/)
    expect(await grading.text()).not.toContain('分數')
  })

  test('自己的後台與帳號頁都打得開', async ({ page }) => {
    await signInAs(page, 'student')
    expect((await page.goto('/dashboard/student'))?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: /^歡迎回來，/ })).toBeVisible()

    expect((await page.goto('/account'))?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: '我的帳號' })).toBeVisible()
    // C2-13：帳號頁在後台外殼裡（學生側欄、沒有前台主導覽），三張卡、沒有「帳號狀態」卡。
    await expect(page.getByRole('navigation', { name: '後台導覽' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '主導覽', exact: true })).toHaveCount(0)
    for (const name of ['頭像', '基本資料']) await expect(page.getByRole('region', { name })).toBeVisible()
    await expect(page.getByRole('heading', { name: '登入方式' })).toBeVisible()
    await expect(page.getByText('帳號狀態')).toHaveCount(0)
  })

  test('帳號頁的基本資料照原型兩欄成對（桌面同一列、手機依序堆疊）', async ({ page }) => {
    // 不用共用帳號：CI 只有一個 worker，共用學生帳號會跨檔沿用，先跑的 item-delete.spec 會替它補上
    // 學號與屆別，「姓名」旁邊就變成「學號」、登入 Email 被擠到下一列。這裡要一個確定沒有個人資料的學生。
    const session = await createTestSession(page.request, 'student')
    await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
    const top = async (text: string) =>
      (await page.getByRole('region', { name: '基本資料' }).getByText(text, { exact: true }).first().boundingBox())!.y
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/account')
    // 第一列：姓名｜下一格（這個測試帳號沒有個人資料，下一格是登入 Email）。
    expect(Math.abs((await top('姓名')) - (await top('登入 Email')))).toBeLessThan(2)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/account')
    expect((await top('登入 Email')) - (await top('姓名'))).toBeGreaterThan(20)
  })
})

test.describe('以 T1（老師）', () => {
  test('老師首頁與帳號頁都打得開', async ({ page }) => {
    await signInAs(page, 'teacher')
    expect((await page.goto('/dashboard/teacher'))?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: /^歡迎回來，/ })).toBeVisible()

    expect((await page.goto('/account'))?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: '我的帳號' })).toBeVisible()
  })

  test('公開首頁沒有「我的工作」：右上角只有一顆「我的後台」指回老師後台（C2-14）', async ({ page }) => {
    await signInAs(page, 'teacher')
    await page.goto('/')
    await expect(page.getByRole('region', { name: '我的工作' })).toHaveCount(0)
    await expect(page.getByTestId('home-deadlines-elsewhere')).toHaveCount(0)
    await expect(page.getByRole('banner').getByRole('link', { name: '我的後台' })).toHaveAttribute('href', '/dashboard/teacher')
  })
})

/** `main` 裡每個區塊的名稱（`aria-label` 或 `aria-labelledby` 指到的標題），照頁面順序。 */
async function mainRegionNames(page: Page): Promise<string[]> {
  return page.locator('main section').evaluateAll((sections) =>
    sections
      .map((s) => s.getAttribute('aria-label') ?? document.getElementById(s.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() ?? '')
      .filter(Boolean),
  )
}

test.describe('AC-C2-33：登入後的前台跟訪客一樣', () => {
  test('學生的首頁區塊＝訪客的＋「歷屆專題一覽」；右上角只有「我的後台」，沒有頭像選單；沒有 CSP 違規', async ({ page }) => {
    await page.goto('/')
    const guest = await mainRegionNames(page)
    expect(guest).not.toContain('我的工作')

    const csp: string[] = []
    page.on('console', (m) => {
      if (/Content Security Policy|Content-Security-Policy/i.test(m.text())) csp.push(m.text())
    })
    await signInAs(page, 'student')
    await page.goto('/')
    const student = await mainRegionNames(page)
    expect(student.filter((n) => !guest.includes(n))).toEqual(['歷屆專題一覽'])
    expect(guest.filter((n) => !student.includes(n))).toEqual([])

    const nav = page.getByRole('navigation', { name: '主導覽', exact: true })
    await expect(nav.getByRole('link', { name: '歷屆專題', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: '產學合作' })).toBeVisible()
    const banner = page.getByRole('banner')
    await expect(banner.getByRole('link', { name: '我的後台' })).toHaveAttribute('href', '/dashboard/student')
    await expect(page.getByRole('button', { name: '帳號選單' })).toHaveCount(0)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('menuitem')).toHaveCount(0)
    // 頁首唯一的圖是系網 logo，沒有頭像。
    await expect(banner.locator('img')).toHaveCount(1)
    expect(csp).toEqual([])
  })
})

test.describe('臨時密碼還沒改的人', () => {
  test('公開首頁跟訪客一樣：沒有「我的工作」，也沒有產學合作與檔案下載的入口', async ({ page }) => {
    const ownerUrl = process.env.DATABASE_URL_OWNER
    if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能把測試帳號改成必須改密')
    // 不用共用帳號：這一條要把帳號改成必須改密，會影響別的測試。
    const session = await createTestSession(page.request, 'student')
    const pool = new Pool({ connectionString: ownerUrl, max: 1 })
    try {
      await pool.query('update users set must_change_password = true where id = $1', [session.userId])
    } finally {
      await pool.end()
    }
    await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('region', { name: '我的工作' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '檔案下載' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '產學合作' })).toHaveCount(0)
    await expect(page.getByRole('region', { name: '快速入口' }).getByRole('link', { name: '更改密碼' })).toHaveAttribute(
      'href',
      '/account/change-password',
    )
    // 頁首右上角的入口也是「更改密碼」，不是會被導走的「我的專題事務」。
    const banner = page.getByRole('banner')
    await expect(banner.getByRole('link', { name: '更改密碼' }).first()).toHaveAttribute('href', '/account/change-password')
    await expect(banner.getByRole('link', { name: '我的後台' })).toHaveCount(0)
  })
})

test.describe('待審核的人（有 session 但還沒核准）', () => {
  // VB-3：沒驗證 Email、沒送申請的密碼帳號會先被帶去 /register/verify；這裡測的是「已驗證、還沒核准」的人。
  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: BASE_URL })
    const session = await sharedTestSession(request, null).finally(() => request.dispose())
    const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 1 })
    try {
      await owner.query('update users set email_verified = true where id = $1', [session.userId])
    } finally {
      await owner.end()
    }
  })

  test('開後台會被帶到等待審核頁，不是 403', async ({ page }) => {
    await signInAs(page, null)
    await page.goto('/dashboard/student')
    // 這個測試帳號是直接打註冊 API 建的，沒有申請資料：等待審核頁再把他帶到第 3 步補填（VB-6；visitor-r3）。
    await expect(page).toHaveURL(/\/register\/apply$/)
  })

  test('公開首頁跟訪客一樣：沒有「我的工作」、歷屆專題，也沒有產學合作與檔案下載的入口', async ({ page }) => {
    await signInAs(page, null)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('region', { name: '我的工作' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '歷屆專題一覽' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '檔案下載' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '產學合作' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: '申請進度' }).first()).toHaveAttribute('href', '/register/pending')
  })
})

test.describe('手機寬度', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('學生首頁：側欄收合、內容單欄、沒有橫向捲動', async ({ page }) => {
    await signInAs(page, 'student')
    await page.goto('/dashboard/student')

    // 側欄的桌機版導覽在窄螢幕是收起來的；只剩頂列一顆「側欄選單」，按了才從左邊滑出來。
    await expect(page.getByRole('navigation', { name: '後台導覽' })).toBeHidden()
    await page.getByRole('button', { name: '側欄選單' }).click()
    await expect(page.getByRole('navigation', { name: '後台導覽' }).getByRole('link', { name: '組別', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    expect(overflows, '窄螢幕不應該出現橫向捲動').toBe(false)
  })

  test('管理員的帳號表格自己捲，頁面本體不捲', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.goto('/dashboard/admin/accounts')

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    expect(overflows).toBe(false)
  })
})

test.describe('直接打 HTTP 的負向情境（回歸測試）', () => {
  /**
   * 這一組是回歸測試，抓的是一個真的漏過的洞。
   *
   * 原本的寫法是把角色檢查放在 layout（不合格就改渲染 403 畫面，後來改成 redirect）。
   * 畫面都是對的，但 **App Router 會把 layout 與底下的 page 並行渲染**：
   * layout 丟掉 `children` 也好、redirect 也好，那一頁都已經被做出來，
   * 內容跟著 RSC payload 一起送到瀏覽器——畫面看不到，view-source 看得到。
   *
   * 修法是把角色檢查移到**每一頁自己**。下面逐條走 `PROTECTED_ROUTES`，
   * 用「沒有 cookie」與「角色不對的 cookie」兩種身分，斷言回應裡沒有那一頁的任何內容。
   * 之後新增後台頁面忘了加守衛，這裡就會紅。
   */

  // 時間軸、專題事務、編輯器的指紋要有屆別才會出現（沒屆別時頁面只有「先去建屆別」的空狀態）。
  // 單跑這個檔在空庫上也要成立：沒有未封存的屆別就建一個。
  test.beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL_OWNER
    if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
    const pool = new Pool({ connectionString: ownerUrl, max: 1 })
    try {
      const found = await pool.query(`select 1 from cohorts where status <> 'archived' limit 1`)
      if (found.rowCount === 0) {
        await pool.query(
          `insert into cohorts (id, code, name, status, created_by_kind)
           values (gen_random_uuid(), $1, $1, 'preparing', 'system')`,
          [`PAGES-${Date.now().toString(36).toUpperCase()}`],
        )
      }
    } finally {
      await pool.end()
    }
  })

  // FINGERPRINTS 在 `fingerprints.ts`（SH-B10：與 identity-per-request、student-redirects 共用）。
  /** 與 `src/app/dashboard/_nav.ts` 的 `PROTECTED_ROUTES` 對應；新增頁面時兩邊一起補。 */
  const PROTECTED: { path: string; wrongRole: 'admin' | 'teacher' | 'student' }[] = [
    { path: '/dashboard/admin', wrongRole: 'student' },
    { path: '/dashboard/admin/accounts', wrongRole: 'student' },
    { path: '/dashboard/admin/cohorts', wrongRole: 'teacher' },
    { path: '/dashboard/teacher', wrongRole: 'student' },
    { path: '/dashboard/student', wrongRole: 'teacher' },
    { path: '/dashboard/admin/timeline', wrongRole: 'teacher' },
    // 模擬業務鐘只在測試站存在（CI 的 e2e 開著 BUSINESS_CLOCK_OVERRIDE_ENABLED）。
    { path: '/dashboard/admin/clock', wrongRole: 'student' },
    // 通知匣（票 12）。
    { path: '/dashboard/admin/inbox', wrongRole: 'student' },
    { path: '/dashboard/teacher/inbox', wrongRole: 'student' },
    { path: '/dashboard/student/inbox', wrongRole: 'teacher' },
    { path: '/dashboard/admin/groups', wrongRole: 'student' },
    { path: '/dashboard/student/groups', wrongRole: 'teacher' },
    { path: '/dashboard/teacher/groups', wrongRole: 'student' },
    { path: '/dashboard/admin/affairs', wrongRole: 'student' },
    { path: '/dashboard/admin/editor/new', wrongRole: 'teacher' },
    // 檔案管理（票 35）。
    { path: '/dashboard/admin/files', wrongRole: 'teacher' },
    // 作業區（票 17）。
    { path: '/dashboard/student/affairs', wrongRole: 'admin' },
    // 老師各組繳交狀態（票 22）：學生拿到的回應裡不能有矩陣。
    { path: '/dashboard/teacher/affairs', wrongRole: 'student' },
    // 合作案管理（票 20）。
    { path: '/dashboard/admin/industry', wrongRole: 'teacher' },
    // 評分（票 23）。
    { path: '/dashboard/admin/grading', wrongRole: 'teacher' },
    { path: '/dashboard/teacher/grading', wrongRole: 'student' },
    // 簽核與精選（票 25）。
    { path: '/dashboard/admin/signoff', wrongRole: 'student' },
    { path: '/dashboard/admin/showcase', wrongRole: 'student' },
    { path: '/dashboard/student/signoff', wrongRole: 'teacher' },
    // 操作紀錄（票 36）：老師與學生都不能讀全站稽核。
    { path: '/dashboard/admin/audit', wrongRole: 'teacher' },
    // 首頁設定（第三波 W3）。
    { path: '/dashboard/admin/home-settings', wrongRole: 'teacher' },
    // 評分規則子頁（AD-08）。
    { path: '/dashboard/admin/grading/rules', wrongRole: 'teacher' },
    // C 階段規格② 的新分頁（C2-01）；結算之前漏列，一起補。舊設定入口頁 `/settings` 移到 admin-redirects.spec。
    { path: '/dashboard/admin/affairs/assignments', wrongRole: 'student' },
    { path: '/dashboard/admin/affairs/resources', wrongRole: 'teacher' },
    { path: '/dashboard/admin/affairs/rules', wrongRole: 'student' },
    { path: '/dashboard/admin/groups/unassigned', wrongRole: 'teacher' },
    { path: '/dashboard/admin/grading/teachers', wrongRole: 'teacher' },
    { path: '/dashboard/admin/grading/settle', wrongRole: 'student' },
    { path: '/dashboard/admin/accounts/pending', wrongRole: 'student' },
    { path: '/dashboard/admin/accounts/disabled', wrongRole: 'teacher' },
    { path: '/dashboard/admin/accounts/roster', wrongRole: 'student' },
  ]

  for (const { path, wrongRole } of PROTECTED) {
    test(`${path}：沒有 cookie 拿不到任何內容`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 })
      expect([302, 303, 307, 308]).toContain(response.status())
      expect(response.headers()['location']).toContain('/login')
      expect(await response.text(), '回應裡不該有這一頁的內容').not.toContain(FINGERPRINTS[path]!)
    })

    test(`${path}：角色不對（${wrongRole}）拿不到任何內容`, async ({ request }) => {
      const session = await sharedTestSession(request, wrongRole)
      const response = await request.get(path, {
        headers: { cookie: session.cookie },
        maxRedirects: 0,
      })
      expect([302, 303, 307, 308]).toContain(response.status())
      expect(response.headers()['location']).toContain('/403')
      expect(await response.text(), '回應裡不該有這一頁的內容').not.toContain(FINGERPRINTS[path]!)
    })

    // 反向對照：有權限的人打開，指紋**一定要在**。不然頁面文字改了、指紋沒跟著改，
    // 上面兩條「不該有」就永遠成立、形同空轉（票 9 審查意見）。
    test(`${path}：有權限的人看得到指紋字串（上面兩條不是空轉）`, async ({ request }) => {
      const role = path.startsWith('/dashboard/admin') ? 'admin' : path.startsWith('/dashboard/teacher') ? 'teacher' : 'student'
      const session = await sharedTestSession(request, role)
      const response = await request.get(path, { headers: { cookie: session.cookie }, maxRedirects: 0 })
      expect(response.status()).toBe(200)
      expect(await response.text()).toContain(FINGERPRINTS[path]!)
    })
  }
})
