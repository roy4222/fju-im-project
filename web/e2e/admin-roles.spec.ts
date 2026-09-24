import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 10b：帳號列表每一列的「設為管理員／取消管理員」與孤兒帳號，用**真的畫面**走一次。
 *
 * 1. 老師 → 設為管理員（理由必填）→ 業務角色與套件的 `users.role` 一起變；再取消回來。
 * 2. 自己那一列沒有「取消管理員」。
 * 3. 孤兒帳號（只有登入身分）：磚與篩選看得到；補建成老師；另一個直接停用。
 *
 * 最後一位管理員保護（兩位管理員同時互相取消／停用）要控制並行，放在整合測試
 * `role-assignment.integration.test.ts`、`account-directory-command.integration.test.ts`。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const tag = `角色${String(Date.now()).slice(-6)}`

/**
 * 造帳號用的獨立 request context（帶 Origin）：瀏覽器分頁的 request 帶著管理員的 session cookie，
 * Better Auth 對「帶 cookie 又沒有 Origin」的請求一律拒絕（CSRF 檢查）。
 */
let seeder: APIRequestContext

test.beforeAll(async ({ playwright }) => {
  seeder = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
})

test.afterAll(async () => {
  await seeder?.dispose()
})

async function adminPage(browser: Browser): Promise<{ page: Page; admin: TestSession }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const admin = await sharedTestSession(page.request, 'admin')
  await context.addCookies([toPlaywrightCookie(admin.cookie, BASE_URL)])
  return { page, admin }
}

async function db<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER')
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    return await fn(pool)
  } finally {
    await pool.end()
  }
}

/** 造一個帳號並把顯示名稱改成這一輪專用的名字（列表用名字找列）。 */
async function seeded(role: 'teacher' | null, name: string): Promise<TestSession & { name: string }> {
  const session = await createTestSession(seeder, role)
  await db(async (pool) => {
    await pool.query(`update users set name = $2 where id = $1`, [session.userId, name])
    await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [session.userId, name])
  })
  return { ...session, name }
}

function rowOf(page: Page, name: string) {
  return page.getByRole('table', { name: '帳號列表' }).getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
}

const adminState = (userId: string) =>
  db(async (pool) =>
    (
      await pool.query<{ role: string | null; admins: number }>(
        `select u.role,
                (select count(*)::int from role_assignments r
                  where r.user_id = u.id and r.role = 'admin' and r.revoked_real_at is null) as admins
           from users u where u.id = $1`,
        [userId],
      )
    ).rows[0],
  )

test('老師設為管理員、再取消：業務角色與套件的 users.role 一起變，理由必填', async ({ browser }) => {
  const { page } = await adminPage(browser)
  const teacher = await seeded('teacher', `${tag}-老師`)

  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(teacher.email)}`)
  const row = rowOf(page, teacher.name)
  await expect(row).toBeVisible()
  // 還不是管理員：只有「設為管理員」，沒有「取消管理員」。
  await expect(row.getByRole('button', { name: `取消管理員 ${teacher.name}` })).toHaveCount(0)

  await row.getByRole('button', { name: `設為管理員 ${teacher.name}` }).click()
  const grant = page.getByRole('dialog', { name: `設為管理員 ${teacher.name}` })
  await expect(grant).toContainText('只給系辦與負責的老師')
  // 沒寫理由不送。
  await grant.getByRole('button', { name: '確認設為管理員' }).click()
  await expect(grant.getByRole('alert')).toHaveText('請寫理由。')
  await grant.getByLabel(/理由/).fill('e2e：新任承辦人')
  await grant.getByRole('button', { name: '確認設為管理員' }).click()
  await expect(grant.getByRole('status')).toContainText('已設為管理員')
  await grant.getByRole('button', { name: '關閉' }).click()

  expect(await adminState(teacher.userId)).toEqual({ role: 'admin', admins: 1 })
  await expect(row).toContainText('管理員')

  await row.getByRole('button', { name: `取消管理員 ${teacher.name}` }).click()
  const revoke = page.getByRole('dialog', { name: `取消管理員 ${teacher.name}` })
  await expect(revoke).toContainText('系統至少要留一位管理員')
  await revoke.getByLabel(/理由/).fill('e2e：職務調整')
  await revoke.getByRole('button', { name: '確認取消管理員' }).click()
  await expect(revoke.getByRole('status')).toContainText('已取消管理員')
  await revoke.getByRole('button', { name: '關閉' }).click()

  expect(await adminState(teacher.userId)).toEqual({ role: 'user', admins: 0 })
  await expect(row.getByRole('button', { name: `設為管理員 ${teacher.name}` })).toBeVisible()
})

test('自己那一列沒有「取消管理員」', async ({ browser }) => {
  const { page, admin } = await adminPage(browser)
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(admin.email)}`)
  const row = page.getByRole('table', { name: '帳號列表' }).locator(`tr[data-user-id="${admin.userId}"]`)
  await expect(row).toBeVisible()
  await expect(row.getByRole('button', { name: /取消管理員/ })).toHaveCount(0)
  await expect(row.getByRole('button', { name: /停用/ })).toHaveCount(0)
})

test('孤兒帳號：磚與篩選看得到；補建成老師；另一個直接停用', async ({ browser }) => {
  const { page } = await adminPage(browser)
  // 只有登入身分：註冊了、沒有申請、沒有角色、沒有個人資料。
  const orphan = await seeded(null, `${tag}-孤兒甲`)
  const another = await seeded(null, `${tag}-孤兒乙`)

  await page.goto('/dashboard/admin/accounts')
  await page.getByRole('link', { name: /^孤兒帳號/ }).click()
  await expect(page).toHaveURL(/orphan=1/)
  await expect(page.getByRole('heading', { name: /^孤兒帳號/ })).toBeVisible()
  await expect(rowOf(page, orphan.name)).toBeVisible()
  await expect(rowOf(page, orphan.name).getByTestId('orphan-badge')).toHaveText('孤兒帳號')

  // 補建成老師。
  await rowOf(page, orphan.name).getByRole('button', { name: `補建角色 ${orphan.name}` }).click()
  const repair = page.getByRole('dialog', { name: `補建角色 ${orphan.name}` })
  await repair.getByLabel(/理由/).fill('e2e：新增老師時系統出錯')
  await repair.getByRole('button', { name: '確認補建' }).click()
  await expect(repair.getByRole('alert')).toHaveText('請選擇要補建的角色。')
  await repair.getByRole('radio', { name: /老師/ }).check()
  await repair.getByRole('button', { name: '確認補建' }).click()
  await expect(repair.getByRole('status')).toContainText('已補建為老師')
  await repair.getByRole('button', { name: '關閉' }).click()
  await expect(rowOf(page, orphan.name)).toHaveCount(0)

  const repaired = await db(async (pool) =>
    (
      await pool.query<{ status: string; roles: string[] }>(
        `select u.status, array(select r.role from role_assignments r where r.user_id = u.id and r.revoked_real_at is null) as roles
           from users u where u.id = $1`,
        [orphan.userId],
      )
    ).rows[0],
  )
  expect(repaired).toEqual({ status: 'active', roles: ['teacher'] })

  // 另一個孤兒：待審也能直接停用（沒有申請可以退回）。
  await rowOf(page, another.name).getByRole('button', { name: `停用 ${another.name}` }).click()
  const disable = page.getByRole('dialog', { name: `停用 ${another.name}` })
  await disable.getByLabel(/理由/).fill('e2e：不明帳號')
  await disable.getByRole('button', { name: '確認停用' }).click()
  await expect(disable.getByRole('status')).toContainText('已停用')
  await disable.getByRole('button', { name: '關閉' }).click()
  expect(await db(async (pool) => (await pool.query(`select status from users where id = $1`, [another.userId])).rows[0])).toEqual({
    status: 'disabled',
  })
})
