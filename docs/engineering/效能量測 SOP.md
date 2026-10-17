# 效能量測 SOP

> 2026-10-17 新增（共用 SH-7）。工具是共用 SH-0（PR #465）交付的 `web/scripts/perf/**`，指令細節以 [`web/scripts/perf/README.md`](../../web/scripts/perf/README.md) 為準；本頁只寫「什麼時候量、怎麼開隔離庫、看哪個數字、超了怎麼辦」。預算定義在產品總規格 §14.3。

## 1. 什麼時候量

- 改到某一頁的讀取、元件或依賴的 PR：量那一頁的 `perf:sql` 與 `perf:bundle`，數字貼在 PR 說明。
- 改到「現在」橫幅或 Pixel Trail：多跑 `perf:trail`。
- 想看體感（LCP、INP）：`perf:lab`，只在本機或 Review 手動跑。
- A 階段五個命令都**不進 CI**；CI 擋門是 B 的 SH-B3（build 後加 `perf:bundle`）。

## 2. 開隔離量測庫（`perf:db`）

量 SQL 要用**只給量測用的資料庫**，不要接測試站或別人的庫。

1. 設密碼（至少 16 字，不寫進檔案、不印出）：`export PERF_PASSWORD='…'`。
2. 建庫：`pnpm -C web perf:db up --dataset normal`（要放大三倍資料就 `--dataset x3`）。它會依序：起 `postgres:16.10-alpine` 容器 `fju-perf-pg`（port 5499，記錄每一句 SQL）→ 跑 migration → 設 `fju_app` 密碼 → 種示範資料（`FJU_SITE=test seed-demo.mjs`，隔離庫不是測試站）→ 建三個量測帳號並把 `DEMO-114` 設成預設屆別。沒有 docker 的機器加 `--engine native --pg-bin <postgres bin 目錄>`。
3. 起 app：`pnpm -C web build`，再用 `DATABASE_URL=postgres://fju_app@127.0.0.1:5499/fju` 與 `PGPASSWORD` `next start --port 3399`。**不要開** `BUSINESS_CLOCK_OVERRIDE_ENABLED`、**不要起 worker**（worker 也用 `fju_app`，輪詢會被算進 SQL）。不要用 `next dev`（nonce CSP 下 client handler 會壞）。
4. 驗庫：`pnpm -C web perf:db check --base http://localhost:3399`，三個量測帳號（學生林彥廷、老師陳建宏、系辦 `perf-admin@perf.invalid`）登入後 GET 自己的首頁都要 200。
5. 量完：只停自己起的 `next start` PID；`pnpm -C web perf:db down` 只刪 `fju-perf-pg` 這個名字的容器（同一台開兩個庫時用 `--name`、`--port` 分開）。

## 3. 四個量測命令

| 命令 | 量什麼 | 判定 |
|---|---|---|
| `perf:sql --base … --as student\|teacher\|admin [--routes …] [--expect scripts/perf/sql-expect.json]` | 每頁送出幾句 SQL，分「身分／徽章／頁面」三類（相加＝總數），另列重複語句 | 對 `sql-expect.json`：總數不比 c0f32bd 基準差、身分一般 ≤ 7（老師頁含 `needsSetup` ≤ 8）、具名 workload 查詢零重複；轉址或非 200 標 `N/A` 並失敗 |
| `perf:bundle [--write-baseline]` | 每路由 First Load JS（gzip），讀 Turbopack 建置的 `route-bundle-stats.json` | 對 `budget.json`：每路由 ≤ `limit`（`min(ceil(baseline×1.1), 250)`，Q106）、共用 chunk ≤ 230 KB、三角色首頁不含 `recharts` |
| `perf:lab --as … [--runs 5]` | CPU×4 下 LCP／INP／CLS／TTFB 的 p75（暖機 1 次＋量 5 次） | 對總規格 §14.3 的本機目標；量不到標 `N/A` |
| `perf:trail --as student\|teacher` | Pixel Trail 開／關兩組的主執行緒占用與長任務 | Trail 開：腳本占用 ≤ 20%、長任務 0；對照組 ≤ 2%；首頁沒掛 Trail 也算失敗 |

`perf:sql`、`perf:bundle` 的數字跟機器無關，可以跨機器比；`perf:lab`、`perf:trail` 跟機器與當下負載有關，只跟同一台的前後比。

## 4. 新增路由、超標怎麼辦

- 新增路由的票在 `budget.json`、`sql-expect.json`、`lab-routes.json` **各加自己的一列**，不改既有列。
- `perf:bundle` 超過 `limit`：先看輸出列出的最大 5 個 chunk，能 `dynamic import` 或拿掉依賴就拿；確實需要才在 PR 寫理由放寬到現值＋10%，**硬上限 250 KB**（Q106）。
- `perf:sql` 超過：用 `--dump <路由>` 看每條語句與分類，常見是迴圈裡 `await` 查詢（改成 `= any($1)` 一次撈）或同一份資料在外框與頁面各查一次（照共用 SH-P2 改成共用）。查詢文字改了導致簽名對不上，就更新 `scripts/perf/signatures.json`。
- 已知做不到、延到 B 的（例如系辦首頁整頁 ≤ 20 句、身分 ≤ 3 句），在 PR 列出來交主腦，不在 A 硬壓。

## 5. 已知限制（2026-10-17）

- `loadStage`（首頁「現在」橫幅的階段資料）實際是模擬鐘關 **3** 句、開 **4** 句（共用 SH-P3 #428 實測；規格原寫 2／3，主腦 10/16 接受以實際值為準）。
- 老師首頁還沒傳 `trail`，`perf:trail --as teacher` 目前會因「首頁沒掛 Trail」失敗，等整合驗收補上。
