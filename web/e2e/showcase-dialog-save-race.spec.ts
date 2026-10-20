import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const stamp = `SC1-R2-${Date.now().toString(36)}`
const title = `${stamp} 作品`
const CONFLICT = '這份草稿剛剛已經被別人更新了，請重新載入頁面看最新內容再改。'
let pool: Pool
let cohortId: string
let entryId: string

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
  entryId = String((await pool.query(
    `insert into showcase_entries (id, cohort_id, status, created_by_user_id)
     values (gen_random_uuid(), $1, 'draft', $2) returning id`,
    [cohortId, admin],
  )).rows[0]!.id)
  await pool.query(
    `insert into showcase_drafts (entry_id, title, summary, summary_checksum)
     values ($1, $2, '', encode(sha256(convert_to('', 'UTF8')), 'hex'))`,
    [entryId, title],
  )
})

test.afterAll(async () => { await pool?.end() })

function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  return { wait, release }
}

async function visit(page: Page) {
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
  await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
}

async function edit(page: Page) {
  await page.getByTestId('entry-row').filter({ hasText: title }).getByRole('button', { name: /^編輯：/ }).click()
  const dialog = page.getByTestId('showcase-edit-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

for (const outcome of ['尚未送出', '版本衝突', '儲存成功'] as const) {
  test(`FIX-SC1 R2：舊榮譽載入回應不能取代作品編輯（${outcome}）`, async ({ page }) => {
    const honor = gate()
    const save = gate()
    let honorHeld = false
    let saveHeld = false
    let posts = 0
    // 榮譽開窗先等 frontEditContextAction 的 Flight 回應，再下載表單 chunk。
    // 卡住這段載入回應，才能在榮譽 modal 出現前點到另一個入口。
    await page.route('**/dashboard/admin/showcase*', async (route) => {
      if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue()
      posts += 1
      if (posts === 1) {
        const response = await route.fetch()
        honorHeld = true
        await honor.wait
        await route.fulfill({ response })
      } else {
        saveHeld = true
        await save.wait
        await route.continue()
      }
    })
    try {
      await visit(page)
      await page.getByRole('button', { name: '新增', exact: true }).click()
      await page.getByRole('menuitem', { name: /^榮譽/ }).click()
      await expect.poll(() => honorHeld).toBe(true)
      const dialog = await edit(page)
      if (outcome !== '尚未送出') {
        await dialog.getByRole('textbox', { name: '摘要', exact: true }).fill(`${stamp} ${outcome}`)
        if (outcome === '版本衝突') {
          await pool.query('update showcase_drafts set revision = revision + 1 where entry_id = $1', [entryId])
        }
        await dialog.getByRole('button', { name: '儲存', exact: true }).click()
        await expect(dialog.getByRole('button', { name: '儲存中…', exact: true })).toBeDisabled()
      }
      honor.release()
      // Next 會依序派送 Server Actions；儲存 POST 要在舊回應放行後才出現。
      if (outcome !== '尚未送出') await expect.poll(() => saveHeld).toBe(true)
      else await expect(page.getByRole('button', { name: '新增', exact: true })).toBeEnabled()
      await expect(dialog).toBeVisible()
      await expect(page.locator('dialog[open]')).toHaveCount(1)
      save.release()
      if (outcome === '版本衝突') {
        await expect(dialog.getByRole('alert')).toHaveText(CONFLICT)
        await expect(dialog.getByRole('textbox', { name: '摘要', exact: true })).toHaveValue(`${stamp} ${outcome}`)
        await expect(page.locator('dialog[open]')).toHaveCount(1)
      } else if (outcome === '儲存成功') {
        await expect(page.getByTestId('showcase-toast')).toContainText('已儲存')
        await expect(page.locator('dialog[open]')).toHaveCount(0)
      }
    } finally {
      honor.release()
      save.release()
      await page.unrouteAll({ behavior: 'wait' })
    }
  })
}

test('FIX-SC1 R2：送出期間忽略新的開窗請求，衝突仍留在原視窗', async ({ page }) => {
  const save = gate()
  let held = false
  await page.route('**/dashboard/admin/showcase*', async (route) => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue()
    held = true
    await save.wait
    await route.continue()
  })
  try {
    await visit(page)
    const dialog = await edit(page)
    await dialog.getByRole('textbox', { name: '摘要', exact: true }).fill(`${stamp} 新請求`)
    await pool.query('update showcase_drafts set revision = revision + 1 where entry_id = $1', [entryId])
    await dialog.getByRole('button', { name: '儲存', exact: true }).click()
    await expect.poll(() => held).toBe(true)
    // 原生 modal 會擋滑鼠；直接送出入口事件，獨立驗證 owner 的送出鎖，
    // 避免只靠「舊請求序號失效」就誤判已保護所有新請求。
    await page.getByTestId('entry-row').filter({ hasText: title }).getByRole('button', { name: /^刪除：/ }).dispatchEvent('click')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    save.release()
    await expect(dialog.getByRole('alert')).toHaveText(CONFLICT)
    await expect(page.locator('dialog[open]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await edit(page)
  } finally {
    save.release()
    await page.unrouteAll({ behavior: 'wait' })
  }
})
