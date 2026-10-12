<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 開發者後台（status/）

- 獨立專案：**不在** `pnpm-workspace.yaml`，有自己的 `pnpm-lock.yaml`。安裝與執行一律加 `--ignore-workspace`：`pnpm install --ignore-workspace`、`pnpm --ignore-workspace run <script>`。
- Next 版本與主網站相同（16.3.8），文件在 `status/node_modules/next/dist/docs/`。
- 規格：`docs/plans/2026-10-12-status-console/設計方案.md`；資料型別都在 `src/lib/data/types.ts`（第二波共用檔，改型別要 S-1 作者審）。
- 本機：`STATUS_DEV_BYPASS_ACCESS=1 pnpm --ignore-workspace run dev`，讀 `fixtures/base/`（正式模式這個開關無效）。
