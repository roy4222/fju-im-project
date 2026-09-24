import { beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, poolAsRole, withIsolatedDatabase, type IsolatedDatabase } from '../../../test/db'
import { applyMigration, applyMigrations, migratedSchema } from '../../../test/migrations'

/**
 * 票 17（S05）：第六支 migration（模組 05 附錄 A 的草稿與正式版本兩表）。
 *
 * 驗三件事：
 * 1. 兩條升級路徑都通：空庫 S00→S05、以及「已經發布了收件、建好名單」的 S04 庫升版。
 * 2. 逐欄對照附錄 A（草稿表名加了 `submission_` 前綴，註明在 schema/submissions.ts）。
 * 3. 約束用故意違反的寫入證明；正式版本以正式執行角色 `fju_app` 改或刪都被拒絕。
 */

const S04_LAST = '0005_s04_items'
const S05_LAST = '0006_s05_submissions'
const S05_TABLES = ['submission_drafts', 'submission_versions']

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

/** 發布過的個人收件：一位管理員、一位學生、一屆、一份項目（兩個目前版本）與學生的名單列。 */
async function seedPublishedItem(db: IsolatedDatabase) {
  const admin = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '管理員', 'a-s05@example.com', true, now(), 'active') returning id`,
  )
  const adminId = String(admin.rows[0]!.id)
  const student = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '學生', 's-s05@example.com', true, now(), 'active') returning id`,
  )
  const studentId = String(student.rows[0]!.id)
  const cohort = await db.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), '115', '115', 'active', '2027-06-30', 'system') returning id`,
  )
  const cohortId = String(cohort.rows[0]!.id)
  const stage = await db.sql(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '成組期', '2026-09-15', 'system') returning id`,
    [cohortId],
  )
  const item = await db.sql(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, due_at, title, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'individual', $2, '2026-11-15T15:59:00Z', '意向調查',
             'user', $3)
     returning id`,
    [cohortId, stage.rows[0]!.id, adminId],
  )
  const itemId = String(item.rows[0]!.id)
  const content = await db.sql(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '意向調查', '', '', $2) returning id`,
    [itemId, adminId],
  )
  const schema = await db.sql(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[{"key":"topic","type":"text","label":"題目","required":true}]}'::jsonb, $2)
     returning id`,
    [itemId, adminId],
  )
  const schemaVersionId = String(schema.rows[0]!.id)
  await db.sql(
    `update managed_items set status = 'published', actual_opened_at = '2026-09-20T00:00:00Z',
            current_content_version_id = $2, current_schema_version_id = $3
      where id = $1`,
    [itemId, content.rows[0]!.id, schemaVersionId],
  )
  await db.sql(
    `insert into response_rosters
       (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'user', $3, now(), 'auto', 'system')`,
    [itemId, cohortId, studentId],
  )
  return { adminId, studentId, cohortId, itemId, schemaVersionId }
}

type Seeded = Awaited<ReturnType<typeof seedPublishedItem>>

function insertDraft(db: IsolatedDatabase, s: Seeded, patch: { answers?: string; receiverKind?: string; migration?: string } = {}) {
  return db.sql(
    `insert into submission_drafts
       (id, item_id, receiver_kind, receiver_id, schema_version_id, answers, migration_state, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, 'user', $3)
     returning id`,
    [s.itemId, patch.receiverKind ?? 'user', s.studentId, s.schemaVersionId, patch.answers ?? '{"topic":"智慧校園"}', patch.migration ?? 'none'],
  )
}

function insertVersion(
  db: IsolatedDatabase | { query: IsolatedDatabase['pool']['query'] },
  s: Seeded,
  patch: { versionNo?: number; requestId?: string; receiverKind?: string; membership?: string | null; answers?: string } = {},
) {
  const sql = `insert into submission_versions
       (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
        received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $3, now(), now(), coalesce($7::uuid, gen_random_uuid()), $8::jsonb, 1)
     returning id`
  const values = [
    s.itemId,
    patch.receiverKind ?? 'user',
    s.studentId,
    patch.versionNo ?? 1,
    s.schemaVersionId,
    patch.answers ?? '{"topic":"智慧校園"}',
    patch.requestId ?? null,
    patch.membership ?? null,
  ]
  return 'sql' in db ? db.sql(sql, values) : db.query(sql, values)
}

describe('S04→S05 升級', () => {
  it('空庫：0005 之後四十二張表，套上 0006 長出兩張新表', async () => {
    await withIsolatedDatabase({ label: 's04-to-s05' }, async (db) => {
      await applyMigrations(db, S04_LAST)
      const afterS04 = await tableNames(db)
      expect(afterS04).toHaveLength(42)

      await applyMigration(db, S05_LAST)
      const afterS05 = await tableNames(db)
      expect(afterS05).toHaveLength(44)
      expect(afterS05.filter((t) => !afterS04.includes(t))).toEqual(S05_TABLES)
    })
  })

  it('舊表一欄都沒動（只新增表）', async () => {
    await withIsolatedDatabase({ label: 's04-untouched' }, async (db) => {
      await applyMigrations(db, S04_LAST)
      const before: Record<string, Record<string, string>> = {}
      for (const table of await tableNames(db)) before[table] = await columnsOf(db, table)

      await applyMigration(db, S05_LAST)
      for (const [table, columns] of Object.entries(before)) {
        expect(await columnsOf(db, table), `${table} 在 S05 被改動了`).toEqual(columns)
      }
    })
  })

  it('已發布收件的庫升版：項目與名單原封不動，升版後名單上的學生直接能存草稿、送出', async () => {
    await withIsolatedDatabase({ label: 's04-seeded-upgrade' }, async (db) => {
      await applyMigrations(db, S04_LAST)
      const seeded = await seedPublishedItem(db)

      await applyMigration(db, S05_LAST)

      expect(Number((await db.sql('select count(*) as n from response_rosters')).rows[0]!.n)).toBe(1)
      expect((await db.sql('select status from managed_items where id = $1', [seeded.itemId])).rows[0]!.status).toBe('published')
      await insertDraft(db, seeded)
      await insertVersion(db, seeded)
      expect(Number((await db.sql('select count(*) as n from submission_versions')).rows[0]!.n)).toBe(1)
    })
  })
})

describe('逐欄對照模組 05 附錄 A', () => {
  const EXPECTED_COLUMNS: Record<string, string[]> = {
    // 附錄 A `drafts`（加了 submission_ 前綴）；revision、updated_* 之外補契約 01 §1 的 created_*。
    submission_drafts: [
      'id', 'item_id', 'receiver_kind', 'receiver_id', 'schema_version_id', 'answers', 'legacy_answers', 'file_ids',
      'migration_state', 'revision', 'created_at', 'created_by_kind', 'created_by_user_id', 'updated_at',
      'updated_by_user_id',
    ],
    submission_versions: [
      'id', 'item_id', 'receiver_kind', 'receiver_id', 'version_no', 'schema_version_id', 'answers',
      'submitted_by_user_id', 'received_real_at', 'received_business_at', 'request_id', 'membership_snapshot',
      'advisor_snapshot', 'deadline_version_at_submit',
    ],
  }

  it.each(Object.entries(EXPECTED_COLUMNS))('%s 的欄位與附錄 A 一致', async (table, expected) => {
    await withIsolatedDatabase({ label: `cols-${table}`, setup: migratedSchema }, async (db) => {
      expect(Object.keys(await columnsOf(db, table)).sort()).toEqual([...expected].sort())
    })
  })
})

describe('約束反例', () => {
  it('一個收件者在一個項目上只有一份草稿', async () => {
    await withIsolatedDatabase({ label: 'drafts-unique', setup: migratedSchema }, async (db) => {
      const s = await seedPublishedItem(db)
      await insertDraft(db, s)
      await expect(insertDraft(db, s)).rejects.toMatchObject({ constraint: 'submission_drafts_receiver_unique' })
    })
  })

  it('草稿的收件者種類、答案形狀、改版狀態都是白名單', async () => {
    await withIsolatedDatabase({ label: 'drafts-checks', setup: migratedSchema }, async (db) => {
      const s = await seedPublishedItem(db)
      await expect(insertDraft(db, s, { receiverKind: 'teacher' })).rejects.toMatchObject({
        constraint: 'submission_drafts_receiver_kind_check',
      })
      await expect(insertDraft(db, s, { answers: '["不是物件"]' })).rejects.toMatchObject({
        constraint: 'submission_drafts_answers_check',
      })
      await expect(insertDraft(db, s, { migration: 'maybe' })).rejects.toMatchObject({
        constraint: 'submission_drafts_migration_state_check',
      })
    })
  })

  it('正式版本號在收件者內唯一；同一個人的同一個請求編號只能有一列', async () => {
    await withIsolatedDatabase({ label: 'versions-unique', setup: migratedSchema }, async (db) => {
      const s = await seedPublishedItem(db)
      const requestId = '0190f000-0000-7000-8000-000000000001'
      await insertVersion(db, s, { versionNo: 1, requestId })
      await expect(insertVersion(db, s, { versionNo: 1 })).rejects.toMatchObject({
        constraint: 'submission_versions_receiver_version_unique',
      })
      await expect(insertVersion(db, s, { versionNo: 2, requestId })).rejects.toMatchObject({
        constraint: 'submission_versions_request_unique',
      })
      await insertVersion(db, s, { versionNo: 2 })
    })
  })

  it('組別送出一定帶當時成員；個人送出不能帶', async () => {
    await withIsolatedDatabase({ label: 'versions-membership', setup: migratedSchema }, async (db) => {
      const s = await seedPublishedItem(db)
      await expect(insertVersion(db, s, { receiverKind: 'group' })).rejects.toMatchObject({
        constraint: 'submission_versions_membership_check',
      })
      await expect(insertVersion(db, s, { membership: '["x"]' })).rejects.toMatchObject({
        constraint: 'submission_versions_membership_check',
      })
      await expect(insertVersion(db, s, { versionNo: 0 })).rejects.toMatchObject({
        constraint: 'submission_versions_version_no_check',
      })
    })
  })

  it('正式版本不可變：fju_app 改、刪都被拒絕，owner 也被 trigger 擋下', async () => {
    await withIsolatedDatabase({ label: 'versions-immutable', setup: migratedSchema }, async (db) => {
      const s = await seedPublishedItem(db)
      const app = await poolAsRole(db, 'fju_app')
      try {
        const inserted = await insertVersion(app, s)
        const id = inserted.rows[0]!.id
        await expect(app.query(`update submission_versions set answers = '{}'::jsonb where id = $1`, [id])).rejects.toMatchObject({
          code: '42501',
        })
        await expect(app.query('delete from submission_versions where id = $1', [id])).rejects.toMatchObject({ code: '42501' })
        await expect(db.sql(`update submission_versions set answers = '{}'::jsonb where id = $1`, [id])).rejects.toThrow(
          /不可變表/,
        )
        await expect(db.sql('delete from submission_versions where id = $1', [id])).rejects.toThrow(/不可變表/)
        // 0008（票 21）起 `submission_files` 指向這張表：一般 TRUNCATE 先被外鍵擋；帶 CASCADE 繞過外鍵，照樣撞到 trigger。
        await expect(db.sql('truncate submission_versions')).rejects.toThrow()
        await expect(db.sql('truncate submission_versions cascade')).rejects.toThrow(/不可變表/)
      } finally {
        await app.end()
      }
    })
  })

  it('草稿不能刪、項目與收件者不能改（欄級權限）', async () => {
    await withIsolatedDatabase({ label: 'drafts-grants', setup: migratedSchema }, async (db) => {
      const s = await seedPublishedItem(db)
      const draft = await insertDraft(db, s)
      const id = draft.rows[0]!.id
      const app = await poolAsRole(db, 'fju_app')
      try {
        await app.query(`update submission_drafts set answers = '{"topic":"改"}'::jsonb, revision = revision + 1 where id = $1`, [id])
        await expect(app.query('update submission_drafts set receiver_id = gen_random_uuid() where id = $1', [id])).rejects.toMatchObject({
          code: '42501',
        })
        await expect(app.query('update submission_drafts set item_id = item_id where id = $1', [id])).rejects.toMatchObject({
          code: '42501',
        })
        await expect(app.query('delete from submission_drafts where id = $1', [id])).rejects.toMatchObject({ code: '42501' })
      } finally {
        await app.end()
      }
    })
  })
})
