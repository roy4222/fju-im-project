# web/test｜整合測試工具

T3 決定（Roy 2026-09-15，採票上預設）：**自動測試的主要接縫是 application 用例＋真 PostgreSQL**。
整合測試從用例進去、打真的資料庫，同一個測試同時看授權、狀態、交易、唯一性、歷史、並行、
冪等與 DB 角色拒絕（母 spec §5、契約 04 §2）。不用 in-memory 假資料庫。

## 先把資料庫起起來

```bash
pnpm -C web db:up                 # = docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres
docker compose ps postgres        # 應該是 healthy
```

**一定要帶 `docker-compose.local.yml`**：基礎 `docker-compose.yml` 是 VM 上的樣子，
postgres 不對宿主機發布 port（SOP 01 §4 的 ufw 只開 22/80/443）。本機覆蓋才會把 5432
發布出來，而且只綁 `127.0.0.1`——同一台機器連得到，LAN 上的其他人連不到（review R3）。

只會起本專案自己的 `fju-postgres`（project name `fju-im-project`、對外埠 `127.0.0.1:55432`、
volume `fju-im-project-pgdata`），不動這台機器上其他容器。停掉用 `pnpm -C web db:down`，
資料保留；要連資料一起清才用 `docker compose down -v`。

## 跑測試

```bash
pnpm -C web test:unit          # 不需要資料庫
pnpm -C web test:integration   # 需要 postgres
pnpm -C web test               # 兩個都跑
```

連線字串預設 `postgres://fju_owner:fju_local_dev@127.0.0.1:55432/fju`，
可用 `TEST_DATABASE_URL` 覆寫。連不到時測試會**明確失敗**並告訴你去跑 `docker compose up -d postgres`，
不會靜靜跳過。連線字串的主機**不是本機**（localhost／127.0.0.1／::1）時 globalSetup 直接拒絕，
免得 shell 裡沿用了別的環境的 `DATABASE_URL_OWNER` 就去建角色、改密碼。

### runtime 角色與密碼（globalSetup）

`test/global-setup.ts` 在整套整合測試開始前跑一次：先建好 `fju_app`／`fju_backup`
（角色是 cluster 共用的，各 schema 同時套 migration 0001 會撞建角色的競態），再把兩個角色的
測試密碼設好——**用測試密碼登入得了就不改**。`poolAsRole()` 只負責連線，不再 `ALTER ROLE`。

測試密碼是 `TEST_FJU_APP_PASSWORD`／`TEST_FJU_BACKUP_PASSWORD`，沒設就是 `fju_app_local_test`／
`fju_backup_local_test`。本機若同一個資料庫上還跑著 app／worker（`.env` 的 `DATABASE_URL` 用 `fju_app`），
把 `TEST_FJU_APP_PASSWORD` 設成那個密碼，整合測試就不會改掉它、讓 app 登入失敗。
CI 的 integration 與 e2e-smoke 各自起一個 PostgreSQL service，不受影響。

## 隔離：每個測試一份自己的 schema

```ts
import { withIsolatedDatabase } from './db'

await withIsolatedDatabase({ label: 'submission' }, async (db) => {
  await db.sql('create table ...')
  // db.db 是綁在同一個池上的 drizzle 實例
})
```

`createIsolatedDatabase()` 會建一個唯一名稱的 PostgreSQL schema，把連線的 `search_path`
指過去，`close()` 時 `DROP SCHEMA ... CASCADE`。所以兩個測試同時建同名的表也不會互相污染
（`harness.integration.test.ts` 有自測證明）。`setup` 參數用來在 schema 建好後套 migration。

手動控制交易用 `inTransaction(db, fn)`（body 丟例外就 ROLLBACK），或 `db.connect()` 自己借連線。

## 並行：用同步屏障，不要用 sleep

```ts
import { createBarrier } from './barrier'

const bothInTransaction = createBarrier(2)
// 兩個並行的交易各自 await bothInTransaction.arrive()，到齊才一起往下走
```

屏障預設 5 秒逾時，逾時會丟明確的錯誤而不是靜靜過去；某一方失敗時用 `abort(reason)`
叫醒還在等的人。母 spec §5：「並行與故障用同步屏障，不用固定 sleep」。

## 故障注入

被測程式在可以被中斷的位置呼叫 `reachFaultPoint('<名稱>')`（`@/shared/fault-points`）。
正常情況下它是立即回傳的 no-op；只有 `FAULT_INJECTION_ENABLED=true` 才會查註冊表。

```ts
import { enableFaultInjection, failAt } from './fault-injection'

const disable = enableFaultInjection()
failAt('uow.before-commit')      // 模擬 commit 前程序掛掉
// ...
disable()                         // 清掉註冊並還原旗標
```

目前約定的注入點：`uow.before-commit`、`uow.after-commit`、`outbox.after-insert`、
`worker.before-claim`、`worker.after-claim`、`worker.before-handler`、`file.after-upload`、
`group.establish.after-release`、`group.member.add.before-insert`、`group.dissolve.after-writes`、`item.publish.after-roster`、`advisor.claim.before-insert`。
要加新的注入點就改 `@/shared/fault-points` 的 `FaultPointName`。
沒開旗標時 `injectFault` 會直接丟錯，避免注入行為不小心留在 production 路徑上。

## run manifest

`buildRunManifest()` 與 `writeRunManifest()` 產出契約 04 §7 的最小欄位
（`runId`、`kind`、`commit`、`imageDigest`、`schemaVersion`、`workerVersion`、`env`、
`dataset`、`businessClockStart`、`startedAt`、`operator`）。commit 直接讀 `git rev-parse HEAD`。

## 這套工具自己的測試

`test/harness.integration.test.ts` 證明：兩個測試並行寫同名表不衝突、schema 在 close 後真的消失、
屏障能讓兩筆交易在指定點會合（後到的那筆確實被鎖擋住直到前一筆 commit）、逾時與 abort 會報錯、
交易 helper 會 rollback、注入點沒開旗標時是 no-op、manifest 欄位齊全。

## A-19 解散組別：鎖順序回歸（PR #511）

`src/infrastructure/groups/pg-group-dissolve.integration.test.ts` 的「A-19 鎖順序：套用方案與更正／復核」
包含 `override / edit-first`、`override / apply-first`、`resolveReview / edit-first`、`resolveReview / apply-first` 四案。
第一個操作在真實資料庫取鎖後暫停；第二個操作由 `pg_blocking_pids` 證實等待指定的第一個 backend，才放行屏障。
不攔第二個鎖的完成，避免修正後的正確排隊反而被測試屏障卡住。交易一律在 `finally` 放行並排空。

行為斷言：更正／復核先取得組別鎖時，兩操作皆成功；套用先取得組別鎖時，套用成功，舊成績基礎的更正／復核回 `CONFLICT`。
四案均不得出現 PostgreSQL `40P01` 或操作 `INTERNAL`，且最後版本與待復核狀態正確。

### 新增／改動鎖盤點

以下是 A-19 相對 `stage-b 0baeb17` 的全部四個新增顯式 SQL 取鎖點；S＝`FOR SHARE`，U＝`FOR UPDATE`。
沒有新增或改動 advisory lock。組別集合一律依 id 排序，單組操作只有一列。

| SQL 點 | 修正後完整順序 | 掃描結論 |
|---|---|---|
| `pg-grading-results.ts`：`applySchemeVersion` 全屆 groups S | cohort S → groups S（id）→ scheme U → target version U → override states U | 原先 scheme／version 在 groups 前；本次移到 groups 後 |
| `pg-grading-dissolution.ts`：active assignments U | caller cohort S → group U → assignments U（id） | scheme／version 只讀；與套用以 group 鎖互斥 |
| 同檔：draft evaluation statuses U | 上列 → statuses U（evaluation_id） | 不回頭取 group 或 scheme |
| `pg-signoff.ts`：`voidForDissolution` 的 `FOR UPDATE OF p,s` | 上列解散順序 → packages／current version statuses U（查詢依 purpose 排序） | group U 先排除同組簽核寫入；不把 JOIN 宣稱成保證先 p 後 s |

`dissolveGroup` 是新 caller，重用既有 `#lockGroup` 的 cohort S → group U；這兩個 SQL 本身沒有改動。
以下同時掃描相關既有路徑，確認沒有 scheme／version → group 的反向取鎖：

| 寫入路徑 | 鎖順序 |
|---|---|
| `override`／`resolveReview` | cohort S → group U → scheme S；復核再取 override state U |
| `returnEvaluation` | cohort S → group S → scheme S → assignment U → evaluation status U |
| `removeAssignment` | cohort S → group S → scheme S → assignments U（id）→ target assignment U → requirement U → draft statuses U |
| `setRequirement`／`assign` | cohort S → group S → scheme S → requirement U／新增 assignment |
| `saveDraft`／`submitFinal` | cohort S → group S → scheme S → assignment U；首份評分 UPDATE version 也在 group 後 |
| `createSchemeVersion`／`publishScheme` | cohort S → scheme U → version；不回頭鎖 group |
| 簽核 create／respond／restart／void／remind | cohort S → group S → package U → status U |
| 簽核 participant-change hook | caller 已持 group U／NO KEY UPDATE，才取 packages／statuses |
| `lockLeaderships` | groups 依 id 逐一取鎖；不碰評分方案／版本 |

這是原碼路徑盤點；並行實測範圍為四個新案例、原有解散／套用雙向案例及解散／送分案例。
`c752a0b` 尚無全組鎖，edit-first 兩案會因先行更正／復核得到 `CONFLICT` 而失敗，並非死鎖；
`9cb6f18` 四案均重現 `40P01`。修正後四案通過。第一輪理由保密、明確 null 方案快照、解散與套用序列化的斷言保留。
