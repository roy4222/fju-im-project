# S14-01 證據：VM 現況重新探測與冪等設定腳本

票：[#187](https://github.com/roy4222/fju-im-project/issues/187)｜追蹤：[#201](https://github.com/roy4222/fju-im-project/issues/201)
｜探測時間：2026-09-15 20:14 CST

> **本票尚未完成。** 這份記的是「重新探測的現況」與「Fable 準備好、等 Roy 以 sudo 執行的腳本」。
> SOP 01 的執行紀錄表仍是 NOT_RUN——腳本還沒在 VM 上跑過。

## 1. 重新探測（2026-09-15）

交接說「過去 SSH 與 sudo 成功」，所以這次全部重驗。從 Fable 的機器：

```
$ ssh roy422roy@140.136.155.167 ...
### OS
Ubuntu 24.04.4 LTS
6.8.0-136-generic
### 資源
/dev/mapper/ubuntu--vg-ubuntu--lv   97G  7.1G   85G   8% /
Mem:            7941         565        5557           1        2125        7375
nproc=4
### docker
NOT INSTALLED
### ufw
ufw binary 在（狀態要 sudo 才看得到）
### deploy 帳號
id: ‘deploy’: no such user
### /srv/fju
ls: cannot access '/srv/fju': No such file or directory
### DNS（從 VM 自己解）
fju.roy422.dev ->
b1.fju.roy422.dev ->
b2.fju.roy422.dev ->
### 對外 443
https://ghcr.io -> 301
https://accounts.google.com -> 302
https://acme-v02.api.letsencrypt.org/directory -> 200
```

```
$ ssh roy422roy@140.136.155.167 'sudo -n true'
sudo: a password is required
```

### 結論

| SOP 01 前置 | 現況 | 說明 |
|---|---|---|
| SSH 可連 | ✅ | 公鑰登入可用（`roy422roy@140.136.155.167`） |
| Ubuntu 24.04 | ✅ | 24.04.4 LTS、kernel 6.8.0-136 |
| 磁碟 ≥ 20 GB | ✅ | 可用 **85 GB**，遠高於停止門檻 |
| 資源 | ✅ | 4 核、7.9 GB RAM（與 9/11 快照一致） |
| Docker | ❌ **未安裝** | 交接快照說「過去可連 GHCR」不代表裝了 Docker |
| `deploy` 帳號 | ❌ 不存在 | |
| `/srv/fju` | ❌ 不存在 | |
| ufw 規則 | ❓ 看不到 | `ufw status` 需要 root |
| 對外 443 | ✅ | GHCR、Google、**Let's Encrypt ACME 目錄都通** |
| DNS `fju`／`b1`／`b2` | ❌ 三筆都沒有 A 記錄 | 前置清單 §3.1，待 Roy 在 Cloudflare 建立 |
| 校方對內 80／443 | ❓ 未驗證 | 沒有 DNS 與 Caddy，現在驗不了；待 Roy 向校方申請 |
| **sudo 免密碼** | ❌ 需要密碼 | **這是刻意保留的人類界線**：Fable 沒有也不該有 sudo 密碼 |

也就是說：**VM 幾乎是全新的**，SOP 01 八個步驟一步都還沒跑。

## 2. Fable 準備好的東西

| 檔案 | 用途 |
|---|---|
| [`ops/vm-setup.sh`](../../../ops/vm-setup.sh) | SOP 01 步驟 0–8 的冪等腳本；`--check` 只看不改 |
| [`ops/Caddyfile.vm`](../../../ops/Caddyfile.vm) | VM 用的 Caddy 設定：三個 host、真憑證（repo 根那份是本機用的 `:80`／`auto_https off`） |
| [`docker-compose.vm.yml`](../../../docker-compose.vm.yml) | VM 覆蓋檔：把 caddy 的 ports 取代成 `80:80`／`443:443`（2026-09-16 review 補） |
| [`ops/ssh-config.example`](../../../ops/ssh-config.example) | `~/.ssh/config` 範本（`fju-vm`、`fju-vm-deploy`；不含任何金鑰） |

`vm-setup.sh` 的性質：

- **冪等**：每一步先檢查再動作，已就緒的印「✓ 已就緒」，不重裝、不動既有資料。
- **有停止條件**：根目錄可用 < 20 GB 直接 `exit 2`（SOP 01 的停止條件）。
- **`--check` 模式**：完全不改東西，只印現況與「會執行什麼」。**請先跑這個。**
- 涵蓋步驟 1–4（套件、docker 群組、`/srv/fju/{files,tmp,backups,postgres,app,branches}`、ufw 只開 22/80/443）
  與 `deploy` 帳號；步驟 5–8 只做**檢查**（.env 權限、設定檔是否就位、DNS、對外連線），
  因為那些的值與操作屬於 SOP 02／#188 與 Roy 本人。
- 語法已用 `bash -n` 檢查過；**尚未在 VM 上執行**（需要 sudo 密碼）。

## 2.5 2026-09-16 review 的四項修正

review 在**沒有連線 VM** 的情況下讀出四個會讓腳本在乾淨機器上出事的問題，四項都已修：

| # | 問題 | 修法 |
|---|---|---|
| 1（P1） | Compose 只發布 `8080:80`，沒有對外的 80／443，Caddy 拿不到憑證 | 新增 `docker-compose.vm.yml`，用 Compose 的 `!override` **取代**（不是附加）成 `80:80`、`443:443`＋HTTP/3 的 `443/udp`；腳本步驟 6 讀 resolved config 確認真的有發布 |
| 2（P1） | 裝 `docker-compose-plugin`（那是 **Docker 官方 repo** 的套件名），Ubuntu 24.04 來源裡叫 `docker-compose-v2`，乾淨機器會卡住 | 改成單一來源：`docker.io docker-compose-v2 ufw`，不額外加 repo 與 GPG 金鑰 |
| 3（P2） | `chown -R 1000:1000 /srv/fju` 會把 deploy 擁有的 mode-600 `.env` 改掉；而且 uid 也錯（Dockerfile 實際是 **1001**） | 分開處理：`files`／`tmp`／`postgres` 給容器的 1001:1001，`app`／`backups`／`branches` 給 `deploy` —— **重跑不會動到秘密** |
| 4（P2） | curl 失敗時 `%{http_code}` 輸出 `000` 再接 `echo FAIL` 成 `000FAIL`，兩個失敗條件都不等於它，於是印成 OK | 依 curl 的 exit status 判斷，再看 HTTP 狀態 |

另外照 review 的提醒，起基礎設施改用 `--no-deps`：`caddy` 的 `depends_on` 有 `app`，
不加的話會把 app 與 migrate 一起拉起來——那時 `.env` 還沒填（SOP 02／#188）。

本機實測（**不是在 VM 上**）：

```
$ docker compose -f docker-compose.yml -f docker-compose.vm.yml config | grep -A10 "^  caddy:"
        target: 80    published: "80"   protocol: tcp
        target: 443   published: "443"  protocol: tcp
        target: 443   published: "443"  protocol: udp
$ …| grep -c '"8080"'
0                                    ← 本機用的 8080 被 !override 取代掉，沒有多餘曝露

$ # Standards 4 的重現：打一個一定連不到的位址
  ✗ 連不到（curl 失敗）               ← 修正前這裡會印成 OK

$ bash -n ops/vm-setup.sh             ← 語法通過
$ docker compose -f docker-compose.yml -f docker-compose.local.yml config   ← 本機覆蓋仍可解析
```

> **仍然 NOT_RUN**：腳本在 VM 上的實際執行、套件安裝、憑證簽發。上面驗的是
> 「resolved config 正確」「失敗會被報成失敗」「語法通過」，**不是**「在乾淨 Ubuntu 上裝得起來」。
> 那一項要等 Roy 以 sudo 執行。

## 3. Roy 怎麼執行（每一步的預期結果）

```bash
# 1. 把腳本與設定送上去
scp ops/vm-setup.sh ops/Caddyfile.vm ops/deploy.sh docker-compose.yml \
    roy422roy@140.136.155.167:/tmp/

# 2. 先看現況，什麼都不會改
ssh roy422roy@140.136.155.167 'sudo bash /tmp/vm-setup.sh --check'
```
> 預期：印出上面第 1 節那份清單，docker／deploy／`/srv/fju`／DNS 標成「→ 還沒做」，
> 磁碟 85 GB 標「✓」。**不會安裝任何東西。**

```bash
# 3. 實際設定（會裝 docker.io、docker-compose-plugin、ufw）
ssh -t roy422roy@140.136.155.167 'sudo bash /tmp/vm-setup.sh'
```
> 預期：步驟 1–4 全部變成 ✓；最後印出「接下來 Roy 要做的事」七點。

```bash
# 4. 重新登入後確認 docker 不用 sudo
ssh roy422roy@140.136.155.167 'docker ps'
```
> 預期：印出空的容器表頭，不是 permission denied。

```bash
# 5. 在 Cloudflare dashboard 加三筆 A 記錄（灰雲、TTL auto、140.136.155.167）：fju、b1、b2
dig +short fju.roy422.dev A b1.fju.roy422.dev A b2.fju.roy422.dev A
```
> 預期：三行都是 `140.136.155.167`。

```bash
# 6. 放設定檔、起資料庫與 Caddy
ssh -t roy422roy@140.136.155.167 '
  sudo install -o deploy -g deploy -m 644 /tmp/docker-compose.yml /srv/fju/app/docker-compose.yml
  sudo install -o deploy -g deploy -m 644 /tmp/Caddyfile.vm       /srv/fju/app/Caddyfile
  sudo install -o deploy -g deploy -m 755 /tmp/deploy.sh          /srv/fju/app/deploy.sh
  cd /srv/fju/app && sudo -u deploy docker compose up -d postgres caddy
  sudo -u deploy docker compose logs caddy | grep -i "certificate obtained"'
```
> 預期：三個網域各出現一行 `certificate obtained`。
> **如果校方還沒開對內 80，這一步會失敗**——那就是校方 port 還沒開通的證據，記錄下來即可。

## 4. 還缺什麼（阻塞項）

| 缺的東西 | 誰做 | 擋住什麼 |
|---|---|---|
| VM 的 sudo 密碼 | **Roy 親自執行腳本** | SOP 01 步驟 1–4 全部 |
| Cloudflare `fju`／`b1`／`b2` 三筆 A 記錄 | Roy（dashboard） | Caddy 取不到憑證 → 沒有 HTTPS 測試站 |
| 校方開放對內 80／443 | Roy 向校方申請（有前置作業時間） | Let's Encrypt HTTP-01 驗證、站台本身 |
| 三份 `.env` 的值 | Roy（SOP 02／#188，只在 VM 上輸入） | app 與 worker 起不來 |
| GHCR 唯讀 PAT | Roy（SOP 02／#188） | VM 拉不到映像 |
| 部署公鑰貼進 `/home/deploy/.ssh/authorized_keys` | Roy | CD 自動部署（SOP 03／#189） |

秘密一律不經聊天、issue、repo。

## 5. NOT_RUN

- `vm-setup.sh` 在 VM 上的實際執行：**NOT_RUN**（需要 sudo 密碼）。
- `ufw status`、`docker --version`、`docker ps` 不用 sudo、`ls -ld /srv/fju/*`：**NOT_RUN**（要先跑腳本）。
- Caddy 憑證取得：**NOT_RUN**（DNS 與校方 port 都還沒好）。
- SOP 01 執行紀錄表：維持 **NOT_RUN**，本票**不關**。
- 校方對內 80／443 是否已開：**未驗證**。
