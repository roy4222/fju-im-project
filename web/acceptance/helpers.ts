import fs from 'node:fs'
import path from 'node:path'
import { expect, type Browser, type Locator, type Page } from '@playwright/test'

/**
 * 站驗收共用的小工具：帳密、截圖、登入、帳號頁的常用動作與收尾。
 *
 * 帳密只從環境變數讀、只在記憶體裡用：不印、不寫檔、不放進測試名稱、斷言訊息或截圖檔名。
 */

export const OUT_ROOT = path.join(import.meta.dirname, '.out')

export function adminCredentials(): { email: string; password: string } {
  const email = process.env.E2E_ADMIN_EMAIL
  const password = process.env.E2E_ADMIN_PASSWORD
  if (!email || !password) {
    throw new Error(
      '缺 E2E_ADMIN_EMAIL 或 E2E_ADMIN_PASSWORD。請用：doppler run -p fju-im-capstone -c stg --only-secrets E2E_ADMIN_EMAIL,E2E_ADMIN_PASSWORD -- pnpm -C web acceptance',
    )
  }
  return { email, password }
}

/** 畫面上看起來像 email 的字。 */
const EMAIL_TEXT = /[\w.+-]+@[\w-]+(\.[\w-]+)+/

/**
 * 每站一個截圖器：`.out/<這次>/<站>/NN-<英文短名>.png`，NN 依拍攝順序遞增。
 * 名稱只用固定的英文短名，不帶任何帳號資料。
 *
 * 每一張都把畫面上的 email（帳號列表、側欄、下拉選單、Email 輸入框）遮掉：
 * 帳號頁會列出 E2E 管理員與測試站上其他人的 email，截圖不該帶著走。
 */
export function screenshotter(station: string) {
  const runId = process.env.ACCEPTANCE_RUN_ID ?? 'manual'
  const dir = path.join(OUT_ROOT, runId, station)
  let n = 0
  return async (page: Page, name: string) => {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`截圖名稱只能用小寫英數與連字號：${name}`)
    // 第一次拍才建資料夾：`--list` 只載入 spec，不該留下空資料夾。
    if (n === 0) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    n += 1
    await page.screenshot({
      path: path.join(dir, `${String(n).padStart(2, '0')}-${name}.png`),
      fullPage: true,
      mask: [page.getByText(EMAIL_TEXT), page.locator('input[type=email], input[autocomplete=email], input[autocomplete=username]')],
    })
  }
}

/**
 * 填密碼這類不能外流的值。Playwright 的 `fill` 失敗時，錯誤的 call log 會把填的值原樣印出來；
 * 這裡先確定欄位看得到，失敗時丟一個**不含值**的錯誤（不帶原本的錯誤，免得值跟著出去）。
 */
export async function fillSecret(field: Locator, value: string) {
  await expect(field).toBeVisible()
  try {
    await field.fill(value)
  } catch {
    throw new Error('填寫密碼欄失敗（值不印出）；請看同一步的截圖或重跑一次。')
  }
}

/** 用表單登入；等到真的離開登入頁或看到錯誤訊息才回來。 */
export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await fillSecret(page.getByLabel('密碼', { exact: true }), password)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await Promise.race([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 }),
    page.locator('p[role="alert"]').waitFor({ timeout: 20_000 }),
  ])
}

/** 按右上角帳號選單裡的「登出」，回到登入頁或首頁。 */
export async function signOut(page: Page) {
  await page.getByRole('button', { name: '帳號選單' }).first().click()
  await page.getByRole('menuitem', { name: '登出' }).click()
  await page.waitForURL((url) => url.pathname === '/login' || url.pathname === '/', { timeout: 20_000 })
}

/** 未登入開後台會被帶去登入頁，看不到「系辦首頁」。 */
export async function expectDashboardBlocked(page: Page) {
  await page.goto('/dashboard/admin')
  await expect(page).toHaveURL(/\/login(\?|$)/)
  await expect(page.getByRole('heading', { name: '系辦首頁' })).toHaveCount(0)
}

/** 開一個全新的瀏覽器工作階段（不帶任何 cookie）。 */
export async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  return context.newPage()
}

/** 用 E2E 管理員登入一個新分頁；整條流程共用它（登入限速 10 分鐘 10 次）。 */
export async function adminPage(browser: Browser): Promise<Page> {
  const { email, password } = adminCredentials()
  const page = await newPage(browser)
  await signIn(page, email, password)
  await expect(page).not.toHaveURL(/\/login|\/account\/change-password/)
  return page
}

// ── 帳號頁 ────────────────────────────────────────────────────────────────

/**
 * 伺服器回來的那一句成功回饋。限定在 `<main>`（避開 Next 的換頁播報器），再用文字挑：
 * 同一頁可能同時掛著好幾句回饋。
 */
export async function expectStatus(page: Page, text: string) {
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: text })).toBeVisible()
}

export function cohortRow(page: Page, code: string) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: code, exact: true }) })
}

export function pendingRow(page: Page, name: string) {
  // 帳號頁下方還有「帳號列表」，待審的人兩邊都有；這裡只看上方的待審核清單。
  return page.locator('table:not([aria-label="帳號列表"])').getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
}

export function accountRow(page: Page, name: string): Locator {
  return page.getByRole('table', { name: '帳號列表' }).getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
}

export async function searchAccounts(page: Page, q: string) {
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(q)}`)
  await expect(page.getByRole('table', { name: '帳號列表' })).toBeVisible()
}

export type FlagLabel = '開放註冊中' | '預設工作中'

/** 某個旗標目前在哪一屆（沒有就 null）。要先開在屆別頁。 */
export async function flagHolder(page: Page, held: FlagLabel): Promise<string | null> {
  const row = page.getByRole('row').filter({ hasText: held })
  if ((await row.count()) === 0) return null
  return (await row.first().getByRole('cell').first().innerText()).trim()
}

/** 跑之前握著兩個旗標的屆別代碼；跑完還回去。 */
export type Flags = { registrationOpen: string | null; defaultWorking: string | null }

export async function readFlags(page: Page): Promise<Flags> {
  await page.goto('/dashboard/admin/cohorts')
  await expect(page.getByRole('heading', { name: '屆別', exact: true })).toBeVisible()
  return { registrationOpen: await flagHolder(page, '開放註冊中'), defaultWorking: await flagHolder(page, '預設工作中') }
}

/** 把兩個全系唯一的旗標還給原本的屆別（原本沒有、或原本就是這一輪的屆別就不動）。 */
export async function restoreFlags(page: Page, previous: Flags, runCohort: string) {
  await page.goto('/dashboard/admin/cohorts')
  for (const [flag, label] of [
    [previous.registrationOpen, '開放註冊屆別'],
    [previous.defaultWorking, '預設工作屆別'],
  ] as const) {
    if (!flag || flag === runCohort) continue
    const button = page.getByRole('button', { name: `把 ${flag} 設為${label}` })
    if ((await button.count()) > 0) {
      await button.click()
      await expectStatus(page, `已把 ${flag} 設為${label}`)
    }
  }
}

export type NewStudent = { name: string; studentNo: string; email: string; dept: string; password: string }

/** 新學生在 `/register` 用密碼註冊，停在等待審核頁。 */
export async function registerStudent(page: Page, s: NewStudent) {
  await page.goto('/register')
  await page.getByLabel('姓名').fill(s.name)
  await page.getByLabel('學號').fill(s.studentNo)
  await page.getByLabel('系級').fill(s.dept)
  await page.getByLabel('手機').fill('0912-345-678')
  await page.getByLabel('登入 Email').fill(s.email)
  await fillSecret(page.getByLabel('密碼', { exact: true }), s.password)
  await fillSecret(page.getByLabel('確認密碼'), s.password)
  await page.getByRole('button', { name: '送出註冊' }).click()
  await expect(page).toHaveURL(/\/register\/pending$/)
  await expect(page.getByRole('heading', { name: '等待系辦審核' })).toBeVisible()
}

/** 管理員在帳號頁審核一位待審學生：選「當面核對」後核准，回到列表。 */
export async function approveStudent(admin: Page, name: string, cohortName: string) {
  await admin.goto('/dashboard/admin/accounts')
  await admin.getByRole('button', { name: `審核 ${name}` }).click()
  const dialog = admin.getByRole('dialog', { name: `審核 ${name}` })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('當面核對學生證或其他身分證件').check()
  await dialog.getByRole('button', { name: '核准' }).click()
  await expect(dialog.getByRole('status')).toContainText('已核准')
  await expect(dialog.getByRole('status')).toContainText(cohortName)
  await dialog.getByRole('button', { name: '關閉' }).click()
  await expect(pendingRow(admin, name)).toHaveCount(0)
}

/** 管理員直接新增老師，回傳只顯示一次的臨時密碼（只留在記憶體）。 */
export async function createTeacher(admin: Page, teacher: { name: string; email: string }): Promise<string> {
  await admin.goto('/dashboard/admin/accounts')
  await admin.getByRole('button', { name: '新增老師', exact: true }).click()
  const dialog = admin.getByRole('dialog', { name: '新增老師' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('登入 Email').fill(teacher.email)
  await dialog.getByLabel('姓名').fill(teacher.name)
  await dialog.getByLabel('當面核對學生證或其他身分證件').check()
  await dialog.getByRole('button', { name: '建立並產生臨時密碼' }).click()
  await expect(dialog.getByRole('status')).toContainText('只顯示這一次')
  const temporary = (await dialog.getByTestId('temporary-password').innerText()).trim()
  // 不用 `toMatch`：斷言失敗時 Received 會把臨時密碼印出來。只比布林值。
  expect(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/.test(temporary), '臨時密碼格式不對（值不印出）').toBe(true)
  await dialog.getByRole('button', { name: '關閉' }).click()
  return temporary
}

/** 老師用臨時密碼第一次登入：被逼改密 → 補資料 → 進老師首頁。 */
export async function teacherFirstLogin(page: Page, email: string, temporary: string, newPassword: string) {
  await signIn(page, email, temporary)
  await expect(page).toHaveURL(/\/account\/change-password$/)
  await fillSecret(page.getByLabel('目前的一次性密碼'), temporary)
  await fillSecret(page.getByLabel('新密碼', { exact: true }), newPassword)
  await fillSecret(page.getByLabel('再輸入一次新密碼'), newPassword)
  await page.getByRole('button', { name: '設定新密碼' }).click()
  await expect(page).toHaveURL(/\/account\/setup$/)
  await page.getByLabel('手機').fill('0911-111-111')
  await page.getByRole('button', { name: '儲存並進入老師首頁' }).click()
  await expect(page).toHaveURL(/\/dashboard\/teacher$/)
}

export function firstLine(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]! : '未知錯誤'
}

/**
 * 收尾：停用這一輪建的帳號。只停用「搜尋姓名後、姓名完全相同且目前已核准」的那一列，
 * 其他人（包括姓名只是相似的）一律不動。失敗只記下來，不讓整個收尾中斷。
 */
export async function disableAccount(admin: Page, name: string): Promise<boolean> {
  try {
    await searchAccounts(admin, name)
    const row = accountRow(admin, name)
    if ((await row.count()) !== 1) return false
    const button = row.getByRole('button', { name: `停用 ${name}`, exact: true })
    if ((await button.count()) === 0) return false
    await button.click()
    const dialog = admin.getByRole('dialog', { name: `停用 ${name}` })
    await dialog.getByLabel(/理由/).fill('站驗收收尾：停用這一輪建的測試帳號')
    await dialog.getByRole('button', { name: '確認停用' }).click()
    await expect(dialog.getByRole('status')).toContainText('已停用')
    await dialog.getByRole('button', { name: '關閉' }).click()
    return true
  } catch (error) {
    console.log(`收尾：停用「${name}」沒成功（${firstLine(error)}）`)
    return false
  }
}

/**
 * 收尾：還在待審清單上的這一輪申請（註冊成功、核准前就失敗）用審核對話框「退回」收掉。
 * 待審帳號沒有「停用」可按；只認姓名完全相同的那一列。
 */
export async function rejectPending(admin: Page, name: string): Promise<boolean> {
  try {
    await admin.goto('/dashboard/admin/accounts')
    if ((await pendingRow(admin, name).count()) !== 1) return false
    await admin.getByRole('button', { name: `審核 ${name}`, exact: true }).click()
    const dialog = admin.getByRole('dialog', { name: `審核 ${name}` })
    await dialog.getByRole('textbox', { name: /^理由/ }).fill('站驗收收尾：這是自動測試建的申請，退回收掉')
    await dialog.getByRole('button', { name: '退回', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('已退回')
    await dialog.getByRole('button', { name: '關閉' }).click()
    return true
  } catch (error) {
    console.log(`收尾：退回「${name}」的申請沒成功（${firstLine(error)}）`)
    return false
  }
}

/** 收尾：這一輪的帳號不論停在哪一步，都收掉（待審就退回，已核准就停用）。 */
export async function retireAccount(admin: Page, name: string) {
  if (!(await rejectPending(admin, name))) await disableAccount(admin, name)
}
