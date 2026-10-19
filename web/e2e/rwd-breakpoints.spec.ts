import { expect, test, type Locator, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

/**
 * RWD 根因（規格④ C4-03）：
 * - AC-54／55：後台側欄 1024 起才常駐；768（iPad 直式）改成「側欄選單」鈕叫出，右欄標題不再被擠成「本 ‥」。
 * - AC-56：三角色首頁橫幅在 768 單欄、左欄夠寬；學生的「接下來」卡在下方，1024 起才分兩欄。
 * - AC-57：觸控裝置後台頂列四顆鈕 ≥ 44×44；桌機維持原尺寸。
 * - AC-61：body 用 `overflow-x: clip`（不是 hidden），關掉遮罩後 440 首頁沒有真溢位。
 * - AC-71：觸控裝置前台漢堡、篩選 chip、麵包屑（含透明延伸區）、側欄文章連結 ≥ 44。
 *
 * 截圖：設 `RWD_SHOT_DIR` 才存。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const SHOT_DIR = process.env.RWD_SHOT_DIR

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `RWDB-${stamp}`
const CATEGORY = `RWD分類${stamp}`
const HOMES: Record<TestRole, string> = { admin: '/dashboard/admin', teacher: '/dashboard/teacher', student: '/dashboard/student' }
const TOUCH = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } }

function shot(name: string): string | undefined {
  return SHOT_DIR ? `${SHOT_DIR}/${name}.png` : undefined
}

async function signInAs(page: Page, role: TestRole) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, role)).cookie, BASE_URL)])
}

async function size(locator: Locator) {
  await expect(locator).toBeVisible()
  const box = (await locator.boundingBox())!
  return { width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 }
}

/** 頂列四顆：側欄開關、深色切換、通知鈴、帳號鈕。 */
function topBar(page: Page) {
  const header = page.locator('header.dash-header')
  return {
    trigger: header.locator('[data-sidebar="trigger"]'),
    theme: header.getByTestId('dash-theme-toggle'),
    bell: header.getByTestId('inbox-bell'),
    account: header.getByRole('button', { name: '帳號選單' }),
  }
}

test.describe('後台側欄與橫幅斷點', () => {
  test('AC-54：768 寬系辦首頁，側欄收起、「側欄選單」鈕可見、右欄標題完整', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto(HOMES.admin)
    await expect(page.getByRole('button', { name: '側欄選單' })).toBeVisible()
    await expect(page.locator('nav[aria-label="後台導覽"]')).toBeHidden()
    const title = page.getByRole('heading', { level: 2, name: '本屆分組', exact: true })
    await expect(title).toBeVisible()
    // `truncate` 的標題：沒被截斷才是完整的（不是「本 ‥」）。
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

    // 按鈕叫得出側欄。
    await page.getByRole('button', { name: '側欄選單' }).click()
    await expect(page.locator('nav[aria-label="後台導覽"]')).toBeVisible()
  })

  test('AC-55：1024 寬系辦首頁，側欄常駐', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto(HOMES.admin)
    await expect(page.locator('nav[aria-label="後台導覽"]')).toBeVisible()
  })

  for (const role of ['admin', 'teacher', 'student'] as const) {
    test(`AC-56：768 寬${role}首頁，橫幅單欄、左欄 ≥ 400px、h1 不是一字一行`, async ({ page }) => {
      await signInAs(page, role)
      await page.setViewportSize({ width: 768, height: 1024 })
      await page.goto(HOMES[role])
      const hero = page.locator('section.hero')
      const h1 = hero.getByRole('heading', { level: 1 })
      await expect(h1).toBeVisible()
      const left = h1.locator('xpath=..')
      expect((await left.boundingBox())!.width).toBeGreaterThanOrEqual(400)
      const lines = await h1.evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
      })
      expect(lines).toBe(1)
      const tracks = await hero.locator('> div.grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
      expect(tracks).toBe(1)
      await page.screenshot({ path: shot(`home-768-${role}`) })

      if (role === 'student') {
        const next = hero.getByTestId('hero-next')
        await expect(next).toBeVisible()
        // 「接下來」卡在左欄下方。
        expect((await next.boundingBox())!.y).toBeGreaterThanOrEqual((await left.boundingBox())!.y + (await left.boundingBox())!.height - 1)

        await page.setViewportSize({ width: 1024, height: 768 })
        await expect
          .poll(() => hero.locator('> div.grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length))
          .toBe(2)
      }
    })
  }
})

test.describe('觸控目標 44px', () => {
  test('準備：兩則同分類公告（內容頁側欄才有「同分類公告」）', async ({ page }) => {
    test.setTimeout(180_000)
    if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
    const pool = new Pool({ connectionString: ownerUrl, max: 1 })
    let cohortId: string
    try {
      const yearEnd = new Date(Date.now() + 300 * 86_400_000 + 8 * 3600_000).toISOString().slice(0, 10)
      cohortId = (
        await pool.query<{ id: string }>(
          `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
           values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
          [CODE, yearEnd],
        )
      ).rows[0]!.id
    } finally {
      await pool.end()
    }
    await signInAs(page, 'admin')
    for (const n of [1, 2]) {
      await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
      await page.locator('#ed-title').fill(`${CODE} 公告 ${n}`)
      await page.locator('#ed-body').fill('觸控目標測試。')
      await page.getByLabel('誰看得到').selectOption('public')
      await page.locator('#ed-category').fill(CATEGORY)
      await page.getByRole('button', { name: '發布', exact: true }).click()
      const check = page.getByRole('dialog', { name: '發布前檢查' })
      await check.getByRole('button', { name: '確認發布' }).click()
      await expect(check.getByRole('status')).toContainText('已發布')
    }
  })

  test.describe('觸控裝置', () => {
    test.use(TOUCH)

    test('AC-57：390 觸控，系辦後台頂列四顆 ≥ 44×44', async ({ page }) => {
      await signInAs(page, 'admin')
      await page.goto(HOMES.admin)
      const sizes: Record<string, { width: number; height: number }> = {}
      for (const [name, locator] of Object.entries(topBar(page))) {
        sizes[name] = await size(locator)
        expect(sizes[name].width, name).toBeGreaterThanOrEqual(44)
        expect(sizes[name].height, name).toBeGreaterThanOrEqual(44)
      }
      console.log('AC-57 觸控尺寸', JSON.stringify(sizes))
      await page.screenshot({ path: shot('admin-topbar-390') })
    })

    test('AC-71：390 觸控，前台漢堡、chip、麵包屑、文章連結 ≥ 44', async ({ page }) => {
      await page.context().clearCookies()
      const sizes: Record<string, unknown> = {}
      await page.goto('/')
      sizes.hamburger = await size(page.getByRole('button', { name: '開啟選單' }))
      await page.screenshot({ path: shot('front-390') })

      await page.goto(`/news?category=${encodeURIComponent(CATEGORY)}`)
      sizes.chip = await size(page.locator('a[aria-current="page"]').filter({ hasText: CATEGORY }))

      await page.getByRole('link', { name: `${CODE} 公告 1` }).first().click()
      await expect(page).toHaveURL(/\/news\/[0-9a-f-]+$/)
      const crumb = page.locator('nav[aria-label="麵包屑"] a').first()
      const crumbSize = await size(crumb)
      const reach = await crumb.evaluate((a) => {
        const r = a.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const probes = { up: [cx, cy - 20], down: [cx, cy + 20], left: [cx - 20, cy], right: [cx + 20, cy] } as const
        return Object.fromEntries(
          Object.entries(probes).map(([k, [x, y]]) => [k, document.elementFromPoint(x, y)?.closest('a') === a]),
        )
      })
      sizes.crumb = { ...crumbSize, reach }
      const item = page.locator('.fju-list-item a').first()
      sizes.listItem = await size(item)
      console.log('AC-71 觸控尺寸', JSON.stringify(sizes))

      for (const key of ['hamburger', 'chip'] as const) {
        const s = sizes[key] as { width: number; height: number }
        expect(s.width, key).toBeGreaterThanOrEqual(44)
        expect(s.height, key).toBeGreaterThanOrEqual(44)
      }
      expect(crumbSize.height).toBeGreaterThanOrEqual(44)
      expect(reach).toEqual({ up: true, down: true, left: true, right: true })
      expect((sizes.listItem as { height: number }).height).toBeGreaterThanOrEqual(44)
    })
  })

  test('AC-57（桌機）：1280 滑鼠，頂列各鈕維持原尺寸', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(HOMES.admin)
    const { trigger, theme, bell, account } = topBar(page)
    for (const locator of [trigger, theme, bell]) expect(await size(locator)).toEqual({ width: 36, height: 36 })
    expect((await size(account)).height).toBe(36)
  })
})

test('AC-61：440 首頁，body 是 overflow-x: clip，關掉遮罩後沒有真溢位', async ({ page }) => {
  await page.context().clearCookies()
  await page.setViewportSize({ width: 440, height: 900 })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await page.evaluate(() => getComputedStyle(document.body).overflowX)).toBe('clip')
  const overflow = await page.evaluate(() => {
    for (const el of [document.documentElement, document.body, ...document.querySelectorAll('main')]) {
      ;(el as HTMLElement).style.setProperty('overflow-x', 'visible')
    }
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }
  })
  console.log('AC-61', JSON.stringify(overflow))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
})
