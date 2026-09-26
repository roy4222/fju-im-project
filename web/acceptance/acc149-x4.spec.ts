import { randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import {
  activateCohort,
  assignAdvisor,
  closeContext,
  cohortIdOf,
  confirmAll,
  createCohortWithFlags,
  ensureAdmin,
  fillStages,
  importRoster,
  onboardStudents,
  propose,
  retireAll,
  runTag,
  saveGroupingSettings,
  selectOptionContaining,
  waitForInbox,
  type Student,
} from './acc149-helpers'
import {
  adminPage,
  createTeacher,
  disableAccount,
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
 * 149 案補驗 X4：評分方案型態、平均與捨入、改派三選一的執行、失效暫存、更正待復核、新版方案預覽、老師停用
 * （對照 e2e/acceptance/acc149-x4-grading-extra.md；測試名稱開頭是清單步驟與案例編號）。
 *
 * - 不動模擬業務鐘。會動開放註冊／預設工作兩個旗標：afterAll 一定還原。
 * - 這一輪的東西都帶 `ACC149-X4-<T>`（<T>＝臺灣時間月日時分）。註冊 2 位學生；3 位老師由管理員直接建。
 * - 收尾：停用學生與老師；每組最後一位組長停不掉（票 42），改核發臨時密碼作廢舊密碼（不看、不截圖）。
 * - 前一步失敗，後面就跳過（serial）。
 */

test.describe.configure({ mode: 'serial' })

const shot = screenshotter('acc149-x4')
const T = runTag()
const CODE = `ACC149-X4-${T}`
const COHORT_NAME = `ACC149 驗收屆 X4-${T}`
const PREFIX = `ACC149-X4-${T}`
const STUDENTS: NewStudent[] = [1, 2].map((i) => ({
  name: `${PREFIX}學生${i}`,
  studentNo: `8${T}0${i}`,
  email: `acc149-x4-${T}-s${i}@example.com`,
  dept: '資管三甲',
  password: `Acc149-X4-${randomBytes(6).toString('hex')}`,
}))
const TEACHERS = (['甲', '乙', '丙'] as const).map((k, i) => ({
  key: k,
  name: `${PREFIX}${k}老師`,
  email: `acc149-x4-${T}-t${'abc'[i]}@example.com`,
  newPassword: `Acc149-T-${randomBytes(6).toString('hex')}`,
}))
const [TA, TB, TC] = TEACHERS as [(typeof TEACHERS)[0], (typeof TEACHERS)[0], (typeof TEACHERS)[0]]

let admin: Page
const teacher: Record<string, Page> = {}
let students: Student[] = []
let cohortId = ''
let group = ''
let groupId = ''
let taSystemUrl = ''
let previousFlags: Flags = { registrationOpen: null, defaultWorking: null }
let flagsTouched = false
const registered = new Set<string>()
let teachersCreated = 0
/** 甲老師暫存專題發表後沒重新整理的那一頁（第 14、17 步）。 */
let taStalePage: Page | undefined

// ── 小工具 ─────────────────────────────────────────────────────────────────

async function openGrading(page: Page) {
  await page.goto(`/dashboard/admin/grading?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '成績管理', exact: true })).toBeVisible()
}

/** 「評分要求與指派」對話框，選好階段。 */
async function openAssign(page: Page, stage: '系統驗收' | '專題發表') {
  await openGrading(page)
  await page.getByRole('button', { name: '評分要求與指派' }).click()
  const dialog = page.getByRole('dialog', { name: '評分要求與指派' })
  await expect(dialog).toBeVisible()
  const link = dialog.getByRole('navigation', { name: '選擇階段' }).getByRole('link', { name: stage })
  if ((await link.getAttribute('aria-current')) !== 'page') {
    await link.click()
    await expect(page.getByRole('dialog', { name: '評分要求與指派' }).getByRole('navigation', { name: '選擇階段' }).getByRole('link', { name: stage })).toHaveAttribute(
      'aria-current',
      'page',
    )
  }
  return page.getByRole('dialog', { name: '評分要求與指派' })
}

function assignRow(page: Page) {
  return page.getByTestId(`grading-row-${group}`)
}

function bookRow(page: Page) {
  return page.getByTestId(`gradebook-row-${group}`)
}

function stageCell(page: Page, index: number) {
  return bookRow(page).locator('[data-testid^="stage-"]').nth(index)
}

async function openDetail(page: Page) {
  await page.goto(`/dashboard/admin/grading/${groupId}`)
  await expect(page.getByRole('heading', { name: `${group} 計算明細` })).toBeVisible()
}

/** 老師的評分工作台：從佇列點「<屆別>・<階段>」的組別。 */
async function openBench(page: Page, stage: string) {
  await page.goto('/dashboard/teacher/grading')
  const queue = page.getByRole('list', { name: '評分佇列' })
  await queue.getByRole('link', { name: new RegExp(`${stage}[\\s\\S]*${group}`) }).click()
  const bench = page.getByRole('region', { name: `${group}「${stage}」評分表` })
  await expect(bench).toBeVisible()
  return bench
}

async function submitBench(page: Page, stage: string, values: { score: string; label: string; pass?: boolean }, expected: string) {
  const bench = await openBench(page, stage)
  await bench.getByLabel(values.label).fill(values.score)
  if (values.pass) await bench.getByRole('radio', { name: '通過', exact: true }).click()
  await bench.getByRole('button', { name: '正式送出' }).click()
  await page.getByRole('dialog', { name: '確認正式送出' }).getByRole('button', { name: '確認送出' }).click()
  const receipt = page.getByRole('dialog', { name: '已收件' })
  await expect(receipt).toContainText('已收件')
  await expect(receipt).toContainText(expected)
  return receipt
}

async function reassign(page: Page, stage: '系統驗收' | '專題發表', from: string, choice: 'keep' | 'replace', to: string | null, reason: string) {
  const dialog = await openAssign(page, stage)
  await dialog.getByRole('link', { name: `移除或改派 ${from} 老師` }).click()
  await expect(page.getByRole('heading', { name: '移除或改派評分老師' })).toBeVisible()
  await page.getByTestId(`choice-${choice}`).getByRole('radio').check()
  if (choice === 'replace') {
    const select = page.getByLabel('接手的評分老師（不選＝只移除，之後再指派）')
    if (to) await selectOptionContaining(select, to)
  }
  await page.getByLabel(/^理由（必填，留在指派紀錄裡/).fill(reason)
}

// ── 收尾 ───────────────────────────────────────────────────────────────────

test.afterAll(async ({ browser }) => {
  test.setTimeout(300_000)
  if (flagsTouched || registered.size > 0 || teachersCreated > 0) {
    const page = await ensureAdmin(browser, admin)
    if (page) {
      admin = page
      // 1. 全站旗標先還（會影響別人）。
      if (flagsTouched) {
        await restoreFlags(admin, previousFlags, CODE).catch((error: unknown) => console.log(`收尾：旗標沒還成功（${firstLine(error)}）`))
      }
      // 2. 帳號：學生 2（組員）先、學生 1（組長）後；老師（乙可能已停用）。
      const names = [...[...registered].reverse(), ...TEACHERS.slice(0, teachersCreated).map((t) => t.name)]
      await retireAll(admin, names)
    }
  }
  await closeContext(admin)
  for (const p of Object.values(teacher)) await closeContext(p)
  for (const s of students) await closeContext(s.page)
})

// ── 前置 ───────────────────────────────────────────────────────────────────

test('x4:1-7 前置：背景工作在跑；建屆別與旗標、排階段、轉進行中、分組設定；2 位學生、3 位老師；成組並指派甲老師', async ({ browser, request }) => {
  test.setTimeout(420_000)
  const health = (await (await request.get('/api/health')).json()) as { commit?: string; worker?: { lastTickAt: string | null } }
  console.log(`測試站版本：commit=${health.commit?.slice(0, 8) ?? '（不明）'}；代號 ${T}`)
  const lastTick = health.worker?.lastTickAt ? Date.parse(health.worker.lastTickAt) : 0
  expect(Date.now() - lastTick, '背景工作的心跳超過 2 分鐘沒更新').toBeLessThan(120_000)

  admin = await adminPage(browser)
  await admin.goto('/dashboard/admin')
  await expect(admin.getByRole('heading', { name: /^歡迎回來，/ })).toBeVisible()

  previousFlags = await readFlags(admin)
  flagsTouched = true
  console.log(`跑之前：開放註冊屆別＝${previousFlags.registrationOpen ?? '（無）'}、預設工作屆別＝${previousFlags.defaultWorking ?? '（無）'}`)
  await createCohortWithFlags(admin, CODE, COHORT_NAME)
  await fillStages(admin, CODE)
  await expectStatus(admin, `已儲存 ${CODE} 的階段與日期`)
  await activateCohort(admin, CODE)
  cohortId = await cohortIdOf(admin, CODE)
  await saveGroupingSettings(admin, cohortId, CODE, 2, 2, 7)

  await importRoster(admin, CODE, STUDENTS)
  students = await onboardStudents(browser, admin, COHORT_NAME, STUDENTS, registered)

  for (const t of TEACHERS) {
    teachersCreated += 1
    const temporary = await createTeacher(admin, t)
    const page = await newPage(browser)
    teacher[t.key] = page
    await teacherFirstLogin(page, t.email, temporary, t.newPassword)
  }

  await propose(students[0]!.page, '一般專題', [students[1]!.studentNo])
  group = await confirmAll([students[0]!.page, students[1]!.page])
  await assignAdvisor(admin, cohortId, group, TA.name, '149 補驗：抽籤結果')
  await shot(admin, 'setup-advisor')
})

// ── 方案 ───────────────────────────────────────────────────────────────────

test('x4:8 GRD-01 等第型態有對照表；權重合計 90% 不能建立', async () => {
  await openGrading(admin)
  await admin.getByRole('button', { name: '建立新方案版本' }).click()
  const dialog = admin.getByRole('dialog', { name: '建立評分方案版本' })
  await dialog.getByLabel('第 2 階段第 1 項型態').selectOption({ label: '等第 A–F' })
  await expect(dialog.getByText('等第對照（隨版本保存）')).toBeVisible()
  for (const g of ['A', 'B', 'C', 'D', 'F']) await expect(dialog.getByRole('textbox', { name: g, exact: true })).toBeVisible()
  await shot(admin, 'letter-map')
  await dialog.getByLabel('第 2 階段第 1 項型態').selectOption({ label: '分數' })
  await expect(dialog.getByText('等第對照（隨版本保存）')).toHaveCount(0)

  await dialog.getByLabel('占總成績 %').nth(1).fill('30')
  await expect(dialog.getByTestId('weight-sum').first()).toContainText('階段合計 90%（要 100%）')
  await dialog.getByRole('button', { name: '建立草稿' }).click()
  await expect(dialog.getByRole('alert')).toContainText('各階段占總成績的合計是 90%，要剛好 100% 才能建立。')
  await expect(dialog).toBeVisible()
  await shot(admin, 'weight-90-blocked')
})

test('x4:9 GRD-01 加一個通過／不通過項目（不計分），建立並發布 v1', async () => {
  const dialog = admin.getByRole('dialog', { name: '建立評分方案版本' })
  await dialog.getByLabel('占總成績 %').nth(1).fill('40')
  await dialog.getByRole('button', { name: '＋ 新增項目' }).first().click()
  await dialog.getByLabel('第 1 階段第 2 項名稱').fill('出席')
  await dialog.getByLabel('第 1 階段第 2 項型態').selectOption({ label: '通過／不通過' })
  await expect(dialog.getByRole('listitem', { name: '第 1 個階段' })).toContainText('不計分')
  await expect(dialog.getByTestId('weight-sum').nth(1)).toContainText('項目合計 100%')
  await expect(dialog.getByTestId('weight-sum').nth(1)).not.toContainText('要 100%')
  await shot(admin, 'passfail-item')
  await dialog.getByRole('button', { name: '建立草稿' }).click()
  await expect(admin.getByRole('status').filter({ hasText: '已建立方案 v1（草稿）' })).toBeVisible()

  await admin.getByRole('button', { name: /^版本紀錄/ }).click()
  await admin.getByRole('dialog', { name: '評分方案版本' }).getByRole('button', { name: '發布 v1' }).click()
  await expect(admin.getByTestId('scheme-status')).toHaveText('v1・已發布')
  await expect(admin.getByTestId('scheme-formula')).toContainText('系統驗收 × 60% ＋ 專題發表 × 40%')
  await expect(admin.getByTestId('scheme-formula')).not.toContainText('出席')
  await shot(admin, 'scheme-v1-published')
})

test('x4:10 指派：系統驗收 2 份（甲、乙），專題發表 1 份（甲）', async () => {
  const setRequirement = async (stage: '系統驗收' | '專題發表', count: string, names: string[]) => {
    await openAssign(admin, stage)
    await assignRow(admin).getByLabel(`${group}「${stage}」要求份數`).fill(count)
    await assignRow(admin).getByRole('button', { name: '儲存' }).click()
    await expect(assignRow(admin)).toContainText(`已正式送出 0／${count} 份`)
    for (const name of names) {
      await selectOptionContaining(assignRow(admin).getByLabel(`${group}「${stage}」評分老師`), name)
      await assignRow(admin).getByRole('button', { name: '指派' }).click()
      await expect(assignRow(admin).getByRole('status')).toContainText(`已指派 ${name} 老師評 ${group}「${stage}」`)
    }
  }
  await setRequirement('系統驗收', '2', [TA.name, TB.name])
  await setRequirement('專題發表', '1', [TA.name])
  await shot(admin, 'assignments')
  const href = await bookRowLinkHref()
  groupId = href.split('/').pop() ?? ''
  expect(groupId).toMatch(/^[0-9a-f-]{36}$/)
})

async function bookRowLinkHref(): Promise<string> {
  await openGrading(admin)
  return (await bookRow(admin).getByRole('link', { name: '計算明細' }).getAttribute('href')) ?? ''
}

// ── 老師評分 ───────────────────────────────────────────────────────────────

test('x4:11 甲老師送出系統驗收 80（出席通過）；重新整理後已正式送出、不能再改', async () => {
  const page = teacher['甲']!
  const receipt = await submitBench(page, '系統驗收', { label: '1. 功能完整度', score: '80', pass: true }, '80.00')
  await shot(page, 'ta-receipt')
  await receipt.getByRole('button', { name: '知道了' }).click()
  taSystemUrl = page.url()
  await page.reload()
  const bench = page.getByRole('region', { name: `${group}「系統驗收」評分表` })
  await expect(bench.getByTestId('save-status')).toContainText('已正式送出')
  await expect(bench.getByLabel('1. 功能完整度')).toBeDisabled()
})

test('x4:12 GRD-12 GRD-02 沒被指派的丙老師：佇列沒有這一組，打開甲的網址看到「你沒有被指派評這一組」', async () => {
  const page = teacher['丙']!
  await page.goto('/dashboard/teacher/grading')
  await expect(page.locator('main')).not.toContainText(group)
  await page.goto(taSystemUrl)
  await expect(page.getByRole('heading', { name: '你沒有被指派評這一組' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText('80.00')
  await shot(page, 'tc-not-assigned')
})

test('x4:13 GRD-12 GRD-05 乙老師：負數擋暫存、漏填不能送出；84.29 可以', async () => {
  const page = teacher['乙']!
  const bench = await openBench(page, '系統驗收')
  await bench.getByLabel('1. 功能完整度').fill('-5')
  await expect(bench).toContainText('第 1 項要填 0–100 的數字（最多兩位小數）')
  await bench.getByRole('button', { name: '暫存' }).click()
  await expect(bench.getByRole('alert')).toContainText('修正後才能暫存。')
  await shot(page, 'tb-negative')
  await bench.getByLabel('1. 功能完整度').fill('')
  await expect(bench.getByRole('button', { name: '正式送出' })).toBeDisabled()
  await expect(bench).toContainText(/還差 \d 項，填齊後才能正式送出。/)
  await shot(page, 'tb-missing')
  await bench.getByLabel('1. 功能完整度').fill('84.29')
  await bench.getByRole('radio', { name: '通過', exact: true }).click()
  await bench.getByRole('button', { name: '正式送出' }).click()
  await page.getByRole('dialog', { name: '確認正式送出' }).getByRole('button', { name: '確認送出' }).click()
  const receipt = page.getByRole('dialog', { name: '已收件' })
  await expect(receipt).toContainText('84.29')
  await receipt.getByRole('button', { name: '知道了' }).click()
})

test('x4:14 GRD-14 甲老師暫存專題發表 88（不送出，這一頁之後不重新整理）', async () => {
  const page = teacher['甲']!
  const bench = await openBench(page, '專題發表')
  await bench.getByLabel('1. 發表內容').fill('88')
  await bench.getByRole('button', { name: '暫存' }).click()
  await expect(bench.getByRole('status').filter({ hasText: '已暫存到伺服器。暫存只有你和系辦看得到，不算正式分數。' })).toBeVisible()
  taStalePage = page
  await shot(page, 'ta-draft-88')
})

test('x4:15 GRD-05 GRD-03 系統驗收平均 82.15（不是先捨入再平均）；專題發表暫存不算', async () => {
  await openGrading(admin)
  await expect(stageCell(admin, 0)).toContainText('82.15')
  await expect(stageCell(admin, 0)).toContainText('已完成')
  await expect(stageCell(admin, 1)).toContainText('尚未完成')
  await expect(bookRow(admin).getByTestId('final')).toContainText('尚未完成')
  await shot(admin, 'gradebook-82-15')
  const dialog = await openAssign(admin, '專題發表')
  await expect(dialog.getByTestId(`grading-row-${group}`)).toContainText('暫存中（未正式）')
  await openDetail(admin)
  const formula = admin.locator('[data-testid^="detail-stage-"]').first().getByTestId('stage-formula')
  await expect(formula).toContainText('80')
  await expect(formula).toContainText('84.29')
  await expect(formula).toContainText('82.15')
  console.log(`x4:15 系統驗收算式：${await formula.innerText()}`)
  await shot(admin, 'detail-82-15')
})

// ── 改派三選一與失效暫存 ───────────────────────────────────────────────────

test('x4:16 GRD-13 GRD-14 專題發表「替換」甲 → 丙：甲的暫存標成失效', async () => {
  await reassign(admin, '專題發表', TA.name, 'replace', TC.name, '149 補驗：甲老師改當主指導就好')
  await expect(admin.getByRole('main')).toContainText('不會轉給新老師')
  await shot(admin, 'reassign-replace-preview')
  await admin.getByRole('button', { name: '確認執行' }).click()
  await expect(admin.getByRole('status').filter({ hasText: `${TA.name} 老師 → ${TC.name} 老師（替換評分老師、重新評分` })).toBeVisible()
  await openDetail(admin)
  const history = admin.getByRole('table', { name: '評分紀錄' })
  await expect(history.getByRole('row').filter({ hasText: '失效的暫存' })).toContainText('評分指派已移除')
  await shot(admin, 'draft-invalidated')
})

test('x4:17 GRD-14 甲老師的舊頁面不能再暫存；分組頁仍是甲指導', async () => {
  const page = taStalePage!
  const bench = page.getByRole('region', { name: `${group}「專題發表」評分表` })
  await bench.getByLabel('1. 發表內容').fill('89')
  await bench.getByRole('button', { name: '暫存' }).click()
  await expect(bench.getByRole('alert')).toContainText('你沒有被指派評這一組（或指派已結束），不能評分。')
  await shot(page, 'ta-stale-rejected')
  await page.goto('/dashboard/teacher/groups')
  await expect(page.getByRole('main')).toContainText(group)
  await shot(page, 'ta-still-advisor')
})

test('x4:18 GRD-02 丙老師收到指派通知；評分表沒有甲的 88；送出專題發表 90', async () => {
  test.setTimeout(240_000)
  const page = teacher['丙']!
  await waitForInbox(page, '/dashboard/teacher/inbox', `你被指派評分：${group}「專題發表」`)
  await shot(page, 'tc-inbox')
  const bench = await openBench(page, '專題發表')
  await expect(bench.getByLabel('1. 發表內容')).toHaveValue('')
  const receipt = await submitBench(page, '專題發表', { label: '1. 發表內容', score: '90' }, '90.00')
  await receipt.getByRole('button', { name: '知道了' }).click()
})

test('x4:19 GRD-06 最終加權與捨入：82.15、90.00 → 85.29', async () => {
  await openGrading(admin)
  await expect(stageCell(admin, 0)).toContainText('82.15')
  await expect(stageCell(admin, 1)).toContainText('90.00')
  await expect(bookRow(admin).getByTestId('final')).toContainText('85.29')
  await openDetail(admin)
  await expect(admin.getByTestId('adopted-final')).toHaveText('85.29')
  await expect(admin.getByTestId('final-formula')).toContainText('60%')
  await expect(admin.getByTestId('final-formula')).toContainText('40%')
  console.log(`x4:19 最終算式：${await admin.getByTestId('final-formula').innerText()}`)
  await shot(admin, 'final-85-29')
})

test('x4:20 GRD-13「保留已完成評分」移除乙：份數 2／2、平均 82.15、最終 85.29 不變；乙的佇列沒有系統驗收', async () => {
  test.setTimeout(180_000)
  await reassign(admin, '系統驗收', TB.name, 'keep', null, '149 補驗：乙老師離職，分數保留')
  await admin.getByRole('button', { name: '確認執行' }).click()
  await expect(admin.getByRole('status').filter({ hasText: TB.name })).toBeVisible()
  const dialog = await openAssign(admin, '系統驗收')
  await expect(dialog.getByTestId(`grading-row-${group}`)).toContainText('已正式送出 2／2 份')
  await admin.keyboard.press('Escape')
  await openGrading(admin)
  await expect(stageCell(admin, 0)).toContainText('82.15')
  await expect(bookRow(admin).getByTestId('final')).toContainText('85.29')
  await shot(admin, 'keep-unchanged')
  const tb = teacher['乙']!
  await tb.goto('/dashboard/teacher/grading')
  await expect(tb.getByRole('list', { name: '評分佇列' }).getByRole('link', { name: new RegExp(`系統驗收[\\s\\S]*${group}`) })).toHaveCount(0)
  // 票 43 之後：被移出的老師會收到移出通知（清單寫「目前沒有」是舊的）；照實記下。
  await tb.goto('/dashboard/teacher/inbox')
  const removed = await tb.getByTestId('inbox-item').filter({ hasText: '被移出' }).count()
  console.log(`x4:20 觀察：乙老師通知匣「被移出」通知 ${removed} 則（背景工作可能還沒投影）`)
})

// ── 更正與待復核 ───────────────────────────────────────────────────────────

test('x4:21 GRD-08 GRD-15 更正最終成績 88（保留原值 85.29 與理由）', async () => {
  await openDetail(admin)
  await admin.getByRole('button', { name: '更正最終成績' }).click()
  const dialog = admin.getByRole('dialog', { name: '更正最終成績' })
  await dialog.getByLabel('更正後的最終成績（0–100，最多兩位小數）').fill('88')
  await dialog.getByLabel('更正理由').fill('149 補驗：口試補考')
  await dialog.getByRole('button', { name: '確認更正' }).click()
  await expect(admin.getByRole('status').filter({ hasText: `${group} 的最終成績已更正為 88.00（原 85.29，原始老師輸入不變）` })).toBeVisible()
  await expect(admin.getByText('已更正：原 85.29 → 88.00（149 補驗：口試補考')).toBeVisible()
  await shot(admin, 'override-88')
})

test('x4:22 GRD-15 NTF-17 計算基礎改變：系統驗收替換甲 → 丙，更正進待復核，系辦收到通知', async () => {
  test.setTimeout(240_000)
  await reassign(admin, '系統驗收', TA.name, 'replace', TC.name, '149 補驗：重評系統驗收')
  await expect(admin.getByText('這一組有生效中的最終成績更正；這個選擇會改變計算基礎，那筆更正會進「待復核」。')).toBeVisible()
  await shot(admin, 'replace-review-warning')
  await admin.getByRole('button', { name: '確認執行' }).click()
  await expect(admin.getByRole('status').filter({ hasText: `${TA.name} 老師 → ${TC.name} 老師` })).toBeVisible()

  await openGrading(admin)
  await expect(bookRow(admin).getByTestId('final')).toContainText('更正待復核')
  await expect(admin.getByRole('region', { name: '待復核' })).toContainText(group)
  await expect(admin.getByText('待復核的更正（1）')).toBeVisible()
  await expect(stageCell(admin, 0)).toContainText('尚未完成')
  await openDetail(admin)
  await expect(admin.getByText('更正待復核：計算基礎已改變，原更正暫不套用。')).toBeVisible()
  await shot(admin, 'pending-review')
  await waitForInbox(admin, '/dashboard/admin/inbox', `${group} 的成績更正待復核：計算基礎改變了`)
  await shot(admin, 'admin-inbox-review')
})

test('x4:23 GRD-15 丙老師送出系統驗收 76：重算 80.15、計算最終 84.09，仍待復核', async () => {
  const page = teacher['丙']!
  const receipt = await submitBench(page, '系統驗收', { label: '1. 功能完整度', score: '76', pass: true }, '76.00')
  await receipt.getByRole('button', { name: '知道了' }).click()
  await openGrading(admin)
  await expect(stageCell(admin, 0)).toContainText('80.15')
  await expect(bookRow(admin).getByTestId('final')).toContainText('更正待復核')
  await openDetail(admin)
  await expect(admin.getByTestId('final-formula')).toContainText('84.09')
  await expect(admin.getByText('更正待復核：計算基礎已改變，原更正暫不套用。')).toBeVisible()
  console.log(`x4:23 待復核時採用值：${await admin.getByTestId('adopted-final').innerText()}`)
  await shot(admin, 'recomputed-pending')
})

test('x4:24 GRD-15 復核：沿用原更正值 88.00', async () => {
  await openDetail(admin)
  const form = admin.getByRole('form', { name: '復核更正' })
  await form.getByRole('radio', { name: /沿用原更正值 88\.00/ }).check()
  await form.getByLabel('復核說明').fill('149 補驗：補考成績維持')
  await form.getByRole('button', { name: '確認復核' }).click()
  await expect(admin.getByRole('status').filter({ hasText: '已處理待復核：' })).toBeVisible()
  await expect(admin.getByTestId('adopted-final')).toHaveText('88.00')
  await expect(admin.getByText('更正待復核：計算基礎已改變，原更正暫不套用。')).toHaveCount(0)
  await openGrading(admin)
  await expect(bookRow(admin).getByTestId('final')).not.toContainText('更正待復核')
  await shot(admin, 'review-kept-88')
})

// ── 新版方案預覽後取消 ─────────────────────────────────────────────────────

test('x4:25 GRD-09 方案已鎖定：建 v2（50／50）看影響後取消，不重算', async () => {
  await openGrading(admin)
  await expect(admin.getByTestId('scheme-status')).toHaveText('v1・已鎖定')
  await expect(admin.getByRole('main')).toContainText('結構已鎖定')
  await admin.getByRole('button', { name: '建立新方案版本' }).click()
  const dialog = admin.getByRole('dialog', { name: '建立評分方案版本' })
  await dialog.getByLabel('占總成績 %').nth(0).fill('50')
  await dialog.getByLabel('占總成績 %').nth(1).fill('50')
  await dialog.getByRole('button', { name: '建立草稿' }).click()
  await expect(admin.getByRole('status').filter({ hasText: '已建立方案 v2（草稿）' })).toBeVisible()
  await admin.getByRole('button', { name: /^版本紀錄/ }).click()
  await admin.getByRole('link', { name: '看影響並套用 v2' }).click()
  await expect(admin.getByRole('heading', { name: '套用新評分方案' })).toBeVisible()
  await expect(admin.getByRole('main')).toContainText('v1 → v2 的影響')
  const row = admin.getByTestId(`apply-row-${group}`)
  await expect(row).toContainText('→')
  await expect(row).toContainText('更正會進待復核')
  console.log(`x4:25 影響列：${(await row.innerText()).replace(/\s+/g, ' ')}`)
  await shot(admin, 'apply-v2-preview')
  await admin.getByRole('link', { name: '取消（不重算）' }).click()
  await expect(admin.getByTestId('scheme-status')).toHaveText('v1・已鎖定')
  await expect(bookRow(admin).getByTestId('final')).toContainText('88.00')
  await shot(admin, 'apply-cancelled')
})

// ── 老師停用 ───────────────────────────────────────────────────────────────

test('x4:26 GRD-14 停用有未完成指派的乙老師：缺評待處理，不自動改派', async () => {
  const dialog = await openAssign(admin, '專題發表')
  const row = dialog.getByTestId(`grading-row-${group}`)
  await row.getByLabel(`${group}「專題發表」要求份數`).fill('2')
  await row.getByRole('button', { name: '儲存' }).click()
  await expect(row).toContainText('已正式送出 1／2 份')
  await selectOptionContaining(row.getByLabel(`${group}「專題發表」評分老師`), TB.name)
  await row.getByRole('button', { name: '指派' }).click()
  await expect(row.getByRole('status')).toContainText(`已指派 ${TB.name} 老師評 ${group}「專題發表」`)

  expect(await disableAccount(admin, TB.name), '停用乙老師沒成功').toBe(true)

  await openGrading(admin)
  await expect(stageCell(admin, 1)).toContainText('尚未完成')
  await expect(bookRow(admin)).toContainText(`專題發表：${TB.name}（老師已停用，缺評待處理）`)
  await expect(stageCell(admin, 1)).toContainText('1／2')
  await shot(admin, 'disabled-missing')
  const assign = await openAssign(admin, '專題發表')
  await expect(assign.getByTestId(`grading-row-${group}`)).toContainText('已正式送出 1／2 份')
  await expect(assign.getByTestId(`grading-row-${group}`)).toContainText(TC.name)
})
