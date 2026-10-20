import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, type TestSession } from './session'

/**
 * C3-08 AC-C3-43：前台首頁「近期活動」直接編輯，開③的 `activity` 表單模組（`admin/timeline/front-edit/activity.tsx`）。
 *
 * - 模組按下「編輯」才載入（Network 多一個獨立 chunk），欄位跟系辦時程頁的活動視窗相同。
 * - 改結束日、新增（區塊沒有 `data-fe-cohort` → 落在預設工作屆別；有值 → 落在那一屆）、沒有工作屆別時顯示「還沒有工作屆別」不送出、
 *   刪除（排定中的直接刪）。首頁的區塊目前不帶 `data-fe-cohort`，「有值」那次在頁面上補屬性再開編輯模式（同 front-edit-items 補標記的做法）。
 *
 * 預設工作屆別是全站狀態：先記下原本是哪一屆，跑完還回去。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'E2e-Password-Correct-9'

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE_A = `FEA-${stamp}`
const CODE_B = `FEB-${stamp}`
const TITLE = `${stamp} 公開說明會`

const ymd = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const taipei = (date: string) => new Date(`${date}T00:00:00+08:00`)
const TODAY = ymd(new Date())

let pool: Pool
let admin: TestSession
let cohortA: string
let cohortB: string
let previousDefault: string | null = null
let activityId: string

async function newCohort(code: string) {
  const row = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
    [code, addDays(TODAY, 300)],
  )
  return row.rows[0]!.id
}

async function setDefault(id: string | null) {
  await pool.query('update cohorts set is_default_working = false where is_default_working')
  if (id) await pool.query('update cohorts set is_default_working = true where id = $1', [id])
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
  // 系辦要用密碼從登入頁登入，才會帶前台編輯的提示 cookie（同 front-edit.spec）。
  admin = await createTestSession(api, 'admin')
  await api.dispose()
  previousDefault = (await pool.query<{ id: string }>('select id from cohorts where is_default_working')).rows[0]?.id ?? null
  cohortA = await newCohort(CODE_A)
  cohortB = await newCohort(CODE_B)
  await setDefault(cohortA)
  // 首頁「近期活動」只列公開、排定中、還沒結束的：昨天到今天的全天活動，排在最前面。
  activityId = (
    await pool.query<{ id: string }>(
      `insert into project_events (id, cohort_id, title, starts_at, ends_at, all_day, audience_kind, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, true, 'public', 'system') returning id`,
      [cohortA, TITLE, taipei(addDays(TODAY, -1)), taipei(addDays(TODAY, 1))],
    )
  ).rows[0]!.id
})

test.afterAll(async () => {
  await setDefault(previousDefault)
  await pool?.end()
})

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(admin.email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
}

/** 前台開編輯模式；`cohort` 有給就先在「近期活動」區塊補 `data-fe-cohort`（編輯層打開時才掃標記）。 */
async function openEditMode(page: Page, cohort?: string) {
  await page.goto('/')
  if (cohort) {
    await page.locator('section[aria-labelledby="home-activities"]').evaluate((el, id) => el.setAttribute('data-fe-cohort', id), cohort)
  }
  await page.getByRole('button', { name: '編輯頁面' }).click()
  const layer = page.getByTestId('front-edit-layer')
  await expect(layer).toBeAttached()
  return layer
}

/** 這個分頁下載過的 JS 裡，有沒有活動表單模組（`fe-activity-form` 是它的 testid）。 */
function watchActivityChunk(page: Page) {
  const hits: string[] = []
  page.on('response', async (response) => {
    if (!response.url().endsWith('.js')) return
    const body = await response.text().catch(() => '')
    if (body.includes('fe-activity-form')) hits.push(response.url())
  })
  return hits
}

async function eventRow(id: string) {
  const row = await pool.query<{ cohort_id: string; ends_at: Date; revision: number; deleted: boolean }>(
    'select cohort_id, ends_at, revision, deleted_at is not null as deleted from project_events where id = $1',
    [id],
  )
  return row.rows[0]!
}

test('AC-C3-43 編輯：模組按下才載入、欄位跟系辦視窗相同；改結束日存進去', async ({ page }) => {
  const chunks = watchActivityChunk(page)
  await signIn(page)
  const layer = await openEditMode(page)
  expect(chunks).toEqual([])

  await layer.getByRole('button', { name: `編輯「${TITLE}」` }).click()
  const dialog = page.getByRole('dialog', { name: '編輯活動' })
  const form = dialog.getByTestId('fe-activity-form')
  await expect(form).toBeVisible()
  await expect.poll(() => chunks.length).toBeGreaterThan(0)
  // 跟系辦時程頁的活動視窗同一份欄位（ActivityFormBody）。
  for (const label of ['活動名稱', '開始日', '結束日', '全天', '開始時間', /^結束時間/, '誰看得到', '說明（可不填）']) {
    await expect(form.getByLabel(label)).toBeVisible()
  }
  await expect(form.getByLabel('活動名稱')).toHaveValue(TITLE)
  await expect(form.getByLabel('開始日')).toHaveValue(addDays(TODAY, -1))
  await expect(form.getByLabel('結束日')).toHaveValue(TODAY)
  await expect(form.getByLabel('全天')).toBeChecked()
  await form.getByLabel('結束日').fill(addDays(TODAY, 3))
  await form.getByRole('button', { name: '儲存' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: '已儲存' })).toBeVisible()
  const row = await eventRow(activityId)
  expect(row.revision).toBe(2)
  expect(row.ends_at.toISOString()).toBe(taipei(addDays(TODAY, 4)).toISOString())
})

test('AC-C3-43 新增：區塊沒有屆別 → 預設工作屆別；有屆別 → 那一屆；沒有工作屆別 → 「還沒有工作屆別」不送出', async ({ page }) => {
  await signIn(page)

  // cohortId = null：落在預設工作屆別（A）。
  let layer = await openEditMode(page)
  await layer.getByRole('button', { name: '新增活動（近期活動）' }).click()
  let dialog = page.getByRole('dialog', { name: '新增活動' })
  let form = dialog.getByTestId('fe-activity-form')
  await expect(form).toContainText(`屆別：${CODE_A}（${CODE_A}）`)
  await expect(form.getByLabel('開始日')).toHaveValue(TODAY)
  await form.getByLabel('活動名稱').fill(`${stamp} 預設屆別的活動`)
  await form.getByRole('button', { name: '建立活動' }).click()
  await expect(dialog).toHaveCount(0)
  const inA = await pool.query('select cohort_id from project_events where title = $1', [`${stamp} 預設屆別的活動`])
  expect(inA.rows).toEqual([{ cohort_id: cohortA }])

  // cohortId 有值：落在那一屆（B）。
  layer = await openEditMode(page, cohortB)
  await layer.getByRole('button', { name: '新增活動（近期活動）' }).click()
  dialog = page.getByRole('dialog', { name: '新增活動' })
  form = dialog.getByTestId('fe-activity-form')
  await expect(form).toContainText(`屆別：${CODE_B}（${CODE_B}）`)
  await form.getByLabel('活動名稱').fill(`${stamp} 指定屆別的活動`)
  await form.getByRole('button', { name: '建立活動' }).click()
  await expect(dialog).toHaveCount(0)
  const inB = await pool.query('select cohort_id from project_events where title = $1', [`${stamp} 指定屆別的活動`])
  expect(inB.rows).toEqual([{ cohort_id: cohortB }])

  // 沒有工作屆別：表單顯示「還沒有工作屆別」，沒有送出鈕。
  await setDefault(null)
  try {
    layer = await openEditMode(page)
    await layer.getByRole('button', { name: '新增活動（近期活動）' }).click()
    dialog = page.getByRole('dialog', { name: '新增活動' })
    await expect(dialog.getByRole('alert')).toHaveText('還沒有工作屆別')
    await expect(dialog.getByRole('button', { name: '建立活動' })).toHaveCount(0)
    await dialog.getByRole('button', { name: '關閉', exact: true }).first().click()
  } finally {
    await setDefault(cohortA)
  }
})

test('AC-C3-43 刪除：排定中的直接刪，不用先取消', async ({ page }) => {
  await signIn(page)
  const layer = await openEditMode(page)
  await layer.getByRole('button', { name: `刪除「${TITLE}」` }).click()
  const confirm = page.getByRole('alertdialog', { name: '刪除' })
  await expect(confirm).toContainText(`確定刪除『${TITLE}』？`)
  await confirm.getByRole('button', { name: '確定刪除' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: '已刪除' })).toBeVisible()
  expect((await eventRow(activityId)).deleted).toBe(true)
})
