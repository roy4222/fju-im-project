# S00-03 證據：真 PostgreSQL 整合測試 harness

執行時間：2026-09-15 17:48:20 CST  Node：v22.23.2

## T3 決定

Roy 於 2026-09-15 回覆：**採票上預設「application 用例＋真 PostgreSQL」**。in-memory 假資料庫與只測 repository 層兩個選項都未採用。

## 怎麼起資料庫

```bash
pnpm -C web db:up      # = docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres
pnpm -C web db:down
```

一定要帶 `docker-compose.local.yml`：基礎 compose 是 VM 上的樣子，postgres 不對宿主機發布 port（review R3）。本機覆蓋才發布，而且只綁 `127.0.0.1`。

```
NAME           IMAGE                   COMMAND                  SERVICE    CREATED         STATUS                   PORTS
fju-postgres   postgres:16.10-alpine   "docker-entrypoint.s…"   postgres   4 minutes ago   Up 4 minutes (healthy)   127.0.0.1:55432->5432/tcp
```

## postgres 版本與隔離設定
```
PostgreSQL 16.10 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 14.2.0) 14.2.0, 64-bit
project name: fju-im-project
container:    fju-postgres
port:         127.0.0.1:55432 -> 5432（只有本機覆蓋才發布）
volume:       fju-im-project-pgdata
```

## 這台機器上其他容器未受影響
```
fju-caddy	caddy:2.10-alpine	Up 58 seconds
fju-app	ghcr.io/roy4222/fju-web:local	Up 58 seconds (healthy)
fju-worker	ghcr.io/roy4222/fju-web:local	Up 58 seconds
fju-backup	postgres:16.10-alpine	Up 59 seconds
fju-postgres	postgres:16.10-alpine	Up 4 minutes (healthy)
n8n	docker.n8n.io/n8nio/n8n	Up 3 hours
```

## pnpm test:integration（全部整合測試）
```
   ✓ 注入：migrate 失敗時 app 不啟動 > migrate 非 0 結束，app 不會被啟動  5301ms
 ✓ |integration| test/ops/deploy-execute.integration.test.ts (11 tests) 18721ms
   ✓ 順利部署 > 七步走完、deploy_log 記 deployed  1056ms
   ✓ 順利部署 > app 與 worker 是用 --no-deps 起的（migration 第 4 步已經跑過）  791ms
   ✓ R4：啟動新版失敗 > 不是直接被 set -e 帶走——會走補償流程並留下紀錄  689ms
   ✓ R4：啟動新版失敗 > 回滾真的把 APP_IMAGE 換回前一版再啟動  742ms
   ✓ R4：啟動新版失敗 > 沒有前一版可回滾時明講，不假裝成功  388ms
   ✓ R4：啟動新版失敗 > postgres 起不來也走同一條補償流程  563ms
   ✓ R5：回滾不可以重跑舊 migration > 整個回滾過程沒有再執行過 migrate  4645ms
   ✓ R5：回滾不可以重跑舊 migration > 回滾的 up 帶 --no-deps，不會讓 compose 去滿足 migrate 依賴  4612ms
   ✓ R5：回滾不可以重跑舊 migration > 健康失敗時回滾到舊映像並重跑健康判定，schema 維持新的  4626ms
   ✓ 更前面的步驟失敗就不會動到 app > migrate 失敗直接中止，舊 app 繼續跑，不啟動新版  325ms

 Test Files  8 passed (8)
      Tests  183 passed (183)
   Start at  17:48:21
   Duration  19.17s (transform 280ms, setup 0ms, collect 3.21s, tests 38.94s, environment 1ms, prepare 1.06s)

```
