import { expect, request as playwrightRequest, test, type Page, type Route } from '@playwright/test'
import { Pool } from 'pg'
import { fillItemForm, formReady } from './create-item'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * CL-4（#820）：成果展示
 *
 * 1. 榮譽榜區的表單與刪除確認按下才下載：下載途中連點同列、不同列，放行後只開一個視窗；Esc 關掉焦點回觸發鈕。
 * 2. 作品「編輯」、「新增 › 補登歷屆作品」按 Esc 關窗，焦點回觸發鈕（選單項目已收起 → 回「新增」）。
 * 3. 榮譽刪除送出中按 Esc 關窗：結果回來後右下角提示看得到（提示不隨被刪的列卸載），焦點回「新增」。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const stamp = `CL4-${Date.now().toString(36)}`
const ENTRY = `${stamp} 作品`
const HONORS = [`${stamp} 榮譽甲`, `${stamp} 榮譽乙`, `${stamp} 榮譽丙`]
/** 只出現在 `honor-dialogs.tsx` 那個延遲 chunk 的字串。 */
const HONOR_CHUNK_MARK = '榮譽視窗的 Server Function 還沒登錄'

test.describe.configure({ mode: 'serial' })

let pool: Pool
let cohortId: string

test.beforeAll(async () => {
  if (!process.env.DATABASE_URL_OWNER) throw new Error('e2e 需要 DATABASE_URL_OWNER')
  pool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 })
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = (await sharedTestSession(context, 'admin')).userId
  await context.dispose()
  cohortId = String((await pool.query(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2099-06-30', 'system') returning id`,
    [stamp],
  )).rows[0]!.id)
  const entryId = String((await pool.query(
    `insert into showcase_entries (id, cohort_id, status, created_by_user_id)
     values (gen_random_uuid(), $1, 'draft', $2) returning id`,
    [cohortId, admin],
  )).rows[0]!.id)
  await pool.query(
    `insert into showcase_drafts (entry_id, title, summary, summary_checksum)
     values ($1, $2, '', encode(sha256(convert_to('', 'UTF8')), 'hex'))`,
    [entryId, ENTRY],
  )
})

test.afterAll(async () => { await pool?.end() })

async function asAdmin(page: Page) {
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
}

const PAGE = () => `/dashboard/admin/showcase?cohort=${cohortId}&honor=${cohortId}`
const honorRow = (page: Page, title: string) => page.getByTestId('honor-row').filter({ hasText: title })
const openDialog = (page: Page) => page.locator('dialog[open]')

/** 卡住含 `mark` 的 chunk，直到呼叫 `release`。 */
async function holdChunk(page: Page, mark: string) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held = 0
  await page.route('**/_next/static/chunks/*.js', async (route) => {
    const response = await route.fetch()
    const body = await response.text()
    if (body.includes(mark)) {
      held += 1
      await gate
    }
    await route.fulfill({ response, body })
  })
  return { release, held: () => held }
}

test('準備：「新增 › 榮譽」建三則草稿（表單按下才下載，存完提示在右下角）', async ({ page }) => {
  await asAdmin(page)
  for (const title of HONORS) {
    await page.goto(PAGE())
    await page.getByRole('button', { name: '新增', exact: true }).click()
    await page.getByRole('menuitem', { name: /^榮譽/ }).click()
    const dialog = page.getByRole('dialog', { name: '新增榮譽' })
    const form = await formReady(dialog)
    await fillItemForm(page, form, { title, body: '得獎紀錄。', awardedOn: '2026-09-30' })
    await form.getByRole('button', { name: '儲存（先不發布）' }).click()
    await expect(page.getByTestId('showcase-toast')).toHaveText('已儲存')
    await expect(honorRow(page, title)).toContainText('草稿')
  }
})

type Click = { kind: '編輯' | '刪除'; row: number }
const races: { name: string; first: Click; second: Click; shown: Click }[] = [
  // 表單一開（下載中也算）就不替換：保留它自己的狀態。
  { name: '編輯後點別列刪除', first: { kind: '編輯', row: 0 }, second: { kind: '刪除', row: 1 }, shown: { kind: '編輯', row: 0 } },
  { name: '刪除後點別列編輯', first: { kind: '刪除', row: 0 }, second: { kind: '編輯', row: 1 }, shown: { kind: '編輯', row: 1 } },
  { name: '刪除後點別列刪除', first: { kind: '刪除', row: 0 }, second: { kind: '刪除', row: 1 }, shown: { kind: '刪除', row: 1 } },
  { name: '同列編輯連點兩次', first: { kind: '編輯', row: 0 }, second: { kind: '編輯', row: 0 }, shown: { kind: '編輯', row: 0 } },
]

for (const race of races) {
  test(`榮譽視窗下載中${race.name}：放行後只開一個視窗，Esc 後焦點回觸發鈕`, async ({ page }) => {
    await asAdmin(page)
    const chunk = await holdChunk(page, HONOR_CHUNK_MARK)
    const button = (click: Click) => honorRow(page, HONORS[click.row]!).getByRole('button', { name: `${click.kind}：${HONORS[click.row]}` })
    try {
      await page.goto(PAGE())
      await button(race.first).click()
      await expect.poll(chunk.held, { timeout: 10_000, message: '榮譽視窗的 chunk 沒有開始下載' }).toBeGreaterThan(0)
      await button(race.second).click()
      chunk.release()
      const dialog = openDialog(page)
      await expect(dialog).toHaveCount(1)
      const title = HONORS[race.shown.row]!
      if (race.shown.kind === '編輯') {
        await expect(dialog).toHaveAttribute('aria-label', `編輯：${title}`)
        await expect((await formReady(dialog)).getByLabel('標題', { exact: true })).toHaveValue(title)
      } else {
        await expect(dialog).toHaveAttribute('aria-label', `刪除「${title}」`)
      }
      // 再等一下（第二次點擊若晚到會在這時冒出第二個視窗）。
      await page.waitForLoadState('networkidle')
      await expect(openDialog(page)).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(openDialog(page)).toHaveCount(0)
      await expect(button(race.shown)).toBeFocused()
    } finally {
      chunk.release()
      await page.unrouteAll({ behavior: 'wait' })
    }
  })
}

test('榮譽列「編輯」讀資料期間寫「載入中…」並停用', async ({ page }) => {
  await asAdmin(page)
  await page.goto(PAGE())
  const title = HONORS[1]!
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held = 0
  await page.route(
    (url) => url.pathname === '/dashboard/admin/showcase',
    async (route: Route) => {
      if (route.request().method() === 'POST' && route.request().headers()['next-action']) {
        held += 1
        await gate
      }
      await route.continue()
    },
  )
  try {
    await honorRow(page, title).getByRole('button', { name: `編輯：${title}` }).click()
    await expect.poll(() => held, { timeout: 10_000, message: '讀資料的請求沒有送出' }).toBeGreaterThan(0)
    const button = honorRow(page, title).getByRole('button', { name: `編輯：${title}` })
    await expect(button).toHaveText('載入中…')
    await expect(button).toBeDisabled()
    release()
    await expect(page.getByRole('dialog', { name: `編輯：${title}` })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(button).toHaveText('編輯')
    await expect(button).toBeEnabled()
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
  }
})

test('作品「編輯」與「新增 › 補登歷屆作品」：Esc 關窗後焦點回觸發鈕', async ({ page }) => {
  await asAdmin(page)
  await page.goto(PAGE())
  const edit = page.getByTestId('entry-row').filter({ hasText: ENTRY }).getByRole('button', { name: `編輯：${ENTRY}` })
  await edit.click()
  await expect(openDialog(page)).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(openDialog(page)).toHaveCount(0)
  await expect(edit).toBeFocused()

  const create = page.getByRole('button', { name: '新增', exact: true })
  await create.click()
  await page.getByRole('menuitem', { name: /^補登歷屆作品/ }).click()
  await expect(openDialog(page)).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(openDialog(page)).toHaveCount(0)
  await expect(create).toBeFocused()
})

test('榮譽刪除送出中按 Esc 關窗：結果回來後右下角提示看得到、那一列消失、焦點回「新增」', async ({ page }) => {
  await asAdmin(page)
  await page.goto(PAGE())
  const title = HONORS[2]!
  await honorRow(page, title).getByRole('button', { name: `刪除：${title}` }).click()
  const confirm = page.getByRole('dialog', { name: `刪除「${title}」` })
  await expect(confirm).toBeVisible()

  // 卡住 Server Action（先讀版本、再刪除）：送出中先關窗。
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held = 0
  await page.route(
    (url) => url.pathname === '/dashboard/admin/showcase',
    async (route: Route) => {
      if (route.request().method() === 'POST' && route.request().headers()['next-action']) {
        held += 1
        await gate
      }
      await route.continue()
    },
  )
  try {
    await confirm.getByRole('button', { name: '刪除', exact: true }).click()
    await expect.poll(() => held, { timeout: 10_000, message: '刪除請求沒有送出' }).toBeGreaterThan(0)
    await expect(confirm.getByRole('button', { name: '刪除中…' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(openDialog(page)).toHaveCount(0)
    release()
    // 先等那一列消失（列內的東西都卸載了），提示還要在。
    await expect(honorRow(page, title)).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: `「${title}」已刪除` })).toBeVisible()
    await expect(page.getByRole('button', { name: '新增', exact: true })).toBeFocused()
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
  }
  const left = await pool.query('select 1 from managed_items where title = $1 and deleted_at is null', [title])
  expect(left.rowCount).toBe(0)
})
