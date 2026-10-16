import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 榮譽榜說明裡的「歷屆專題」入口（Q47；AC-VI-36、37、37b）。
 *
 * 原則：依權限只顯示能用的入口。`/projects` 要已開通、進得了自己後台的人（`isMember`）才打得開，
 * 所以只有他們看得到說明裡的連結；訪客、待審、還沒改臨時密碼的人看到的是不提歷屆專題的那句。
 * 判斷跟導覽列同一個（`site-shell.tsx` 的 `isMember`），所以順便確認導覽列也是同一邊。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

// 同 pages.spec.ts：註冊有限速，同一個 worker 才共用得到 `sharedTestSession` 的帳號。
test.describe.configure({ mode: 'serial' })

const GUEST_SENTENCE = '收錄本系專題在校內外競賽的得獎紀錄與照片。'
const MEMBER_SENTENCE = '收錄本系專題在校內外競賽的得獎紀錄與照片；歷屆專題作品請看「歷屆專題」。'
const GUEST_NAV = ['最新公告', '專題規則', '優秀專題', '榮譽榜']

const description = (page: Page) => page.getByRole('main').locator('h1 + p')
const topNav = (page: Page) => page.getByRole('navigation', { name: '主導覽', exact: true }).locator(':scope > div > a')

async function signIn(page: Page, session: TestSession) {
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function expectGuestHonors(page: Page) {
  await page.goto('/honors')
  await expect(description(page)).toHaveText(GUEST_SENTENCE)
  await expect(page.getByText('歷屆專題')).toHaveCount(0)
  await expect(page.locator('a[href="/projects"]')).toHaveCount(0)
  await expect(topNav(page)).toHaveText(GUEST_NAV)
}

test('訪客：榮譽榜說明不提歷屆專題，也沒有連到 /projects 的入口（AC-VI-36）', async ({ page }) => {
  await expectGuestHonors(page)
})

test('待審核的人：有 session 也跟訪客一樣（AC-VI-37b）', async ({ page }) => {
  await signIn(page, await sharedTestSession(page.request, null))
  await expectGuestHonors(page)
})

test('臨時密碼還沒改的學生：有角色也跟訪客一樣（AC-VI-37b）', async ({ page }) => {
  const ownerUrl = process.env.DATABASE_URL_OWNER
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能把測試帳號改成必須改密')
  // 不用共用帳號：改成必須改密會影響別的測試。
  const session = await createTestSession(page.request, 'student')
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    await pool.query('update users set must_change_password = true where id = $1', [session.userId])
  } finally {
    await pool.end()
  }
  await signIn(page, session)
  await expectGuestHonors(page)
})

test('已開通的學生：說明是原句，「歷屆專題」連到 /projects，導覽列也有歷屆專題（AC-VI-37）', async ({ page }) => {
  await signIn(page, await sharedTestSession(page.request, 'student'))
  await page.goto('/honors')
  await expect(description(page)).toHaveText(MEMBER_SENTENCE)
  await expect(description(page).getByRole('link', { name: '歷屆專題', exact: true })).toHaveAttribute('href', '/projects')
  await expect(topNav(page).filter({ hasText: '歷屆專題' })).toHaveAttribute('href', '/projects')
})
