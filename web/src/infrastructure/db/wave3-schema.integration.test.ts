import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  withIsolatedDatabase,
  withTemporaryDatabase,
  type IsolatedDatabase,
} from '../../../test/db'
import { applyMigration, applyMigrations, migratedSchema, migrationTags } from '../../../test/migrations'

/**
 * 第三波 W0（0012）：刪除標記、首頁設定、個別補交、輪播順序的資料層。
 *
 * AC-1：空庫跑正式的 `db:migrate` 後，版本、欄位、新表都在；權限產生器認得 W0。
 * AC-2：資料庫自己擋住「刪發布中的」「刪除者沒填」「第二列首頁設定」；app 角色改得動輪播順序，
 * 但仍然不能 DELETE。後面的票（W1、W2、W3、W10、W11、W15）只寫用例，靠這裡的約束兜底。
 */

const execFileAsync = promisify(execFile)
const webRoot = path.join(import.meta.dirname, '..', '..', '..')

const LATEST = '0012_wave3_delete_home'
const DELETE_MARKED = ['industry_opportunities', 'managed_items', 'project_events', 'showcase_entries']

beforeAll(async () => {
  await assertTestDatabaseReachable()
})

async function columnTypes(query: (sql: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>, schema: string) {
  const rows = await query(
    `select table_name, column_name, data_type, is_nullable from information_schema.columns
     where table_schema = $1 order by table_name, ordinal_position`,
    [schema],
  )
  return rows.rows.map((r) => ({
    table: String(r.table_name),
    column: String(r.column_name),
    type: String(r.data_type),
    nullable: r.is_nullable === 'YES',
  }))
}

describe('AC-1：空庫跑 db:migrate', () => {
  it('schema_version 是 0012；四張表有刪除標記、showcase_entries 有 home_position、兩張新表建好', async () => {
    await withTemporaryDatabase('w0-migrate', async (url) => {
      const { stdout } = await execFileAsync(process.execPath, ['scripts/migrate.mjs'], {
        cwd: webRoot,
        env: { ...process.env, DATABASE_URL_OWNER: url },
      })
      // schema_version 是最後一支 migration（W15 起有 0013）；其餘斷言仍針對 W0 的 0012。
      expect(stdout).toContain(`SCHEMA_VERSION=${migrationTags().at(-1)}`)

      const pool = new Pool({ connectionString: url, max: 1 })
      try {
        const meta = await pool.query(`select value from schema_meta where key = 'schema_version'`)
        expect(meta.rows).toEqual([{ value: migrationTags().at(-1) }])

        const columns = await columnTypes((sql, values) => pool.query(sql, values as never[]), 'public')
        const find = (table: string, column: string) => columns.find((c) => c.table === table && c.column === column)

        for (const table of DELETE_MARKED) {
          expect(find(table, 'deleted_at'), `${table}.deleted_at`).toEqual({
            table,
            column: 'deleted_at',
            type: 'timestamp with time zone',
            nullable: true,
          })
          expect(find(table, 'deleted_by_user_id'), `${table}.deleted_by_user_id`).toEqual({
            table,
            column: 'deleted_by_user_id',
            type: 'uuid',
            nullable: true,
          })
        }
        expect(find('showcase_entries', 'home_position')).toMatchObject({ type: 'smallint', nullable: true })
        expect(find('home_settings', 'id')).toMatchObject({ type: 'smallint', nullable: false })
        expect(columns.filter((c) => c.table === 'home_settings').map((c) => c.column)).toEqual([
          'id',
          'hero_file_id',
          'hero_alt',
          'tagline_line1',
          'tagline_line2',
          'revision',
          'updated_at',
          'updated_by_user_id',
        ])
        expect(columns.filter((c) => c.table === 'submission_reopens').map((c) => c.column)).toEqual([
          'id',
          'item_id',
          'receiver_kind',
          'receiver_id',
          'due_at',
          'reason',
          'created_at',
          'created_by_user_id',
        ])
      } finally {
        await pool.end()
      }
    })
  })

  it('權限產生器認得 W0：--check 通過，同一個產生區塊含新表權限與 showcase_entries 補欄', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/generate-grants.mjs', '--check'], { cwd: webRoot })
    expect(stdout).toContain(`drizzle/${LATEST}.sql 的 GRANT 區塊與權限矩陣一致（W0）`)

    const { stdout: printed } = await execFileAsync(process.execPath, ['scripts/generate-grants.mjs'], { cwd: webRoot })
    const w0 = printed.slice(printed.indexOf(`-- drizzle/${LATEST}.sql（W0）`))
    expect(w0).toContain('REVOKE ALL ON submission_reopens, home_settings')
    expect(w0).toContain('GRANT UPDATE ON home_settings TO fju_app;')
    expect(w0).toContain('GRANT UPDATE (deleted_at, deleted_by_user_id, home_position) ON showcase_entries TO fju_app;')
  })
})

describe('AC-2：資料庫擋住不合規的刪除與第二列首頁設定', () => {
  let owner: IsolatedDatabase
  let app: Pool
  let userId: string
  let itemId: string
  let entryId: string

  beforeAll(async () => {
    owner = await createIsolatedDatabase({ label: 'w0-checks', setup: migratedSchema })
    app = await poolAsRole(owner, 'fju_app')

    const user = await owner.sql(
      `insert into users (id, name, email, email_verified, updated_at) values (gen_random_uuid(), '系辦', 'w0@example.com', true, now()) returning id`,
    )
    userId = String(user.rows[0]!.id)
    const cohort = await owner.sql(
      `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '115-W0', '115', 'system') returning id`,
    )
    const cohortId = String(cohort.rows[0]!.id)

    // 一筆發布中的公告（發布要有實際開放時間與兩個目前版本）。
    const item = await owner.sql(
      `insert into managed_items (id, cohort_id, placement, audience_kind, title, actual_opened_at, created_by_kind)
       values (gen_random_uuid(), $1, 'news', 'public', '發布中的公告', now(), 'system') returning id`,
      [cohortId],
    )
    itemId = String(item.rows[0]!.id)
    const content = await owner.sql(
      `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
       values (gen_random_uuid(), $1, 1, '發布中的公告', '', '', $2) returning id`,
      [itemId, userId],
    )
    const form = await owner.sql(
      `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
       values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
      [itemId, userId],
    )
    await owner.sql(
      `update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`,
      [itemId, content.rows[0]!.id, form.rows[0]!.id],
    )

    // 一件公開中的精選作品。
    const entry = await owner.sql(
      `insert into showcase_entries (id, cohort_id, created_by_user_id) values (gen_random_uuid(), $1, $2) returning id`,
      [cohortId, userId],
    )
    entryId = String(entry.rows[0]!.id)
    const version = await owner.sql(
      `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, authorization_kind, authorization_ref,
                                      pii_check, created_by_user_id, created_real_at)
       values (gen_random_uuid(), $1, 1, '公開作品', '', encode(sha256(''::bytea), 'hex'), 'external', gen_random_uuid(), '{}'::jsonb, $2, now())
       returning id`,
      [entryId, userId],
    )
    await owner.sql(`update showcase_entries set status = 'published', current_version_id = $2 where id = $1`, [
      entryId,
      version.rows[0]!.id,
    ])
  })

  afterAll(async () => {
    await app?.end()
    await owner?.close()
  })

  it('發布中的專題事務項目不能標記刪除', async () => {
    await expect(
      app.query(`update managed_items set deleted_at = now(), deleted_by_user_id = $2 where id = $1`, [itemId, userId]),
    ).rejects.toThrow(/managed_items_deleted_check/)
  })

  it('公開中的精選作品不能標記刪除', async () => {
    await expect(
      app.query(`update showcase_entries set deleted_at = now(), deleted_by_user_id = $2 where id = $1`, [entryId, userId]),
    ).rejects.toThrow(/showcase_entries_deleted_check/)
  })

  it('只設刪除時間、沒記刪除者也被擋（已下架的也一樣）', async () => {
    await owner.sql(`update managed_items set status = 'archived' where id = $1`, [itemId])
    await owner.sql(`update showcase_entries set status = 'withdrawn' where id = $1`, [entryId])
    try {
      await expect(app.query(`update managed_items set deleted_at = now() where id = $1`, [itemId])).rejects.toThrow(
        /managed_items_deleted_check/,
      )
      await expect(app.query(`update showcase_entries set deleted_at = now() where id = $1`, [entryId])).rejects.toThrow(
        /showcase_entries_deleted_check/,
      )
      // 反過來：時間與刪除者都填，已下架的就刪得掉（之後的票就是這樣刪）。
      await expect(
        app.query(`update managed_items set deleted_at = now(), deleted_by_user_id = $2 where id = $1`, [itemId, userId]),
      ).resolves.toMatchObject({ rowCount: 1 })
      await expect(
        app.query(`update showcase_entries set deleted_at = now(), deleted_by_user_id = $2 where id = $1`, [entryId, userId]),
      ).resolves.toMatchObject({ rowCount: 1 })
      // 刪了就不能再回到發布中。
      await expect(app.query(`update managed_items set status = 'published' where id = $1`, [itemId])).rejects.toThrow(
        /managed_items_deleted_check/,
      )
      await expect(app.query(`update showcase_entries set status = 'published' where id = $1`, [entryId])).rejects.toThrow(
        /showcase_entries_deleted_check/,
      )
    } finally {
      await owner.sql(`update managed_items set deleted_at = null, deleted_by_user_id = null, status = 'published' where id = $1`, [itemId])
      await owner.sql(`update showcase_entries set deleted_at = null, deleted_by_user_id = null, status = 'published' where id = $1`, [
        entryId,
      ])
    }
  })

  it('home_settings 只能有 id = 1 那一列', async () => {
    await expect(
      app.query(`insert into home_settings (id, updated_by_user_id) values (2, $1)`, [userId]),
    ).rejects.toThrow(/home_settings_single_row_check/)
    await expect(app.query(`insert into home_settings (updated_by_user_id) values ($1)`, [userId])).resolves.toMatchObject({
      rowCount: 1,
    })
    await expect(app.query(`insert into home_settings (updated_by_user_id) values ($1)`, [userId])).rejects.toThrow(
      /home_settings_pkey/,
    )
    // 恢復預設＝內容欄清成 NULL，不刪列。
    await expect(
      app.query(`update home_settings set tagline_line1 = '新標語', revision = revision + 1 where id = 1`),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(app.query(`update home_settings set tagline_line1 = null where id = 1`)).resolves.toMatchObject({
      rowCount: 1,
    })
  })

  it('app 角色能改輪播順序；超出 1–99 被擋', async () => {
    await expect(app.query(`update showcase_entries set home_position = 1 where id = $1`, [entryId])).resolves.toMatchObject({
      rowCount: 1,
    })
    await expect(app.query(`update showcase_entries set home_position = 0 where id = $1`, [entryId])).rejects.toThrow(
      /showcase_entries_home_position_check/,
    )
    await expect(app.query(`update showcase_entries set home_position = 100 where id = $1`, [entryId])).rejects.toThrow(
      /showcase_entries_home_position_check/,
    )
  })

  it('DELETE 仍然被拒（權限）', async () => {
    await expect(app.query(`delete from managed_items where id = $1`, [itemId])).rejects.toThrow(/permission denied/i)
    await expect(app.query(`delete from home_settings`)).rejects.toThrow(/permission denied/i)
  })

  it('活動只有已取消、合作案只有草稿或已下架能標記刪除', async () => {
    const cohort = await owner.sql(`select cohort_id from managed_items where id = $1`, [itemId])
    const event = await owner.sql(
      `insert into project_events (id, cohort_id, title, starts_at, audience_kind, created_by_kind)
       values (gen_random_uuid(), $1, '說明會', now(), 'public', 'system') returning id`,
      [cohort.rows[0]!.cohort_id],
    )
    const eventId = event.rows[0]!.id
    await expect(
      app.query(`update project_events set deleted_at = now(), deleted_by_user_id = $2 where id = $1`, [eventId, userId]),
    ).rejects.toThrow(/project_events_deleted_check/)
    await app.query(`update project_events set status = 'cancelled' where id = $1`, [eventId])
    await expect(
      app.query(`update project_events set deleted_at = now(), deleted_by_user_id = $2 where id = $1`, [eventId, userId]),
    ).resolves.toMatchObject({ rowCount: 1 })

    const opportunity = await owner.sql(
      `insert into industry_opportunities (id, owner_teacher_user_id, company_name, department, content, requirements, status,
                                           published_business_at, created_by_kind)
       values (gen_random_uuid(), $1, '公司', '部門', '內容', '需求', 'published', now(), 'system') returning id`,
      [userId],
    )
    const opportunityId = opportunity.rows[0]!.id
    await expect(
      app.query(`update industry_opportunities set deleted_at = now(), deleted_by_user_id = $2 where id = $1`, [
        opportunityId,
        userId,
      ]),
    ).rejects.toThrow(/industry_opportunities_deleted_check/)
    await app.query(`update industry_opportunities set status = 'withdrawn', withdrawn_business_at = now() where id = $1`, [
      opportunityId,
    ])
    await expect(
      app.query(`update industry_opportunities set deleted_at = now(), deleted_by_user_id = $2 where id = $1`, [
        opportunityId,
        userId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('個別補交只插不改：理由 1–200 字、收件者只能是人或組', async () => {
    const insert = (kind: string, reason: string) =>
      app.query(
        `insert into submission_reopens (id, item_id, receiver_kind, receiver_id, due_at, reason, created_by_user_id)
         values (gen_random_uuid(), $1, $2, $3, now() + interval '1 day', $4, $3) returning id`,
        [itemId, kind, userId, reason],
      )
    await expect(insert('team', '請假')).rejects.toThrow(/submission_reopens_receiver_kind_check/)
    await expect(insert('user', '')).rejects.toThrow(/submission_reopens_reason_check/)
    await expect(insert('user', '字'.repeat(201))).rejects.toThrow(/submission_reopens_reason_check/)
    const ok = await insert('user', '字'.repeat(200))
    await expect(
      app.query(`update submission_reopens set reason = '改' where id = $1`, [ok.rows[0]!.id]),
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('0012：已套 0011、有資料的庫升版', () => {
  it('舊列的刪除標記與輪播順序都是 NULL，發布中的資料不受新 CHECK 影響', async () => {
    await withIsolatedDatabase({ label: 'w0-upgrade' }, async (db) => {
      await applyMigrations(db, '0011_t39_showcase_stage_fields')
      const user = await db.sql(
        `insert into users (id, name, email, email_verified, updated_at) values (gen_random_uuid(), '系辦', 'w0up@example.com', true, now()) returning id`,
      )
      const userId = String(user.rows[0]!.id)
      const cohort = await db.sql(
        `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '113', '113', 'system') returning id`,
      )
      const cohortId = String(cohort.rows[0]!.id)
      await db.sql(
        `insert into managed_items (id, cohort_id, placement, audience_kind, title, created_by_kind) values (gen_random_uuid(), $1, 'news', 'public', '舊公告', 'system')`,
        [cohortId],
      )
      const entry = await db.sql(
        `insert into showcase_entries (id, cohort_id, award_level, created_by_user_id) values (gen_random_uuid(), $1, 'excellent', $2) returning id`,
        [cohortId, userId],
      )
      const version = await db.sql(
        `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, authorization_kind, authorization_ref,
                                        pii_check, created_by_user_id, created_real_at)
         values (gen_random_uuid(), $1, 1, '舊作品', '', encode(sha256(''::bytea), 'hex'), 'external', gen_random_uuid(), '{}'::jsonb, $2, now())
         returning id`,
        [entry.rows[0]!.id, userId],
      )
      await db.sql(`update showcase_entries set status = 'published', current_version_id = $2 where id = $1`, [
        entry.rows[0]!.id,
        version.rows[0]!.id,
      ])
      await db.sql(
        `insert into project_events (id, cohort_id, title, starts_at, audience_kind, created_by_kind) values (gen_random_uuid(), $1, '活動', now(), 'public', 'system')`,
        [cohortId],
      )

      await applyMigration(db, LATEST)

      expect((await db.sql(`select deleted_at, deleted_by_user_id from managed_items`)).rows).toEqual([
        { deleted_at: null, deleted_by_user_id: null },
      ])
      expect((await db.sql(`select status, home_position, deleted_at, deleted_by_user_id from showcase_entries`)).rows).toEqual([
        { status: 'published', home_position: null, deleted_at: null, deleted_by_user_id: null },
      ])
      expect((await db.sql(`select deleted_at from project_events`)).rows).toEqual([{ deleted_at: null }])
      expect((await db.sql(`select count(*)::int as n from home_settings`)).rows).toEqual([{ n: 0 }])
    })
  })
})
