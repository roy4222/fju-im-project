import { expect, test } from '@playwright/test'

/**
 * S00 的煙霧測試：空殼首頁、/api/health，以及 CSP 真的在擋東西。
 */

test('首頁打得開，而且有 hydration（Next 的 script 帶著 nonce 被執行）', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('輔仁大學資訊管理學系專題管理平台')

  // hydration 正常＝React 真的跑起來了。
  await expect
    .poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-nextjs-hydrated') || !!(window as unknown as { next?: unknown }).next))
    .toBeTruthy()
  expect(errors, `頁面有未預期的錯誤：${errors.join(' / ')}`).toEqual([])
})

test('/api/health 回 200 與契約 05 §1 的欄位', async ({ request }) => {
  const response = await request.get('/api/health')
  expect(response.status()).toBe(200)
  const body = (await response.json()) as Record<string, unknown>
  expect(Object.keys(body)).toEqual(['ok', 'version', 'commit', 'imageDigest', 'schemaVersion', 'worker'])
  expect(body.ok).toBe(true)
})

test('回應帶 CSP 與其他安全標頭（契約 03 §6）', async ({ page }) => {
  const response = await page.goto('/')
  const headers = response!.headers()

  const csp = headers['content-security-policy']
  expect(csp).toBeTruthy()
  expect(csp).toContain("'strict-dynamic'")
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/)
  expect(csp).toContain("object-src 'none'")
  expect(csp).toContain("frame-ancestors 'none'")

  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  expect(headers['x-frame-options']).toBe('DENY')
})

test('nonce 每次請求都不一樣', async ({ page }) => {
  const nonceOf = async () => {
    const response = await page.goto('/')
    return /nonce-([^']+)/.exec(response!.headers()['content-security-policy'] ?? '')?.[1]
  }
  const first = await nonceOf()
  const second = await nonceOf()
  expect(first).toBeTruthy()
  expect(first).not.toBe(second)
})

/**
 * 注入必須發生在**文件本身**裡，才是真的在測 CSP：
 * `page.evaluate()` 跑在 Playwright 自己的執行環境，不受頁面 CSP 管，
 * 用它插腳本會得到假的通過。所以這裡攔截 HTML 回應，把腳本塞進 body，
 * 模擬「被存進資料庫的 XSS 跟著頁面一起送出來」。
 */
async function withInjectedMarkup(
  page: import('@playwright/test').Page,
  markup: string,
): Promise<string[]> {
  const violations: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
      violations.push(message.text())
    }
  })

  await page.route('**/', async (route) => {
    const response = await route.fetch()
    const headers = response.headers()
    if (!(headers['content-type'] ?? '').includes('text/html')) {
      await route.fulfill({ response })
      return
    }
    const body = (await response.text()).replace('</body>', `${markup}</body>`)
    await route.fulfill({ response, body, headers })
  })

  await page.goto('/')
  return violations
}

test('沒有 nonce 的 inline 腳本被 CSP 擋下，頁面照常運作', async ({ page }) => {
  const violations = await withInjectedMarkup(
    page,
    '<script>window.__injectedRan = true</script>',
  )

  const ran = await page.evaluate(() => (window as unknown as { __injectedRan?: boolean }).__injectedRan ?? false)
  expect(ran, '注入的 inline 腳本不該執行').toBe(false)
  expect(violations.length, '瀏覽器應該報 CSP 違規').toBeGreaterThan(0)

  // 頁面本身照常。
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

test('外部來源的腳本也被擋（script-src 只允許 self 與帶 nonce 者）', async ({ page }) => {
  const violations = await withInjectedMarkup(
    page,
    '<script src="https://example.com/evil.js" onerror="window.__externalBlocked = true"></script>',
  )
  expect(violations.some((v) => /example\.com/.test(v)), `違規訊息：${violations.join(' / ')}`).toBe(true)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})
