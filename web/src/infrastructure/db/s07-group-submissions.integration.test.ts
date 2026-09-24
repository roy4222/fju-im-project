import { beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, poolAsRole, withIsolatedDatabase, type IsolatedDatabase } from '../../../test/db'
import { applyMigration, applyMigrations, migratedSchema } from '../../../test/migrations'

/**
 * 票 21（S07）：第八支 migration（模組 05 附錄 A 的繳交附件 `submission_files`、主指導閱覽設定
 * `advisor_visibility_settings`，以及模組 10 的檔案回收索引）。
 *
 * 驗三件事：
 * 1. 兩條升級路徑都通：空庫 S00→S07、以及「已經有草稿、正式版本、檔案」的 S06 庫升版（舊資料原封不動）。
 * 2. 逐欄對照附錄 A；回收索引是部分索引（只收 `uploading`／`soft_deleted`）。
 * 3. 兩張新表都不可變：`fju_app` 只能插不能改刪，owner 改也被 trigger 擋；checksum 形狀、一欄一檔用約束擋。
 */

const S06_LAST = '0007_s06_advisors'
const S07_LAST = '0008_s07_group_submissions'
const S07_TABLES = ['advisor_visibility_settings', 'submission_files']

beforeAll(async () => {
  await assertTestDatabaseReachable()
})

async function tableNames(db: IsolatedDatabase): Promise<string[]> {
  const rows = await db.sql(
    `select table_name from information_schema.tables
     where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
    [db.schemaName],
  )
  return rows.rows.map((r) => String(r.table_name))
}

async function columnsOf(db: IsolatedDatabase, table: string): Promise<Record<string, string>> {
  const rows = await db.sql(
    `select column_name, data_type, is_nullable from information_schema.columns
     where table_schema = $1 and table_name = $2`,
    [db.schemaName, table],
  )
  return Object.fromEntries(rows.rows.map((r) => [String(r.column_name), `${r.data_type}/${r.is_nullable}`]))
}

const CHECKSUM = 'c'.repeat(64)

/** 一屆、一位學生、一份組別收件（有欄位版本）、一個已存的繳交檔，以及一份草稿與一個正式版本。 */
async function seedSubmission(db: IsolatedDatabase) {
  const user = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '學生', $1, true, now(), 'active') returning id`,
    [`s07-${Math.random().toString(36).slice(2)}@example.com`],
  )
  const userId = String(user.rows[0]!.id)
  const cohort = await db.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), '115', '115', 'active', '2027-06-30', 'system') returning id`,
  )
  const cohortId = String(cohort.rows[0]!.id)
  const item = await db.sql(
    `insert into managed_items (id, cohort_id, placement, audience_kind, receiver_unit, title, created_by_kind)
     values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'group', '期中報告', 'system') returning id`,
    [cohortId],
  )
  const itemId = String(item.rows[0]!.id)
  const schema = await db.sql(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
    [itemId, userId],
  )
  const schemaVersionId = String(schema.rows[0]!.id)
  const file = await db.sql(
    `insert into stored_files
       (id, owner_user_id, scope, cohort_id, purpose, original_name, mime_declared, extension, status, storage_key,
        uploaded_real_at, size_bytes, checksum, finalized_at)
     values (gen_random_uuid(), $1, 'cohort', $2, 'submission', '報告.pdf', 'application/pdf', 'pdf', 'stored', $3,
             now(), 10, $4, now()) returning id`,
    [userId, cohortId, `s07-${Math.random().toString(36).slice(2)}`, CHECKSUM],
  )
  const fileId = String(file.rows[0]!.id)
  const groupId = (await db.sql('select gen_random_uuid() as id')).rows[0]!.id as string
  await db.sql(
    `insert into submission_drafts (id, item_id, receiver_kind, receiver_id, schema_version_id, answers, file_ids, created_by_kind)
     values (gen_random_uuid(), $1, 'group', $2, $3, jsonb_build_object('report', $4::text), array[$5::uuid], 'system')`,
    [itemId, groupId, schemaVersionId, fileId, fileId],
  )
  const version = await db.sql(
    `insert into submission_versions
       (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
        received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
     values (gen_random_uuid(), $1, 'group', $2, 1, $3, '{}'::jsonb, $4, now(), now(), gen_random_uuid(),
             jsonb_build_array($5::text), 1) returning id`,
    [itemId, groupId, schemaVersionId, userId, userId],
  )
  return { userId, cohortId, itemId, schemaVersionId, fileId, versionId: String(version.rows[0]!.id) }
}

type Seeded = Awaited<ReturnType<typeof seedSubmission>>

function attachFile(db: { query: IsolatedDatabase['pool']['query'] }, s: Seeded, patch: { field?: string; checksum?: string; versionId?: string } = {}) {
  return db.query(
    `insert into submission_files (submission_version_id, file_id, field_key, checksum) values ($1, $2, $3, $4)`,
    [patch.versionId ?? s.versionId, s.fileId, patch.field ?? 'report', patch.checksum ?? CHECKSUM],
  )
}

describe('S06→S07 升級', () => {
  it('空庫：0007 之後四十七張表，套上 0008 長出兩張新表', async () => {
    await withIsolatedDatabase({ label: 's06-to-s07' }, async (db) => {
      await applyMigrations(db, S06_LAST)
      const afterS06 = await tableNames(db)
      expect(afterS06).toHaveLength(47)

      await applyMigration(db, S07_LAST)
      const afterS07 = await tableNames(db)
      expect(afterS07).toHaveLength(49)
      expect(afterS07.filter((t) => !afterS06.includes(t))).toEqual(S07_TABLES)
    })
  })

  it('已有草稿、正式版本與檔案的庫升版：舊表一欄都沒動、舊資料原封不動，升版後就能記附件與閱覽設定', async () => {
    await withIsolatedDatabase({ label: 's06-seeded-upgrade' }, async (db) => {
      await applyMigrations(db, S06_LAST)
      const before: Record<string, Record<string, string>> = {}
      for (const table of await tableNames(db)) before[table] = await columnsOf(db, table)
      const seeded = await seedSubmission(db)
      const snapshot = async () =>
        (
          await db.sql(
            `select (select row_to_json(d) from submission_drafts d where d.item_id = $1) as draft,
                    (select row_to_json(v) from submission_versions v where v.id = $2) as version,
                    (select row_to_json(f) from stored_files f where f.id = $3) as file`,
            [seeded.itemId, seeded.versionId, seeded.fileId],
          )
        ).rows[0]
      const beforeRows = await snapshot()

      await applyMigration(db, S07_LAST)

      for (const [table, columns] of Object.entries(before)) {
        expect(await columnsOf(db, table), `${table} 在 S07 被改動了`).toEqual(columns)
      }
      expect(await snapshot()).toEqual(beforeRows)
      await attachFile(db.pool, seeded)
      await db.sql(
        `insert into advisor_visibility_settings (id, item_id, enabled, effective_from_version_no, set_by_user_id, set_at)
         values (gen_random_uuid(), $1, true, 2, $2, now())`,
        [seeded.itemId, seeded.userId],
      )
    })
  })
})

describe('逐欄對照附錄 A', () => {
  const EXPECTED_COLUMNS: Record<string, string[]> = {
    submission_files: ['submission_version_id', 'file_id', 'field_key', 'checksum'],
    advisor_visibility_settings: ['id', 'item_id', 'enabled', 'effective_from_version_no', 'set_by_user_id', 'set_at'],
  }

  it.each(Object.entries(EXPECTED_COLUMNS))('%s 的欄位與附錄 A 一致（全部 NOT NULL）', async (table, expected) => {
    await withIsolatedDatabase({ label: `cols-${table}`, setup: migratedSchema }, async (db) => {
      const columns = await columnsOf(db, table)
      expect(Object.keys(columns).sort()).toEqual([...expected].sort())
      for (const [name, shape] of Object.entries(columns)) expect(shape, name).toMatch(/\/NO$/)
    })
  })

  it('回收索引是 stored_files 上的部分索引：只收 uploading 殘留與軟刪除檔', async () => {
    await withIsolatedDatabase({ label: 'gc-indexes', setup: migratedSchema }, async (db) => {
      const rows = await db.sql(
        `select indexname, indexdef from pg_indexes where schemaname = $1 and tablename = 'stored_files' and indexname like '%gc_idx'`,
        [db.schemaName],
      )
      const defs = Object.fromEntries(rows.rows.map((r) => [String(r.indexname), String(r.indexdef)]))
      expect(Object.keys(defs).sort()).toEqual(['stored_files_soft_deleted_gc_idx', 'stored_files_uploading_gc_idx'])
      expect(defs.stored_files_uploading_gc_idx).toMatch(/\(uploaded_real_at\) WHERE \(status = 'uploading'::text\)/)
      expect(defs.stored_files_soft_deleted_gc_idx).toMatch(/\(soft_deleted_at\) WHERE \(status = 'soft_deleted'::text\)/)
    })
  })
})

describe('約束反例', () => {
  it('一個正式版本的同一欄只能有一個檔；checksum 要是 sha256 hex', async () => {
    await withIsolatedDatabase({ label: 'files-checks', setup: migratedSchema }, async (db) => {
      const s = await seedSubmission(db)
      await expect(attachFile(db.pool, s, { checksum: 'not-a-hash' })).rejects.toMatchObject({
        constraint: 'submission_files_checksum_check',
      })
      await attachFile(db.pool, s)
      await expect(attachFile(db.pool, s, { field: 'other' })).rejects.toMatchObject({ constraint: 'submission_files_pk' })
      const second = await db.sql(
        `insert into stored_files
           (id, owner_user_id, scope, cohort_id, purpose, original_name, mime_declared, extension, status, storage_key,
            uploaded_real_at, size_bytes, checksum, finalized_at)
         values (gen_random_uuid(), $1, 'cohort', $2, 'submission', 'b.pdf', 'application/pdf', 'pdf', 'stored', 's07-second',
                 now(), 10, $3, now()) returning id`,
        [s.userId, s.cohortId, CHECKSUM],
      )
      await expect(
        db.sql(`insert into submission_files (submission_version_id, file_id, field_key, checksum) values ($1, $2, 'report', $3)`, [
          s.versionId,
          second.rows[0]!.id,
          CHECKSUM,
        ]),
      ).rejects.toMatchObject({ constraint: 'submission_files_field_unique' })
    })
  })

  it('閱覽設定的生效欄位版本從 1 起算', async () => {
    await withIsolatedDatabase({ label: 'visibility-checks', setup: migratedSchema }, async (db) => {
      const s = await seedSubmission(db)
      await expect(
        db.sql(
          `insert into advisor_visibility_settings (id, item_id, enabled, effective_from_version_no, set_by_user_id, set_at)
           values (gen_random_uuid(), $1, true, 0, $2, now())`,
          [s.itemId, s.userId],
        ),
      ).rejects.toMatchObject({ constraint: 'advisor_visibility_settings_effective_check' })
    })
  })

  it('兩張新表都不可變：fju_app 能插、不能改不能刪；owner 改也被 trigger 擋', async () => {
    await withIsolatedDatabase({ label: 's07-immutable', setup: migratedSchema }, async (db) => {
      const s = await seedSubmission(db)
      const app = await poolAsRole(db, 'fju_app')
      try {
        await attachFile(app, s)
        await app.query(
          `insert into advisor_visibility_settings (id, item_id, enabled, effective_from_version_no, set_by_user_id, set_at)
           values (gen_random_uuid(), $1, true, 1, $2, now())`,
          [s.itemId, s.userId],
        )
        await expect(app.query(`update submission_files set checksum = $1`, ['d'.repeat(64)])).rejects.toMatchObject({ code: '42501' })
        await expect(app.query('delete from submission_files')).rejects.toMatchObject({ code: '42501' })
        await expect(app.query('update advisor_visibility_settings set enabled = false')).rejects.toMatchObject({ code: '42501' })
        await expect(app.query('delete from advisor_visibility_settings')).rejects.toMatchObject({ code: '42501' })
      } finally {
        await app.end()
      }
      await expect(db.sql(`update submission_files set checksum = $1`, ['d'.repeat(64)])).rejects.toThrow(/不可變/)
      await expect(db.sql('update advisor_visibility_settings set enabled = false')).rejects.toThrow(/不可變/)
    })
  })
})
