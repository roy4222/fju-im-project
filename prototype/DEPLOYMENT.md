# Cloudflare 原型展示站

展示網址：https://fju-prototype.roy422roy.workers.dev

2026-09-13 已發布；Worker version `1f121cf4-d67e-45e0-9539-a3907792a2a0`。

目的：讓助教直接瀏覽既有前台與學生、老師、管理員後台。內容沿用 `src/lib/fixtures.ts` 假資料；前台的「原型操作列」可切換身分，沒有正式帳號驗證。這份部署不代表正式系統已實作或驗收。

## 指令

在 `prototype/` 執行：

```sh
pnpm run build:vinext
pnpm exec wrangler deploy --config dist/server/wrangler.json --dry-run
pnpm exec wrangler deploy --config dist/server/wrangler.json
```

部署來源為 `wrangler.jsonc` 與 `vite.config.ts`；`dist/` 是產物，不直接修改。Worker 名稱 `fju-prototype`，使用帳戶的 workers.dev 網址，無 DB／KV／R2 綁定。CLI 必須已取得對應帳戶的 Workers scripts 授權。

本機 Workers 預覽：

```sh
pnpm run start:vinext --port 3101
```

原本 Next.js 指令保留：`pnpm dev --port 3100`。vinext 與 React Server Components 版本列在 package.json、lockfile；字型透過 CDN 載入。

## 展示方式

1. 打開首頁，右下角「原型操作列」選訪客、學生、老師或管理員。
2. 點右上方工作台入口進後台；從後台左下角「回到前台」返回切換身分。
3. 展示公告、歷屆作品、學生專題事務、老師評分／簽核、管理員帳號／事務管理等既有畫面。

## 2026-09-13 檢查紀錄

- vinext compatibility scan：主要 imports／libraries 支援；補上 ESM 設定，字型有 CDN 差異。
- Workers production build、Wrangler deploy dry-run、TypeScript `tsc --noEmit` 通過。
- 本機 Workers 22 個前台與三角色後台 URL 檢查正常；老師評分入口正常轉到組別頁。
- 瀏覽器實際操作老師角色切換、讀取後台並檢視畫面成功。
- Cloudflare OAuth 完成，已部署；線上 22 個前台／後台 URL 均 HTTP 200（含預期重新導向）。瀏覽器實際切換學生、老師、管理員並進入各自後台成功。
- 線上 HTTP 初次檢查使用的 Python 憑證庫缺少 issuer，改用 macOS 系統 curl 後全部通過，未關閉 TLS 驗證。
- 線上入口核對證據：`/private/tmp/fju-prototype-live-smoke.json`；部署輸出：`/private/tmp/fju-prototype-deploy-output.txt`。

## 2026-09-15 依賴升級檢查紀錄（#202）

升級：`next` 16.3.1 → 16.3.5、`eslint-config-next` 同版；workspace overrides 加 `fast-uri: ^3.1.6`。
`sharp` 由 next 的 optionalDependencies 帶動，0.35.3 → 0.35.4。React、react-dom（19.2.8）、
react-server-dom-webpack（19.2.8）、vinext（1.0.0-beta.9）、@vinext/cloudflare（1.0.0-beta.7）維持原版本。

- `pnpm audit`：16 件（2 critical、5 high、9 moderate）→ 9 件（全部 moderate）。
- `pnpm run build`（Next）、`pnpm exec tsc --noEmit`、`pnpm run build:vinext` 通過。
- `wrangler deploy --config dist/server/wrangler.json --dry-run` 通過，綁定仍只有 ASSETS 與
  CF_VERSION_METADATA，`wrangler.jsonc` 與 `vite.config.ts` 未改動。
- 本機 Workers 預覽（`wrangler dev --port 3101`）掃 42 條路由（前台 13＋學生 8＋老師 8＋管理員 13）全部 200；
  從前台原型操作列點「老師」實際切換 cookie，再由工作台入口進 `/dashboard/teacher`。
- 升級前後同一組截圖逐張比對：版面與內容相同，唯一差異在 Recharts 圓環圖動畫的擷取時點
  （同一版連拍兩次也會出現同樣大小的差異）。
- `pnpm run lint` 仍有 1 個既有 error（`src/hooks/use-mobile.ts` 的 react-hooks/set-state-in-effect），
  升級前後相同，本次未修。eslint 設定另補上忽略 `dist/`、`.vinext/`、`.wrangler/`，
  否則跑過 `build:vinext` 之後 lint 會多出數千筆產物噪音。
- NOT_RUN：線上 https://fju-prototype.roy422roy.workers.dev 未重新部署、未重新驗證。
