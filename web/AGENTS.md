<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 驗證一律用 `pnpm -C web verify`

實作與 Review 都用這個入口（`scripts/verify.mjs`），不手拼 lint／vitest／playwright 指令，也不連共用的 `fju-postgres`。結尾印每步指令、通過／失敗、耗時，失敗附最後 40 行；任一步失敗非 0 結束。

- `pnpm -C web verify [單元測試檔…]`：lint＋typecheck＋單元（給檔名只跑那些單元測試）。
- `pnpm -C web verify --integration src/infrastructure/db/migrations.integration.test.ts`：只跑指定整合測試，自己的 PostgreSQL 容器與 port，結束只清自己的。
- `IDENTITY_CACHE_TTL_SECONDS=0 pnpm -C web verify --e2e e2e/smoke.spec.ts`：build＋`next start`＋worker（自己的 port 與資料庫、`--workers=1`、瀏覽器在 `~/.cache/fju-verify-browsers`）；前綴環境變數會傳到 app 與 worker。`--integration`、`--e2e` 可並用，加 `--static` 連 lint＋typecheck＋單元一起跑。
