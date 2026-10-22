import { expect, test, type Page } from '@playwright/test'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * SH-3（AC-SH-19；網站問題 #8）：`PageTitle` 的 actions 很寬時，標題不得被擠成直排。
 *
 * 原本的現場是系辦成績管理頁右上的「評分要求與指派」「建立新版評分規則」＋建立草稿後的狀態句。
 * AD-08 把這兩個動作搬到評分規則子頁的區塊裡（成功訊息不放標題列），成績頁與子頁的標題列都沒有按鈕了，
 * 所以現場換成標題列仍有兩顆寬按鈕的系辦帳號管理頁（「發臨時密碼」「新增老師」，AC-AD-21 改版後仍在標題右側）。
 * 那兩顆按鈕的回執在各自的對話框裡，標題列沒有狀態句可驗。
 *
 * 改後：標題至少 16rem 寬、最多兩行高；actions 不壓到標題（同一列在右邊、放不下就換到下一列）。標題 40px／900。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

test.describe.configure({ mode: 'serial' })

async function openAdminAccounts(page: Page) {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto('/dashboard/admin/accounts')
  await expect(page.getByRole('heading', { level: 1, name: '帳號', exact: true })).toBeVisible()
}

type Box = { top: number; bottom: number; left: number; right: number; width: number; height: number }

async function box(page: Page, locator: ReturnType<Page['locator']>): Promise<Box> {
  const b = await locator.boundingBox()
  if (!b) throw new Error('元素沒有版面')
  return { top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width, width: b.width, height: b.height }
}

for (const width of [1280, 1024]) {
  test(`${width} 寬：actions 有兩顆按鈕時，標題不直排、actions 換到下一列`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await openAdminAccounts(page)

    const h1 = page.locator('main h1')
    await expect(h1).toHaveText('帳號')
    const style = await h1.evaluate((el) => {
      const s = getComputedStyle(el)
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: parseFloat(s.lineHeight) }
    })
    expect(style.fontSize).toBe('40px')
    expect(style.fontWeight).toBe('900')

    const title = await box(page, h1)
    expect(title.width).toBeGreaterThanOrEqual(256)
    expect(title.height).toBeLessThanOrEqual(2 * style.lineHeight)

    // 按鈕不壓到標題（AD-11：AC-AD-21 標題縮短後兩顆按鈕可以跟標題同一列）：
    // 同一列時按鈕在標題右邊，換列時按鈕在標題下面。
    const actions = page.getByTestId('page-title-actions')
    for (const part of [actions.getByRole('button', { name: '新增成員' })]) {
      const b = await box(page, part)
      if (b.top < title.bottom - 1) expect(b.left).toBeGreaterThanOrEqual(title.right - 1)
      else expect(b.top).toBeGreaterThanOrEqual(title.bottom - 1)
    }
  })
}
