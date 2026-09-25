import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  adminPage,
  approveStudent,
  cohortRow,
  createTeacher,
  disableAccount,
  expectStatus,
  firstLine,
  newPage,
  pendingRow,
  readFlags,
  registerStudent,
  restoreFlags,
  retireAccount,
  screenshotter,
  signIn,
  teacherFirstLogin,
  type Flags,
  type NewStudent,
} from './helpers'

/**
 * 第 3 站：年度流程、通知、分組、指導、專題事務與繳交（票 11–22「做完的樣子」），對測試站走一次真實流程。
 *
 * 屆別＋時間軸（四階段、活動、轉進行中）→ 模擬業務鐘 → 分組設定 → 匯入名單、4 位學生註冊並核准 → 新增兩位老師 →
 * 測試通知進通知匣 → 找組員 → 三人提案（產學合作）逐人確認成組 → 管理員加入第 4 位、換組長 → 指派主指導 →
 * 發布公開公告（附件）、個人收件、整組收件（上傳要求）→ 個人填報拿回執 → 組別共用草稿、上傳 PDF、代表送出 →
 * 名單頁完成率 → 主指導看繳交矩陣並下載 → 重派後舊老師被拒 → 訪客在 /news 看到公告並下載附件 →
 * 老師建合作案、組長連結 → 管理員匯出組別名單 CSV／XLSX。
 *
 * - 這一輪的東西都帶前綴：屆別 `ACC3<時間戳>`、姓名 `驗收三<數字>…`、標題與公司名含屆別代碼，搜尋得到、不會撞到別人的資料。
 * - 註冊限速每 IP 每小時 30 次：這一站註冊 4 位學生（加第 2 站 1 位，一次全跑 5 位）。老師由管理員直接建，不佔註冊額度；
 *   第二位老師只當「重派的對象」，不登入。
 * - 開放註冊／預設工作兩個旗標、模擬業務鐘都是全站狀態：跑完把旗標還給原本的屆別，業務鐘撥回跑之前的樣子。
 * - 收尾（不論成敗）：下架這一輪發布的三個項目與合作案、停用這一輪的學生與老師。屆別、組別、繳交紀錄後台沒有刪除，留著。
 * - 前一步失敗，後面就跳過（serial）。
 */

test.describe.configure({ mode: 'serial' })

const shot = screenshotter('station-3')

const DAY = 86_400_000
const now = Date.now()
const CODE = `ACC3${now}`
const COHORT_NAME = `驗收屆 ${CODE}`
const prefix = String(now).slice(-7)
/** 姓名標籤：和第 2 站的「驗收<數字>」分開，搜尋不會互相撈到。 */
const TAG = `驗收三${prefix}`

type Student = NewStudent & { page: Page }
const STUDENTS: NewStudent[] = [1, 2, 3, 4].map((i) => ({
  name: `${TAG}學生${i}`,
  studentNo: `3${prefix}0${i}`,
  email: `acc3-s${i}-${now}@example.com`,
  dept: '資管三甲',
  password: `Acc3-Student-${randomBytes(6).toString('hex')}`,
}))
const TEACHER_A = { name: `${TAG}甲老師`, email: `acc3-ta-${now}@example.com`, newPassword: `Acc3-Teacher-${randomBytes(6).toString('hex')}` }
const TEACHER_B = { name: `${TAG}乙老師`, email: `acc3-tb-${now}@example.com` }
const ACTIVITY = `${CODE} 專題說明會`
const PUBLIC_NEWS = `${CODE} 公開公告`
const PERSONAL = `${CODE} 分組意向登記`
const GROUP_ITEM = `${CODE} 期中報告`
const COMPANY = `${TAG}科技`
const OPPORTUNITY = `${COMPANY}・資訊部`
const TEST_NOTICE = `${CODE} 測試通知`
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'utf8')
const ROSTER_CSV = [
  'student_no,name,cohort,email,department_class',
  ...STUDENTS.map((s) => `${s.studentNo},${s.name},${CODE},${s.email},${s.dept}`),
  '',
].join('\n')

let admin: Page
let teacherA: Page
const students: Student[] = []
let cohortId = ''
let group = 'G01'
const itemIds = { news: '', personal: '', group: '' }
let teacherVersionUrl = ''
let submissionFileHref = ''
let opportunityId = ''
let previousFlags: Flags = { registrationOpen: null, defaultWorking: null }
/** 跑之前的業務鐘：null＝沒有模擬；否則是「業務時間 − 真實時間」。 */
let previousClockOffset: number | null = null
/** 這一輪動過業務鐘了沒：動過才需要還原。 */
let clockTouched = false
/** 送出註冊的學生姓名（收尾用：待審就退回、已核准就停用）。 */
const registered = new Set<string>()
let teachersCreated = false
/** 合作案發布成功了沒：一成功就記下，後面的步驟失敗也會下架。 */
let opportunityPublished = false

// ── 時間（全部是臺灣時間） ─────────────────────────────────────────────────

function taipeiIso(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString()
}

/** 相對今天的臺灣日期 `YYYY-MM-DD`。 */
function ymd(offsetDays: number): string {
  return taipeiIso(Date.now() + offsetDays * DAY).slice(0, 10)
}

/** `datetime-local` 到分鐘。 */
function localMinute(ms: number): string {
  return taipeiIso(ms).slice(0, 16)
}

/** `datetime-local` 到秒；秒數是 0 時瀏覽器會把它省略，所以避開 0 秒。 */
function localSecond(ms: number): string {
  const safe = new Date(ms).getUTCSeconds() === 0 ? ms + 1000 : ms
  return taipeiIso(safe).slice(0, 19)
}

/** 畫面上的 `YYYY/MM/DD HH:mm:ss`（臺灣時間）轉回毫秒。 */
function parseTaipeiSecond(text: string): number {
  const m = /(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text)
  if (!m) throw new Error(`看不懂業務時間：${text}`)
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]! - 8, +m[5]!, +m[6]!)
}

async function setClock(page: Page, ms: number, reason: string) {
  await page.goto('/dashboard/admin/clock')
  await page.getByLabel('業務時間（臺灣時間，到秒）').fill(localSecond(ms))
  await page.getByLabel('原因').fill(reason)
  await page.getByRole('button', { name: '設定業務時間' }).click()
  await expectStatus(page, '已設定業務時間')
}

async function stageText(page: Page, path: string) {
  await page.goto(path)
  return page.getByRole('region', { name: '現在階段' }).getByTestId('stage-text')
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

function student(i: number): Student {
  const s = students[i]
  if (!s) throw new Error(`第 ${i + 1} 位學生還沒準備好（前面的步驟失敗了）`)
  return s
}

async function openMyGroup(page: Page) {
  await page.goto('/dashboard/student/groups')
  await expect(page.getByRole('heading', { name: '我的組別', exact: true })).toBeVisible()
}

function groupRow(page: Page) {
  return page.getByRole('region', { name: '全部組別' }).getByRole('row').filter({ hasText: group })
}

async function openAdminGroups(page: Page) {
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '分組總覽', exact: true })).toBeVisible()
}

/** 下拉選單裡含某段文字的那一個選項（選項文字帶 email，不寫死格式）。 */
async function selectOptionContaining(select: Locator, text: string) {
  const value = await select.locator('option', { hasText: text }).first().getAttribute('value')
  expect(value, `選單裡找不到「${text}」`).toBeTruthy()
  await select.selectOption(value!)
}

/** 完整編輯器：存草稿後網址換成 `/dashboard/admin/editor/<id>`，回傳 id。 */
async function saveDraft(page: Page): Promise<string> {
  await page.getByRole('button', { name: '存草稿' }).click()
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: '已存成草稿' })).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard\/admin\/editor\/[0-9a-f-]{36}$/)
  return new URL(page.url()).pathname.split('/').pop()!
}

async function publishFromEditor(page: Page) {
  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await expect(check.locator('[data-ok="no"]')).toHaveCount(0)
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toContainText('收件名單')
  await expect(page.getByTestId('item-status')).toHaveText('發布中')
}

async function waitForInbox(page: Page, text: string) {
  await expect
    .poll(
      async () => {
        await page.goto('/dashboard/student/inbox')
        return page.getByTestId('inbox-item').filter({ hasText: text }).count()
      },
      { timeout: 90_000, intervals: [2_000, 5_000] },
    )
    .toBeGreaterThan(0)
}

async function closeContext(page: Page | undefined) {
  if (page && !page.isClosed()) await page.context().close()
}

// ── 收尾 ───────────────────────────────────────────────────────────────────

test.afterAll(async ({ browser }) => {
  test.setTimeout(300_000)
  const touchedSite = clockTouched || previousFlags.registrationOpen !== null || previousFlags.defaultWorking !== null
  const leftovers = itemIds.news || itemIds.personal || itemIds.group || opportunityPublished || registered.size > 0 || teachersCreated
  // 管理員分頁掛了也要有人收尾：重登一個（全站狀態不能留著）。
  if ((touchedSite || leftovers) && (!admin || admin.isClosed())) {
    try {
      admin = await adminPage(browser)
    } catch (error) {
      console.log(`收尾：管理員重登失敗，全站狀態沒還（${firstLine(error)}）`)
    }
  }
  if (admin && !admin.isClosed()) {
    // 先還全站狀態（業務鐘、旗標）：它們會影響別人；這一輪的帳號與項目只是帶前綴的殘留，排在後面。
    // 1. 業務鐘撥回跑之前的樣子：原本有模擬就還原當時的偏移，原本沒有就撥回真實時間（偏移 0）。
    if (clockTouched) {
      try {
        const offset = previousClockOffset ?? 0
        await setClock(admin, Date.now() + offset, offset === 0 ? '站驗收收尾：撥回真實時間' : '站驗收收尾：還原跑之前的模擬時間')
      } catch (error) {
        console.log(`收尾：業務鐘沒撥回（${firstLine(error)}）`)
      }
    }
    // 2. 兩個全系唯一的旗標還給原本的屆別。
    await restoreFlags(admin, previousFlags, CODE).catch((error: unknown) => console.log(`收尾：旗標沒還成功（${firstLine(error)}）`))
    // 3. 下架這一輪發布的項目（下架不需要「沒人作答」，公開公告也就不會留在前台）。
    for (const id of Object.values(itemIds).filter(Boolean)) {
      try {
        await admin.goto(`/dashboard/admin/editor/${id}`)
        const archive = admin.getByRole('button', { name: '下架', exact: true })
        if ((await archive.count()) === 0) continue
        await archive.click()
        await admin.getByRole('dialog', { name: '下架這個項目？' }).getByRole('button', { name: '確認下架' }).click()
        await expect(admin.getByTestId('item-status')).toHaveText('已下架')
      } catch (error) {
        console.log(`收尾：項目 ${id} 沒下架成功（${firstLine(error)}）`)
      }
    }
    // 4. 下架這一輪的合作案（按這一輪的公司名找按鈕）。
    if (opportunityPublished) {
      try {
        await admin.goto('/dashboard/admin/industry')
        await admin.getByRole('button', { name: `下架：${OPPORTUNITY}`, exact: true }).click()
        await admin.getByRole('dialog', { name: `下架「${OPPORTUNITY}」` }).getByRole('button', { name: '確認下架' }).click()
        await expect(admin.getByTestId('managed-opportunity').filter({ hasText: COMPANY })).toContainText('已下架')
      } catch (error) {
        console.log(`收尾：合作案沒下架成功（${firstLine(error)}）`)
      }
    }
    // 5. 收掉這一輪的帳號（只認這一輪的姓名標籤）：還在待審就退回，已核准就停用。
    for (const name of [...registered]) await retireAccount(admin, name)
    if (teachersCreated) for (const name of [TEACHER_A.name, TEACHER_B.name]) await disableAccount(admin, name)
  }
  await closeContext(admin)
  await closeContext(teacherA)
  for (const s of students) await closeContext(s.page)
})

// ── 步驟 ───────────────────────────────────────────────────────────────────

test('0 前置：背景工作在跑、測試站有模擬業務鐘；管理員登入，業務鐘撥回真實時間', async ({ browser, request }) => {
  const health = (await (await request.get('/api/health')).json()) as {
    commit?: string
    worker?: { lastTickAt: string | null }
  }
  console.log(`測試站版本：${health.commit?.slice(0, 8) ?? '（不明）'}`)
  const lastTick = health.worker?.lastTickAt ? Date.parse(health.worker.lastTickAt) : 0
  expect(Date.now() - lastTick, '背景工作的心跳超過 2 分鐘沒更新：通知不會投影').toBeLessThan(120_000)

  admin = await adminPage(browser)
  const response = await admin.goto('/dashboard/admin/clock')
  expect(response?.status(), '測試站應該有模擬業務鐘頁').toBe(200)
  const business = parseTaipeiSecond(await admin.getByLabel('目前業務時間').innerText())
  const simulated = await admin.getByText('模擬中：').count()
  previousClockOffset = simulated > 0 ? business - Date.now() : null
  clockTouched = true
  console.log(`跑之前的業務鐘：${previousClockOffset === null ? '沒有模擬' : `模擬中，偏移 ${Math.round(previousClockOffset / 60_000)} 分鐘`}`)
  await setClock(admin, Date.now(), '站驗收：開始前撥回真實時間')
  await shot(admin, 'clock-reset')
})

test('票 11 建屆別、設旗標；時間軸填四個階段與年度結束日、新增活動；轉為進行中', async () => {
  previousFlags = await readFlags(admin)
  console.log(`跑之前：開放註冊屆別＝${previousFlags.registrationOpen ?? '（無）'}、預設工作屆別＝${previousFlags.defaultWorking ?? '（無）'}`)

  await admin.getByLabel('代碼').fill(CODE)
  await admin.getByLabel('名稱').fill(COHORT_NAME)
  await admin.getByRole('button', { name: '新增屆別' }).click()
  await expectStatus(admin, `已新增屆別 ${CODE}`)
  await admin.reload()
  await admin.getByRole('button', { name: `把 ${CODE} 設為開放註冊屆別` }).click()
  await expectStatus(admin, `已把 ${CODE} 設為開放註冊屆別`)
  await admin.getByRole('button', { name: `把 ${CODE} 設為預設工作屆別` }).click()
  await expectStatus(admin, `已把 ${CODE} 設為預設工作屆別`)

  // 時間軸編輯的是預設工作屆別。第 1 階段從十天前開始：今天是成組期。
  await admin.goto('/dashboard/admin/timeline')
  await expect(admin.getByRole('region', { name: '時間軸' })).toContainText(CODE)
  await admin.getByRole('button', { name: '編輯階段與日期' }).click()
  const dialog = admin.getByRole('dialog', { name: `編輯 ${CODE} 的階段與日期` })
  for (const [i, [name, offset]] of ([
    ['成組期', -10],
    ['期中', 30],
    ['期末', 90],
    ['成果', 150],
  ] as const).entries()) {
    await dialog.getByLabel(`第 ${i + 1} 階段名稱`).fill(name)
    await dialog.getByLabel(`第 ${i + 1} 階段開始日`).fill(ymd(offset))
  }
  await dialog.getByLabel('年度結束日').fill(ymd(300))
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expectStatus(admin, `已儲存 ${CODE} 的階段與日期`)
  await expect(admin.getByRole('list', { name: '本屆階段' })).toContainText('成組期')

  await admin.getByRole('button', { name: '新增活動' }).click()
  const create = admin.getByRole('dialog', { name: '新增活動' })
  await create.getByLabel('活動名稱').fill(ACTIVITY)
  await create.getByLabel('日期', { exact: true }).fill(ymd(3))
  await create.getByLabel('開始時間').fill('14:00')
  await create.getByLabel('結束時間（可不填）').fill('16:00')
  await create.getByRole('button', { name: '建立活動' }).click()
  await expectStatus(admin, `已新增活動「${ACTIVITY}」`)
  await expect(admin.getByRole('region', { name: '已排定的活動' })).toContainText(ACTIVITY)
  await shot(admin, 'timeline')

  await admin.goto('/dashboard/admin/cohorts')
  await admin.getByRole('button', { name: `把 ${CODE} 轉為進行中` }).click()
  await expectStatus(admin, `已把 ${CODE} 轉為進行中`)
  await expect(cohortRow(admin, CODE)).toContainText('進行中')
  await shot(admin, 'cohort-active')
})

test('票 11 模擬業務鐘：推到第 1 階段前一天是「尚未開始」，撥回現在是「階段 1：成組期」；每次都留紀錄', async () => {
  await setClock(admin, Date.now() - 11 * DAY, '站驗收：第 1 階段前一天')
  await expect(await stageText(admin, '/dashboard/admin')).toHaveText('尚未開始')
  await shot(admin, 'stage-not-started')

  await setClock(admin, Date.now(), '站驗收：撥回現在')
  await expect(await stageText(admin, '/dashboard/admin')).toHaveText('階段 1：成組期')
  await shot(admin, 'stage-1')

  await admin.goto('/dashboard/admin/clock')
  const latest = admin.getByRole('region', { name: '設定紀錄' }).getByRole('row').nth(1)
  await expect(latest).toContainText('站驗收：撥回現在')
})

test('票 14 分組設定：每組最少 3 人（本屆 3–5 人）', async () => {
  await admin.goto('/dashboard/admin/groups')
  // 屆別選單的連結帶著屆別編號；後面的頁面用它指定這一屆。
  const link = admin.getByRole('navigation', { name: '選擇屆別' }).getByRole('link', { name: CODE, exact: true })
  cohortId = new URL((await link.getAttribute('href'))!, 'https://x').searchParams.get('cohort') ?? ''
  expect(cohortId).toMatch(/^[0-9a-f-]{36}$/)
  await openAdminGroups(admin)
  await admin.getByRole('button', { name: '分組設定' }).click()
  const dialog = admin.getByRole('dialog', { name: `${CODE} 的分組設定` })
  await dialog.getByLabel('每組最少人數').fill('3')
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expectStatus(admin, '每組 3–5 人')
  await admin.reload()
  await expect(admin.getByTestId('grouping-settings')).toContainText('每組 3–5 人')
})

test('票 6／7 匯入名單、4 位學生註冊、管理員核准、學生登入', async ({ browser }) => {
  test.setTimeout(300_000)
  await admin.goto('/dashboard/admin/accounts')
  await admin.getByRole('button', { name: '匯入名單 CSV' }).click()
  const file = `roster-${CODE}.csv`
  await admin.getByLabel('選擇名單 CSV 檔').setInputFiles({ name: file, mimeType: 'text/csv', buffer: Buffer.from(ROSTER_CSV, 'utf8') })
  await expect(admin.getByTestId('roster-count-有效')).toHaveText(String(STUDENTS.length))
  await admin.getByRole('button', { name: `匯入 ${STUDENTS.length} 筆` }).click()
  await expect(admin.getByText('已匯入', { exact: true })).toBeVisible()
  await admin.getByRole('button', { name: '關閉' }).click()

  for (const s of STUDENTS) {
    const page = await newPage(browser)
    registered.add(s.name)
    await registerStudent(page, s)
    students.push({ ...s, page })
  }
  await shot(student(3).page, 'register-pending')

  await admin.goto('/dashboard/admin/accounts')
  for (const s of students) await expect(pendingRow(admin, s.name)).toContainText('名單符合')
  await shot(admin, 'pending-list')
  for (const s of students) await approveStudent(admin, s.name, COHORT_NAME)

  for (const s of students) {
    await s.page.context().clearCookies()
    await signIn(s.page, s.email, s.password)
    await expect(s.page).toHaveURL(/\/dashboard\/student$/)
  }
  await expect(await stageText(student(0).page, '/dashboard/student')).toHaveText('階段 1：成組期')
  await shot(student(0).page, 'student-home')
})

test('票 8 新增兩位老師；甲老師第一次登入改密、補資料', async ({ browser }) => {
  teachersCreated = true
  const temporary = await createTeacher(admin, TEACHER_A)
  await createTeacher(admin, TEACHER_B)
  teacherA = await newPage(browser)
  await teacherFirstLogin(teacherA, TEACHER_A.email, temporary, TEACHER_A.newPassword)
  await shot(teacherA, 'teacher-home')
})

test('票 12 系辦發測試通知：學生的通知匣收到、鈴鐺有未讀', async () => {
  test.setTimeout(180_000)
  await admin.goto('/dashboard/admin/inbox')
  await selectOptionContaining(admin.getByLabel('收件人', { exact: true }), student(0).name)
  await admin.getByLabel('屆別', { exact: true }).selectOption({ label: CODE })
  await admin.getByLabel('標題', { exact: true }).fill(TEST_NOTICE)
  await admin.getByRole('button', { name: '發送測試通知' }).click()
  await expectStatus(admin, '已發給')

  const page = student(0).page
  await waitForInbox(page, TEST_NOTICE)
  await expect(page.getByTestId('inbox-item').filter({ hasText: TEST_NOTICE })).toHaveAttribute('data-read', 'false')
  await expect(page.getByTestId('inbox-bell')).toHaveAccessibleName(/則未讀/)
  await shot(page, 'inbox-test-notice')
})

test('票 13 找組員：學生 2 公開後，學生 1 在名單看到他的姓名與學號', async () => {
  const s2 = student(1).page
  await openMyGroup(s2)
  await s2.getByRole('button', { name: '公開找組員' }).click()
  await expectStatus(s2, '已公開找組員')

  const s1 = student(0).page
  await openMyGroup(s1)
  const row = s1.getByRole('region', { name: '找組員名單' }).getByRole('row').filter({ hasText: student(1).name })
  await expect(row).toContainText(student(1).studentNo)
  await shot(s1, 'find-members')
})

test('票 13 學生 1 發起三人提案（產學合作），三人逐一確認，最後一位確認時成組；提案人是組長', async () => {
  const s1 = student(0).page
  await openMyGroup(s1)
  await expect(s1.getByText('本屆每組 3–5 人')).toBeVisible()
  await s1.getByRole('radio', { name: '產學合作' }).check()
  await s1.getByLabel('同學 1 的學號').fill(student(1).studentNo)
  await s1.getByLabel('同學 2 的學號').fill(student(2).studentNo)
  await s1.getByRole('button', { name: '發起提案' }).click()
  const status = s1.getByRole('region', { name: '我的組別狀態' })
  await expect(status).toContainText('0／3 已確認')
  await expect(status).toContainText('到期時間')
  await shot(s1, 'proposal-open')

  for (const i of [0, 1, 2]) {
    const page = student(i).page
    await openMyGroup(page)
    await page.getByRole('button', { name: '確認加入' }).click()
    if (i < 2) {
      await expectStatus(page, `已確認（${i + 1}／3 已確認）`)
    } else {
      const done = page.getByRole('main').getByRole('status').filter({ hasText: '成立了' })
      await expect(done).toBeVisible()
      group = /組別 (\S+) 成立了/.exec(await done.innerText())?.[1] ?? group
    }
  }
  const s3 = student(2).page
  await expect(s3.getByRole('region', { name: '我的組別狀態' })).toContainText(`組別 ${group}`)
  await expect(s3.getByRole('list', { name: '組員' }).getByRole('listitem').filter({ hasText: '組長' })).toContainText(student(0).name)
  await shot(s3, 'group-established')
})

test('票 14 管理員把學生 4 加入這一組（理由必填）、把組長換給學生 2；學生看得到異動', async () => {
  await openAdminGroups(admin)
  await admin.getByRole('region', { name: '未分組學生' }).getByRole('button', { name: `加入某組：${student(3).name}` }).click()
  const add = admin.getByRole('dialog', { name: `把 ${student(3).name} 加入組別` })
  await expect(add.getByLabel('組別')).toContainText(group)
  await add.getByRole('button', { name: '確認加入' }).click()
  await expect(add.getByRole('alert')).toContainText('一定要填理由')
  await add.getByLabel('理由（必填）').fill('站驗收：系上安排加入')
  await add.getByRole('button', { name: '確認加入' }).click()
  await expectStatus(admin, `已把 ${student(3).name} 加入 ${group}`)

  await admin.reload()
  await admin.getByRole('region', { name: '全部組別' }).getByRole('button', { name: `${group} 詳情` }).click()
  const detail = admin.getByRole('dialog', { name: `${group} 詳情` })
  await detail.getByRole('button', { name: '換組長' }).click()
  const change = admin.getByRole('dialog', { name: `換 ${group} 的組長` })
  await change.getByLabel('新組長').selectOption({ label: student(1).name })
  await change.getByLabel('理由（必填）').fill('站驗收：原組長請辭')
  await change.getByRole('button', { name: '確定更換' }).click()
  await expect(detail.getByRole('status')).toContainText(`${group} 的組長已從 ${student(0).name} 換成 ${student(1).name}`)
  await expect(detail.getByRole('region', { name: '異動歷程' })).toContainText(`${student(3).name} 加入`)
  await shot(admin, 'group-detail')

  const s4 = student(3).page
  await openMyGroup(s4)
  await expect(s4.getByRole('region', { name: '我的組別狀態' })).toContainText(`組別 ${group}`)
  const history = s4.getByRole('list', { name: '組別異動' })
  await expect(history).toContainText(`組長 ${student(0).name} → ${student(1).name}`)
  await expect(s4.getByRole('region', { name: '我的組別狀態' })).not.toContainText('原組長請辭')
})

test('票 19 管理員指派甲老師為主指導（理由必填）；學生看得到指導老師', async () => {
  await openAdminGroups(admin)
  await groupRow(admin).getByRole('button', { name: `指派指導老師：${group}` }).click()
  const dialog = admin.getByRole('dialog', { name: `指派 ${group} 的指導老師` })
  await selectOptionContaining(dialog.getByLabel('指導老師'), TEACHER_A.name)
  await dialog.getByLabel('理由（必填）').fill('站驗收：抽籤結果')
  await dialog.getByRole('button', { name: '確認指派' }).click()
  await expect(groupRow(admin).getByRole('status')).toContainText(`已指派 ${TEACHER_A.name} 老師指導 ${group}`)
  await shot(admin, 'advisor-assigned')

  const s1 = student(0).page
  await openMyGroup(s1)
  await expect(s1.getByTestId('my-advisor')).toContainText(TEACHER_A.name)
})

test('票 15 三步驟發布公開公告（附 PDF）', async () => {
  await admin.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await admin.getByRole('button', { name: '新增項目' }).click()
  const dialog = admin.getByRole('dialog', { name: '新增項目' })
  await dialog.getByRole('radio', { name: /公告/ }).check()
  await dialog.getByLabel('標題').fill(PUBLIC_NEWS)
  await dialog.getByLabel('發布對象').selectOption('public')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByLabel('說明', { exact: true }).fill('<p>站驗收用的公開公告，跑完會自動下架。</p>')
  await dialog.locator('input[type=file]').setInputFiles({ name: '驗收簡章.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(dialog.getByRole('link', { name: '驗收簡章.pdf' })).toBeVisible()
  await dialog.getByRole('button', { name: '下一步' }).click()
  await expect(dialog.locator('[data-ok="no"]')).toHaveCount(0)
  await dialog.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText(`「${PUBLIC_NEWS}」已發布`)
  // 一發布就記下 id：後面任一步失敗，收尾也會把這則公開公告下架。
  const tune = dialog.getByRole('link', { name: '細調欄位' })
  itemIds.news = /\/dashboard\/admin\/editor\/([0-9a-f-]{36})$/.exec((await tune.getAttribute('href')) ?? '')?.[1] ?? ''
  expect(itemIds.news, '拿不到公告的 id').not.toBe('')
  await shot(admin, 'news-published')
  await tune.click()
  await expect(admin).toHaveURL(new RegExp(`/dashboard/admin/editor/${itemIds.news}$`))
  await expect(admin.getByTestId('item-status')).toHaveText('發布中')
})

test('票 15 完整編輯器發布個人收件（本屆學生、必填簡答）', async () => {
  await admin.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await admin.getByLabel('標題', { exact: true }).fill(PERSONAL)
  await admin.getByLabel('正文').fill('請填想做的題目。')
  await admin.getByLabel('發布位置', { exact: true }).selectOption('submission')
  await admin.getByRole('radio', { name: '個人一份', exact: true }).check()
  await admin.getByLabel('發布對象').selectOption('cohort_students')
  await admin.getByLabel('所屬階段').selectOption({ index: 1 })
  await admin.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(Date.now() + 20 * DAY))
  await admin.getByLabel('要新增的欄位類型').selectOption('text')
  await admin.getByRole('button', { name: '新增欄位' }).click()
  const field = admin.locator('li[data-field-type="text"]')
  await field.getByLabel('第 1 個欄位的標籤').fill('想做的題目')
  await field.getByRole('checkbox', { name: '必填' }).check()
  itemIds.personal = await saveDraft(admin)
  await publishFromEditor(admin)
  await shot(admin, 'personal-published')
})

test('票 15 完整編輯器發布整組收件（指定這一組、簡答＋PDF 上傳）', async () => {
  await admin.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await admin.getByLabel('標題', { exact: true }).fill(GROUP_ITEM)
  await admin.getByLabel('正文').fill('請上傳期中報告 PDF。')
  await admin.getByLabel('發布位置', { exact: true }).selectOption('submission')
  await admin.getByRole('radio', { name: '整組一份', exact: true }).check()
  await admin.getByLabel('發布對象').selectOption('groups')
  await admin.getByRole('checkbox', { name: new RegExp(group) }).check()
  await admin.getByLabel('所屬階段').selectOption({ index: 1 })
  await admin.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(Date.now() + 20 * DAY))
  await admin.getByLabel('要新增的欄位類型').selectOption('text')
  await admin.getByRole('button', { name: '新增欄位' }).click()
  await admin.locator('li[data-field-type="text"]').getByLabel('第 1 個欄位的標籤').fill('專題題目')
  await admin.getByLabel('要新增的欄位類型').selectOption('file')
  await admin.getByRole('button', { name: '新增欄位' }).click()
  await admin.locator('li[data-field-type="file"]').getByLabel('第 2 個欄位的標籤').fill('期中報告 PDF')
  itemIds.group = await saveDraft(admin)
  await publishFromEditor(admin)
  await shot(admin, 'group-item-published')
})

test('票 17 學生 3 個人填報：存草稿、正式送出拿到收件章回執', async () => {
  const page = student(2).page
  await page.goto('/dashboard/student/affairs')
  const row = page.getByTestId(`affair-${itemIds.personal}`)
  await expect(row).toContainText('未繳')
  await row.getByRole('link', { name: PERSONAL }).click()
  await expect(page.getByRole('heading', { name: PERSONAL })).toBeVisible()
  await page.getByLabel('想做的題目').fill('站驗收：校園導覽 App')
  await page.getByRole('button', { name: '儲存草稿' }).click()
  await expect(page.getByTestId('save-status')).toContainText('已儲存')
  await page.getByRole('button', { name: '正式送出' }).click()
  const receipt = page.getByTestId('receipt')
  await expect(receipt).toContainText('已收件')
  await expect(receipt).toContainText('v1')
  await expect(receipt).toContainText(student(2).name)
  await shot(page, 'personal-receipt')
  await receipt.getByRole('button', { name: '關閉' }).click()
  await expect(page.getByTestId('affair-banner')).toContainText('已繳 v1')
})

test('票 21 組別共用草稿、上傳 PDF、組長代表全組送出；其他組員收到通知', async () => {
  test.setTimeout(240_000)
  const path = `/dashboard/student/affairs/${itemIds.group}`
  const s1 = student(0).page
  await s1.goto('/dashboard/student/affairs')
  await expect(s1.getByTestId(`affair-${itemIds.group}`)).toContainText(`整組一份（${group}）`)
  await s1.goto(path)
  await expect(s1.getByTestId('group-bar')).toContainText(group)
  await s1.getByLabel('專題題目').fill('站驗收：智慧校園導覽')
  await s1.getByRole('button', { name: '儲存草稿' }).click()
  await expect(s1.getByText('共用草稿已存到伺服器；同組的人打開會看到同一份。')).toBeVisible()

  const s3 = student(2).page
  await s3.goto(path)
  await expect(s3.getByLabel('專題題目')).toHaveValue('站驗收：智慧校園導覽')
  await s3.locator('[data-testid^="file-field-"] input[type=file]').first().setInputFiles({ name: '期中報告.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(s3.getByText('「期中報告.pdf」已上傳並附到草稿。')).toBeVisible()
  await shot(s3, 'group-draft-uploaded')

  const s2 = student(1).page
  await s2.goto(path)
  await expect(s2.locator('[data-testid^="file-field-"]').getByRole('link', { name: '期中報告.pdf' })).toBeVisible()
  await s2.getByRole('button', { name: '代表全組正式送出' }).click()
  const receipt = s2.getByTestId('receipt')
  await expect(receipt).toContainText('已收件')
  await expect(receipt).toContainText('v1')
  await expect(receipt).toContainText(`${student(1).name}（代表 ${group} 全組）`)
  await expect(receipt).toContainText('期中報告.pdf')
  await shot(s2, 'group-receipt')
  await receipt.getByRole('button', { name: '關閉' }).click()

  await s1.goto('/dashboard/student/affairs')
  await expect(s1.getByTestId(`affair-${itemIds.group}`)).toContainText('已繳 v1')
  await waitForInbox(s1, `正式送出了「${GROUP_ITEM}」`)
  await shot(s1, 'group-submitted-notice')
})

test('票 18／22 名單頁完成率：個人收件 1／4、整組收件 1／1；點進組別看得到版本', async () => {
  await admin.goto(`/dashboard/admin/affairs/${itemIds.personal}`)
  await expect(admin.getByTestId('completion-rate')).toHaveText(`1／${STUDENTS.length}`)
  await shot(admin, 'personal-completion')
  await admin.goto(`/dashboard/admin/affairs/${itemIds.group}`)
  await expect(admin.getByTestId('completion-rate')).toHaveText('1／1')
  await admin.getByRole('link', { name: `查看 ${group} 組的繳交` }).click()
  await expect(admin.getByTestId('receiver-view')).toContainText('正式送出的版本（1）')
  await shot(admin, 'group-completion')
})

test('票 22 甲老師（主指導）看到繳交矩陣，點進去下載組別附件', async () => {
  await teacherA.goto('/dashboard/teacher/affairs')
  const row = teacherA.getByTestId(`matrix-row-${group}`)
  await expect(row).toContainText('已繳 v1')
  await shot(teacherA, 'teacher-matrix')
  await row.locator(`a[data-testid="matrix-cell"][href*="${itemIds.group}"]`).click()
  await expect(teacherA.getByTestId('receiver-view')).toContainText(`${group} 組`)
  await teacherA.getByRole('link', { name: '查看內容' }).last().click()
  const link = teacherA.getByTestId('version-view').getByRole('link', { name: '期中報告.pdf' })
  await expect(link).toBeVisible()
  teacherVersionUrl = teacherA.url()
  submissionFileHref = (await link.getAttribute('href')) ?? ''
  expect(submissionFileHref).toMatch(/^\/api\/files\//)
  const [download] = await Promise.all([teacherA.waitForEvent('download'), link.click()])
  expect(download.suggestedFilename()).toBe('期中報告.pdf')
  expect((await fs.readFile(await download.path())).equals(PDF), '下載到的檔案要和上傳的一樣').toBe(true)
  await shot(teacherA, 'teacher-version')
})

test('票 19／22 管理員把主指導重派給乙老師：甲老師的矩陣沒有這一組、版本頁 404、附件 403', async () => {
  await openAdminGroups(admin)
  await groupRow(admin).getByRole('button', { name: `重派指導老師：${group}` }).click()
  const dialog = admin.getByRole('dialog', { name: `重派 ${group} 的指導老師` })
  await expect(dialog).toContainText(`目前：${TEACHER_A.name}`)
  await selectOptionContaining(dialog.getByLabel('指導老師'), TEACHER_B.name)
  await dialog.getByLabel('理由（必填）').fill('站驗收：甲老師休假')
  await dialog.getByRole('button', { name: '確認重派' }).click()
  await expect(groupRow(admin).getByRole('status')).toContainText(`${group} 的指導老師已從 ${TEACHER_A.name} 換成 ${TEACHER_B.name}`)
  await shot(admin, 'advisor-reassigned')

  await teacherA.goto('/dashboard/teacher/affairs')
  await expect(teacherA.getByTestId(`matrix-row-${group}`)).toHaveCount(0)
  await shot(teacherA, 'teacher-matrix-after')
  expect((await teacherA.goto(teacherVersionUrl))?.status()).toBe(404)
  expect((await teacherA.request.get(submissionFileHref)).status()).toBe(403)
  // 系辦仍然下載得到。
  expect((await admin.request.get(submissionFileHref)).status()).toBe(200)
})

test('票 16 訪客：/news 看得到公開公告，內容頁的附件直接下載', async ({ browser }) => {
  const visitor = await newPage(browser)
  try {
    await visitor.goto(`/news?q=${encodeURIComponent(CODE)}`)
    const card = visitor.getByTestId('news-card').filter({ hasText: PUBLIC_NEWS })
    await expect(card).toBeVisible()
    await card.click()
    await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(PUBLIC_NEWS)
    await expect(visitor.getByRole('article')).toContainText('站驗收用的公開公告')
    const link = visitor.getByRole('link', { name: '驗收簡章.pdf' })
    await expect(link).toHaveAttribute('href', /^\/api\/files\//)
    await shot(visitor, 'visitor-news')
    const [download] = await Promise.all([visitor.waitForEvent('download'), link.click()])
    expect(download.suggestedFilename()).toBe('驗收簡章.pdf')
    expect((await fs.readFile(await download.path())).equals(PDF)).toBe(true)
  } finally {
    await visitor.context().close()
  }
})

test('票 20 甲老師建立並發布合作案；組長（學生 2）把組別連結到它', async () => {
  await teacherA.goto('/dashboard/teacher/industry')
  await teacherA.getByRole('button', { name: '新增合作案' }).click()
  const dialog = teacherA.getByRole('dialog', { name: '新增合作案' })
  await dialog.getByLabel('公司名稱').fill(COMPANY)
  await dialog.getByLabel('需求部門').fill('資訊部')
  await dialog.getByLabel('專題／合作內容').fill('站驗收用的合作案，跑完會自動下架。')
  await dialog.getByLabel('對學生的條件／需求').fill('會 Python')
  await dialog.getByLabel('聯絡電話').fill('02-2905-0000')
  await dialog.getByLabel('聯絡 Email').fill(`acc3-contact-${now}@example.com`)
  await dialog.getByLabel('聯絡人').fill('驗收聯絡人')
  await dialog.getByRole('button', { name: '儲存並發布' }).click()
  await expect(teacherA.getByRole('status').filter({ hasText: `已發布「${OPPORTUNITY}」` })).toBeAttached()
  opportunityPublished = true
  await teacherA.goto('/industry')
  const card = teacherA.getByTestId('opportunity-card').filter({ hasText: COMPANY })
  opportunityId = ((await card.getAttribute('href')) ?? '').split('/').pop() ?? ''
  expect(opportunityId).toMatch(/^[0-9a-f-]{36}$/)
  await shot(teacherA, 'opportunity-published')

  const leader = student(1).page
  await leader.goto(`/industry/${opportunityId}`)
  await leader.getByRole('link', { name: `把 ${group} 連結到這個合作案` }).click()
  const panel = leader.locator('#industry-link')
  await expect(panel.getByLabel('選一個已發布的合作案')).toHaveValue(opportunityId)
  await panel.getByRole('button', { name: `把 ${group} 連結到這個合作案` }).click()
  await expect(panel.getByRole('status')).toContainText(`${group} 已連結「${OPPORTUNITY}」`)
  await leader.reload()
  await expect(leader.getByTestId('linked-opportunity')).toContainText(OPPORTUNITY)
  await shot(leader, 'opportunity-linked')
})

test('票 20 管理員匯出組別名單：篩選結果 CSV、勾選 XLSX 都下載成功', async () => {
  await openAdminGroups(admin)
  const [csvFile] = await Promise.all([admin.waitForEvent('download'), admin.getByRole('button', { name: '匯出篩選結果（CSV）' }).click()])
  expect(csvFile.suggestedFilename()).toMatch(new RegExp(`^組別名單-${CODE}-\\d{8}-\\d{4}\\.csv$`))
  const csv = await fs.readFile(await csvFile.path(), 'utf8')
  expect(csv.charCodeAt(0), '開頭要有 UTF-8 BOM').toBe(0xfeff)
  const lines = csv.slice(1).trim().split('\r\n')
  expect(lines[0]).toContain('"登入信箱"')
  expect(lines).toHaveLength(1 + STUDENTS.length)
  for (const s of STUDENTS) expect(csv).toContain(s.studentNo)

  await admin.getByRole('region', { name: '全部組別' }).getByRole('checkbox', { name: `勾選 ${group}` }).check()
  const [xlsxFile] = await Promise.all([admin.waitForEvent('download'), admin.getByRole('button', { name: '匯出勾選（XLSX）' }).click()])
  expect(xlsxFile.suggestedFilename()).toMatch(/\.xlsx$/)
  const xlsx = await fs.readFile(await xlsxFile.path())
  expect(xlsx.subarray(0, 2).toString('latin1'), 'XLSX 是 zip 檔').toBe('PK')
  await expect(admin.getByRole('status').filter({ hasText: `已匯出 1 組、${STUDENTS.length} 位組員` })).toBeVisible()
  await shot(admin, 'groups-exported')
})

