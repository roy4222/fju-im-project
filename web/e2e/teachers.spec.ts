import { expect, test, type Browser, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 票 8：老師帳號與臨時密碼，用**真的畫面**走完「做完的樣子」三條。
 *
 * 1. 管理員用「新增成員」建老師（C2-09：不發密碼，寄「請設定密碼」信）；老師第一次登入補姓名與聯絡資料後進老師首頁。
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

/** 老師用「請設定密碼」信裡的連結設好密碼（信存在 `mail_outbox`，e2e 用擷取模式）。 */
async function setPasswordFromMail(page: Page, email: string, password: string) {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 1 })
  let body = ''
  try {
    for (let i = 0; i < 75 && !body; i += 1) {
      const row = await owner.query<{ body_text: string | null }>(
        `select body_text from mail_outbox where to_email = $1 and template = 'password_reset' order by created_at desc limit 1`,
        [email],
      )
      body = row.rows[0]?.body_text ?? ''
      if (!body) await new Promise((resolve) => setTimeout(resolve, 200))
    }
  } finally {
    await owner.end()
  }
  const url = /https?:\/\/\S+?\/reset-password\?token=[^\s。，]+/.exec(body)?.[0]
  if (!url) throw new Error(`mail_outbox 沒有 ${email} 的設定密碼信（e2e 要 MAIL_CAPTURE=1）`)
  const parsed = new URL(url)
  await page.goto(`${parsed.pathname}${parsed.search}`)
  await page.getByLabel('新密碼', { exact: true }).fill(password)
  await page.getByLabel('確認密碼').fill(password)
  await page.getByRole('button', { name: '重設密碼' }).click()
  await expect(page.getByText('密碼已重設，請用新密碼登入')).toBeVisible()
}

async function changePassword(page: Page, current: string) {
  await expect(page).toHaveURL(/\/account\/change-password$/)
  await expect(page.getByRole('heading', { name: '請先更改密碼' })).toBeVisible()
  await page.getByLabel('目前的一次性密碼').fill(current)
  await page.getByLabel('新密碼', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('再輸入一次新密碼').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: '設定新密碼' }).click()
}

test('1＋3：新增成員（老師）→ 寄請設定密碼信 → 老師自己設密碼登入 → 補資料 → 老師首頁；系辦拿不到任何密碼', async ({ browser }) => {
  const email = `t08-direct-${run}@example.com`
  const admin = await adminPage(browser)
  await admin.goto('/dashboard/admin/accounts')

  // C2-09：新增成員不再發臨時密碼，也不問核實方式；改寄「請設定密碼」信，密碼由老師自己設。
  await admin.getByRole('button', { name: '新增成員', exact: true }).click()
  const dialog = admin.getByRole('dialog', { name: '新增成員' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('radio', { name: /^老師/ }).check()
  await dialog.getByLabel('登入 Email').fill(email)
  await dialog.getByLabel('姓名').fill('林直接老師')
  await dialog.getByRole('button', { name: '新增老師' }).click()
  await expect(dialog.getByRole('status')).toContainText('已新增老師')
  await expect(dialog.getByTestId('temporary-password')).toHaveCount(0)
  await dialog.getByRole('button', { name: '關閉' }).click()

  // 3. 關掉就沒有東西可拿：重新打開是空白表單。
  await admin.getByRole('button', { name: '新增成員', exact: true }).click()
  await expect(dialog.getByLabel('登入 Email')).toHaveValue('')
  await dialog.getByRole('button', { name: '取消' }).click()

  // 老師：用信裡的連結設密碼 → 登入 → 補資料 → 老師首頁（密碼是自己設的，不用再改）。
  const teacher = await freshPage(browser)
  await setPasswordFromMail(teacher, email, NEW_PASSWORD)
  await signIn(teacher, email, NEW_PASSWORD)
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
  await expect(teacher.getByRole('heading', { name: /^歡迎回來，/ })).toBeVisible()

  // 重新登入直接進老師首頁。
  await teacher.context().clearCookies()
  await signIn(teacher, email, NEW_PASSWORD)
  await expect(teacher).toHaveURL(/\/dashboard\/teacher$/)
  await teacher.context().close()
})

test('1：新增成員（老師）後 Email 被占住，別人拿同一個 Email 註冊被拒；系辦發臨時密碼後老師登入補資料', async ({ browser }) => {
  const email = `t08-preauth-${run}@example.com`
  const admin = await adminPage(browser)
  await admin.goto('/dashboard/admin/accounts')

  await admin.getByRole('button', { name: '新增成員', exact: true }).click()
  const dialog = admin.getByRole('dialog', { name: '新增成員' })
  await dialog.getByRole('radio', { name: /^老師/ }).check()
  // 新增成員不發密碼，也不需要核實方式。
  await expect(dialog.getByText('怎麼確認是本人')).toHaveCount(0)
  await dialog.getByLabel('登入 Email').fill(email)
  await dialog.getByLabel('姓名').fill('陳預授權老師')
  await dialog.getByRole('button', { name: '新增老師' }).click()
  await expect(dialog.getByRole('status')).toContainText('已新增老師')
  await expect(dialog.getByTestId('temporary-password')).toHaveCount(0)
  await dialog.getByRole('button', { name: '關閉' }).click()

  // 搶先註冊：同一個 Email 被拒（統一訊息），不會多出一個帳號。
  const hijacker = await freshPage(browser)
  await hijacker.goto('/register')
  await hijacker.getByLabel('Email', { exact: true }).fill(email)
  await hijacker.getByLabel('密碼', { exact: true }).fill('Hijacker-Password-2026')
  await hijacker.getByLabel('確認密碼').fill('Hijacker-Password-2026')
  await hijacker.getByRole('button', { name: '建立帳號' }).click()
  await expect(hijacker.getByText('這個 Email 無法用來註冊')).toBeVisible()
  await hijacker.context().close()

  // 系辦用 Email 找到這位老師那一列，核實後發臨時密碼（C 階段規格② A15：標題列不再有「發臨時密碼」，改在每一列）。
  await admin.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(email)}`)
  await admin.getByRole('table', { name: '帳號列表' }).getByRole('row').filter({ hasText: email }).getByRole('button', { name: /^發臨時密碼給/ }).click()
  const temp = admin.getByRole('dialog', { name: '發臨時密碼' })
  await expect(temp).toContainText('老師')
  // C2-11：發臨時密碼不再問怎麼確認是本人（伺服器一律記 office_review）。
  await expect(temp).not.toContainText('怎麼確認')
  await expect(temp.getByRole('radio')).toHaveCount(0)
  await temp.getByRole('button', { name: '產生一次性密碼' }).click()
  const secret = (await temp.getByTestId('temporary-password').innerText()).trim()
  await temp.getByRole('button', { name: '關閉' }).click()

  const teacher = await freshPage(browser)
  await signIn(teacher, email, secret)
  await changePassword(teacher, secret)
  await expect(teacher).toHaveURL(/\/account\/setup$/)
  await expect(teacher.getByLabel('姓名')).toHaveValue('陳預授權老師')
  await teacher.getByRole('button', { name: '儲存並進入老師首頁' }).click()
  await expect(teacher).toHaveURL(/\/dashboard\/teacher$/)
  await teacher.context().close()
})

test('2＋3：替待審學生發臨時密碼 → 舊登入被登出、舊密碼失效 → 用臨時密碼登入被強制改密；重新核發讓上一組失效', async ({
  browser,
}) => {
  const student = await freshPage(browser)
  const session = await createTestSession(student.request, null)
  // VB-2 之後「沒驗證 Email、沒送申請」的密碼帳號登入會先被帶去 /register/verify（AC-VI-50）；
  // 這條測的是臨時密碼，前置當成已驗證 Email 的待審學生。
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  try {
    await owner.query('update users set email_verified = true where email = $1', [session.email])
  } finally {
    await owner.end()
  }
  await student.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await student.goto('/register/pending')
  // 沒送申請的待審帳號會被帶去第 3 步（VB-6）。
  await expect(student).toHaveURL(/\/register\/apply$/)

  const admin = await adminPage(browser)
  await admin.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(session.email)}`)
  await admin
    .getByRole('table', { name: '帳號列表' })
    .getByRole('row')
    .filter({ hasText: session.email })
    .getByRole('button', { name: /^寄重設密碼信給/ })
    .click()
  // C2-11：有密碼的人先是「寄重設密碼信」，信收不到才從視窗裡改發臨時密碼，而且不問怎麼確認是本人。
  await admin.getByRole('dialog', { name: '寄重設密碼信' }).getByRole('button', { name: '改發臨時密碼' }).click()
  const temp = admin.getByRole('dialog', { name: '發臨時密碼' })
  await expect(temp).toContainText('待審核')
  await expect(temp).not.toContainText('怎麼確認')
  await temp.getByLabel(/理由/).fill('忘記密碼，到系辦櫃台')
  await temp.getByRole('button', { name: '產生一次性密碼' }).click()
  const first = (await temp.getByTestId('temporary-password').innerText()).trim()

  // 重新核發：新的一組，舊的那組失效。
  await temp.getByRole('button', { name: '重新核發' }).click()
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
  // 待審學生改完密碼回等待審核頁；沒送申請的待審帳號會被帶去第 3 步（VB-6）。
  await expect(student).toHaveURL(/\/register\/apply$/)
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
