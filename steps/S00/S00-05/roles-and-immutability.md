# S00-05 證據：資料庫角色、逐表權限與不可變保護

執行時間：2026-09-15 15:54:25 CST  PostgreSQL 16.10

## 三個角色
```
  rolname   | rolsuper | rolcanlogin | rolcreatedb | rolcreaterole 
------------+----------+-------------+-------------+---------------
 fju_app    | f        | t           | f           | f
 fju_backup | f        | t           | f           | f
 fju_owner  | t        | t           | t           | t
(3 rows)

```

## public schema 上 fju_app 的表級權限（與契約 01 §5 矩陣逐列對照）
```
    table_name     |           privileges           
-------------------+--------------------------------
 accounts          | INSERT, SELECT, UPDATE
 audit_events      | INSERT, SELECT
 cohorts           | INSERT, SELECT, UPDATE
 domain_events     | INSERT, SELECT
 due_work          | INSERT, SELECT, UPDATE
 event_projections | INSERT, SELECT, UPDATE
 operation_records | INSERT, SELECT
 schema_meta       | SELECT
 sessions          | DELETE, INSERT, SELECT, UPDATE
 users             | INSERT, SELECT, UPDATE
 verifications     | DELETE, INSERT, SELECT, UPDATE
(11 rows)

```

## 欄級 UPDATE：operation_records 只有四欄可改
```
    column_name     
--------------------
 receipt
 receipt_expires_at
 result_ref
 state
(4 rows)

```

## fju_backup 的權限（讀全庫，無表級寫入）
```
    member_of     
------------------
 pg_read_all_data
(1 row)

0
```

## 不可變表的 trigger（row 與 statement 各一）
```
    relname    |              tgname              
---------------+----------------------------------
 audit_events  | audit_events_immutable_row
 audit_events  | audit_events_immutable_truncate
 domain_events | domain_events_immutable_row
 domain_events | domain_events_immutable_truncate
(4 rows)

```

## roles 測試：允許的做得到＋沒給的被拒（契約 01 §5「只測禁止不算通過」）
```

 RUN  v3.2.4 /Users/lubaiyu/fju-project/.claude/worktrees/ssh-connection-4ed37a/web

 ✓ |integration| src/infrastructure/db/roles.integration.test.ts (20 tests) 347ms

 Test Files  1 passed (1)
      Tests  20 passed (20)
   Start at  15:54:26
   Duration  974ms (transform 59ms, setup 0ms, collect 327ms, tests 347ms, environment 0ms, prepare 52ms)

```

## 尚未涵蓋

- `fju_backup` 對 `backup_runs` 的 INSERT：該表在後續切片才建，屆時補 GRANT。
- 契約 01 §5 驗收第（2）項的正向用例（核准、改密、確認提案、正式送分、簽核同意…）需要 S01 起的業務用例，本切片沒有可跑的用例；S00 只證明逐表權限與不可變保護。
- 待 Roy（契約 01 §13）：`fju_app` 是否拆成 app 與 worker 兩個 runtime 角色；目前照預設共用一個。
- 本機的 `fju_owner` 是 Docker 映像的 `POSTGRES_USER`，因此帶 superuser。superuser 會繞過
  GRANT，但**不會**繞過 trigger——上面「連 owner 自己想改 audit_events 也會被擋下」就是這件事的證明。
  VM 上的 owner 依契約 05 §6 由維運建立，不必是 superuser。
