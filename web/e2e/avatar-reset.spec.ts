import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * AD-B2：系辦在帳號列表「更多」重設頭像（AC-AD-B8、AC-AD-B9）。
 *
 * 對話框顯示目前頭像、理由必填（空的先擋）；重設後兩欄清空、稽核 `account.avatar_reset` 帶理由；
 * 已去識別化的列沒有「更多」，也就沒有「重設頭像」。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const SHOTS = process.env.AVATAR_RESET_SHOTS

const prefix = String(Date.now()).slice(-6)
const name = `頭像${prefix}`
const PRESET = 7

let pool: Pool
let target: TestSession

function rowOf(page: Page, text: string) {
  return page.getByRole('table', { name: '帳號列表' }).getByRole('row').filter({ has: page.getByText(text, { exact: true }) })
}

test.beforeAll(async ({ playwright }) => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能種資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const request = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
  try {
    target = await createTestSession(request, 'student')
    await pool.query(`update users set name = $2 where id = $1`, [target.userId, name])
    await pool.query(
      `insert into user_profiles (user_id, display_name, name_normalized, contact_email, avatar_preset) values ($1, $2, lower($2), $3, $4)
       on conflict (user_id) do update set display_name = $2, name_normalized = lower($2), avatar_preset = $4`,
      [target.userId, name, target.email, PRESET],
    )
  } finally {
    await request.dispose()
  }
})

test.afterAll(async () => {
  await pool?.end()
})

test('AC-AD-B8：選單一項、對話框顯示目前頭像與理由欄、空理由先擋、重設後頭像回預設並留稽核理由', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const session = await sharedTestSession(page.request, 'admin')
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])

  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(name)}`)
  await rowOf(page, name).getByRole('button', { name: `更多 ${name}` }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: `重設頭像 ${name}` })).toBeVisible()
  // 放在「危險操作」群組之前。
  const items = await menu.getByRole('menuitem').allInnerTexts()
  expect(items.indexOf('重設頭像')).toBeLessThan(items.indexOf('停用'))
  await menu.getByRole('menuitem', { name: `重設頭像 ${name}` }).click()

  const dialog = page.getByRole('dialog', { name: `重設 ${name} 的頭像` })
  await expect(dialog.locator('img')).toHaveAttribute('src', `/avatars/${String(PRESET).padStart(3, '0')}.webp`)
  await expect(dialog.locator('img')).toHaveAttribute('width', '64')
  const reason = dialog.getByLabel('理由（必填，對方看不到）')
  await expect(reason).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/avatar-reset-dialog.png` })

  // 空理由（含只有空白）先擋，不打伺服器。
  await reason.fill('   ')
  await dialog.getByRole('button', { name: '重設', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('請填理由')
  expect((await pool.query('select avatar_preset from user_profiles where user_id = $1', [target.userId])).rows[0]).toEqual({ avatar_preset: PRESET })

  // 取消不改。
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).not.toBeVisible()
  expect((await pool.query('select avatar_preset from user_profiles where user_id = $1', [target.userId])).rows[0]).toEqual({ avatar_preset: PRESET })

  await rowOf(page, name).getByRole('button', { name: `更多 ${name}` }).click()
  await page.getByRole('menuitem', { name: `重設頭像 ${name}` }).click()
  await dialog.getByLabel('理由（必填，對方看不到）').fill('  不當圖片  ')
  await dialog.getByRole('button', { name: '重設', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('已重設頭像')

  // AC-AD-B9：稽核帶理由（去頭尾空白）、操作者；兩欄清空。
  const audit = await pool.query(
    `select actor_user_id, reason, payload from audit_events where action = 'account.avatar_reset' and target_id = $1`,
    [target.userId],
  )
  expect(audit.rows).toHaveLength(1)
  expect(audit.rows[0]).toMatchObject({ actor_user_id: session.userId, reason: '不當圖片', payload: { reason: '不當圖片', avatarPreset: PRESET } })
  if (SHOTS) console.log('audit_events row:', JSON.stringify(audit.rows[0]))
  expect((await pool.query('select avatar_preset, avatar_file_id from user_profiles where user_id = $1', [target.userId])).rows[0]).toEqual({
    avatar_preset: null,
    avatar_file_id: null,
  })

  await dialog.getByRole('button', { name: '關閉' }).click()
  await context.close()
})

test('AC-AD-B9：已去識別化的列沒有「更多」，也就沒有「重設頭像」', async ({ browser }) => {
  // 已去識別化：直接改資料（流程本身由 deidentify.spec 測）。
  await pool.query(`update users set deidentified_at = now(), status = 'disabled' where id = $1`, [target.userId])
  const context = await browser.newContext()
  const page = await context.newPage()
  const session = await sharedTestSession(page.request, 'admin')
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto(`/dashboard/admin/accounts?status=deidentified&q=${encodeURIComponent('已刪除個資')}`)
  const rows = page.getByRole('table', { name: '帳號列表' }).getByRole('row')
  await expect(rows.nth(1)).toBeVisible()
  await expect(page.getByRole('button', { name: /^更多 已刪除個資/ })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: /重設頭像/ })).toHaveCount(0)
  await context.close()
})
