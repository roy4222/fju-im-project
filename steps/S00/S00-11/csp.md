# S00-11 證據：CSP 與安全標頭

執行時間：2026-09-15 16:22:52 CST

## T2 決定

Roy 於 2026-09-15 回覆：**採票上預設方案 A — 全站動態渲染＋Proxy 產生 nonce＋`strict-dynamic`**。方案 B（實驗性 SRI）與方案 C（來源白名單）都未採用。

實作位置：`web/src/proxy.ts`（Next 16 把 middleware 改名為 proxy）；指令字串在 `web/src/shared/security-headers.ts`，逐項對照契約 03 §6。首頁與其他頁面 `export const dynamic = 'force-dynamic'`，nonce 才能每個回應都不一樣。

## 回應標頭（實測）
```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-xfqEF0aEtNQnhlFjtZXp8w==' 'strict-dynamic'; style-src 'self' 'nonce-xfqEF0aEtNQnhlFjtZXp8w=='; img-src 'self' blob: data: https://i.ytimg.com; font-src 'self'; frame-src https://www.youtube.com https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

## nonce 一次性
```
nonce-OACSzWGrJn4Cq0BQlxO8/Q==
nonce-ux8GnbgvIr6kj0VSH8Ttnw==
nonce-2qZ6Ys6pV7jbtp9MCpk3rA==
```

## Next 自己的 script 帶著 nonce（所以 hydration 正常）
```
<script src="/_next/static/chunks/2j57ztj32lxai.js" async="" nonce="sYdQDm/r+JS7cXBz7JQ/hw==">
<script src="/_next/static/chunks/3kxgx8et7nps5.js" async="" nonce="sYdQDm/r+JS7cXBz7JQ/hw==">
<script src="/_next/static/chunks/turbopack-0zdo0y8vmfb9k.js" async="" nonce="sYdQDm/r+JS7cXBz7JQ/hw==">
```

## 注入測試：把腳本塞進 HTML 文件（模擬存下來的 XSS）

`scripts/csp-evidence.mjs` 攔截 HTML 回應，在 `</body>` 前插入一段沒有 nonce 的 inline 腳本與一個外部腳本，再看瀏覽器的反應。**不能**用 `page.evaluate()` 插腳本——那跑在 Playwright 自己的執行環境，不受頁面 CSP 管，會得到假通過。

```json
{
  "url": "http://localhost:8080",
  "status": 200,
  "contentSecurityPolicy": "default-src 'self'; script-src 'self' 'nonce-tZm0qT3w5Re3Za5JLg9/zg==' 'strict-dynamic'; style-src 'self' 'nonce-tZm0qT3w5Re3Za5JLg9/zg=='; img-src 'self' blob: data: https://i.ytimg.com; font-src 'self'; frame-src https://www.youtube.com https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "otherSecurityHeaders": {
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  },
  "injectedInlineScriptRan": false,
  "headingStillRendered": "輔仁大學資訊管理學系專題管理平台",
  "cspViolationsInConsole": [
    "Executing inline script violates the following Content Security Policy directive 'script-src 'self' 'nonce-tZm0qT3w5Re3Za5JLg9/zg==' 'strict-dynamic''. Either the 'unsafe-inline' keyword, a hash ('sha256-+N4fjhC/YBM8WRg7W1GPZweDsWoQga9mGbM47DfEX/8='), or a nonce ('nonce-...') is required to enable inline execution. The action has been blocked.",
    "Loading the script 'https://example.com/evil.js' violates the following Content Security Policy directive: \"script-src 'self' 'nonce-tZm0qT3w5Re3Za5JLg9/zg==' 'strict-dynamic'\". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked."
  ]
}
```

注入的 inline 腳本沒有執行（`injectedInlineScriptRan: false`），外部腳本也被擋，
而頁面的 h1 照常顯示。截圖：`page-after-injection.png`。

## 自動測試
```
$ playwright test

Running 6 tests using 4 workers

  ✓  3 [chromium] › e2e/smoke.spec.ts:22:1 › /api/health 回 200 與契約 05 §1 的欄位 (65ms)
  ✓  5 [chromium] › e2e/smoke.spec.ts:89:1 › 沒有 nonce 的 inline 腳本被 CSP 擋下，頁面照常運作 (890ms)
  ✓  1 [chromium] › e2e/smoke.spec.ts:7:1 › 首頁打得開，而且有 hydration（Next 的 script 帶著 nonce 被執行） (886ms)
  ✓  4 [chromium] › e2e/smoke.spec.ts:30:1 › 回應帶 CSP 與其他安全標頭（契約 03 §6） (892ms)
  ✓  2 [chromium] › e2e/smoke.spec.ts:46:1 › nonce 每次請求都不一樣 (932ms)
  ✓  6 [chromium] › e2e/smoke.spec.ts:103:1 › 外部來源的腳本也被擋（script-src 只允許 self 與帶 nonce 者） (222ms)

  6 passed (2.3s)
```

```

 ✓ |unit| src/shared/security-headers.test.ts (10 tests) 7ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  16:22:56
   Duration  441ms (transform 74ms, setup 0ms, collect 37ms, tests 7ms, environment 0ms, prepare 134ms)

```

## 本票未涵蓋

- 限速實際規則（登入 10 次／10 分鐘等）：`proxy.ts` 只留了位置，規則由 S01-05／S01-09 填。
- cookie 的 `secure; httpOnly; sameSite=lax`：由 Better Auth 設定，S01-02 一併處理。
- HSTS 只在 https 才送；本機是 http 所以標頭中看不到，S14 上 VM 後可驗。
