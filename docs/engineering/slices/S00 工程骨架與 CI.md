---
type: slice
slice: S00
project: FJU IM Project
updated: 2026-09-12
status: written-v2.1-pending-review
---
# S00｜工程骨架、分層 lint、Compose、CI（CD 只 dry-run）、第一支 migration

## 成果
開發者在本機 `pnpm dev` 跑起 `web/`（空殼首頁與 `/api/health`），`pnpm lint` 對七個反例檔全部報錯、對合法引用不報錯，`pnpm test` 有真 PostgreSQL 的整合測試骨架並包含 DB 角色拒絕測試，CI 七道門檻綠燈，`cd.yml` 只允許 `workflow_dispatch` 且預設 `--dry-run`（契約 05 §3），`deploy.sh --dry-run` 可執行。沒有任何業務功能。

## 模組與前置
無業務模組；前置：無。是 S01 起的地基。

## 進場資料
無。`.env.example` 列契約 05 §6 三組憑證的變數名（無值）。

## schema／API／狀態依賴
- 第一支 migration（純 SQL，契約 01 §12 順序）：Better Auth 四表（`users`、`sessions`、`accounts`、`verifications`，含 `users` 擴充欄）→ 最小 `cohorts`（契約 01 §4.2）→ `schema_meta` → `audit_events`、`operation_records`、`domain_events`、`event_projections`、`due_work` → 角色 `fju_owner`／`fju_app`／`fju_backup` 與**逐表**權限矩陣產生的 GRANT（含欄級）、不可變表 trigger（契約 01 §5 v2.1）。模組 01 表在 S01 的第二支 migration。
- `/api/health` 回 `{ok, version, commit, imageDigest, schemaVersion, worker:{version:null, lastTickAt:null}}`。

## 責任範圍與公開介面
- 目錄：`web/src/{domain,application,infrastructure,app,composition,shared}`；`tsconfig` paths；`next.config` 不改 `bodySizeLimit`。
- lint：`eslint-plugin-boundaries`（母 spec §4.3）、`no-restricted-imports`、`import/no-cycle`、`server-only`、`actions.ts` 的 `'use server'` 與「只匯出 async 函式」規則（契約 02 §7）；`web/lint-fixtures/` 七個反例與三個合法例，`pnpm lint:boundaries-test` 斷言。
- Compose：`docker-compose.yml`（app、worker、migrate、postgres、caddy、backup）與 `docker-compose.local.yml`；`Caddyfile` 上傳上限；`migrate` 服務使用 owner 連線，app／worker 使用 app 連線（runtime 角色是否再拆 app／worker 待 Roy，預設共用）。
- CI：`ci.yml`（`typecheck`、`lint`、`unit`、`integration`、`build`、`e2e-smoke`、`audit` 七道）為 PR required checks（branch protection 由 Roy 設定，待辦）；`cd.yml` dispatch-only dry-run。
- `deploy.sh`：flock、previous_tag（含 digest）、pull、migrate 先跑、up、健康判定比對 commit／imageDigest／schemaVersion／worker、回滾（契約 05 §3）。
- `shared/time`、`shared/result`、`shared/errors`（契約 02 錯誤碼）；`domain` 允許 `decimal.js`。

## 正常與拒絕路徑
lint 反例被擋；`deploy.sh --dry-run` 印出步驟不執行；health 在 DB 不可用時回 503（不洩漏設定）；整合測試以 `fju_app` 對 `audit_events` UPDATE 必須被拒。

## 重試／回滾／恢復
CI 失敗不合併；`deploy.sh` 未實際執行（S14 才在 VM 跑）。

## 最終責任案例、子步驟、自動測試、Codex、四欄
- 最終責任案例：無業務案例。
- 契約 04 §4 由本切片證明：DB 角色權限與不可變（`fju_app` 禁止操作測試檔 `infrastructure/db/roles.test.ts`）。
- 自動：lint fixture 測試；`shared/time` 邊界單元；health 整合；roles 整合。
- Codex：劇本 P00 只核對 `/api/health` 與版本；不需瀏覽器操作。證據：CI run URL、lint 測試輸出、roles 測試輸出。
- 切片出場操作起點（v2.1）：總圖「切片出場與年度案例 PASS 的分界」表的 S00 列；證據存 `steps/S00/`；不以案例 PASS 為出場條件。
- 四欄：N/A。

## 出場條件（環境：local＋CI）
本切片自動測試綠（lint、邊界 fixtures、空庫 migration、`roles.test.ts` 逐表矩陣）；操作起點走通（總圖 v2.1 表）並留 `steps/S00/`；Fable review；Roy 看 CI 綠燈。不要求任何案例 PASS。

## 未涵蓋
任何頁面與業務；VM 實際部署（S14）；branch protection 設定（Roy）。

## 依賴
Roy：branch protection；runtime 角色拆分決定（可延後）。環境：Node 22 LTS、pnpm、Docker。

## 狀態
文件已寫｜待 review｜可實作：否（待 review）｜實作完成：否｜自動驗證：否｜瀏覽器：N/A｜VM：否｜Roy 接受：否
