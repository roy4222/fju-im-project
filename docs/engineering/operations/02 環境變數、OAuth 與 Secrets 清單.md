---
type: sop
project: FJU IM Project
updated: 2026-10-21
execution_status: NOT_RUN
---
# SOP 02｜環境變數、OAuth 與 Secrets 清單

> 執行狀態：**NOT_RUN**（2026-09-12 只寫文件，未在任何環境執行）。VM 事實為 2026-09-11 快照，執行前重新核對。規則來源：[共用契約 05](<../contracts/05 CI-CD、部署與維運.md>)。v2（2026-09-12）：依契約 05 §6 改為三組憑證分檔（回覆 R02）。v2.1（2026-09-12）：變數名展開定名、推 GHCR 改用 `GITHUB_TOKEN`、`AGE_RECIPIENTS`、R2 token 權限、七道 checks；Roy 的登入／開通／金鑰待辦與現況見 [00 Roy 前置工作清單](<00 Roy 前置工作清單.md>)。

> **2026-09-24 v3（兩站版，0-C；Roy 9/23 定案）**：秘密值**只在 Doppler**（專案 `fju-im-capstone`：`stg`＝測試站 `fju-test`、`prd`＝正式站 `fju-prod`，各 16 鍵，9/23 Roy 確認）。VM 上**不再有** `.env`／`.env.migrate`／`.env.backup`：每站一把**唯讀 service token**，由 Roy 親貼到 `/srv/fju/secrets/doppler-<test|prod>.token`（`deploy` 擁有、600）；部署時腳本用它 `doppler run --no-fallback` 把秘密放進**程序環境**，再由 `docker-compose.vm.yml` 逐項交給各服務——不寫檔、不留 Doppler 加密快取、不印到 log。R2、age、`ALERT_WEBHOOK_URL` 不用（Turnstile 在 B 階段 2026-10 改成要用，見鍵總表）；`b1`／`b2` 插槽取消。逐步指令在 repo [`ops/README.md`](https://github.com/roy4222/fju-im-project/blob/main/ops/README.md) 第 5–7 步。舊版步驟收在文末摺疊區塊。

| 欄位 | 內容 |
|---|---|
| 操作者 | Roy（持有 Doppler 與 GitHub 帳號）；agent 只提供鍵名清單，**不讀任何秘密值** |
| 前置 | SOP 01 v3 步驟 1–4 完成 |
| 停止條件 | `ops/site.sh <站> check` 報缺鍵、token 貼錯站，或 GHCR 登入失敗 |
| 恢復 | 在 Doppler 補值後重跑該站部署（`deploy.sh` 每次都重新取值）；token 貼錯就覆寫該檔 |
| 證據 | `ls -l /srv/fju/secrets/`（只看權限）；`ops/site.sh test check`、`ops/site.sh prod check` 各一行 ✓；`docker login` 的 `Login Succeeded`；PAT 到期日 |

## 步驟與預期（v3 兩站版）

1. **取值方式（設計）**：`ops/lib/site.sh` 讀 token 檔前先核對 600＋擁有者＝執行者；token 以 `DOPPLER_TOKEN` 環境變數交給 `doppler run --no-fallback`（不進指令列，`ps` 看不到），被執行的指令前面再 `env -u DOPPLER_TOKEN`，所以 docker compose 與容器都拿不到 token。進入後核對 Doppler 注入的 `DOPPLER_CONFIG` 必須是該站的 `stg`／`prd`（防止 token 貼錯站），並檢查必要鍵都有值——缺的**只印鍵名**。會印出環境的指令（`docker compose config`、`env`、`printenv`）由 `ops/site.sh` 擋掉。
2. **每個服務拿到哪些鍵**（`docker-compose.vm.yml`，每項 `${X:?}`，少一個整個指令失敗）：

   | 服務 | 鍵 |
   |---|---|
   | `postgres` | `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`（只在第一次建庫生效） |
   | `migrate` | `DATABASE_URL_OWNER` |
   | `app`、`worker` | `DATABASE_URL`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`FILES_ROOT`、`FILE_MAX_BYTES`、`BUSINESS_CLOCK_OVERRIDE_ENABLED` |
   | `ops/deploy.sh` 本身 | `APP_DB_PASSWORD`（每次 migrate 後以 stdin 設成 `fju_app` 的密碼；migration 只建角色不設密碼） |
   | `ops/seed-admin.sh`（每站一次，migrate 容器內跑 `seed-a1.mjs`） | `A1_EMAIL`、`A1_INITIAL_PASSWORD`（必填，一次性密碼 ≥ 12 字元）、`A1_NAME`（可選）＋`DATABASE_URL_OWNER`；以 `-e 名稱` 轉交，不進指令列、不印 |
   | `ops/seed-demo.sh`（選填，只在 `stg`；⑤-18） | `SEED_DEMO_PASSWORD`：測試站示範帳號（示範老師與在學示範學生）共用的登入密碼。`prd` **不加**（正式站本來就不准跑 seed-demo）。`seed-demo.sh` 以 `-e SEED_DEMO_PASSWORD`（名稱不帶值）轉交進 migrate 容器；只在**新建**示範資料時寫入（已存在就不動，要換密碼＝`seed-demo.sh test --remove` 後重建）。沒設＝示範帳號沒有密碼、照舊建立。值由 Roy 自己產（例 `openssl rand -base64 18`），不寫進任何檔、票或聊天；設定：`doppler secrets set SEED_DEMO_PASSWORD -p fju-im-capstone -c stg`（互動輸入） |
   | `worker`（選填，⑤-06） | `HEALTHCHECKS_WORKER_URL`：Healthchecks.io「worker 測試站／正式站」check 的 ping 網址（`stg`、`prd` 各一個）。`docker-compose.vm.yml` 用 `${HEALTHCHECKS_WORKER_URL:-}` **只轉交給 worker**（app 沒有）、不在 `ops/lib/site.sh` 的必要鍵裡；沒設＝空字串＝不打卡 |

   驗證 app 容器內沒有 owner 連線（只看名稱）：`sudo -u deploy docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' fju-test-app | cut -d= -f1`，預期沒有 `DATABASE_URL_OWNER`、`POSTGRES_PASSWORD`。
3. **Roy 在 Doppler 核對值的形狀**（agent 看不到值）：連線字串主機一律是 `postgres`（Compose 服務名）、port 5432；`DATABASE_URL`＝`postgres://fju_app:<APP_DB_PASSWORD>@postgres:5432/<POSTGRES_DB>`；`DATABASE_URL_OWNER`＝`postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@postgres:5432/<POSTGRES_DB>`；`BETTER_AUTH_URL` stg＝`https://test.fju.roy422.dev`、prd＝`https://fju.roy422.dev`；`FILES_ROOT` 是**容器內**路徑（例 `/srv/fju/files`，實體在 VM 的 `/srv/fju/<站>/files`）；`BUSINESS_CLOCK_OVERRIDE_ENABLED` stg `true`、prd `false`；密碼用英數字（`openssl rand -hex 24`），免 URL 跳脫。
4. **產生並貼 token**：Doppler → `fju-im-capstone` → `stg`／`prd` → Access → Service Tokens → Generate（Read），名稱 `vm-test`／`vm-prod`；在 VM 用 `read -rs`（不回顯、不進 shell history）寫入 `/srv/fju/secrets/doppler-<test|prod>.token`，`umask 077`。預期 `ls -l` 兩行 `-rw------- deploy deploy`；`ops/site.sh test check`、`ops/site.sh prod check` 各一行 ✓。
4a. **Healthchecks.io 打卡網址（⑤-06）**：不在 Doppler 的兩個 VM 檔，由 Roy 在 VM 用 `read -rs` 寫入（`deploy` 擁有、600，跟 token 同目錄）：`/srv/fju/secrets/healthchecks-backup.url`（`ops/backup-daily.sh`，「每日備份」check）、`/srv/fju/secrets/healthchecks-deploy.url`（`ops/auto-deploy.sh`，「自動部署」check）。檔案不存在＝不打卡、腳本照常。網址等同密碼，不進 repo、log、issue。步驟見 [`ops/README.md`](https://github.com/roy4222/fju-im-project/blob/main/ops/README.md)「Healthchecks.io」。
5. **GHCR**：推映像由 `.github/workflows/image.yml` 用 `GITHUB_TOKEN`（該 job `permissions: {contents: read, packages: write}`），main 合併後推 `ghcr.io/roy4222/fju-web:<完整 SHA>` 與 `:main`；套件 private（跟 repo）。VM 拉映像：Roy 建 classic PAT `fju-vm-ghcr-pull`（只勾 `read:packages`，90 天到期記行事曆），`sudo -u deploy docker login ghcr.io -u roy4222`。**GitHub 上不放任何 VM 的 SSH 金鑰**（`VM_SSH_KEY`、`VM_HOST`、`VM_USER` 不再需要）：測試站由 VM 自己拉（SOP 03 §自動部署），正式站由 Roy 在 VM 手動部署。
6. **Google OAuth**（9/23 已完成，見前置清單 Google OAuth 項）：專案 `fju-im-capstone`、用戶端 `fju-web`；origins／redirect 三組：`https://fju.roy422.dev`、`https://test.fju.roy422.dev`（各自 `/api/auth/callback/google`）與本機 `http://localhost:3000`。ID／Secret 已在 Doppler 兩個 config。
7. **分支保護**：`ci.yml` 七道 required checks（`typecheck`、`lint`、`unit`、`integration`、`build`、`e2e-smoke`、`audit`）不變；`image.yml` 不列 required（只在 main 上跑）。
8. 交接：本清單與鍵名放 Vault；值只在 Doppler（交接校方時轉移 Doppler 專案，見前置清單的交接項）。

## 鍵總表（以 `.env.example` 為準，2026-10-21 對齊；只列名稱，不放值）

「範本」欄：✓＝在 `.env.example`；「否」＝刻意不放，原因寫在「誰用」。「放哪」：VM＝Doppler 的 `stg`／`prd`（由 `docker-compose.vm.yml` 轉交）；本機＝`.env`（app 組）、`.env.migrate`（owner 組）、`.env.backup`（backup 組）。

| 鍵 | 誰用 | 放哪 | 範本 |
|---|---|---|---|
| `DATABASE_URL` | app、worker（`fju_app` 連線） | VM、本機 | ✓ |
| `BETTER_AUTH_SECRET` | app、worker；上傳憑證金鑰也從它導出 | VM、本機 | ✓ |
| `BETTER_AUTH_URL` | app、worker；登入回呼網址 | VM、本機 | ✓ |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | app（Google 登入） | VM、本機 | ✓ |
| `FILES_ROOT`、`FILE_MAX_BYTES` | app、worker（檔案存放根目錄、單檔上限） | VM、本機 | ✓ |
| `BUSINESS_CLOCK_OVERRIDE_ENABLED` | app、worker（營運時鐘可否被覆寫；stg `true`、prd `false`） | VM、本機 | ✓ |
| `BREVO_API_KEY`、`MAIL_FROM` | app、worker（寄信）；少了站照常起來，只是寄信失敗；VM 不列必填 | VM、本機 | ✓ |
| `MAIL_REPLY_TO` | app（寄信的 Reply-To，選配）；`docker-compose.vm.yml` 沒有轉交，所以 VM 目前設了也讀不到 | 本機 | ✓ |
| `MAIL_CAPTURE` | 只限本機與 CI（e2e 從 `mail_outbox` 讀驗證碼）；VM、Doppler 一律不設 | 本機、CI | ✓ |
| `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY` | app（註冊、忘記密碼、重寄驗證碼的人機驗證）；不列必填 | VM、本機 | ✓ |
| `GA4_MEASUREMENT_ID` | app（只正式站設；其餘留空就不載入） | VM（prd）、本機 | ✓ |
| `DB_POOL_MAX` | app、worker 連線池上限（沒設＝10；VM 的 worker 在 compose 固定 2） | 本機 | ✓ |
| `HEALTHCHECKS_WORKER_URL` | 只給 worker（打卡網址）；沒設＝不打卡 | VM（選填）、本機 | ✓ |
| `IDENTITY_CACHE_TTL_SECONDS` | app 身分快取秒數（沒設＝60；e2e 設 0） | 本機、CI | ✓ |
| `UPLOAD_RATE_MAX` | app 上傳限速額度（沒設＝20；e2e 設 1000）；VM 不設 | 本機、CI | ✓ |
| `REGISTRATION_OPEN` | app（開放註冊開關）：程式沒這個鍵＝開放，空字串或不是 `true`＝關閉；VM compose 沒設時補 `false`。刻意不放範本，因為本機照範本建出空值會把註冊關掉 | VM | 否：空值會關閉註冊 |
| `DATABASE_URL_OWNER` | `migrate` 服務、owner 級腳本與整合測試；app 容器內不得有 | VM、本機 | ✓ |
| `APP_DB_PASSWORD` | `ops/deploy.sh`（每次 migrate 後設定 `fju_app` 的密碼）；不進 app 容器 | VM | ✓ |
| `DATABASE_URL_BACKUP` | 目前沒有任何程式讀它（備份走 `ops/backup-daily.sh`）；留著是因為基礎 Compose 與 CI 要有 `.env.backup` 這個檔 | 本機 | ✓ |
| `APP_IMAGE`、`GIT_COMMIT`、`APP_VERSION`、`IMAGE_DIGEST` | 基礎 `docker-compose.yml`（映像與版本資訊，`/api/health` 回報）；非憑證，可留空 | 本機、部署腳本 | ✓ |
| `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB` | `postgres` 服務（只在第一次建庫生效）；`migrate` 組 owner 連線字串時對應 | VM、本機 | ✓ |
| `POSTGRES_PORT`、`HTTP_PORT` | 本機 Compose 的對外埠（`docker-compose.local.yml`、`docker-compose.yml`）；VM 不用 | 本機 | ✓ |
| `A1_EMAIL`、`A1_INITIAL_PASSWORD`、`A1_NAME` | 只有 `ops/seed-admin.sh`（每站一次，一次性） | VM（用完可刪） | 否：一次性腳本輸入 |
| `SEED_DEMO_PASSWORD` | 只有 `ops/seed-demo.sh`（只 `stg`） | VM（stg，選填） | 否：只在測試站、互動設定 |

不列的變數：測試與驗證腳本自用的（`BASE_URL`、`TEST_FJU_APP_PASSWORD`、`E2E_*`、`PERF_*`、`*_SHOT_DIR` 等）、`ops/restore-drill.sh` 與 `ops/fault-drill*.sh` 內部產生的 `DRILL_*`／`FAULTSIM_PORT`、腳本內部設定的 `FJU_SITE`、框架自帶的 `NODE_ENV`／`CI`。

**重跑比對**（在 repo 根目錄；「範本」欄為 ✓ 的鍵必須等於 `.env.example` 的鍵，兩邊差集都印出來，輸出為空＝一致）：

```sh
f='docs/engineering/operations/02 環境變數、OAuth 與 Secrets 清單.md'
diff <(grep -oE '^[A-Z][A-Z0-9_]*' .env.example | sort -u) \
     <(sed -n '/^## 鍵總表/,/^## 執行紀錄/p' "$f" \
         | awk -F'|' '$5 ~ /✓/ {print $2}' | grep -oE '`[A-Z][A-Z0-9_]*`' | tr -d '`' | sort -u) \
  && echo "一致"
```

## 執行紀錄

| 日期 | 操作者 | 版本／環境 | 結果 | 證據 |
|---|---|---|---|---|
| — | — | — | NOT_RUN | — |

> [!quote]- 被取代的舊版步驟（2026-09-12 v2.1 單站三檔版，保留為歷史，不再執行；其中的 R2、age、`AGE_RECIPIENTS`、`ALERT_WEBHOOK_URL`、`DATABASE_URL_BACKUP` 用法都已不用，現行鍵以上方「鍵總表」為準）
> 1. 依契約 05 §6 分三個檔案填值，皆 `chmod 600`、owner 為部署使用者；值不得進 repo 與聊天紀錄：
>    - `/srv/fju/app/.env.migrate`：`DATABASE_URL_OWNER`（`fju_owner`），只給 `migrate` 服務與 SOP 06 的 reset。
>    - `/srv/fju/app/.env`：`DATABASE_URL`（`fju_app`）、`BETTER_AUTH_SECRET`（`openssl rand -base64 32`）、`BETTER_AUTH_URL=https://fju.roy422.dev`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`、`FILES_ROOT=/srv/fju/files`、`FILE_MAX_BYTES=104857600`、`BUSINESS_CLOCK_OVERRIDE_ENABLED`（staging true、正式 false）。
>    - `/srv/fju/app/.env.backup`：`DATABASE_URL_BACKUP`（`fju_backup`：`pg_read_all_data`＋`backup_runs` INSERT）、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET=fju-db-backup`、`AGE_RECIPIENTS`（一個以上 age 公鑰，逗號分隔）、`ALERT_WEBHOOK_URL`（可空）。
>    Compose 以 `env_file` 分別掛給 migrate／app＋worker／backup；app 容器內不得存在 owner 或 backup 連線字串（驗證：`docker compose exec app env | grep DATABASE_URL_`）。DB 三個角色與密碼由 SOP 01 的 `init.sql` 建立。
> 2. Google Cloud console：以 Roy 帳號建立專案與 OAuth client（Web application）；consent screen External、Testing 模式並加入 Roy 的測試信箱 A、B（、C）為 test users；Authorized JavaScript origins `https://fju.roy422.dev`、`https://b1.fju.roy422.dev`、`https://b2.fju.roy422.dev`；redirect URI `https://fju.roy422.dev/api/auth/callback/google`、`https://b1.fju.roy422.dev/api/auth/callback/google`、`https://b2.fju.roy422.dev/api/auth/callback/google`（插槽供隔離副本，SOP 04 步驟 5；本機另加 `http://localhost:3000` 與其 callback）；staging 與正式用同一 client，正式網域時再加一組。完整清單以前置清單 §3.1–3.3 為準。
> 3. Turnstile：建立 widget（hostname `fju.roy422.dev`，mode Managed），填 `TURNSTILE_SITE_KEY`／`TURNSTILE_SECRET_KEY`；local／CI 用 Cloudflare 官方測試金鑰。
> 4. R2：建立 bucket `fju-db-backup`（location hint APAC），lifecycle 30 天；建立 API token 權限 Object Read & Write、只限此 bucket（`rclone copy` 需要 list，純唯寫不可行）；`age-keygen` 產生金鑰對，公鑰放 VM `AGE_RECIPIENTS`、私鑰放 Roy 密碼管理器並另存離線副本；校方第二把公鑰可稍後加入。
> 5. GitHub：environment `staging`（方案支援 environments 時；否則 Secrets 放 repository 層級）的 Secrets；required reviewers 在 private repo 需 Enterprise，本專案不設，approval＝Roy 親自 dispatch（前置清單 §2.1）； `VM_SSH_KEY`、`VM_HOST`、`VM_USER`——只在「第一次 staging 部署」階段（時點待 Roy，預設 S01 後）才建立；推 GHCR 用 `GITHUB_TOKEN`（在 `cd.yml` 推映像的 job 宣告 `permissions: {contents: read, packages: write}`，不放大 workflow 預設權限），VM 拉映像用 classic PAT（只勾 `read:packages`；Packages 不支援 fine-grained token）在 VM `docker login`；S00 期間 `cd.yml` 只 dispatch dry-run、不需這些值。Roy 另設 branch protection（`ci.yml` 七道 required checks：`typecheck`、`lint`、`unit`、`integration`、`build`、`e2e-smoke`、`audit`）。
> 6. 驗證：`docker compose config` 無缺值警告；app 容器內無 owner／backup 連線字串；`/api/health` 回 200（部署後）；以 `fju_app` 連線執行 `UPDATE audit_events` 被拒（角色生效）。
> 7. 交接：本清單與鍵名放 Vault；值只在 VM 與密碼管理器。
