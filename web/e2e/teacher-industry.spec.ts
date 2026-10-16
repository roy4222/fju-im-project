import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 老師規格 TE-01（網站問題 #1）：新建合作案後**不重新載入**，同一頁接著下架、重新發布都按得動。
 *
 * 曾經 `useDialog()` 每次 render 回新物件，新增對話框的 effect 依賴它，新建成功後 `setVersion` → 再 render →
 * 新的 dialog → effect 再跑 → 無限迴圈，頁面卡死、console 出現 "Maximum update depth exceeded"。
 * 老師頁（`teacher/industry/opportunity-forms.tsx`）與系辦頁（`_industry/opportunity-forms.tsx`）各一份，都走一遍
 * （AC-TE-23、AC-TE-24）。`industry.spec.ts` 的建案流程在發布前會重新載入，所以抓不到這個問題。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()

let pool: Pool
let teacher: TestSession
let admin: TestSession

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const fresh = async (role: 'teacher' | 'admin') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  teacher = await fresh('teacher')
  admin = await fresh('admin')
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function revisionOf(company: string): Promise<number> {
  const rows = await pool.query<{ revision: number }>('select revision from industry_opportunities where company_name = $1', [company])
  return rows.rows[0]!.revision
}

/** 收 console 的錯誤與警告：React 的 "Maximum update depth exceeded" 是 console.error。 */
function watchConsole(page: Page): string[] {
  const messages: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') messages.push(msg.text())
  })
  page.on('pageerror', (error) => messages.push(error.message))
  return messages
}

/** 新增 → 儲存並發布；不重新載入，同一列下架、重新發布。每一步 2 秒內看到新狀態，版本號一步加一。 */
async function createThenToggle(page: Page, path: string, company: string, pickOwner?: string) {
  const messages = watchConsole(page)
  const name = `${company}・資訊部`
  await page.goto(path)
  const dialog = page.getByRole('dialog', { name: '新增合作案' })
  // 剛載入時按鈕可能還沒接上事件，「按鈕→對話框打開」整段重試到成功為止。
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.getByRole('button', { name: '新增合作案' }).click()
    await expect(dialog).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  if (pickOwner) await dialog.getByRole('combobox', { name: /負責老師/ }).selectOption(pickOwner)
  await dialog.getByLabel('公司名稱').fill(company)
  await dialog.getByLabel('需求部門').fill('資訊部')
  await dialog.getByLabel('專題／合作內容').fill('門市補貨預測')
  await dialog.getByRole('button', { name: '儲存並發布' }).click()

  // 狀態看列上的標籤（完全等於那幾個字）：關著的確認對話框也在列裡，說明句裡就有「已下架」。
  const row = page.getByTestId('managed-opportunity').filter({ hasText: company })
  const status = (label: string) => row.getByText(label, { exact: true })
  await expect(dialog).toBeHidden({ timeout: 2_000 })
  await expect(status('已發布')).toBeVisible({ timeout: 2_000 })
  await expect.poll(() => revisionOf(company)).toBe(1)

  // 頁面沒卡住：下架鈕按得下去、確認後對話框關掉、列變「已下架」。
  await row.getByRole('button', { name: `下架：${name}` }).click({ timeout: 2_000 })
  const withdraw = page.getByRole('dialog', { name: `下架「${name}」` })
  await withdraw.getByRole('button', { name: '確認下架' }).click({ timeout: 2_000 })
  await expect(withdraw).toBeHidden({ timeout: 2_000 })
  await expect(status('已下架')).toBeVisible({ timeout: 2_000 })
  await expect.poll(() => revisionOf(company)).toBe(2)

  await row.getByRole('button', { name: `重新發布：${name}` }).click({ timeout: 2_000 })
  const republish = page.getByRole('dialog', { name: `重新發布「${name}」` })
  await republish.getByRole('button', { name: '確認重新發布' }).click({ timeout: 2_000 })
  await expect(republish).toBeHidden({ timeout: 2_000 })
  await expect(status('已發布')).toBeVisible({ timeout: 2_000 })
  await expect.poll(() => revisionOf(company)).toBe(3)

  // 主執行緒還在回應（迴圈時這裡等不到）。
  await page.waitForFunction(() => true, undefined, { timeout: 2_000 })
  expect(messages.filter((m) => m.includes('Maximum update depth'))).toEqual([])
}

test('老師新建合作案後不重新載入，同一列下架、重新發布都按得動（AC-TE-23）', async ({ page }) => {
  await signIn(page, teacher)
  await createThenToggle(page, '/dashboard/teacher/industry', `老師連按${stamp}`)
})

test('系辦新建合作案後不重新載入，同一列下架、重新發布都按得動（AC-TE-24）', async ({ page }) => {
  await signIn(page, admin)
  await createThenToggle(page, '/dashboard/admin/industry', `系辦連按${stamp}`, teacher.userId)
})
