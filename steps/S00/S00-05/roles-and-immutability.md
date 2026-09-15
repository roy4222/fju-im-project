# S00-05 證據：資料庫角色、逐表權限與不可變保護

執行時間：2026-09-15 17:43:14 CST  PostgreSQL 16.10

## 表驅動的矩陣與 GRANT 產生器（review R7）

唯一正文位置是契約 01 §5；`web/src/infrastructure/db/permissions/matrix.json` 是它的機器可讀鏡像。
migration 的 GRANT 與不可變 trigger **不是手寫的**，由矩陣產生：

```bash
pnpm -C web db:grants            # 印出會產生的 SQL
pnpm -C web db:grants --write    # 寫回 migration 的標記區塊
pnpm -C web db:grants --check    # 核對 migration 與矩陣一致（CI lint 那道會跑）
```

### 矩陣內容

| 表 | SELECT | INSERT | UPDATE | DELETE | 不可變 | worker 也用 |
|---|---|---|---|---|---|---|
| users | ✓ | ✓ | 整列 | — | — | ✓ |
| accounts | ✓ | ✓ | 整列 | — | — | — |
| sessions | ✓ | ✓ | 整列 | ✓ | — | ✓ |
| verifications | ✓ | ✓ | 整列 | ✓ | — | — |
| cohorts | ✓ | ✓ | 整列 | — | — | ✓ |
| schema_meta | ✓ | — | — | — | — | ✓ |
| audit_events | ✓ | ✓ | — | — | ✓ | ✓ |
| operation_records | ✓ | ✓ | state、receipt、receipt_expires_at、result_ref | — | — | ✓ |
| domain_events | ✓ | ✓ | — | — | ✓ | ✓ |
| event_projections | ✓ | ✓ | 整列 | — | — | ✓ |
| due_work | ✓ | ✓ | 整列 | — | — | ✓ |

`fju_backup`：`pg_read_all_data`；唯一能寫的 `backup_runs` 在 S12 才建，矩陣的 `backupWrites` 記著。

### 產生出來的 SQL

```sql
-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON users, accounts, sessions, verifications, cohorts, schema_meta, audit_events, operation_records, domain_events, event_projections, due_work
  FROM fju_app, fju_backup;
GRANT SELECT ON users, accounts, sessions, verifications, cohorts, schema_meta, audit_events, operation_records, domain_events, event_projections, due_work TO fju_app;
GRANT INSERT ON users, accounts, sessions, verifications, cohorts, audit_events, operation_records, domain_events, event_projections, due_work TO fju_app;
GRANT UPDATE ON users, accounts, sessions, verifications, cohorts, event_projections, due_work TO fju_app;
-- 帳本；receipt_purge 清 receipt
GRANT UPDATE (state, receipt, receipt_expires_at, result_ref) ON operation_records TO fju_app;
GRANT DELETE ON sessions, verifications TO fju_app;
-- 備份角色讀全庫；唯一能寫的 backup_runs 在 S12 才建（matrix.json 的 backupWrites 記著）。
GRANT pg_read_all_data TO fju_backup;
-- 不可變表的第二層保護：除了不給 UPDATE／DELETE，trigger 也一律拒絕。
CREATE OR REPLACE FUNCTION fju_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% 是不可變表，不接受 %（契約 01 §5）', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;
DROP TRIGGER IF EXISTS audit_events_immutable_row ON audit_events;
CREATE TRIGGER audit_events_immutable_row
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
DROP TRIGGER IF EXISTS audit_events_immutable_truncate ON audit_events;
CREATE TRIGGER audit_events_immutable_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
DROP TRIGGER IF EXISTS domain_events_immutable_row ON domain_events;
CREATE TRIGGER domain_events_immutable_row
  BEFORE UPDATE OR DELETE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
DROP TRIGGER IF EXISTS domain_events_immutable_truncate ON domain_events;
CREATE TRIGGER domain_events_immutable_truncate
  BEFORE TRUNCATE ON domain_events
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
-- <<< 產生區塊結束 <<<
```

## 逐格驗證（矩陣驅動）

`roles.integration.test.ts` 直接讀矩陣，對**每一張表的每一格**同時驗「該准的准」與「該擋的擋」，
另外驗 TRUNCATE／DDL／`SET ROLE fju_owner` 一律拒絕、不可變表的兩個 trigger、
以及 `fju_backup` 每張表讀得到但寫不進去。

```

 Test Files  1 passed (1)
      Tests  101 passed (101)
   Start at  17:43:15
   Duration  1.25s (transform 68ms, setup 0ms, collect 325ms, tests 652ms, environment 0ms, prepare 78ms)

```

## 突變測試：證明這套測試真的抓得到

R7 的原話是「移除必要 GRANT 或多給 DELETE 仍可能全綠」。實際改壞再跑：

| 突變（只改 migration，不動矩陣） | `db:grants --check` | roles 測試 |
|---|---|---|
| 拿掉 `GRANT DELETE ON sessions` | exit 1，報告不一致 | `fju_app × sessions > DELETE 允許` 失敗 |
| 多給 `GRANT DELETE ON due_work` | exit 1，報告不一致 | `這個操作應該被拒絕但成功了：delete from due_work` |

兩層防線：`--check` 抓「SQL 與矩陣不一致」，roles 測試抓「資料庫實際權限與矩陣不一致」。

## 尚未涵蓋

- `fju_backup` 對 `backup_runs` 的 INSERT：該表在 S12 才建。
- 契約 01 §5 驗收第（2）項的正向**業務**用例（核准、改密、確認提案、正式送分、簽核同意…）要等 S01 起才有用例可跑。
- **待 Roy（T1／契約 01 §13）**：`fju_app` 是否拆成 app 與 worker 兩個 runtime 角色。矩陣已經有 `worker` 欄記著哪些表 worker 也用，真的要拆時加一個角色與一欄即可；目前照預設共用。

## 票模板

「新增表必擴充權限矩陣與 roles.test」已寫進 `docs/engineering/slices/🎫 票草稿/00 總索引.md` §0 的每票固定欄位。
