-- S00-05：資料庫角色、逐表權限與不可變資料保護（契約 01 §5；母 spec §4.6）。
--
-- 三個角色：
--   fju_owner  只在 migrate／reset 容器用，擁有 DDL。就是跑這支 migration 的角色。
--   fju_app    app 與 worker 共用的 runtime 角色（是否拆成兩個待 Roy；契約 01 §13）。
--   fju_backup 讀全庫，只能寫 backup_runs（該表在後續切片才建，屆時補 GRANT）。
--
-- 權限一律「白名單」：先 REVOKE ALL，再照契約 01 §5 的逐表矩陣 GRANT 回去。
-- 沒列到的操作就是沒有；fju_app 對所有表都沒有 TRUNCATE 與 DDL。
-- 不可變表除了不給 UPDATE／DELETE，另加 trigger 當第二層。
--
-- 下面的 GRANT 與 trigger **不是手寫的**：由 web/src/infrastructure/db/permissions/matrix.json
-- 經 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對兩邊一致。
-- 新增表請改 matrix.json 再重產，不要手改產生區塊。
--
-- 密碼不在 migration 裡設；由維運依契約 05 §6 以 ALTER ROLE 帶入（本機與測試各自設）。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fju_app') THEN
    CREATE ROLE fju_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fju_backup') THEN
    CREATE ROLE fju_backup LOGIN;
  END IF;
END $$;
--> statement-breakpoint

-- 讓兩個 runtime 角色看得到目前這個 schema，但不能在裡面建東西。
DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO fju_app, fju_backup', current_schema());
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM fju_app, fju_backup', current_schema());
END $$;
--> statement-breakpoint

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON users, accounts, sessions, verifications, cohorts, schema_meta, audit_events, operation_records, domain_events, event_projections, due_work
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON users, accounts, sessions, verifications, cohorts, schema_meta, audit_events, operation_records, domain_events, event_projections, due_work TO fju_app;
--> statement-breakpoint

GRANT INSERT ON users, accounts, sessions, verifications, cohorts, audit_events, operation_records, domain_events, event_projections, due_work TO fju_app;
--> statement-breakpoint

GRANT UPDATE ON users, accounts, sessions, verifications, cohorts, event_projections, due_work TO fju_app;
--> statement-breakpoint

-- 帳本；receipt_purge 清 receipt
GRANT UPDATE (state, receipt, receipt_expires_at, result_ref) ON operation_records TO fju_app;
--> statement-breakpoint

GRANT DELETE ON sessions, verifications TO fju_app;
--> statement-breakpoint

-- 備份角色讀全庫；唯一能寫的 backup_runs 在 S12 才建（matrix.json 的 backupWrites 記著）。
GRANT pg_read_all_data TO fju_backup;
--> statement-breakpoint

-- 不可變表的第二層保護：除了不給 UPDATE／DELETE，trigger 也一律拒絕。
CREATE OR REPLACE FUNCTION fju_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% 是不可變表，不接受 %（契約 01 §5）', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_events_immutable_row ON audit_events;
--> statement-breakpoint

CREATE TRIGGER audit_events_immutable_row
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_events_immutable_truncate ON audit_events;
--> statement-breakpoint

CREATE TRIGGER audit_events_immutable_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS domain_events_immutable_row ON domain_events;
--> statement-breakpoint

CREATE TRIGGER domain_events_immutable_row
  BEFORE UPDATE OR DELETE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS domain_events_immutable_truncate ON domain_events;
--> statement-breakpoint

CREATE TRIGGER domain_events_immutable_truncate
  BEFORE TRUNCATE ON domain_events
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
-- <<< 產生區塊結束 <<<
