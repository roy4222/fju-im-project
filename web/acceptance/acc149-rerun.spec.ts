import { randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import {
  activateCohort,
  archiveItem,
  assignAdvisor,
  closeContext,
  cohortIdOf,
  confirmAll,
  createCohortWithFlags,
  ensureAdmin,
  fillStages,
  groupRow,
  importRoster,
  inboxCount,
  onboardStudents,
  openAdminGroups,
  propose,
  publishFromEditor,
  retireAll,
  runTag,
  saveDraft,
  saveGroupingSettings,
  selectOptionContaining,
  taipeiIso,
  DAY,
  waitForInbox,
  type Student,
} from './acc149-helpers'
import {
  adminPage,
  createTeacher,
  expectStatus,
  firstLine,
  newPage,
  readFlags,
  restoreFlags,
  screenshotter,
  teacherFirstLogin,
  type Flags,
  type NewStudent,
} from './helpers'

/**
 * 149 案重驗：第一輪 Codex 操作失誤（裁定 C）、需要重驗的步驟。
 *
 * - x2:5  甲老師用臨時密碼第一次登入（上一輪 Codex 記錯臨時密碼）。
 * - x2:8  重要公告只通知對象：本屆學生收到、老師不收（NTF-01、PUB-01、PUB-02）。
 * - x2:18 整組收件發布後組員收到通知、未分組的人沒有（NTF-02、PUB-04）。
 * - x2:26 主指導只看正式送出、看不到草稿（SUB-24）。
 * - x2:27 換主指導後舊老師 404、新老師看得到（SUB-24）。
 * - x2:36 學生、目前主指導、系辦看到同一個最新版本，三邊都點進內容頁（SUB-10、SHW-09）。
 * - x1:34 移出組長必須指定接任；接任者與**被移出的人本人**都收到通知（GRP-06、GRP-18、NTF-15）。
 *
 * 這份把 x1、x2 的相關前置壓成最小：屆別 `ACC149-RR-<T>`、3 位學生（學生 1、2 成 <G1>，學生 3 未分組）、甲乙兩位老師。
 * 不動模擬業務鐘；旗標 afterAll 一定還原；發布的項目收尾下架；帳號收尾停用（最後一位組長改核發臨時密碼作廢，票 42）。
 */

test.describe.configure({ mode: 'serial' })

const shot = screenshotter('acc149-rerun')
const T = runTag()
const CODE = `ACC149-RR-${T}`
const COHORT_NAME = `ACC149 驗收屆 RR-${T}`
const PREFIX = `ACC149-RR-${T}`
const STUDENTS: NewStudent[] = [1, 2, 3].map((i) => ({
  name: `${PREFIX}學生${i}`,
  studentNo: `9${T}0${i}`,
  email: `acc149-rr-${T}-s${i}@example.com`,
  dept: '資管三甲',
  password: `Acc149-RR-${randomBytes(6).toString('hex')}`,
}))
const TA = { name: `${PREFIX}甲老師`, email: `acc149-rr-${T}-ta@example.com`, newPassword: `Acc149-T-${randomBytes(6).toString('hex')}` }
const TB = { name: `${PREFIX}乙老師`, email: `acc149-rr-${T}-tb@example.com`, newPassword: `Acc149-T-${randomBytes(6).toString('hex')}` }
const NEWS = `${PREFIX} 重要公告`
const PERSONAL = `${PREFIX} 意向調查`
const GROUP_ITEM = `${PREFIX} 期中報告`
const DRAFT_TEXT = '149 補驗：只是草稿不要給老師看'

let admin: Page
let ta: Page
let tb: Page
let students: Student[] = []
let cohortId = ''
let group = ''
let previousFlags: Flags = { registrationOpen: null, defaultWorking: null }
let flagsTouched = false
const registered = new Set<string>()
const teachersCreated: string[] = []
const itemIds = { news: '', personal: '', group: '' }
let taPersonalUrl = ''

function student(i: number): Student {
  const s = students[i]
  if (!s) throw new Error(`第 ${i + 1} 位學生還沒準備好（前面的步驟失敗了）`)
  return s
}

function localMinute(offsetDays: number, time = '23:59'): string {
  return `${taipeiIso(Date.now() + offsetDays * DAY).slice(0, 10)}T${time}`
}

/** 老師個人收件：清單 → 這個項目「查看」→ 某位學生的繳交 → 最新版本內容。回傳內容頁網址。 */
async function teacherOpensPersonalLatest(page: Page, studentName: string) {
  await page.goto('/dashboard/teacher/affairs')
  const list = page.getByTestId('individual-items')
  await expect(list).toContainText(PERSONAL)
  await list.getByRole('listitem').filter({ hasText: PERSONAL }).getByRole('link', { name: '查看' }).click()
  await page.getByRole('link', { name: `查看 ${studentName} 的繳交` }).click()
  await expect(page.getByTestId('receiver-view')).toContainText('正式送出的版本（2）')
  await page.getByRole('link', { name: '查看內容' }).first().click()
  await expect(page.getByTestId('version-view')).toBeVisible()
}

/** 版本表最上面那一列（最新）：第幾次、誰送的。 */
async function latestVersionRow(page: Page, tableName: string) {
  const row = page.getByRole('table', { name: tableName }).locator('tbody tr').first()
  await expect(row).toBeVisible()
  return (await row.innerText()).replace(/\s+/g, ' ')
}

// ── 收尾 ───────────────────────────────────────────────────────────────────

test.afterAll(async ({ browser }) => {
  test.setTimeout(360_000)
  if (flagsTouched || registered.size > 0 || teachersCreated.length > 0) {
    const page = await ensureAdmin(browser, admin)
    if (page) {
      admin = page
      if (flagsTouched) {
        await restoreFlags(admin, previousFlags, CODE).catch((error: unknown) => console.log(`收尾：旗標沒還成功（${firstLine(error)}）`))
      }
      for (const id of Object.values(itemIds).filter(Boolean)) {
        await archiveItem(admin, id).catch((error: unknown) => console.log(`收尾：項目 ${id} 沒下架成功（${firstLine(error)}）`))
      }
      // 學生 1（已被移出）、學生 3（組員）先，學生 2（接任的組長）最後；再來老師。
      const order = [STUDENTS[0]!.name, STUDENTS[2]!.name, STUDENTS[1]!.name].filter((n) => registered.has(n))
      await retireAll(admin, [...order, ...teachersCreated])
    }
  }
  await closeContext(admin)
  await closeContext(ta)
  await closeContext(tb)
  for (const s of students) await closeContext(s.page)
})

// ── 前置 ───────────────────────────────────────────────────────────────────

test('前置：建屆別與旗標、排階段、轉進行中、分組 2–3 人；3 位學生註冊核准；學生 1、2 成組', async ({ browser, request }) => {
  test.setTimeout(360_000)
  const health = (await (await request.get('/api/health')).json()) as { commit?: string; worker?: { lastTickAt: string | null } }
  console.log(`測試站版本：commit=${health.commit?.slice(0, 8) ?? '（不明）'}；代號 ${T}`)
  const lastTick = health.worker?.lastTickAt ? Date.parse(health.worker.lastTickAt) : 0
  expect(Date.now() - lastTick, '背景工作的心跳超過 2 分鐘沒更新').toBeLessThan(120_000)

  admin = await adminPage(browser)
  previousFlags = await readFlags(admin)
  flagsTouched = true
  console.log(`跑之前：開放註冊屆別＝${previousFlags.registrationOpen ?? '（無）'}、預設工作屆別＝${previousFlags.defaultWorking ?? '（無）'}`)
  await createCohortWithFlags(admin, CODE, COHORT_NAME)
  await fillStages(admin, CODE)
  await expectStatus(admin, `已儲存 ${CODE} 的階段與日期`)
  await activateCohort(admin, CODE)
  cohortId = await cohortIdOf(admin, CODE)
  await saveGroupingSettings(admin, cohortId, CODE, 2, 3, 7)

  await importRoster(admin, CODE, STUDENTS)
  students = await onboardStudents(browser, admin, COHORT_NAME, STUDENTS, registered)
  await propose(student(0).page, '一般專題', [student(1).studentNo])
  group = await confirmAll([student(0).page, student(1).page])
  console.log(`組別 <G1>＝${group}`)
  await shot(student(1).page, 'group-established')
})

test('x2:5 新增甲、乙兩位老師；臨時密碼一顯示就登入，改密、補資料，兩位都到老師首頁', async ({ browser }) => {
  for (const t of [TA, TB]) {
    teachersCreated.push(t.name)
    const temporary = await createTeacher(admin, t)
    const page = await newPage(browser)
    if (t === TA) ta = page
    else tb = page
    await teacherFirstLogin(page, t.email, temporary, t.newPassword)
    await shot(page, t === TA ? 'ta-home' : 'tb-home')
  }
  await assignAdvisor(admin, cohortId, group, TA.name, '149 補驗：抽籤結果')
})

test('x2:8 NTF-01 PUB-01 PUB-02 重要公告只通知對象：學生 1、學生 3 收到，甲老師沒有', async () => {
  test.setTimeout(300_000)
  await admin.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await admin.getByRole('button', { name: '新增項目' }).click()
  const dialog = admin.getByRole('dialog', { name: '新增項目' })
  await dialog.getByRole('radio', { name: /公告/ }).check()
  await dialog.getByLabel('標題').fill(NEWS)
  await dialog.getByLabel('發布對象').selectOption('cohort_students')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByLabel('說明', { exact: true }).fill('<p>149 補驗：重要公告第一版。</p>')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await expect(dialog.getByRole('checkbox', { name: '重要公告：逐人發站內通知給對象' })).toBeChecked()
  await expect(dialog.locator('[data-ok="no"]')).toHaveCount(0)
  await dialog.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('已發布')
  const tune = dialog.getByRole('link', { name: '細調欄位' })
  itemIds.news = /\/dashboard\/admin\/editor\/([0-9a-f-]{36})$/.exec((await tune.getAttribute('href')) ?? '')?.[1] ?? ''
  expect(itemIds.news, '拿不到公告的編號').not.toBe('')
  await shot(admin, 'news-published')
  // PUB-02：從「細調欄位」進完整編輯器，同一筆。
  await tune.click()
  await expect(admin).toHaveURL(new RegExp(`/dashboard/admin/editor/${itemIds.news}$`))

  await waitForInbox(student(0).page, '/dashboard/student/inbox', NEWS)
  await shot(student(0).page, 's1-inbox-news')
  await waitForInbox(student(2).page, '/dashboard/student/inbox', NEWS)
  await shot(student(2).page, 's3-inbox-news')
  // 兩位學生都已經投影到了：老師若也在對象裡，同一批早就該到。再多等一輪背景工作（30 秒）才下結論。
  await ta.waitForTimeout(35_000)
  expect(await inboxCount(ta, '/dashboard/teacher/inbox', NEWS), '甲老師不在「本屆學生」裡，不該收到重要公告').toBe(0)
  await shot(ta, 'ta-inbox-no-news')
})

test('x2:16 準備：個人收件「意向調查」先開主指導閱覽再發布（x2:26／27 用）', async () => {
  await admin.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await admin.getByLabel('標題', { exact: true }).fill(PERSONAL)
  await admin.getByLabel('正文').fill('請填想做的題目。')
  await admin.getByLabel('發布位置', { exact: true }).selectOption('submission')
  await admin.getByRole('radio', { name: '個人一份', exact: true }).check()
  await admin.getByLabel('發布對象').selectOption('cohort_students')
  await admin.getByLabel('所屬階段').selectOption({ index: 1 })
  await admin.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(20))
  await admin.getByLabel('要新增的欄位類型').selectOption('text')
  await admin.getByRole('button', { name: '新增欄位' }).click()
  const field = admin.locator('li[data-field-type="text"]')
  await field.getByLabel('第 1 個欄位的標籤').fill('想做的題目')
  await field.getByRole('checkbox', { name: '必填' }).check()
  itemIds.personal = await saveDraft(admin)

  await admin.goto(`/dashboard/admin/affairs/${itemIds.personal}`)
  const panel = admin.getByTestId('visibility-panel')
  await panel.getByRole('button', { name: '開放主指導閱覽' }).click()
  await admin.getByRole('dialog', { name: '開放主指導閱覽' }).getByRole('button', { name: '確定開放' }).click()
  const opened = admin.locator('dialog[open]')
  await expect(opened.getByRole('status')).toContainText('已開放')
  await opened.getByRole('button', { name: '關閉', exact: true }).click()
  await expect(panel.getByTestId('visibility-state')).toContainText('開放中')

  await admin.goto(`/dashboard/admin/editor/${itemIds.personal}`)
  const receipt = await publishFromEditor(admin)
  expect(receipt).toContain('收件名單 3 位')
})

test('x2:18 NTF-02 PUB-04 整組收件只算已成組的組：<G1> 的學生 1 收到通知，未分組的學生 3 沒有', async () => {
  test.setTimeout(300_000)
  await admin.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await admin.getByLabel('標題', { exact: true }).fill(GROUP_ITEM)
  await admin.getByLabel('正文').fill('請填專題題目。')
  await admin.getByLabel('發布位置', { exact: true }).selectOption('submission')
  await admin.getByRole('radio', { name: '整組一份', exact: true }).check()
  await admin.getByLabel('發布對象').selectOption('cohort_students')
  await admin.getByLabel('所屬階段').selectOption({ index: 1 })
  await admin.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(localMinute(20))
  await admin.getByLabel('要新增的欄位類型').selectOption('text')
  await admin.getByRole('button', { name: '新增欄位' }).click()
  const field = admin.locator('li[data-field-type="text"]')
  await field.getByLabel('第 1 個欄位的標籤').fill('專題題目')
  await field.getByRole('checkbox', { name: '必填' }).check()
  itemIds.group = await saveDraft(admin)
  await admin.getByRole('button', { name: '發布', exact: true }).click()
  const check = admin.getByRole('dialog', { name: '發布前檢查' })
  await expect(check).toContainText('收件名單：1 組')
  await expect(check.locator('[data-ok="no"]')).toHaveCount(0)
  await shot(admin, 'group-item-recipients')
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toContainText('收件名單')
  await expect(admin.getByTestId('item-status')).toHaveText('發布中')

  await waitForInbox(student(0).page, '/dashboard/student/inbox', GROUP_ITEM)
  await shot(student(0).page, 's1-inbox-group-item')
  await student(2).page.waitForTimeout(35_000)
  expect(await inboxCount(student(2).page, '/dashboard/student/inbox', GROUP_ITEM), '未分組的學生 3 不該收到整組收件通知').toBe(0)
  await shot(student(2).page, 's3-inbox-no-group-item')
})

test('x2:26 SUB-24 主指導（甲）只看正式送出的 v2，看不到之後存的草稿', async () => {
  const s1 = student(0).page
  await s1.goto(`/dashboard/student/affairs/${itemIds.personal}`)
  await expect(s1.getByTestId('advisor-notice')).toContainText('草稿不會給老師看')
  await s1.getByLabel('想做的題目').fill('149 補驗：第一版題目')
  await s1.getByRole('button', { name: '正式送出' }).click()
  await expect(s1.getByTestId('receipt')).toContainText('v1')
  await s1.getByTestId('receipt').getByRole('button', { name: '關閉' }).click()
  await s1.getByLabel('想做的題目').fill('149 補驗：第二版題目')
  await s1.getByRole('button', { name: '重新送出' }).click()
  await expect(s1.getByTestId('receipt')).toContainText('v2')
  await s1.getByTestId('receipt').getByRole('button', { name: '關閉' }).click()
  await s1.getByLabel('想做的題目').fill(DRAFT_TEXT)
  await s1.getByRole('button', { name: '儲存草稿' }).click()
  await expect(s1.getByTestId('save-status')).toContainText('已儲存')
  await expect(s1.getByTestId('affair-banner')).toContainText('已繳 v2')

  await teacherOpensPersonalLatest(ta, student(0).name)
  await expect(ta.getByTestId('version-view')).toContainText('第二版題目')
  await expect(ta.locator('body')).not.toContainText(DRAFT_TEXT)
  taPersonalUrl = ta.url()
  console.log(`x2:26 甲老師的版本頁：${new URL(taPersonalUrl).pathname}${new URL(taPersonalUrl).search}`)
  await shot(ta, 'ta-personal-v2')
})

test('x2:27 SUB-24 換主指導（甲 → 乙）：甲的版本頁 404；乙看得到 v2、看不到草稿', async () => {
  await openAdminGroups(admin, cohortId)
  await groupRow(admin, group).getByRole('button', { name: `重派指導老師：${group}` }).click()
  const dialog = admin.getByRole('dialog', { name: `重派 ${group} 的指導老師` })
  await selectOptionContaining(dialog.getByLabel('指導老師'), TB.name)
  await dialog.getByLabel('理由（必填）').fill('149 補驗：換老師')
  await dialog.getByRole('button', { name: '確認重派' }).click()
  await expect(groupRow(admin, group).getByRole('status')).toContainText(`${group} 的指導老師已從 ${TA.name} 換成 ${TB.name}`)
  await shot(admin, 'advisor-reassigned')

  expect((await ta.goto(taPersonalUrl))?.status(), '舊主指導打開原本的版本頁要 404').toBe(404)
  await shot(ta, 'ta-404')
  await teacherOpensPersonalLatest(tb, student(0).name)
  await expect(tb.getByTestId('version-view')).toContainText('第二版題目')
  await expect(tb.locator('body')).not.toContainText(DRAFT_TEXT)
  await shot(tb, 'tb-personal-v2')
})

test('x2:36 SUB-10 SHW-09 整組收件：學生 1 送 v1、學生 2 重送 v2；學生、目前主指導（乙）、系辦看到同一個最新版本並各自點進內容頁', async () => {
  test.setTimeout(300_000)
  const path = `/dashboard/student/affairs/${itemIds.group}`
  const s1 = student(0).page
  await s1.goto(path)
  await s1.getByLabel('專題題目').fill('149 補驗：G1 題目')
  await s1.getByRole('button', { name: '代表全組正式送出' }).click()
  await expect(s1.getByTestId('receipt')).toContainText('v1')
  await s1.getByTestId('receipt').getByRole('button', { name: '關閉' }).click()
  const s2 = student(1).page
  await s2.goto(path)
  await s2.getByLabel('專題題目').fill('149 補驗：G1 題目修正')
  await s2.getByRole('button', { name: '重新送出' }).click()
  const receipt = s2.getByTestId('receipt')
  await expect(receipt).toContainText('v2')
  await expect(receipt).toContainText(`${student(1).name}（代表 ${group} 全組）`)
  await receipt.getByRole('button', { name: '關閉' }).click()

  // 目前主指導（乙）：矩陣 → 格子 → 版本表最新是學生 2 的 v2 → 內容頁。
  await tb.goto('/dashboard/teacher/affairs')
  const row = tb.getByTestId(`matrix-row-${group}`)
  await expect(row).toContainText('已繳 v2')
  await row.locator(`a[data-testid="matrix-cell"][href*="${itemIds.group}"]`).click()
  await expect(tb.getByTestId('receiver-view')).toContainText('正式送出的版本（2）')
  const byTeacher = await latestVersionRow(tb, '正式送出的版本')
  expect(byTeacher).toContain('第 2 次')
  expect(byTeacher).toContain(student(1).name)
  await tb.getByRole('link', { name: '查看內容' }).first().click()
  await expect(tb.getByTestId('version-view')).toContainText('G1 題目修正')
  await shot(tb, 'tb-group-v2-content')

  // 系辦：名單頁 → 這一組的繳交 → 最新是學生 2 的 v2 → 內容頁。
  await admin.goto(`/dashboard/admin/affairs/${itemIds.group}`)
  await admin.getByRole('link', { name: `查看 ${group} 組的繳交` }).click()
  await expect(admin.getByTestId('receiver-view')).toContainText('正式送出的版本（2）')
  const byAdmin = await latestVersionRow(admin, '正式送出的版本')
  expect(byAdmin).toContain('第 2 次')
  expect(byAdmin).toContain(student(1).name)
  await admin.getByRole('link', { name: '查看內容' }).first().click()
  await expect(admin.getByTestId('version-view')).toContainText('G1 題目修正')
  await shot(admin, 'admin-group-v2-content')

  // 學生 1：從通知匣（組員送出通知）與作業區兩個入口，進到同一頁；繳交歷史最新是學生 2 的 v2。
  await waitForInbox(s1, '/dashboard/student/inbox', `正式送出了「${GROUP_ITEM}」`)
  await s1.getByTestId('inbox-item').filter({ hasText: `正式送出了「${GROUP_ITEM}」` }).first().getByRole('link').first().click()
  await expect(s1).toHaveURL(new RegExp(`${path}(\\?|#|$)`))
  const fromInbox = new URL(s1.url()).pathname
  await s1.goto('/dashboard/student/affairs')
  await s1.getByTestId(`affair-${itemIds.group}`).getByRole('link', { name: GROUP_ITEM }).click()
  await expect(s1).toHaveURL(new RegExp(`${path}(\\?|#|$)`))
  expect(new URL(s1.url()).pathname).toBe(fromInbox)
  await s1.goto(`${path}?tab=history`)
  const byStudent = await latestVersionRow(s1, '繳交歷史')
  expect(byStudent).toContain('第 2 次')
  expect(byStudent).toContain(student(1).name)
  await s1.getByRole('link', { name: '查看內容' }).first().click()
  await expect(s1.getByTestId('version-view')).toContainText('G1 題目修正')
  await shot(s1, 's1-group-v2-content')
})

test('x1:34 GRP-06 GRP-18 NTF-15 移出組長必須指定接任；接任者與被移出的學生 1 本人都收到通知', async () => {
  test.setTimeout(300_000)
  // 先把未分組的學生 3 加進來，移出組長後這組還有兩人（和 x1 當時一樣是三人組）。
  await openAdminGroups(admin, cohortId)
  await admin.getByRole('region', { name: '未分組學生' }).getByRole('button', { name: `加入某組：${student(2).name}` }).click()
  const add = admin.getByRole('dialog', { name: `把 ${student(2).name} 加入組別` })
  await add.getByLabel('理由（必填）').fill('149 補驗：補成三人組')
  await add.getByRole('button', { name: '確認加入' }).click()
  await expectStatus(admin, `已把 ${student(2).name} 加入 ${group}`)

  await admin.reload()
  await admin.getByRole('region', { name: '全部組別' }).getByRole('button', { name: `${group} 詳情` }).click()
  const detail = admin.getByRole('dialog', { name: `${group} 詳情` })
  await detail.getByRole('button', { name: `移出：${student(0).name}` }).click()
  const dialog = admin.getByRole('dialog', { name: `把 ${student(0).name} 移出 ${group}？` })
  await dialog.getByLabel('理由（必填）').fill('149 補驗：移出組長')
  await dialog.getByRole('button', { name: '確定移出' }).click()
  await expect(dialog.getByRole('alert')).toContainText('要移出的是組長：請同時指定接任的組長。')
  await shot(admin, 'remove-leader-needs-successor')
  await selectOptionContaining(dialog.getByLabel(/接任組長/), student(1).name)
  await dialog.getByRole('button', { name: '確定移出' }).click()
  await expect(detail.getByRole('status')).toContainText(`已把 ${student(0).name} 移出 ${group}，組長改由 ${student(1).name} 接任`)
  await expect(detail.getByRole('status')).toContainText('全組已收到通知')
  await shot(admin, 'leader-removed')

  await waitForInbox(student(1).page, '/dashboard/student/inbox', `系辦把 ${student(0).name} 移出組別 ${group}，組長改由 ${student(1).name} 接任`)
  await shot(student(1).page, 's2-inbox-successor')
  await waitForInbox(student(0).page, '/dashboard/student/inbox', `系辦已把你移出組別 ${group}；有疑問請聯絡系辦`)
  await shot(student(0).page, 's1-inbox-removed')
})
