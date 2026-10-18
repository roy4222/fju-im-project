# 效能量測工具（共用 SH-0）

規格：`docs/plans/2026-10-16-shared/設計方案.md` §2.5、§7.2、§7.4。五個命令都只在本機或 Review 手動跑，**不進 CI**（CI 擋門是 B 階段的 SH-B3）。

| 命令 | 量什麼 | 要什麼 |
|---|---|---|
| `perf:db up\|check\|down` | 建／驗／刪隔離量測庫 | docker（或 native Postgres）、`PERF_PASSWORD` |
| `perf:sql` | 每頁送出幾句 SQL、分身分／徽章／頁面三類 | 量測庫＋指向它的 `next start` |
| `perf:bundle` | 每路由 First Load JS（gzip）對 `budget.json` | `pnpm -C web build`（預設 Turbopack） |
| `perf:lab` | LCP／INP／CLS／TTFB 的 p75（CPU×4） | 量測庫＋app；Playwright Chromium |
| `perf:trail` | 「現在」橫幅 Pixel Card（規格④ C4-02 取代 Pixel Trail）的主執行緒占用與長任務 | 同上 |

## 1. 建隔離量測庫（可重建）

```sh
export PERF_PASSWORD='至少 16 個字的密碼'      # owner、fju_app、三個量測帳號共用；不寫進任何檔、不印出
pnpm -C web perf:db up --dataset normal        # 或 --dataset x3
```

`up` 依序：起 `postgres:16.10-alpine` 容器 `fju-perf-pg`（port 5499，`log_statement=all`、`log_line_prefix='%m [%p] %u@%d '`）→ owner 跑 `db:migrate` → 設 `fju_app` 密碼 → `FJU_SITE=test seed-demo.mjs`（隔離庫，不是測試站）→ `accounts.mjs setup` → （x3）`dataset.mjs x3`。

- 量測帳號：學生 `411410123@demo.invalid`（林彥廷）、老師 `chen.ch@demo.invalid`（陳建宏）、系辦 `perf-admin@perf.invalid`。示範帳號原本沒有密碼，`setup` 給它們加一列 credential 密碼；三個都 `active`、`must_change_password=false`，老師補 `profile_completed_at`（不然被導去補資料）；DEMO-114 設成預設屆別。
- `--dataset x3`：示範屆別的本屆學生、組別與成員、發布中作業與繳交、每人通知、同意書版本各 ×3（新 uuid；學號、Email、組別代碼加 `-p2`／`-p3`；只動 `dataset.mjs` 表頭 `TABLES` 列的表；一個交易，失敗就 rollback），跑完印出每張表前後列數。seed-demo 不寫通知，所以 `notifications` 是 0 → 0。
- 已經有同名的庫就報錯（不重複種）；要重建先 `perf:db down`。`down` 只刪 `fju-perf-pg` 這個名字的容器。
- 其他參數：`--name`、`--port`（同一台要開兩個庫時用）；沒有 docker 的機器用 `--engine native --pg-bin <postgres 的 bin 目錄>`（資料目錄在 `$TMPDIR/fju-perf/<name>`，log 寫到該目錄的 `postgres.log`，`perf:sql` 會自己找到）。

起 app（**不要開** `BUSINESS_CLOCK_OVERRIDE_ENABLED`，也**不要起 worker**——它也用 `fju_app` 連線，輪詢會被算進 SQL）：

```sh
pnpm -C web build
DATABASE_URL=postgres://fju_app@127.0.0.1:5499/fju PGPASSWORD="$PERF_PASSWORD" \
  BETTER_AUTH_SECRET=… BETTER_AUTH_URL=http://localhost:3399 pnpm -C web start --port 3399
pnpm -C web perf:db check --base http://localhost:3399   # 三個帳號登入、GET 自己的首頁都要 200
```

## 2. `perf:sql`

```sh
pnpm -C web perf:sql --base http://localhost:3399 --as teacher [--routes /dashboard/teacher,…] \
  [--expect scripts/perf/sql-expect.json] [--json out.json] [--dump /dashboard/teacher]
node --test 'scripts/perf/*.test.mjs'   # 判定邏輯的單元測試（scripts/perf 不在 vitest unit 專案裡）
```

- `--as`：`student`／`teacher`／`admin`（上面的固定帳號）、`anonymous`、或任一 email（密碼同 `PERF_PASSWORD`）。
- 沒給 `--routes`：該角色的預設後台路由＋公開頁 `/`、`/honors`、`/news`。學生的 `grading`、`industry`、`timeline` 刻意不放（學生 ST-7 會把它們轉址）。
- 每路由抓兩次（第一次暖機），只算第二次；owner 連線送 `PERFMARK BEGIN/END` 標記，從 log 取兩標記間 `fju_app` 的 `statement`／`execute`。log 來源：docker `docker logs <name>`、native 的 log 檔、或 `--log-cmd "<指令>"`。
- 分類照 `signatures.json`（正規化後語句的**前綴**）：`identity`／`badge`／其餘 `page`，每條實際 SQL 都算一類，三類相加＝`total`。`duplicates` 只是診斷。`--dump <route>` 印出該路由每條正規化語句與分類——查詢文字改了，用它看新樣子、更新簽名。
- 不跟隨轉址：`status` 是原始碼；不是 200 的列全標 `N/A`，exit 1。
- `--expect`：`total > max`、`identity` 超過、`noDuplicate` 的簽名出現在 `duplicates`、或該簽名在這個路由一句都對不到（簽名過期）→ exit 1，並列出 `duplicates` 與前 5 大表。
- **身分快取開著跑**（SH-B1）：app 不要帶 `IDENTITY_CACHE_TTL_SECONDS`（預設 60 秒；啟動 log 印 `identity cache: ttl 60s`）。每路由第二次抓取時同一張 cookie 命中快取，身分 SQL 是 0，`sql-expect.json` 與兩個 `sql-expect.timeline-*.json` 的 `identity` 都是 0。用 `IDENTITY_CACHE_TTL_SECONDS=0` 起的 app（e2e 那種）量，`identity` 不會是 0，期望檔必然失敗，這是預期的。

## 3. `perf:bundle`

```sh
pnpm -C web build && pnpm -C web perf:bundle [--write-baseline] [--budget …] [--dir <web 目錄>]
```

讀 `.next/diagnostics/route-bundle-stats.json`（Next 16.3.8 只在 Turbopack 建置時寫），每路由 `firstLoadChunkPaths` 去重、逐檔 gzip（level 9）加總。缺 manifest、缺 chunk、預算列的路由不在 manifest、manifest 的路由沒有預算列 → exit 1，不印假的 0。超過 `limit` → exit 1 並列最大 5 個 chunk。也檢查 `$shared`（每路由都載入的 chunk）與三角色首頁不含 `$rules.homeRoutesMustNotContain`。

`--write-baseline` 覆寫每列 `baseline`，`limit = min(ceil(baseline × 1.1), 250)`（baseline 已超過 250 時不封頂）。

## 4. `perf:lab`、`perf:trail`

```sh
pnpm -C web perf:lab --base http://localhost:3399 --as teacher [--routes …] [--runs 5]
pnpm -C web perf:trail --base http://localhost:3399 --as student|teacher [--seconds 5]
```

- `perf:lab`：量 `lab-routes.json` 中 `as` 相同的路由；每路由暖機 1 次再量 N 次（新 context、CPU×4），印 p75。INP 有兩個數：click 事件時長（Event Timing，短於 16 ms 沒有紀錄時取 `first-input`）與「點下去到新頁 `main h1` 出現」。量不到的格 `N/A`、exit 1。✓／✗ 只是和 §7.2 目標對照。
- `perf:trail`：首頁 `section.hero` 上以固定 8 字路徑掃 N 秒，Pixel 開與對照組（`reducedMotion: reduce`）各一次；判定 §7.5（Pixel 開 `scriptPct ≤ 20`、`longTasks === 0`；對照組 `scriptPct ≤ 2`）。Pixel 開那組要找得到 `section.hero [data-testid=hero-pixel]` 而且 `data-running=1`（常駐閃在跑；規格④ §2.3 不准關常駐閃達標），否則算失敗。
- 兩者的數字跟機器與當下負載有關，不同機器不能直接比；`perf:sql`、`perf:bundle` 的數字則與機器無關。

## 5. 基準檔

- `budget.json` 的 `baseline` 是在 `c0f32bd` 用本工具量的（normal 資料集）。`sql-expect.json`、`sql-expect.timeline-*.json` 在 SH-B1 全表重基準（stage-b＋SH-B1，normal 資料集、快取開著）。`c0f32bd` 之後才有的路由，baseline 是加列當下的 main 量的（PR 說明裡註明）。
- 角色規格新增路由：在 `budget.json`、`sql-expect.json`、`lab-routes.json` 加自己的列，不改既有列。
