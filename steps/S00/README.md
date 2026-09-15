# steps/S00｜S00 切片的證據

每張票一份，記錄實際跑出來的東西——指令輸出、資料庫讀回、HTTP 回應、瀏覽器觀測。
不是計畫，也不是「應該會怎樣」。

| 票 | 證據 |
|---|---|
| S00-01 #33 | [typecheck-and-unit.md](S00-01/typecheck-and-unit.md)、[dev-shell.md](S00-01/dev-shell.md) |
| S00-02 #34 | [column-mapping.md](S00-02/column-mapping.md)（欄名對照表） |
| S00-03 #35 | [harness.md](S00-03/harness.md)（含 T3 決定） |
| S00-04 #36 | [empty-db-migration.md](S00-04/empty-db-migration.md) |
| S00-05 #37 | [roles-and-immutability.md](S00-05/roles-and-immutability.md) |
| S00-06 #38 | [lint-fixtures.md](S00-06/lint-fixtures.md) |
| S00-07 #39 | [compose.md](S00-07/compose.md) |
| S00-08 #40 | [health.md](S00-08/health.md) |
| S00-09 #41 | [ci.md](S00-09/ci.md)、[branch-protection.md](S00-09/branch-protection.md)（未套用） |
| S00-10 #42 | [deploy-dry-run.md](S00-10/deploy-dry-run.md) |
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
| `pnpm lint:boundaries-test` | 10/10 符合預期（七反例被擋且理由正確、三合法例放行） |
| `pnpm test:unit` | 59 passed |
| `pnpm test:integration` | 71 passed |
| `pnpm test:e2e` | 6 passed |
| CI 七道 | 全綠，[run 34948147077](https://github.com/roy4222/fju-im-project/actions/runs/34948147077) |

## 不在這一批

真部署、SSH 到校方 VM、線上原型改動、CD 接真部署、worker 與 backup 的實作、
branch protection 的啟用、任何業務案例的 PASS。
