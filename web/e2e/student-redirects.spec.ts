import { expect, test, type APIResponse } from '@playwright/test'
import { FINGERPRINTS, PUBLIC_FINGERPRINTS } from './fingerprints'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 學生規格 ST-7：學生後台拿掉的三個舊網址只轉頁（AC-ST-23；轉址目標 Q126）。
 *
 * - 學生：3xx 到新位置，回應沒有舊頁面的任何內容；跟著轉過去的新頁打得開。
 * - 老師、系辦：仍導 `/403`（角色檢查在轉頁之前，不會先被轉走）。
 * - 沒登入：導登入頁。
 *
 * 接手 `pages.spec.ts` PROTECTED 學生三列刪掉後的守衛保證（那三列的「有權限的人看得到指紋」轉址後必紅）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

/**
 * 舊網址 → 學生被轉去的地方、舊頁面的指紋（轉址回應裡不該再出現），
 * 以及新位置的指紋（跟著轉過去後一定要在，證明真的到了那一頁，SH-B10）。
 */
const OLD_PAGES = [
  {
    path: '/dashboard/student/grading',
    target: '/dashboard/student',
    fingerprint: '評分由老師與系辦處理，學生不會看到分數',
    landing: FINGERPRINTS['/dashboard/student']!,
  },
  {
    path: '/dashboard/student/industry',
    target: '/industry',
    fingerprint: '產學組的組長可以在「我的組別」把組別連結到合作案',
    landing: PUBLIC_FINGERPRINTS['/industry'],
  },
  {
    path: '/dashboard/student/timeline',
    target: '/timeline',
    fingerprint: '階段與日期由系辦在時間軸設定',
    landing: PUBLIC_FINGERPRINTS['/timeline'],
  },
] as const

const REDIRECT = [302, 303, 307, 308]

function locationPath(response: APIResponse): string {
  const location = response.headers()['location']
  expect(location, '轉址要帶 location').toBeTruthy()
  return new URL(location!, BASE_URL).pathname
}

for (const { path, target, fingerprint, landing } of OLD_PAGES) {
  test(`${path}：學生被轉到 ${target}，回應沒有舊頁內容`, async ({ request, page }) => {
    const { cookie } = await sharedTestSession(request, 'student')
    const response = await request.get(path, { headers: { cookie }, maxRedirects: 0 })
    expect(REDIRECT).toContain(response.status())
    expect(locationPath(response)).toBe(target)
    const body = await response.text()
    expect(body, '回應裡不該有舊頁的內容').not.toContain(fingerprint)
    expect(body).not.toContain('分數')

    // 用瀏覽器開舊網址：跟著轉過去，新位置學生打得開。
    await page.context().addCookies([toPlaywrightCookie(cookie, BASE_URL)])
    const landed = await page.goto(path)
    expect(landed?.status()).toBe(200)
    expect(new URL(page.url()).pathname).toBe(target)
    await expect(page.locator('body'), '轉過去的頁要真的是新位置').toContainText(landing)
  })

  for (const role of ['teacher', 'admin'] as const) {
    test(`${path}：${role === 'teacher' ? '老師' : '系辦'}仍導 /403`, async ({ request }) => {
      const { cookie } = await sharedTestSession(request, role)
      const response = await request.get(path, { headers: { cookie }, maxRedirects: 0 })
      expect(REDIRECT).toContain(response.status())
      expect(locationPath(response)).toBe('/403')
      expect(await response.text()).not.toContain(fingerprint)
    })
  }

  test(`${path}：沒登入導登入頁`, async ({ request }) => {
    const response = await request.get(path, { maxRedirects: 0 })
    expect(REDIRECT).toContain(response.status())
    expect(locationPath(response)).toBe('/login')
    expect(response.headers()['location']).toContain('next=')
    expect(await response.text()).not.toContain(fingerprint)
  })
}
