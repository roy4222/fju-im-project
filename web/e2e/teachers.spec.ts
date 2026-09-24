import { expect, test, type Browser, type Page } from '@playwright/test'
import { createTestSession, sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 票 8：老師帳號與臨時密碼，用**真的畫面**走完「做完的樣子」三條。
 *
 * 1. 管理員直接新增老師，或先用 Email 建立預授權；老師第一次登入補姓名與聯絡資料後進老師首頁。
 * 2. 管理員替任一帳號核發只顯示一次的臨時密碼，發之前必須記錄核實方式；對方登入後被強制改密。
 * 3. 沒有任何畫面能看到既有密碼（關掉對話框、重新整理都拿不回來）。
 * 另外：預授權的 Email 別人不能搶先註冊。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const run = Date.now().toString(36)
const NEW_PASSWORD = 'Teacher-New-Password-2026'

test.describe.configure({ mode: 'serial' })

let ipCounter = 0
function uniqueIp(): string {
  ipCounter += 1
  return `10.208.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
}

async function adminPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const session = await sharedTestSession(page.request, 'admin')
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  return page
}

async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-real-ip': uniqueIp() } })
  return context.newPage()
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('密碼', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 })
}

async function changePassword(page: Page, current: string) {
  await expect(page).toHaveURL(/\/account\/change-password$/)
  await expect(page.getByRole('heading', { name: '請先更改密碼' })).toBeVisible()
  await page.getByLabel('目前的一次性密碼').fill(current)
  await page.getByLabel('新密碼', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('再輸入一次新密碼').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: '設定新密碼' }).click()
}

test('1＋2＋3：直接新增老師 → 臨時密碼只顯示一次 → 老師登入先改密碼 → 補資料 → 老師首頁', async ({ browser }) => {
  const email = `t08-direct-${run}@example.com`
  const admin = await adminPage(browser)
  await admin.goto('/dashboard/admin/accounts')

  await admin.getByRole('button', { name: '新增老師', exact: true }).click()
  const dialog = admin.getByRole('dialog', { name: '新增老師' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('登入 Email').fill(email)
  await dialog.getByLabel('姓名').fill('林直接老師')

  // 直接新增會發臨時密碼：沒選核實方式就不送。
  await dialog.getByRole('button', { name: '建立並產生臨時密碼' }).click()
  await expect(dialog.getByRole('alert')).toContainText('請選擇怎麼確認是本人')
  await dialog.getByLabel('當面核對學生證或其他身分證件').check()
  await dialog.getByRole('button', { name: '建立並產生臨時密碼' }).click()

  await expect(dialog.getByRole('status')).toContainText('只顯示這一次')
  const secret = (await dialog.getByTestId('temporary-password').innerText()).trim()
  expect(secret).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/)
  await dialog.getByRole('button', { name: '關閉' }).click()

  // 3. 關掉就拿不回來：重新打開是空白表單，整頁（含 RSC payload）找不到這組密碼。
  await admin.getByRole('button', { name: '新增老師', exact: true }).click()
  await expect(dialog.getByTestId('temporary-password')).toHaveCount(0)
  await expect(dialog.getByLabel('登入 Email')).toHaveValue('')
  await dialog.getByRole('button', { name: '取消' }).click()
  const html = await (await admin.request.get('/dashboard/admin/accounts')).text()
  expect(html).not.toContain(secret)

  // 老師：用臨時密碼登入 → 被逼著改密碼 → 補資料 → 老師首頁。
  const teacher = await freshPage(browser)
  await signIn(teacher, email, secret)
  await teacher.goto('/dashboard/teacher')
  await expect(teacher, '改密前哪裡都去不了').toHaveURL(/\/account\/change-password$/)
  await changePassword(teacher, secret)

  await expect(teacher).toHaveURL(/\/account\/setup$/)
  await expect(teacher.getByRole('heading', { name: '第一次登入：補上你的資料' })).toBeVisible()
  await expect(teacher.getByLabel('姓名')).toHaveValue('林直接老師')
  await expect(teacher.getByLabel('聯絡 Email')).toHaveValue(email)
  // 補完之前開老師頁會被帶回來。
  await teacher.goto('/dashboard/teacher')
  await expect(teacher).toHaveURL(/\/account\/setup$/)

  await teacher.getByLabel('手機').fill('0911-111-111')
  await teacher.getByRole('button', { name: '儲存並進入老師首頁' }).click()
  await expect(teacher).toHaveURL(/\/dashboard\/teacher$/)
  await expect(teacher.getByRole('heading', { name: '老師首頁' })).toBeVisible()

  // 臨時密碼從此失效；新密碼登得進去，直接進老師首頁。
  await teacher.context().clearCookies()
  await teacher.goto('/login')
  await teacher.getByLabel('Email').fill(email)
  await teacher.getByLabel('密碼', { exact: true }).fill(secret)
  await teacher.getByRole('button', { name: '登入', exact: true }).click()
  await expect(teacher.getByText('Email 或密碼不正確')).toBeVisible()
  await signIn(teacher, email, NEW_PASSWORD)
  await expect(teacher).toHaveURL(/\/dashboard\/teacher$/)
  await teacher.context().close()
})

test('1：預授權只用 Email；別人拿同一個 Email 註冊被拒；系辦發臨時密碼後老師登入補資料', async ({ browser }) => {
  const email = `t08-preauth-${run}@example.com`
  const admin = await adminPage(browser)
  await admin.goto('/dashboard/admin/accounts')

  await admin.getByRole('button', { name: '新增老師', exact: true }).click()
  const dialog = admin.getByRole('dialog', { name: '新增老師' })
  await dialog.getByLabel('只用 Email 預授權').check()
  // 預授權不發密碼，也就不需要核實方式。
  await expect(dialog.getByText('怎麼確認是本人')).toHaveCount(0)
  await dialog.getByLabel('登入 Email').fill(email)
  await dialog.getByRole('button', { name: '建立預授權' }).click()
  await expect(dialog.getByRole('status')).toContainText('已建立預授權')
  await expect(dialog.getByTestId('temporary-password')).toHaveCount(0)
  await dialog.getByRole('button', { name: '關閉' }).click()

  // 搶先註冊：同一個 Email 被拒（統一訊息），不會多出一個帳號。
  const hijacker = await freshPage(browser)
  await hijacker.goto('/register')
  await hijacker.getByLabel('姓名').fill('冒用者')
  await hijacker.getByLabel('學號').fill('499999999')
  await hijacker.getByLabel('系級').fill('資管二甲')
  await hijacker.getByLabel('手機').fill('0912-345-678')
  await hijacker.getByLabel('登入 Email').fill(email)
  await hijacker.getByLabel('密碼', { exact: true }).fill('Hijacker-Password-2026')
  await hijacker.getByLabel('確認密碼').fill('Hijacker-Password-2026')
  await hijacker.getByRole('button', { name: '送出註冊' }).click()
  await expect(hijacker.getByText('這個 Email 無法用來註冊')).toBeVisible()
  await hijacker.context().close()

  // 系辦用 Email 查到這位老師，核實後發臨時密碼。
  await admin.getByRole('button', { name: '發臨時密碼', exact: true }).click()
  const temp = admin.getByRole('dialog', { name: '發臨時密碼' })
  await temp.getByLabel('登入 Email').fill(email)
  await temp.getByRole('button', { name: '查詢' }).click()
  await expect(temp).toContainText('老師')
  await temp.getByLabel('經校方授權人員透過既有可信管道確認').check()
  await temp.getByRole('button', { name: '產生一次性密碼' }).click()
  // 校方管道要寫由誰、透過什麼管道——伺服器擋下。
  await expect(temp.getByRole('alert')).toContainText('由誰、透過什麼管道')
  await temp.getByLabel(/核實說明/).fill('系主任秘書以系上分機回撥確認')
  await temp.getByRole('button', { name: '產生一次性密碼' }).click()
  const secret = (await temp.getByTestId('temporary-password').innerText()).trim()
  await temp.getByRole('button', { name: '關閉' }).click()

  const teacher = await freshPage(browser)
  await signIn(teacher, email, secret)
  await changePassword(teacher, secret)
  await expect(teacher).toHaveURL(/\/account\/setup$/)
  // 預授權沒填姓名：不把 Email 當成姓名預填。
  await expect(teacher.getByLabel('姓名')).toHaveValue('')
  await teacher.getByLabel('姓名').fill('陳預授權老師')
  await teacher.getByRole('button', { name: '儲存並進入老師首頁' }).click()
  await expect(teacher).toHaveURL(/\/dashboard\/teacher$/)
  await teacher.context().close()
})

test('2＋3：替待審學生發臨時密碼 → 舊登入被登出、舊密碼失效 → 用臨時密碼登入被強制改密；重新核發讓上一組失效', async ({
  browser,
}) => {
  const student = await freshPage(browser)
  const session = await createTestSession(student.request, null)
  await student.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await student.goto('/register/pending')
  await expect(student).toHaveURL(/\/register\/pending$/)

  const admin = await adminPage(browser)
  await admin.goto('/dashboard/admin/accounts')
  await admin.getByRole('button', { name: '發臨時密碼', exact: true }).click()
  const temp = admin.getByRole('dialog', { name: '發臨時密碼' })
  await temp.getByLabel('登入 Email').fill(session.email)
  await temp.getByRole('button', { name: '查詢' }).click()
  await expect(temp).toContainText('待審核')

  // 沒選核實方式不送。
  await temp.getByRole('button', { name: '產生一次性密碼' }).click()
  await expect(temp.getByRole('alert')).toContainText('發臨時密碼前一定要核實本人')
  await temp.getByLabel('當面核對學生證或其他身分證件').check()
  await temp.getByLabel(/理由/).fill('忘記密碼，到系辦櫃台')
  await temp.getByRole('button', { name: '產生一次性密碼' }).click()
  const first = (await temp.getByTestId('temporary-password').innerText()).trim()

  // 重新核發：新的一組，舊的那組失效。
  await temp.getByRole('button', { name: '重新核發' }).click()
  await temp.getByLabel('當面核對學生證或其他身分證件').check()
  await temp.getByRole('button', { name: '產生一次性密碼' }).click()
  const second = (await temp.getByTestId('temporary-password').innerText()).trim()
  expect(second).not.toBe(first)
  await temp.getByRole('button', { name: '關閉' }).click()

  // 學生舊分頁：下一個動作就被登出。
  await student.goto('/register/pending')
  await expect(student).toHaveURL(/\/login/)

  // 舊密碼、第一組臨時密碼都不能用；第二組可以，而且被強制改密。
  for (const stale of ['E2e-Password-Correct-9', first]) {
    await student.goto('/login')
    await student.getByLabel('Email').fill(session.email)
    await student.getByLabel('密碼', { exact: true }).fill(stale)
    await student.getByRole('button', { name: '登入', exact: true }).click()
    await expect(student.getByText('Email 或密碼不正確')).toBeVisible()
  }
  await signIn(student, session.email, second)
  await expect(student).toHaveURL(/\/account\/change-password$/)
  await student.goto('/register/pending')
  await expect(student, '改密前連待審頁也不能看').toHaveURL(/\/account\/change-password$/)
  await changePassword(student, second)
  // 待審學生改完密碼回等待審核頁。
  await expect(student).toHaveURL(/\/register\/pending$/)
  await student.context().close()
})

test('非管理員拿不到這兩個對話框', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const session = await sharedTestSession(page.request, 'teacher')
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto('/dashboard/admin/accounts')
  await expect(page).toHaveURL(/\/403$/)
  await expect(page.getByRole('button', { name: '發臨時密碼' })).toHaveCount(0)
  await context.close()
})
