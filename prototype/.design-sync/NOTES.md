# design-sync 筆記（fju-project）

## 這個 repo 的特殊之處

- **這不是元件庫，是 Next.js 應用**。沒有 `dist/`、沒有 library build script。
  轉換器靠 `--entry` 指向產生出來的 barrel 進入點，並從那裡往上走到 repo 根目錄的
  `package.json` 當作 `PKG_DIR`。少了 `--entry` 會直接失敗於
  `ENOENT: node_modules/fju-project/package.json`。

- **元件探索需要 `.d.ts` 樹**。第一次跑得到 `[ZERO_MATCH] 0 components`，因為 Next.js app
  不輸出型別宣告。解法是產生宣告檔並在 `package.json` 加 `types` 欄位指向 barrel 宣告。

## 每次 re-sync 前必跑的三步

```bash
node .design-sync/build-entry.mjs                    # 1. barrel 進入點
npx tsc -p .design-sync/tsconfig.dts.json            # 2. 型別宣告 → generated/types/
node .design-sync/build-entry.mjs --dts-only         #    補上 types/index.d.ts
node .design-sync/build-css.mjs                      # 3. CSS（Tailwind + 字體層）
```

然後才是：

```bash
DS_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node .ds-sync/resync.mjs --config .design-sync/config.json \
    --node-modules ./node_modules --entry .design-sync/generated/entry.ts \
    --out ./ds-bundle --remote .design-sync/.cache/remote-sync.json
```

`build-entry.mjs` 掃描 `src/components/ui/*.tsx` 的 export（`export { … }` 區塊 +
`export function/const PascalCase`）。**新增或移除元件後一定要重跑**，否則新元件不會進 bundle。

## 已解決的問題（不要重踩）

- **`[TOKENS_MISSING]` 字體變數**：`--font-geist-sans` / `--font-serif-tc` / `--font-kaisei`
  等是 `next/font` 在**執行期**注入的，Claude Design 沒有 Next.js，字體會全部掉回系統預設。
  解法是 `.design-sync/fonts.css`：用遠端 Google Fonts `@import` 並定義那些變數，
  由 `build-css.mjs` 併到編譯後 CSS 的最前面（CSS 規範要求 `@import` 在最前）。
  **不要改用 `@import "./fonts.css"`**——轉換器會把 cssEntry 原樣複製成 `_ds_bundle.css`，
  相對路徑的 `@import` 複製後會斷掉（`[CSS_IMPORT_MISSING]`）。

- **Progress 預覽出現上下兩條線**：`Progress` 的 Root 在 `{children}` 之後**自己就會渲染**
  一組 `ProgressTrack` + `ProgressIndicator`。預覽只放 `ProgressLabel` 與 `ProgressValue`。

- **`[GRID_OVERFLOW]` Progress**：已設 `overrides.Progress = {cardMode: "single",
  primaryStory: "SubmissionRate"}`。

- **playwright 沒有 browser 快取**：不要下載 200MB chromium，用
  `DS_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`
  指向本機已安裝的 Chrome 即可。validate 與 capture 都要帶這個環境變數。

## 已知且可接受的 warn

- `[FONT_REMOTE]`：`"Geist"` `"Geist Mono"` `"Noto Sans TC"` —— 由
  `fonts.css` 的遠端 Google Fonts `@import` 供應，屬預期行為。
  2026-09-07 起全站黑體，Noto Serif TC 與 Kaisei Tokumin 已從 `fonts.css` 與 `src/lib/fonts.ts` 移除。
- `tokens: 1 missing, below threshold` —— `--tw` 是 Tailwind 內部變數，非我們的 token。

## 2026-09-07 re-sync 紀錄

- 前台全部重寫後 re-sync：130 個匯出不變，`bundle: false`；只有 `styling`（CSS 多了
  `.btn-fju*`、`.fju-list-item`、`.fju-panel-title` 與新用到的語意色組合）與 `aux`（README／conventions）要上傳。
- 遠端 anchor 取自主 checkout 的 `ds-bundle/_ds_sync.json`（8/18 首次同步的產物），因為本 session 無法
  `get_file`。正常做法仍是上傳前重新抓專案的 `_ds_sync.json`。
- `DesignSync` 在非互動 session 需要先在互動式 Claude Code 跑一次 `/design-login`（在 claude 對話裡打，不是 shell）。
- 2026-09-07 21:30 上傳完成：547 檔（545 內容＋sentinel＋anchor），無刪除；四個改成 column card 的元件重新評分 good。
- 新 `[GRID_OVERFLOW]` 處理法：把元件加進 `cfg.overrides.<Name>.cardMode = "column"`，跑 `preview-rebuild.mjs --components`，再跑 driver 評分。

## Re-sync 風險（下次要注意什麼）

- **Tailwind 只編譯原始碼用過的 class。** 上傳的 `_ds_bundle.css` 只含 50 個語意色
  class（清單見 `conventions.md` §2）。若前台程式碼新增了語意色組合，
  **`build-css.mjs` 必須重跑**，否則設計 agent 用到新 class 會沒有樣式。
  反之，若前台移除某些用法，那些 class 會從 CSS 消失、既有設計會掉樣式。
  這是這個 repo 最容易靜默走鐘的地方。

- **`package.json` 的 `types` 欄位是為 design-sync 加的**，指向
  `.design-sync/generated/types/index.d.ts`（gitignored）。fresh clone 後該檔不存在，
  必須先跑上面第 2 步才能 build。Next.js 本身不受這個欄位影響。

- **只有 13 個元件有 authored preview**，其餘 117 個是 floor card。它們功能完整、
  可被設計 agent 匯入使用，只是預覽卡是排版佔位。任何一次 re-sync 都可以逐步補。

- **顏色 token 來自 `src/app/globals.css`**，取樣自 im.fju.edu.tw（`#003366` / `#E56E00` /
  `#FFF4EA`，2026-08-17 取樣）。系網改版時要重新取樣。

- 這次沒有驗證的：深色主題下的預覽卡（capture 只跑淺色）、行動裝置寬度的元件行為。
