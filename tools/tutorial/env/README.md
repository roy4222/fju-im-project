# 教學影片的本機網站環境

錄教學影片會真的送出作業、評分、核准，所以不在測試站錄，改在 Mac mini 本機跑一份跟這個 checkout 同版的網站，
放示範資料（`web/scripts/seed-demo.mjs`），每錄一段前都能幾秒內重置回乾淨狀態。

## 多實例（幾個人同時錄）

每個指令前加 `INSTANCE=n`（0～4，沒設＝0），各實例的資料庫、網站、檔案、程序、帳號設定都分開，
reset 一個不影響別的：

| 實例 | 網站 | 資料庫 | 檔案 | pid／log | 帳號設定 |
|---|---|---|---|---|---|
| 0 | <http://localhost:3300> | `fju_tutorial` | `~/work/tutorial-files/0` | `~/work/tutorial-run/0` | `~/work/tutorial-secrets/accounts.json` |
| n（1～4） | `http://localhost:330n` | `fju_tutorial_n` | `~/work/tutorial-files/n` | `~/work/tutorial-run/n` | `~/work/tutorial-secrets/accounts-n.json` |

實例 n 的帳號設定第一次從實例 0 那份複製，所以帳號密碼跟實例 0 一樣。
建置產物（`web/.next`、`web/dist`）各實例共用：up.sh 只在沒有建置、或 `web/` 跟上次建置時不同才建，
而且有任何實例在跑時拒絕重建（會把它們用到一半的 `.next` 換掉），兩個人同時建也會被鎖擋下。

**同一個瀏覽器不要同時開兩個實例**：cookie 不分 port，`localhost:3300` 和 `localhost:3301` 的登入會互相蓋掉。
每個實例用自己的瀏覽器設定檔（或各自的 Playwright browser context）。

| 指令 | 做什麼 |
|---|---|
| `tools/tutorial/env/up.sh` | 建置（需要時）→ 建這個實例的資料庫（已在就沿用）→ migration → seed-demo → 設教學帳號密碼 → 起 `next start`（port 3300+n）與背景 worker |
| `tools/tutorial/env/up.sh --no-build`／`--build` | 一定沿用既有建置／一定重建（所有實例都 down 了才可以） |
| `tools/tutorial/env/reset.sh` | 停這個實例的 app／worker → 刪庫重建 → 清空這個實例的上傳檔案 → migration → seed-demo → 帳號 → 模擬業務鐘回到真實時間 → 再起。實測約 5 秒 |
| `tools/tutorial/env/clock-reset.sh` | 只把這個實例的模擬業務鐘清回真實時間（資料不動）；本來就是真實時間就不寫任何東西 |
| `tools/tutorial/env/down.sh` | 只停這個實例 up.sh 起的那兩組程序；資料庫與檔案留著 |
| `node tools/tutorial/env/accounts.mjs list [--passwords]` | 印「角色／示範名稱／登入帳號」對照 |
| `node tools/tutorial/env/accounts.mjs apply` | 照設定檔重設密碼（up／reset 會自動跑；改了設定檔後手動跑一次） |
| `node tools/tutorial/env/accounts.mjs check` | 每個帳號真的登入一次，確認進得了自己的首頁、看得到自己的名字 |

網站照**測試站**的樣子跑（`FJU_SITE=test`、`BUSINESS_CLOCK_OVERRIDE_ENABLED=true`）：系辦後台有「模擬業務鐘」頁與「發一則測試通知」。只影響本機這幾個實例。

網站：實例 0 是 <http://localhost:3300>、實例 n 是 `http://localhost:330n`。用 Email＋密碼登入（Google 登入在本機不能用）。

## 本機檔案（都不進 repo）

| 路徑 | 內容 |
|---|---|
| `~/work/tutorial-secrets/env` | 本機隨機 `BETTER_AUTH_SECRET`（第一次跑自動產生，權限 600） |
| `~/work/tutorial-secrets/accounts[-n].json` | 教學帳號清單與密碼（實例 0 第一次從 `accounts.default.json` 複製並補隨機密碼，權限 600） |
| `~/work/tutorial-files/<n>/` | `FILES_ROOT`：示範封面、附件，以及錄影時上傳的檔案（reset 會清掉重放） |
| `~/work/tutorial-run/<n>/` | pid 檔與 `app.log`、`worker.log`（`build.log`、`build-commit` 在 `~/work/tutorial-run/`） |

## 預設教學帳號（照分鏡表 PR #404）

系辦管理員（腳本建的）、林彥廷（G07 組長）、鄭凱文（G07 組員）、應宥丞（未分組，組別提案發起人）、鞠柏宇、冷佳霓（未分組，在提案裡還沒回覆）、
陳建宏（指導老師）、李孟儒（評分老師），另保留黃詩涵（G07 組員）、陳冠宇（新註冊待審）。
分鏡裡的新生「林示範」與老師「示範新老師」**不預先建**，留給錄影段落自己示範註冊／新增；reset 後他們就不在了。

## 加教學帳號

在 `~/work/tutorial-secrets/accounts.json`（實例 n 是 `accounts-n.json`）的 `accounts` 陣列加一筆，再跑 `[INSTANCE=n] accounts.mjs apply`：

```json
{ "role": "另一位組員", "name": "吳柏諺" }
```

`name` 是示範資料裡的顯示名稱（停用的帳號不算）；同名時改寫 `"email": "...@demo.invalid"`。
沒寫 `password` 會自動產生並寫回檔案。示範資料裡沒有的系辦帳號用 `"create": "admin"`（要寫 `name` 與 `email`）。

## 防呆（`safety.mjs`，測試在 `safety.test.mjs`）

這幾支會刪庫、清目錄、送訊號，所以每個入口在任何副作用之前先驗目標，不對就拒絕：

- **實例與資料庫名**：`INSTANCE` 只能是 0～4；資料庫只接受 `fju_tutorial`、`fju_tutorial_1`～`4`，而且要是這個實例的那一個。建庫、刪庫函式再核對一次。
- **連線目的地**：照 pg 實際的解析結果驗，host 只能是 localhost／127.0.0.1／::1、port 55432、database 是這個實例的；帶任何查詢參數（`?host=` 等會改寫目的地）一律拒絕。
- **檔案目錄**：`FILES_ROOT` 正規化（realpath，含符號連結）後必須是 `~/work/tutorial-files/<n>` 或它底下。
- **Docker**：所有 docker 指令都用 `-H unix://<本機 socket>`（預設 colima 的 `~/.colima/default/docker.sock`，可用 `TUTORIAL_DOCKER_SOCK` 指定，必須是存在的 unix socket）；`DOCKER_HOST` 設成 unix:// 以外就拒絕。
- **停程序**：pid 檔記下啟動時間、工作目錄、種類（app／worker）與 PGID；停之前核對，對不上（pid 被重用、pid 檔殘留）就只清 pid 檔、不送訊號。
- **帳號設定檔**：格式錯誤只回報索引與缺的欄位，不印整筆（裡面有密碼）。

```bash
node --test tools/tutorial/env/safety.test.mjs   # 不碰真的資料庫與目錄（HOME 指到暫存目錄）
```

## 已知限制

- Google 登入不能用（本機用假的 client id）。
- 不寄任何信：網站本來就沒有寄信功能（忘記密碼頁請人找系辦發臨時密碼），所以不需要本機收信。
- 模擬業務鐘的設定紀錄只增不改（資料庫 trigger 擋刪改），所以單跑 `clock-reset.sh` 是補一筆「設定成現在」：
  系統時間確實回到真實時間，但「模擬業務鐘」頁的標題仍會寫「（模擬中）」、紀錄裡多一筆「回到真實時間」。
  要畫面完全沒有模擬紀錄就跑 `reset.sh`（新的資料庫沒有任何設定）。
- `REGISTRATION_OPEN=true`（可在跑 up.sh 前用環境變數蓋掉）。
- seed-demo 的日期以「第一次灌資料那天」對齊原型的 2026-08-17；reset 會用當天重新對齊。
- reset 之後所有 session 都失效，錄影瀏覽器要重新登入。
- 用本機 Compose 的 `fju-postgres` 容器（127.0.0.1:55432）；沒有的話先在 repo 根跑 `pnpm -C web db:up`。
- seed-demo 只認 `FJU_SITE=test`：腳本只在跑 seed-demo 那一個指令上設它，連的是本機這個實例的教學庫。
- 同一個瀏覽器設定檔同時開兩個實例，登入會互相蓋掉（見上面「多實例」）。
