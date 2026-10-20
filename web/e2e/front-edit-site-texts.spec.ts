import { writeFileSync } from 'node:fs'
import { expect, request as playwrightRequest, test, type Browser, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * C2-17 站內文字與首頁橫幅（規格② 設計方案 §6.5；AC-C2-40、AC-C2-44 步驟 5–6；接手第三波 W3 的 AC-16～AC-20、AC-V27）。
 *
 * 1. 沒有任何設定時首頁、頁尾、聯絡卡跟改版前一字不差，全站搜不到舊號碼（AC-16、AC-20）。
 * 2. AC-C2-40 (a)：系辦在前台頁尾按「編輯」改電話→存→視窗關、頁尾不用手動重整就是新電話；
 *    `site_texts.footer_contact` 一列 `revision = 1`；訪客重整看到新電話，HTML 沒有 `data-fe-`（AC-C2-44 步驟 5–6）。
 * 3. AC-C2-40 (b)：三張卡每張有「編輯」；中間那張的視窗只有標題、說明兩欄→改標題→存；
 *    卡上連結仍是登入狀態那組；登出後訪客看到新標題＋「登入」；`site_texts.quick_card_2` 一列。
 * 4. 兩個分頁同時改頁尾：後存的被擋（版本過期那一句），視窗不關、內容還在。
 * 5. 隱私權政策：改內文（`# 標題` 起一節）→訪客看到新段落；「聯絡我們」仍由頁尾聯絡資料帶入。
 * 6. 首頁橫幅改在前台（AC-17、AC-18）：上傳圖、填說明與標語→存→訪客看到；換圖後舊圖 401；三欄清空＋改用預設照片就回預設（AC-19 的恢復半邊）。
 * 7. 首頁圖片屬性（AC-V27 ①②③ 首頁）。
 *
 * 首頁與頁尾是全站共用的：這一檔改完一定恢復預設（`afterAll` 用 owner 連線清 `site_texts`、把 `home_settings` 四欄清回 null），
 * 不影響 `smoke.spec`、`public-pages.spec`、`footer-privacy.spec` 對預設字的斷言。
 * 跑完把 `site_texts` 查詢結果寫進 `E2E_EVIDENCE_DIR`（有設才寫）：C2-17-sql-1.json（附 PR 用）。
 */

test.describe.configure({ mode: 'serial' })

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'E2e-Password-Correct-9'
const stamp = Date.now().toString(36).toUpperCase()

const DEFAULT_LINE1 = '輔仁大學資訊管理學系專題管理平台'
const DEFAULT_LINE2 = '輔大資管系專題：從分組、提案到成果發表，公告、規則與歷屆作品都在這裡。'
const ADDRESS = '242 新北市新莊區中正路 510 號 利瑪竇大樓 LM306'
const PHONE = '02-2905-2666'
const NEW_PHONE = '02-2905-2000'
const SLOGAN = '透過機測、專題及產業實習讓學生動手做'
const STALE = '這份設定剛被改過，請重新整理再改'

// 真的解得開的小圖（4×3，JPEG 與 PNG 各一）：首頁斷言 `naturalWidth > 0`，破圖不會混過去。
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAAAwAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAwAEAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A1KKKK/zTP9ED/9k=', 'base64')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAD0lEQVR4nGNgME5DIJwcAIc5By0Ywt6kAAAAAElFTkSuQmCC', 'base64')

let pool: Pool
let admin: TestSession

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(text, values)).rows
}

/** 保險：站內文字全部清掉、首頁設定四欄清回 null（不刪列，同以前的「恢復預設」）。 */
async function forceDefaults() {
  await pool.query('delete from site_texts')
  await pool.query(
    `update home_settings set hero_file_id = null, hero_alt = null, tagline_line1 = null, tagline_line2 = null, revision = revision + 1
      where hero_file_id is not null or hero_alt is not null or tagline_line1 is not null or tagline_line2 is not null`,
  )
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  await forceDefaults()
  // 新註冊的系辦：要用密碼從登入頁登入，才會經過設 `fju_office` 提示 cookie 的 hooks.after（前台編輯模式的前提）。
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
  admin = await createTestSession(api, 'admin')
  await api.dispose()
})

test.afterAll(async () => {
  await forceDefaults()
  await pool.end()
})

/** 從登入頁用密碼登入（真的 Server Action → Better Auth `/sign-in/email`）。 */
async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(admin.email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
}

/** 開編輯模式，回編輯層。 */
async function editMode(page: Page) {
  await page.getByRole('button', { name: '編輯頁面' }).click()
  const layer = page.getByTestId('front-edit-layer')
  await expect(layer).toBeAttached()
  return layer
}

/** 存檔成功：視窗關、toast「已儲存」。 */
async function expectSaved(page: Page, dialogName: string) {
  await expect(page.getByRole('dialog', { name: dialogName })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: '已儲存' })).toBeVisible()
}

/** 沒登入的訪客（或帶著某個登入狀態的人）開某一頁。 */
async function visitor(browser: Browser, path = '/', cookie?: string) {
  const context = await browser.newContext({ baseURL: BASE_URL })
  if (cookie) await context.addCookies([toPlaywrightCookie(cookie, BASE_URL)])
  const page = await context.newPage()
  await page.goto(path)
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

test('沒有任何設定時首頁跟改版前一樣；聯絡卡、頁尾是系網的地址與電話，搜不到舊號碼（AC-16、AC-20）', async ({ page }) => {
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

  for (const path of ['/news', '/rules', '/honors', '/projects/featured', '/login', '/privacy']) {
    await page.goto(path)
    await expectNoOldPhone(page)
  }
})

test('首頁輪播沒有公開的優秀專題時，空狀態不說「系辦發布後」（AC-15 首頁那半）', async ({ page }) => {
  // 測試庫可能已有別的 spec 發布的得獎作品；那時輪播不是空的，這一條沒得驗。
  const found = await sql(`select 1 from showcase_entries where status = 'published' and award_level is not null limit 1`)
  test.skip(found.length > 0, '測試庫已有公開的優秀專題，輪播不是空的')
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

test('AC-C2-40 (a)：頁尾「編輯」改電話→存→視窗關、頁尾不用手動重整；footer_contact 一列 revision 1；訪客重整看到新電話、HTML 沒有 data-fe-（AC-C2-44 步驟 5–6）', async ({ page, browser }) => {
  await signIn(page)
  await page.goto('/')
  const layer = await editMode(page)
  const footer = layer.locator('.fe-item[data-fe-for="footer_contact"]')
  await expect(footer.getByRole('button', { name: '編輯「頁尾聯絡資料」' })).toHaveCount(1)
  await footer.getByRole('button', { name: '編輯「頁尾聯絡資料」' }).click()

  const dialog = page.getByRole('dialog', { name: '編輯頁尾聯絡資料' })
  await expect(dialog).toBeVisible()
  // 預填是目前（預設）的值。
  await expect(dialog.getByLabel('電話', { exact: true })).toHaveValue(PHONE)
  await expect(dialog.getByLabel('地址', { exact: true })).toHaveValue(ADDRESS)
  await dialog.getByLabel('電話', { exact: true }).fill(NEW_PHONE)
  await dialog.getByRole('button', { name: '儲存', exact: true }).click()
  await expectSaved(page, '編輯頁尾聯絡資料')

  // 頁尾不用手動重整就是新電話（框架的 router.refresh()）。
  const siteFooter = page.locator('footer')
  await expect(siteFooter.getByRole('link', { name: NEW_PHONE })).toHaveAttribute('href', 'tel:+886229052000')
  await expect(siteFooter).not.toContainText(PHONE)
  // 第三張卡的聯絡資料跟頁尾同一份。
  await expect(page.getByRole('region', { name: '快速入口' })).toContainText(`電話 ${NEW_PHONE}`)

  const rows = await sql<{ key: string; revision: number; phone: string }>(`select key, revision, value->>'phone' as phone from site_texts`)
  expect(rows).toEqual([{ key: 'footer_contact', revision: 1, phone: NEW_PHONE }])

  // 訪客重新整理：新電話；HTML 沒有任何 data-fe-、沒有「編輯頁面」。
  const guest = await visitor(browser)
  await guest.page.waitForLoadState('networkidle')
  expect((await guest.page.content()).includes('data-fe-')).toBe(false)
  await expect(guest.page.getByRole('button', { name: '編輯頁面' })).toHaveCount(0)
  await expect(guest.page.locator('footer').getByRole('link', { name: NEW_PHONE })).toHaveAttribute('href', 'tel:+886229052000')
  await expect(guest.page.locator('footer')).toContainText(ADDRESS)
  // 隱私權頁的「聯絡我們」也是新電話。
  await guest.page.goto('/privacy')
  await expect(guest.page.getByTestId('privacy-contact').getByRole('link', { name: NEW_PHONE })).toHaveAttribute('href', 'tel:+886229052000')
  await guest.close()
})

test('AC-C2-40 (b)：三張卡各有「編輯」；中間卡只有標題、說明兩欄→改標題→存；連結仍照登入狀態；登出後訪客看到新標題＋「登入」；quick_card_2 一列', async ({ page }) => {
  await signIn(page)
  await page.goto('/')
  const layer = await editMode(page)
  const cards = layer.locator('.fe-item[data-fe-for="quick_card"]')
  await expect(cards).toHaveCount(3)
  for (const title of ['專題規則', '我的入口', '系辦聯絡']) await expect(layer.getByRole('button', { name: `編輯「${title}」` })).toHaveCount(1)

  await layer.getByRole('button', { name: '編輯「我的入口」' }).click()
  const dialog = page.getByRole('dialog', { name: '編輯快速入口' })
  await expect(dialog).toBeVisible()
  // 只有標題、說明兩欄；沒有連結欄位。
  await expect(dialog.getByRole('textbox')).toHaveCount(2)
  await expect(dialog.getByLabel('標題')).toHaveValue('我的入口')
  await expect(dialog.getByLabel('說明')).toHaveValue('')
  await expect(dialog.getByLabel(/連結|網址/)).toHaveCount(0)
  const title = `我的入口 ${stamp}`
  await dialog.getByLabel('標題').fill(title)
  await dialog.getByRole('button', { name: '儲存', exact: true }).click()
  await expectSaved(page, '編輯快速入口')

  // 卡上是新標題；連結仍是登入狀態那組（我的後台、檔案下載、產學合作），不是「登入」。
  const card = page.getByTestId('quick_card_2')
  await expect(card).toContainText(title)
  await expect(card.getByRole('link')).toHaveText(['我的後台', '檔案下載', '產學合作'])

  const rows = await sql<{ key: string; revision: number; value: unknown }>(`select key, revision, value from site_texts where key = 'quick_card_2'`)
  expect(rows).toEqual([{ key: 'quick_card_2', revision: 1, value: { title, description: '' } }])

  // 登出（清掉登入狀態）後的訪客：新標題＋「登入」按鈕。
  await page.context().clearCookies()
  await page.goto('/')
  const guestCard = page.getByTestId('quick_card_2')
  await expect(guestCard).toContainText(title)
  await expect(guestCard.getByRole('link', { name: '登入' })).toHaveAttribute('href', '/login')
  await expect(guestCard.getByRole('link', { name: '我的後台' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '編輯頁面' })).toHaveCount(0)
})

test('兩個分頁同時改頁尾：後存的被擋、視窗不關、內容還在', async ({ page }) => {
  await signIn(page)
  const second = await page.context().newPage()
  await page.goto('/')
  await second.goto('/')
  const first = await editMode(page)
  await first.getByRole('button', { name: '編輯「頁尾聯絡資料」' }).click()
  const layer2 = await editMode(second)
  await layer2.getByRole('button', { name: '編輯「頁尾聯絡資料」' }).click()

  const dialog1 = page.getByRole('dialog', { name: '編輯頁尾聯絡資料' })
  await dialog1.getByLabel('專題洽詢說明').fill(`分頁一 ${stamp}`)
  await dialog1.getByRole('button', { name: '儲存', exact: true }).click()
  await expectSaved(page, '編輯頁尾聯絡資料')

  const dialog2 = second.getByRole('dialog', { name: '編輯頁尾聯絡資料' })
  await dialog2.getByLabel('專題洽詢說明').fill(`分頁二 ${stamp}`)
  await dialog2.getByRole('button', { name: '儲存', exact: true }).click()
  await expect(dialog2.getByRole('alert')).toContainText(STALE)
  await expect(dialog2).toBeVisible()
  await expect(dialog2.getByLabel('專題洽詢說明')).toHaveValue(`分頁二 ${stamp}`)

  const rows = await sql<{ revision: number; note: string }>(`select revision, value->>'officeNote' as note from site_texts where key = 'footer_contact'`)
  expect(rows).toEqual([{ revision: 2, note: `分頁一 ${stamp}` }])
  await second.close()
})

test('隱私權政策：改內文（# 標題起一節）→訪客看到新段落；「聯絡我們」仍由頁尾聯絡資料帶入', async ({ page, browser }) => {
  await signIn(page)
  await page.goto('/privacy')
  const layer = await editMode(page)
  await layer.getByRole('button', { name: '編輯「隱私權政策」' }).click()
  const dialog = page.getByRole('dialog', { name: '編輯隱私權政策' })
  const body = dialog.getByLabel('內文')
  // 預填是目前（預設）的內文：三節。
  await expect(body).toHaveValue(/^# 我們蒐集哪些資料\n/)
  expect(((await body.inputValue()).match(/^# /gm) ?? []).length).toBe(3)
  const heading = `第四節 ${stamp}`
  await body.fill(`${await body.inputValue()}\n\n# ${heading}\n\n這是新加的一段。`)
  await dialog.getByRole('button', { name: '儲存', exact: true }).click()
  await expectSaved(page, '編輯隱私權政策')
  await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible()

  const guest = await visitor(browser, '/privacy')
  await expect(guest.page.getByRole('heading', { level: 2, name: heading })).toBeVisible()
  await expect(guest.page.getByRole('main')).toContainText('這是新加的一段。')
  await expect(guest.page.getByRole('heading', { level: 2 })).toHaveText(['我們蒐集哪些資料', '資料用在哪裡', '誰看得到', heading, '聯絡我們'])
  await expect(guest.page.getByTestId('privacy-contact')).toContainText(ADDRESS)
  expect((await guest.page.content()).includes('data-fe-')).toBe(false)
  await guest.close()

  const rows = await sql<{ revision: number; n: number }>(`select revision, jsonb_array_length(value->'sections') as n from site_texts where key = 'privacy'`)
  expect(rows).toEqual([{ revision: 1, n: 4 }])
})

test('首頁橫幅改在前台：上傳圖、填說明與標語→存→訪客看到；換圖後舊圖無法存取；清空就回預設（AC-17、AC-18、AC-19 恢復半邊）', async ({ page, browser }) => {
  const startedAt = new Date()
  await signIn(page)
  await page.goto('/')
  const layer = await editMode(page)
  const openHero = async () => {
    await layer.getByRole('button', { name: '編輯「首頁橫幅」' }).click()
    const dialog = page.getByRole('dialog', { name: '編輯首頁橫幅' })
    await expect(dialog).toBeVisible()
    return dialog
  }
  const uploadHero = async (dialog: ReturnType<Page['getByRole']>, name: string, mimeType: string, buffer: Buffer) => {
    await dialog.getByLabel('選擇首頁大圖').setInputFiles({ name, mimeType, buffer })
    await expect(dialog.getByTestId('hero-name')).toContainText(name)
  }

  const line1 = `E2E 首頁標語 ${stamp}`
  const line2 = `第二行說明 ${stamp}`
  const alt = `利瑪竇大樓外觀 ${stamp}`
  let dialog = await openHero()
  await uploadHero(dialog, `hero-a-${stamp}.jpg`, 'image/jpeg', JPG)
  await dialog.getByLabel(/^圖片說明/).fill(alt)
  await dialog.getByLabel(/^標語第一行/).fill(line1)
  await dialog.getByLabel(/^標語第二行/).fill(line2)

  // 還沒存：訪客首頁不變。
  const before = await visitor(browser)
  await expect(before.page.getByRole('heading', { level: 1 })).toHaveText(DEFAULT_LINE1)
  await before.close()

  await dialog.getByRole('button', { name: '儲存', exact: true }).click()
  await expectSaved(page, '編輯首頁橫幅')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(line1)

  const guest = await visitor(browser)
  await expect(guest.page.getByRole('heading', { level: 1 })).toHaveText(line1)
  await expect(guest.page.getByTestId('home-hero-line2')).toHaveText(line2)
  const imageA = guest.page.getByTestId('home-hero-image')
  await expect(imageA).toHaveAttribute('alt', alt)
  const srcA = await imageA.getAttribute('src')
  expect(srcA).toMatch(/^\/api\/files\/[0-9a-f-]{36}$/)
  await expectHeroLoaded(guest.page)
  await guest.close()
  expect(await anonymousStatus(srcA!)).toBe(200)

  // 操作紀錄：home.updated（用例沒換）。
  const audit = await sql<{ payload: Record<string, unknown> }>(
    `select payload from audit_events where action = 'home.updated' and real_at >= $1 order by real_at desc limit 1`,
    [startedAt],
  )
  expect(audit[0]?.payload).toMatchObject({ line1, line2, heroAlt: alt })

  // 換成圖 B：B 公開、A 回到「無法存取」（跟其他非公開檔案一樣：訪客 401）。預填是存過的值。
  dialog = await openHero()
  await expect(dialog.getByLabel(/^標語第一行/)).toHaveValue(line1)
  await uploadHero(dialog, `hero-b-${stamp}.png`, 'image/png', PNG)
  await dialog.getByLabel(/^圖片說明/).fill(`圖 B ${stamp}`)
  await dialog.getByRole('button', { name: '儲存', exact: true }).click()
  await expectSaved(page, '編輯首頁橫幅')

  const after = await visitor(browser)
  const srcB = await after.page.getByTestId('home-hero-image').getAttribute('src')
  await expect(after.page.getByTestId('home-hero-image')).toHaveAttribute('alt', `圖 B ${stamp}`)
  await expectHeroLoaded(after.page)
  await after.close()
  expect(srcB).not.toBe(srcA)
  expect(await anonymousStatus(srcB!)).toBe(200)
  expect(await anonymousStatus(srcA!)).toBe(401)

  // 改用預設照片＋三欄清空＝恢復預設。
  dialog = await openHero()
  await dialog.getByRole('button', { name: '改用預設照片' }).click()
  await expect(dialog.getByTestId('hero-name')).toContainText('使用預設的校園照片')
  await dialog.getByLabel(/^標語第一行/).fill('')
  await dialog.getByLabel(/^標語第二行/).fill('')
  await dialog.getByRole('button', { name: '儲存', exact: true }).click()
  await expectSaved(page, '編輯首頁橫幅')

  const reset = await visitor(browser)
  await expect(reset.page.getByRole('heading', { level: 1 })).toHaveText(DEFAULT_LINE1)
  await expect(reset.page.getByTestId('home-hero-line2')).toHaveText(DEFAULT_LINE2)
  await expect(reset.page.getByTestId('home-hero-image')).toHaveAttribute('src', '/placeholder/campus.jpg')
  await expect(reset.page.getByTestId('home-hero-image')).toHaveAttribute('alt', '')
  await reset.close()
})

test('首頁圖片屬性：hero 不 lazy、提早抓；卡片、榮譽大圖與底部建築照 lazy；都有寬高（第 1 批 AC-V27 ①②③ 首頁）', async ({ browser }) => {
  const { page, close } = await visitor(browser)
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

  // 證據（附 PR）：site_texts 全部列（含 quick_card_2）。
  const dir = process.env.E2E_EVIDENCE_DIR
  if (dir) {
    const rows = await sql(`select key, value, revision, updated_at from site_texts order by key`)
    writeFileSync(`${dir}/C2-17-sql-1.json`, `${JSON.stringify(rows, null, 2)}\n`)
  }
})
