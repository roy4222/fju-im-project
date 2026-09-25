---
type: engineering-contract
project: FJU IM Project
updated: 2026-09-23
status: draft-v2.5-pending-review
---
# 共用契約 05｜CI／CD、部署與維運（v2.5）

> **2026-09-23 v2.5（Roy 定案，來源：[主控台交接](</Users/lubaiyu/Documents/roy422的人生online/專案/🌐 網站與互動/📁 輔大資管系專題網站/🛠️ 工程開發/📝 開發紀錄/2026-09-23 主控台交接.md>) 第 2 節；變更總表見 [05 執行手冊](</Users/lubaiyu/Documents/roy422的人生online/專案/🌐 網站與互動/📁 輔大資管系專題網站/🛠️ 工程開發/🧱 實作切片/05 執行手冊.md>) §6）**：同一台 VM 兩站——正式 `fju.roy422.dev`、測試 `test.fju.roy422.dev`；Cloudflare 只當 DNS。Docker Compose 兩組 project（`fju-test`、`fju-prod`），各自 PostgreSQL、volume、`.env`；共用一個 Caddy 依主機名分流。正式站先建好維持空站；每版同一映像：測試站→Roy 接受→推正式站，§9 的清庫切換不再需要。Turnstile、R2、age、告警 webhook 不用；備份只放 VM、不做異地；分支插槽 `b1`／`b2` 取消。秘密值存 Doppler（`stg`＝測試站、`prd`＝正式站），VM 取值方式與 Compose／Caddy／SOP 01–03 的具體寫法由 0-C 設計。下方被取代的原文以刪除線保留。

> 2026-09-12 v2：依母 spec v3.2 §4.16 與 Codex R02、R14、R15、R16 重寫。具體命令只在 `🚀 部署與維運` 的 SOP 維護。已寫、待 review；所有操作 NOT_RUN。

> 2026-09-12 v2.1（Codex 第二輪 RR01、RR11；前置工作清單）：§2 七道 checks 名稱固定；§6 變數名展開、`fju_backup` 的 `backup_runs` INSERT、推 GHCR 改用 `GITHUB_TOKEN`、`AGE_RECIPIENTS`；§7 副本一致性窗口；§8 告警通道具體化。現況與 Roy 待辦見 [00 Roy 前置工作清單](<../operations/00 Roy 前置工作清單.md>)。

## 1. 環境與版本識別

| 環境 | 位置 | 差異 |
|---|---|---|
| local | 開發機 Compose | 模擬鐘可用；秘密用 Doppler `dev`（只放本機假值） |
| 測試站（原 staging） | 校方 VM，Compose project `fju-test`，`https://test.fju.roy422.dev`（v2.5） | 模擬鐘可用；測試資料；自己的 PostgreSQL、volume、`.env`；秘密來源 Doppler `stg`；第一次部署目標 TP1（9/27） |
| 正式站（production） | 同一台 VM，Compose project `fju-prod`，`https://fju.roy422.dev`（v2.5；~~同 VM 經 SOP 06~~） | `BUSINESS_CLOCK_OVERRIDE_ENABLED=false` 且路由不掛載；自己的 PostgreSQL、volume、`.env`；秘密來源 Doppler `prd`；先建好維持空站，只接受測試站已由 Roy 接受的同一映像 |

兩站共用一個 Caddy，依主機名轉到各自的 app（v2.5）。Cloudflare 只當 DNS（兩筆 A 記錄，僅 DNS）。

版本：git commit、映像 `ghcr.io/<owner>/fju-web:<sha>` 與 digest（v2.5：CI 推映像的 job 由 0-C 新增；9/23 查證 GHCR 尚無映像）；`/api/health` 回 `{version, commit, imageDigest, schemaVersion(schema_meta), worker:{version, lastTickAt}}`。

## 2. CI 門檻（PR required checks）

typecheck → lint（含邊界反例測試）→ 單元 → 整合（Compose postgres：空庫 migration、`fju_app` 權限拒絕測試、用例）→ build → 煙霧 E2E → `pnpm audit`。job 名稱固定 `typecheck`、`lint`、`unit`、`integration`、`build`、`e2e-smoke`、`audit`，七道都是 required checks（S00 與 SOP 02 的「六道」指前六道加 `audit`）。schema 變更的 PR 另跑「前一個 main 映像對新 schema 的整合測試」與「前一版 seed 庫升版」。main 只接受 PR；分支保護規則未在 GitHub 啟用前，文件標 **pending**，不宣稱 main 已受保護。

## 3. CD 啟用時點與部署（回覆 R15）

- S00 只啟用 CI；`cd.yml` 存在但只允許 `workflow_dispatch` 且預設 `--dry-run`；到選定的第一次 staging 部署階段才接上 GitHub Secrets、environment（方案支援時）與 VM；部署 approval 一律是 Roy 親自觸發 `workflow_dispatch`（或手動 SSH 執行 `deploy.sh`），不依賴 environment 的 required reviewers（private repo 需 Enterprise；v2.3，Codex C5）。
- `deploy.sh <tag>`：`flock` 部署鎖（拿不到即失敗）→ 記 `.deploy/previous_tag`（含 digest）→ `docker compose pull app worker migrate` → **`docker compose run --rm migrate`（新映像；失敗即中止，舊 app 繼續）** → `docker compose up -d app worker` → 健康判定 → 寫 `deploy_log`。
- **健康判定**：60 秒內 `/api/health` 回 200 **且** `commit`、`imageDigest` 等於本次部署、`schemaVersion` 等於 migrate 輸出的最後名稱、`worker.version` 等於本次、`worker.lastTickAt` 在 60 秒內；任一不符視為失敗。**分階段（v2.4，E-19）**：E02 出場前（worker 尚未交付）`deploy.sh` 不帶 `--expect-worker`，只判前四項且 `worker` 欄須為 null，`deploy_log` 記「有限健康條件」；E02 出場後帶 `--expect-worker` 判全部六項；旗標與階段不符即失敗。
- 失敗：`up -d` 回 `previous_tag`，再跑同樣的健康判定並記錄；DB 不回滾（expand／contract）；通知 Roy。
- 停機窗口：目前只是估計，第一次 staging 部署實測並記錄；長鎖 migration 另排維護時段。
- **兩站發版（v2.5）**：每版同一個映像 tag／digest，先部署到 `fju-test`→Roy 在里程碑驗收 issue 接受→同一 tag 部署到 `fju-prod`。兩站各跑自己的 `migrate`；`deploy.sh` 的目標站選擇與部署鎖範圍由 0-C 定。

## 4. migration 相容性

expand／contract（契約 01 §12）；回滾只換映像；CI 用前一映像跑整合測試證明相容。

## 5. worker 與到期工作

`worker` 服務同映像、單實例（advisory lock）；`/api/health` 曝露版本與 `lastTickAt`，超過 5 分鐘視為不健康；Compose `restart: unless-stopped`；毒事件與失敗到期工作在管理端顯示，重跑 SOP 04。

## 6. 憑證分組（回覆 R02）

| 組 | 內容 | 位置 |
|---|---|---|
| owner | `DATABASE_URL_OWNER`（`fju_owner`）只給 `migrate` ~~與 reset~~（v2.5：不再有清庫 reset） | 每站自己的 `.env.migrate`（600）；值存 Doppler（v2.5） |
| app | `DATABASE_URL`（`fju_app`）給 app 與 worker；`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、~~`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`~~（v2.5 拿掉）、`FILES_ROOT`、`FILE_MAX_BYTES`、`BUSINESS_CLOCK_OVERRIDE_ENABLED` | 每站自己的 `.env`（600）；值存 Doppler `stg`／`prd`，VM 取值方式由 0-C 設計（v2.5） |
| backup | `DATABASE_URL_BACKUP`（`fju_backup`：`pg_read_all_data`＋`backup_runs` INSERT，備份結果的唯一寫入通道）；~~`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`、`AGE_RECIPIENTS`、`ALERT_WEBHOOK_URL`~~（v2.5：不做異地、不加密、不設告警 webhook） | ~~VM `.env.backup`（600）；私鑰只在 Roy 密碼管理器~~；v2.5：backup 連線放哪個檔與是否仍獨立一份，由 0-C 定 |
| CI | `VM_SSH_KEY`、`VM_HOST`、`VM_USER`（environment `staging`）；推 GHCR 用 `GITHUB_TOKEN`，在推映像的 job 宣告最小 `permissions: {contents: read, packages: write}`（不放大 workflow 預設權限）；VM 拉映像用 **classic** PAT（`read:packages`；Packages 目前不支援 fine-grained token），只存在 VM 的 docker 設定 | GitHub Secrets（方案支援 environments 時放 `staging` environment，否則 repository 層級；見前置清單 §2.1） |

## 7. 備份、還原與隔離（回覆 R14）

- **v2.5（9/23 第二批）**：**兩站都先不排程**；需要時手動執行備份（`pg_dump -Fc` → 存在 VM 本機 → `backup_runs`），仍只放 VM、不做異地、不加密上傳；存放目錄與手動命令由 0-C／S14 owner 定。附件只在 volume。「管理員下載整份資料」列候選，不進 beta。
- ~~**v2.5**：每日 `pg_dump -Fc` → 存在 VM 本機 → `backup_runs`；**不做異地**、不加密上傳；保留天數與存放目錄由 0-C／S14 定（原本機 7 天可沿用）。附件只在 volume。失敗站內通知管理員。「管理員下載整份資料」列候選，不進 beta。~~
- ~~每日 `pg_dump -Fc` → `age` 加密 → `rclone` 到 R2（30 天）→ `backup_runs`；本機 7 天；`AGE_RECIPIENTS` 空時 backup 服務啟動前置檢查失敗、不執行 dump、不寫 `backup_runs`（v2.4，E-11）；附件只在 volume，無異地；失敗站內通知管理員＋Roy Email。~~
- 還原演練：獨立 Compose override（不同專案名、`PGDATA` 目錄、DB URL、port、附件目錄副本、worker 關閉、通知不指真實通道）；restore 前以 `docker inspect` 列 mount 與 `SELECT current_database()` 核對隔離；演練寫入與刪除不改變來源樣本 hash；報告寫明附件不在備份範圍；`restore_drills` 記錄。
- 驗收分支（契約 04 §6）同樣使用隔離副本。
- 副本一致性窗口（RR11）：驗收分支與演練副本取樣前 `docker compose stop app worker`、確認無在途上傳，再依序 `pg_dump`、複製 `files/`；還原後逐一核對有效 `file_references` 對應檔案存在且 checksum 相符（`pnpm ops:verify-files`）；正式備份仍只備 DB、附件無異地（既定）。
- ~~分支副本的對外入口（v2.2，Codex O1）：兩個固定插槽 host `b1.fju.roy422.dev`、`b2.fju.roy422.dev`（Caddy 依 host 轉到副本 app；只用 443；不開任意 port），副本 `BETTER_AUTH_URL`／trusted origins 指向插槽，Google callback 與 Turnstile hostname 預先登記兩個插槽；cookie 依 host 分開，再加獨立瀏覽器 profile（SOP 04 步驟 5）。~~ v2.5：`b1`／`b2` 取消；副本**不開對外入口**，只在 VM 內以獨立 Compose project 跑；需要看畫面時用 SSH port-forward（主控台 9/23 工程決定）。

## 8. 監測與告警

health cron（GitHub Actions 每 5 分鐘，連續 3 次失敗才告警；失敗以 GitHub Actions 通知信寄 Roy；v2.5 兩站各探測一次）；磁碟 80%；備份失敗；worker 停擺；Caddy 5xx 比率；~~第二通道 `ALERT_WEBHOOK_URL`（Roy 決定，可空，未設時只站內通知）~~（v2.5 不設 webhook，只站內通知＋Actions 通知信）。告警通道與產品 Email 分開；現況與待辦見 [00 Roy 前置工作清單](<../operations/00 Roy 前置工作清單.md>) §4.4。

**v2.5（9/23 第二批，D-04 定案）**：磁碟用量只顯示在站內狀態（檔案工作台等級）與探測結果，**不另推播**（不發站內通知、不發外部告警）。

## 9. 測試站→正式站（v2.5 改寫；原「staging→正式」回覆 R16；SOP 06）

**v2.5**：正式站是另一組 Compose project（`fju-prod`），從空庫開始，不從測試站搬資料，所以**不再有清庫切換**（#197／D-09 的清庫前提消失）。每版流程：同一映像先上測試站→Roy 在里程碑驗收 issue 接受→同一 tag 部署到正式站；正式站首次部署跑 `migrate`＋`seed:a1`（正式站自己的 A1 一次性密碼），A1 登入改密。人工 Gate、不在 CD。正式開放（真實名單、校方條件）仍依正式 Gate。

~~人工 Gate、不在 CD。清除範圍逐項：~~（以下原表保留為歷史）

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

~~執行前核對目標環境、最終備份可還原、Gate 放行紀錄；切換後煙霧與 Roy 放行。~~
