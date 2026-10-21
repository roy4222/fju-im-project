import { expect, type Page, type Route } from '@playwright/test'

/**
 * 「下載或請求期間的互動」測試用的閘門（CL-7；同類 3 次：C4-09、FIX-SC1、C3-13）。
 *
 * 延遲載入的視窗、選單、表單，以及送出後要等伺服器回覆的確認流程，都要測「卡在半路時使用者又點了別的」：
 * 卡住 → 期間連點同一顆與不同顆 → 放行（或中斷）→ 只剩一個結果、計時照點擊時間、焦點回觸發鈕。
 * 寫法與檢查清單見 `e2e/README.md`「延遲載入／非同步確認的互動」。
 *
 * - 每個閘門的 `release()` 可以重複呼叫；`finally` 一律 `await gate.dispose()`，失敗時也會放行並拿掉攔截。
 * - `waitHeld()` 有上限（預設 10 秒）與清楚的失敗訊息，不會等到整支測試逾時。
 */
export type Gate = {
  /** 放行目前與之後卡住的請求（`abort` 閘門是中斷）。 */
  release: () => void
  /** 已經卡住幾個請求。 */
  held: () => number
  /** 等到至少卡住 `count` 個；超過上限就以 `message` 失敗。 */
  waitHeld: (message: string, count?: number) => Promise<void>
  /** 放行並拿掉攔截（放在 `finally`）。 */
  dispose: () => Promise<void>
}

function gate(page: Page): { gate: Gate; wait: () => Promise<void>; hit: () => void } {
  let release!: () => void
  const opened = new Promise<void>((resolve) => { release = resolve })
  let held = 0
  const g: Gate = {
    release: () => release(),
    held: () => held,
    waitHeld: async (message, count = 1) => {
      await expect.poll(() => held, { timeout: 10_000, message }).toBeGreaterThanOrEqual(count)
    },
    dispose: async () => {
      release()
      await page.unrouteAll({ behavior: 'wait' })
    },
  }
  return { gate: g, wait: () => opened, hit: () => { held += 1 } }
}

/**
 * 卡住內容含 `mark` 的 JS chunk，直到 `release()`。`mark` 挑一句只出現在那個延遲 chunk 的字串
 * （例如那支檔案裡的錯誤訊息），不要用檔名——Turbopack 的 chunk 名稱每次 build 都不同。
 */
export async function holdChunk(page: Page, mark: string): Promise<Gate> {
  const g = gate(page)
  await page.route('**/_next/static/chunks/*.js', async (route) => {
    const response = await route.fetch()
    const body = await response.text()
    if (body.includes(mark)) {
      g.hit()
      await g.wait()
    }
    await route.fulfill({ response, body })
  })
  return g.gate
}

/**
 * 卡住打到 `pathname` 的 Server Action（`POST`＋`next-action` 標頭），直到 `release()`。
 * `abort: true` 時放行改成中斷（`route.abort('failed')`），測「請求失敗後畫面回到可再操作」。
 */
export async function holdAction(page: Page, pathname: string, opts: { abort?: boolean } = {}): Promise<Gate> {
  const g = gate(page)
  await page.route(
    (url) => url.pathname === pathname,
    async (route: Route) => {
      const request = route.request()
      if (request.method() !== 'POST' || !request.headers()['next-action']) return route.continue()
      g.hit()
      await g.wait()
      if (opts.abort) return route.abort('failed')
      return route.continue()
    },
  )
  return g.gate
}
