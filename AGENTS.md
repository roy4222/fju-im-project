<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 專案結構（2026-09-09 Roy 定案）

- `prototype/`：可點的前端原型（Next.js，port 3100）。前台樣子已定稿、後台做多個版本供評選。讀 `src/lib/fixtures.ts` 假資料、身分用 cookie 模擬。這裡可以自由改，程式碼結構不是重點。
- 正式程式碼尚未開始：後台版本定案後，從 Better Auth＋Drizzle 那條垂直切片（規格 §16.7）起頭另建，需要哪一頁再從 prototype 搬並順便拆好元件。不要把 prototype 整包當正式碼。
- `docs/`：規格、架構、術語、ADR 的 Vault 鏡像；`docs/DASHBOARD-PAGES.md`、`docs/FRONTEND-PAGES.md` 是頁面清單。

## 專案文件入口

接續需求、設計、實作或 review 時，先讀 [docs/README.md](docs/README.md)；它連到完整主規格、架構、術語與 ADR。使用 `grill-with-docs` 時載入 `grilling` 與 `domain-modeling`，沿用既定需求，只討論本次未決事項。

Roy 從 Obsidian 討論本專案；開始先核對 docs/README.md 所連的 Vault 最新修訂，完成文件或開發改動後依其中同步步驟更新 Vault 的對應全文、目前狀態及核對時間。
