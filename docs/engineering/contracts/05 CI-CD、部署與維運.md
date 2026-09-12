---
type: engineering-contract
project: FJU IM Project
updated: 2026-09-12
status: draft-v2.1-pending-review
---
# 共用契約 05｜CI／CD、部署與維運（v2.1）

> 2026-09-12 v2：依母 spec v3.2 §4.16 與 Codex R02、R14、R15、R16 重寫。具體命令只在 `🚀 部署與維運` 的 SOP 維護。已寫、待 review；所有操作 NOT_RUN。

> 2026-09-12 v2.1（Codex 第二輪 RR01、RR11；前置工作清單）：§2 七道 checks 名稱固定；§6 變數名展開、`fju_backup` 的 `backup_runs` INSERT、推 GHCR 改用 `GITHUB_TOKEN`、`AGE_RECIPIENTS`；§7 副本一致性窗口；§8 告警通道具體化。現況與 Roy 待辦見 [00 Roy 前置工作清單](<../operations/00 Roy 前置工作清單.md>)。

## 1. 環境與版本識別

| 環境 | 位置 | 差異 |
|---|---|---|
| local | 開發機 Compose | 模擬鐘可用 |
| staging | 校方 VM | 模擬鐘可用；測試資料；第一次部署時點待 Roy（預設 S01 後） |
| production | 同 VM 經 SOP 06 | `BUSINESS_CLOCK_OVERRIDE_ENABLED=false` 且路由不掛載 |

版本：git commit、映像 `ghcr.io/<owner>/fju-web:<sha>` 與 digest；`/api/health` 回 `{version, commit, imageDigest, schemaVersion(schema_meta), worker:{version, lastTickAt}}`。

## 2. CI 門檻（PR required checks）

typecheck → lint（含邊界反例測試）→ 單元 → 整合（Compose postgres：空庫 migration、`fju_app` 權限拒絕測試、用例）→ build → 煙霧 E2E → `pnpm audit`。job 名稱固定 `typecheck`、`lint`、`unit`、`integration`、`build`、`e2e-smoke`、`audit`，七道都是 required checks（S00 與 SOP 02 的「六道」指前六道加 `audit`）。schema 變更的 PR 另跑「前一個 main 映像對新 schema 的整合測試」與「前一版 seed 庫升版」。main 只接受 PR；分支保護規則未在 GitHub 啟用前，文件標 **pending**，不宣稱 main 已受保護。

## 3. CD 啟用時點與部署（回覆 R15）

- S00 只啟用 CI；`cd.yml` 存在但只允許 `workflow_dispatch` 且預設 `--dry-run`；到選定的第一次 staging 部署階段才接上 GitHub Secrets、protected environment 與 VM。
- `deploy.sh <tag>`：`flock` 部署鎖（拿不到即失敗）→ 記 `.deploy/previous_tag`（含 digest）→ `docker compose pull app worker migrate` → **`docker compose run --rm migrate`（新映像；失敗即中止，舊 app 繼續）** → `docker compose up -d app worker` → 健康判定 → 寫 `deploy_log`。
- **健康判定**：60 秒內 `/api/health` 回 200 **且** `commit`、`imageDigest` 等於本次部署、`schemaVersion` 等於 migrate 輸出的最後名稱、`worker.version` 等於本次、`worker.lastTickAt` 在 60 秒內；任一不符視為失敗。
- 失敗：`up -d` 回 `previous_tag`，再跑同樣的健康判定並記錄；DB 不回滾（expand／contract）；通知 Roy。
- 停機窗口：目前只是估計，第一次 staging 部署實測並記錄；長鎖 migration 另排維護時段。

## 4. migration 相容性

expand／contract（契約 01 §12）；回滾只換映像；CI 用前一映像跑整合測試證明相容。

## 5. worker 與到期工作

`worker` 服務同映像、單實例（advisory lock）；`/api/health` 曝露版本與 `lastTickAt`，超過 5 分鐘視為不健康；Compose `restart: unless-stopped`；毒事件與失敗到期工作在管理端顯示，重跑 SOP 04。

## 6. 憑證分組（回覆 R02）

| 組 | 內容 | 位置 |
|---|---|---|
| owner | `DATABASE_URL_OWNER`（`fju_owner`）只給 `migrate` 與 reset | VM `.env.migrate`（600） |
| app | `DATABASE_URL`（`fju_app`）給 app 與 worker；`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`、`FILES_ROOT`、`FILE_MAX_BYTES`、`BUSINESS_CLOCK_OVERRIDE_ENABLED` | VM `.env`（600） |
| backup | `DATABASE_URL_BACKUP`（`fju_backup`：`pg_read_all_data`＋`backup_runs` INSERT，備份結果的唯一寫入通道）、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`、`AGE_RECIPIENTS`（一個以上 age 公鑰，逗號分隔；取代 `AGE_PUBLIC_KEY`）、`ALERT_WEBHOOK_URL`（可空） | VM `.env.backup`（600）；私鑰只在 Roy 密碼管理器（校方第二把鑰匙見前置清單 §4.2） |
| CI | `VM_SSH_KEY`、`VM_HOST`、`VM_USER`（environment `staging`）；推 GHCR 用 `GITHUB_TOKEN`（不需 `GHCR_TOKEN`）；VM 拉映像用只讀 PAT，只存在 VM 的 docker 設定 | GitHub Environments Secrets |

## 7. 備份、還原與隔離（回覆 R14）

- 每日 `pg_dump -Fc` → `age` 加密 → `rclone` 到 R2（30 天）→ `backup_runs`；本機 7 天；附件只在 volume，無異地；失敗站內通知管理員＋Roy Email。
- 還原演練：獨立 Compose override（不同專案名、`PGDATA` 目錄、DB URL、port、附件目錄副本、worker 關閉、通知不指真實通道）；restore 前以 `docker inspect` 列 mount 與 `SELECT current_database()` 核對隔離；演練寫入與刪除不改變來源樣本 hash；報告寫明附件不在備份範圍；`restore_drills` 記錄。
- 驗收分支（契約 04 §6）同樣使用隔離副本。
- 副本一致性窗口（RR11）：驗收分支與演練副本取樣前 `docker compose stop app worker`、確認無在途上傳，再依序 `pg_dump`、複製 `files/`；還原後逐一核對有效 `file_references` 對應檔案存在且 checksum 相符（`pnpm ops:verify-files`）；正式備份仍只備 DB、附件無異地（既定）。

## 8. 監測與告警

health cron（GitHub Actions 每 5 分鐘，連續 3 次失敗才告警；失敗以 GitHub Actions 通知信寄 Roy）；磁碟 80%；備份失敗；worker 停擺；Caddy 5xx 比率；第二通道 `ALERT_WEBHOOK_URL`（Roy 決定，可空，未設時只站內通知）。告警通道與產品 Email 分開；現況與待辦見 [00 Roy 前置工作清單](<../operations/00 Roy 前置工作清單.md>) §4.4。

## 9. staging→正式（回覆 R16；SOP 06）

人工 Gate、不在 CD。清除範圍逐項：

| 對象 | 處置 |
|---|---|
| Better Auth `users／accounts／sessions／verifications` | 刪除（含 A1）；A1 以 `seed:a1` 重建並強制改密 |
| `role_assignments`、`user_profiles`、申請與名單、占用表 | 刪除 |
| 業務表（屆別、組別、項目、回答、評分、簽核、精選） | 刪除 |
| `operation_records`、`domain_events`、`event_projections`、`due_work`、`notifications`、`audit_events` | 刪除（切換前的最終備份已保存整份 staging） |
| `stored_files` 與 `files/`、`tmp/` | 刪除實體檔與列 |
| 公開資源、快取 | 刪除；重啟後快取空 |
| `schema_meta` | 保留 |
| 舊 session 與舊 requestId | 因表已清空不可能生效；切換後以測試證明舊 cookie 被拒 |

執行前核對目標環境、最終備份可還原、Gate 放行紀錄；切換後煙霧與 Roy 放行。
