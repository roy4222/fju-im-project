import { beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, withIsolatedDatabase } from '../../../test/db'
import { applyMigrations, migratedSchema } from '../../../test/migrations'

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
].sort()

const LATEST = '0010_s11_signoff_showcase'

async function tableNames(db: Awaited<ReturnType<typeof createIsolatedDatabase>>): Promise<string[]> {
  const rows = await db.sql(
    `select table_name from information_schema.tables
     where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
    [db.schemaName],
  )
  return rows.rows.map((r) => String(r.table_name))
}

describe('空庫 migration', () => {
  it('在全新的空 schema 上跑得起來，建出六十六張表', async () => {
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

      // worker_heartbeat 是固定一列的心跳表（模組 08 附錄 A：`id smallint CHECK (id = 1)`），不是業務實體。
      const ids = await db.sql(
        `select table_name, data_type from information_schema.columns
         where table_schema = $1 and column_name = 'id' and table_name <> 'worker_heartbeat'`,
        [db.schemaName],
      )
      for (const row of ids.rows) {
        expect(row.data_type).toBe('uuid')
      }
    })
  })
})
