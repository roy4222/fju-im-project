import { expect, test, type Page } from '@playwright/test'
import { sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

/**
 * AD-15：設定分頁（首頁設定、操作紀錄兩頁）與操作紀錄姓名搜尋。
 *
 * 1. AC-AD-24（本票兩頁）：`h1`「設定」；分頁列三項（屆別｜專題時程｜操作紀錄；C 階段規格② §2.2 拿掉首頁設定），
 *    目前頁 `aria-current`；首頁設定頁仍掛這條分頁列但沒有一項是目前頁；從首頁設定點「操作紀錄」分頁到 `/audit`。
 * 2. AC-A-32／AC-A-33（A-11 反轉 AC-AD-26）：搜尋由伺服器做——Enter 送出後網址帶 `q=`、打一次伺服器；比對「誰」「對象」；
 *    分頁籤數字隨結果；清除回全部；搜尋框下一句「只搜近 7 天、最多 200 筆（在伺服器搜尋）」；欄位擋在 50 字；角色膠囊與搜尋可同時用。
 * 種資料走畫面新增兩屆（跟 `audit.spec.ts` 同一招），「對象」欄是屆別「名稱（代碼）」。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const stamp = Date.now().toString(36).toUpperCase()
const CODE_A = `E2E-AS-${stamp}-A`
const CODE_B = `E2E-AS-${stamp}-B`
const AUDIT = '/dashboard/admin/audit'
const TABS = [
  { label: '屆別', href: '/dashboard/admin/cohorts' },
  { label: '專題時程', href: '/dashboard/admin/timeline' },
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

test('首頁設定與操作紀錄：h1「設定」、三個分頁、目前頁標 aria-current，點分頁切頁（AC-AD-24）', async ({ page }) => {
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

  await page.getByRole('navigation', { name: '設定分頁' }).getByRole('link', { name: '屆別', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/cohorts$/)
  await expectSettingsTabs(page, '/dashboard/admin/cohorts')
})

test('操作紀錄伺服器端搜尋：Enter 送出網址帶 q、打一次伺服器；籤數字隨結果；清除全回來；可與角色膠囊同時用（AC-A-32）', async ({ page }) => {
  await signIn(page, 'admin')
  for (const code of [CODE_A, CODE_B]) {
    await page.goto('/dashboard/admin/cohorts')
    // C2-06：「新增屆別」開視窗填。
    await page.getByRole('button', { name: '新增屆別' }).click()
    const create = page.getByRole('dialog', { name: '新增屆別' })
    await create.getByLabel('代碼').fill(code)
    await create.getByLabel('名稱').fill(`${code} 搜尋測試`)
    await create.getByRole('button', { name: '確定新增' }).click()
    await expect(page.getByRole('main').getByRole('status')).toContainText(code)
  }

  await page.goto(AUDIT)
  const entries = page.getByTestId('audit-entry')
  const entryA = entries.filter({ hasText: CODE_A })
  const entryB = entries.filter({ hasText: CODE_B })
  await expect(entryA).toHaveCount(1)
  await expect(entryB).toHaveCount(1)
  await expect(page.getByRole('main')).toContainText('只搜近 7 天、最多 200 筆（在伺服器搜尋）')
  const pills = page.getByRole('navigation', { name: '依角色篩選' })
  const adminPill = pills.getByRole('link', { name: /^管理員/ })
  const pillCount = async (name: RegExp) => Number(((await pills.getByRole('link', { name }).innerText()).match(/\d+/) ?? ['-1'])[0])
  const totalAll = await pillCount(/^全部/)

  const search = page.getByRole('searchbox', { name: '搜尋姓名或對象' })
  const requests: string[] = []
  // 側欄、分頁列的 `<Link>` 會在背景預抓（帶 `next-router-prefetch`），那不是搜尋打的，不算。
  page.on('request', (r) => {
    if (r.headers()['next-router-prefetch']) return
    if (['document', 'fetch', 'xhr'].includes(r.resourceType())) requests.push(`${r.method()} ${r.url()}`)
  })

  // 對「對象」欄：Enter 送出 → 網址帶 q、打一次伺服器、只剩 A 那一筆、全部籤數字變 1。
  await search.fill(CODE_A)
  await search.press('Enter')
  await expect(page).toHaveURL(new RegExp(`${AUDIT}\\?q=${CODE_A}$`))
  expect(requests).toHaveLength(1)
  await expect(entries).toHaveCount(1)
  await expect(entryA).toHaveCount(1)
  await expect(pills.getByRole('link', { name: /^全部/ })).toContainText('1')
  await expect(search).toHaveValue(CODE_A)

  // 大小寫不分。
  await search.fill(CODE_A.toLowerCase())
  await search.press('Enter')
  await expect(page).toHaveURL(new RegExp(`${AUDIT}\\?q=${CODE_A.toLowerCase()}$`))
  await expect(entries).toHaveCount(1)

  // 清除：回到沒有 q 的網址，全部回來。
  await page.getByRole('link', { name: '清除' }).click()
  await expect(page).toHaveURL(new RegExp(`${AUDIT}$`))
  await expect(entries.first()).toBeVisible()
  expect(await pillCount(/^全部/)).toBe(totalAll)

  // 對「誰」欄：用 A 那筆的操作者姓名搜，兩筆都還在（同一個管理員做的）。
  const actor = (await entryA.locator('span.truncate').first().innerText()).trim()
  expect(actor.length).toBeGreaterThan(0)
  await search.fill(actor)
  await search.press('Enter')
  await expect(page).toHaveURL(/\?q=/)
  await expect(entryA).toHaveCount(1)
  await expect(entryB).toHaveCount(1)

  // 找不到：清單空、給一句原因、籤數字為 0。
  await search.fill(`沒有這個人-${stamp}`)
  await search.press('Enter')
  await expect(entries).toHaveCount(0)
  await expect(page.getByRole('list', { name: '操作紀錄清單' })).toContainText('找不到')
  await expect(pills.getByRole('link', { name: /^全部/ })).toContainText('0')

  // 角色膠囊與搜尋同時用：膠囊連結帶著 q。
  await search.fill(CODE_B)
  await search.press('Enter')
  await expect(entries).toHaveCount(1)
  await expect(adminPill).toHaveAttribute('href', new RegExp(`role=admin&q=${CODE_B}$`))
  await adminPill.click()
  await expect(page).toHaveURL(new RegExp(`${AUDIT}\\?role=admin&q=${CODE_B}$`))
  await expect(adminPill).toHaveAttribute('aria-current', 'page')
  await expect(entryB).toHaveCount(1)
  await expect(entries).toHaveCount(1)

  await pills.getByRole('link', { name: /^學生/ }).click()
  await expect(page).toHaveURL(new RegExp(`${AUDIT}\\?role=student&q=${CODE_B}$`))
  await expect(entries).toHaveCount(0)
})

test('操作紀錄搜尋字上限：欄位擋在 50 字；網址硬塞 51 字 → 不搜、顯示說明（AC-A-33）', async ({ page }) => {
  await signIn(page, 'admin')
  await page.goto(AUDIT)
  const search = page.getByRole('searchbox', { name: '搜尋姓名或對象' })
  await expect(search).toHaveAttribute('maxlength', '50')
  await search.fill('王'.repeat(60))
  await expect(search).toHaveValue('王'.repeat(50))

  await page.goto(`${AUDIT}?q=${encodeURIComponent('王'.repeat(51))}`)
  await expect(page.getByRole('main').getByRole('alert')).toContainText('最多 50 字')
  await expect(page.getByTestId('audit-entry').first()).toBeVisible()
})

test('操作紀錄搜尋框：搜尋後改字不送出，再按清除或切換角色 → 輸入框跟著網址重置', async ({ page }) => {
  await signIn(page, 'admin')
  await page.goto(`${AUDIT}?q=${encodeURIComponent(CODE_A)}`)
  const search = page.getByRole('searchbox', { name: '搜尋姓名或對象' })
  await expect(search).toHaveValue(CODE_A)

  await search.fill('還沒送出的字')
  await page.getByRole('link', { name: '清除' }).click()
  await expect(page).toHaveURL(new RegExp(`${AUDIT}$`))
  await expect(search).toHaveValue('')

  await page.goto(`${AUDIT}?q=${encodeURIComponent(CODE_A)}`)
  await search.fill('還沒送出的字')
  await page.getByRole('navigation', { name: '依角色篩選' }).getByRole('link', { name: /^老師/ }).click()
  await expect(page).toHaveURL(new RegExp(`${AUDIT}\\?role=teacher&q=`))
  await expect(search).toHaveValue(CODE_A)
})

test('操作紀錄搜尋字上限用同一把尺：補充平面字 𠮷 ×25 可搜，×26 欄位擋住、網址送入被拒', async ({ page }) => {
  await signIn(page, 'admin')
  await page.goto(AUDIT)
  const search = page.getByRole('searchbox', { name: '搜尋姓名或對象' })
  await search.fill('𠮷'.repeat(26))
  await expect(search).toHaveValue('𠮷'.repeat(25))
  await page.goto(`${AUDIT}?q=${encodeURIComponent('𠮷'.repeat(25))}`)
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
  await page.goto(`${AUDIT}?q=${encodeURIComponent('𠮷'.repeat(26))}`)
  await expect(page.getByRole('main').getByRole('alert')).toContainText('最多 50 字')
})
