# steps/S00｜S00 切片的證據

每張票一份，記錄實際跑出來的東西——指令輸出、資料庫讀回、HTTP 回應、瀏覽器觀測。
不是計畫，也不是「應該會怎樣」。

| 票 | 證據 |
|---|---|
| S00-01 #33 | [typecheck-and-unit.md](S00-01/typecheck-and-unit.md)、[dev-shell.md](S00-01/dev-shell.md) |
| S00-02 #34 | [column-mapping.md](S00-02/column-mapping.md)（欄名對照表） |
| S00-03 #35 | [harness.md](S00-03/harness.md)（含 T3 決定） |
| S00-04 #36 | [empty-db-migration.md](S00-04/empty-db-migration.md) |
| S00-05 #37 | [roles-and-immutability.md](S00-05/roles-and-immutability.md)（矩陣、產生器、突變測試） |
| S00-06 #38 | [lint-fixtures.md](S00-06/lint-fixtures.md) |
| S00-07 #39 | [compose.md](S00-07/compose.md) |
| S00-08 #40 | [health.md](S00-08/health.md) |
| S00-09 #41 | [ci.md](S00-09/ci.md)、[branch-protection.md](S00-09/branch-protection.md)（未套用） |
| S00-10 #42 | [deploy-dry-run.md](S00-10/deploy-dry-run.md)、[r4-r5-repro.md](S00-10/r4-r5-repro.md)（失敗情境重現與對照） |
| S00-11 #43 | [csp.md](S00-11/csp.md)、[csp-observed.json](S00-11/csp-observed.json)、[page-after-injection.png](S00-11/page-after-injection.png) |

## 環境

Node v22.23.2、pnpm 11.0.9、PostgreSQL 16.10（Docker Desktop 29.1.3）、Next 16.3.3、macOS arm64。

## 本機怎麼重現

```bash
nvm use 22
pnpm install --filter @fju/web...
docker compose up -d                      # 六個服務
pnpm -C web typecheck
pnpm -C web lint
pnpm -C web lint:boundaries-test
pnpm -C web test:unit
pnpm -C web test:integration
pnpm -C web test:e2e
docker compose down                       # 停掉，資料保留
```

只要開發伺服器：`docker compose up -d postgres` 再 `pnpm -C web dev`（port 3000）。

## 這一輪的實際結果（2026-09-15）

| 項目 | 結果 |
|---|---|
| `pnpm typecheck` | 綠 |
| `pnpm lint` | 綠 |
| `pnpm lint:boundaries-test` | 19/19 符合預期（13 反例被擋且理由正確、6 合法例放行） |
| `pnpm -C web db:grants --check` | migration 的 GRANT 與權限矩陣一致 |
| `pnpm test:unit` | 74 passed |
| `pnpm test:integration` | 172 passed（roles 的 UPDATE 從抽樣改成逐欄，案例數變少、覆蓋變大：11 表 117 欄） |
| `pnpm test:e2e` | 6 passed |
| CI 七道 | 全綠 |

## review

第一輪（Codex 在 PR #199 上）五個 P1，全部已修、thread 已 resolve：

| # | 問題 | commit |
|---|---|---|
| 1 | health 整合測試打未 migrate 的 `public` schema，CI 上必紅 | `3158ce6` |
| 2 | `<tag>` 沒綁到 Compose 的映像，`--execute` 會部署到錯的版本 | `23f3ed3` |
| 3 | 回滾沒換回舊映像，掛掉的版本繼續跑卻記 `rollback-done` | `23f3ed3` |
| 4 | 只傳 `EXPECT_TAG`，四項健康門檻退化成一項 | `23f3ed3` |
| 5 | 容器永遠回 `imageDigest: null` | `23f3ed3` |

第二輪（`/private/tmp/fju-pr199-review/REVIEW.md`，R1–R7），全部已修：

| R | 問題 | commit |
|---|---|---|
| R1 | 稽核報告沒跑成功（registry 失敗）也 exit 0 | `3b2d546` |
| R2 | lint 沒落實跨模組 type-only 與公開入口 | `8af1b97` |
| R3 | postgres 對宿主機所有介面發布 | `b4d79d6` |
| R4 | 啟動新版失敗會跳過回滾與部署紀錄 | `dea73e7` |
| R5 | 回滾連帶重跑舊 migration，schema metadata 倒退 | `dea73e7` |
| R6 | Caddy 上限 50MB，比契約的 105MB 小 | `7d17739` |
| R7 | 缺權限矩陣產生器與逐格驗證 | `2e66ead` |

第三輪（`REVIEW-992aeb1.md`）：R1／R3／R4／R5／R6 結案，另三項 P2 也已修：

| R | 問題 | commit |
|---|---|---|
| R2a | `export … from` 繞過公開入口與 type-only | `2431baf` |
| R2b | infrastructure 被整層豁免，私有入口仍可直接引用 | `2431baf` |
| R7 | 欄位 UPDATE 只抽樣，沒有逐欄驗收 | `942a575` |

## 不在這一批

真部署、SSH 到校方 VM、線上原型改動、CD 接真部署、worker 與 backup 的實作、
branch protection 的啟用、任何業務案例的 PASS。
