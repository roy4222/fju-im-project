---
type: prerequisites-checklist
project: FJU IM Project
updated: 2026-09-12
status: draft-v1.2-pending-roy
---
# 00｜Roy 需要提早介入的前置工作清單（登入、開通、金鑰、校方申請）

> 2026-09-12 v1（Fable 依 Roy 指示提早交付，不等整套 spec 定稿）。本清單只列**要 Roy 本人或校方才能完成**的平台登入、授權、開通與金鑰事項，以及 Fable 可以先準備的設定與腳本；不含產品決策與校方 12 項確認（見 [校方確認清單](<../../product/💬 討論與決策/2026-09-12 校方確認清單.md>)）。四項待 Roy 決定的技術選擇另列在文末，與登入／開通待辦分開。規則來源：[契約 05](<../contracts/05 CI-CD、部署與維運.md>)、[SOP 01](<01 VM 首次設定.md>)、[SOP 02](<02 環境變數、OAuth 與 Secrets 清單.md>)、[SOP 04](<04 備份、還原演練與故障處理.md>)、[SOP 05](<05 監測與告警.md>)。

> 2026-09-13 v1.1（Codex 對 PR #7 第三輪 review O1–O4 與事實等級）：分支副本改用插槽 host 並登記兩組 Google callback／Turnstile hostname（§3.1–3.3）；Turnstile action 統一 `login`／`register`；age 變數統一 `AGE_RECIPIENTS`；GitHub 方案限制（private repo 的 branch protection、environments、required reviewers 需 Pro／Team）與 token 類型（VM 用 classic PAT，workflow 用 job 層 `permissions`）；Google Testing 限制改為只陳述官方規則與本專案 scope 的例外；交接範圍限本專案資源；本機看不到的項目降為「尚未確認」。

> 2026-09-13 v1.2（Codex 第四輪 C5、C6）：GitHub 能力改為逐項表（branch protection／rulesets、environments、required reviewers 各自的方案限制），private repo 的 required reviewers 需 Enterprise，本專案一律用 Roy 親自 dispatch 作 approval；Google Testing 的基本 scope 例外寫進總表與 §5.2 全段，不再斷言名單外使用者必然無法登入。

## 0. 核對方式與現況等級

- **核對時間**：2026-09-12（Fable 在 Roy 的 Mac 上做唯讀核對：`gh`、`wrangler`、`dig`、`~/.ssh/config` 只讀主機別名、`which`；沒有登入任何服務、沒有建立任何資源）。Codex 同日確認：Wrangler 回報 Not logged in；`roy4222/fju-im-project` repository 層級 Actions Secrets 為空；相關 SOP 全部 NOT_RUN。
- **現況等級**（每項只用一種）：**已實際確認**＝本機命令或 API 回應證明；**僅文件記載**＝SOP／spec 寫了但沒有任何命令證明；**尚未確認**＝需要登入儀表板或連線才能知道；**尚未建立**＝可確定還不存在。
- **原則**：帳號已登入不等於專案已授權，資源存在不等於整合已成功；每項都以「完成後怎麼驗證」的證據為準。**任何秘密值（密碼、token、私鑰、client secret）不貼入聊天、Vault、repo、issue 或截圖**；只記名稱、位置、持有人與核對時間。
- **工程可先做的**：部署使用者與目錄建立腳本、套件安裝腳本、Compose／Caddy／env 範本、CI workflow、指令稿與核對清單都由 Fable 先準備；真正必須 Roy 本人的是帳號登入與 MFA、平台授權、持有秘密值、方案與帳務確認、校方申請。
- **本機已確認的環境事實**：Docker 29.1.3、Compose v2.40.3、Node 24.3.0、pnpm 11.0.9；`web/`、`.github/workflows/`、`.env.example` 都尚不存在（S00 才建立）。

## 1. 總表（依階段）

| # | 項目 | 現況（2026-09-12） | 階段 | 最晚完成 | 未完成會阻擋 |
|---|---|---|---|---|---|
| 1 | GitHub repo 保護、Environments、Actions 權限 | 已實際確認：無 branch protection、0 secrets、0 variables、0 environments、0 workflows；**帳號方案尚未確認**；本 repo 是 private：branch protection／rulesets 與 environments 需 Pro／Team，required reviewers 需 Enterprise（本專案用 Roy 親自 dispatch 取代） | 現在先做 | S00 第一個 `web/` PR 合併前 | 契約 05 §2「main 只接受 PR」只能標 pending 或改為約定 |
| 2 | Google 測試身分（至少兩個、建議三個 Google 帳號） | 尚未確認 | 現在先做 | B01 R1–R3 與老師 Google 預授權人工測試前 | ACC-13、16、18 永遠 BLOCKED |
| 3 | Cloudflare 帳號與 `roy422.dev` zone 權限 | 已實際確認 zone 的 NS 在 Cloudflare；wrangler 未登入；帳號持有人僅文件記載 | 現在先做 | DNS 記錄與 R2 之前 | DNS、Turnstile、R2 全部無法開始 |
| 4 | 校方 VM 可連線、sudo、對外連線、對內 80／443 | 僅文件記載（140.136.155.167、Ubuntu 24.04.4、4 核／7.8 GB／97 GB，2026-09-11 快照）；本機無 SSH 主機設定；連線尚未確認 | 現在先做 | 第一次 staging 部署前（校方開 port 有前置作業時間） | SOP 01 無法開始；staging 不存在 |
| 5 | 決定第一次 staging 部署時點 | 待 Roy（預設 S01 出場後） | 現在先做 | S01 出場前 | 切片 S02 起的瀏覽器驗收環境不確定 |
| 6 | DNS `fju.roy422.dev` A 記錄（灰雲） | 已實際確認：無 A／AAAA 記錄 | 第一次 staging 前 | SOP 01 執行當天 | Caddy 拿不到憑證；OAuth redirect 無法驗證 |
| 7 | Google Cloud 專案與 OAuth client | 尚未確認（本機無 gcloud；文件只記 redirect URI 與「Roy 帳號建立」） | 第一次 staging 前 | SOP 02 執行當天 | Google 登入、連結、Roy 人工三案 |
| 8 | Cloudflare Turnstile widget | 尚未確認（文件只寫「建立 site」） | 第一次 staging 前 | SOP 02 執行當天 | 註冊頁、登入失敗 5 次後的驗證；local／CI 用測試金鑰不受影響 |
| 9 | VM 上的三份 `.env` 與資料庫密碼、Better Auth secret | 尚未確認（本輪未連 VM；文件無紀錄） | 第一次 staging 前 | SOP 02 執行當天 | app、worker、migrate 都起不來 |
| 10 | GHCR 讀取憑證（VM `docker login`）與 Actions 推映像權限 | 尚未確認（token 無 packages scope，本機查不到 GHCR 套件；尚無映像） | 第一次 staging 前 | SOP 03 第一次部署 | `docker compose pull` 失敗 |
| 11 | GitHub Actions Secrets 與 environment（CD 接上時；approval 為 Roy 親自 dispatch） | 已實際確認：0 secrets、0 environments | 第一次 staging 前（可延到 CD 接上時） | CD 從 dry-run 改為真部署前 | 只影響 CD；手動 `deploy.sh` 不受影響 |
| 12 | Cloudflare R2 bucket、lifecycle、API token | 尚未確認（文件記 `fju-db-backup`、30 天；wrangler 未登入無法查） | 備份整合前 | S14 之前，最晚 S12 出場後 | 每日備份、FIL-05 還原演練 |
| 13 | age 備份加密金鑰對與私鑰保管、校方第二把鑰匙 | 尚未確認（本機無 age 且文件未記任何公鑰；不證明未產生） | 備份整合前 | 同上 | 備份無法加密；還原演練無法解密 |
| 14 | VM 安裝 rclone、age（SOP 01 補項） | 尚未確認（本輪未連 VM） | 備份整合前 | 同上 | 備份服務容器或 cron 無法跑 |
| 15 | 維運告警通道（health cron、備份失敗、磁碟） | 僅文件記載（「寄 Roy」但沒有寄送機制） | 備份整合前 | S14 出場前 | SOP 05 無法驗收；契約 05 §8 空談 |
| 16 | 正式網域與 DNS 控制權（校方，TBD-01） | 僅文件記載（校方網域由玉姐管理） | 正式開放前 | 正式 Gate G7 前 | 正式網址、OAuth 與 Turnstile 的正式 hostname |
| 17 | OAuth 同意畫面由 Testing 轉正式、校方 Google 帳號歸屬 | 尚未確認 | 正式開放前 | 正式 Gate G7 前 | Testing 狀態下名單外使用者能否登入：本專案只要 `openid`／`email`／`profile`，官方明列例外，結果以 staging 實測記錄（NOT_RUN），不預先斷言失敗；正式前仍需轉 In production、核對品牌驗證與校方 Workspace 政策 |
| 18 | 本專案資源與金鑰交接校方（正式網域記錄、R2、Turnstile、Google Cloud 專案、GitHub repo、VM、密碼管理器條目） | 尚未建立交接文件；接手人員尚未確認 | 正式開放前 | 正式 Gate G6／G7 前 | 校方無法自行維運；備份私鑰只在 Roy 手上 |

## 2. 現在先做

### 2.1 GitHub repo 保護、Environments、Actions 權限
1. **現況**：已實際確認（2026-09-12 `gh`）：`roy4222/fju-im-project` private、default branch `main`、`allow_auto_merge=false`、`delete_branch_on_merge=false`；`branches/main/protection` 回 404；`gh secret list`、`gh variable list`、environments、workflows 全部 0；本機 `gh` 登入 `roy4222`，token scopes `gist, read:org, repo, workflow`。**帳號方案尚未確認**；本 repo 是 private，各能力的方案限制不同（依 GitHub 官方「Deployments and environments」與方案說明；2026-09-13 核對）：

| 能力 | public repo | private repo（本專案） | 本專案的做法 |
|---|---|---|---|
| branch protection／rulesets | 所有方案 | Pro（個人）／Team／Enterprise；Free 不可 | 方案支援才設；否則書面約定「main 只經 PR、CI 綠燈由 Roy 確認」 |
| environments、environment secrets、deployment branches | 所有方案 | Pro／Team／Enterprise；Free 不可 | 方案支援才建 `staging`／`production`；否則 Secrets 放 repository 層級 |
| deployment protection rules：required reviewers、wait timer | 所有方案 | **只有 Enterprise** | 不使用；approval 一律＝Roy 親自觸發 `workflow_dispatch`（或手動 SSH 執行 `deploy.sh`），`cd.yml` 不接 push 觸發 |

本清單不預設方案；先由 Roy 回報方案名稱再決定前兩列。
2. **帳號**：GitHub `roy4222`（Roy 個人）。交接：正式開放前把 repo 轉到校方 GitHub organization（或校方帳號）並重設 Secrets；轉移後所有 GHCR 映像路徑改變，SOP 03 的 `ghcr.io/<owner>` 隨之更新。
3. **Roy 親自**：（0）先看 Settings → Billing and plans 確認方案，回報「Free／Pro／Team／Enterprise」；（a）branch protection：Pro／Team 以上才在 Settings → Branches（或 Rulesets）新增 `main` 規則（require PR、require status checks——S00 的 `ci.yml` 第一次跑過後才能勾選 check 名稱、禁止 force push）；Free 不設規則、不把 repo 改公開，改為書面約定「main 只經 PR 合併、CI 綠燈由 Roy 確認」，契約 05 §2 標 pending 並註明原因；（b）environments：Pro／Team 以上才建 `staging` 與 `production`（等 SOP 06 才用）並把 Secrets 放在 environment；Free 則 Secrets 放 repository 層級；（c）**required reviewers 不設**（private repo 需 Enterprise）：不論方案，部署 approval 都是 Roy 親自觸發 `workflow_dispatch`（或手動 SSH 執行 `deploy.sh`），`cd.yml` 不接 push 觸發；（d）不調整 Actions 的 workflow 預設權限：推映像的 job 在 `cd.yml` 內宣告 `permissions: {contents: read, packages: write}`（Fable 寫）；（e）勾 `delete_branch_on_merge`（可選）。
4. **Fable 可先備**：S00 的 `ci.yml`（七道 job 名稱固定）、`cd.yml`（`workflow_dispatch`＋`--dry-run`）、`health-cron.yml`；一份 `gh api` 指令稿讓 Roy 貼上執行（不含任何秘密）。
5. **精確設定值**：required checks 名稱固定為 `typecheck`、`lint`、`unit`、`integration`、`build`、`e2e-smoke`、`audit`（契約 05 §2；S00 的「六道」指前六道，`audit` 也是 required，本輪已統一寫法）；environment 名稱 `staging`、`production`；映像 `ghcr.io/roy4222/fju-web:<sha>`（repo 轉移後改 owner）。
6. **最晚**：方案確認在 S00 開工前；branch protection（若可用）在 S00 第一個 `web/` PR 合併前；environments（若可用）在 CD 接上前；人工 approval 流程從第一次 staging 部署起生效。未完成或方案不支援：契約 05 §2 的「main 只接受 PR」只能標 pending 或改為書面約定。
7. **驗證與證據**：方案名稱一句話；方案支援時 `gh api repos/roy4222/fju-im-project/branches/main/protection` 回 200 且列出規則、`gh api repos/roy4222/fju-im-project/environments` 列出名稱；不支援時記錄「不可用、改書面約定」；required reviewers 一律記錄「不使用，approval＝Roy dispatch」；輸出（無秘密）貼到 SOP 02 的執行紀錄與 S00 卡「狀態」。

### 2.2 Google 測試身分
1. **現況**：尚未確認。人工案例 ACC-13（Google 註冊）、ACC-16（同人兩種登入方式）、ACC-18（搶綁拒絕與補密碼）與老師 Google 預授權首次登入，都需要真的 Google 帳號；主線改為全部密碼註冊（P02 v1.1），Google 只在分支 B01 由 Roy 執行。
2. **帳號**：Roy 自備的 Google 帳號 A、B（建議加 C 給老師預授權路徑）；不用系上任何人的真實帳號。交接：測試帳號不交接，正式後由真實使用者登入。
3. **Roy 親自**：準備帳號 A、B（、C），能收登入驗證；OAuth 同意畫面在 Testing 模式時把三個信箱加入 test users（見 §3.2）。
4. **Fable 可先備**：B01 v1.1 的 R0–R3 步驟已寫（SG1 以 A 用 Google 註冊；SG2 以 B 的信箱密碼註冊後連結 Google；SG2 嘗試連結 A → `ACCOUNT_LINK_CONFLICT`；SG1 設密碼）。
5. **精確設定值**：三個信箱只寫進 Google Cloud 的 test users 清單與 Roy 的密碼管理器，不寫進文件。
6. **最晚**：B01 執行前（完整年度跑到 P02 後即可做）；未完成：ACC-13、16、18 維持 BLOCKED（人工）。
7. **驗證與證據**：B01 R0–R3 的畫面截圖（信箱遮罩）與 `accounts` 表 provider 欄輸出（無 token）。

### 2.3 Cloudflare 帳號與 `roy422.dev` zone 權限
1. **現況**：已實際確認 `dig roy422.dev NS` → `harmony.ns.cloudflare.com`、`james.ns.cloudflare.com`（zone 在 Cloudflare）；`wrangler 4.4.0` 已裝但 `wrangler whoami` 為 Not logged in（Codex 同日相同結果）；本機無 `CLOUDFLARE_*`／`CF_*` 環境變數；zone 屬於哪個 Cloudflare 帳號**僅文件記載**（推定 Roy 個人帳號）。
2. **帳號**：Cloudflare（Roy 個人）。交接範圍只限**本專案資源**：正式網域（校方網域）的 DNS 記錄、R2 bucket `fju-db-backup`、Turnstile widget；`roy422.dev` 是 Roy 的個人 zone，不列入交接，正式改用校方網域後只需移除 `fju`／`b1`／`b2` 三筆記錄。校方若自建 Cloudflare 帳號，由 Roy 依本清單重建資源。
3. **Roy 親自**：登入 Cloudflare dashboard，確認 `roy422.dev` 在自己帳號下且可編輯 DNS；不需要現在建立 API token（DNS 記錄、Turnstile、R2 都可在 dashboard 手動完成；若 Roy 想用 `wrangler`，`wrangler login` 由 Roy 在自己終端機執行，登入狀態只在 Roy 的機器）。
4. **Fable 可先備**：DNS 記錄值、Turnstile 與 R2 的建立清單（本文 §3.1、§3.3、§4.1）。
5. **精確設定值**：zone `roy422.dev`；不啟用 proxy（灰雲），TLS 由 Caddy 在 VM 上簽發（母 spec §4.1、SOP 01）。
6. **最晚**：§3.1 DNS 記錄之前。未完成：DNS、Turnstile、R2 都無法開始。
7. **驗證與證據**：Roy 回報「zone 在帳號 X 下可編輯」一句話即可（不需截圖帳號 ID）；後續以 §3.1 的 `dig` 結果為證。

### 2.4 校方 VM 可連線、sudo、對外連線、對內 80／443
1. **現況**：僅文件記載（`📍 目前進度.md`、母 spec §4.1）：IP `140.136.155.167`、Ubuntu 24.04.4、4 核／7.8 GB／97 GB（可用 85 GB）、2026-09-11 快照時可連 GHCR；本機 `~/.ssh/config` 沒有任何指向此 IP 的 Host 別名（已實際確認）；SSH 可連、sudo、對外 443、校方防火牆對內 80／443 都**尚未確認**（本輪沒有嘗試連線）。
2. **帳號**：VM 的 Linux 帳號（Roy 持 sudo 密碼）；校方網路單位負責對內 port。交接：正式前把 VM 帳號、sudo 與 `deploy` 使用者的 key 交給校方指定人員；Roy 的 key 移除。
3. **Roy 親自**：（a）在自己的機器 `ssh` 登入一次，確認 `sudo -v` 可用；（b）在 VM 執行 `curl -sI https://ghcr.io | head -1`、`curl -sI https://accounts.google.com | head -1`、`curl -sI https://<accountid>.r2.cloudflarestorage.com | head -1`（先用任一 Cloudflare 網址代替）確認對外 443；（c）向校方申請對 `140.136.155.167` 開放 Internet 端 80／443（Let's Encrypt HTTP-01 與網站本身都需要），並詢問是否有校內出口 proxy；（d）新增 `deploy` 使用者與 `authorized_keys`（SOP 01 腳本）。
4. **Fable 可先備**：SOP 01 v2 全部命令與一份 `~/.ssh/config` 範本（`Host fju-vm`、`HostName 140.136.155.167`、`User <roy>`；不含 key）。
5. **精確設定值**：ufw 只開 22、80、443；目錄 `/srv/fju/{files,tmp,backups,postgres,app,branches}`；`deploy` 使用者屬於 `docker` 群組。
6. **最晚**：第一次 staging 部署前；校方開 port 需要前置作業時間，建議現在就送申請。未完成：SOP 01 無法開始，staging 不存在，S02 起的瀏覽器驗收只能在 local。
7. **驗證與證據**：`ssh fju-vm 'uname -a; sudo -n true && echo sudo-ok; curl -sI https://ghcr.io | head -1'` 的輸出（去掉主機金鑰指紋以外的敏感內容）貼入 SOP 01 執行紀錄；校方開 port 的回覆信件日期。

### 2.5 決定第一次 staging 部署時點
待 Roy 決定；預設 S01 出場後（契約 04 §5、契約 05 §1）。Codex 建議先把 S01 的 local 操作證據做齊再接 VM。決定後 Fable 更新契約 04 §5、切片總圖與 S14 卡。這是排程決定，不是本文的四項技術選擇之一。

## 3. 第一次 staging 部署前（SOP 01–03）

### 3.1 DNS `fju.roy422.dev` A 記錄
1. **現況**：已實際確認 `dig +short fju.roy422.dev A／AAAA` 皆為空；`staging.fju.roy422.dev` 也無記錄；`curl -I https://fju.roy422.dev` 無回應。
2. **帳號**：Cloudflare（Roy）。交接：正式網域由校方 DNS（§5.1）。
3. **Roy 親自**：在 Cloudflare dashboard 新增 A 記錄。
4. **Fable 可先備**：本項設定值；SOP 01 的 Caddy 檢查命令。
5. **精確設定值**：type A、name `fju`、content `140.136.155.167`、proxy **off**（灰雲）、TTL auto；不建 AAAA；staging 與正式共用此名稱（原地轉正，SOP 06），不另建 `staging.` 子網域；**分支副本插槽**：另加兩筆 A 記錄 `b1`、`b2`（同 IP、灰雲），供隔離副本以 `https://b1.fju.roy422.dev`／`https://b2.fju.roy422.dev` 對外（Caddy 依 host 轉到副本；只用 443，不開任意 port；SOP 04 步驟 5）。
6. **最晚**：SOP 01 執行當天（Caddy 啟動前）。未完成：Caddy 拿不到憑證，站台無 HTTPS，OAuth redirect 驗證失敗。
7. **驗證與證據**：`dig +short fju.roy422.dev A`、`dig +short b1.fju.roy422.dev A`、`dig +short b2.fju.roy422.dev A` 都回 `140.136.155.167`；`docker compose logs caddy` 出現 certificate obtained；兩段輸出貼入 SOP 01 執行紀錄。

### 3.2 Google Cloud 專案與 OAuth client
1. **現況**：尚未確認（本機沒有 gcloud，無法查；文件只記 redirect URI 與「以 Roy 帳號建立」）。
2. **帳號**：Google Cloud（Roy 個人 Google 帳號）。交接：正式前把專案擁有者加上校方 Google 帳號（或校方另建 client 後換 `.env`）；client secret 在交接時輪換。
3. **Roy 親自**：（a）建立 Google Cloud 專案；（b）OAuth consent screen：User type External、App name 「輔大資管系專題網站（測試）」、support email 與 developer contact 用 Roy 信箱、scopes 只勾 `openid`、`email`、`profile`、Publishing status 先 **Testing** 並加入 §2.2 的測試信箱為 test users；（c）Credentials → OAuth client ID → Web application；（d）把 client ID 與 client secret 交到 VM `.env`（SOP 02，Roy 在 VM 上編輯，不經聊天）。
4. **Fable 可先備**：Better Auth Google provider 設定碼（S01）；`.env.example` 變數名；contract 03 §2 的路由矩陣測試。
5. **精確設定值**：Authorized JavaScript origins `https://fju.roy422.dev`、`https://b1.fju.roy422.dev`、`https://b2.fju.roy422.dev`；Authorized redirect URIs `https://fju.roy422.dev/api/auth/callback/google`、`https://b1.fju.roy422.dev/api/auth/callback/google`、`https://b2.fju.roy422.dev/api/auth/callback/google`（Better Auth 預設路徑；插槽供隔離副本的 B01 Google 登入，callback 落在副本本身；staging 與正式同 client，正式網域時再加一組）；本機開發另加 `http://localhost:3000` 與 `http://localhost:3000/api/auth/callback/google`；環境變數名固定 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`（本輪定名，SOP 02 同步）。
6. **最晚**：SOP 02 執行當天；未完成：Google 登入按鈕出現但回錯誤，ACC-13、16、18 與老師 Google 預授權都不能做；密碼登入不受影響。
7. **驗證與證據**：staging 上以測試信箱 A 走一次 Google 登入到等待審核頁的截圖（信箱遮罩）；consent screen 的 Testing 狀態截圖；client ID 可記錄（公開值），secret 不記。

### 3.3 Cloudflare Turnstile
1. **現況**：尚未確認（無法從本機查詢；文件只寫「建立 site，填 site key／secret」）。
2. **帳號**：Cloudflare（Roy）。交接：同 §2.3。
3. **Roy 親自**：Turnstile → Add widget → hostname `fju.roy422.dev`、`b1.fju.roy422.dev`、`b2.fju.roy422.dev`（正式網域時再加）、widget mode **Managed**；把 site key 與 secret key 填入 VM `.env`。
4. **Fable 可先備**：契約 03 §7 的 siteverify 驗證碼與受控 adapter 測試；local／CI 使用 Cloudflare 官方測試金鑰（永遠通過與永遠失敗兩組），不需 Roy。
5. **精確設定值**：變數名 `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`（本輪定名）；使用位置：密碼註冊、連續登入失敗 5 次後；`action` 值 `register`（密碼註冊）、`login`（連續登入失敗 5 次後）；與契約 03 §7 後端比對值一致，直接請求測試也用同值。
6. **最晚**：SOP 02 執行當天。未完成：staging 註冊頁的真實 Turnstile 無法驗；可暫用測試金鑰但案例標 BLOCKED（人工）直到換真金鑰重測。
7. **驗證與證據**：staging 註冊頁 widget 顯示與一次成功註冊的回執（含 requestId）；Cloudflare Turnstile analytics 有計數的截圖。

### 3.4 VM 上的三份 `.env`、資料庫密碼、Better Auth secret
1. **現況**：尚未確認（本輪未連 VM；文件沒有任何 env 紀錄；本機工具缺失不證明 VM 上不存在）。
2. **帳號**：VM `deploy` 使用者（Roy 建立）；密碼與 secret 只在 VM 檔案（600）與 Roy 密碼管理器。交接：正式前輪換三個 DB 密碼與 `BETTER_AUTH_SECRET` 並交給校方。
3. **Roy 親自**：在 VM 上執行 SOP 02 腳本產生三個 DB 密碼與 `BETTER_AUTH_SECRET`（`openssl rand -base64 32`），寫入 `/srv/fju/app/.env.migrate`、`.env`、`.env.backup`（600），並把值存入密碼管理器；填入 §3.2、§3.3 的 Google 與 Turnstile 值。
4. **Fable 可先備**：S00 的 `.env.example`（只有變數名）、SOP 02 的產生腳本（輸出直接寫檔，不印到終端機）、Compose 檔的 `env_file` 對應。
5. **精確設定值**：`.env.migrate`：`DATABASE_URL_OWNER`；`.env`：`DATABASE_URL`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL=https://fju.roy422.dev`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`、`FILES_ROOT=/srv/fju/files`、`FILE_MAX_BYTES=104857600`、`BUSINESS_CLOCK_OVERRIDE_ENABLED=true`（正式改 false）；`.env.backup`：`DATABASE_URL_BACKUP`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET=fju-db-backup`、`AGE_RECIPIENTS`（一個以上 age 公鑰，逗號分隔）、`ALERT_WEBHOOK_URL`（可空）；隔離副本另覆寫 `BETTER_AUTH_URL=https://b<n>.fju.roy422.dev`（本輪把通配名展開定名；SOP 02 同步）。
6. **最晚**：SOP 02 執行當天。未完成：migrate、app、worker 都起不來。
7. **驗證與證據**：`ls -l /srv/fju/app/.env*` 顯示 600 與擁有者；`docker compose run --rm migrate` 成功輸出的 schema 名稱；`/api/health` 回 200（SOP 03）。

### 3.5 GHCR 讀取憑證與 Actions 推映像權限
1. **現況**：尚未確認：本機 token 沒有 `read:packages`，查不到 GHCR 套件；目前也沒有任何映像（CI 尚未存在）。
2. **帳號**：GitHub `roy4222`。推映像用 Actions 的 `GITHUB_TOKEN`，在 `cd.yml` 推映像的 job 宣告 `permissions: {contents: read, packages: write}`（不放大 workflow 預設權限）；VM 拉映像需要一個 **classic** PAT（scope 只勾 `read:packages`；GitHub Packages 目前不支援 fine-grained token），只存在 VM 的 `docker login` 設定檔。交接：repo 轉校方後重發。
3. **Roy 親自**：建立 classic PAT（名稱 `fju-vm-ghcr-pull`，scope 僅 `read:packages`，到期 90 天並記到行事曆）；在 VM 以 `deploy` 使用者 `docker login ghcr.io`（token 從剪貼簿貼，不寫檔）。
4. **Fable 可先備**：`cd.yml` 推映像 job、SOP 03 的 pull／deploy 腳本。
5. **精確設定值**：套件可見性 private（跟 repo）；映像名 `ghcr.io/roy4222/fju-web`；tag `<git sha>` 與 digest 記在 `.deploy/previous_tag`。
6. **最晚**：SOP 03 第一次部署前。未完成：`docker compose pull` 失敗；可暫以 VM 本地 build 頂替（不建議，7.8 GB RAM）。
7. **驗證與證據**：`docker pull ghcr.io/roy4222/fju-web:<sha>` 成功輸出（digest）；PAT 到期日記在 SOP 02 執行紀錄。

### 3.6 GitHub Actions Secrets 與 environment（CD 接上時；approval 為人工 dispatch）
1. **現況**：已實際確認 0 secrets、0 environments；environments／environment secrets 是否可用取決於 §2.1 的方案（private repo 需 Pro／Team）；required reviewers 在 private repo 只有 Enterprise 才有，本專案不論方案都用 Roy 親自 dispatch 作 approval。CD 在 S00 只 dry-run，不需要這些值；第一次 staging 部署可以由 Roy 手動 SSH 執行 `deploy.sh`，Secrets 可延到 CD 真正接上。
2. **帳號**：GitHub `roy4222`；SSH 部署金鑰由 Roy 產生（私鑰只放 GitHub Secret，公鑰放 VM `deploy` 使用者）。交接：repo 轉校方後重建。
3. **Roy 親自**：`ssh-keygen -t ed25519 -f fju-deploy -C fju-deploy`（本機）；公鑰加到 VM `deploy` 的 `authorized_keys`；在 environment `staging`（方案不支援 environments 時放 repository 層級）建 Secrets `VM_SSH_KEY`（私鑰內容）、`VM_HOST`、`VM_USER`；用完刪除本機私鑰檔。
4. **Fable 可先備**：`cd.yml` 的 environment 綁定與 `--dry-run` 切換；SOP 03。
5. **精確設定值**：Secrets 名稱固定 `VM_SSH_KEY`、`VM_HOST=140.136.155.167`、`VM_USER=deploy`；`GHCR_TOKEN` 不再需要（改用 `GITHUB_TOKEN`；SOP 02 同步刪除）；不設 required reviewers（private repo 需 Enterprise）；approval＝Roy 親自觸發 `workflow_dispatch`（或手動 SSH 執行 `deploy.sh`），`cd.yml` 不接 push 觸發。
6. **最晚**：CD 從 dry-run 改真部署前；未完成：只影響 CD，手動部署不受影響。
7. **驗證與證據**：`gh secret list -R roy4222/fju-im-project -e staging` 列出三個名稱；一次 `workflow_dispatch` 的 dry-run 成功 run URL。

## 4. 備份整合前（S14 之前，最晚 S12 出場後；SOP 04）

### 4.1 Cloudflare R2 bucket、lifecycle、API token
1. **現況**：尚未確認（wrangler 未登入無法列 bucket；文件記 bucket `fju-db-backup`、lifecycle 30 天、「唯寫 token」）。
2. **帳號**：Cloudflare（Roy）；R2 需先在帳號啟用（可能要求綁付款方式，免費額度 10 GB 儲存，每日一份 DB 備份 30 天遠低於此）。交接：正式前把 bucket 移到校方帳號或由校方重建，舊備份 30 天內自然到期。
3. **Roy 親自**：（a）R2 → Create bucket `fju-db-backup`，location hint Asia-Pacific；（b）Settings → Object lifecycle rules：delete objects after 30 days；（c）R2 API token：權限 **Object Read & Write**、只限此 bucket（`rclone copy` 需要 list 與 put，純唯寫不可行，本輪修正文件用語）、TTL 一年並記到行事曆；（d）把 Account ID、Access Key ID、Secret Access Key 填入 VM `.env.backup`。
4. **Fable 可先備**：SOP 04 的 backup 腳本與 rclone 設定範本（remote 名 `r2`，以環境變數提供憑證，不落地 `rclone.conf`）。
5. **精確設定值**：bucket `fju-db-backup`；endpoint `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`；物件鍵 `db/<YYYY-MM-DD>/fju-<timestamp>.dump.age`；變數名見 §3.4。
6. **最晚**：S14 之前、最晚 S12 出場後（S00–S11 的本機與 staging 工作不必等 R2）。未完成：無每日異地備份，FIL-05 無法演練，正式 Gate G6 不開。
7. **驗證與證據**：`rclone lsd r2:` 列出 bucket；第一次備份後 `backup_runs` 有 success 列且 R2 物件列表截圖（鍵名可見，無 token）。

### 4.2 age 備份加密金鑰對、私鑰保管、校方第二把鑰匙
1. **現況**：尚未確認（本機無 `age` 且文件未記錄任何公鑰；不證明 Roy 未產生過）。
2. **帳號**：無平台帳號；私鑰在 Roy 密碼管理器＋離線副本。交接：建議備份同時加密給兩個收件者（`age -r <Roy 公鑰> -r <校方公鑰>`），校方公鑰由校方指定人員自行 `age-keygen` 產生並只交出公鑰；這樣交接時不必重加密舊備份。
3. **Roy 親自**：本機 `brew install age`；`age-keygen -o fju-backup.key`；公鑰行貼到 VM `.env.backup` 的 `AGE_RECIPIENTS`；私鑰內容存密碼管理器與離線媒體後刪除本機檔；向校方要一把公鑰（可延到正式前）。
4. **Fable 可先備**：SOP 04 的加密／解密命令與還原演練步驟；`.env.backup` 只有一個變數 `AGE_RECIPIENTS`（一個以上公鑰，逗號分隔；SOP 02／04 與契約 05 同名）。
5. **精確設定值**：`AGE_RECIPIENTS=<age1...>[,<age1...>]`；解密只在還原演練機器上用 Roy 私鑰。
6. **最晚**：同 §4.1。未完成：備份不加密不得上傳 R2（契約 05 §7）。
7. **驗證與證據**：以 1 KB 測試檔 `age -r` 加密後 `age -d` 還原成功的輸出；第一次還原演練 `restore_drills` 列。

### 4.3 VM 安裝 rclone、age（SOP 01 補項）
1. **現況**：尚未確認（本輪未連 VM；SOP 01 目前只裝 docker、compose plugin、ufw；backup 容器內也可自帶，二選一）。
2. **帳號**：VM sudo（Roy）。
3. **Roy 親自**：執行 SOP 01 補項 `sudo apt install -y rclone age`（或採 backup 容器映像自帶，Fable 在 S14 定案）。
4. **Fable 可先備**：backup 服務的 Dockerfile（自帶 `pg_dump`、`age`、`rclone`），讓 VM 不必另裝。
5. **精確設定值**：以容器自帶為預設；VM 只需 docker。
6. **最晚**：同 §4.1。
7. **驗證與證據**：`docker compose run --rm backup --check` 輸出三個工具版本。

### 4.4 維運告警通道
1. **現況**：僅文件記載（SOP 05：health cron「寄 Roy」、磁碟 80％ 站內通知＋Email、備份失敗站內通知＋Roy Email），但沒有任何寄送機制，產品 Email 又延後；契約 05 §8 要求「告警通道與產品 Email 分開」。
2. **帳號**：GitHub（Actions 通知信）＋ Roy 決定的第二通道。交接：通道改指校方人員。
3. **Roy 親自**：（a）GitHub Settings → Notifications → Actions：開啟「Send notifications for failed workflows only」（health-cron 失敗即寄信，零設定）；（b）決定第二通道：Discord webhook（免費、5 分鐘可設）或不設；若設，webhook URL 放 GitHub Secret `ALERT_WEBHOOK_URL` 與 VM `.env.backup`。
4. **Fable 可先備**：`health-cron.yml` 失敗即紅燈的寫法；備份與磁碟告警的 webhook 發送碼（有 URL 才啟用，否則只站內通知）。
5. **精確設定值**：`ALERT_WEBHOOK_URL`（可空）；health cron 每 5 分鐘、連續 3 次失敗才告警。
6. **最晚**：S14 出場前。未完成：SOP 05 無法驗收。
7. **驗證與證據**：故意讓 health cron 打錯網址一次的失敗通知截圖；恢復後的成功 run。

## 5. 正式開放前（Gate G6／G7）

### 5.1 正式網域與 DNS 控制權（校方，TBD-01）
1. **現況**：僅文件記載（校方網域由玉姐管理；正式網域名稱待校方）。
2. **帳號**：校方 DNS（`fju.edu.tw` 由校方自己的 DNS 伺服器服務，不在 Cloudflare）。
3. **Roy 親自**：向校方確認正式主機名（例如 `project.im.fju.edu.tw`，待定）、申請 A 記錄指向 `140.136.155.167`、確認校方是否允許 Let's Encrypt HTTP-01（否則需校方核發憑證交 Caddy 使用）。
4. **Fable 可先備**：SOP 06 的 Caddy 網域更新與 OAuth／Turnstile 追加 hostname 清單。
5. **精確設定值**：待正式主機名確定後填入 SOP 06。
6. **最晚**：正式 Gate G7 前；未完成：只能以 `fju.roy422.dev` 開放。
7. **驗證與證據**：`dig` 結果與 Caddy 憑證日誌。

### 5.2 OAuth 同意畫面轉正式與校方 Google 帳號歸屬
1. **現況**：尚未確認。
2. **帳號**：Google Cloud（Roy → 校方）。
3. **Roy 親自**：依 Google 官方「OAuth app publishing status」：外部 app 在 Testing 狀態一般只開放給 test users（上限 100 人）且 refresh token 七天到期；官方同時明列**基本 scope 例外**——只要求 `openid`、`email`、`profile` 的 app 不受 test-user 名單限制、refresh token 也不會七天到期，本專案屬此類。所以三件事分開記錄：（a）名單外使用者實際能否登入：以 staging 實測為準，結果記入 run manifest（目前 NOT_RUN），文件不預先斷言成功或失敗；（b）品牌驗證（brand verification）：正式開放前核對是否需要，不宣稱「完全不需任何驗證」；（c）校方 Workspace 的第三方 app 管理政策：校方帳號可能被組織設定擋下，需向校方確認。正式開放前把 Publishing status 改為 In production；把校方 Google 帳號加為專案 Owner；正式網域的 origin／redirect URI 加入 client。
4. **Fable 可先備**：SOP 06 檢核項。
5. **精確設定值**：同 §3.2 加正式網域。
6. **最晚**：正式 Gate G7 前。未完成：仍是 Testing 狀態；名單外使用者的登入結果只能靠 staging 實測記錄，不預先斷言；密碼註冊不受影響。
7. **驗證與證據**：consent screen 狀態截圖；一個非測試信箱成功登入到等待審核頁（信箱遮罩）。

### 5.3 平台帳號與金鑰交接校方
1. **現況**：尚未建立任何交接文件。
2. **帳號**：Cloudflare 上本專案的資源（正式網域記錄、R2 bucket、Turnstile widget；`roy422.dev` 個人 zone 不在範圍）、Google Cloud 專案、GitHub repo 與 GHCR、VM 帳號、密碼管理器條目（A1、三個 DB 密碼、Better Auth secret、age 私鑰、PAT）。
3. **Roy 親自**：與校方確定接手人員與帳號；逐項轉移或重建；輪換所有秘密；移除 Roy 的 key 與 token。
4. **Fable 可先備**：交接清單範本（本文 §1 的 18 項加狀態欄）與 SOP 06 檢核。
5. **精確設定值**：交接完成標準＝校方人員能獨立完成一次部署（SOP 03）與一次還原演練（SOP 04）。
6. **最晚**：正式 Gate G6／G7 前。未完成：校方無法自行維運。
7. **驗證與證據**：校方人員執行 SOP 03、04 的執行紀錄。

## 6. 推薦順序（Roy 本人操作，估計時間）

1. §2.1 先確認 GitHub 方案，再依方案設保護與 environments 或改書面約定（10 分鐘）。
2. §2.3 Cloudflare 登入確認 zone → §3.1 新增 `fju`、`b1`、`b2` 三筆 A 記錄（5 分鐘；提早做無害）。
3. §2.4 VM SSH／sudo／對外連線確認（15 分鐘）＋ 向校方送對內 80／443 申請（有前置作業時間，越早越好）。
4. §2.2 準備 Google 測試信箱 → §3.2 Google Cloud 專案、同意畫面、OAuth client（三組 origin／redirect URI）、test users（20 分鐘）。
5. §3.3 Turnstile widget（5 分鐘）。
6. §2.5 決定第一次 staging 部署時點；到時執行 §3.4、§3.5（SOP 01–03，Fable 陪同，約 1 小時）。
7. §4.1 R2、§4.2 age、§4.4 告警通道（30 分鐘；S12 出場前）。
8. §5 正式網域與交接（與校方時程綁定）。

## 7. 四項待 Roy 決定的技術選擇（與登入／開通待辦分開）

| # | 選擇 | 目前預設（未核准） | 影響的文件 | 需要決定的時點 |
|---|---|---|---|---|
| T1 | runtime 資料庫角色是否拆成 app 與 worker 兩個 | 共用 `fju_app`；逐表權限矩陣已完整（契約 01 §5 v2.1） | 母 spec §4.6、契約 01 §5、契約 05 §6、S00 | S00 第一支 migration 前（拆分可延後加角色，不阻塞） |
| T2 | CSP 方案 | A：全站動態渲染＋nonce＋`strict-dynamic` | 母 spec §4.15、契約 02 §9、契約 03 §6 | S00 骨架前 |
| T3 | 自動測試主要接縫 | Codex 建議：application 用例＋真 PostgreSQL | 母 spec §5、契約 04 §2 | S00 的測試骨架前 |
| T4 | ADR 0005（單機 outbox 與到期工作）是否 accepted | proposed；前提：契約已寫入且 S02 整合測試通過 | ADR 0005、母 spec §4.10 | S02 出場時 |

第一次 staging 部署時點（§2.5）與 branch protection（§2.1）是排程與設定動作，不在此四項內。
