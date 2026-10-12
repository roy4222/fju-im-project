# 開發者後台：上線與重跑

`fju-status.roy422.dev`（另外三個工具：`fju-status-vm`、`fju-status-logs`、`fju-status-db`，都是 `.roy422.dev`）。
只給 Roy 用：Cloudflare Tunnel 進來、Cloudflare Access 只放 Roy 的 Gmail，隧道端再驗一次 Access JWT。
設計見 `docs/plans/2026-10-12-status-console/設計方案.md`（§3.11 誰做什麼、§3.12 安裝十二步）。主網站的說明在 `ops/README.md`，這份只講開發者後台。

> 下面每個指令框都可以整段貼上。標「💻 Mac mini」的在 Mac mini 的 repo 根目錄跑，標「🖥️ VM」的先 `ssh fju-vm` 再跑。

## 兩支腳本

| 腳本 | 在哪跑 | 誰 | 做什麼 |
|---|---|---|---|
| `ops/status-prepare.sh` | 💻 Mac mini，不用 sudo | 工程主腦 | 產驗收結果推送金鑰 `~/.ssh/fju_status_publish`、把 compose 檔與 `ops/` 送到 VM 的 `/tmp/fju-app/`（一次連線）、印兩支重置腳本的 sha256、印 Roy 要在 VM 貼的那一行 |
| `ops/status-install.sh` | 🖥️ VM，`sudo` 一次 | Roy 貼上 | 十二步＋7b（下表）。可重跑：已完成的步驟印「跳過」 |

兩支都有 `--dry-run`（只讀現況、只印不做，不需要 sudo）與 `--help`。

推送金鑰與 S-8 共用同一個名字：私鑰 `~/.ssh/fju_status_publish`、`~/.ssh/config` 的 `Host fju-status-publish`（照 `ops/ssh-config.example`）。本機試跑整夜驗收、不想推上 VM 時用 S-8 的開關 `ACCEPT_STATUS_PUBLISH=0`。

## 上線步驟（照順序）

前提：S-4（`docker-compose.status.yml`、`ops/status-up.sh`、`ops/status-render-cloudflared.sh`、`ops/status/systemd/`）與 S-1（`fju-status` 映像，含 `verify-origin.mjs`）已合併，`status.yml` 已把映像推到 GHCR。還沒合併時兩支腳本只能 `--dry-run`。

1. **Roy 做第 1 件事**（下節），把 **team 網域**（`<team>.cloudflareaccess.com`）和 **AUD** 貼到對話。
2. 💻 Mac mini，工程主腦：

   ```bash
   # 💻 Mac mini，repo 根目錄、main 最新
   git switch main && git pull
   ops/status-prepare.sh --access-team <team>.cloudflareaccess.com --access-aud <AUD>
   ```

   預期：金鑰「產好了」或「跳過 已有」、rsync 沒有錯誤、兩行 sha256、最後印出一整行 `sudo rsync … && sudo bash /srv/fju/app/ops/status-install.sh …`。把那一行原樣交給 Roy。
3. **Roy 做第 2 件事**：VM 貼那一行（下節）。
4. 看安裝最後的「摘要」：每步 ✓ 或「跳過」；結束碼 0。
5. **Roy 做第 3 件事**（Beszel，可延後）。
6. 跑端到端 AC-S-26（設計方案的驗收案例）。

## Roy 的 3 件事

| # | 在哪 | 做什麼 | 大約 |
|---|---|---|---|
| 1 | Cloudflare 網頁 → Zero Trust | 第一次進去取 team 名稱、選 Free 方案。Access → Applications → Add an application → **Self-hosted**，名稱 `fju-status`，加四個網址：`fju-status.roy422.dev`、`fju-status-vm.roy422.dev`、`fju-status-logs.roy422.dev`、`fju-status-db.roy422.dev`；Policy 只 Include 自己的 Gmail；登入方式 One-time PIN。存好後把應用程式頁的 **Application Audience (AUD) Tag** 與 Settings 裡的 **team 網域**貼到對話（都不是秘密） | 10 分鐘 |
| 2 | VM | `ssh fju-vm`，貼工程主腦給的那一行、輸入一次 sudo 密碼。中途印出 `https://dash.cloudflare.com/argotunnel?…`：用瀏覽器打開、選 `roy422.dev`、按 Authorize。接著自動做第 7b 步的暫時通道測試（2–3 分鐘），最後印摘要與記憶體 | 8 分鐘 |
| 3 | 瀏覽器開 `fju-status-vm.roy422.dev` | Beszel 第一次：建管理帳號 →「Add System」→ Host / IP 填安裝最後印的 **`/beszel_socket/beszel.sock`**（是 socket 路徑，不是網址）、名稱隨意、公鑰照安裝印的。看不到「網路流量」圖是預期的（agent 不開 port 的取捨） | 2 分鐘 |

## 安裝腳本每一步

| 步 | 做什麼 | 失敗時 |
|---|---|---|
| 1 | 前置（Ubuntu 24.04、docker compose、compose 檔、`status-up.sh`、`/usr/bin/rrsync`、python3／curl／openssl）；印 `free -m`、`docker stats --no-stream`；**可用記憶體 < 2560 MB 就停**。前置過了、改任何設定之前：**先停 `fju-status-update`（timer 與 service）並開始「中途結束就關門」**，直到第 10 步守門通過（已裝過的機器重跑時，壞掉的新設定不能讓既有的對外通道繼續開著） | 停、什麼都沒建、結束碼 2（記憶體）／1（前置） |
| 2 | `/srv/fju/status/{secrets,data,inbox,envcheck,beszel,gatus,pghero,diskprobe}`（權限照設計方案 §3.1）；`diskprobe` 必須是空目錄；異地備份目錄寫進 `/srv/fju/status/paths.env` 的 `STATUS_OFFSITE_DIR` | `diskprobe` 不是空的就停 |
| 3 | 帳號 `fjustatus`（system、無密碼）；`authorized_keys`＝`restrict,command="/usr/bin/rrsync -wo /srv/fju/status/inbox" <公鑰>`；`inbox` 交給它；`/etc/ssh/sshd_config.d/10-fju.conf` 的 `AllowUsers` 加上 `fjustatus`（`sshd -t` 不過就還原） | `sshd -t` 不過：還原設定、停 |
| 4 | 重置腳本含 `seed-demo`（S-7 合併後）才 `install` 到 `/usr/local/sbin/`，印兩支 sha256 跟 Mac 比對；不含就印「跳過」 | — |
| 5 | `secrets/pghero.env`（`FJU_MONITOR_PASSWORD`＝`openssl rand -hex 24`、`DATABASE_URL` 指 `fju-test-postgres`）；以 deploy 跑 `status-up.sh --ensure-db-role-only` 建 `fju_monitor` | 測試站 postgres 不在：✗，之後由每 10 分鐘的 timer 補 |
| 6 | `secrets/status.env`（team、AUD、`STATUS_HOSTS`）；先放空的 `beszel-agent.env` | — |
| 1 之後、10 之前任何一種結束 | 不論是哪一步失敗、`set -e` 直接中止、Ctrl-C、ssh 斷線、輸出管線斷掉（例如 `\| tee` 死掉）、等授權時被終止，都**先關門**：停所有 cloudflared 容器、停用 `fju-status-update.timer`、停掉 `fju-status-update.service`；接著砍掉還在等授權的 `fju-status-login` 容器、清 7b 暫時資源、刪 `cert.pem`。關門動作本身不印到畫面；關門途中再按 Ctrl-C、再斷線也不會中斷（本 shell 忽略訊號，`systemctl`／`docker` 子程序用 `setsid` 放到別的 session，終端或整個程序群組的 INT／TERM 都打不到）。容器列舉失敗不會當成「沒有容器」：重試三次，還是不行就用預設容器名 `fju-status-cloudflared-1` 直接 stop；timer 停用、service 停止、容器 stop 三項都確認成功才算關好，任一項失敗會印出要手動做的指令、結束碼非 0。原因與結束碼寫進 `/srv/fju/status/.install/exit.log`（畫面已經不在時看這裡） | — |
| 7 | cloudflared 容器（版本取自 compose 檔）：`tunnel login` → 建／沿用隧道 `fju-status` → 四個網址 `route dns` → `secrets/tunnel.json` → 跑 `status-render-cloudflared.sh` 產 `ops/status/cloudflared.yml` → 用第 10 步同一個檢查核對 | 停 |
| 7b | 暫時隧道 `fju-status-verify`＋暫時網址 `fju-status-verify.roy422.dev`（不在任何 Access 應用程式裡）＋計數假 origin（`fju-status` 映像 `node verify-origin.mjs`）。有鎖：`/probe` 三次都 403、`/count` 兩次都 0；拿掉 `access` 重起：`/count` 兩次都 3。最後刪暫時容器、網路、隧道、DNS，再刪 `cert.pem`。要重做 7b 時（沒有 `tunnel.json`、或 team／AUD／cloudflared 版本變了）**先刪掉舊的通過紀錄**，兩輪驗證與四類清理全部通過才原子地寫新的；中途任何失敗（含沒清乾淨）都不會留下紀錄，下次重跑會重新登入、再做一次 7b | 停、結束碼 1；暫時資源與 `cert.pem` 照樣清掉 |
| 8 | `fju-status-{update,envcheck}.{service,timer}` 裝到 `/etc/systemd/system`；`enable --now` envcheck timer。**update timer 等第 10 步守門通過才啟用**（它每 10 分鐘 `up -d`，守門沒過時不能把 cloudflared 再起來） | 停 |
| 9 | 以 deploy 跑 `status-up.sh`，等 status-web `/healthz` | 停並關門 |
| 10 | 四個網址不帶 cookie `curl -sI`：都要 302 到 `https://<team>/cdn-cgi/access/login`；再對每個 cloudflared 容器 `docker cp <容器>:/etc/cloudflared/config.yml -` 核對實際掛載的設定：每條會轉給服務的 ingress 都有 `originRequest.access`（`required: true`、`teamName`、`audTag` 恰好是這個 AUD）。通過才 `enable --now fju-status-update.timer` | **關門**：停所有 cloudflared 容器、停 `fju-status-update`（timer 與正在跑的 service）、印哪個網址沒擋、結束碼 1 |
| 11 | 從 Beszel hub 取公鑰寫 `beszel-agent.env`、重起 agent；印「新增系統」要填的 `/beszel_socket/beszel.sock` | ✗（不影響三頁） |
| 12 | 再印一次 `free -m`、`docker stats --no-stream` 與摘要 | — |

## 怎麼重跑

- **同一行再貼一次就好**。已完成的步驟印「跳過」；第 7 步只有在「沒有 `tunnel.json`」或「第 7b 步沒以同一組 team／AUD／cloudflared 版本通過過」時才會要你再點一次授權網址。
- **第 10 步關門之後**：去 Zero Trust 把印出來的網址加進 `fju-status` 應用程式，再貼同一行。第 9 步的 `status-up.sh` 會把 cloudflared 起回來，第 10 步再檢查一次，通過才重新啟用自動更新 timer。
- **中途斷線、被中斷、或畫面上看不到為什麼停**：門已經關了（四個網址連不上）。`sudo tail /srv/fju/status/.install/exit.log` 看最後幾行：停在哪一步、什麼原因（Ctrl-C、SIGHUP、輸出管線中斷、或最後失敗的指令與行號）。修好後貼同一行重跑；第 9 步起回服務、第 10 步守門通過才重新開門。
- **換了 team 或 AUD**：Mac mini 帶新值重跑 `status-prepare.sh`，把新的那一行給 Roy。第 7b 步會重做（要再點一次授權）。
- **repo 的 ops／compose 檔改了**：Mac mini 重跑 `status-prepare.sh`（會重送），VM 只要跑那一行的前半段 `sudo rsync … /srv/fju/app/`。之後每 10 分鐘的 `fju-status-update` 會自己 `pull` 與 `up -d`。
  注意：VM 那一行的 rsync 帶 `--filter='P /ops/status/cloudflared.yml'`，因為那份是安裝時產生的、repo 裡沒有。若改用 `ops/README.md` 那個沒帶 filter 的 rsync，它會被刪掉，cloudflared 起不來；重貼安裝那一行會重新產生。
- **只想看會做什麼**：VM 上 `FJU_STATUS_APP_DIR=/tmp/fju-app bash /tmp/fju-app/ops/status-install.sh --dry-run …`（同一組參數，不用 sudo、不寫任何東西）。
- **測試用的環境變數**：`FJU_STATUS_ROOT`、`FJU_STATUS_UNIT_DIR`、`FJU_STATUS_SSH_DIR`、`FJU_STATUS_HOME_ROOT`、`FJU_STATUS_SBIN`、`FJU_STATUS_OS_RELEASE`、`FJU_STATUS_RRSYNC`、`FJU_STATUS_CF_API` 只給 `status/test/ops/install.test.ts` 的故障注入測試把系統路徑換成暫存目錄；正式安裝不要設。
- **單獨核對某份 cloudflared 設定**：`bash ops/status-install.sh --check-cloudflared-config <檔> --access-team … --access-aud …`。
- **測第 1 步的停止條件**：加 `--mem-available-override 2000`，應停在第 1 步、結束碼非 0。
- **異地備份不在 `/srv/fju/offsite`**：第 2 步會印找到的位置，加 `--offsite-dir <實際路徑>` 重跑；它寫進 `/srv/fju/status/paths.env`。

## 已知限制（上線前要知道）

- **第 7b 步的兩份暫時設定由 S-4 的產生器產**（同一份產生器、同一種 JSON 寫法）：第一個網址是暫時網址 `fju-status-verify.roy422.dev`，後三個只是占位（沒有 DNS、不在任何 Access 應用程式裡）；產生器第一條 ingress 固定轉到 `http://status-web:3000`，所以假 origin 在暫時網路裡掛 `status-web` 別名、聽 3000。拿掉鎖那份用產生器的 `--no-access`。
- **刪暫時網址的 DNS 記錄**用 `cert.pem` 裡 cloudflared 登入時拿到的 zone token 呼叫 Cloudflare DNS API（cloudflared 沒有刪 DNS 的子命令）。這把 token 能不能 `GET`／`DELETE` DNS 記錄還沒在真帳號上試過；不能的話 7b 會在清理時停下、不寫通過紀錄，並印出要到 Cloudflare 網頁手動刪的記錄名（`fju-status-verify.roy422.dev`）；重跑會重新做 7b，清理一樣會失敗。所以第一次真裝前，先用真帳號確認這把 token 能刪 DNS；不能的話要改用別的方式刪（需要另開票）。
- **`kill -9` 或整台當機擋不住**（任何 trap 都不會跑）：門不會自動關。重跑同一行會先停自動更新、刪掉殘留的 `cert.pem`，再從頭核對；要重做 7b 時舊的通過紀錄會先被刪掉。
- **檢查器**：產生器的輸出是 JSON 寫法的 YAML，先用 python3 的 json 真的解析（鍵重複、鍵名帶「.」一樣判失敗）；不是 JSON 才退回自寫的區塊樣式 YAML 小解析器（錨點、多文件、tab 縮排、同一個鍵寫兩次都判失敗，寧可擋下）。

## 跟其他票的介面（整合時核對）

安裝腳本依設計方案 §3 寫，下面這些是它「假設」S-1／S-4 的樣子；合併時若不同，改安裝腳本開頭的變數即可：

| 介面 | 安裝腳本的假設 |
|---|---|
| compose 服務名 | `status-web`、`cloudflared`、`beszel`、`beszel-agent`（用 compose 標籤 `com.docker.compose.project=fju-status`、`…service=<名>` 找容器） |
| 映像 | compose 檔裡 `image: cloudflare/cloudflared:<版本>`、`image: ghcr.io/roy4222/fju-status:<tag>` 寫成字面值；讀不到才退回腳本裡的備用值 |
| 產生器 | `STATUS_HOSTS='…' bash ops/status-render-cloudflared.sh --team <team 名稱> --aud <AUD> --tunnel-id <id> --out ops/status/cloudflared.yml` |
| cloudflared 設定 | compose 把 `/srv/fju/app/ops/status/cloudflared.yml` 掛成容器的 `/etc/cloudflared/config.yml`；`secrets/tunnel.json` 是 deploy 600，cloudflared 容器要用讀得到它的 uid 跑 |
| `pghero.env` | 鍵 `FJU_MONITOR_PASSWORD`（`status-up.sh --ensure-db-role-only` 讀它設密碼）、`DATABASE_URL`（PgHero 用） |
| `beszel-agent.env` | `KEY="<hub 公鑰>"`、`LISTEN=/beszel_socket/beszel.sock`；hub 資料在容器內 `/beszel_data`（金鑰 `id_ed25519`） |
| status-web 健康 | 有 compose healthcheck 就看它；沒有就從同網路 `curl http://status-web:3000/healthz` 要回 `ok` |
| 假 origin | `node verify-origin.mjs` 讀 `PORT`（安裝給 3000，配合產生器第一條 ingress 的 `http://status-web:3000`；容器在暫時網路掛 `status-web` 別名）；`/count` 回數字 |
| 異地備份掛載點 | compose 用 `${STATUS_OFFSITE_DIR:-/srv/fju/offsite}`，值在 `/srv/fju/status/paths.env` |
