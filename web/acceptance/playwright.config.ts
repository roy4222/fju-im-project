import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * 站驗收：對**已部署的測試站**跑真實流程（不進 CI；CI 跑的是 `web/playwright.config.ts` 的 `e2e/`）。
 *
 *   doppler run -p fju-im-capstone -c stg --only-secrets E2E_ADMIN_EMAIL,E2E_ADMIN_PASSWORD -- pnpm -C web acceptance
 *
 * 只准打測試站：`ACCEPTANCE_BASE_URL` 沒設就用測試站；設了別的網域（包括正式站 fju.roy422.dev）直接失敗，
 * 連一個請求都不會送出。
 *
 * 帳密只從環境變數讀（見 helpers.ts）。為了讓密碼不落地：
 *   - 不開 trace、不錄影（trace 會把 fill 的值存下來）；
 *   - 報告只用 list（HTML 報告的步驟標題會帶 fill 的值）；
 *   - 截圖只有 spec 自己拍的 `.out/<這次>/`，密碼欄在畫面上是圓點；跑完 global-teardown 再掃一遍 `.out/`。
 */

const TEST_SITE = 'https://test.fju.roy422.dev'

function resolveBaseUrl(): string {
  const raw = process.env.ACCEPTANCE_BASE_URL?.trim() || TEST_SITE
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`ACCEPTANCE_BASE_URL 不是合法網址：${raw}`)
  }
  if (url.origin !== TEST_SITE) {
    throw new Error(`站驗收只准打測試站 ${TEST_SITE}；收到 ${url.origin}，拒絕執行（正式站與其他網域一律不打）。`)
  }
  return TEST_SITE
}

const baseURL = resolveBaseUrl()

// 這次跑的輸出資料夾名稱：runner 先定好，worker 從環境變數繼承同一個值。
process.env.ACCEPTANCE_RUN_ID ??= new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')

export default defineConfig({
  testDir: '.',
  testMatch: ['station-*.spec.ts', 'acc149-*.spec.ts'],
  // 真實流程一步接一步，而且註冊有限速（每 IP 每小時 30 次）：不平行、不重試。
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  outputDir: path.join(import.meta.dirname, '.out', 'artifacts'),
  globalTeardown: path.join(import.meta.dirname, 'global-teardown.ts'),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
