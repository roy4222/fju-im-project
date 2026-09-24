import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 票 5（#216）：建立屆別與開放註冊。「做完的樣子」三條逐條走一次：
 *
 * 1. 管理員新增屆別（代碼、名稱），列表看得到狀態。
 * 2. 可把某屆設為預設工作屆別與開放註冊屆別；各只有一個，切換時舊的自動取消。
 * 3. 沒有設開放註冊屆別時，畫面提示管理員處理，不自行猜測。
 *
 * 全程用真的表單與按鈕；重新整理後再看一次，確認是存進資料庫而不是只改畫面。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

test.describe.configure({ mode: 'serial' })

// 代碼只收英數與連字號、最多 20 字；每次跑都不一樣，重跑不會撞到上一次留下的屆別。
const stamp = Date.now().toString(36).toUpperCase()
const CODE_A = `E2E-${stamp}-A`
const CODE_B = `E2E-${stamp}-B`

test.beforeAll(async () => {
  // 兩個旗標是全系唯一的狀態。先把它們清掉，第 3 條「沒有開放註冊屆別」才看得到；
  // 用 owner 連線直接改，是測試前置，不是被測的功能。
  const ownerUrl = process.env.DATABASE_URL_OWNER
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備屆別狀態')
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    await pool.query(
      `update cohorts set is_registration_open = false, is_default_working = false
        where is_registration_open or is_default_working`,
    )
  } finally {
    await pool.end()
  }
})

async function signInAsAdmin(page: Page) {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

function rowOf(page: Page, code: string) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: code, exact: true }) })
}

/**
 * 伺服器回來的那一句回饋。限定在 `<main>` 裡找：Next 的換頁播報器也用 `role="alert"`，
 * 不限定範圍會一次抓到兩個。
 */
function feedback(page: Page, role: 'status' | 'alert') {
  return page.getByRole('main').getByRole(role)
}

async function createCohort(page: Page, code: string, name: string) {
  await page.getByLabel('代碼').fill(code)
  await page.getByLabel('名稱').fill(name)
  await page.getByRole('button', { name: '新增屆別' }).click()
}

test('沒有開放註冊屆別時，屆別頁提示管理員處理', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/dashboard/admin/cohorts')

  await expect(page.getByRole('heading', { name: '屆別', exact: true })).toBeVisible()
  const notice = page.getByRole('note', { name: '尚未設定開放註冊屆別' })
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('系統不會自己猜')
})

test('新增屆別：列表出現一列，狀態是籌備中；代碼重複被擋下', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/dashboard/admin/cohorts')

  await createCohort(page, CODE_A, `${CODE_A} 測試屆`)
  await expect(feedback(page, 'status')).toContainText(`已新增屆別 ${CODE_A}`)
  await expect(rowOf(page, CODE_A)).toContainText('籌備中')
  await expect(rowOf(page, CODE_A)).toContainText(`${CODE_A} 測試屆`)
  // 成功後表單清空，可以接著建下一屆。
  await expect(page.getByLabel('代碼')).toHaveValue('')

  await createCohort(page, CODE_A, '同一個代碼')
  await expect(feedback(page, 'alert')).toContainText('已經有人用了')
  // 失敗時剛填的字留著，不用重打。
  await expect(page.getByLabel('名稱')).toHaveValue('同一個代碼')
  await expect(rowOf(page, CODE_A)).toHaveCount(1)

  await page.getByLabel('代碼').fill(CODE_B)
  await page.getByLabel('名稱').fill(`${CODE_B} 測試屆`)
  await page.getByRole('button', { name: '新增屆別' }).click()
  await expect(feedback(page, 'status')).toContainText(`已新增屆別 ${CODE_B}`)
  await expect(rowOf(page, CODE_B)).toContainText('籌備中')
})

test('開放註冊屆別只有一個：交給另一屆時舊的自動取消', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/dashboard/admin/cohorts')

  await page.getByRole('button', { name: `把 ${CODE_A} 設為開放註冊屆別` }).click()
  await expect(feedback(page, 'status')).toContainText(`已把 ${CODE_A} 設為開放註冊屆別`)
  await expect(rowOf(page, CODE_A)).toContainText('開放註冊中')
  // 有開放註冊屆別之後，提示就不見了。
  await expect(page.getByRole('note', { name: '尚未設定開放註冊屆別' })).toHaveCount(0)

  await page.getByRole('button', { name: `把 ${CODE_B} 設為開放註冊屆別` }).click()
  await expect(feedback(page, 'status')).toContainText(`${CODE_A} 的開放註冊屆別已自動取消`)
  await expect(rowOf(page, CODE_B)).toContainText('開放註冊中')
  await expect(rowOf(page, CODE_A)).not.toContainText('開放註冊中')
  await expect(page.getByRole('button', { name: `把 ${CODE_A} 設為開放註冊屆別` })).toBeVisible()
  await expect(page.getByText('開放註冊中')).toHaveCount(1)
})

test('預設工作屆別與開放註冊屆別是兩件事，可以是不同屆；重新整理後都還在', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/dashboard/admin/cohorts')

  await page.getByRole('button', { name: `把 ${CODE_A} 設為預設工作屆別` }).click()
  await expect(feedback(page, 'status')).toContainText(`已把 ${CODE_A} 設為預設工作屆別`)

  await page.getByRole('button', { name: `把 ${CODE_B} 設為預設工作屆別` }).click()
  await expect(feedback(page, 'status')).toContainText(`${CODE_A} 的預設工作屆別已自動取消`)

  await page.getByRole('button', { name: `把 ${CODE_A} 設為預設工作屆別` }).click()
  await expect(feedback(page, 'status')).toContainText(`${CODE_B} 的預設工作屆別已自動取消`)

  // 離開再回來：存在資料庫，不是只改了畫面。
  await page.reload()
  await expect(rowOf(page, CODE_A)).toContainText('預設工作中')
  await expect(rowOf(page, CODE_A)).not.toContainText('開放註冊中')
  await expect(rowOf(page, CODE_B)).toContainText('開放註冊中')
  await expect(rowOf(page, CODE_B)).not.toContainText('預設工作中')
  await expect(page.getByText('預設工作中')).toHaveCount(1)
  await expect(page.getByText('開放註冊中')).toHaveCount(1)
})

test.describe('手機寬度', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('屆別表格自己橫向捲，頁面本體不捲', async ({ page }) => {
    await signInAsAdmin(page)
    await page.goto('/dashboard/admin/cohorts')
    await expect(rowOf(page, CODE_A)).toHaveCount(1)

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    expect(overflows, '窄螢幕不應該出現橫向捲動').toBe(false)
  })
})
