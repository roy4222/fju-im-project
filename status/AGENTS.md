<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 開發者後台（status/）

- 獨立專案：**不在** `pnpm-workspace.yaml`，有自己的 `pnpm-lock.yaml`。安裝與執行一律加 `--ignore-workspace`：`pnpm install --ignore-workspace`、`pnpm --ignore-workspace run <script>`。
- Next 版本與主網站相同（16.3.8），文件在 `status/node_modules/next/dist/docs/`。
- 規格：`docs/plans/2026-10-12-status-console/設計方案.md`（第一版，AC-S-1～26 仍是既有保證）；2026-10-16 起的側欄八項、總覽、`/health`、`/deploy`、`/errors`、`/backup`、`/usage`、G5、`metrics.json`／`usage.json`／`vm.json.disk` 以 `docs/plans/2026-10-16-status/`（設計方案、驗收案例、拆票）為準。人維護的四個設定檔與頁面清單見 `docs/status/README.md`。
- 圖表元件介面見設計方案 §4.3：`components/charts/area-chart.tsx` 吃 `{ series: { id?, label, points: { at, value }[] }[], unit }`，伺服器端畫 SVG（Roy 定案 Q151，不用 Recharts）；總覽與 `/health` 只透過這個介面用圖。
- 不新增 `"use client"` 檔（現有的只有側欄與 `components/ui/*`）；側欄的 `src/lib/data/nav.ts` 會進 client bundle，只放純資料。頁面票的 PR 要貼 `node scripts/bundle-size.mjs` 的輸出（共用 ≤ 230 KB、每路由專屬 ≤ 30 KB、每路由總量 ≤ 260 KB）。
- 資料型別都在 `src/lib/data/types.ts`（第二波共用檔，改型別要 S-1 作者審）。
- 本機：`STATUS_DEV_BYPASS_ACCESS=1 pnpm --ignore-workspace run dev`，讀 `fixtures/base/`（正式模式這個開關無效）。
