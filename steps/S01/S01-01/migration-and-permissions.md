# S01-01 證據：第二支 migration、新表權限與約束反例

票：[#44](https://github.com/roy4222/fju-im-project/issues/44)｜執行時間：2026-09-15 20:10 CST｜PostgreSQL 16.10

## 1. 本票新增表 vs S00 已有表（票的完成定義第一項）

| # | 表 | 來源 | 這支 migration | 不可變 | `fju_app` |
|---|---|---|---|---|---|
| 1 | `users` | S00（0000） | **不動** | — | S I U |
| 2 | `accounts` | S00（0000） | **不動** | — | S I U |
| 3 | `sessions` | S00（0000） | **不動** | — | S I U D |
| 4 | `verifications` | S00（0000） | **不動** | — | S I U D |
| 5 | `cohorts` | S00（0000） | **不動** | — | S I U |
| 6 | `schema_meta` | S00（0000） | **不動** | — | S |
| 7 | `audit_events` | S00（0000） | **不動** | ✓ | S I |
| 8 | `operation_records` | S00（0000） | **不動** | — | S I U(4 欄) |
| 9 | `domain_events` | S00（0000） | **不動** | ✓ | S I |
| 10 | `event_projections` | S00（0000） | **不動** | — | S I U |
| 11 | `due_work` | S00（0000） | **不動** | — | S I U |
| 12 | `stored_files` | 模組 10 附錄 A | **新增** | — | S I U(9 欄) |
| 13 | `file_references` | 模組 10 附錄 A | **新增** | — | S I U(`released_at`) |
| 14 | `user_profiles` | 模組 01 附錄 A | **新增** | — | S I U |
| 15 | `student_identities` | 模組 01 附錄 A | **新增** | — | S I D |
| 16 | `roster_versions` | 模組 01 附錄 A | **新增** | ✓ | S I |
| 17 | `roster_entries` | 模組 01 附錄 A | **新增** | ✓ | S I |
| 18 | `registration_applications` | 模組 01 附錄 A | **新增** | — | S I U |
| 19 | `application_revisions` | 模組 01 附錄 A | **新增** | ✓ | S I |
| 20 | `role_assignments` | 模組 01 附錄 A | **新增** | — | S I U(3 欄) |
| 21 | `user_status_events` | 模組 01 附錄 A | **新增** | ✓ | S I |
| 22 | `session_revocations` | 模組 01 附錄 A | **新增** | — | S I U |

契約 01 §12 要求「同一支內先建檔案表再建 `roster_versions`」——`stored_files`、`file_references`
排在 migration 最前面，`roster_versions.file_id` 的 FK 目標才存在。

### 逐欄核對

`src/infrastructure/db/s01-accounts.integration.test.ts` 的「逐欄對照附錄 A」把十一張表的
欄位清單寫死在測試裡，用 `information_schema.columns` 逐張比對（多一欄、少一欄都紅）。
另有一條單獨的測試證明 v2.4 已經把 `session_revocations.attempts` 拿掉。

## 2. 兩條 migration 路徑

`DATABASE_URL_OWNER` 指向一個全新的 `fju_s0101_evidence` 資料庫，跑正式那支 `scripts/migrate.mjs`：

```
$ node scripts/migrate.mjs
migration 完成；schema_meta.schema_version = 0002_s01_accounts_and_files
SCHEMA_VERSION=0002_s01_accounts_and_files

$ node scripts/migrate.mjs          # 第二次：no-op
migration 完成；schema_meta.schema_version = 0002_s01_accounts_and_files
SCHEMA_VERSION=0002_s01_accounts_and_files
```

```
$ psql -d fju_s0101_evidence -c '\dt'
 public | __drizzle_migrations      | table | fju_owner
 public | accounts                  | table | fju_owner
 public | application_revisions     | table | fju_owner
 public | audit_events              | table | fju_owner
 public | cohorts                   | table | fju_owner
 public | domain_events             | table | fju_owner
 public | due_work                  | table | fju_owner
 public | event_projections         | table | fju_owner
 public | file_references           | table | fju_owner
 public | operation_records         | table | fju_owner
 public | registration_applications | table | fju_owner
 public | role_assignments          | table | fju_owner
 public | roster_entries            | table | fju_owner
 public | roster_versions           | table | fju_owner
 public | schema_meta               | table | fju_owner
 public | session_revocations       | table | fju_owner
 public | sessions                  | table | fju_owner
 public | stored_files              | table | fju_owner
 public | student_identities        | table | fju_owner
 public | user_profiles             | table | fju_owner
 public | user_status_events        | table | fju_owner
 public | users                     | table | fju_owner
 public | verifications             | table | fju_owner
(23 rows)                                   -- 22 張業務表 + drizzle 自己的追蹤表

$ psql -d fju_s0101_evidence -c 'select * from schema_meta'
 schema_version | 0002_s01_accounts_and_files | 2026-09-15 12:10:31.632968+00
```

同樣三條路徑也寫成自動測試（跑在每個 PR 上）：

| 路徑 | 測試 | 斷言 |
|---|---|---|
| 空庫 S00→S01 升級 | 「空庫：0001 之後只有 S00 十一張表，套上 0002 才長出新的十一張」 | 套到 0001 是 11 張且沒有 `user_profiles`；套 0002 變 22 張，S00 的每一張都還在 |
| S00 的表沒被動到 | 「S00 的表一欄都沒被動到」 | 升版前後逐表比對欄名／型別／可為空三者完全相同 |
| 前一版 seed 庫升版 | 「前一版的 seed 庫升版：既有資料原封不動」 | 先在只有 S00 的庫寫入 user／cohort／audit／session，升版後逐筆讀回相同值，且既有使用者可直接掛上 `user_profiles` |
| 重跑 no-op | 「用正式那支 migrator 跑第二次是 no-op，資料不動」 | 用真的 drizzle migrator 在獨立資料庫跑兩次；`__drizzle_migrations` 筆數兩次都是 3，中間寫入的資料還在，業務表仍是 22 張 |

## 3. 新表的權限（契約 01 §5）

GRANT 不是手寫的：`permissions/matrix.json` 的每一列多了 `slice`，
`scripts/generate-grants.mjs` 依 slice 把 S00 的 GRANT 產生到 `0001`、S01 的產生到 `0002`
（已部署的 0001 一個字都沒改）。CI 的 lint 那道跑 `--check`。

```
$ pnpm -C web db:grants --check
drizzle/0001_s00_roles_and_immutability.sql 的 GRANT 區塊與權限矩陣一致（S00）。
drizzle/0002_s01_accounts_and_files.sql 的 GRANT 區塊與權限矩陣一致（S01）。
```

資料庫實際長出來的樣子：

```
$ psql -c "select table_name, string_agg(distinct privilege_type, ',' order by privilege_type)
           from information_schema.table_privileges where grantee='fju_app' and table_name in (...)"
        table_name         |        privs
---------------------------+----------------------
 application_revisions     | INSERT,SELECT
 file_references           | INSERT,SELECT
 registration_applications | INSERT,SELECT,UPDATE
 role_assignments          | INSERT,SELECT
 roster_entries            | INSERT,SELECT
 roster_versions           | INSERT,SELECT
 session_revocations       | INSERT,SELECT,UPDATE
 stored_files              | INSERT,SELECT
 student_identities        | DELETE,INSERT,SELECT
 user_profiles             | INSERT,SELECT,UPDATE
 user_status_events        | INSERT,SELECT
```

`role_assignments`、`stored_files`、`file_references` 的 UPDATE 是欄級的，所以沒有出現在
上表的 `privs`（PostgreSQL 把欄級權限記在 `column_privileges`）：

```
    table_name    |                                     updatable_columns
------------------+-----------------------------------------------------------------------------
 file_references  | released_at
 role_assignments | reason, revoked_by_user_id, revoked_real_at
 stored_files     | checksum, finalized_at, mime_detected, purged_at, revision, size_bytes,
                  | soft_deleted_at, status, updated_at
```

`roles.integration.test.ts` 是矩陣驅動的，本票之後從 99 條長到 **183 條**：每張新表都同時驗
「該准的准」與「該擋的擋」，UPDATE 是**逐欄**驗的（`set col = col where false` 只觸發權限檢查）。

### 不可變 trigger

```
$ psql -c "select c.relname, t.tgname from pg_trigger t ... where not t.tgisinternal"
 application_revisions | application_revisions_immutable_row / _immutable_truncate
 audit_events          | audit_events_immutable_row / _immutable_truncate          （S00）
 domain_events         | domain_events_immutable_row / _immutable_truncate         （S00）
 roster_entries        | roster_entries_immutable_row / _immutable_truncate
 roster_versions       | roster_versions_immutable_row / _immutable_truncate
 user_status_events    | user_status_events_immutable_row / _immutable_truncate
```

> **與票面文字的一處差異（請 review 時確認）**：#44 第 2 節寫「三張不可變表的 trigger」
> （`application_revisions`、`roster_entries`、`user_status_events`），但**契約 01 §5 的逐表
> 矩陣把 `roster_versions` 也標成不可變**（該列權限是 S I，沒有 U／D）。矩陣是唯一正文位置，
> 而且 `roles.integration.test.ts` 有一條「只有矩陣標 immutable 的表才有 trigger」的反向斷言，
> 所以這裡照契約做了**四張**。這只會更嚴、不會更鬆；若 Roy 認為要以票面三張為準，改
> `matrix.json` 的 `roster_versions.immutable` 再跑 `db:grants --write` 即可。

## 4. 約束反例（故意衝突的寫入）

全部在 `s01-accounts.integration.test.ts`，每一條都是「先插一筆合法的，再插一筆故意衝突的，
斷言被擋，且擋的理由是指定的那個約束名」；能合法放行的情境也一併驗證。

| 約束 | 反例 | 正例 |
|---|---|---|
| `session_revocations` ① `(status_event_id) WHERE trigger='status_event'` | 同一狀態事件插第二筆主工作 → `session_revocations_one_main_per_event` | 換一個狀態事件可以再排一筆 |
| `session_revocations` ② `(user_id) WHERE state='executing'` | 同一人第二筆 executing → `session_revocations_one_executing_per_user` | — |
| `session_revocations` ③ `(user_id) WHERE trigger='reconcile' AND state IN ('queued','executing')` | 兩個核對者同時插收斂工作，第二筆 `ON CONFLICT DO NOTHING` 回 0 列 | 最終只留一筆未結收斂工作 |
| `session_revocations` reconcile 配對 CHECK | 主工作帶 `reconcile_reason` → `..._reconcile_reason_pairing_check`；收斂工作沒帶 `reconcile_of_id` → `..._reconcile_of_pairing_check` | — |
| `session_revocations` `reconcile_round` CHECK | 主工作 round=1 → `..._reconcile_round_check` | — |
| `session_revocations` 租約 CHECK | executing 沒有 `lease_owner`／`lease_expires_at` → `..._lease_check` | — |
| `file_references` 部分唯一（契約 01 §11） | 同一 `(file_id, ref_type, ref_id)` 插第二筆有效引用 → `file_references_active_ref` | 設了 `released_at` 之後可以再附回 |
| `registration_applications` 一次一筆待審 | 同一人第二筆 pending → `registration_applications_one_pending` | rejected／approved 不占鍵，可以有很多筆 |
| `registration_applications` 核准必記核實方式 | approved 沒有 `verification_method` → `..._approved_verification_check`；`other` 沒寫 note → `..._other_note_check` | — |
| `student_identities` 占用表 | 同屆同學號換人占 → `student_identities_pkey` | DELETE 釋放後別人可以占 |
| `role_assignments` 同角色一筆有效 | 同一人第二筆未撤銷的 admin → `role_assignments_one_active` | 設 `revoked_real_at` 之後可以再指派 |
| `roster_entries` 同版本學號唯一 | 同版本同學號第二筆 → `roster_entries_identity` | — |

## 5. 系級（2026-09-15 Roy 定案）

`department_class` 是「資管二甲／資管二乙」這類完整文字，與 `cohort_id`（專題屆別）是兩個
獨立欄位，**不能互相推導**。三張表各有一欄，`application_revisions.snapshot` 存修改歷史：

| 位置 | 欄位 | 用在哪 |
|---|---|---|
| 名單列 | `roster_entries.department_class` | #51 匯入 CSV 帶進來 |
| 註冊申請 | `registration_applications.department_class` | #52 學生填、#57 Google 首次補資料 |
| 申請修改歷史 | `application_revisions.snapshot -> 'departmentClass'` | #52 每次修改留版本 |
| 核准後學生資料 | `user_profiles.department_class` | #53 核准時保存、#59 匯出 |

三欄都是 nullable：**舊資料缺值保留空白，不從屆別猜填**。資料字典同步補在
[模組 01 附錄 A](../../../docs/engineering/modules/01%20帳號與權限.md)。

測試（欄位往返）：
- 「名單列、註冊申請、修改歷史、核准後的個人資料都存得住完整文字」——兩個系級的名單列各讀回原文；
  申請讀回 `資管二甲`；修改歷史兩個 revision 讀回 `資管二甲`／`資管二乙`；個人資料讀回 `資管二乙`，
  且 `cohort_id` 仍是原本的屆別（證明兩者獨立）。
- 「舊資料沒有系級就留白，不從屆別猜填」——用舊的三欄 CSV 形狀插入，讀回 `null`。

**本票不做**：名單匯入（#51）、註冊表單（#52）、審核並列（#53）、Google 補資料（#57）、
名單匯出（#59）。這張票只到「資料存得住、讀得回、缺值留白」。

## 6. 本機跑出來的結果

```
$ pnpm -C web typecheck                 ✅
$ pnpm -C web lint                      ✅
$ pnpm -C web lint:boundaries-test      ✅ 全部符合預期
$ pnpm -C web db:grants --check         ✅ 兩支 migration 都與矩陣一致
$ pnpm -C web test:unit                 ✅ 6 檔 74 條
$ pnpm -C web vitest run --project integration src/infrastructure/db/
                                        ✅ roles 183 條、migrations 9 條、s01-accounts 30 條
```

`pnpm -C web test:integration` 整批在本機有 16 條紅的，全部集中在
`test/ops/deploy.integration.test.ts` 與 `test/ops/deploy-execute.integration.test.ts`，
原因是 **macOS 內建 bash 3.2**，與本票無關（見 [steps/S01/README](../README.md) 的說明）。
這兩支在 CI 的 ubuntu-latest（bash 5）上跑，**以 PR 的 CI 結果為準**。

## 7. NOT_RUN

- CI 七道在本 PR 的最新 commit：**待 PR 開出後回填 run 連結**。
- `pnpm -C web test:e2e`：本票沒有畫面，未在本機跑（e2e-smoke 由 CI 那道跑）。
- VM 上的部署與實機驗證：NOT_RUN（#187–#189，VM 目前尚未安裝 Docker）。
- 本票沒有 Roy 的畫面確認項；票面第 3 節寫明由工程核對，Roy 在 E01 整體展示時看 CI 綠燈與新表清單。
