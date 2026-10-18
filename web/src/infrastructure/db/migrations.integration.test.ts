import { beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, withIsolatedDatabase } from '../../../test/db'
import { applyMigration, applyMigrations, migratedSchema, migrationTags } from '../../../test/migrations'
import { PgPublicShowcaseQuery } from '@/infrastructure/showcase/pg-public-showcase'

/**
 * S00-04：第一支 migration 在**空資料庫**上跑得起來，而且建出契約 01 §12 點名的十一張表。
 * S01-01：第二支 migration 在它之上**只新增**十一張表；空庫升級與舊庫升版兩條路徑都要通。
 * 票 11（S02-01）：第三支再新增七張表（細節在 s02-timeline.integration.test.ts）。
 * 票 13（S03-01）：第四支再新增六張分組表（細節在 s03-groups.integration.test.ts）。
 * 票 15（S04-01）：第五支再新增專題事務六表與收件名單表（細節在 s04-items.integration.test.ts）。
 * 票 17（S05）：第六支再新增草稿與正式版本兩表（細節在 s05-submissions.integration.test.ts）。
 * 票 19（S06）：第七支再新增主指導、合作案、合作案連結三表（細節在 s06-advisors.integration.test.ts）。
 * 票 21（S07）：第八支再新增繳交附件、主指導閱覽設定兩表與檔案回收索引（細節在 s07-group-submissions.integration.test.ts）。
 * 票 23（S10）：第十支再新增評分九表（細節在 s10-grading.integration.test.ts）。
 * 票 25（S11）：第十一支再新增簽核五表與精選三表（細節在 s11-signoff-showcase.integration.test.ts）。
 * 票 39：第十二支只給舊表加欄與索引；已套 0010、有資料的庫升上來，舊列拿到安全的預設（下面倒數第二組）。
 * 第三波 W0：第十三支新增首頁設定、個別補交兩表，並給舊表加刪除標記與輪播順序（細節在 wave3-schema.integration.test.ts）。
 * 第三波 W15：第十四支只改精選「一組一屆一個條目」的唯一索引，改成只算未刪除的（刪掉後同組可以再建草稿；下面倒數第二組）。
 * B 階段 A-01：0017 新增系辦結算表 `grade_settlements`、0018 給 `evaluations` 加評語欄；已套 0016、有資料的庫升上來（下面倒數第二組）。
 * B 階段 A-14：0019 只給 `managed_items` 加規則章節位置欄與索引（仍七十張表）；已套 0018、有資料的庫升上來會回填順序（下面倒數第二組）。
 * C 階段 C2-21：0020 只放寬約束（理由選填、核實方式加 office_review／email_roster_match；仍七十張表）；已套 0019、有資料的庫升上來（下面最後一組）。
 * C 階段 C1-01：0021 新增評分項目側表 `grading_stage_settings`（七十一張表），其餘是加欄與放寬（細節在 s04-items、pg-signoff、pg-grading 整合測試）。
 */

beforeAll(async () => {
  await assertTestDatabaseReachable()
})

/** S00 建的十一張表（契約 01 §12 第一支 migration）。 */
const S00_TABLES = [
  'accounts',
  'audit_events',
  'cohorts',
  'domain_events',
  'due_work',
  'event_projections',
  'operation_records',
  'schema_meta',
  'sessions',
  'users',
  'verifications',
]

/** S01-01 新增的十一張表：模組 01 附錄 A 九張＋模組 10 最小檔案兩張。 */
const S01_TABLES = [
  'application_revisions',
  'file_references',
  'registration_applications',
  'role_assignments',
  'roster_entries',
  'roster_versions',
  'session_revocations',
  'stored_files',
  'student_identities',
  'user_profiles',
  'user_status_events',
]

/** 票 11（S02-01）新增的七張表：模組 02 附錄 A 四張＋模組 08 附錄 A 三張。 */
const S02_TABLES = [
  'business_clock_overrides',
  'cohort_stages',
  'cohort_status_events',
  'digest_events',
  'notifications',
  'project_events',
  'worker_heartbeat',
]

/** 票 13（S03-01）新增的六張表：模組 03 附錄 A（提案、邀請、占用、組別、成員、組長）。 */
const S03_TABLES = [
  'group_leaders',
  'group_memberships',
  'group_proposals',
  'groups',
  'proposal_invitations',
  'proposal_occupancy',
]

/** 票 15（S04-01）新增的七張表：模組 04 附錄 A 六張＋模組 05 的收件名單。 */
const S04_TABLES = [
  'form_schema_versions',
  'item_attachments',
  'item_audience_groups',
  'item_publications',
  'item_versions',
  'managed_items',
  'response_rosters',
]

/** 票 17（S05）新增的兩張表：模組 05 附錄 A 的草稿與正式版本。 */
const S05_TABLES = ['submission_drafts', 'submission_versions']

/** 票 19（S06）新增的三張表：模組 03 附錄 A 的主指導、合作案、合作案連結。 */
const S06_TABLES = ['advisor_assignments', 'industry_opportunities', 'opportunity_links']

/** 票 21（S07）新增的兩張表：模組 05 附錄 A 的繳交附件與主指導閱覽設定。 */
const S07_TABLES = ['advisor_visibility_settings', 'submission_files']

/** 票 23（S10）新增的九張表：模組 06 附錄 A 的評分方案、版本、要求份數、指派、輸入、狀態、狀態紀錄、更正、復核。 */
const S10_TABLES = [
  'evaluation_status',
  'evaluation_status_events',
  'evaluations',
  'evaluator_assignments',
  'grade_overrides',
  'grading_scheme_versions',
  'grading_schemes',
  'override_review_state',
  'stage_requirements',
]

/** 票 25（S11）新增的八張表：模組 07 附錄 A 的簽核五表與模組 09 附錄 A 的精選三表。 */
const S11_TABLES = [
  'approvals',
  'showcase_drafts',
  'showcase_entries',
  'showcase_versions',
  'signoff_exports',
  'signoff_package_versions',
  'signoff_packages',
  'signoff_version_status',
]

/** 第三波 W0 新增的兩張表：首頁設定（固定一列）與個別補交。 */
const W0_TABLES = ['home_settings', 'submission_reopens']

/** B 階段 VB-1 的 0015：寄信紀錄。 */
const VB1_TABLES = ['mail_outbox']

/** B 階段 A-01 的 0017：系辦結算。 */
const A01_TABLES = ['grade_settlements']

/** C 階段 C1-01 的 0021：評分項目側表（對應作業、說明、評審組）。 */
const C1_TABLES = ['grading_stage_settings']

const EXPECTED_TABLES = [
  ...S00_TABLES,
  ...S01_TABLES,
  ...S02_TABLES,
  ...S03_TABLES,
  ...S04_TABLES,
  ...S05_TABLES,
  ...S06_TABLES,
  ...S07_TABLES,
  ...S10_TABLES,
  ...S11_TABLES,
  ...W0_TABLES,
  ...VB1_TABLES,
  ...A01_TABLES,
  ...C1_TABLES,
].sort()

const LATEST = '0021_c1_affairs_consent_grading'

async function tableNames(db: Awaited<ReturnType<typeof createIsolatedDatabase>>): Promise<string[]> {
  const rows = await db.sql(
    `select table_name from information_schema.tables
     where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
    [db.schemaName],
  )
  return rows.rows.map((r) => String(r.table_name))
}

describe('空庫 migration', () => {
  it('在全新的空 schema 上跑得起來，建出七十一張表', async () => {
    await withIsolatedDatabase({ label: 'empty-migrate' }, async (db) => {
      const before = await tableNames(db)
      expect(before).toEqual([])

      const tags = await applyMigrations(db)
      expect(tags[0]).toBe('0000_s00_foundation')
      expect(tags.at(-1)).toBe(LATEST)

      expect(await tableNames(db)).toEqual(EXPECTED_TABLES)
    })
  })

  it('建表順序符合契約 01 §12：FK 目標先存在', async () => {
    await withIsolatedDatabase({ label: 'fk-order' }, async (db) => {
      await applyMigrations(db)
      const fks = await db.sql(
        `select tc.table_name, ccu.table_name as references_table
         from information_schema.table_constraints tc
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
         where tc.table_schema = $1 and tc.constraint_type = 'FOREIGN KEY'
         order by 1, 2`,
        [db.schemaName],
      )
      const pairs = fks.rows.map((r) => `${r.table_name} -> ${r.references_table}`)
      expect(pairs).toContain('sessions -> users')
      expect(pairs).toContain('accounts -> users')
      expect(pairs).toContain('audit_events -> cohorts')
      expect(pairs).toContain('operation_records -> users')
      expect(pairs).toContain('event_projections -> domain_events')
    })
  })
})

describe('契約 01 §4 的約束確實建出來了', () => {
  it('0015：三個核實方式 CHECK 都多了 google_email_match（Q42 自動開通），舊值照收、亂填照擋', async () => {
    await withIsolatedDatabase({ label: 'vb1-verification-method', setup: migratedSchema }, async (db) => {
      const defs = await db.sql(
        `select conname, pg_get_constraintdef(c.oid) as def from pg_constraint c
           join pg_namespace n on n.oid = c.connamespace
          where n.nspname = $1 and conname like '%verification_method_check' order by conname`,
        [db.schemaName],
      )
      expect(defs.rows.map((r) => r.conname)).toEqual([
        'audit_events_verification_method_check',
        'registration_applications_verification_method_check',
        'user_status_events_verification_method_check',
      ])
      for (const row of defs.rows) {
        for (const method of ['id_document', 'school_channel', 'other', 'google_email_match']) {
          expect(String(row.def), `${row.conname} 少了 ${method}`).toContain(`'${method}'`)
        }
      }
      const audit = (method: string) =>
        db.sql(
          `insert into audit_events (id, actor_kind, action, target_type, target_id, scope, verification_method, real_at, business_at)
           values (gen_random_uuid(), 'system', 'account.approve', 'registration_application', gen_random_uuid(), 'global', $1, now(), now())`,
          [method],
        )
      await expect(audit('google_email_match')).resolves.toBeTruthy()
      await expect(audit('guess')).rejects.toThrow(/audit_events_verification_method_check/)
    })
  })

  it('列舉欄用 CHECK 白名單，不用 pgEnum', async () => {
    await withIsolatedDatabase({ label: 'checks', setup: migratedSchema }, async (db) => {
      const enums = await db.sql('select typname from pg_type where typtype = $1', ['e'])
      expect(enums.rowCount).toBe(0)

      await expect(
        db.sql("insert into cohorts (id, code, name, status, created_by_kind) values (gen_random_uuid(), 'X', 'X', 'nope', 'system')"),
      ).rejects.toThrow(/cohorts_status_check/)
    })
  })

  it('actor 規則：actor_kind=user 必須有 actor_user_id，反之亦然', async () => {
    await withIsolatedDatabase({ label: 'actor', setup: migratedSchema }, async (db) => {
      await expect(
        db.sql(`insert into audit_events (id, actor_kind, action, target_type, scope, real_at, business_at)
                values (gen_random_uuid(), 'user', 'test', 'user', 'global', now(), now())`),
      ).rejects.toThrow(/audit_events_actor_check/)

      const ok = await db.sql(`insert into audit_events (id, actor_kind, action, target_type, scope, real_at, business_at)
              values (gen_random_uuid(), 'system', 'test', 'user', 'global', now(), now()) returning id`)
      expect(ok.rowCount).toBe(1)
    })
  })

  it('scope 規則：scope=cohort 必須有 cohort_id', async () => {
    await withIsolatedDatabase({ label: 'scope', setup: migratedSchema }, async (db) => {
      await expect(
        db.sql(`insert into audit_events (id, actor_kind, action, target_type, scope, real_at, business_at)
                values (gen_random_uuid(), 'system', 'test', 'user', 'cohort', now(), now())`),
      ).rejects.toThrow(/audit_events_scope_cohort_check/)
    })
  })

  it('只能有一個預設工作屆別、一個開放註冊屆別', async () => {
    await withIsolatedDatabase({ label: 'cohort-unique', setup: migratedSchema }, async (db) => {
      await db.sql(`insert into cohorts (id, code, name, is_default_working, created_by_kind)
                    values (gen_random_uuid(), '115-A', '115 甲', true, 'system')`)
      await expect(
        db.sql(`insert into cohorts (id, code, name, is_default_working, created_by_kind)
                values (gen_random_uuid(), '116-A', '116 甲', true, 'system')`),
      ).rejects.toThrow(/cohorts_one_default_working/)

      // 不是預設的就可以有很多個。
      const second = await db.sql(`insert into cohorts (id, code, name, created_by_kind)
                    values (gen_random_uuid(), '116-A', '116 甲', 'system') returning id`)
      expect(second.rowCount).toBe(1)
    })
  })

  it('operation_records 的去重鍵是（本人、操作種類、requestId）', async () => {
    await withIsolatedDatabase({ label: 'dedupe', setup: migratedSchema }, async (db) => {
      const user = await db.sql(
        `insert into users (id, name, email, email_verified, updated_at)
         values (gen_random_uuid(), 'A', 'a@example.com', false, now()) returning id`,
      )
      const userId = user.rows[0]!.id

      const insert = (requestId: string) =>
        db.sql(
          `insert into operation_records
             (id, actor_user_id, operation_kind, request_id, fingerprint, state, scope, committed_real_at, receipt_expires_at)
           values (gen_random_uuid(), $1, 'submission.submit', $2, 'abc', 'committed', 'global', now(), now() + interval '30 days')`,
          [userId, requestId],
        )

      const requestId = '11111111-1111-4111-8111-111111111111'
      await insert(requestId)
      await expect(insert(requestId)).rejects.toThrow(/operation_records_dedupe_key/)
      await expect(insert('22222222-2222-4222-8222-222222222222')).resolves.toBeTruthy()
    })
  })

  it('due_work 的 identity 是（kind、subject、deadline_version）', async () => {
    await withIsolatedDatabase({ label: 'due-work', setup: migratedSchema }, async (db) => {
      const subject = '33333333-3333-4333-8333-333333333333'
      const insert = (version: number) =>
        db.sql(
          `insert into due_work (id, kind, subject_type, subject_id, deadline_version, due_business_at)
           values (gen_random_uuid(), 'deadline_snapshot', 'item', $1, $2, now())`,
          [subject, version],
        )
      await insert(1)
      await expect(insert(1)).rejects.toThrow(/due_work_identity/)
      await expect(insert(2)).resolves.toBeTruthy()
    })
  })

  it('時間欄都是 timestamptz、主鍵都是 uuid', async () => {
    await withIsolatedDatabase({ label: 'types', setup: migratedSchema }, async (db) => {
      const timestamps = await db.sql(
        `select table_name, column_name, data_type from information_schema.columns
         where table_schema = $1 and data_type like 'timestamp%'`,
        [db.schemaName],
      )
      expect(timestamps.rowCount).toBeGreaterThan(0)
      for (const row of timestamps.rows) {
        expect(row.data_type).toBe('timestamp with time zone')
      }

      // worker_heartbeat 是固定一列的心跳表（模組 08 附錄 A：`id smallint CHECK (id = 1)`），不是業務實體；
      // home_settings（第三波 W0）是固定一列的首頁設定，同一個做法。
      const singleRow = ['worker_heartbeat', 'home_settings']
      const ids = await db.sql(
        `select table_name, data_type from information_schema.columns
         where table_schema = $1 and column_name = 'id' and table_name <> all($2::text[])`,
        [db.schemaName, singleRow],
      )
      for (const row of ids.rows) {
        expect(row.data_type).toBe('uuid')
      }

      // 例外的兩張：id 是 smallint，而且 CHECK 只允許 1。
      const singleRowIds = await db.sql(
        `select table_name, data_type from information_schema.columns
         where table_schema = $1 and column_name = 'id' and table_name = any($2::text[]) order by table_name`,
        [db.schemaName, singleRow],
      )
      expect(singleRowIds.rows).toEqual([
        { table_name: 'home_settings', data_type: 'smallint' },
        { table_name: 'worker_heartbeat', data_type: 'smallint' },
      ])
      const singleRowChecks = await db.sql(
        `select conname, pg_get_constraintdef(c.oid) as def from pg_constraint c
         join pg_namespace n on n.oid = c.connamespace
         where n.nspname = $1 and conname = any($2::text[]) order by conname`,
        [db.schemaName, ['home_settings_single_row_check', 'worker_heartbeat_single_row_check']],
      )
      expect(singleRowChecks.rows.map((r) => [r.conname, String(r.def).replaceAll(/\s+/g, ' ')])).toEqual([
        ['home_settings_single_row_check', 'CHECK ((id = 1))'],
        ['worker_heartbeat_single_row_check', 'CHECK ((id = 1))'],
      ])
    })
  })
})

describe('0011（票 39）：已套 0010、有資料的庫升版', () => {
  it('舊列拿到預設（說明空字串、日期與獎項 NULL）；原本已發布的作品升版後不在公開的優秀專題', async () => {
    await withIsolatedDatabase({ label: 't39-upgrade' }, async (db) => {
      await applyMigrations(db, '0010_s11_signoff_showcase')
      const user = await db.sql(
        `insert into users (id, name, email, email_verified, updated_at) values (gen_random_uuid(), '系辦', 't39@example.com', true, now()) returning id`,
      )
      const userId = String(user.rows[0]!.id)
      const cohort = await db.sql(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind) values (gen_random_uuid(), '113', '113', 'active', '2027-06-30', 'system') returning id`,
      )
      const cohortId = String(cohort.rows[0]!.id)
      await db.sql(
        `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind) values (gen_random_uuid(), $1, 1, '分組', '2026-09-01', 'system')`,
        [cohortId],
      )
      await db.sql(
        `insert into managed_items (id, cohort_id, placement, audience_kind, title, category, created_by_kind, created_by_user_id)
         values (gen_random_uuid(), $1, 'news', 'public', '舊競賽公告', '競賽資訊', 'user', $2)`,
        [cohortId, userId],
      )
      const entry = await db.sql(
        `insert into showcase_entries (id, cohort_id, status, created_by_user_id) values (gen_random_uuid(), $1, 'draft', $2) returning id`,
        [cohortId, userId],
      )
      const entryId = String(entry.rows[0]!.id)
      const version = await db.sql(
        `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, authorization_kind, authorization_ref,
                                        pii_check, created_by_user_id, created_real_at)
         values (gen_random_uuid(), $1, 1, '舊作品', '', encode(sha256(''::bytea), 'hex'), 'external', gen_random_uuid(), '{}'::jsonb, $2, now())
         returning id`,
        [entryId, userId],
      )
      await db.sql(`update showcase_entries set status = 'published', current_version_id = $2 where id = $1`, [entryId, version.rows[0]!.id])

      await applyMigration(db, '0011_t39_showcase_stage_fields')

      expect((await db.sql(`select description from cohort_stages`)).rows).toEqual([{ description: '' }])
      expect((await db.sql(`select registration_deadline, event_date, awarded_on from managed_items`)).rows).toEqual([
        { registration_deadline: null, event_date: null, awarded_on: null },
      ])
      expect((await db.sql(`select award_level, award_label from showcase_entries`)).rows).toEqual([{ award_level: null, award_label: null }])
      // 公開查詢是目前的程式碼，要接最新的 schema（第三波 W2 起會讀 0012 的 deleted_at／home_position）：
      // 0011 的預設值上面已經斷言過，這裡把之後的 migration 補齊，再證明舊的已發布作品仍不在公開清單。
      const tags = migrationTags()
      for (const tag of tags.slice(tags.indexOf('0011_t39_showcase_stage_fields') + 1)) await applyMigration(db, tag)
      expect((await db.sql(`select award_level, award_label from showcase_entries`)).rows).toEqual([{ award_level: null, award_label: null }])
      const query = new PgPublicShowcaseQuery(() => db.pool)
      expect(await query.featured()).toEqual([])
      expect(await query.entry({ kind: 'anonymous' }, entryId)).toEqual({ access: 'need_login' })
      const index = await db.sql(`select 1 from pg_indexes where schemaname = $1 and indexname = 'audit_events_real_at_idx'`, [db.schemaName])
      expect(index.rowCount).toBe(1)
    })
  })
})

describe('0013（W15）：精選一組一屆一個「未刪除」的條目', () => {
  it('從 0012 升上來：已刪除的條目不佔名額，同組可以再建；未刪除的仍只能一筆', async () => {
    await withIsolatedDatabase({ label: 'm0013' }, async (db) => {
      const tags = migrationTags()
      for (const tag of tags.slice(0, tags.indexOf('0012_wave3_delete_home') + 1)) await applyMigration(db, tag)
      const user = await db.sql(
        `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), '系辦', 'm0013@example.com', true, now(), 'active') returning id`,
      )
      const userId = String(user.rows[0]!.id)
      const cohort = await db.sql(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind) values (gen_random_uuid(), '113', '113', 'active', '2027-06-30', 'system') returning id`,
      )
      const cohortId = String(cohort.rows[0]!.id)
      const group = await db.sql(
        `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
         values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
        [cohortId],
      )
      const groupId = String(group.rows[0]!.id)
      const entry = (deleted: boolean) =>
        db.sql(
          `insert into showcase_entries (id, cohort_id, group_id, status, created_by_user_id, deleted_at, deleted_by_user_id)
           values (gen_random_uuid(), $1, $2, 'draft', $3, $4, $5)`,
          [cohortId, groupId, userId, deleted ? new Date() : null, deleted ? userId : null],
        )
      // 0012 時：刪掉的那一筆仍佔名額。
      await entry(true)
      await expect(entry(false)).rejects.toThrow(/showcase_entries_one_per_group/)

      await applyMigration(db, '0013_w15_showcase_one_per_group')
      await entry(false)
      await expect(entry(false)).rejects.toThrow(/showcase_entries_one_per_group/)
      const index = await db.sql(`select indexdef from pg_indexes where schemaname = $1 and indexname = 'showcase_entries_one_per_group'`, [db.schemaName])
      expect(String(index.rows[0]!.indexdef)).toMatch(/UNIQUE INDEX .*WHERE \(\(group_id IS NOT NULL\) AND \(deleted_at IS NULL\)\)/)
    })
  })
})

describe('0017、0018（A-01）：已套 0016、有資料的庫升到 0018', () => {
  it('舊 evaluations 列的評語是 null；check 擋 501 字、收 500 字；結算表同屆同階段只能一筆現行', async () => {
    await withIsolatedDatabase({ label: 'm0018' }, async (db) => {
      await applyMigrations(db, '0016_avatar')
      const user = await db.sql(
        `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), '老師', 'm0018@example.com', true, now(), 'active') returning id`,
      )
      const userId = String(user.rows[0]!.id)
      const cohort = await db.sql(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind) values (gen_random_uuid(), '113', '113', 'active', '2027-06-30', 'system') returning id`,
      )
      const cohortId = String(cohort.rows[0]!.id)
      const group = await db.sql(
        `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
         values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
        [cohortId],
      )
      const groupId = String(group.rows[0]!.id)
      const scheme = await db.sql(
        `insert into grading_schemes (id, cohort_id, name, created_by_kind, created_by_user_id) values (gen_random_uuid(), $1, '方案', 'user', $2) returning id`,
        [cohortId, userId],
      )
      const version = await db.sql(
        `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id)
         values (gen_random_uuid(), $1, 1, '[]'::jsonb, 'draft', $2) returning id`,
        [scheme.rows[0]!.id, userId],
      )
      const versionId = String(version.rows[0]!.id)
      const assignment = await db.sql(
        `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
         values (gen_random_uuid(), $1, 's1', $2, now(), $2) returning id`,
        [groupId, userId],
      )
      const assignmentId = String(assignment.rows[0]!.id)
      const evaluation = (comment?: string) =>
        db.sql(
          `insert into evaluations (id, assignment_id, kind, scheme_version_id, scores, submitted_real_at, submitted_business_at, request_id${comment === undefined ? '' : ', comment'})
           values (gen_random_uuid(), $1, 'draft', $2, '{}'::jsonb, now(), now(), gen_random_uuid()${comment === undefined ? '' : ', $3'}) returning id`,
          comment === undefined ? [assignmentId, versionId] : [assignmentId, versionId, comment],
        )
      const old = String((await evaluation()).rows[0]!.id)

      await applyMigration(db, '0017_te_b2a_grade_settlements')
      await applyMigration(db, '0018_te_b4_evaluation_comment')

      expect((await db.sql(`select comment from evaluations where id = $1`, [old])).rows).toEqual([{ comment: null }])
      await expect(evaluation('字'.repeat(501))).rejects.toThrow(/evaluations_comment_length_check/)
      await expect(evaluation('字'.repeat(500))).resolves.toBeTruthy()

      const settle = () =>
        db.sql(
          `insert into grade_settlements (id, cohort_id, stage_key, settled_at, settled_by_user_id, reason, counted_evaluations, request_id)
           values (gen_random_uuid(), $1, 's1', now(), $2, '期中結算', 0, gen_random_uuid()::text) returning id`,
          [cohortId, userId],
        )
      const first = String((await settle()).rows[0]!.id)
      await expect(settle()).rejects.toThrow(/grade_settlements_active_one/)
      // 解除三欄要一起填。
      await expect(db.sql(`update grade_settlements set released_at = now() where id = $1`, [first])).rejects.toThrow(
        /grade_settlements_released_check/,
      )
      await db.sql(`update grade_settlements set released_at = now(), released_by_user_id = $2, release_reason = '重開' where id = $1`, [first, userId])
      await expect(settle()).resolves.toBeTruthy()
    })
  })
})

describe('0019（A-14）：已套 0018、有資料的庫升到 0019：回填順序', () => {
  it('同屆未刪除的規則依實際開放時間從 1 編號、各屆各自編；刪除的與其他位置是 null', async () => {
    await withIsolatedDatabase({ label: 'm0019' }, async (db) => {
      await applyMigrations(db, '0018_te_b4_evaluation_comment')
      const user = await db.sql(
        `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), '系辦', 'm0019@example.com', true, now(), 'active') returning id`,
      )
      const userId = String(user.rows[0]!.id)
      const cohort = async (code: string) =>
        String(
          (
            await db.sql(
              `insert into cohorts (id, code, name, status, year_end_date, created_by_kind) values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
              [code],
            )
          ).rows[0]!.id,
        )
      const c113 = await cohort('113')
      const c114 = await cohort('114')
      const item = async (cohortId: string, placement: string, title: string, openedAt: string | null, deleted = false) =>
        String(
          (
            await db.sql(
              `insert into managed_items (id, cohort_id, placement, audience_kind, title, actual_opened_at, created_by_kind, deleted_at, deleted_by_user_id)
               values (gen_random_uuid(), $1, $2, 'public', $3, $4, 'system', $5, $6) returning id`,
              [cohortId, placement, title, openedAt, deleted ? new Date() : null, deleted ? userId : null],
            )
          ).rows[0]!.id,
        )
      // 插入順序故意打亂：回填看實際開放時間，不看插入順序。
      const third = await item(c113, 'rules', '第三章', '2026-09-03T00:00:00Z')
      const first = await item(c113, 'rules', '第一章', '2026-09-01T00:00:00Z')
      const gone = await item(c113, 'rules', '已刪除', '2026-08-01T00:00:00Z', true)
      const second = await item(c113, 'rules', '第二章', '2026-09-02T00:00:00Z')
      const never = await item(c113, 'rules', '從未發布', null)
      const news = await item(c113, 'news', '公告', '2026-09-01T00:00:00Z')
      const other = await item(c114, 'rules', '別屆第一章', '2026-09-05T00:00:00Z')

      await applyMigration(db, '0019_rules_position')

      const positions = await db.sql(`select id, rules_position from managed_items`)
      const at = new Map(positions.rows.map((r) => [String(r.id), r.rules_position]))
      expect([first, second, third, never].map((id) => at.get(id))).toEqual([1, 2, 3, 4])
      expect(at.get(other)).toBe(1)
      expect(at.get(gone)).toBeNull()
      expect(at.get(news)).toBeNull()
      const index = await db.sql(`select indexdef from pg_indexes where schemaname = $1 and indexname = 'managed_items_rules_position_idx'`, [
        db.schemaName,
      ])
      expect(String(index.rows[0]!.indexdef)).toMatch(/\(cohort_id, rules_position\) WHERE .*placement = 'rules'.*deleted_at IS NULL/)
    })
  })
})

describe('0020（C2-21）：已套 0019、有資料的庫升到 0020：理由選填、核實方式新值', () => {
  it('舊列不受影響；理由可存 NULL；核准可不帶核實方式；三表收 office_review／email_roster_match、亂填照擋', async () => {
    await withIsolatedDatabase({ label: 'm0020' }, async (db) => {
      await applyMigrations(db, '0019_rules_position')
      const user = await db.sql(
        `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), '系辦', 'm0020@example.com', true, now(), 'active') returning id`,
      )
      const userId = String(user.rows[0]!.id)
      const cohort = await db.sql(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind) values (gen_random_uuid(), '113', '113', 'active', '2027-06-30', 'system') returning id`,
      )
      const cohortId = String(cohort.rows[0]!.id)
      const clock = (reason: string | null) =>
        db.sql(
          `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
           values (gen_random_uuid(), 'local', now(), now(), $1, $2) returning id`,
          [userId, reason],
        )
      const status = (from: string | null, to: string, reason: string | null) =>
        db.sql(
          `insert into cohort_status_events (id, cohort_id, from_status, to_status, reason, actor_user_id, real_at, business_at)
           values (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now()) returning id`,
          [cohortId, from, to, reason, userId],
        )
      let studentNo = 410000100
      const application = (state: string, method: string | null) =>
        db.sql(
          `insert into registration_applications
             (id, user_id, applied_name, student_no, phone, contact_email, login_email, state, verification_method,
              created_by_kind, created_by_user_id)
           values (gen_random_uuid(), $1, 'X', $2, '09', 'c@example.com', 'c@example.com', $3, $4, 'user', $1) returning id`,
          [userId, String(studentNo++), state, method],
        )
      const userStatus = (method: string) =>
        db.sql(
          `insert into user_status_events (id, user_id, from_status, to_status, verification_method, actor_kind, real_at)
           values (gen_random_uuid(), $1, 'pending', 'active', $2, 'system', now())`,
          [userId, method],
        )
      const audit = (method: string) =>
        db.sql(
          `insert into audit_events (id, actor_kind, action, target_type, target_id, scope, verification_method, real_at, business_at)
           values (gen_random_uuid(), 'system', 'account.approve', 'registration_application', gen_random_uuid(), 'global', $1, now(), now())`,
          [method],
        )

      // 0019 時：空理由、封存無理由、核准無核實方式、新值都被擋。
      await expect(clock(null)).rejects.toThrow(/null value in column "reason"/)
      await expect(clock('  ')).rejects.toThrow(/business_clock_overrides_reason_check/)
      await expect(status('active', 'archived', null)).rejects.toThrow(/cohort_status_events_archive_reason_check/)
      await expect(application('approved', null)).rejects.toThrow(/registration_applications_approved_verification_check/)
      await expect(audit('office_review')).rejects.toThrow(/audit_events_verification_method_check/)
      const oldClock = String((await clock('示範')).rows[0]!.id)
      const oldStatus = String((await status('active', 'archived', '年度結束')).rows[0]!.id)
      const oldApplication = String((await application('approved', 'id_document')).rows[0]!.id)

      await applyMigration(db, '0020_c2_verification_office_review')

      expect((await db.sql(`select reason from business_clock_overrides where id = $1`, [oldClock])).rows).toEqual([{ reason: '示範' }])
      expect((await db.sql(`select reason from cohort_status_events where id = $1`, [oldStatus])).rows).toEqual([{ reason: '年度結束' }])
      expect((await db.sql(`select verification_method from registration_applications where id = $1`, [oldApplication])).rows).toEqual([
        { verification_method: 'id_document' },
      ])

      // 理由選填（X2）：測試用時間、封存／解封都可存 NULL。
      const column = await db.sql(
        `select is_nullable from information_schema.columns where table_schema = $1 and table_name = 'business_clock_overrides' and column_name = 'reason'`,
        [db.schemaName],
      )
      expect(column.rows).toEqual([{ is_nullable: 'YES' }])
      await expect(clock(null)).resolves.toBeTruthy()
      await expect(status('archived', 'active', null)).resolves.toBeTruthy()
      await expect(status('active', 'archived', null)).resolves.toBeTruthy()
      // 其他約束沒被一起拿掉。
      await expect(
        db.sql(
          `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id) values (gen_random_uuid(), 'production', now(), now(), $1)`,
          [userId],
        ),
      ).rejects.toThrow(/business_clock_overrides_environment_check/)
      await expect(status('active', 'gone', null)).rejects.toThrow(/cohort_status_events_to_status_check/)

      // 不再問核實方式（X3）：核准可不帶；三表收兩個新值、舊值照收、亂填照擋；other 仍要說明。
      await expect(application('approved', null)).resolves.toBeTruthy()
      await expect(application('approved', 'other')).rejects.toThrow(/registration_applications_other_note_check/)
      for (const method of ['office_review', 'email_roster_match', 'id_document', 'google_email_match']) {
        await expect(application('approved', method), `registration_applications 擋了 ${method}`).resolves.toBeTruthy()
        await expect(userStatus(method), `user_status_events 擋了 ${method}`).resolves.toBeTruthy()
        await expect(audit(method), `audit_events 擋了 ${method}`).resolves.toBeTruthy()
      }
      await expect(application('approved', 'guess')).rejects.toThrow(/registration_applications_verification_method_check/)
      await expect(userStatus('guess')).rejects.toThrow(/user_status_events_verification_method_check/)
      await expect(audit('guess')).rejects.toThrow(/audit_events_verification_method_check/)

      const gone = await db.sql(
        `select conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace
          where n.nspname = $1 and conname in ('business_clock_overrides_reason_check', 'cohort_status_events_archive_reason_check', 'registration_applications_approved_verification_check')`,
        [db.schemaName],
      )
      expect(gone.rows).toEqual([])
      expect(await tableNames(db)).toEqual(EXPECTED_TABLES.filter((t) => !C1_TABLES.includes(t)))
    })
  })
})
