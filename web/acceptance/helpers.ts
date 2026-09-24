import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'

/**
 * 站驗收共用的小工具：帳密、截圖、登入。
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

/**
 * 每站一個截圖器：`.out/<這次>/<站>/NN-<英文短名>.png`，NN 依拍攝順序遞增。
 * 名稱只用固定的英文短名，不帶任何帳號資料。
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
    await page.screenshot({ path: path.join(dir, `${String(n).padStart(2, '0')}-${name}.png`), fullPage: true })
  }
}

/** 用表單登入；等到真的離開登入頁或看到錯誤訊息才回來。 */
export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('密碼', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await Promise.race([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 }),
    page.locator('p[role="alert"]').waitFor({ timeout: 20_000 }),
  ])
}

/** 按側邊的「登出」，回到登入頁或首頁。 */
export async function signOut(page: Page) {
  await page.getByRole('button', { name: '登出' }).first().click()
  await page.waitForURL((url) => url.pathname === '/login' || url.pathname === '/', { timeout: 20_000 })
}

/** 未登入開後台會被帶去登入頁，看不到「系辦首頁」。 */
export async function expectDashboardBlocked(page: Page) {
  await page.goto('/dashboard/admin')
  await expect(page).toHaveURL(/\/login(\?|$)/)
  await expect(page.getByRole('heading', { name: '系辦首頁' })).toHaveCount(0)
}
