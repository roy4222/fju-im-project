import { expect, test, type Page } from '@playwright/test'
import { sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

/**
 * 沒權限就不要出現（2026-09-26 定案、2026-10-12 Roy Q35）：登入了但打網址進別人的東西，
 * 一律是有網站頁首頁尾的中文「找不到這個頁面」，不說原因、沒有鎖頭；不同拒絕原因的畫面一模一樣。
 *
 * 1. 學生開系辦後台（角色不對，guard 導到 `/403`）。
 * 2. 老師開不是他的評分頁、簽核版本頁（頁面自己判斷，導到 `/403`）。
 * 3. 開拿不到的附件（`/api/files` 303 到 `/403`；不存在、已下架、別屆的回應逐位元相同，見 file-download-pages.spec）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const REVEALING = /權限|角色|指派|指導|無法存取|403/

async function signInAs(page: Page, role: TestRole) {
  const session = await sharedTestSession(page.request, role)
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

/** 主要內容的文字；同時確認是找不到頁面、有網站頁首頁尾、沒有鎖頭、沒有透露原因。 */
async function deniedMain(page: Page, url: string): Promise<string> {
  await page.goto(url)
  await expect(page.getByRole('heading', { name: '找不到這個頁面' })).toBeVisible()
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByRole('contentinfo')).toBeVisible()
  // 舊版 /403 放的是 Tabler 的 IconLock（svg class `tabler-icon-lock`）；任何鎖頭類圖示都不能出現。
  await expect(page.locator('main svg[class*="tabler-icon-lock"]')).toHaveCount(0)
  const text = await page.locator('main').innerText()
  expect(text).not.toMatch(REVEALING)
  return text
}

test('學生開系辦後台、老師開別人的評分與簽核頁、開拿不到的附件：主要內容文字都相同', async ({ page }) => {
  await signInAs(page, 'student')
  const studentAdmin = await deniedMain(page, '/dashboard/admin')
  const studentFile = await deniedMain(page, `/api/files/${crypto.randomUUID()}`)
  expect(studentFile).toBe(studentAdmin)

  await signInAs(page, 'teacher')
  const grading = await deniedMain(page, `/dashboard/teacher/grading/${crypto.randomUUID()}`)
  const signoff = await deniedMain(page, `/dashboard/teacher/signoff/${crypto.randomUUID()}`)
  const teacherFile = await deniedMain(page, `/api/files/${crypto.randomUUID()}`)
  expect(signoff).toBe(grading)
  expect(teacherFile).toBe(grading)
  // 兩個角色只差在「回到自己的首頁」指去哪裡，按鈕文字一樣，所以主要內容文字也一樣。
  expect(grading).toBe(studentAdmin)
})
