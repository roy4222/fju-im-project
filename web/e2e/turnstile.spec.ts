import { expect, test } from '@playwright/test'

/**
 * VB-7 Turnstile（AC-VI-67；AC-VI-66 的 CSP 段）。
 *
 * CI 與本機 e2e 不設 `TURNSTILE_SITE_KEY`／`TURNSTILE_SECRET_KEY`，功能是關的：
 * 會寄信的表單頁不能出現 widget、也不能去載 `api.js`。CSP 一字不改——`frame-src`、`connect-src`
 * 本來就放 `https://challenges.cloudflare.com`，`api.js` 靠 nonce＋`strict-dynamic` 放行。
 *
 * widget 掛進表單是 VB-3（註冊、重寄）與 VB-4（忘記密碼）；有金鑰時「widget 出現、表單送得出去」
 * 那兩條由那兩張票在掛載後補。
 */

const FORM_PAGES = ['/register', '/forgot-password', '/login']

for (const path of FORM_PAGES) {
  test(`沒設金鑰：${path} 沒有 widget、沒有載 api.js、沒有 CSP 錯誤`, async ({ page }) => {
    const cloudflareRequests: string[] = []
    const cspErrors: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('challenges.cloudflare.com')) cloudflareRequests.push(request.url())
    })
    page.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) cspErrors.push(message.text())
    })

    const response = await page.goto(path)
    expect(response?.status()).toBe(200)
    await page.waitForLoadState('networkidle')

    const html = await response!.text()
    expect(html).not.toContain('challenges.cloudflare.com/turnstile')
    await expect(page.locator('[data-turnstile-action]')).toHaveCount(0)
    await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveCount(0)
    expect(cloudflareRequests).toEqual([])
    expect(cspErrors).toEqual([])
  })
}

test('CSP 逐字不變：script-src 只靠 nonce＋strict-dynamic，Turnstile 只在 frame-src／connect-src', async ({ page }) => {
  const response = await page.goto('/register')
  const csp = response!.headers()['content-security-policy'] ?? ''
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'(;|$)/)
  expect(csp).toContain('frame-src https://www.youtube.com https://challenges.cloudflare.com;')
  expect(csp).toContain("connect-src 'self' https://challenges.cloudflare.com;")
})
