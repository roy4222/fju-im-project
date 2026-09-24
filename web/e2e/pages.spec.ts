import { expect, test, type Page } from '@playwright/test'
import { sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

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
})

test.describe('以 A1（管理員）', () => {
  test('看得到管理員首頁與側欄，側欄有「帳號」「屆別」', async ({ page }) => {
    await signInAs(page, 'admin')
    const response = await page.goto('/dashboard/admin')
    expect(response?.status()).toBe(200)

    await expect(page.getByRole('heading', { name: '系辦首頁' })).toBeVisible()
    // 側欄有兩份：行動版收在 <details> 裡、桌機版直接展開。
    // 桌機視窗下只有後者在可及性樹裡，所以這裡拿得到的就是看得見的那一份。
    await expect(page.getByRole('link', { name: '帳號', exact: true })).toHaveAttribute(
      'href',
      '/dashboard/admin/accounts',
    )
    await expect(page.getByRole('link', { name: '屆別', exact: true })).toHaveAttribute(
      'href',
      '/dashboard/admin/cohorts',
    )
  })

  test('點進「帳號」與「屆別」都是空狀態，不是假資料', async ({ page }) => {
    await signInAs(page, 'admin')

    await page.goto('/dashboard/admin/accounts')
    await expect(page.getByRole('heading', { name: '帳號', exact: true })).toBeVisible()
    await expect(page.getByText('這個功能還沒做').first()).toBeVisible()

    // 屆別頁在票 5 已經是真功能（見 cohorts.spec.ts）；這裡只確認打得開、沒有假資料。
    await page.goto('/dashboard/admin/cohorts')
    await expect(page.getByRole('heading', { name: '屆別', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '新增屆別' })).toBeVisible()
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

  test('自己的後台與帳號頁都打得開', async ({ page }) => {
    await signInAs(page, 'student')
    expect((await page.goto('/dashboard/student'))?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: '我的專題' })).toBeVisible()

    expect((await page.goto('/account'))?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: '我的帳號' })).toBeVisible()
  })
})

test.describe('以 T1（老師）', () => {
  test('老師首頁與帳號頁都打得開', async ({ page }) => {
    await signInAs(page, 'teacher')
    expect((await page.goto('/dashboard/teacher'))?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: '老師首頁' })).toBeVisible()

    expect((await page.goto('/account'))?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: '我的帳號' })).toBeVisible()
  })
})

test.describe('待審核的人（有 session 但還沒核准）', () => {
  test('開後台會被帶到等待審核頁，不是 403', async ({ page }) => {
    await signInAs(page, null)
    await page.goto('/dashboard/student')
    await expect(page).toHaveURL(/\/register\/pending$/)
    // 這個測試帳號是直接打註冊 API 建的，沒有申請資料：等待審核頁請他補送（票 7）。
    await expect(page.getByRole('heading', { name: '還沒送出申請資料' })).toBeVisible()
  })
})

test.describe('手機寬度', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('學生首頁：側欄收合、內容單欄、沒有橫向捲動', async ({ page }) => {
    await signInAs(page, 'student')
    await page.goto('/dashboard/student')

    // 側欄的桌機版導覽在窄螢幕是收起來的；只剩一個「選單」。
    await expect(page.getByText('選單', { exact: true })).toBeVisible()

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

  /** 每一條受保護路由上，只有有權限的人才看得到的一段字。 */
  const FINGERPRINTS: Record<string, string> = {
    '/dashboard/admin': '這一批只做骨架',
    '/dashboard/admin/accounts': '名單匯入、註冊審核、停用與臨時密碼',
    '/dashboard/admin/cohorts': '一屆專題從開放註冊到封存的整個流程',
    '/dashboard/teacher': '指導的組別、要評分的項目與待簽核',
    '/dashboard/student': '組別、要交的東西與截止日',
    '/dashboard/admin/timeline': '屆別的四個階段與獨立活動',
    '/dashboard/admin/clock': '把系統認定的「今天」設到任何一秒',
    '/dashboard/admin/inbox': '跟你有關的事件都會出現在這裡',
    '/dashboard/teacher/inbox': '跟你有關的事件都會出現在這裡',
    '/dashboard/student/inbox': '跟你有關的事件都會出現在這裡',
  }

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
  }
})
