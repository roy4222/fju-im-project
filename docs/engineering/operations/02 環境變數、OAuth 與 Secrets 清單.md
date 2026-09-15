---
type: sop
project: FJU IM Project
updated: 2026-09-12
execution_status: NOT_RUN
---
# SOP 02｜環境變數、OAuth 與 Secrets 清單

> 執行狀態：**NOT_RUN**（2026-09-12 只寫文件，未在任何環境執行）。VM 事實為 2026-09-11 快照，執行前重新核對。規則來源：[共用契約 05](<../contracts/05 CI-CD、部署與維運.md>)。v2（2026-09-12）：依契約 05 §6 改為三組憑證分檔（回覆 R02）。v2.1（2026-09-12）：變數名展開定名、推 GHCR 改用 `GITHUB_TOKEN`、`AGE_RECIPIENTS`、R2 token 權限、七道 checks；Roy 的登入／開通／金鑰待辦與現況見 [00 Roy 前置工作清單](<00 Roy 前置工作清單.md>)。

| 欄位 | 內容 |
|---|---|
| 操作者 | Roy（持有金鑰）；Fable 提供清單 |
| 前置 | SOP 01 完成 |
| 停止條件 | 任一必要值缺少 |
| 恢復 | 補值後重啟 app／worker |
| 證據 | `.env` 的鍵名清單（不含值）截圖；Google console redirect URI 截圖；GitHub Secrets 名稱截圖 |

## 步驟與預期

1. 依契約 05 §6 分三個檔案填值，皆 `chmod 600`、owner 為部署使用者；值不得進 repo 與聊天紀錄：
   - `/srv/fju/app/.env.migrate`：`DATABASE_URL_OWNER`（`fju_owner`），只給 `migrate` 服務與 SOP 06 的 reset。
   - `/srv/fju/app/.env`：`DATABASE_URL`（`fju_app`）、`BETTER_AUTH_SECRET`（`openssl rand -base64 32`）、`BETTER_AUTH_URL=https://fju.roy422.dev`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`、`FILES_ROOT=/srv/fju/files`、`FILE_MAX_BYTES=104857600`、`BUSINESS_CLOCK_OVERRIDE_ENABLED`（staging true、正式 false）。
   - `/srv/fju/app/.env.backup`：`DATABASE_URL_BACKUP`（`fju_backup`：`pg_read_all_data`＋`backup_runs` INSERT）、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET=fju-db-backup`、`AGE_RECIPIENTS`（一個以上 age 公鑰，逗號分隔）、`ALERT_WEBHOOK_URL`（可空）。
   Compose 以 `env_file` 分別掛給 migrate／app＋worker／backup；app 容器內不得存在 owner 或 backup 連線字串（驗證：`docker compose exec app env | grep DATABASE_URL_`）。DB 三個角色與密碼由 SOP 01 的 `init.sql` 建立。
2. Google Cloud console：以 Roy 帳號建立專案與 OAuth client（Web application）；consent screen External、Testing 模式並加入 Roy 的測試信箱 A、B（、C）為 test users；Authorized JavaScript origins `https://fju.roy422.dev`、`https://b1.fju.roy422.dev`、`https://b2.fju.roy422.dev`；redirect URI `https://fju.roy422.dev/api/auth/callback/google`、`https://b1.fju.roy422.dev/api/auth/callback/google`、`https://b2.fju.roy422.dev/api/auth/callback/google`（插槽供隔離副本，SOP 04 步驟 5；本機另加 `http://localhost:3000` 與其 callback）；staging 與正式用同一 client，正式網域時再加一組。完整清單以前置清單 §3.1–3.3 為準。
3. Turnstile：建立 widget（hostname `fju.roy422.dev`，mode Managed），填 `TURNSTILE_SITE_KEY`／`TURNSTILE_SECRET_KEY`；local／CI 用 Cloudflare 官方測試金鑰。
4. R2：建立 bucket `fju-db-backup`（location hint APAC），lifecycle 30 天；建立 API token 權限 Object Read & Write、只限此 bucket（`rclone copy` 需要 list，純唯寫不可行）；`age-keygen` 產生金鑰對，公鑰放 VM `AGE_RECIPIENTS`、私鑰放 Roy 密碼管理器並另存離線副本；校方第二把公鑰可稍後加入。
5. GitHub：environment `staging`（方案支援 environments 時；否則 Secrets 放 repository 層級）的 Secrets；required reviewers 在 private repo 需 Enterprise，本專案不設，approval＝Roy 親自 dispatch（前置清單 §2.1）； `VM_SSH_KEY`、`VM_HOST`、`VM_USER`——只在「第一次 staging 部署」階段（時點待 Roy，預設 S01 後）才建立；推 GHCR 用 `GITHUB_TOKEN`（在 `cd.yml` 推映像的 job 宣告 `permissions: {contents: read, packages: write}`，不放大 workflow 預設權限），VM 拉映像用 classic PAT（只勾 `read:packages`；Packages 不支援 fine-grained token）在 VM `docker login`；S00 期間 `cd.yml` 只 dispatch dry-run、不需這些值。Roy 另設 branch protection（`ci.yml` 七道 required checks：`typecheck`、`lint`、`unit`、`integration`、`build`、`e2e-smoke`、`audit`）。
6. 驗證：`docker compose config` 無缺值警告；app 容器內無 owner／backup 連線字串；`/api/health` 回 200（部署後）；以 `fju_app` 連線執行 `UPDATE audit_events` 被拒（角色生效）。
7. 交接：本清單與鍵名放 Vault；值只在 VM 與密碼管理器。

## 執行紀錄

| 日期 | 操作者 | 版本／環境 | 結果 | 證據 |
|---|---|---|---|---|
| — | — | — | NOT_RUN | — |
