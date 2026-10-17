import { expect, test, type Page } from '@playwright/test'
import { sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

/**
 * AD-15：設定分頁（首頁設定、操作紀錄兩頁）與操作紀錄姓名搜尋。
 *
 * 1. AC-AD-24（本票兩頁）：`h1`「設定」；分頁列四項（屆別｜時間軸｜首頁設定｜操作紀錄），目前頁 `aria-current`；
 *    從首頁設定點「操作紀錄」分頁到 `/audit`。屆別、時間軸兩頁的分頁列歸 AD-12，各自的 spec 驗。
 * 2. AC-AD-26：搜尋只過濾已載入的這批——不打伺服器、網址不變；只比對「誰」「對象」兩欄；清空後全部回來；
 *    搜尋框下一句「只搜近 7 天、最多 200 筆」；角色篩選膠囊與搜尋可同時用。
 * 種資料走畫面新增兩屆（跟 `audit.spec.ts` 同一招），「對象」欄是屆別「名稱（代碼）」。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const stamp = Date.now().toString(36).toUpperCase()
const CODE_A = `E2E-AS-${stamp}-A`
const CODE_B = `E2E-AS-${stamp}-B`
const AUDIT = '/dashboard/admin/audit'
const TABS = [
  { label: '屆別', href: '/dashboard/admin/cohorts' },
  { label: '時間軸', href: '/dashboard/admin/timeline' },
  { label: '首頁設定', href: '/dashboard/admin/home-settings' },
  { label: '操作紀錄', href: AUDIT },
]

async function signIn(page: Page, role: TestRole) {
  const session = await sharedTestSession(page.request, role)
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function expectSettingsTabs(page: Page, current: string) {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('設定')
  const nav = page.getByRole('navigation', { name: '設定分頁' })
  const links = nav.getByRole('link')
  await expect(links).toHaveText(TABS.map((t) => t.label))
  for (const t of TABS) {
    const link = nav.getByRole('link', { name: t.label, exact: true })
    await expect(link).toHaveAttribute('href', t.href)
    if (t.href === current) await expect(link).toHaveAttribute('aria-current', 'page')
    else await expect(link).not.toHaveAttribute('aria-current')
  }
}

test('首頁設定與操作紀錄：h1「設定」、四個分頁、目前頁標 aria-current，點分頁切頁（AC-AD-24）', async ({ page }) => {
  await signIn(page, 'admin')
  await page.goto('/dashboard/admin/home-settings')
  await expectSettingsTabs(page, '/dashboard/admin/home-settings')
  // description 只留第一句（第二句「按『儲存並更新首頁』後立刻生效…」砍掉）。
  await expect(page.getByRole('main')).toContainText('前台首頁最上面的大圖與兩行標語。')
  await expect(page.getByRole('main')).not.toContainText('後立刻生效，所有訪客重新整理就會看到')

  await page.getByRole('navigation', { name: '設定分頁' }).getByRole('link', { name: '操作紀錄', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${AUDIT}$`))
  await expectSettingsTabs(page, AUDIT)
  // 舊頁首說明（含舊指紋句）拿掉。
  await expect(page.getByRole('main')).not.toContainText('誰、何時、對哪個對象、做了什麼、為什麼')

  await page.getByRole('navigation', { name: '設定分頁' }).getByRole('link', { name: '首頁設定', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/home-settings$/)
  await expectSettingsTabs(page, '/dashboard/admin/home-settings')
})

test('操作紀錄姓名搜尋：只過濾已載入的、不打伺服器；比對誰與對象；清空全回來；可與角色膠囊同時用（AC-AD-26）', async ({ page }) => {
  await signIn(page, 'admin')
  for (const code of [CODE_A, CODE_B]) {
    await page.goto('/dashboard/admin/cohorts')
    await page.getByLabel('代碼').fill(code)
    await page.getByLabel('名稱').fill(`${code} 搜尋測試`)
    await page.getByRole('button', { name: '新增屆別' }).click()
    await expect(page.getByRole('main').getByRole('status')).toContainText(code)
  }

  await page.goto(AUDIT)
  const entries = page.getByTestId('audit-entry')
  const entryA = entries.filter({ hasText: CODE_A })
  const entryB = entries.filter({ hasText: CODE_B })
  await expect(entryA).toHaveCount(1)
  await expect(entryB).toHaveCount(1)
  await expect(page.getByRole('main')).toContainText('只搜近 7 天、最多 200 筆')
  const total = await entries.count()

  const search = page.getByRole('searchbox', { name: '搜尋姓名或對象' })
  const requests: string[] = []
  // 側欄、分頁列的 `<Link>` 會在背景預抓（帶 `next-router-prefetch`），那不是搜尋打的，不算。
  page.on('request', (r) => {
    if (r.headers()['next-router-prefetch']) return
    if (['document', 'fetch', 'xhr'].includes(r.resourceType())) requests.push(`${r.method()} ${r.url()}`)
  })

  // 對「對象」欄：只剩 A 那一筆。
  await search.fill(CODE_A)
  await expect(entryA).toHaveCount(1)
  await expect(entryB).toHaveCount(0)
  await expect(entries).toHaveCount(1)
  await expect(page).toHaveURL(new RegExp(`${AUDIT}$`))
  expect(requests).toEqual([])

  // 大小寫不分。
  await search.fill(CODE_A.toLowerCase())
  await expect(entries).toHaveCount(1)

  // 清空：全部回來。
  await search.fill('')
  await expect(entries).toHaveCount(total)

  // 對「誰」欄：用 A 那筆的操作者姓名搜，兩筆都還在（同一個管理員做的）。
  const actor = (await entryA.locator('span.truncate').first().innerText()).trim()
  expect(actor.length).toBeGreaterThan(0)
  await search.fill(actor)
  await expect(entryA).toHaveCount(1)
  await expect(entryB).toHaveCount(1)

  // 找不到：清單空、給一句原因。
  await search.fill(`沒有這個人-${stamp}`)
  await expect(entries).toHaveCount(0)
  await expect(page.getByRole('list', { name: '操作紀錄清單' })).toContainText('找不到')
  expect(requests).toEqual([])

  // 角色膠囊仍是連結（網址篩選），與搜尋同時用。
  const pills = page.getByRole('navigation', { name: '依角色篩選' })
  await pills.getByRole('link', { name: /^管理員/ }).click()
  await expect(page).toHaveURL(new RegExp(`${AUDIT}\\?role=admin$`))
  await expect(pills.getByRole('link', { name: /^管理員/ })).toHaveAttribute('aria-current', 'page')
  await search.fill(CODE_B)
  await expect(entryB).toHaveCount(1)
  await expect(entries).toHaveCount(1)

  await pills.getByRole('link', { name: /^學生/ }).click()
  await expect(page).toHaveURL(new RegExp(`${AUDIT}\\?role=student$`))
  await search.fill(CODE_B)
  await expect(entries).toHaveCount(0)
})
