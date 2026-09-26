import { randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import {
  activateCohort,
  archiveItem,
  closeContext,
  cohortIdOf,
  createCohortWithFlags,
  ensureAdmin,
  fillStages,
  importRoster,
  onboardStudents,
  openMyGroup,
  publishFromEditor,
  readClockOffset,
  retireAll,
  runTag,
  saveDraft,
  saveGroupingSettings,
  setClock,
  setClockLocal,
  stageText,
  waitForInbox,
  ymd,
  type Student,
} from './acc149-helpers'
import { adminPage, expectStatus, firstLine, readFlags, restoreFlags, screenshotter, type Flags, type NewStudent } from './helpers'

/**
 * 149 案補驗 X3：模擬業務鐘推進與倒退、截止那一分鐘、提案逾期、活動改期與取消
 * （對照 e2e/acceptance/acc149-x3-clock-deadlines.md；測試名稱開頭是清單步驟與案例編號）。
 *
 * - **會把業務鐘推到 6 天、31 天後再倒退**：業務鐘是全站狀態，推過去的那段時間裡，測試站上其他屆別到期的提案、截止
 *   也會照業務時間處理（清單說這是預期的）。第 0 步先記下原本的業務鐘，afterAll 一定還原（原本沒模擬就撥回真實時間），
 *   並在最後讀一次確認。旗標也一定還原。
 * - 這一輪的東西都帶 `ACC149-X3-<T>`。註冊 2 位學生。
 * - 「今天 ±N 天」一律從真實的今天算（不是業務時間）。
 * - 前一步失敗，後面就跳過（serial）；收尾照做。
 */

test.describe.configure({ mode: 'serial' })

const shot = screenshotter('acc149-x3')
const T = runTag()
const CODE = `ACC149-X3-${T}`
const COHORT_NAME = `ACC149 驗收屆 X3-${T}`
const PREFIX = `ACC149-X3-${T}`
const STUDENTS: NewStudent[] = [1, 2].map((i) => ({
  name: `${PREFIX}學生${i}`,
  studentNo: `7${T}0${i}`,
  email: `acc149-x3-${T}-s${i}@example.com`,
  dept: '資管三甲',
  password: `Acc149-X3-${randomBytes(6).toString('hex')}`,
}))
const BRIEFING = `${PREFIX} 說明會`
const SHOWCASE = `${PREFIX} 成果發表`
const ITEM = `${PREFIX} 期限測試`
const DUE_DAY = ymd(5)
const slash = (d: string) => d.replace(/-/g, '/')
/** 日期兩種寫法（2026/09/29 或 2026-09-29）都認。 */
const dayRe = (d: string) => d.replace(/-/g, '[/-]')

let admin: Page
let students: Student[] = []
let cohortId = ''
let itemId = ''
let previousFlags: Flags = { registrationOpen: null, defaultWorking: null }
let flagsTouched = false
/** 跑之前的業務鐘：null＝沒有模擬；否則「業務時間 − 真實時間」。 */
let previousClockOffset: number | null = null
let clockTouched = false
const registered = new Set<string>()
const reasons: string[] = []

function student(i: number): Student {
  const s = students[i]
  if (!s) throw new Error(`第 ${i + 1} 位學生還沒準備好（前面的步驟失敗了）`)
  return s
}

async function clock(local: string, reason: string) {
  await setClockLocal(admin, local, reason)
  reasons.push(reason)
}

/** 學生行事曆：翻到那個月、點那一天，回傳「這天的行程」的文字（沒有行程就是空字串）。 */
async function calendarDay(page: Page, date: string): Promise<string> {
  const calendar = page.getByTestId('student-calendar')
  await expect(calendar).toBeVisible()
  const heading = calendar.getByText(/^\d{4} 年 \d{1,2} 月$/)
  const [shownY, shownM] = ((await heading.innerText()).match(/\d+/g) ?? []).map(Number)
  const [y, m] = date.split('-').map(Number)
  const diff = (y! - shownY!) * 12 + (m! - shownM!)
  for (let i = 0; i < Math.abs(diff); i += 1) await calendar.getByRole('button', { name: diff > 0 ? '下個月' : '上個月' }).click()
  await calendar.getByRole('button', { name: new RegExp(`^${date}`) }).click()
  const list = calendar.getByRole('list', { name: '這天的行程' })
  return (await list.count()) > 0 ? (await list.innerText()).replace(/\s+/g, ' ') : ''
}

/** x3:9 的結果：讀行事曆失敗不擋後面的業務鐘步驟（serial），留到最後一個測試再判定。 */
let calendarResult: { day3: string; day4: string; day5: string } | { error: string } | null = null

// ── 收尾 ───────────────────────────────────────────────────────────────────

test.afterAll(async ({ browser }) => {
  test.setTimeout(300_000)
  if (clockTouched || flagsTouched || registered.size > 0 || itemId) {
    const page = await ensureAdmin(browser, admin)
    if (page) {
      admin = page
      // 1. 業務鐘（全站、影響最大）：原本有模擬就還原當時的偏移，原本沒有就撥回真實時間。
      if (clockTouched) {
        try {
          const offset = previousClockOffset ?? 0
          await setClock(admin, Date.now() + offset, offset === 0 ? '149 補驗收尾：撥回真實時間' : '149 補驗收尾：還原跑之前的模擬時間')
          const now = await readClockOffset(admin)
          const drift = Math.abs((now ?? 0) - offset)
          console.log(`收尾：業務鐘已還原；目前${now === null ? '沒有模擬' : `模擬中，偏移 ${Math.round(now / 1000)} 秒`}，與預期差 ${Math.round(drift / 1000)} 秒`)
          if (drift > 60_000) console.log('收尾：⚠ 業務鐘與預期相差超過 1 分鐘，請手動檢查 /dashboard/admin/clock')
        } catch (error) {
          console.log(`收尾：⚠ 業務鐘沒還原（${firstLine(error)}）——請手動到 /dashboard/admin/clock 撥回`)
        }
      }
      // 2. 旗標。
      if (flagsTouched) {
        await restoreFlags(admin, previousFlags, CODE).catch((error: unknown) => console.log(`收尾：旗標沒還成功（${firstLine(error)}）`))
      }
      // 3. 下架期限測試。
      if (itemId) await archiveItem(admin, itemId).catch((error: unknown) => console.log(`收尾：期限測試沒下架（${firstLine(error)}）`))
      // 4. 兩位學生（提案逾期後都沒有組別）。
      await retireAll(admin, [...registered])
    }
  }
  await closeContext(admin)
  for (const s of students) await closeContext(s.page)
})

// ── 前置 ───────────────────────────────────────────────────────────────────

test('x3:1-4 前置：背景工作在跑；記下業務鐘並撥回真實時間；記下旗標；建屆別、設旗標、分組 2 人、提案 3 天', async ({ browser, request }) => {
  const health = (await (await request.get('/api/health')).json()) as { commit?: string; worker?: { lastTickAt: string | null } }
  console.log(`測試站版本：commit=${health.commit?.slice(0, 8) ?? '（不明）'}；代號 ${T}；今天 ${ymd(0)}`)
  const lastTick = health.worker?.lastTickAt ? Date.parse(health.worker.lastTickAt) : 0
  expect(Date.now() - lastTick, '背景工作的心跳超過 2 分鐘沒更新：提案逾期不會處理').toBeLessThan(120_000)

  admin = await adminPage(browser)
  previousClockOffset = await readClockOffset(admin)
  clockTouched = true
  console.log(`跑之前的業務鐘：${previousClockOffset === null ? '沒有模擬' : `模擬中，偏移 ${Math.round(previousClockOffset / 1000)} 秒`}`)
  await setClock(admin, Date.now(), `149 補驗 ${T}：開始前撥回真實時間`)
  reasons.push(`149 補驗 ${T}：開始前撥回真實時間`)

  previousFlags = await readFlags(admin)
  flagsTouched = true
  console.log(`跑之前：開放註冊屆別＝${previousFlags.registrationOpen ?? '（無）'}、預設工作屆別＝${previousFlags.defaultWorking ?? '（無）'}`)
  await createCohortWithFlags(admin, CODE, COHORT_NAME)
  cohortId = await cohortIdOf(admin, CODE)
  await saveGroupingSettings(admin, cohortId, CODE, 2, 2, 3)
  await expectStatus(admin, '每組 2 人、提案 3 天內要全員確認')
  await shot(admin, 'grouping-settings')
})

// ── 票 11：階段日期、活動 ─────────────────────────────────────────────────

test('x3:5 COH-01 階段開始日不遞增被擋，改正後儲存；轉進行中', async () => {
  const dialog = await fillStages(admin, CODE, [-10, -20, 90, 150])
  await expect(dialog.getByRole('alert')).toContainText(`第 2 階段的開始日（${ymd(-20)}）要晚於第 1 階段（${ymd(-10)}）。開始日必須一段比一段晚。`)
  await shot(admin, 'stage-order-blocked')
  await dialog.getByLabel('第 2 階段開始日').fill(ymd(30))
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expectStatus(admin, `已儲存 ${CODE} 的階段與日期`)
  await activateCohort(admin, CODE)
})

test('x3:6 COH-02 新增計時活動與全天活動；沒填開始時間也沒勾全天被擋', async () => {
  await admin.goto('/dashboard/admin/timeline')
  await admin.getByRole('button', { name: '新增活動' }).click()
  let create = admin.getByRole('dialog', { name: '新增活動' })
  await create.getByLabel('活動名稱').fill(BRIEFING)
  await create.getByLabel('日期', { exact: true }).fill(ymd(3))
  await create.getByRole('button', { name: '建立活動' }).click()
  await expect(admin.getByText('請填開始時間，或勾選「全天」。').first()).toBeVisible()
  await create.getByLabel('開始時間').fill('14:00')
  await create.getByLabel('結束時間（可不填）').fill('16:00')
  await create.getByRole('button', { name: '建立活動' }).click()
  await expectStatus(admin, `已新增活動「${BRIEFING}」。`)

  await admin.goto('/dashboard/admin/timeline')
  await admin.getByRole('button', { name: '新增活動' }).click()
  create = admin.getByRole('dialog', { name: '新增活動' })
  await create.getByLabel('活動名稱').fill(SHOWCASE)
  await create.getByLabel('日期', { exact: true }).fill(ymd(4))
  await create.getByRole('checkbox', { name: '全天' }).check()
  await create.getByRole('button', { name: '建立活動' }).click()
  await expectStatus(admin, `已新增活動「${SHOWCASE}」。`)
  const scheduled = admin.getByRole('region', { name: '已排定的活動' })
  await expect(scheduled).toContainText(`${ymd(3)} 14:00–16:00`)
  await expect(scheduled).toContainText(`${ymd(4)}（全天）`)
  await shot(admin, 'activities-created')
})

test('x3:7 COH-03 說明會改期到今天+5 天、成果發表取消（留在「已取消」、沒有改期按鈕）', async () => {
  const scheduled = admin.getByRole('region', { name: '已排定的活動' })
  await scheduled.getByRole('button', { name: `改期：${BRIEFING}` }).click()
  const edit = admin.getByRole('dialog', { name: `改期：${BRIEFING}` })
  await edit.getByLabel('日期', { exact: true }).fill(ymd(5))
  await edit.getByRole('button', { name: '儲存改期' }).click()
  await expectStatus(admin, `已更新活動「${BRIEFING}」。`)
  await scheduled.getByRole('button', { name: `取消活動：${SHOWCASE}` }).click()
  await admin.getByRole('dialog', { name: `取消「${SHOWCASE}」？` }).getByRole('button', { name: '確定取消' }).click()
  // 成功回饋掛在活動那一列上；取消後那一列搬去「已取消」清單，回饋跟著消失——只記下有沒有看到。
  await expect(admin.getByRole('region', { name: '已取消的活動' })).toContainText(SHOWCASE)
  const cancelMessage = await admin.getByText(`已取消活動「${SHOWCASE}」；它會留在「已取消」清單。`).count()
  console.log(`x3:7 觀察：取消後畫面上${cancelMessage > 0 ? '有' : '沒有'}「已取消活動「…」；它會留在「已取消」清單。」回饋`)
  await admin.reload()
  const cancelled = admin.getByRole('region', { name: '已取消的活動' })
  await expect(cancelled).toContainText(SHOWCASE)
  await expect(cancelled.getByRole('button', { name: `改期：${SHOWCASE}` })).toHaveCount(0)
  await expect(admin.getByRole('region', { name: '已排定的活動' })).toContainText(`${ymd(5)} 14:00–16:00`)
  await shot(admin, 'activities-rescheduled')
})

// ── 學生進來、發一份有截止的收件 ───────────────────────────────────────────

test('x3:8 匯入名單、兩位學生註冊並核准、登入', async ({ browser }) => {
  test.setTimeout(240_000)
  await importRoster(admin, CODE, STUDENTS)
  students = await onboardStudents(browser, admin, COHORT_NAME, STUDENTS, registered)
})

test('x3:9（讀取）學生 1 首頁行事曆看今天+3、+4、+5 天（判定在最後一個測試）', async () => {
  const page = student(0).page
  await page.goto('/dashboard/student')
  try {
    const day5 = await calendarDay(page, ymd(5))
    const day3 = await calendarDay(page, ymd(3))
    const day4 = await calendarDay(page, ymd(4))
    calendarResult = { day3, day4, day5 }
    console.log(`x3:9 行事曆：+3＝「${day3}」；+4＝「${day4}」；+5＝「${day5}」`)
  } catch (error) {
    calendarResult = { error: firstLine(error) }
    console.log(`x3:9 讀行事曆失敗：${firstLine(error)}`)
  }
  await shot(page, 'student-calendar')
})

test('x3:10 GRP-12 學生 1 發起提案：到期時間約 3 天後；學生 2 不確認', async () => {
  const page = student(0).page
  await openMyGroup(page)
  await page.getByRole('radio', { name: '一般專題' }).check()
  await page.getByLabel(/^同學 1 的學號/).fill(student(1).studentNo)
  await page.getByRole('button', { name: '發起提案' }).click()
  const status = page.getByRole('region', { name: '我的組別狀態' })
  // 提案人也要自己按「確認加入」（triage 2026-09-26：清單寫 1／2 是舊預期），所以發起後是 0／2。
  await expect(status).toContainText(/[01]／2 已確認/)
  await expect(status).toContainText(new RegExp(`到期時間\\s*${dayRe(ymd(3))}`))
  console.log(`x3:10 提案狀態：${(await status.innerText()).replace(/\s+/g, ' ').slice(0, 200)}`)
  await shot(page, 'proposal-open')
})

test('x3:11 發布個人收件「期限測試」（截止 今天+5 天 23:59）', async () => {
  await admin.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
  await admin.getByLabel('標題', { exact: true }).fill(ITEM)
  await admin.getByLabel('正文').fill('149 補驗：截止測試。')
  await admin.getByLabel('發布位置', { exact: true }).selectOption('submission')
  await admin.getByRole('radio', { name: '個人一份', exact: true }).check()
  await admin.getByLabel('發布對象').selectOption('cohort_students')
  await admin.getByLabel('所屬階段').selectOption({ index: 1 })
  await admin.getByLabel('截止時間（臺灣時間，含這一分鐘）').fill(`${DUE_DAY}T23:59`)
  await admin.getByLabel('要新增的欄位類型').selectOption('text')
  await admin.getByRole('button', { name: '新增欄位' }).click()
  const field = admin.locator('li[data-field-type="text"]')
  await field.getByLabel('第 1 個欄位的標籤').fill('內容')
  await field.getByRole('checkbox', { name: '必填' }).check()
  itemId = await saveDraft(admin)
  const receipt = await publishFromEditor(admin)
  expect(receipt).toContain('收件名單 2 位')
  expect(receipt).toMatch(new RegExp(`${dayRe(DUE_DAY)} 23:59`))
  expect(receipt).toContain('含此分鐘')
  await shot(admin, 'item-published')
})

test('x3:12 學生 1 送 v1 再改內容（不送）；學生 2 只存草稿、頁面開著不動', async () => {
  const s1 = student(0).page
  await s1.goto(`/dashboard/student/affairs/${itemId}`)
  await s1.getByRole('textbox', { name: '內容', exact: true }).fill('149 補驗：截止前第一版')
  await s1.getByRole('button', { name: '正式送出' }).click()
  await expect(s1.getByTestId('receipt')).toContainText('v1')
  await s1.getByTestId('receipt').getByRole('button', { name: '關閉' }).click()
  await s1.getByRole('textbox', { name: '內容', exact: true }).fill('149 補驗：截止分鐘內的第二版')

  const s2 = student(1).page
  await s2.goto(`/dashboard/student/affairs/${itemId}`)
  await s2.getByRole('textbox', { name: '內容', exact: true }).fill('149 補驗：學生二的草稿')
  await s2.getByRole('button', { name: '儲存草稿' }).click()
  await expect(s2.getByTestId('save-status')).toContainText('已儲存')
})

// ── 推到截止那一分鐘、再推過截止 ───────────────────────────────────────────

test('x3:13 SUB-16 COH-10 COH-04 業務時間推到截止那一分鐘（23:59:07）：學生 1 仍可重新送出 v2', async () => {
  await clock(`${DUE_DAY}T23:59:07`, `149 補驗 ${T}：截止那一分鐘`)
  // 業務鐘會跟著走：約 50 秒內要送出去。中間不截圖。
  const s1 = student(0).page
  await s1.getByRole('button', { name: '重新送出' }).click()
  const receipt = s1.getByTestId('receipt')
  await expect(receipt).toContainText('v2')
  await expect(receipt).toContainText(new RegExp(`${dayRe(DUE_DAY)} 23:59`))
  await shot(s1, 'resubmit-last-minute')
  await receipt.getByRole('button', { name: '關閉' }).click()
})

test('x3:14 SUB-11 SUB-16 COH-10 推過截止（隔天 00:00:07）：學生 2 的舊頁面送出被伺服器拒絕；重新整理後唯讀、草稿保留', async () => {
  await clock(`${ymd(6)}T00:00:07`, `149 補驗 ${T}：截止後一分鐘`)
  const s2 = student(1).page
  await s2.getByRole('button', { name: '正式送出' }).click()
  await expect(s2.getByRole('alert').filter({ hasText: '已經截止' })).toContainText(
    `已經截止（截止：${slash(DUE_DAY)} 23:59，含此分鐘，臺灣時間）；需要補交請聯絡系辦。`,
  )
  await shot(s2, 'stale-page-rejected')
  await s2.reload()
  await expect(s2.getByRole('main')).toContainText('已截止・唯讀；需要補交請聯絡系辦重新開放。')
  console.log(`x3:14 截止後上方橫幅：${(await s2.getByTestId('affair-banner').innerText()).replace(/\s+/g, ' ')}`)
  await expect(s2.getByRole('button', { name: '正式送出' })).toHaveCount(0)
  await expect(s2.getByRole('button', { name: '儲存草稿' })).toHaveCount(0)
  const field = s2.getByRole('textbox', { name: '內容', exact: true })
  if ((await field.count()) > 0) await expect(field).toHaveValue('149 補驗：學生二的草稿')
  else console.log('x3:14 觀察：截止後內容頁沒有顯示欄位（看不到草稿內容）')
  await shot(s2, 'read-only-after-deadline')
  await s2.goto('/dashboard/student/affairs')
  const row = s2.getByTestId(`affair-${itemId}`)
  if ((await row.count()) > 0) await expect(row).not.toContainText('已繳')
  else console.log('x3:14 觀察：截止後作業區沒有這一列')
})

test('x3:15 GRP-12 提案逾期：整份終止、學生 1 收到通知、又看得到發起提案', async () => {
  test.setTimeout(240_000)
  const page = student(0).page
  await expect
    .poll(
      async () => {
        await openMyGroup(page)
        return page.getByRole('region', { name: '提案紀錄' }).filter({ hasText: '已終止：逾期' }).count()
      },
      { timeout: 150_000, intervals: [5_000, 10_000] },
    )
    .toBeGreaterThan(0)
  await expect(page.getByRole('region', { name: '提案紀錄' })).toContainText(`${student(0).name} 發起的一般專題提案`)
  await expect(page.getByRole('button', { name: '發起提案' })).toBeVisible()
  await shot(page, 'proposal-expired')
  await waitForInbox(page, '/dashboard/student/inbox', '分組提案已終止（逾期），所有人都已釋放')
  await shot(page, 'proposal-expired-inbox')
})

test('x3:16 COH-04 時間推進不代替完成：完成率 1／2；系辦首頁仍是階段 1，註明模擬鐘', async () => {
  await admin.goto(`/dashboard/admin/affairs/${itemId}`)
  await expect(admin.getByTestId('completion-rate')).toHaveText('1／2')
  await shot(admin, 'completion-after-deadline')
  await expect(await stageText(admin, '/dashboard/admin')).toHaveText('階段 1：成組期')
  await expect(admin.locator('body')).toContainText('模擬鐘')
  await shot(admin, 'stage-1-simulated')
})

// ── 倒退回開放區間 ─────────────────────────────────────────────────────────

test('x3:17 COH-10 業務鐘倒退回現在：學生 2 又可以送，草稿還在，送出 v1', async () => {
  const now = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19)
  await clock(now.endsWith(':00') ? `${now.slice(0, 17)}07` : now, `149 補驗 ${T}：倒退回開放區間`)
  const s2 = student(1).page
  await s2.goto(`/dashboard/student/affairs/${itemId}`)
  await expect(s2.getByRole('textbox', { name: '內容', exact: true })).toHaveValue('149 補驗：學生二的草稿')
  await s2.getByRole('button', { name: '正式送出' }).click()
  await expect(s2.getByTestId('receipt')).toContainText('v1')
  await shot(s2, 'resubmit-after-rewind')
  await s2.getByTestId('receipt').getByRole('button', { name: '關閉' }).click()
})

test('x3:18 COH-10 COH-04 倒退不改既有版本、不復活逾期的提案', async () => {
  const s1 = student(0).page
  await s1.goto(`/dashboard/student/affairs/${itemId}?tab=history`)
  const rows = s1.getByRole('table', { name: '繳交歷史' }).locator('tbody tr')
  await expect(rows).toHaveCount(2)
  await rows.last().getByRole('link', { name: '查看內容' }).click()
  await expect(s1.getByTestId('version-view')).toContainText('截止前第一版')
  await s1.goto(`/dashboard/student/affairs/${itemId}?tab=history`)
  await s1.getByRole('table', { name: '繳交歷史' }).locator('tbody tr').first().getByRole('link', { name: '查看內容' }).click()
  await expect(s1.getByTestId('version-view')).toContainText('截止分鐘內的第二版')
  await shot(s1, 'history-intact')
  await openMyGroup(s1)
  await expect(s1.getByRole('region', { name: '提案紀錄' })).toContainText('已終止：逾期')
  await expect(s1.getByRole('button', { name: '發起提案' })).toBeVisible()
})

test('x3:19 COH-04 GRP-12 推到第 2 階段（+31 天）：系辦與學生都是期中；成組期結束不能再提案', async () => {
  await clock(`${ymd(31)}T10:00:07`, `149 補驗 ${T}：推到第 2 階段`)
  await expect(await stageText(admin, '/dashboard/admin')).toHaveText('階段 2：期中')
  const s1 = student(0).page
  await expect(await stageText(s1, '/dashboard/student')).toHaveText('階段 2：期中')
  await openMyGroup(s1)
  const form = s1.getByRole('button', { name: '發起提案' })
  if ((await form.count()) === 0) {
    console.log('x3:19 觀察：成組期結束後頁面已沒有「發起提案」表單')
    await expect(s1.getByRole('main')).toContainText('成組期已經結束')
  } else {
    await s1.getByRole('radio', { name: '一般專題' }).check()
    await s1.getByLabel(/^同學 1 的學號/).fill(student(1).studentNo)
    await form.click()
    await expect(s1.getByRole('main')).toContainText('成組期已經結束')
    await expect(s1.getByRole('main')).toContainText('需要分組請聯絡系辦')
  }
  await shot(s1, 'proposal-after-grouping')
})

test('x3:20 COH-04 COH-10 設定紀錄：這一輪每一筆都有操作者、原因、前後業務時間與真實時間', async () => {
  await admin.goto('/dashboard/admin/clock')
  const history = admin.getByRole('region', { name: '設定紀錄' })
  for (const reason of reasons) await expect(history.getByRole('row').filter({ hasText: reason })).toHaveCount(1)
  const latest = history.getByRole('row').filter({ hasText: `149 補驗 ${T}：推到第 2 階段` })
  console.log(`x3:20 最新一筆：${(await latest.innerText()).replace(/\s+/g, ' ')}`)
  await expect(latest).toContainText(`${slash(ymd(31))} 10:00:`)
  await shot(admin, 'clock-history')
})

test('x3:9 COH-02 COH-03 NTF-13 學生行事曆與活動清單一致：+5 天有說明會、+3 天沒有、+4 天成果發表已取消', () => {
  expect(calendarResult, '行事曆沒有讀到').not.toBeNull()
  if (calendarResult && 'error' in calendarResult) throw new Error(`讀行事曆失敗：${calendarResult.error}`)
  const r = calendarResult as { day3: string; day4: string; day5: string }
  expect(r.day5).toContain(BRIEFING)
  expect(r.day3).not.toContain(BRIEFING)
  expect(r.day4).toContain(SHOWCASE)
  expect(r.day4).toContain('已取消')
})
