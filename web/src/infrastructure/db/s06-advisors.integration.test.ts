import { beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, poolAsRole, withIsolatedDatabase, type IsolatedDatabase } from '../../../test/db'
import { applyMigration, applyMigrations, migratedSchema } from '../../../test/migrations'

/**
 * 票 19（S06）：第七支 migration（模組 03 附錄 A 的主指導、合作案、合作案連結三表，
 * 以及 `stored_files_purpose_check` 多收 `advisor_csv`）。
 *
 * 驗三件事：
 * 1. 兩條升級路徑都通：空庫 S00→S06、以及「已經有組別與名單原檔」的 S05 庫升版。
 * 2. 逐欄對照附錄 A（多出來的 `ended_by_user_id`、`end_reason` 註明在 schema/advisors.ts）。
 * 3. 約束用故意違反的寫入證明；主指導只能改結束欄（以 `fju_app` 連線）。
 */

const S05_LAST = '0006_s05_submissions'
const S06_LAST = '0007_s06_advisors'
const S06_TABLES = ['advisor_assignments', 'industry_opportunities', 'opportunity_links']

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

/** 一屆、一位老師、一位管理員、一個已成立的產學組，以及一份已存的名單原檔。 */
async function seedGroup(db: IsolatedDatabase) {
  const user = async (name: string) =>
    String(
      (
        await db.sql(
          `insert into users (id, name, email, email_verified, updated_at, status)
           values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
          [name, `${name}-${Math.random().toString(36).slice(2)}@example.com`],
        )
      ).rows[0]!.id,
    )
  const teacherId = await user('老師')
  const otherTeacherId = await user('另一位老師')
  const adminId = await user('管理員')
  const cohort = await db.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), '115', '115', 'active', '2027-06-30', 'system') returning id`,
  )
  const cohortId = String(cohort.rows[0]!.id)
  const group = await db.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'industry', now(), now(), 'system') returning id`,
    [cohortId],
  )
  const groupId = String(group.rows[0]!.id)
  await db.sql(
    `insert into stored_files
       (id, owner_user_id, scope, purpose, original_name, mime_declared, extension, storage_key, uploaded_real_at)
     values (gen_random_uuid(), $1, 'global', 'roster_csv', '名單.csv', 'text/csv', 'csv', 's06-seed-key', now())`,
    [adminId],
  )
  return { teacherId, otherTeacherId, adminId, cohortId, groupId }
}

type Seeded = Awaited<ReturnType<typeof seedGroup>>

function insertAdvisor(
  db: IsolatedDatabase | { query: IsolatedDatabase['pool']['query'] },
  s: Seeded,
  patch: { source?: string; teacherId?: string; assignedBy?: string; reason?: string | null; groupId?: string } = {},
) {
  const sql = `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, $3, now(), $4, $5) returning id`
  const teacher = patch.teacherId ?? s.teacherId
  const values = [
    patch.groupId ?? s.groupId,
    teacher,
    patch.source ?? 'claim',
    patch.assignedBy ?? teacher,
    patch.reason === undefined ? null : patch.reason,
  ]
  return 'sql' in db ? db.sql(sql, values) : db.query(sql, values)
}

function insertOpportunity(db: IsolatedDatabase, s: Seeded, patch: { status?: string; notesVisibility?: string } = {}) {
  return db.sql(
    `insert into industry_opportunities
       (id, owner_teacher_user_id, company_name, department, content, requirements, notes_visibility, status,
        created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, '輔仁科技', '資訊部', '內容', '條件', $2, $3, 'user', $1) returning id`,
    [s.teacherId, patch.notesVisibility ?? 'internal', patch.status ?? 'draft'],
  )
}

describe('S05→S06 升級', () => {
  it('空庫：0006 之後四十四張表，套上 0007 長出三張新表', async () => {
    await withIsolatedDatabase({ label: 's05-to-s06' }, async (db) => {
      await applyMigrations(db, S05_LAST)
      const afterS05 = await tableNames(db)
      expect(afterS05).toHaveLength(44)

      await applyMigration(db, S06_LAST)
      const afterS06 = await tableNames(db)
      expect(afterS06).toHaveLength(47)
      expect(afterS06.filter((t) => !afterS05.includes(t))).toEqual(S06_TABLES)
    })
  })

  it('舊表一欄都沒動；只有 stored_files 的用途白名單多了 advisor_csv', async () => {
    await withIsolatedDatabase({ label: 's05-untouched' }, async (db) => {
      await applyMigrations(db, S05_LAST)
      const before: Record<string, Record<string, string>> = {}
      for (const table of await tableNames(db)) before[table] = await columnsOf(db, table)

      await applyMigration(db, S06_LAST)
      for (const [table, columns] of Object.entries(before)) {
        expect(await columnsOf(db, table), `${table} 在 S06 被改動了`).toEqual(columns)
      }
      const check = await db.sql(
        `select pg_get_constraintdef(c.oid) as def from pg_constraint c
          join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = $1 and c.conname = 'stored_files_purpose_check'`,
        [db.schemaName],
      )
      expect(String(check.rows[0]!.def)).toContain("'advisor_csv'")
      expect(String(check.rows[0]!.def)).toContain("'roster_csv'")
    })
  })

  it('已有組別與名單原檔的庫升版：舊資料原封不動，升版後就能指派主指導、存批次 CSV', async () => {
    await withIsolatedDatabase({ label: 's05-seeded-upgrade' }, async (db) => {
      await applyMigrations(db, S05_LAST)
      const seeded = await seedGroup(db)

      await applyMigration(db, S06_LAST)

      expect((await db.sql('select group_type from groups where id = $1', [seeded.groupId])).rows[0]!.group_type).toBe('industry')
      expect(Number((await db.sql(`select count(*) as n from stored_files where purpose = 'roster_csv'`)).rows[0]!.n)).toBe(1)
      await insertAdvisor(db, seeded)
      await db.sql(
        `insert into stored_files
           (id, owner_user_id, scope, purpose, original_name, mime_declared, extension, storage_key, uploaded_real_at)
         values (gen_random_uuid(), $1, 'global', 'advisor_csv', '指派.csv', 'text/csv', 'csv', 's06-advisor-key', now())`,
        [seeded.adminId],
      )
      await expect(
        db.sql(
          `insert into stored_files
             (id, owner_user_id, scope, purpose, original_name, mime_declared, extension, storage_key, uploaded_real_at)
           values (gen_random_uuid(), $1, 'global', 'whatever', 'x.csv', 'text/csv', 'csv', 's06-bad-key', now())`,
          [seeded.adminId],
        ),
      ).rejects.toMatchObject({ constraint: 'stored_files_purpose_check' })
    })
  })
})

describe('逐欄對照模組 03 附錄 A', () => {
  const EXPECTED_COLUMNS: Record<string, string[]> = {
    // 附錄 A 加 `previous_assignment_id`（重派接手哪一列）、`ended_real_at`／`ended_by_user_id`／`end_reason`
    // （解除／重派的時間、操作者、理由留在被結束的那一列）與 created_at。
    advisor_assignments: [
      'id', 'group_id', 'teacher_user_id', 'source', 'valid_from', 'valid_to', 'assigned_by_user_id', 'reason',
      'previous_assignment_id', 'ended_real_at', 'ended_by_user_id', 'end_reason', 'created_at',
    ],
    industry_opportunities: [
      'id', 'owner_teacher_user_id', 'company_name', 'department', 'content', 'requirements', 'notes',
      'notes_visibility', 'address', 'contact_name', 'contact_phone', 'contact_email', 'status',
      'published_business_at', 'withdrawn_business_at', 'revision', 'created_at', 'created_by_kind',
      'created_by_user_id', 'updated_at', 'updated_by_user_id',
    ],
    // 附錄 A 的 `reason` 叫 `end_reason`（和主指導同名同義）；另加 `previous_link_id`（換案前後關係）與 `ended_real_at`。
    opportunity_links: [
      'id', 'group_id', 'opportunity_id', 'valid_from', 'valid_to', 'linked_by_user_id', 'previous_link_id',
      'ended_real_at', 'ended_by_user_id', 'end_reason', 'created_at',
    ],
  }

  it.each(Object.entries(EXPECTED_COLUMNS))('%s 的欄位與附錄 A 一致', async (table, expected) => {
    await withIsolatedDatabase({ label: `cols-${table}`, setup: migratedSchema }, async (db) => {
      expect(Object.keys(await columnsOf(db, table)).sort()).toEqual([...expected].sort())
    })
  })
})

describe('約束反例', () => {
  it('一組同時只有一位有效主指導；結束舊列之後才能插新的（歷史保留）', async () => {
    await withIsolatedDatabase({ label: 'advisor-one-active', setup: migratedSchema }, async (db) => {
      const s = await seedGroup(db)
      const first = await insertAdvisor(db, s)
      await expect(insertAdvisor(db, s, { teacherId: s.otherTeacherId })).rejects.toMatchObject({
        constraint: 'advisor_assignments_one_active',
      })
      await db.sql(
        `update advisor_assignments set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2, end_reason = '重派' where id = $1`,
        [first.rows[0]!.id, s.adminId],
      )
      await insertAdvisor(db, s, { teacherId: s.otherTeacherId, source: 'admin', assignedBy: s.adminId, reason: '抽籤結果' })
      expect(Number((await db.sql('select count(*) as n from advisor_assignments where group_id = $1', [s.groupId])).rows[0]!.n)).toBe(2)
    })
  })

  it('來源白名單；認領一定是老師本人；管理員指派一定有理由；結束一定記誰與理由', async () => {
    await withIsolatedDatabase({ label: 'advisor-checks', setup: migratedSchema }, async (db) => {
      const s = await seedGroup(db)
      await expect(insertAdvisor(db, s, { source: 'lottery', reason: '抽籤' })).rejects.toMatchObject({
        constraint: 'advisor_assignments_source_check',
      })
      await expect(insertAdvisor(db, s, { assignedBy: s.adminId })).rejects.toMatchObject({
        constraint: 'advisor_assignments_claim_self_check',
      })
      await expect(insertAdvisor(db, s, { source: 'admin', assignedBy: s.adminId, reason: '  ' })).rejects.toMatchObject({
        constraint: 'advisor_assignments_admin_reason_check',
      })
      await expect(insertAdvisor(db, s, { source: 'csv', assignedBy: s.adminId })).rejects.toMatchObject({
        constraint: 'advisor_assignments_admin_reason_check',
      })
      const row = await insertAdvisor(db, s)
      await expect(db.sql('update advisor_assignments set valid_to = now() where id = $1', [row.rows[0]!.id])).rejects.toMatchObject({
        constraint: 'advisor_assignments_ended_check',
      })
      await expect(
        db.sql(`update advisor_assignments set valid_to = now(), ended_by_user_id = $2, end_reason = '解除' where id = $1`, [
          row.rows[0]!.id,
          s.adminId,
        ]),
      ).rejects.toMatchObject({ constraint: 'advisor_assignments_ended_check' })
    })
  })

  it('fju_app 只能改主指導的結束欄：換老師、改來源都被拒', async () => {
    await withIsolatedDatabase({ label: 'advisor-app-grants', setup: migratedSchema }, async (db) => {
      const s = await seedGroup(db)
      const app = await poolAsRole(db, 'fju_app')
      try {
        const row = await insertAdvisor(app, s)
        const id = row.rows[0]!.id
        await expect(app.query('update advisor_assignments set teacher_user_id = $2 where id = $1', [id, s.otherTeacherId])).rejects.toMatchObject({
          code: '42501',
        })
        await expect(app.query(`update advisor_assignments set source = 'admin' where id = $1`, [id])).rejects.toMatchObject({
          code: '42501',
        })
        await expect(app.query('delete from advisor_assignments where id = $1', [id])).rejects.toMatchObject({ code: '42501' })
        await app.query(
          `update advisor_assignments set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2, end_reason = '解除' where id = $1`,
          [id, s.adminId],
        )
      } finally {
        await app.end()
      }
    })
  })

  it('合作案的狀態、備註可見性白名單；已發布與已下架要有時間', async () => {
    await withIsolatedDatabase({ label: 'opportunity-checks', setup: migratedSchema }, async (db) => {
      const s = await seedGroup(db)
      await expect(insertOpportunity(db, s, { status: 'public' })).rejects.toMatchObject({
        constraint: 'industry_opportunities_status_check',
      })
      await expect(insertOpportunity(db, s, { notesVisibility: 'internet' })).rejects.toMatchObject({
        constraint: 'industry_opportunities_notes_visibility_check',
      })
      await expect(insertOpportunity(db, s, { status: 'published' })).rejects.toMatchObject({
        constraint: 'industry_opportunities_published_at_check',
      })
      await expect(insertOpportunity(db, s, { status: 'withdrawn' })).rejects.toMatchObject({
        constraint: 'industry_opportunities_withdrawn_at_check',
      })
      const draft = await insertOpportunity(db, s)
      const created = await db.sql('select notes_visibility, status from industry_opportunities where id = $1', [draft.rows[0]!.id])
      expect(created.rows[0]).toMatchObject({ notes_visibility: 'internal', status: 'draft' })
    })
  })

  it('一組最多連結一個合作案、一案可連多組；解除要記誰與理由', async () => {
    await withIsolatedDatabase({ label: 'links-checks', setup: migratedSchema }, async (db) => {
      const s = await seedGroup(db)
      const opportunity = String((await insertOpportunity(db, s)).rows[0]!.id)
      const another = String((await insertOpportunity(db, s)).rows[0]!.id)
      const other = await db.sql(
        `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
         values (gen_random_uuid(), $1, 'G02', 'industry', now(), now(), 'system') returning id`,
        [s.cohortId],
      )
      const link = (groupId: string, opportunityId: string) =>
        db.sql(
          `insert into opportunity_links (id, group_id, opportunity_id, valid_from, linked_by_user_id)
           values (gen_random_uuid(), $1, $2, now(), $3) returning id`,
          [groupId, opportunityId, s.adminId],
        )
      const first = await link(s.groupId, opportunity)
      await link(String(other.rows[0]!.id), opportunity)
      await expect(link(s.groupId, another)).rejects.toMatchObject({ constraint: 'opportunity_links_one_active' })
      await expect(db.sql('update opportunity_links set valid_to = now() where id = $1', [first.rows[0]!.id])).rejects.toMatchObject({
        constraint: 'opportunity_links_ended_check',
      })
      await db.sql(
        `update opportunity_links set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2, end_reason = '換案' where id = $1`,
        [first.rows[0]!.id, s.adminId],
      )
      await link(s.groupId, another)
    })
  })
})
