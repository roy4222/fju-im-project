import { defineConfig, devices } from '@playwright/test'

/**
 * 煙霧 E2E（契約 04 §2；CI job 名稱固定 `e2e-smoke`）。
 *
 * 預設打本機 Compose 起來的整套（經 Caddy 的 8080）；CI 會用 BASE_URL 指到自己起的服務。
 * S00 只有「首頁與 health 活著」與「CSP 真的擋得住注入腳本」兩件事；
 * 登入、發布、繳交、評分、簽核各一條由後續切片補（契約 04 §2）。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  outputDir: './e2e/.artifacts',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
