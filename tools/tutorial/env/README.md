# 教學影片的本機網站環境

錄教學影片會真的送出作業、評分、核准，所以不在測試站錄，改在 Mac mini 本機跑一份跟這個 checkout 同版的網站，
放示範資料（`web/scripts/seed-demo.mjs`），每錄一段前都能幾秒內重置回乾淨狀態。

| 指令 | 做什麼 |
|---|---|
| `tools/tutorial/env/up.sh` | `pnpm -C web build` → 建資料庫 `fju_tutorial`（已在就沿用）→ migration → seed-demo → 設教學帳號密碼 → 起 `next start`（port 3300）與背景 worker |
| `tools/tutorial/env/up.sh --no-build` | 同上，但跳過建置（`web/.next` 已是這個版本時） |
| `tools/tutorial/env/reset.sh` | 停 app／worker → 刪庫重建 → 清空上傳檔案 → migration → seed-demo → 帳號 → 再起 app／worker。實測約 5 秒 |
| `tools/tutorial/env/down.sh` | 只停 up.sh 起的那兩組程序（照 pid 檔，不按名稱比對）；資料庫與檔案留著 |
| `node tools/tutorial/env/accounts.mjs list [--passwords]` | 印「角色／示範名稱／登入帳號」對照 |
| `node tools/tutorial/env/accounts.mjs apply` | 照設定檔重設密碼（up／reset 會自動跑；改了設定檔後手動跑一次） |
| `node tools/tutorial/env/accounts.mjs check` | 每個帳號真的登入一次，確認進得了自己的首頁、看得到自己的名字 |

網站：<http://localhost:3300>。用 Email＋密碼登入（Google 登入在本機不能用）。

## 本機檔案（都不進 repo）

| 路徑 | 內容 |
|---|---|
| `~/work/tutorial-secrets/env` | 本機隨機 `BETTER_AUTH_SECRET`（第一次跑自動產生，權限 600） |
| `~/work/tutorial-secrets/accounts.json` | 教學帳號清單與密碼（第一次從 `accounts.default.json` 複製並補隨機密碼，權限 600） |
| `~/work/tutorial-files/` | `FILES_ROOT`：示範封面、附件，以及錄影時上傳的檔案（reset 會清掉重放） |
| `~/work/tutorial-run/` | pid 檔與 `app.log`、`worker.log`、`build.log` |

## 加教學帳號

在 `~/work/tutorial-secrets/accounts.json` 的 `accounts` 陣列加一筆，再跑 `accounts.mjs apply`：

```json
{ "role": "另一位組員", "name": "吳柏諺" }
```

`name` 是示範資料裡的顯示名稱（停用的帳號不算）；同名時改寫 `"email": "...@demo.invalid"`。
沒寫 `password` 會自動產生並寫回檔案。示範資料裡沒有的系辦帳號用 `"create": "admin"`（要寫 `name` 與 `email`）。

## 已知限制

- Google 登入不能用（本機用假的 client id）。
- 不寄任何信：網站本來就沒有寄信功能（忘記密碼頁請人找系辦發臨時密碼），所以不需要本機收信。
- 預設 `BUSINESS_CLOCK_OVERRIDE_ENABLED=false`（畫面跟正式站一樣、沒有「模擬業務鐘」頁）、`REGISTRATION_OPEN=true`；
  兩者都可以在跑 up.sh 前用環境變數蓋掉。
- seed-demo 的日期以「第一次灌資料那天」對齊原型的 2026-08-17；reset 會用當天重新對齊。
- reset 之後所有 session 都失效，錄影瀏覽器要重新登入。
- 用本機 Compose 的 `fju-postgres` 容器（127.0.0.1:55432）；沒有的話先在 repo 根跑 `pnpm -C web db:up`。
- seed-demo 只認 `FJU_SITE=test`：腳本只在跑 seed-demo 那一個指令上設它，連的是本機的 `fju_tutorial`。
