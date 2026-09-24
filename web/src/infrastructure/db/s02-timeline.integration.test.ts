import { beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, withIsolatedDatabase, type IsolatedDatabase } from '../../../test/db'
import { applyMigration, applyMigrations, migratedSchema } from '../../../test/migrations'

/**
 * 票 11（S02-01）：第三支 migration（模組 02 附錄 A 四張＋模組 08 附錄 A 三張，加 `cohorts.year_end_date`）。
 *
 * 驗三件事：
 * 1. 兩條升級路徑都通：空庫 S00→S01→S02、以及「已經有資料」的 S01 庫升版（票 5 之後測試站就有屆別了）。
 * 2. 逐欄對照附錄 A。
 * 3. 約束用故意違反的寫入證明，不是只看 constraint 名字。
 */

const S01_LAST = '0002_s01_accounts_and_files'
const S02_LAST = '0003_s02_timeline_and_events'

const S02_TABLES = [
  'business_clock_overrides',
  'cohort_stages',
  'cohort_status_events',
  'digest_events',
  'notifications',
  'project_events',
  'worker_heartbeat',
]

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

/** 在只跑到 S01 的資料庫裡塞一份「票 5 之後」的資料：管理員、一屆籌備中、稽核、帳本。 */
async function seedS01Data(db: IsolatedDatabase): Promise<{ userId: string; cohortId: string }> {
  const user = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '既有管理員', 'existing-s01@example.com', true, now(), 'active') returning id`,
  )
  const userId = String(user.rows[0]!.id)
  const cohort = await db.sql(
    `insert into cohorts (id, code, name, is_default_working, is_registration_open, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), '115', '115 學年', true, true, 'user', $1) returning id`,
    [userId],
  )
  const cohortId = String(cohort.rows[0]!.id)
  await db.sql(
    `insert into audit_events (id, actor_kind, actor_user_id, action, target_type, target_id, scope, cohort_id, real_at, business_at)
     values (gen_random_uuid(), 'user', $1, 'cohort.create', 'cohort', $2, 'cohort', $2, now(), now())`,
    [userId, cohortId],
  )
  await db.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'admin', $1, now())`,
    [userId],
  )
  return { userId, cohortId }
}

describe('S01→S02 升級', () => {
  it('空庫：0002 之後二十二張表，套上 0003 長出七張新表', async () => {
    await withIsolatedDatabase({ label: 's01-to-s02' }, async (db) => {
      await applyMigrations(db, S01_LAST)
      const afterS01 = await tableNames(db)
      expect(afterS01).toHaveLength(22)

      await applyMigration(db, S02_LAST)
      const afterS02 = await tableNames(db)
      expect(afterS02).toHaveLength(29)
      expect(afterS02.filter((t) => !afterS01.includes(t))).toEqual(S02_TABLES)
    })
  })

  it('S01 的表只有 cohorts 多一欄（year_end_date，可為 NULL），其餘一欄都沒動', async () => {
    await withIsolatedDatabase({ label: 's01-untouched' }, async (db) => {
      await applyMigrations(db, S01_LAST)
      const before: Record<string, Record<string, string>> = {}
      for (const table of await tableNames(db)) before[table] = await columnsOf(db, table)

      await applyMigration(db, S02_LAST)
      for (const [table, columns] of Object.entries(before)) {
        const expected = table === 'cohorts' ? { ...columns, year_end_date: 'date/YES' } : columns
        expect(await columnsOf(db, table), `${table} 在 S02 被改動了`).toEqual(expected)
      }
    })
  })

  it('已有資料的庫升版：屆別、旗標、稽核原封不動；舊屆別的年度結束日是 NULL，可以直接接上新表', async () => {
    await withIsolatedDatabase({ label: 's01-seeded-upgrade' }, async (db) => {
      await applyMigrations(db, S01_LAST)
      const { userId, cohortId } = await seedS01Data(db)

      await applyMigration(db, S02_LAST)

      const cohort = await db.sql(
        `select code, status, is_default_working, is_registration_open, year_end_date from cohorts where id = $1`,
        [cohortId],
      )
      expect(cohort.rows[0]).toEqual({
        code: '115',
        status: 'preparing',
        is_default_working: true,
        is_registration_open: true,
        year_end_date: null,
      })
      expect(Number((await db.sql('select count(*) as n from audit_events')).rows[0]!.n)).toBe(1)

      await db.sql(
        `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind, created_by_user_id)
         values (gen_random_uuid(), $1, 1, '成組期', '2026-09-15', 'user', $2)`,
        [cohortId, userId],
      )
      await db.sql(`update cohorts set year_end_date = '2027-06-30' where id = $1`, [cohortId])
      await db.sql(
        `insert into cohort_status_events (id, cohort_id, from_status, to_status, actor_user_id, real_at, business_at)
         values (gen_random_uuid(), $1, 'preparing', 'active', $2, now(), now())`,
        [cohortId, userId],
      )
      expect(Number((await db.sql('select count(*) as n from cohort_stages')).rows[0]!.n)).toBe(1)
    })
  })
})

describe('逐欄對照模組 02、08 附錄 A', () => {
  const EXPECTED_COLUMNS: Record<string, string[]> = {
    cohort_stages: [
      'id', 'cohort_id', 'seq', 'name', 'start_date', 'deadline_version', 'revision',
      'created_at', 'created_by_kind', 'created_by_user_id', 'updated_at', 'updated_by_user_id',
    ],
    project_events: [
      'id', 'cohort_id', 'title', 'description', 'starts_at', 'ends_at', 'all_day', 'audience_kind', 'status',
      'revision', 'created_at', 'created_by_kind', 'created_by_user_id', 'updated_at', 'updated_by_user_id',
    ],
    business_clock_overrides: [
      'id', 'environment', 'business_at', 'real_at', 'previous_business_at', 'set_by_user_id', 'reason',
    ],
    cohort_status_events: [
      'id', 'cohort_id', 'from_status', 'to_status', 'reason', 'unfinished_summary', 'actor_user_id', 'real_at', 'business_at',
    ],
    notifications: [
      'id', 'event_id', 'recipient_user_id', 'scope', 'cohort_id', 'kind', 'title', 'source_ref', 'created_at', 'read_at',
    ],
    digest_events: [
      'id', 'kind', 'cohort_id', 'subject_id', 'deadline_version', 'count', 'payload', 'event_id', 'generated_business_at',
    ],
    worker_heartbeat: ['id', 'version', 'last_tick_real_at', 'last_projection_at', 'last_due_work_at', 'updated_at'],
  }

  it.each(Object.entries(EXPECTED_COLUMNS))('%s 的欄位與附錄 A 一致', async (table, expected) => {
    await withIsolatedDatabase({ label: `cols-${table}`, setup: migratedSchema }, async (db) => {
      expect(Object.keys(await columnsOf(db, table)).sort()).toEqual([...expected].sort())
    })
  })

  it('階段開始日、年度結束日是純日期（date），不是時間戳', async () => {
    await withIsolatedDatabase({ label: 'date-cols', setup: migratedSchema }, async (db) => {
      expect((await columnsOf(db, 'cohort_stages')).start_date).toBe('date/NO')
      expect((await columnsOf(db, 'cohorts')).year_end_date).toBe('date/YES')
    })
  })
})

describe('約束反例', () => {
  async function seeded(db: IsolatedDatabase) {
    const user = await db.sql(
      `insert into users (id, name, email, email_verified, updated_at) values (gen_random_uuid(), 'U', 'u@example.com', false, now()) returning id`,
    )
    const cohort = await db.sql(
      `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '115-C', '115', 'system') returning id`,
    )
    const event = await db.sql(
      `insert into domain_events (id, type, scope, source_type, source_id, actor_kind, occurred_real_at, occurred_business_at)
       values (gen_random_uuid(), 'test.notification', 'global', 'test', gen_random_uuid(), 'system', now(), now()) returning id`,
    )
    return { userId: String(user.rows[0]!.id), cohortId: String(cohort.rows[0]!.id), eventId: String(event.rows[0]!.id) }
  }

  it('cohort_stages：同一屆不能兩段同一天開始、也不能兩個同序號', async () => {
    await withIsolatedDatabase({ label: 'stage-unique', setup: migratedSchema }, async (db) => {
      const { cohortId } = await seeded(db)
      const insert = (seq: number, date: string) =>
        db.sql(
          `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
           values (gen_random_uuid(), $1, $2, 's', $3, 'system')`,
          [cohortId, seq, date],
        )
      await insert(1, '2026-09-15')
      await expect(insert(2, '2026-09-15')).rejects.toThrow(/cohort_stages_start_date_unique/)
      await expect(insert(1, '2026-10-01')).rejects.toThrow(/cohort_stages_seq_unique/)
    })
  })

  it('project_events：結束不能早於開始、受眾與狀態只收白名單', async () => {
    await withIsolatedDatabase({ label: 'activity-checks', setup: migratedSchema }, async (db) => {
      const { cohortId } = await seeded(db)
      const insert = (endsAt: string | null, audience = 'cohort_students', status = 'scheduled') =>
        db.sql(
          `insert into project_events (id, cohort_id, title, starts_at, ends_at, audience_kind, status, created_by_kind)
           values (gen_random_uuid(), $1, 't', '2026-12-20T06:00:00Z', $2, $3, $4, 'system')`,
          [cohortId, endsAt, audience, status],
        )
      await expect(insert('2026-12-20T05:00:00Z')).rejects.toThrow(/project_events_ends_after_starts_check/)
      await expect(insert(null, 'everyone')).rejects.toThrow(/project_events_audience_kind_check/)
      await expect(insert(null, 'cohort_students', 'deleted')).rejects.toThrow(/project_events_status_check/)
      await expect(insert('2026-12-20T08:00:00Z')).resolves.toBeTruthy()
    })
  })

  it('cohort_status_events：進出「已封存」一定要有理由；轉進行中可以沒有', async () => {
    await withIsolatedDatabase({ label: 'status-reason', setup: migratedSchema }, async (db) => {
      const { userId, cohortId } = await seeded(db)
      const insert = (from: string | null, to: string, reason: string | null) =>
        db.sql(
          `insert into cohort_status_events (id, cohort_id, from_status, to_status, reason, actor_user_id, real_at, business_at)
           values (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now())`,
          [cohortId, from, to, reason, userId],
        )
      await expect(insert('active', 'archived', null)).rejects.toThrow(/cohort_status_events_archive_reason_check/)
      await expect(insert('archived', 'active', null)).rejects.toThrow(/cohort_status_events_archive_reason_check/)
      await expect(insert('active', 'archived', '年度結束')).resolves.toBeTruthy()
      await expect(insert('preparing', 'active', null)).resolves.toBeTruthy()
      await expect(insert(null, 'preparing', null)).resolves.toBeTruthy()
    })
  })

  it('notifications：同一事件同一收件人只有一則；scope 與屆別要配對', async () => {
    await withIsolatedDatabase({ label: 'notify-unique', setup: migratedSchema }, async (db) => {
      const { userId, cohortId, eventId } = await seeded(db)
      const insert = (scope: string, cohort: string | null) =>
        db.sql(
          `insert into notifications (id, event_id, recipient_user_id, scope, cohort_id, kind, title)
           values (gen_random_uuid(), $1, $2, $3, $4, 'test', 't')`,
          [eventId, userId, scope, cohort],
        )
      await expect(insert('cohort', null)).rejects.toThrow(/notifications_scope_cohort_check/)
      await insert('cohort', cohortId)
      await expect(insert('global', null)).rejects.toThrow(/notifications_event_recipient_unique/)
    })
  })

  it('worker_heartbeat：只能有 id=1 那一列', async () => {
    await withIsolatedDatabase({ label: 'heartbeat', setup: migratedSchema }, async (db) => {
      await db.sql(`insert into worker_heartbeat (id, version, last_tick_real_at, updated_at) values (1, 'v', now(), now())`)
      await expect(
        db.sql(`insert into worker_heartbeat (id, version, last_tick_real_at, updated_at) values (2, 'v', now(), now())`),
      ).rejects.toThrow(/worker_heartbeat_single_row_check/)
    })
  })

  it('digest_events：同一 identity（種類、對象、期限版本）只有一筆', async () => {
    await withIsolatedDatabase({ label: 'digest-unique', setup: migratedSchema }, async (db) => {
      const { eventId } = await seeded(db)
      const subject = '55555555-5555-4555-8555-555555555555'
      const insert = () =>
        db.sql(
          `insert into digest_events (id, kind, subject_id, deadline_version, count, payload, event_id, generated_business_at)
           values (gen_random_uuid(), 'overdue', $1, 1, 3, '{}'::jsonb, $2, now())`,
          [subject, eventId],
        )
      await insert()
      await expect(insert()).rejects.toThrow(/digest_events_identity/)
    })
  })
})
