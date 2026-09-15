# S00-03 證據：真 PostgreSQL 整合測試 harness

執行時間：2026-09-15 15:46:31 CST  Node：v22.23.2

## T3 決定

Roy 於 2026-09-15 回覆：**採票上預設「application 用例＋真 PostgreSQL」**。in-memory 假資料庫與只測 repository 層兩個選項都未採用。

## docker compose ps postgres
```
NAME           IMAGE                   COMMAND                  SERVICE    CREATED         STATUS                   PORTS
fju-postgres   postgres:16.10-alpine   "docker-entrypoint.s…"   postgres   3 minutes ago   Up 3 minutes (healthy)   0.0.0.0:55432->5432/tcp, [::]:55432->5432/tcp
```

## postgres 版本與隔離設定
```
PostgreSQL 16.10 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 14.2.0) 14.2.0, 64-bit
project name: fju-im-project
container:    fju-postgres
port:         55432 -> 5432
volume:       fju-im-project-pgdata
```

## 這台機器上其他容器未受影響
```
fju-postgres	postgres:16.10-alpine	Up 3 minutes (healthy)
n8n	docker.n8n.io/n8nio/n8n	Up 30 minutes
```

## pnpm test:integration（harness 自測）
```
$ vitest run --project integration

 RUN  v3.2.4 /Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web

 ✓ |integration| test/harness.integration.test.ts (10 tests) 321ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  15:46:32
   Duration  996ms (transform 61ms, setup 0ms, collect 384ms, tests 321ms, environment 0ms, prepare 77ms)

```
