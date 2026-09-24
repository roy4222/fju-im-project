# VM 兩站：Roy 的操作清單

同一台 VM（`140.136.155.167`，Ubuntu 24.04）跑兩個站：

| 站 | 網址 | Compose project | Doppler config | 怎麼更新 |
|---|---|---|---|---|
| 測試站 | https://test.fju.roy422.dev | `fju-test` | `stg` | **自動**：main 合併、映像推上 GHCR 後，約 2–5 分鐘內 VM 自己部署 |
| 正式站 | https://fju.roy422.dev | `fju-prod` | `prd` | **只能手動**：Roy 看過測試站後，把同一個版本推上去 |

兩站各有自己的資料庫與附件目錄，互不影響；前面共用一個 Caddy（`fju-edge`）負責 HTTPS 憑證與依網址分流。

秘密（資料庫密碼、Google 金鑰……）只存在 Doppler。VM 上每站放一把**唯讀** service token，
腳本用它把秘密放進記憶體裡的環境變數交給容器——不寫成 `.env` 檔、不印到螢幕、不進 repo。

> 下面每個指令框都可以整段複製貼上。標「💻 Mac」的在你自己的電腦跑，標「🖥️ VM」的先 `ssh fju-vm` 再跑。
> `sudo -u deploy …` 會沿用你目前的目錄，而 deploy 讀不到你的家目錄，所以第 4 步以後的指令框開頭都先 `cd /srv/fju/app`。
> `deploy.sh --execute`、`seed-admin.sh`、`auto-deploy.sh`、`site.sh`、`backup.sh`、`restore-drill.sh` 不是 deploy 身分就一開始停下（什麼都不寫），
> 並提示改用 `sudo -u deploy …`——免得用 root 跑留下 deploy 寫不進去的檔。`deploy.sh` 的演練（不帶 `--execute`）與各腳本的 `--help` 誰都能跑。
> 要換成你自己的值的地方用 `<尖括號>` 標出來。

---

## 第一次設定（照順序做，共 12 步）

### 1. 💻 把檔案送上 VM

在 repo 根目錄、已經切到**合併後最新的 main**：

```bash
git switch main && git pull
rsync -av --delete docker-compose.yml docker-compose.vm.yml docker-compose.edge.yml docker-compose.drill.yml ops fju-vm:/tmp/fju-app/
```

預期：最後一行是 `total size is …`，沒有 error。（`fju-vm` 是 `ops/ssh-config.example` 那個 SSH 別名。）

### 2. 🖥️ 先看現況（什麼都不會改）

```bash
sudo bash /tmp/fju-app/ops/vm-setup.sh --check
```

預期：開頭印「--check：只看不改」；還沒做的項目是黃色 `→`，磁碟那行是綠色 `✓`。

### 3. 🖥️ 實際設定

```bash
sudo bash /tmp/fju-app/ops/vm-setup.sh
```

它會裝 Docker、Doppler CLI、node、ufw，建 `deploy` 帳號和 `/srv/fju` 底下的目錄，
開防火牆（22 限速、80、443，都是 TCP），建 Docker 網路 `fju-edge`。重跑不會壞任何東西。

### 4. 🖥️ 把 app 檔放到正式位置，再跑一次設定

```bash
sudo rsync -a --delete --chown=deploy:deploy /tmp/fju-app/ /srv/fju/app/
sudo bash /srv/fju/app/ops/vm-setup.sh
```

第二次跑會多做一件事：安裝並啟用測試站自動部署的 timer（第 10 步說明）。
在第 9 步手動部署成功之前，timer 每次醒來都只會說「還沒有手動成功部署過」然後什麼都不做。

### 5. 🖥️ 貼上兩把 Doppler token

先在 Doppler 網頁產生 token：專案 **fju-im-capstone** → config **stg** → **Access** → **Service Tokens** →
**Generate**，名稱 `vm-test`、權限 **Read**。複製那串 `dp.st.stg.…`。

回到 VM 貼上（畫面不會顯示你貼的內容，貼完按 Enter）：

```bash
cd /srv/fju/app
sudo -u deploy bash -c 'umask 077; read -rsp "貼上 stg 的 token 後按 Enter：" t; echo; printf "%s\n" "$t" > /srv/fju/secrets/doppler-test.token && echo 已存檔'
```

同樣產生 config **prd** 的 token（名稱 `vm-prod`），再貼：

```bash
cd /srv/fju/app
sudo -u deploy bash -c 'umask 077; read -rsp "貼上 prd 的 token 後按 Enter：" t; echo; printf "%s\n" "$t" > /srv/fju/secrets/doppler-prod.token && echo 已存檔'
```

確認權限：

```bash
sudo ls -l /srv/fju/secrets/
```

預期兩行都是 `-rw------- 1 deploy deploy`。**不要**用 `cat` 看內容，也不要貼到聊天或 issue。
貼錯站（例如把 prd 的貼進 test）沒關係，下一步的 `check` 會抓出來，重貼即可。

### 6. 🖥️ 讓 VM 能拉 GHCR 上的私有映像

在 GitHub → Settings → Developer settings → **Personal access tokens (classic)** → Generate new token：
名稱 `fju-vm-ghcr-pull`、只勾 **read:packages**、到期 90 天（記到行事曆）。複製 token。

```bash
cd /srv/fju/app
sudo -u deploy docker login ghcr.io -u roy4222
```

Password 那裡貼上 PAT（不會顯示）。預期 `Login Succeeded`。
（Docker 會提醒密碼存在 `/home/deploy/.docker/config.json`——那是只有 deploy 讀得到的檔，可以接受。）

### 7. 🖥️ 核對 Doppler 裡的值長得對不對

我（agent）看不到值，所以這一步要你在 Doppler 網頁上自己對一次。兩個 config 各 16 個鍵，重點：

| 鍵 | stg（測試站） | prd（正式站） |
|---|---|---|
| `BETTER_AUTH_URL` | `https://test.fju.roy422.dev` | `https://fju.roy422.dev` |
| `DATABASE_URL` | `postgres://fju_app:<APP_DB_PASSWORD>@postgres:5432/<POSTGRES_DB>` | 同左，用 prd 自己的值 |
| `DATABASE_URL_OWNER` | `postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@postgres:5432/<POSTGRES_DB>` | 同左 |
| `FILES_ROOT` | 容器裡的路徑，例如 `/srv/fju/files`（每站實際存在 VM 的 `/srv/fju/<站>/files`） | 同左 |
| `BUSINESS_CLOCK_OVERRIDE_ENABLED` | `true` | `false` |

- 連線字串的主機一定是 **`postgres`**（Compose 裡的服務名稱），不是 `localhost`、也不是 `fju-postgres`。
- 密碼只用英數字（例如 `openssl rand -hex 24` 產生），連線字串就不用處理特殊字元。
- `POSTGRES_USER`／`POSTGRES_PASSWORD`／`POSTGRES_DB` **只在第一次建資料庫時生效**；之後改 Doppler 不會改到資料庫。
- `APP_DB_PASSWORD` 每次部署都會被設成 `fju_app` 的密碼，所以它必須跟 `DATABASE_URL` 裡的密碼一樣。
- **`A1_EMAIL`、`A1_INITIAL_PASSWORD` 兩個鍵在 stg 與 prd 都要存在**（第 10、12 步建第一位管理員用）。
  這裡只看**鍵名在不在**，不要把值貼到任何地方；一次性密碼至少 12 個字元。`A1_NAME` 可有可無（沒有就叫「系辦管理員」）。
- **`E2E_ADMIN_EMAIL`、`E2E_ADMIN_PASSWORD` 只放 stg、絕對不要放 prd**（測試站自動驗收用，見下面「測試站自動驗收」）。
  可以先不加；沒有的話部署只會印一行「略過」。

核對完跑：

```bash
sudo -u deploy /srv/fju/app/ops/site.sh test check
sudo -u deploy /srv/fju/app/ops/site.sh prod check
```

預期各印一行 `✓ … 站：token 對應 Doppler config stg／prd，必要的 13 個鍵都有值。`
（`A1_*` 不在這個檢查裡；少了它們的話，第 10 步的 `seed-admin.sh` 會列出缺的鍵名後停下。）

### 8. 🖥️ 起共用的 Caddy，確認兩張憑證

```bash
cd /srv/fju/app
sudo bash /srv/fju/app/ops/vm-setup.sh --check
sudo -u deploy docker compose -f /srv/fju/app/docker-compose.edge.yml up -d
sleep 30
sudo -u deploy docker compose -f /srv/fju/app/docker-compose.edge.yml logs caddy | grep -i "certificate obtained"
```

預期：`--check` 除了 DNS／連線以外都是 `✓`；最後看到**兩行** `certificate obtained`（`fju.roy422.dev` 與 `test.fju.roy422.dev`）。
這時打開兩個網址會看到 502——還沒部署 app，正常。
**沒有憑證就不要往下**：多半是校方還沒開對內 80／443，把 log 存下來問校方。

### 9. 🖥️ 第一次部署測試站（手動）

要部署的版本＝ main 最新 commit 的**完整 SHA**。在 GitHub → Actions → **Image** 最新一次成功的 run，
摘要裡有現成的 SHA；或在 Mac 上 `git rev-parse origin/main`。

```bash
sudo -u deploy /srv/fju/app/ops/deploy.sh --site test <完整SHA> --execute
curl -s https://test.fju.roy422.dev/api/health
```

預期：最後印 `部署完成：test ← <SHA>`；`/api/health` 回 `"ok":true` 且 `commit` 是那個 SHA。
第一次部署沒有前一版可以退，失敗會印「需要人介入」——把整段輸出存下來再處理。

### 10. 🖥️ 建立測試站的第一位管理員（A1）

剛部署好的資料庫是空的，一個帳號都沒有。用 Doppler stg 的 `A1_EMAIL`／`A1_INITIAL_PASSWORD` 建第一位管理員：

```bash
cd /srv/fju/app
sudo -u deploy /srv/fju/app/ops/seed-admin.sh test
```

預期：`A1 已建立：status=active、must_change_password=true、角色 admin。`
接著用那組 email＋一次性密碼登入 https://test.fju.roy422.dev ，會被直接帶去改密碼；改完一次性密碼就失效。

重跑是安全的：帳號已經存在就只印 `A1 已存在（…），不做任何事。`，不會改密碼。
（忘了一次性密碼、或已經改過密碼又忘了，請用系辦的「臨時密碼」功能，不要重跑這步。）

### 11. 🖥️ 確認測試站自動部署在跑

```bash
systemctl list-timers fju-auto-deploy.timer
journalctl -u fju-auto-deploy.service -n 20 --no-pager
```

預期：timer 有「下次執行時間」；journal 最後幾行是 `[auto-deploy] 已是最新（<SHA>），不動作。`
之後每次 main 合併，Image workflow 推完映像幾分鐘內，journal 會出現 `main 有新映像：… 開始部署到 fju-test`。

### 12. 🖥️ 把同一個版本推上正式站，並建正式站的 A1

在測試站看過、覺得可以之後：

```bash
cd /srv/fju/app
sudo -u deploy docker inspect --format '{{.Config.Image}}' fju-test-app
sudo -u deploy /srv/fju/app/ops/deploy.sh --site prod <上一行冒號後面的SHA> --execute
curl -s https://fju.roy422.dev/api/health
sudo -u deploy /srv/fju/app/ops/seed-admin.sh prod
```

預期：`部署完成：prod ← <SHA>`，`/api/health` 的 `commit` 跟測試站相同；最後一行 `A1 已建立`（用 Doppler **prd** 的 A1 值，跟測試站是不同的一次性密碼也沒關係）。
**正式站永遠不會自動更新。**

---

## 日常操作

### 回滾（指定舊版本重新部署）

```bash
sudo tail -n 20 /srv/fju/prod/deploy/deploy_log
sudo -u deploy /srv/fju/app/ops/deploy.sh --site prod <舊的完整SHA> --rollback --execute
```

`deploy_log` 裡 `deployed` 那幾行的第三欄就是之前成功過的 SHA。`--rollback` 只換 app，不動資料庫（資料庫不回滾）。
測試站把 `prod` 換成 `test`；回滾測試站前先暫停自動部署（下一節），不然下次 main 有新映像又會被換掉。

部署途中失敗（啟動不起來或健康檢查沒過）時，`deploy.sh` 會**自己**退回原本那一版，不用手動回滾。

### 暫停／恢復測試站自動部署

```bash
sudo -u deploy touch /srv/fju/test/deploy/auto-deploy.paused   # 暫停
sudo -u deploy rm /srv/fju/test/deploy/auto-deploy.paused      # 恢復
```

要整個關掉：`sudo systemctl disable --now fju-auto-deploy.timer`；重新打開：`sudo systemctl enable --now fju-auto-deploy.timer`。

自動部署的紀錄：`sudo cat /srv/fju/test/deploy/auto-deploy.log`（每行：時間、結果、SHA）。
某個版本自動部署失敗後，同一個 SHA **不會**再自動重試；要重試就 `sudo -u deploy rm /srv/fju/test/deploy/auto-deploy.last`。

### 測試站自動驗收（E2E 測試管理員＋Codex）

目的：讓 Codex 自己上測試站照驗收清單點一遍、截圖、出報告，Roy 只看最後的報告。

**A. 🌐 在 Doppler stg 加兩個鍵（一次）**

Doppler 網頁 → 專案 **fju-im-capstone** → config **stg** → **Add Secret**：

| 鍵 | 要求 |
|---|---|
| `E2E_ADMIN_EMAIL` | 一個**不是任何真人在用**的 email（不會寄信給它，只拿來登入） |
| `E2E_ADMIN_PASSWORD` | **至少 16 個字元**；在自己電腦產生後直接貼進 Doppler（例如 `openssl rand -hex 16`），不要貼到聊天或 issue |

- **只加在 stg**。prd 就算誤加了也不會建（`deploy.sh` 與 `seed-e2e.mjs` 都寫死只認測試站），但部署會印一行提醒你刪掉。
- 建帳號失敗（例如密碼不到 16 字元）**不會擋部署**：新版照常上線，只多一行 `⚠️ 建立 E2E 測試管理員失敗`，
  `deploy_log` 記一列 `e2e-seed-failed`。改好 Doppler 後，下一次部署會再試（已存在就不動）。

**B. 🖥️ 更新 VM 上的腳本（這次 `ops/deploy.sh` 有改）**：照「repo 的 ops／compose 檔改了之後」那一節做一次。

**C. 等下一次測試站部署**（自動，或手動 `deploy.sh --site test <SHA> --execute`）。第 4 步會多一行：

```
E2E 測試管理員已建立：status=active、must_change_password=false、角色 admin（只在測試站）。
```

之後每次部署都會印 `E2E 測試管理員已存在（status=active），不做任何事。`——**已存在就不動**，不會改密碼。
這個帳號名稱是「E2E 測試管理員」，在後台帳號列表一眼認得出來；不需要改密碼就能直接登入。

**D. 💻 在 Mac 跑驗收**

第一次要先裝 Doppler CLI 並登入（你自己的帳號要讀得到 stg）：

```bash
brew install dopplerhq/cli/doppler
doppler login
```

之後每次（在 repo 根目錄）：

```bash
ops/codex-e2e.sh e2e/acceptance/station-1-login.md
```

- 腳本用 `doppler secrets get` 取兩個值，只交給 `codex exec` 這一個行程的環境變數；不印、不寫檔、不進 git。
- 交給 Codex 的環境只留白名單（`PATH`、`HOME`、`USER`、`SHELL`、`TMPDIR`、`LANG`、`LC_*`、`CODEX_HOME`＋兩個 E2E 鍵）：Codex 行程本身先拿掉名單外的變數，它開的 shell 再用 `shell_environment_policy.include_only` 過濾一次，Mac 上其他 API key、token 不會進去。實跑時 npx／Playwright 若缺了哪個變數，加進腳本的 `CODEX_ENV_WHITELIST`。（codex-cli 0.156.1 已把 `include_only` 標為舊鍵；日後若被拿掉會被靜默忽略，但 Codex 行程本身的環境已先剝過，保護不變。）
- Codex（`gpt-6-sol`＋`~/.codex/skills/playwright`）只打 `https://test.fju.roy422.dev`；清單裡出現正式站網址會直接拒絕。
- 結果在 `e2e/acceptance/.out/<時間>-<清單名>/`：`report.md`（每步通過／不通過＋截圖路徑，最後一行 `總結：…`）與 `screenshots/`。這個資料夾已 gitignore。
- 跑完會掃一遍輸出，萬一報告裡出現密碼會自動遮掉並報錯；那時請在 Doppler stg 換**新的 email＋新密碼**（下次部署會建一個新帳號），再到測試站後台停用舊的 E2E 測試管理員。
- 只掃、只遮**密碼**：E2E 帳號的 **email 會出現在登入頁截圖裡**（填表那一步）。它是測試專用信箱，可以接受，但截圖不要貼到公開的地方。
- **第一次實跑後**看一眼 `~/.codex/log/` 有沒有帶到密碼：`grep -rlF -f <(DOPPLER_ENABLE_VERSION_CHECK=false doppler secrets get E2E_ADMIN_PASSWORD --plain --project fju-im-capstone --config stg) ~/.codex/log/`（目錄不存在或沒有輸出＝沒帶到；這樣密碼不進指令列、也不進 shell 歷史）。腳本已用 `--ephemeral` 不留對話紀錄，風險低，但這個資料夾不在自動掃描範圍內。
- 如果 Codex 回報瀏覽器在沙盒裡開不起來：`CODEX_E2E_SANDBOX=danger-full-access ops/codex-e2e.sh <清單>`（Codex 不再受沙盒限制，只在你自己的 Mac 用）。

清單怎麼寫見 [`e2e/acceptance/README.md`](../e2e/acceptance/README.md)。

### 手動備份（票 27）

```bash
cd /srv/fju/app
sudo -u deploy /srv/fju/app/ops/backup.sh --site prod
sudo ls -lh /srv/fju/prod/backups/
```

預期最後印 `✓ 完成：…、… 個項目，sha256 …` 與 `紀錄已寫入 /srv/fju/prod/backups/records.jsonl`。

- 備份檔只存在這台 VM（`/srv/fju/<站>/backups/fju-<站>-<UTC 時間>.dump`，目錄 700、檔案 600，只有 deploy 讀得到）；不排程、不上傳。
- **只備份資料庫**；附件（`/srv/fju/<站>/files`）不在備份裡，VM 硬碟壞了附件救不回來（Roy 已接受）。
- 每次都在同一目錄的 `records.jsonl` 加一筆紀錄（成功：檔名、大小、sha256、各表筆數；失敗：哪一步、錯誤訊息）。
  紀錄只往後加，**失敗不會蓋掉上一次成功**。舊備份檔要清的話手動 `sudo -u deploy rm`，紀錄不用動。

看最近一次成功備份與成功演練（不需要秘密）：

```bash
sudo -u deploy /srv/fju/app/ops/backup.sh --site prod --status
```

### 還原演練（票 27）

把某一份備份還原到一個**獨立的演練副本**（Compose project `fju-drill`），比對筆數後寫一筆紀錄。
副本有自己的資料庫 volume（`fju-drill-pgdata`）與網路（`fju-drill`）、**不發布任何 port、不接 Caddy、沒有 worker**；
兩站的資料庫與 volume 都不會被寫入。不需要 Doppler。

```bash
cd /srv/fju/app
sudo -u deploy /srv/fju/app/ops/restore-drill.sh --site prod --backup latest
```

預期：

```
✓ 隔離核對：只掛 fju-drill-pgdata、只接網路 fju-drill、沒有發布 port、資料庫 fju_drill。
抽查（還原後 vs 備份當下）：
  ✓ 帳號 …  ✓ 組別 …  ✓ 回答版本 …  ✓ 回答內容 md5 相同
  全部 N 張表的筆數都跟備份當下一樣。
✓ 還原演練成功，紀錄已寫入 /srv/fju/prod/backups/records.jsonl
演練副本已移除（要保留看畫面，下次加 --keep --with-app）。
```

- 比對基準是**備份當下**量的各表筆數（記在備份紀錄裡），不是站台現在的資料，所以備份之後有人操作不影響結果。
  評分、簽核的表還沒建；建了之後會自動列進抽查。
- `--backup` 可以給檔名（`fju-prod-20260924T120000Z.dump`）或 `latest`；只接受該站 `backups/` 目錄裡的檔案。
  該站還沒備份過（沒有 `backups/`）會直接說「先跑 `ops/backup.sh`」。
  檔案的 sha256 跟備份當下不同會直接拒絕。
- 票 27 之前做的舊備份沒有紀錄：會改拿站台「現在」的筆數比（唯讀查詢），之後有新資料就會對不上——那種結果要人看過再判斷。
- 失敗也會寫紀錄；沒帶 `--keep` 時，成功或失敗都會把副本整個刪掉（副本裡是真實資料）。

**要看畫面**（例如確認 A1 能登入）：加 `--keep --with-app`（`--with-app` 一定要搭配 `--keep`，只帶 `--with-app` 會直接拒絕）。app 用來源站目前在跑的映像，接演練資料庫：

```bash
cd /srv/fju/app
sudo -u deploy /srv/fju/app/ops/restore-drill.sh --site prod --backup latest --keep --with-app
```

最後會印一行 `ssh -N -L 3999:<容器 IP>:3000 fju-vm`。**在 💻 Mac 另開一個終端機**貼上那行（它會停著不動，是正常的），
再用瀏覽器開 http://localhost:3999/login 。port-forward 走 SSH，VM 防火牆不用開任何 port。

- 副本裡只能用**帳號密碼**登入（Google 登入是假值、會失敗）；來源站的登入狀態在副本裡無效。
- 附件不在備份裡，副本裡下載附件會失敗，這是預期的。
- 只想查資料庫、不用 port-forward：`sudo -u deploy docker exec -it fju-drill-postgres psql -U fju_drill_owner -d fju_drill`。

看完**一定要移除**（副本裡是真實資料；副本還在時也不能開下一次演練）：

```bash
sudo -u deploy /srv/fju/app/ops/restore-drill.sh --remove
```

預期：`✓ 已移除演練副本（fju-drill 的容器、網路與 volume fju-drill-pgdata）。`；Mac 那邊的 ssh 之後連不到東西，按 Ctrl-C 關掉。

### 看狀態與 log

```bash
cd /srv/fju/app
sudo -u deploy /srv/fju/app/ops/site.sh test docker compose ps
sudo -u deploy /srv/fju/app/ops/site.sh test docker compose logs --tail 100 app
sudo -u deploy docker compose -f /srv/fju/app/docker-compose.edge.yml logs --tail 50 caddy
```

`site.sh` 會擋掉 `docker compose config`、`env` 這類會把秘密印出來的指令。

### 背景工作（票 12）上線時要做的一次同步

票 12 起 `worker` 容器是真的背景工作（通知投影、到期工作、停用／恢復核對），`/api/health` 的 `worker` 欄會回報版本與心跳。
**合併票 12 之後、下一次測試站自動部署之前**，照下一節「repo 的 ops／compose 檔改了之後」同步一次，原因有兩個：

1. `docker-compose.yml` 裡 worker 的啟動指令在 VM 那份檔案上；不同步的話，VM 會繼續跑舊的「空進程」，健康檢查看不到心跳。
2. 舊版 `ops/check-health.mjs` 在沒帶 `--expect-worker` 時要求 worker 欄必須是 null；新映像會回報心跳，舊腳本會判失敗並自動回滾。
   新版改成「worker 有回報就一起比對版本與心跳（有心跳即健康），兩欄都是 null（還沒有 worker 的舊映像）才略過」。

來不及同步時的暫時做法：在 fju-auto-deploy 的 timer 環境加 `AUTO_DEPLOY_EXPECT_WORKER=1`（舊腳本帶 `--expect-worker` 也能判過新映像）。
同步完、第一次部署綠了之後，建議保留 `AUTO_DEPLOY_EXPECT_WORKER=1`，讓「worker 沒起來」一定判失敗。

看 worker 有沒有在跑：`curl -s https://test.fju.roy422.dev/api/health` 的 `worker.lastTickAt` 應該是幾秒內的時間；
把 worker 停掉超過 5 分鐘，`ok` 會變 `false`（回 503）。

### 健康判定改成完整六項（票 28）上線時要做的一次同步

票 28 起 `deploy.sh` **預設**就判完整六項：HTTP 200、`commit`、`imageDigest`、`schemaVersion`、
`worker.version`（＝這次的 SHA）、`worker.lastTickAt`（60 秒內）。任一項不符＝部署失敗、自動回滾。

- **不同步也不會出事**：`/api/health` 的欄位完全沒變；VM 上舊的 `check-health.mjs` 看到新映像有 worker 心跳，
  本來就會一起比對 worker 兩項，所以合併後的第一次自動部署照舊會過。
- **同步之後**（照下一節做一次）才真的變成「worker 沒起來一定判失敗」。timer 環境若設過 `AUTO_DEPLOY_EXPECT_WORKER=1`
  可以留著（`--expect-worker` 現在等於預設，無害），也可以拿掉。
- 只有要**回滾到票 12 之前**（還沒有 worker）的舊映像時才加 `--allow-no-worker`：只判前四項，而且 worker 兩欄必須是 null；
  映像其實有 worker 卻帶了這個旗標，一樣判失敗。`deploy_log` 第四欄會記 `limited-no-worker`（平常是 `full`）。

同步之後確認一次：

```bash
cd /srv/fju/app
sudo -u deploy /srv/fju/app/ops/deploy.sh --site test "$(sudo -u deploy docker inspect --format '{{.Config.Image}}' fju-test-app | sed 's/.*://')"
```

預期：演練輸出裡有「健康條件：完整六項」，最後一行 `$ echo "<時間>	deployed	<SHA>	full" …`（這是演練，什麼都不會做）。

### 磁碟用量（票 28）

背景工作每小時量一次附件目錄（`FILES_ROOT`）所在的磁碟，部署後 worker 一起來也會先量一次。
結果顯示在系辦首頁「儲存與備份」磚：用量百分比、等級（正常／**警戒 ≥80%**／危險 ≥90%）、已用／可用、量測時間。
**只看站內、不推播**：到 80% 不發站內通知、不寄信（D-04）。超過 3 小時沒有新量測，磚上會標「量測過期」（多半是 worker 停了）。

- 資料庫在另一個 volume，worker 看不到那顆的剩餘空間，只記資料庫大小；VM 上兩者在同一顆系統碟，所以磚上的百分比就是整顆碟。
- 量測暫存在 `audit_events`（`action='storage.measured'`），等之後建 `storage_stats` 表再搬過去。
- 想立刻重量一次：`sudo -u deploy /srv/fju/app/ops/site.sh test docker compose exec -T worker node migrate/web/dist/worker.mjs --measure-storage-once`

### 故障演練（票 28，只准測試站）

四種故障各一個指令。每次跑完（成功或失敗）都在 `/srv/fju/test/drills/fault-drills.log` 加一行：
時間、演練、pass／fail、映像、細節。**先不帶 `--execute` 看一次步驟**（誰都能跑、什麼都不做），再帶 `--execute` 真的跑。
演練期間腳本拿著測試站的部署鎖，自動部署那一輪會記 `busy`、下一輪再試。`--site prod` 一律拒絕。

```bash
cd /srv/fju/app
sudo -u deploy /srv/fju/app/ops/fault-drill.sh --site test restart --execute        # 約 1 分鐘
sudo -u deploy /srv/fju/app/ops/fault-drill.sh --site test worker-stall --execute   # 約 6 分鐘（要等心跳過期）
sudo -u deploy /srv/fju/app/ops/fault-drill.sh --site test poison --execute         # 約 3 分鐘
sudo -u deploy /srv/fju/app/ops/fault-drill.sh --site test disk80 --execute         # 約 30 秒
```

| 演練 | 做什麼 | 通過的樣子 |
|---|---|---|
| `restart` 服務重啟 | `docker compose restart app worker` | 2 分鐘內完整六項再次通過，`commit` 與 `worker.version` 還是原本那一版 |
| `worker-stall` 背景工作停擺 | 停掉 worker，每 10 秒看一次 `/api/health`；最多等 330 秒後再啟動 | 停掉約 5 分鐘後 `/api/health` 回 **503**、`ok:false`；重新啟動後完整六項恢復 |
| `poison` 毒事件 | 用 psql 插兩件 `test_noop` 到期工作：一件對象種類是 `fault_drill_poison`（處理器一定失敗），一件正常 | 正常那件幾十秒內 `done`；毒工作退避 2／4／8／16 秒後第 5 次標 `failed`，管理員收到 1 則「到期工作失敗 5 次」告警 |
| `disk80` 磁碟 80% | 開一顆 16 MiB 的**記憶體磁碟**塞 14 MiB（~88%），在上面量一次（**不碰真的硬碟**，演練完就刪） | 最新量測是「警戒」、標著演練；通知數沒變。打開 https://test.fju.roy422.dev/dashboard/admin ，「儲存與備份」磚顯示 ~88%、第一段「警戒（≥80%）」、結尾「（故障演練）」 |

`disk80` 看完磚之後把數字換回真的：

```bash
sudo -u deploy /srv/fju/app/ops/fault-drill.sh --site test disk80-restore --execute
```

（不跑也沒關係，下一個整點 worker 自己會量一次蓋過去。）

- `poison` 需要測試站的 `BUSINESS_CLOCK_OVERRIDE_ENABLED=true`（`test_noop` 只在測試站有處理器）。插進去的兩件工作留在資料庫裡當證據，不影響任何人。
- `worker-stall` 中途按 Ctrl-C 也會把 worker 重新啟動。
- 跑完把紀錄貼回 Vault：`sudo cat /srv/fju/test/drills/fault-drills.log`，四行都是 `pass` 就把 SOP 05 的執行紀錄與票 28 第 3 點打勾。

**💻 在自己電腦先模擬一次（不碰 VM）**：同一支腳本、同一個映像，對一個本機的獨立模擬站（`fju-faultsim-*`，跟本機開發的資料庫分開）跑：

```bash
docker build -f web/Dockerfile --build-arg GIT_COMMIT=faultsim -t fju-web:faultsim .
ops/fault-drill-local.sh                 # 五個照順序全跑，約 8 分鐘；跑完自動拆掉模擬站
ops/fault-drill-local.sh disk80 --keep   # 只跑一個、留著看畫面（http://127.0.0.1:3928）
```

### repo 的 ops／compose 檔改了之後

自動部署只換**映像**，不會更新 VM 上的腳本與 compose 檔。這些檔有改時重做第 1、4 步：

```bash
# 💻 Mac
git switch main && git pull
rsync -av --delete docker-compose.yml docker-compose.vm.yml docker-compose.edge.yml docker-compose.drill.yml ops fju-vm:/tmp/fju-app/
# 🖥️ VM
sudo rsync -a --delete --chown=deploy:deploy /tmp/fju-app/ /srv/fju/app/
sudo bash /srv/fju/app/ops/vm-setup.sh
```

改了 `ops/Caddyfile.vm` 還要：`sudo -u deploy docker compose -f /srv/fju/app/docker-compose.edge.yml restart caddy`。

---

## 檔案對照

| 檔案 | 做什麼 |
|---|---|
| `ops/vm-setup.sh` | VM 設定（冪等；`--check` 只看不改） |
| `ops/deploy.sh` | 部署／回滾某一站（`--site test|prod`） |
| `ops/auto-deploy.sh` | timer 呼叫：GHCR `:main` 有新 SHA 就部署到測試站 |
| `ops/backup.sh` | 手動備份某一站的資料庫、寫備份紀錄；`--status` 看最近成功備份／演練 |
| `ops/restore-drill.sh` | 把備份還原到演練副本（`fju-drill`）、抽查、寫演練紀錄；`--remove` 移除副本 |
| `docker-compose.drill.yml` | 演練副本（獨立的 Compose 檔，不疊在站台設定上；不發布 port、不接 Caddy） |
| `ops/fault-drill.sh` | 四種故障演練（只准測試站；`--execute` 才真的跑），結果寫 `/srv/fju/test/drills/fault-drills.log` |
| `ops/fault-drill-local.sh`、`docker-compose.faultsim.yml` | 💻 Mac 用：在本機的獨立模擬站跑同一支 `fault-drill.sh` |
| `ops/lib/backup-common.sh`、`ops/lib/backup-record.mjs` | 上面兩支共用：抽查 SQL、紀錄檔讀寫與比對 |
| `ops/seed-admin.sh` | 建某一站的第一位管理員 A1（每站一次；重跑不會改東西） |
| `ops/site.sh` | 在某一站的環境裡跑指令（ps、logs、check） |
| `web/scripts/seed-e2e.mjs` | `deploy.sh --site test` 在 migration 後跑：建 E2E 測試管理員（只限測試站；已存在不動） |
| `ops/codex-e2e.sh` | 💻 Mac 用：Codex 照 `e2e/acceptance/*.md` 在測試站驗收、出報告 |
| `ops/lib/site.sh` | 上面幾支共用：站台設定、Doppler 取值 |
| `docker-compose.vm.yml` | 疊在 `docker-compose.yml` 上的站台設定 |
| `docker-compose.edge.yml`、`ops/Caddyfile.vm` | 兩站共用的 Caddy |
| `.github/workflows/image.yml` | main 合併後推 `ghcr.io/roy4222/fju-web:<SHA>` 與 `:main` |

VM 上的目錄：

```
/srv/fju/app/                 上面這些檔（deploy 擁有）
/srv/fju/secrets/             doppler-test.token、doppler-prod.token（700／600）
/srv/fju/test/  /srv/fju/prod/
    files/                    附件（容器裡的 app 寫）
    backups/                  手動備份（*.dump）與 records.jsonl（備份／演練紀錄，600）
    drills/                   故障演練紀錄 fault-drills.log（只有 test）
    deploy/                   deploy_log、previous_tag、自動部署紀錄與暫停檔
```
