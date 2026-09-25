import { expect, type Browser, type Locator, type Page } from '@playwright/test'
import {
  adminPage,
  approveStudent,
  cohortRow,
  expectStatus,
  firstLine,
  newPage,
  registerStudent,
  searchAccounts,
  accountRow,
  signIn,
  type NewStudent,
} from './helpers'

/**
 * 149 案補驗（acc149-x3／x4／rerun）共用的小工具。第三站 spec 裡同樣的做法抽到這裡；
 * 帳密規則同 helpers.ts：只在記憶體裡用，不印、不寫檔、不放進名稱或截圖。
 */

export const DAY = 86_400_000

/** 臺灣時間的 ISO 字串（沒有時區尾巴）。 */
export function taipeiIso(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString()
}

/** 相對「真實的今天」的臺灣日期 `YYYY-MM-DD`。 */
export function ymd(offsetDays: number): string {
  return taipeiIso(Date.now() + offsetDays * DAY).slice(0, 10)
}

/** 臺灣時間 `MMDDHHmm`：這一輪的代號 `<T>`。 */
export function runTag(): string {
  return taipeiIso(Date.now()).slice(5, 16).replace(/[-T:]/g, '')
}

/** `datetime-local` 到秒；秒數是 0 時瀏覽器會把它省略，所以避開 0 秒。 */
export function localSecond(ms: number): string {
  const safe = new Date(ms).getUTCSeconds() === 0 ? ms + 1000 : ms
  return taipeiIso(safe).slice(0, 19)
}

/** 畫面上的 `YYYY/MM/DD HH:mm:ss`（臺灣時間）轉回毫秒。 */
export function parseTaipeiSecond(text: string): number {
  const m = /(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text)
  if (!m) throw new Error(`看不懂業務時間：${text}`)
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]! - 8, +m[5]!, +m[6]!)
}

/** 臺灣日期＋時間（`YYYY-MM-DD`、`HH:mm:ss`）轉成毫秒。 */
export function taipeiMs(date: string, time: string): number {
  return Date.parse(`${date}T${time}+08:00`)
}

// ── 業務鐘 ────────────────────────────────────────────────────────────────

/** 直接填 `datetime-local` 的字串（`YYYY-MM-DDTHH:mm:ss`）。 */
export async function setClockLocal(page: Page, local: string, reason: string) {
  await page.goto('/dashboard/admin/clock')
  await page.getByLabel('業務時間（臺灣時間，到秒）').fill(local)
  await page.getByLabel('原因').fill(reason)
  await page.getByRole('button', { name: '設定業務時間' }).click()
  await expectStatus(page, '已設定業務時間')
}

export async function setClock(page: Page, ms: number, reason: string) {
  await setClockLocal(page, localSecond(ms), reason)
}

/** 目前業務鐘：null＝沒有模擬；否則「業務時間 − 真實時間」的毫秒偏移。 */
export async function readClockOffset(page: Page): Promise<number | null> {
  const response = await page.goto('/dashboard/admin/clock')
  expect(response?.status(), '測試站應該有模擬業務鐘頁').toBe(200)
  const business = parseTaipeiSecond(await page.getByLabel('目前業務時間').innerText())
  const simulated = await page.getByText('模擬中：').count()
  return simulated > 0 ? business - Date.now() : null
}

export async function stageText(page: Page, path: string) {
  await page.goto(path)
  return page.getByRole('region', { name: '現在階段' }).getByTestId('stage-text')
}

// ── 通知匣 ────────────────────────────────────────────────────────────────

/** 等背景工作把通知投影進來（每 30 秒一次）：重新整理，最多等 2 分鐘。 */
export async function waitForInbox(page: Page, path: string, text: string, timeout = 120_000) {
  await expect
    .poll(
      async () => {
        await page.goto(path)
        return page.getByTestId('inbox-item').filter({ hasText: text }).count()
      },
      { timeout, intervals: [3_000, 5_000] },
    )
    .toBeGreaterThan(0)
}

export async function inboxCount(page: Page, path: string, text: string): Promise<number> {
  await page.goto(path)
  return page.getByTestId('inbox-item').filter({ hasText: text }).count()
}

// ── 屆別與分組 ────────────────────────────────────────────────────────────

export type CohortSetup = {
  code: string
  name: string
  /** 四個階段開始日（相對今天的天數）。 */
  stageOffsets?: [number, number, number, number]
  groupMin: number
  groupMax: number
  proposalDays: number
}

/** 建屆別、設兩個旗標（呼叫前先用 readFlags 記下原本的旗標，收尾要還）。不排階段、不轉進行中。 */
export async function createCohortWithFlags(admin: Page, code: string, name: string) {
  await admin.goto('/dashboard/admin/cohorts')
  await admin.getByLabel('代碼').fill(code)
  await admin.getByLabel('名稱').fill(name)
  await admin.getByRole('button', { name: '新增屆別' }).click()
  await expectStatus(admin, `已新增屆別 ${code}`)
  await admin.reload()
  await admin.getByRole('button', { name: `把 ${code} 設為開放註冊屆別` }).click()
  await expectStatus(admin, `已把 ${code} 設為開放註冊屆別`)
  await admin.getByRole('button', { name: `把 ${code} 設為預設工作屆別` }).click()
  await expectStatus(admin, `已把 ${code} 設為預設工作屆別`)
}

/** 時間軸填四階段（預設 −10／+30／+90／+150 天）與年度結束日 +300 天。 */
export async function fillStages(admin: Page, code: string, offsets: [number, number, number, number] = [-10, 30, 90, 150]) {
  await admin.goto('/dashboard/admin/timeline')
  await expect(admin.getByRole('region', { name: '時間軸' })).toContainText(code)
  await admin.getByRole('button', { name: '編輯階段與日期', exact: true }).click()
  const dialog = admin.getByRole('dialog', { name: `編輯 ${code} 的階段與日期` })
  for (const [i, name] of ['成組期', '期中', '期末', '成果'].entries()) {
    await dialog.getByLabel(`第 ${i + 1} 階段名稱`).fill(name)
    await dialog.getByLabel(`第 ${i + 1} 階段開始日`).fill(ymd(offsets[i]!))
  }
  await dialog.getByLabel('年度結束日').fill(ymd(300))
  await dialog.getByRole('button', { name: '儲存' }).click()
  return dialog
}

export async function activateCohort(admin: Page, code: string) {
  await admin.goto('/dashboard/admin/cohorts')
  await admin.getByRole('button', { name: `把 ${code} 轉為進行中` }).click()
  await expectStatus(admin, `已把 ${code} 轉為進行中`)
  await expect(cohortRow(admin, code)).toContainText('進行中')
}

/** 分組總覽的屆別編號（屆別選單連結上的 `?cohort=`）。 */
export async function cohortIdOf(admin: Page, code: string): Promise<string> {
  await admin.goto('/dashboard/admin/groups')
  const link = admin.getByRole('navigation', { name: '選擇屆別' }).getByRole('link', { name: code, exact: true })
  const id = new URL((await link.getAttribute('href'))!, 'https://x').searchParams.get('cohort') ?? ''
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  return id
}

export async function openAdminGroups(admin: Page, cohortId: string) {
  await admin.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  await expect(admin.getByRole('heading', { name: '分組總覽', exact: true })).toBeVisible()
}

export async function saveGroupingSettings(admin: Page, cohortId: string, code: string, min: number, max: number, days: number) {
  await openAdminGroups(admin, cohortId)
  await admin.getByRole('button', { name: '分組設定' }).click()
  const dialog = admin.getByRole('dialog', { name: `${code} 的分組設定` })
  await dialog.getByLabel('每組最多人數').fill(String(max))
  await dialog.getByLabel('每組最少人數').fill(String(min))
  await dialog.getByLabel('提案預設天數').fill(String(days))
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expectStatus(admin, `已儲存 ${code} 的分組設定`)
}

export function groupRow(admin: Page, group: string) {
  return admin.getByRole('region', { name: '全部組別' }).getByRole('row').filter({ hasText: group })
}

/** 下拉選單裡含某段文字的那一個選項（選項文字可能帶 email，不寫死格式）。 */
export async function selectOptionContaining(select: Locator, text: string) {
  const value = await select.locator('option', { hasText: text }).first().getAttribute('value')
  expect(value, `選單裡找不到「${text}」`).toBeTruthy()
  await select.selectOption(value!)
}

export async function assignAdvisor(admin: Page, cohortId: string, group: string, teacherName: string, reason: string) {
  await openAdminGroups(admin, cohortId)
  await groupRow(admin, group).getByRole('button', { name: `指派指導老師：${group}` }).click()
  const dialog = admin.getByRole('dialog', { name: `指派 ${group} 的指導老師` })
  await selectOptionContaining(dialog.getByLabel('指導老師'), teacherName)
  await dialog.getByLabel('理由（必填）').fill(reason)
  await dialog.getByRole('button', { name: '確認指派' }).click()
  await expect(groupRow(admin, group).getByRole('status')).toContainText(`已指派 ${teacherName} 老師指導 ${group}`)
}

// ── 學生 ──────────────────────────────────────────────────────────────────

export type Student = NewStudent & { page: Page }

/** 匯入名單 CSV（全部有效），按「匯入 N 筆」。 */
export async function importRoster(admin: Page, code: string, students: NewStudent[]) {
  const csv = ['student_no,name,cohort,email,department_class', ...students.map((s) => `${s.studentNo},${s.name},${code},${s.email},${s.dept}`), ''].join('\n')
  await admin.goto('/dashboard/admin/accounts')
  await admin.getByRole('button', { name: '匯入名單 CSV' }).click()
  await admin.getByLabel('選擇名單 CSV 檔').setInputFiles({ name: `roster-${code}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') })
  await expect(admin.getByTestId('roster-count-有效')).toHaveText(String(students.length))
  await admin.getByRole('button', { name: `匯入 ${students.length} 筆` }).click()
  await expect(admin.getByText('已匯入', { exact: true })).toBeVisible()
  await admin.getByRole('button', { name: '關閉' }).click()
}

/** 註冊、核准、重新登入；每一位一加進 `registered` 就代表收尾要處理他。 */
export async function onboardStudents(
  browser: Browser,
  admin: Page,
  cohortName: string,
  list: NewStudent[],
  registered: Set<string>,
): Promise<Student[]> {
  const out: Student[] = []
  for (const s of list) {
    const page = await newPage(browser)
    registered.add(s.name)
    await registerStudent(page, s)
    out.push({ ...s, page })
  }
  for (const s of out) await approveStudent(admin, s.name, cohortName)
  for (const s of out) {
    await s.page.context().clearCookies()
    await signIn(s.page, s.email, s.password)
    await expect(s.page).toHaveURL(/\/dashboard\/student$/)
  }
  return out
}

export async function openMyGroup(page: Page) {
  await page.goto('/dashboard/student/groups')
  await expect(page.getByRole('heading', { name: '我的組別', exact: true })).toBeVisible()
}

/** 學生發起一般專題提案（同學學號依序填）。 */
export async function propose(page: Page, kind: '一般專題' | '產學合作', studentNos: string[]) {
  await openMyGroup(page)
  await page.getByRole('radio', { name: kind }).check()
  for (const [i, no] of studentNos.entries()) await page.getByLabel(new RegExp(`^同學 ${i + 1} 的學號`)).fill(no)
  await page.getByRole('button', { name: '發起提案' }).click()
  await expect(page.getByRole('region', { name: '我的組別狀態' })).toContainText('已確認')
}

/** 依序確認；最後一位確認時成組，回傳組別代碼。 */
export async function confirmAll(pages: Page[]): Promise<string> {
  let code = ''
  for (const [i, page] of pages.entries()) {
    await openMyGroup(page)
    await page.getByRole('button', { name: '確認加入' }).click()
    if (i === pages.length - 1) {
      const done = page.getByRole('main').getByRole('status').filter({ hasText: '成立了' })
      await expect(done).toBeVisible()
      code = /組別 (\S+) 成立了/.exec(await done.innerText())?.[1] ?? ''
    } else {
      await expect(page.getByRole('main').getByRole('status').filter({ hasText: '已確認' })).toBeVisible()
    }
  }
  expect(code, '拿不到組別代碼').not.toBe('')
  return code
}

// ── 專題事務 ──────────────────────────────────────────────────────────────

/** 完整編輯器：存草稿後網址換成 `/dashboard/admin/editor/<id>`，回傳 id。 */
export async function saveDraft(page: Page): Promise<string> {
  await page.getByRole('button', { name: '存草稿' }).click()
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: '已存成草稿' })).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard\/admin\/editor\/[0-9a-f-]{36}$/)
  return new URL(page.url()).pathname.split('/').pop()!
}

/** 編輯器「發布」→ 發布前檢查全過 →「確認發布」；回傳成功回饋的文字。 */
export async function publishFromEditor(page: Page): Promise<string> {
  await page.getByRole('button', { name: '發布', exact: true }).click()
  const check = page.getByRole('dialog', { name: '發布前檢查' })
  await expect(check.locator('[data-ok="no"]')).toHaveCount(0)
  await check.getByRole('button', { name: '確認發布' }).click()
  await expect(check.getByRole('status')).toContainText('收件名單')
  const text = await check.getByRole('status').innerText()
  await expect(page.getByTestId('item-status')).toHaveText('發布中')
  return text
}

export async function archiveItem(admin: Page, id: string) {
  await admin.goto(`/dashboard/admin/editor/${id}`)
  const archive = admin.getByRole('button', { name: '下架', exact: true })
  if ((await archive.count()) === 0) return
  await archive.click()
  await admin.getByRole('dialog', { name: '下架這個項目？' }).getByRole('button', { name: '確認下架' }).click()
  await expect(admin.getByTestId('item-status')).toHaveText('已下架')
}

// ── 收尾 ──────────────────────────────────────────────────────────────────

export async function closeContext(page: Page | undefined) {
  if (page && !page.isClosed()) await page.context().close().catch(() => undefined)
}

/** 收尾時管理員分頁掛了就重登一個。 */
export async function ensureAdmin(browser: Browser, admin: Page | undefined): Promise<Page | undefined> {
  if (admin && !admin.isClosed()) return admin
  try {
    return await adminPage(browser)
  } catch (error) {
    console.log(`收尾：管理員重登失敗（${firstLine(error)}）`)
    return undefined
  }
}

export type RetireOutcome = '已停用' | '已退回' | '已停用（指定接任）' | '已核發臨時密碼作廢舊密碼' | '沒收掉'

/**
 * 收尾一個帳號（只認姓名完全相同、搜尋得到的那一列）：待審就退回；已核准就停用。
 * 停用對話框要求接任組長時選第一位可接任的人；這組沒有人可接任（票 42：每組最後一位停不掉）時，
 * 改按「發臨時密碼給 <姓名>」讓舊密碼失效——**不看、不截圖那組臨時密碼**，直接關閉。
 */
export async function retire(admin: Page, name: string): Promise<RetireOutcome> {
  try {
    await admin.goto('/dashboard/admin/accounts')
    const pending = admin.locator('table:not([aria-label="帳號列表"])').getByRole('row').filter({ has: admin.getByText(name, { exact: true }) })
    if ((await pending.count()) === 1) {
      await admin.getByRole('button', { name: `審核 ${name}`, exact: true }).click()
      const dialog = admin.getByRole('dialog', { name: `審核 ${name}` })
      await dialog.getByRole('textbox', { name: /^理由/ }).fill('149 補驗收尾：自動測試建的申請，退回收掉')
      await dialog.getByRole('button', { name: '退回', exact: true }).click()
      await expect(dialog.getByRole('status')).toContainText('已退回')
      await dialog.getByRole('button', { name: '關閉' }).click()
      return '已退回'
    }
    await searchAccounts(admin, name)
    const row = accountRow(admin, name)
    if ((await row.count()) !== 1) return '沒收掉'
    const disable = row.getByRole('button', { name: `停用 ${name}`, exact: true })
    if ((await disable.count()) === 0) return (await row.innerText()).includes('已停用') ? '已停用' : '沒收掉'
    await disable.click()
    const dialog = admin.getByRole('dialog', { name: `停用 ${name}` })
    await expect(dialog).toBeVisible()
    // 等對話框問完「是不是組長」。
    await expect(dialog.getByText('正在確認他是不是組長…')).toHaveCount(0)
    await dialog.getByLabel(/理由/).fill('149 補驗收尾：停用這一輪建的測試帳號')
    const noSuccessor = dialog.getByRole('alert').filter({ hasText: '沒有其他可以接任的成員' })
    if ((await noSuccessor.count()) > 0) {
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      return await lockWithTemporaryPassword(admin, name)
    }
    let succession = false
    const successor = dialog.getByLabel(/接任 .+ 組長/)
    if ((await successor.count()) > 0) {
      const value = await successor.locator('option').nth(1).getAttribute('value')
      if (value) {
        await successor.selectOption(value)
        succession = true
      }
    }
    await dialog.getByRole('button', { name: '確認停用' }).click()
    await expect(dialog.getByRole('status')).toContainText('已停用')
    await dialog.getByRole('button', { name: '關閉' }).click()
    return succession ? '已停用（指定接任）' : '已停用'
  } catch (error) {
    console.log(`收尾：「${name}」沒收掉（${firstLine(error)}）`)
    return '沒收掉'
  }
}

/** 替停不掉的最後一位組長核發臨時密碼（舊密碼、舊登入立刻失效）；新密碼不讀、不截圖，直接關閉。 */
async function lockWithTemporaryPassword(admin: Page, name: string): Promise<RetireOutcome> {
  await searchAccounts(admin, name)
  const row = accountRow(admin, name)
  await row.getByRole('button', { name: `發臨時密碼給 ${name}`, exact: true }).click()
  const dialog = admin.getByRole('dialog', { name: '發臨時密碼' })
  await dialog.getByRole('radio').first().check()
  const note = dialog.getByLabel(/核實說明/)
  if ((await note.count()) > 0) await note.fill('149 補驗收尾')
  await dialog.getByLabel(/^理由/).fill('149 補驗收尾：作廢測試密碼（最後一位組長停不掉，票 42）')
  await dialog.getByRole('button', { name: '產生一次性密碼' }).click()
  await expect(dialog.getByRole('status')).toContainText('已核發')
  await dialog.getByRole('button', { name: '關閉' }).click()
  return '已核發臨時密碼作廢舊密碼'
}

/** 依序收尾多個帳號：非組長先、組長後（呼叫端排好順序），結果印出來給報告用。 */
export async function retireAll(admin: Page, names: string[]): Promise<Record<string, RetireOutcome>> {
  const result: Record<string, RetireOutcome> = {}
  for (const name of names) {
    result[name] = await retire(admin, name)
    console.log(`收尾：${name} → ${result[name]}`)
  }
  return result
}
