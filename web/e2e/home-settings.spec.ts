import { expect, request as playwrightRequest, test, type Browser, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

/**
 * 第三波 W3：首頁設定（大圖＋兩行標語，存了就生效）；聯絡卡與頁尾換成系網資料（AC-15 首頁那半、AC-16～AC-20）。
 *
 * 1. 沒有設定時首頁跟改版前一字不差（AC-16）；聯絡卡、頁尾、忘記密碼頁是新的地址與電話，全站搜不到舊號碼（AC-20）。
 * 2. 系辦上傳圖、填圖片說明與兩行標語 → 預覽即時變 → 存檔；訪客重新整理就看到（AC-17）；換圖後舊圖「無法存取」（AC-18）。
 * 3. 兩個分頁：後存的被擋；恢復預設後首頁回原樣（AC-19）。
 * 4. 學生、老師打不開首頁設定。
 *
 * 首頁是全站共用的：這一檔改完一定恢復預設（UI 按「恢復預設」，`afterAll` 再用 owner 連線補一次保險），
 * 不影響 `smoke.spec`、`public-pages.spec` 對預設字的斷言（設計方案 §11 #12）。
 */

test.describe.configure({ mode: 'serial' })

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const stamp = Date.now().toString(36).toUpperCase()

const DEFAULT_LINE1 = '輔仁大學資訊管理學系專題管理平台'
const DEFAULT_LINE2 = '輔大資管系專題：從分組、提案到成果發表，公告、規則與歷屆作品都在這裡。'
const ADDRESS = '242 新北市新莊區中正路 510 號 利瑪竇大樓 LM306'
const PHONE = '02-2905-2666'
const SLOGAN = '透過機測、專題及產業實習讓學生動手做'

// 真的解得開的小圖（4×3，JPEG 與 PNG 各一）：首頁斷言 `naturalWidth > 0`，破圖不會混過去。
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAAAwAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAwAEAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A1KKKK/zTP9ED/9k=', 'base64')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAD0lEQVR4nGNgME5DIJwcAIc5By0Ywt6kAAAAAElFTkSuQmCC', 'base64')

async function signIn(page: Page, role: TestRole) {
  const session = await sharedTestSession(page.request, role)
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

/** 保險：直接把設定清回預設（四欄 null；不刪列，同「恢復預設」）。 */
async function forceDefaults() {
  if (!ownerUrl) return
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    await pool.query(
      `update home_settings set hero_file_id = null, hero_alt = null, tagline_line1 = null, tagline_line2 = null, revision = revision + 1
        where hero_file_id is not null or hero_alt is not null or tagline_line1 is not null or tagline_line2 is not null`,
    )
  } finally {
    await pool.end()
  }
}

/** 沒登入的訪客（或帶著某個登入狀態的人）開首頁。 */
async function visitorHome(browser: Browser, cookie?: string) {
  const context = await browser.newContext({ baseURL: BASE_URL })
  if (cookie) await context.addCookies([toPlaywrightCookie(cookie, BASE_URL)])
  const page = await context.newPage()
  await page.goto('/')
  return { page, close: () => context.close() }
}

/** 首頁大圖真的載入、解得開（不是 403 或破圖）。 */
async function expectHeroLoaded(page: Page) {
  await expect
    .poll(() => page.getByTestId('home-hero-image').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0)
}

async function anonymousStatus(path: string): Promise<number> {
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL })
  try {
    return (await api.get(path)).status()
  } finally {
    await api.dispose()
  }
}

/** 看得到的字與連結裡都沒有舊號碼（整份 HTML 含亂數 nonce 與檔名雜湊，可能剛好有這四個數字，不拿來比）。 */
async function expectNoOldPhone(page: Page) {
  expect(await page.locator('body').innerText(), page.url()).not.toContain('2696')
  await expect(page.locator('a[href*="2696"]')).toHaveCount(0)
}

async function uploadHero(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByLabel('選擇首頁大圖').setInputFiles({ name, mimeType, buffer })
  await expect(page.getByTestId('hero-name')).toContainText(name)
}

test.beforeAll(forceDefaults)
test.afterAll(forceDefaults)

test('沒有首頁設定時首頁跟改版前一樣；聯絡卡、頁尾、忘記密碼頁是系網的地址與電話（AC-16、AC-20）', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(DEFAULT_LINE1)
  await expect(page.getByTestId('home-hero-line2')).toHaveText(DEFAULT_LINE2)
  await expect(page.getByTestId('home-hero-image')).toHaveAttribute('src', '/placeholder/campus.jpg')

  const contact = page.getByRole('region', { name: '快速入口' })
  await expect(contact).toContainText(ADDRESS)
  await expect(contact).toContainText(`電話 ${PHONE}`)
  await expect(contact).toContainText(SLOGAN)
  await expect(contact.getByRole('link', { name: `電話 ${PHONE}` })).toHaveAttribute('href', 'tel:+886229052666')

  const footer = page.locator('footer')
  await expect(footer).toContainText(ADDRESS)
  await expect(footer).toContainText(`電話 ${PHONE}`)
  await expect(footer).toContainText(SLOGAN)
  await expect(footer.getByRole('link', { name: PHONE })).toHaveAttribute('href', 'tel:+886229052666')
  await expectNoOldPhone(page)

  await page.goto('/forgot-password')
  await expect(page.getByTestId('forgot-password')).toContainText(`電話 ${PHONE}`)
  await expect(page.getByTestId('forgot-password').getByRole('link', { name: PHONE })).toHaveAttribute('href', 'tel:+886229052666')
  await expectNoOldPhone(page)

  for (const path of ['/news', '/rules', '/honors', '/projects/featured', '/login']) {
    await page.goto(path)
    await expectNoOldPhone(page)
  }
})

test('首頁輪播沒有公開的優秀專題時，空狀態不說「系辦發布後」（AC-15 首頁那半）', async ({ page }) => {
  // 測試庫可能已有別的 spec 發布的得獎作品；那時輪播不是空的，這一條沒得驗。
  if (ownerUrl) {
    const pool = new Pool({ connectionString: ownerUrl, max: 1 })
    try {
      const found = await pool.query(`select 1 from showcase_entries where status = 'published' and award_level is not null limit 1`)
      test.skip((found.rowCount ?? 0) > 0, '測試庫已有公開的優秀專題，輪播不是空的')
    } finally {
      await pool.end()
    }
  }
  await page.goto('/')
  const featured = page.getByRole('region', { name: '優秀專題' })
  await expect(featured).toContainText('目前還沒有公開的優秀專題。')
  await expect(featured).not.toContainText('系辦發布')
  await expect(featured).not.toContainText('系辦公開')

  // 驗收 P-01：優秀專題頁的空狀態也不能叫訪客去登入後才能用的「歷屆專題一覽」。
  await page.goto('/projects/featured')
  const main = page.getByRole('main')
  await expect(main).toContainText('目前還沒有公開的優秀專題。')
  await expect(main).toContainText('可以先到榮譽榜看看歷屆的得獎消息。')
  await expect(main).not.toContainText('登入後')
  await expect(main).not.toContainText('歷屆專題一覽')
})

test('系辦換首頁大圖與標語：預覽即時變、存了就生效；換圖後舊圖無法存取（AC-17、AC-18）', async ({ page, browser, request }) => {
  const startedAt = new Date()
  await signIn(page, 'admin')
  await page.goto('/dashboard/admin/home-settings')
  await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible()

  const line1 = `E2E 首頁標語 ${stamp}`
  const line2 = `第二行說明 ${stamp}`
  const alt = `利瑪竇大樓外觀 ${stamp}`

  await uploadHero(page, `hero-a-${stamp}.jpg`, 'image/jpeg', JPG)
  await page.getByLabel(/^圖片說明/).fill(alt)
  await page.getByLabel(/^標語第一行/).fill(line1)
  await page.getByLabel(/^標語第二行/).fill(line2)

  // 預覽用表單當下的值（還沒存）。
  const preview = page.getByTestId('home-preview')
  await expect(preview.getByTestId('preview-line1')).toHaveText(line1)
  await expect(preview.getByTestId('preview-line2')).toHaveText(line2)
  await expect(preview.getByRole('img', { name: alt })).toHaveAttribute('src', /^blob:/)

  // 還沒存：訪客首頁不變。
  const before = await visitorHome(browser)
  await expect(before.page.getByRole('heading', { level: 1 })).toHaveText(DEFAULT_LINE1)
  await before.close()

  await page.getByRole('button', { name: '儲存並更新首頁' }).click()
  await expect(page.getByRole('status').filter({ hasText: '首頁已更新' })).toContainText('首頁已更新，訪客重新整理就會看到')

  const visitor = await visitorHome(browser)
  await expect(visitor.page.getByRole('heading', { level: 1 })).toHaveText(line1)
  await expect(visitor.page.getByTestId('home-hero-line2')).toHaveText(line2)
  const imageA = visitor.page.getByTestId('home-hero-image')
  await expect(imageA).toHaveAttribute('alt', alt)
  const srcA = await imageA.getAttribute('src')
  expect(srcA).toMatch(/^\/api\/files\/[0-9a-f-]{36}$/)
  await expectHeroLoaded(visitor.page)
  await visitor.close()
  expect(await anonymousStatus(srcA!)).toBe(200)

  // 待審的帳號（登入了但還不能用業務功能）開首頁一樣看得到大圖（Review：曾被帳號狀態閘門擋成 403）。
  // 另一個沒帶 cookie 的 request（page.request 帶著系辦的 cookie，註冊會被要求 Origin）。
  const pending = await createTestSession(request, null)
  const pendingHome = await visitorHome(browser, pending.cookie)
  await expect(pendingHome.page.getByRole('heading', { level: 1 })).toHaveText(line1)
  await expectHeroLoaded(pendingHome.page)
  await pendingHome.close()

  // 操作紀錄：home.updated（顯示用的中文名稱由用詞票另外對照，這裡直接查紀錄）。
  if (ownerUrl) {
    const pool = new Pool({ connectionString: ownerUrl, max: 1 })
    try {
      const audit = await pool.query(`select payload from audit_events where action = 'home.updated' and real_at >= $1 order by real_at desc limit 1`, [startedAt])
      expect(audit.rows[0]?.payload).toMatchObject({ line1, line2, heroAlt: alt })
    } finally {
      await pool.end()
    }
  }

  // 換成圖 B：B 公開、A 回到「無法存取」（跟其他非公開檔案一樣：訪客 401）。
  await page.reload()
  await uploadHero(page, `hero-b-${stamp}.png`, 'image/png', PNG)
  await page.getByLabel(/^圖片說明/).fill(`圖 B ${stamp}`)
  await page.getByRole('button', { name: '儲存並更新首頁' }).click()
  await expect(page.getByRole('status').filter({ hasText: '首頁已更新' })).toBeVisible()

  const after = await visitorHome(browser)
  const srcB = await after.page.getByTestId('home-hero-image').getAttribute('src')
  await expect(after.page.getByTestId('home-hero-image')).toHaveAttribute('alt', `圖 B ${stamp}`)
  await expectHeroLoaded(after.page)
  await after.close()
  expect(srcB).not.toBe(srcA)
  expect(await anonymousStatus(srcB!)).toBe(200)
  expect(await anonymousStatus(srcA!)).toBe(401)
})

test('兩個分頁同時改：後存的被擋；恢復預設後首頁回原樣（AC-19）', async ({ page, browser }) => {
  await signIn(page, 'admin')
  const second = await page.context().newPage()
  await page.goto('/dashboard/admin/home-settings')
  await second.goto('/dashboard/admin/home-settings')

  await page.getByLabel(/^標語第一行/).fill(`分頁一 ${stamp}`)
  await page.getByRole('button', { name: '儲存並更新首頁' }).click()
  await expect(page.getByRole('status').filter({ hasText: '首頁已更新' })).toBeVisible()

  await second.getByLabel(/^標語第一行/).fill(`分頁二 ${stamp}`)
  await second.getByRole('button', { name: '儲存並更新首頁' }).click()
  await expect(second.getByRole('alert').filter({ hasText: '剛被改過' })).toContainText('這份設定剛被改過，請重新整理再改')

  const visitor = await visitorHome(browser)
  await expect(visitor.page.getByRole('heading', { level: 1 })).toHaveText(`分頁一 ${stamp}`)
  await visitor.close()

  // 重新整理後恢復預設（危險區、先確認一次）。
  await second.reload()
  await second.getByRole('region', { name: '恢復預設' }).getByRole('button', { name: '恢復預設' }).click()
  const dialog = second.getByRole('dialog', { name: '恢復首頁預設？' })
  await expect(dialog).toContainText('不會保留')
  await dialog.getByRole('button', { name: '恢復預設' }).click()
  await expect(second.getByRole('status').filter({ hasText: '已恢復預設' })).toBeVisible()
  await expect(second.getByTestId('preview-line1')).toHaveText(DEFAULT_LINE1)

  const reset = await visitorHome(browser)
  await expect(reset.page.getByRole('heading', { level: 1 })).toHaveText(DEFAULT_LINE1)
  await expect(reset.page.getByTestId('home-hero-line2')).toHaveText(DEFAULT_LINE2)
  await expect(reset.page.getByTestId('home-hero-image')).toHaveAttribute('src', '/placeholder/campus.jpg')
  await expect(reset.page.getByTestId('home-hero-image')).toHaveAttribute('alt', '')
  await reset.close()
})

test('學生與老師打不開首頁設定', async ({ page }) => {
  for (const role of ['student', 'teacher'] as const) {
    await page.context().clearCookies()
    await signIn(page, role)
    await page.goto('/dashboard/admin/home-settings')
    await expect(page).toHaveURL(/\/403$/)
    await expect(page.getByRole('heading', { name: '設定', exact: true })).toHaveCount(0)
  }
})

test('首頁圖片屬性：hero 不 lazy、提早抓；卡片、榮譽大圖與底部建築照 lazy；都有寬高（第 1 批 AC-V27 ①②③ 首頁）', async ({ browser }) => {
  const { page, close } = await visitorHome(browser)
  try {
    const hero = page.getByTestId('home-hero-image')
    await expect(hero).not.toHaveAttribute('loading')
    await expect(hero).toHaveAttribute('fetchpriority', 'high')
    await expect(hero).toHaveAttribute('width', /^\d+$/)
    await expect(hero).toHaveAttribute('height', /^\d+$/)

    const building = page.getByTestId('quicklinks-photo')
    await expect(building).toHaveAttribute('loading', 'lazy')
    await expect(building).toHaveAttribute('width', /^\d+$/)
    await expect(building).toHaveAttribute('height', /^\d+$/)

    // 榮譽大圖沒有得獎資料時是示意照片，一定在。
    const honors = page.locator('section[aria-labelledby="home-honors"] img').first()
    await expect(honors).toHaveAttribute('loading', 'lazy')
    await expect(honors).toHaveAttribute('width', /^\d+$/)
    await expect(honors).toHaveAttribute('height', /^\d+$/)

    // 公告卡（含第一張）與優秀專題卡要看測試庫有沒有資料；有就每張都驗。公告卡的寬高屬 V1，這裡只驗 lazy。
    for (const img of await page.locator('section[aria-labelledby="home-news"] [data-testid="news-card"] img').all()) {
      await expect(img).toHaveAttribute('loading', 'lazy')
    }
    for (const img of await page.getByTestId('home-featured-list').locator('img').all()) {
      await expect(img).toHaveAttribute('loading', 'lazy')
      await expect(img).toHaveAttribute('width', /^\d+$/)
      await expect(img).toHaveAttribute('height', /^\d+$/)
    }
  } finally {
    await close()
  }
})
