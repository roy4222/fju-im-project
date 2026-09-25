import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import {
  accountRow,
  adminCredentials,
  adminPage,
  cohortRow,
  disableAccount,
  expectStatus,
  fillSecret,
  firstLine,
  newPage,
  pendingRow,
  readFlags,
  restoreFlags,
  retireAccount,
  screenshotter,
  searchAccounts,
  signIn,
  type Flags,
} from './helpers'

/**
 * 第 2 站：帳號與身分（票 5–10、10b「做完的樣子」），對測試站走一次真實流程。
 *
 * 建屆別（開放註冊＋預設工作）→ 匯入名單 → 新學生註冊 → 待審 → 管理員比對核准 → 學生登入 →
 * 新增老師拿臨時密碼 → 老師被逼改密 → 補資料 → 帳號列表搜尋／篩選 → 停用學生（舊分頁被登出）→ 恢復 →
 * 匯出勾選帳號 CSV → 老師設為／取消管理員、自己那列不能取消 → Google 按鈕導去 Google（不真的登入）。
 *
 * - 每次跑都用唯一前綴（屆別 `ACC<時間戳>`、學號前綴、姓名標籤），重跑不會撞到上一次的資料。
 * - 註冊限速每 IP 每小時 30 次，而且 Caddy 會覆寫來源 IP：整套只註冊**一個**學生。
 * - 管理員只用表單登入一次，整條流程共用那個分頁（登入限速 10 分鐘 10 次）。
 * - 開放註冊／預設工作兩個旗標是全系唯一的狀態：跑完把它們還給原本的屆別。
 * - 收尾（不論成敗）：先還旗標，再收掉這一輪的學生（待審就退回、已核准就停用）與老師（只認這一輪的姓名標籤）；屆別與名單版本後台沒有刪除，留著。
 * - 前一步失敗，後面就跳過（serial）。
 */

test.describe.configure({ mode: 'serial' })

const shot = screenshotter('station-2')

const now = Date.now()
const COHORT_CODE = `ACC${now}`
const COHORT_NAME = `驗收屆 ${COHORT_CODE}`
const prefix = String(now).slice(-7)
/** 姓名標籤：搜尋它就只會找到這一輪的學生與老師。 */
const TAG = `驗收${prefix}`
const STUDENT = {
  name: `${TAG}學生`,
  // 學號帶前導零，匯出時要原樣保留。
  studentNo: `0${prefix}01`,
  email: `acc-student-${now}@example.com`,
  dept: '資管二甲',
  password: `Acc-Student-${randomBytes(6).toString('hex')}`,
}
const TEACHER = {
  name: `${TAG}老師`,
  email: `acc-teacher-${now}@example.com`,
  newPassword: `Acc-Teacher-${randomBytes(6).toString('hex')}`,
}
/** 名單另放一個不會註冊的人，預覽才看得出「有效 2 筆」。 */
const ROSTER_CSV = [
  'student_no,name,cohort,email,department_class',
  `${STUDENT.studentNo},${STUDENT.name},${COHORT_CODE},${STUDENT.email},${STUDENT.dept}`,
  `0${prefix}02,${TAG}名單同學,${COHORT_CODE},acc-roster-${now}@example.com,資管二乙`,
  '',
].join('\n')
const ROSTER_FILE = `roster-${COHORT_CODE}.csv`

let admin: Page
let adminUserId = ''
let studentContext: BrowserContext
let student: Page
let teacherTempPassword = ''
/** 跑之前握著兩個旗標的屆別代碼；跑完還回去。 */
let previousFlags: Flags = { registrationOpen: null, defaultWorking: null }
let previousFlagsRead = false
let studentRegistered = false
let teacherCreated = false

test.beforeAll(async ({ browser }) => {
  studentContext = await browser.newContext()
  student = await studentContext.newPage()
})

test.afterAll(async ({ browser }) => {
  test.setTimeout(180_000)
  // 管理員分頁掛了也要有人收尾：重登一個（旗標是全站狀態，不能留著）。
  if (previousFlagsRead && (!admin || admin.isClosed())) {
    try {
      admin = await adminPage(browser)
    } catch (error) {
      console.log(`收尾：管理員重登失敗，旗標沒還（${firstLine(error)}）`)
    }
  }
  if (admin && !admin.isClosed()) {
    // 先把兩個全系唯一的旗標還給原本的屆別，再收掉這一輪的學生與老師（只認這一輪的姓名標籤）：
    // 學生還在待審就退回、已核准就停用。
    await restoreFlags(admin, previousFlags, COHORT_CODE).catch((error: unknown) => {
      console.log(`收尾：旗標沒還成功（${firstLine(error)}）`)
    })
    if (studentRegistered) await retireAccount(admin, STUDENT.name)
    if (teacherCreated) await disableAccount(admin, TEACHER.name)
    await admin.context().close()
  }
  await studentContext?.close()
})

test('0 管理員登入（整條流程共用這個分頁）', async ({ browser }) => {
  const { email, password } = adminCredentials()
  admin = await newPage(browser)
  await signIn(admin, email, password)
  await expect(admin).not.toHaveURL(/\/login|\/account\/change-password/)
  const session = await admin.request.get('/api/auth/get-session')
  expect(session.ok()).toBe(true)
  adminUserId = ((await session.json()) as { user?: { id?: string } }).user?.id ?? ''
  expect(adminUserId, '拿不到管理員自己的 userId').not.toBe('')
  await admin.goto('/dashboard/admin')
  await expect(admin.getByRole('heading', { name: '系辦首頁' })).toBeVisible()
  await shot(admin, 'admin-home')
})

test('票 5 建屆別，設為開放註冊與預設工作屆別', async () => {
  previousFlags = await readFlags(admin)
  previousFlagsRead = true
  console.log(`跑之前：開放註冊屆別＝${previousFlags.registrationOpen ?? '（無）'}、預設工作屆別＝${previousFlags.defaultWorking ?? '（無）'}`)

  await admin.getByLabel('代碼').fill(COHORT_CODE)
  await admin.getByLabel('名稱').fill(COHORT_NAME)
  await admin.getByRole('button', { name: '新增屆別' }).click()
  await expectStatus(admin, `已新增屆別 ${COHORT_CODE}`)
  await expect(cohortRow(admin, COHORT_CODE)).toContainText('籌備中')
  await shot(admin, 'cohort-created')

  await admin.getByRole('button', { name: `把 ${COHORT_CODE} 設為開放註冊屆別` }).click()
  await expectStatus(admin, `已把 ${COHORT_CODE} 設為開放註冊屆別`)
  await admin.getByRole('button', { name: `把 ${COHORT_CODE} 設為預設工作屆別` }).click()
  await expectStatus(admin, `已把 ${COHORT_CODE} 設為預設工作屆別`)

  // 重新整理：存進資料庫；兩個旗標各只有一個。
  await admin.reload()
  await expect(cohortRow(admin, COHORT_CODE)).toContainText('開放註冊中')
  await expect(cohortRow(admin, COHORT_CODE)).toContainText('預設工作中')
  await expect(admin.getByText('開放註冊中', { exact: true })).toHaveCount(1)
  await expect(admin.getByText('預設工作中', { exact: true })).toHaveCount(1)
  await shot(admin, 'cohort-flags')
})

test('票 6 上傳名單 CSV：預覽 → 匯入 → 原檔可下載', async () => {
  await admin.goto('/dashboard/admin/accounts')
  await admin.getByRole('button', { name: '匯入名單 CSV' }).click()
  await expect(admin.getByRole('heading', { name: '匯入本屆名單' })).toBeVisible()
  await admin.getByLabel('選擇名單 CSV 檔').setInputFiles({
    name: ROSTER_FILE,
    mimeType: 'text/csv',
    buffer: Buffer.from(ROSTER_CSV, 'utf8'),
  })

  await expect(admin.getByRole('heading', { name: `預覽・${ROSTER_FILE}` })).toBeVisible()
  await expect(admin.getByTestId('roster-count-總筆數')).toHaveText('2')
  await expect(admin.getByTestId('roster-count-有效')).toHaveText('2')
  await expect(admin.getByTestId('roster-count-重複')).toHaveText('0')
  await expect(admin.getByTestId('roster-count-缺欄')).toHaveText('0')
  await expect(admin.getByTestId('roster-count-衝突')).toHaveText('0')
  // CSV 的屆別欄對得到剛建的屆別，預設就選它。
  await expect(admin.getByLabel('匯入到哪一屆').locator('option:checked')).toContainText(COHORT_NAME)
  await shot(admin, 'roster-preview')

  await admin.getByRole('button', { name: '匯入 2 筆' }).click()
  await expect(admin.getByText('已匯入', { exact: true })).toBeVisible()
  await shot(admin, 'roster-imported')
  await admin.getByRole('button', { name: '關閉' }).click()

  await admin.reload()
  const version = admin.getByRole('row').filter({ hasText: `（${COHORT_CODE}）` }).first()
  await expect(version).toBeVisible()
  const [download] = await Promise.all([
    admin.waitForEvent('download'),
    version.getByRole('link', { name: /下載/ }).click(),
  ])
  expect(download.suggestedFilename()).toBe(ROSTER_FILE)
  expect(await fs.readFile(await download.path(), 'utf8'), '原檔要原封不動').toBe(ROSTER_CSV)
  await shot(admin, 'roster-version')
})

test('票 7 新學生用密碼註冊，停在等待審核頁', async () => {
  await student.goto('/register')
  await student.getByLabel('姓名').fill(STUDENT.name)
  await student.getByLabel('學號').fill(STUDENT.studentNo)
  await student.getByLabel('系級').fill(STUDENT.dept)
  await student.getByLabel('手機').fill('0912-345-678')
  await student.getByLabel('登入 Email').fill(STUDENT.email)
  await fillSecret(student.getByLabel('密碼', { exact: true }), STUDENT.password)
  await fillSecret(student.getByLabel('確認密碼'), STUDENT.password)
  await shot(student, 'register-form')
  studentRegistered = true
  await student.getByRole('button', { name: '送出註冊' }).click()

  await expect(student).toHaveURL(/\/register\/pending$/)
  await expect(student.getByRole('heading', { name: '等待系辦審核' })).toBeVisible()
  // 名單比對結果只給系辦看。
  const body = await student.locator('body').innerText()
  for (const leak of ['名單符合', '未命中', '資料不符']) expect(body).not.toContain(leak)
  // 待審的人開其他頁一律被帶回來。
  await student.goto('/dashboard/student')
  await expect(student).toHaveURL(/\/register\/pending$/)
  await shot(student, 'register-pending')
})

test('票 7 管理員看比對結果、選核實方式後核准', async () => {
  await admin.goto('/dashboard/admin/accounts')
  const row = pendingRow(admin, STUDENT.name)
  await expect(row).toContainText('名單符合')
  await expect(row).toContainText('Email 相同')

  await admin.getByRole('button', { name: `審核 ${STUDENT.name}` }).click()
  const dialog = admin.getByRole('dialog', { name: `審核 ${STUDENT.name}` })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('table', { name: '申請資料與名冊並列' })).toContainText(STUDENT.studentNo)
  await expect(dialog.getByTestId('locked-cohort')).toContainText(COHORT_NAME)
  await shot(admin, 'review-dialog')

  // 核實方式必選。
  await dialog.getByRole('button', { name: '核准' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('請選擇核實方式。')
  await dialog.getByLabel('當面核對學生證或其他身分證件').check()
  await dialog.getByRole('button', { name: '核准' }).click()
  await expect(dialog.getByRole('status')).toContainText('已核准')
  await expect(dialog.getByRole('status')).toContainText(COHORT_NAME)
  await shot(admin, 'review-approved')
  await dialog.getByRole('button', { name: '關閉' }).click()
  await expect(pendingRow(admin, STUDENT.name)).toHaveCount(0)
})

test('票 7 學生用密碼登入進學生首頁', async () => {
  await studentContext.clearCookies()
  await signIn(student, STUDENT.email, STUDENT.password)
  await expect(student).toHaveURL(/\/dashboard\/student$/)
  await expect(student.getByRole('heading', { name: '我的專題' })).toBeVisible()
  await shot(student, 'student-home')
})

test('票 8 直接新增老師，拿到只顯示一次的臨時密碼', async () => {
  await admin.goto('/dashboard/admin/accounts')
  await admin.getByRole('button', { name: '新增老師', exact: true }).click()
  const dialog = admin.getByRole('dialog', { name: '新增老師' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('登入 Email').fill(TEACHER.email)
  await dialog.getByLabel('姓名').fill(TEACHER.name)
  await dialog.getByLabel('當面核對學生證或其他身分證件').check()
  teacherCreated = true
  await dialog.getByRole('button', { name: '建立並產生臨時密碼' }).click()

  await expect(dialog.getByRole('status')).toContainText('只顯示這一次')
  teacherTempPassword = (await dialog.getByTestId('temporary-password').innerText()).trim()
  // 不用 `toMatch`：斷言失敗時 Received 會把臨時密碼印出來。只比布林值。
  expect(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/.test(teacherTempPassword), '臨時密碼格式不對（值不印出）').toBe(true)
  await dialog.getByRole('button', { name: '關閉' }).click()

  // 關掉就拿不回來：重新打開是空白表單。截圖在關掉之後拍，臨時密碼不落地。
  await admin.getByRole('button', { name: '新增老師', exact: true }).click()
  await expect(dialog.getByTestId('temporary-password')).toHaveCount(0)
  await expect(dialog.getByLabel('登入 Email')).toHaveValue('')
  await shot(admin, 'teacher-dialog-reopened')
  await dialog.getByRole('button', { name: '取消' }).click()
})

test('票 8 老師用臨時密碼登入被強制改密，補資料後進老師首頁', async ({ browser }) => {
  const teacher = await newPage(browser)
  try {
    await signIn(teacher, TEACHER.email, teacherTempPassword)
    await expect(teacher).toHaveURL(/\/account\/change-password$/)
    await expect(teacher.getByRole('heading', { name: '請先更改密碼' })).toBeVisible()
    // 改密前哪裡都去不了。
    await teacher.goto('/dashboard/teacher')
    await expect(teacher).toHaveURL(/\/account\/change-password$/)
    await shot(teacher, 'teacher-must-change-password')

    await fillSecret(teacher.getByLabel('目前的一次性密碼'), teacherTempPassword)
    await fillSecret(teacher.getByLabel('新密碼', { exact: true }), TEACHER.newPassword)
    await fillSecret(teacher.getByLabel('再輸入一次新密碼'), TEACHER.newPassword)
    await teacher.getByRole('button', { name: '設定新密碼' }).click()

    await expect(teacher).toHaveURL(/\/account\/setup$/)
    await expect(teacher.getByRole('heading', { name: '第一次登入：補上你的資料' })).toBeVisible()
    await expect(teacher.getByLabel('姓名')).toHaveValue(TEACHER.name)
    await teacher.getByLabel('手機').fill('0911-111-111')
    await shot(teacher, 'teacher-setup')
    await teacher.getByRole('button', { name: '儲存並進入老師首頁' }).click()
    await expect(teacher).toHaveURL(/\/dashboard\/teacher$/)
    await expect(teacher.getByRole('heading', { name: '老師首頁' })).toBeVisible()
    await shot(teacher, 'teacher-home')
  } finally {
    await teacher.context().close()
  }
})

test('票 9 帳號列表：三個磚、搜尋、篩選', async () => {
  await admin.goto('/dashboard/admin/accounts')
  for (const label of ['待審核', '已核准', '已停用']) {
    await expect(admin.getByRole('link', { name: new RegExp(`^${label}`) })).toBeVisible()
  }

  // 搜尋姓名標籤：只剩這一輪的學生與老師。
  await searchAccounts(admin, TAG)
  const table = admin.getByRole('table', { name: '帳號列表' })
  await expect(table.locator('tbody tr')).toHaveCount(2)
  await expect(accountRow(admin, STUDENT.name)).toContainText('已核准')
  await expect(accountRow(admin, TEACHER.name)).toBeVisible()
  // 搜尋學號。
  await searchAccounts(admin, STUDENT.studentNo)
  await expect(accountRow(admin, STUDENT.name)).toBeVisible()
  await shot(admin, 'accounts-search')

  // 篩選：搜尋＋角色＋屆別＋狀態。
  await admin.goto('/dashboard/admin/accounts')
  const form = admin.getByRole('search', { name: '篩選帳號' })
  await form.getByRole('searchbox', { name: '搜尋' }).fill(TAG)
  await form.getByRole('searchbox', { name: '搜尋' }).press('Enter')
  await expect(admin).toHaveURL(/q=/)
  await admin.getByRole('button', { name: '篩選角色' }).click()
  await admin.getByRole('menuitemradio', { name: '學生' }).click()
  await expect(admin).toHaveURL(/role=student/)
  await admin.getByRole('button', { name: '篩選屆別' }).click()
  await admin.getByRole('menuitemradio', { name: `${COHORT_NAME}（${COHORT_CODE}）` }).click()
  await expect(admin).toHaveURL(/cohort=/)
  await admin.getByRole('button', { name: '篩選狀態' }).click()
  await admin.getByRole('menuitemradio', { name: '已核准' }).click()
  await expect(admin).toHaveURL(/status=active/)
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(accountRow(admin, STUDENT.name)).toBeVisible()
  await expect(accountRow(admin, TEACHER.name)).toHaveCount(0)
  await shot(admin, 'accounts-filter')
})

test('票 9 停用學生：他的下一個動作就被登出、不能再登入', async () => {
  // 學生的「舊分頁」：還登入著、開著學生首頁。
  await student.goto('/dashboard/student')
  await expect(student).toHaveURL(/\/dashboard\/student$/)

  await searchAccounts(admin, STUDENT.name)
  await accountRow(admin, STUDENT.name).getByRole('button', { name: `停用 ${STUDENT.name}` }).click()
  const dialog = admin.getByRole('dialog', { name: `停用 ${STUDENT.name}` })
  await dialog.getByLabel(/理由/).fill('站驗收：停用測試')
  await dialog.getByRole('button', { name: '確認停用' }).click()
  await expect(dialog.getByRole('status')).toContainText('已停用')
  await shot(admin, 'student-disabled')
  await dialog.getByRole('button', { name: '關閉' }).click()
  await expect(accountRow(admin, STUDENT.name)).toContainText('已停用')

  await student.reload()
  await expect(student).toHaveURL(/\/login/)
  await shot(student, 'student-kicked-out')
  await signIn(student, STUDENT.email, STUDENT.password)
  await expect(student).toHaveURL(/\/login/)
  await expect(student.locator('p[role="alert"]')).toBeVisible()
})

test('票 9 恢復學生：可以再登入', async () => {
  await accountRow(admin, STUDENT.name).getByRole('button', { name: `恢復 ${STUDENT.name}` }).click()
  const dialog = admin.getByRole('dialog', { name: `恢復 ${STUDENT.name}` })
  await dialog.getByLabel(/理由/).fill('站驗收：恢復測試')
  await dialog.getByRole('button', { name: '確認恢復' }).click()
  await expect(dialog.getByRole('status')).toContainText('已恢復')
  await dialog.getByRole('button', { name: '關閉' }).click()
  await expect(accountRow(admin, STUDENT.name)).toContainText('已核准')
  await shot(admin, 'student-restored')

  await signIn(student, STUDENT.email, STUDENT.password)
  await expect(student).toHaveURL(/\/dashboard\/student$/)
  await shot(student, 'student-back')
})

test('票 9 匯出勾選帳號 CSV：下載、UTF-8 BOM、學號保留前導零', async () => {
  await searchAccounts(admin, TAG)
  await accountRow(admin, STUDENT.name).getByRole('checkbox').check()
  await accountRow(admin, TEACHER.name).getByRole('checkbox').check()
  await expect(admin.getByTestId('selected-count')).toHaveText('已勾選 2 筆')

  const [download] = await Promise.all([
    admin.waitForEvent('download'),
    admin.getByRole('button', { name: '匯出勾選的 CSV' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^帳號名單-\d{8}-\d{4}\.csv$/)
  const bytes = await fs.readFile(await download.path())
  expect([...bytes.subarray(0, 3)], '開頭要有 UTF-8 BOM').toEqual([0xef, 0xbb, 0xbf])
  const lines = bytes.toString('utf8').slice(1).trimEnd().split('\r\n')
  expect(lines[0]).toBe('"姓名","學號","系級","屆別","手機","登入 Email","聯絡 Email","角色","狀態"')
  expect(lines).toHaveLength(3)
  const studentLine = lines.find((l) => l.startsWith(`"${STUDENT.name}"`)) ?? ''
  expect(studentLine).toContain(`"${STUDENT.studentNo}"`)
  expect(STUDENT.studentNo.startsWith('0')).toBe(true)
  expect(studentLine).toContain(`"${COHORT_CODE}"`)
  expect(studentLine).toMatch(/"學生","已核准"$/)
  const teacherLine = lines.find((l) => l.startsWith(`"${TEACHER.name}"`)) ?? ''
  expect(teacherLine).toContain('"老師"')
  await expect(admin.getByRole('status')).toContainText('已匯出 2 筆')
  await shot(admin, 'accounts-exported')
})

test('票 10b 老師設為管理員再取消；自己那一列不能取消', async () => {
  await searchAccounts(admin, TEACHER.name)
  const row = accountRow(admin, TEACHER.name)
  await row.getByRole('button', { name: `設為管理員 ${TEACHER.name}` }).click()
  const grant = admin.getByRole('dialog', { name: `設為管理員 ${TEACHER.name}` })
  await grant.getByRole('button', { name: '確認設為管理員' }).click()
  await expect(grant.getByRole('alert')).toHaveText('請寫理由。')
  await grant.getByLabel(/理由/).fill('站驗收：設為管理員')
  await grant.getByRole('button', { name: '確認設為管理員' }).click()
  await expect(grant.getByRole('status')).toContainText('已設為管理員')
  await grant.getByRole('button', { name: '關閉' }).click()
  await expect(row.getByRole('button', { name: `取消管理員 ${TEACHER.name}` })).toBeVisible()
  await shot(admin, 'teacher-granted-admin')

  await row.getByRole('button', { name: `取消管理員 ${TEACHER.name}` }).click()
  const revoke = admin.getByRole('dialog', { name: `取消管理員 ${TEACHER.name}` })
  await revoke.getByLabel(/理由/).fill('站驗收：取消管理員')
  await revoke.getByRole('button', { name: '確認取消管理員' }).click()
  await expect(revoke.getByRole('status')).toContainText('已取消管理員')
  await revoke.getByRole('button', { name: '關閉' }).click()
  await expect(row.getByRole('button', { name: `設為管理員 ${TEACHER.name}` })).toBeVisible()
  await shot(admin, 'teacher-revoked-admin')

  // 自己那一列：用角色篩選找（不把自己的 Email 放進網址）。
  await admin.goto('/dashboard/admin/accounts?role=admin')
  const self = admin.getByRole('table', { name: '帳號列表' }).locator(`tr[data-user-id="${adminUserId}"]`)
  await expect(self).toBeVisible()
  await expect(self.getByRole('button', { name: /取消管理員/ })).toHaveCount(0)
  await expect(self.getByRole('button', { name: /停用/ })).toHaveCount(0)
  await shot(admin, 'admin-self-row')
})

test('票 10 Google 登入／註冊按鈕導去 accounts.google.com（不真的登入）', async ({ browser }) => {
  const context = await browser.newContext()
  const seen: { url: URL | null } = { url: null }
  // 攔在瀏覽器端，回一頁替身：只驗導去哪裡，不真的打 Google。
  await context.route('https://accounts.google.com/**', async (route) => {
    seen.url = new URL(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Google（驗收替身）</title>' })
  })
  const page = await context.newPage()
  try {
    for (const [path, label] of [
      ['/login', '使用 Google 帳號登入'],
      ['/register', '使用 Google 帳號註冊'],
    ] as const) {
      seen.url = null
      await page.goto(path)
      const button = page.getByRole('button', { name: label })
      await expect(button).toBeVisible()
      await button.click()
      await expect.poll(() => seen.url?.origin ?? null).toBe('https://accounts.google.com')
      expect(seen.url!.searchParams.get('redirect_uri')).toBe('https://test.fju.roy422.dev/api/auth/callback/google')
      expect(seen.url!.searchParams.get('state')).toBeTruthy()
    }
    await shot(page, 'google-redirect')
  } finally {
    await context.close()
  }
})
