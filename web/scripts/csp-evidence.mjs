#!/usr/bin/env node
/**
 * 產 S00-11 的證據：回應標頭、注入腳本被擋的 console 訊息，以及頁面照常運作的截圖。
 * 用法：node scripts/csp-evidence.mjs [baseURL] [輸出目錄]
 */
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const baseURL = process.argv[2] ?? 'http://localhost:8080'
const outDir = process.argv[3] ?? path.join(import.meta.dirname, '../../steps/S00/S00-11')
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage()
const violations = []
page.on('console', (m) => {
  if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) violations.push(m.text())
})

await page.route('**/', async (route) => {
  const response = await route.fetch()
  const headers = response.headers()
  if (!(headers['content-type'] ?? '').includes('text/html')) return route.fulfill({ response })
  const body = (await response.text()).replace(
    '</body>',
    '<script>window.__injectedRan = true; document.title = "注入成功"</script>' +
      '<script src="https://example.com/evil.js"></script></body>',
  )
  await route.fulfill({ response, body, headers })
})

const response = await page.goto(baseURL)
const headers = response.headers()
const injectedRan = await page.evaluate(() => globalThis.__injectedRan ?? false)
const heading = await page.locator('h1').textContent()

await page.screenshot({ path: path.join(outDir, 'page-after-injection.png'), fullPage: true })

fs.writeFileSync(
  path.join(outDir, 'csp-observed.json'),
  JSON.stringify(
    {
      url: baseURL,
      status: response.status(),
      contentSecurityPolicy: headers['content-security-policy'],
      otherSecurityHeaders: Object.fromEntries(
        Object.entries(headers).filter(([k]) =>
          ['x-content-type-options', 'referrer-policy', 'x-frame-options', 'permissions-policy', 'cross-origin-opener-policy'].includes(k),
        ),
      ),
      injectedInlineScriptRan: injectedRan,
      headingStillRendered: heading,
      cspViolationsInConsole: violations,
    },
    null,
    2,
  ) + '\n',
)
console.log(`注入腳本有沒有跑起來：${injectedRan}`)
console.log(`console 的 CSP 違規：${violations.length} 則`)
await browser.close()
