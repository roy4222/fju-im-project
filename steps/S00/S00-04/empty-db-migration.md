# S00-04 證據：第一支 migration 在空庫建表

執行時間：2026-09-15 15:51:14 CST  Node：v22.23.2  PostgreSQL 16.10

## 產生方式（契約 01 §12：drizzle-kit 產生純 SQL）

```bash
pnpm -C web db:generate --name s00_foundation   # 產出 drizzle/0000_s00_foundation.sql
pnpm -C web db:migrate                          # 用 owner 連線套用，並寫 schema_meta
```

## 對真資料庫套用
```
$ node scripts/migrate.mjs
migration 完成；schema_meta.schema_version = 0000_s00_foundation
```

## schema_meta
```
      key       |        value        |          updated_at           
----------------+---------------------+-------------------------------
 schema_version | 0000_s00_foundation | 2026-09-15 07:51:14.625871+00
(1 row)

```

## public schema 的表
```
__drizzle_migrations
accounts
audit_events
cohorts
domain_events
due_work
event_projections
operation_records
schema_meta
sessions
users
verifications
```

## 空庫 migration 自動測試
```
$ vitest run --project integration

 RUN  v3.2.4 /Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web

 ✓ |integration| test/harness.integration.test.ts (10 tests) 188ms
 ✓ |integration| src/infrastructure/db/migrations.integration.test.ts (9 tests) 1096ms

 Test Files  2 passed (2)
      Tests  19 passed (19)
   Start at  15:51:15
   Duration  1.66s (transform 91ms, setup 0ms, collect 610ms, tests 1.28s, environment 0ms, prepare 127ms)

```
