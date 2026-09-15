import { beforeAll, describe, expect, it } from 'vitest'
import {
  assertTestDatabaseReachable,
  withIsolatedDatabase,
  withTemporaryDatabase,
  type IsolatedDatabase,
} from '../../../test/db'
import { applyMigration, applyMigrations, migratedSchema, runDrizzleMigrator } from '../../../test/migrations'

/**
 * S01-01：第二支 migration（模組 01 v2.4 附錄 A 九張表＋模組 10 最小檔案兩張）。
 *
 * 這裡驗三件事：
 * 1. 兩條升級路徑（空庫 S00→S01、前一版 seed 庫升版）都成立，而且 S00 的資料與欄位一個不動。
 * 2. 逐欄對照附錄 A——欄位少一個、型別錯一個都要紅。
 * 3. 約束是**用故意衝突的寫入**證明的，不是只斷言 constraint 名字存在。
 */

const S00_LAST = '0001_s00_roles_and_immutability'
const S01_LAST = '0002_s01_accounts_and_files'

beforeAll(async () => {
  await assertTestDatabaseReachable()
})

async function columnsOf(db: IsolatedDatabase, table: string): Promise<Record<string, string>> {
  const rows = await db.sql(
    `select column_name, data_type, is_nullable from information_schema.columns
     where table_schema = $1 and table_name = $2`,
    [db.schemaName, table],
  )
  return Object.fromEntries(
    rows.rows.map((r) => [String(r.column_name), `${r.data_type}/${r.is_nullable}`]),
  )
}

async function tableNames(db: IsolatedDatabase): Promise<string[]> {
  const rows = await db.sql(
    `select table_name from information_schema.tables
     where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
    [db.schemaName],
  )
  return rows.rows.map((r) => String(r.table_name))
}

/** 在只跑到 S00 的資料庫裡塞一份「前一版」的資料。 */
async function seedS00Data(db: IsolatedDatabase): Promise<{ userId: string; cohortId: string }> {
  const user = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '既有使用者', 'existing@example.com', true, now(), 'active') returning id`,
  )
  const userId = String(user.rows[0]!.id)
  const cohort = await db.sql(
    `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '114', '114 學年', 'system') returning id`,
  )
  const cohortId = String(cohort.rows[0]!.id)
  await db.sql(
    `insert into audit_events (id, actor_kind, actor_user_id, action, target_type, scope, cohort_id, real_at, business_at)
     values (gen_random_uuid(), 'user', $1, 'cohort.create', 'cohort', 'cohort', $2, now(), now())`,
    [userId, cohortId],
  )
  await db.sql(
    `insert into sessions (id, expires_at, token, updated_at, user_id, login_method)
     values (gen_random_uuid(), now() + interval '1 day', 'existing-token', now(), $1, 'password')`,
    [userId],
  )
  return { userId, cohortId }
}

describe('S00→S01 升級', () => {
  it('空庫：0001 之後只有 S00 十一張表，套上 0002 才長出新的十一張', async () => {
    await withIsolatedDatabase({ label: 's00-to-s01' }, async (db) => {
      await applyMigrations(db, S00_LAST)
      const afterS00 = await tableNames(db)
      expect(afterS00).toHaveLength(11)
      expect(afterS00).not.toContain('user_profiles')

      await applyMigration(db, S01_LAST)
      const afterS01 = await tableNames(db)
      expect(afterS01).toHaveLength(22)
      // S00 的每一張表都還在。
      for (const table of afterS00) expect(afterS01).toContain(table)
    })
  })

  it('S00 的表一欄都沒被動到（欄名、型別、可為空三者都比對）', async () => {
    await withIsolatedDatabase({ label: 's00-untouched' }, async (db) => {
      await applyMigrations(db, S00_LAST)
      const before: Record<string, Record<string, string>> = {}
      for (const table of await tableNames(db)) before[table] = await columnsOf(db, table)

      await applyMigration(db, S01_LAST)
      for (const [table, columns] of Object.entries(before)) {
        expect(await columnsOf(db, table), `${table} 在 S01 被改動了`).toEqual(columns)
      }
    })
  })

  it('前一版的 seed 庫升版：既有資料原封不動', async () => {
    await withIsolatedDatabase({ label: 'seeded-upgrade' }, async (db) => {
      await applyMigrations(db, S00_LAST)
      const { userId, cohortId } = await seedS00Data(db)

      await applyMigration(db, S01_LAST)

      const user = await db.sql('select id, email, status from users where id = $1', [userId])
      expect(user.rows[0]).toMatchObject({ email: 'existing@example.com', status: 'active' })
      const cohort = await db.sql('select code from cohorts where id = $1', [cohortId])
      expect(cohort.rows[0]!.code).toBe('114')
      const audit = await db.sql('select count(*)::int as n from audit_events')
      expect(audit.rows[0]!.n).toBe(1)
      const session = await db.sql('select token from sessions where user_id = $1', [userId])
      expect(session.rows[0]!.token).toBe('existing-token')

      // 升版後既有使用者可以直接掛上新表（FK 目標就是他）。
      await db.sql(
        `insert into user_profiles (user_id, display_name, name_normalized, department_class, contact_email)
         values ($1, '既有使用者', 'jiyoushiyongzhe', '資管二甲', 'existing@example.com')`,
        [userId],
      )
      const profile = await db.sql('select department_class from user_profiles where user_id = $1', [userId])
      expect(profile.rows[0]!.department_class).toBe('資管二甲')
    })
  })

  it('用正式那支 migrator 跑第二次是 no-op，資料不動', async () => {
    await withTemporaryDatabase('migrator-rerun', async (url) => {
      const firstRun = await runDrizzleMigrator(url)
      expect(firstRun).toBe(3)

      const { Pool } = await import('pg')
      const pool = new Pool({ connectionString: url, max: 1 })
      try {
        await pool.query(
          `insert into users (id, name, email, email_verified, updated_at)
           values (gen_random_uuid(), '重跑前寫的', 'rerun@example.com', false, now())`,
        )

        const secondRun = await runDrizzleMigrator(url)
        expect(secondRun, '第二次跑不應該再套任何一支 migration').toBe(firstRun)

        const rows = await pool.query(`select count(*)::int as n from users where email = 'rerun@example.com'`)
        expect(rows.rows[0].n).toBe(1)
        const tables = await pool.query(
          `select count(*)::int as n from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> '__drizzle_migrations'`,
        )
        expect(tables.rows[0].n).toBe(22)
      } finally {
        await pool.end()
      }
    })
  })
})

describe('逐欄對照模組 01 v2.4 附錄 A 與模組 10 附錄 A', () => {
  /** 表 → 附錄 A 列的欄位（`department_class` 為 2026-09-15 定案新增）。 */
  const EXPECTED_COLUMNS: Record<string, string[]> = {
    user_profiles: [
      'user_id', 'display_name', 'name_normalized', 'student_no', 'department_class', 'cohort_id',
      'phone', 'contact_email', 'login_method_last', 'profile_completed_at',
      'revision', 'created_at', 'updated_at', 'updated_by_user_id',
    ],
    student_identities: ['cohort_id', 'student_no', 'user_id', 'created_at'],
    registration_applications: [
      'id', 'user_id', 'revision', 'applied_name', 'student_no', 'department_class', 'phone',
      'contact_email', 'login_email', 'roster_version_id', 'roster_match', 'state',
      'decided_by_user_id', 'decided_real_at', 'verification_method', 'verification_note', 'reason',
      'assigned_cohort_id', 'created_at', 'updated_at', 'updated_by_user_id',
    ],
    application_revisions: ['id', 'application_id', 'revision', 'snapshot', 'created_at'],
    roster_versions: ['id', 'cohort_id', 'imported_by_user_id', 'imported_real_at', 'summary', 'file_id'],
    roster_entries: [
      'id', 'roster_version_id', 'student_no', 'name_raw', 'name_normalized', 'department_class',
      'email', 'conflict_flag',
    ],
    role_assignments: [
      'id', 'user_id', 'role', 'granted_by_user_id', 'granted_real_at',
      'revoked_by_user_id', 'revoked_real_at', 'reason',
    ],
    user_status_events: [
      'id', 'user_id', 'from_status', 'to_status', 'reason', 'verification_method',
      'actor_kind', 'actor_user_id', 'real_at',
    ],
    session_revocations: [
      'id', 'user_id', 'status_event_id', 'trigger', 'reconcile_reason', 'reconcile_of_id',
      'reconcile_round', 'kind', 'state', 'lease_owner', 'lease_expires_at', 'outcome_unknown',
      'expected_user_status', 'cancel_reason', 'last_error', 'requested_real_at', 'completed_real_at',
      'revision', 'created_at', 'updated_at', 'updated_by_user_id',
    ],
    stored_files: [
      'id', 'owner_user_id', 'scope', 'cohort_id', 'purpose', 'original_name', 'size_bytes',
      'mime_declared', 'mime_detected', 'extension', 'checksum', 'status', 'storage_key',
      'uploaded_real_at', 'finalized_at', 'soft_deleted_at', 'purged_at',
      'revision', 'created_at', 'updated_at', 'updated_by_user_id',
    ],
    file_references: ['id', 'file_id', 'ref_type', 'ref_id', 'created_at', 'released_at'],
  }

  it.each(Object.entries(EXPECTED_COLUMNS))('%s 的欄位與附錄 A 一致', async (table, expected) => {
    await withIsolatedDatabase({ label: `cols-${table}`, setup: migratedSchema }, async (db) => {
      expect(Object.keys(await columnsOf(db, table)).sort()).toEqual([...expected].sort())
    })
  })

  it('`session_revocations` 移除了 v2.3 的 attempts（v2.4 改用 reconcile_round）', async () => {
    await withIsolatedDatabase({ label: 'no-attempts', setup: migratedSchema }, async (db) => {
      expect(Object.keys(await columnsOf(db, 'session_revocations'))).not.toContain('attempts')
    })
  })
})

/** 一套可重複使用的最小資料：一個使用者、一個屆別、一筆狀態事件。 */
async function seedForConstraints(db: IsolatedDatabase) {
  const user = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at)
     values (gen_random_uuid(), '約束測試', 'constraint@example.com', false, now()) returning id`,
  )
  const userId = String(user.rows[0]!.id)
  const cohort = await db.sql(
    `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '115', '115 學年', 'system') returning id`,
  )
  const cohortId = String(cohort.rows[0]!.id)
  const statusEvent = async () => {
    const row = await db.sql(
      `insert into user_status_events (id, user_id, from_status, to_status, actor_kind, actor_user_id, real_at)
       values (gen_random_uuid(), $1, 'active', 'disabled', 'user', $1, now()) returning id`,
      [userId],
    )
    return String(row.rows[0]!.id)
  }
  return { userId, cohortId, statusEvent }
}

describe('session_revocations 的 CHECK（附錄 A v2.4）', () => {
  it('trigger=status_event 不能帶 reconcile 欄位，reconcile 一定要帶', async () => {
    await withIsolatedDatabase({ label: 'sr-checks', setup: migratedSchema }, async (db) => {
      const { userId, statusEvent } = await seedForConstraints(db)
      const eventId = await statusEvent()

      // 主工作帶 reconcile_reason → 配對 CHECK 擋下。
      await expect(
        db.sql(
          `insert into session_revocations (id, user_id, status_event_id, trigger, reconcile_reason, kind, expected_user_status, requested_real_at)
           values (gen_random_uuid(), $1, $2, 'status_event', 'periodic', 'ban', 'disabled', now())`,
          [userId, eventId],
        ),
      ).rejects.toThrow(/session_revocations_reconcile_reason_pairing_check/)

      // 收斂工作沒帶 reconcile_of_id → 另一條配對 CHECK 擋下。
      await expect(
        db.sql(
          `insert into session_revocations (id, user_id, status_event_id, trigger, reconcile_reason, reconcile_round, kind, expected_user_status, requested_real_at)
           values (gen_random_uuid(), $1, $2, 'reconcile', 'periodic', 1, 'unban', 'active', now())`,
          [userId, eventId],
        ),
      ).rejects.toThrow(/session_revocations_reconcile_of_pairing_check/)
    })
  })

  it('reconcile_round：主工作必須是 0、收斂工作必須 ≥ 1', async () => {
    await withIsolatedDatabase({ label: 'sr-round', setup: migratedSchema }, async (db) => {
      const { userId, statusEvent } = await seedForConstraints(db)
      const eventId = await statusEvent()
      await expect(
        db.sql(
          `insert into session_revocations (id, user_id, status_event_id, reconcile_round, kind, expected_user_status, requested_real_at)
           values (gen_random_uuid(), $1, $2, 1, 'ban', 'disabled', now())`,
          [userId, eventId],
        ),
      ).rejects.toThrow(/session_revocations_reconcile_round_check/)
    })
  })

  it('executing 一定要有租約', async () => {
    await withIsolatedDatabase({ label: 'sr-lease', setup: migratedSchema }, async (db) => {
      const { userId, statusEvent } = await seedForConstraints(db)
      const eventId = await statusEvent()
      await expect(
        db.sql(
          `insert into session_revocations (id, user_id, status_event_id, state, kind, expected_user_status, requested_real_at)
           values (gen_random_uuid(), $1, $2, 'executing', 'ban', 'disabled', now())`,
          [userId, eventId],
        ),
      ).rejects.toThrow(/session_revocations_lease_check/)
    })
  })
})

describe('session_revocations 的三條部分唯一鍵（附錄 A v2.4）', () => {
  it('① 一個狀態事件只有一筆主工作', async () => {
    await withIsolatedDatabase({ label: 'sr-uniq1', setup: migratedSchema }, async (db) => {
      const { userId, statusEvent } = await seedForConstraints(db)
      const eventId = await statusEvent()
      const insertMain = () =>
        db.sql(
          `insert into session_revocations (id, user_id, status_event_id, kind, expected_user_status, requested_real_at)
           values (gen_random_uuid(), $1, $2, 'ban', 'disabled', now())`,
          [userId, eventId],
        )
      await insertMain()
      await expect(insertMain()).rejects.toThrow(/session_revocations_one_main_per_event/)

      // 換一個狀態事件就可以再排一筆主工作。
      await expect(
        db.sql(
          `insert into session_revocations (id, user_id, status_event_id, kind, expected_user_status, requested_real_at)
           values (gen_random_uuid(), $1, $2, 'unban', 'active', now())`,
          [userId, await statusEvent()],
        ),
      ).resolves.toBeTruthy()
    })
  })

  it('② 每人同時只有一筆 executing', async () => {
    await withIsolatedDatabase({ label: 'sr-uniq2', setup: migratedSchema }, async (db) => {
      const { userId, statusEvent } = await seedForConstraints(db)
      const executing = (eventId: string) =>
        db.sql(
          `insert into session_revocations
             (id, user_id, status_event_id, state, lease_owner, lease_expires_at, kind, expected_user_status, requested_real_at)
           values (gen_random_uuid(), $1, $2, 'executing', 'worker-1', now() + interval '30 seconds', 'ban', 'disabled', now())`,
          [userId, eventId],
        )
      await executing(await statusEvent())
      await expect(executing(await statusEvent())).rejects.toThrow(
        /session_revocations_one_executing_per_user/,
      )
    })
  })

  it('③ 每人同時只有一筆未結的收斂工作——這就是收斂插入的冪等鍵', async () => {
    await withIsolatedDatabase({ label: 'sr-uniq3', setup: migratedSchema }, async (db) => {
      const { userId, statusEvent } = await seedForConstraints(db)
      const eventId = await statusEvent()
      const main = await db.sql(
        `insert into session_revocations (id, user_id, status_event_id, kind, expected_user_status, requested_real_at, state, completed_real_at)
         values (gen_random_uuid(), $1, $2, 'ban', 'disabled', now(), 'done', now()) returning id`,
        [userId, eventId],
      )
      const mainId = String(main.rows[0]!.id)

      const insertReconcile = (round: number) =>
        db.sql(
          `insert into session_revocations
             (id, user_id, status_event_id, trigger, reconcile_reason, reconcile_of_id, reconcile_round, kind, expected_user_status, requested_real_at)
           values (gen_random_uuid(), $1, $2, 'reconcile', 'periodic', $3, $4, 'unban', 'active', now())
           on conflict do nothing returning id`,
          [userId, eventId, mainId, round],
        )

      const first = await insertReconcile(1)
      expect(first.rowCount).toBe(1)
      // 第二個核對者同時插入：ON CONFLICT DO NOTHING 命中鍵③，視為「已經有人排入」。
      const second = await insertReconcile(2)
      expect(second.rowCount).toBe(0)

      const open = await db.sql(
        `select count(*)::int as n from session_revocations where user_id = $1 and trigger = 'reconcile'`,
        [userId],
      )
      expect(open.rows[0]!.n).toBe(1)
    })
  })
})

describe('其他表的約束反例', () => {
  it('file_references：同一引用者只有一筆有效引用，釋放後可以再附回（契約 01 §11）', async () => {
    await withIsolatedDatabase({ label: 'file-ref', setup: migratedSchema }, async (db) => {
      const { userId } = await seedForConstraints(db)
      const file = await db.sql(
        `insert into stored_files
           (id, owner_user_id, scope, purpose, original_name, mime_declared, extension, storage_key, uploaded_real_at)
         values (gen_random_uuid(), $1, 'global', 'roster_csv', '名單.csv', 'text/csv', 'csv', 'k1', now()) returning id`,
        [userId],
      )
      const fileId = String(file.rows[0]!.id)
      const refId = '44444444-4444-4444-8444-444444444444'

      const attach = () =>
        db.sql(
          `insert into file_references (id, file_id, ref_type, ref_id)
           values (gen_random_uuid(), $1, 'roster_version', $2)`,
          [fileId, refId],
        )

      await attach()
      await expect(attach()).rejects.toThrow(/file_references_active_ref/)

      await db.sql(`update file_references set released_at = now() where file_id = $1`, [fileId])
      await expect(attach()).resolves.toBeTruthy()
    })
  })

  it('registration_applications：一個人同時只有一筆待審', async () => {
    await withIsolatedDatabase({ label: 'one-pending', setup: migratedSchema }, async (db) => {
      const { userId } = await seedForConstraints(db)
      const apply = (state: string) =>
        db.sql(
          `insert into registration_applications
             (id, user_id, applied_name, student_no, phone, contact_email, login_email, state, verification_method)
           values (gen_random_uuid(), $1, '約束測試', '410000002', '0900000002', 'c@example.com', 'c@example.com', $2,
                   case when $2 = 'approved' then 'id_document' else null end)`,
          [userId, state],
        )
      await apply('pending')
      await expect(apply('pending')).rejects.toThrow(/registration_applications_one_pending/)
      // 已決的申請不占鍵，可以有很多筆。
      await expect(apply('rejected')).resolves.toBeTruthy()
      await expect(apply('approved')).resolves.toBeTruthy()
    })
  })

  it('registration_applications：核准必須有核實方式，other 必須寫說明', async () => {
    await withIsolatedDatabase({ label: 'verify-check', setup: migratedSchema }, async (db) => {
      const { userId } = await seedForConstraints(db)
      await expect(
        db.sql(
          `insert into registration_applications
             (id, user_id, applied_name, student_no, phone, contact_email, login_email, state)
           values (gen_random_uuid(), $1, 'X', '410000003', '09', 'c@example.com', 'c@example.com', 'approved')`,
          [userId],
        ),
      ).rejects.toThrow(/registration_applications_approved_verification_check/)

      await expect(
        db.sql(
          `insert into registration_applications
             (id, user_id, applied_name, student_no, phone, contact_email, login_email, state, verification_method)
           values (gen_random_uuid(), $1, 'X', '410000004', '09', 'c@example.com', 'c@example.com', 'approved', 'other')`,
          [userId],
        ),
      ).rejects.toThrow(/registration_applications_other_note_check/)
    })
  })

  it('student_identities：同屆同學號只能被一個人占用，釋放後才輪得到別人', async () => {
    await withIsolatedDatabase({ label: 'occupancy', setup: migratedSchema }, async (db) => {
      const { userId, cohortId } = await seedForConstraints(db)
      const other = await db.sql(
        `insert into users (id, name, email, email_verified, updated_at)
         values (gen_random_uuid(), '另一人', 'other@example.com', false, now()) returning id`,
      )
      const otherId = String(other.rows[0]!.id)

      const occupy = (uid: string) =>
        db.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, '410000005', $2)`, [
          cohortId,
          uid,
        ])

      await occupy(userId)
      await expect(occupy(otherId)).rejects.toThrow(/student_identities_pkey/)

      await db.sql(`delete from student_identities where user_id = $1`, [userId])
      await expect(occupy(otherId)).resolves.toBeTruthy()
    })
  })

  it('role_assignments：同一角色同時只有一筆有效，撤銷後可以再指派', async () => {
    await withIsolatedDatabase({ label: 'role-active', setup: migratedSchema }, async (db) => {
      const { userId } = await seedForConstraints(db)
      const grant = () =>
        db.sql(
          `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
           values (gen_random_uuid(), $1, 'admin', $1, now())`,
          [userId],
        )
      await grant()
      await expect(grant()).rejects.toThrow(/role_assignments_one_active/)

      await db.sql(`update role_assignments set revoked_real_at = now() where user_id = $1`, [userId])
      await expect(grant()).resolves.toBeTruthy()
    })
  })

  it('roster_entries：同一版本學號唯一', async () => {
    await withIsolatedDatabase({ label: 'roster-uniq', setup: migratedSchema }, async (db) => {
      const { userId, cohortId } = await seedForConstraints(db)
      const version = await db.sql(
        `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
         values (gen_random_uuid(), $1, $2, now(), '{"total":1}'::jsonb) returning id`,
        [cohortId, userId],
      )
      const versionId = String(version.rows[0]!.id)
      const entry = () =>
        db.sql(
          `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized)
           values (gen_random_uuid(), $1, '410000006', '甲同學', 'jiatongxue')`,
          [versionId],
        )
      await entry()
      await expect(entry()).rejects.toThrow(/roster_entries_identity/)
    })
  })
})

describe('系級（2026-09-15 定案）', () => {
  it('名單列、註冊申請、修改歷史、核准後的個人資料都存得住完整文字', async () => {
    await withIsolatedDatabase({ label: 'dept-class', setup: migratedSchema }, async (db) => {
      const { userId, cohortId } = await seedForConstraints(db)
      const version = await db.sql(
        `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
         values (gen_random_uuid(), $1, $2, now(), '{"total":2}'::jsonb) returning id`,
        [cohortId, userId],
      )
      const versionId = String(version.rows[0]!.id)

      await db.sql(
        `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized, department_class)
         values (gen_random_uuid(), $1, '410000007', '甲同學', 'jiatongxue', '資管二甲'),
                (gen_random_uuid(), $1, '410000008', '乙同學', 'yitongxue', '資管二乙')`,
        [versionId],
      )
      const application = await db.sql(
        `insert into registration_applications
           (id, user_id, applied_name, student_no, department_class, phone, contact_email, login_email, roster_version_id)
         values (gen_random_uuid(), $1, '甲同學', '410000007', '資管二甲', '0900000003', 'a@example.com', 'a@example.com', $2)
         returning id`,
        [userId, versionId],
      )
      const applicationId = String(application.rows[0]!.id)
      await db.sql(
        `insert into application_revisions (id, application_id, revision, snapshot)
         values (gen_random_uuid(), $1, 1, $2::jsonb), (gen_random_uuid(), $1, 2, $3::jsonb)`,
        [
          applicationId,
          JSON.stringify({ departmentClass: '資管二甲', studentNo: '410000007' }),
          JSON.stringify({ departmentClass: '資管二乙', studentNo: '410000007' }),
        ],
      )
      await db.sql(
        `insert into user_profiles (user_id, display_name, name_normalized, student_no, department_class, cohort_id, contact_email)
         values ($1, '甲同學', 'jiatongxue', '410000007', '資管二乙', $2, 'a@example.com')`,
        [userId, cohortId],
      )

      const entries = await db.sql(
        `select student_no, department_class from roster_entries where roster_version_id = $1 order by student_no`,
        [versionId],
      )
      expect(entries.rows.map((r) => r.department_class)).toEqual(['資管二甲', '資管二乙'])

      const app = await db.sql('select department_class from registration_applications where id = $1', [
        applicationId,
      ])
      expect(app.rows[0]!.department_class).toBe('資管二甲')

      // 修改歷史留得住兩個版本的系級。
      const revisions = await db.sql(
        `select revision, snapshot ->> 'departmentClass' as dept from application_revisions
         where application_id = $1 order by revision`,
        [applicationId],
      )
      expect(revisions.rows.map((r) => r.dept)).toEqual(['資管二甲', '資管二乙'])

      const profile = await db.sql('select department_class, cohort_id from user_profiles where user_id = $1', [
        userId,
      ])
      expect(profile.rows[0]!.department_class).toBe('資管二乙')
      // 系級與屆別是兩個獨立欄位，不能互相推導。
      expect(profile.rows[0]!.cohort_id).toBe(cohortId)
    })
  })

  it('舊資料沒有系級就留白，不從屆別猜填', async () => {
    await withIsolatedDatabase({ label: 'dept-null', setup: migratedSchema }, async (db) => {
      const { userId, cohortId } = await seedForConstraints(db)
      const version = await db.sql(
        `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
         values (gen_random_uuid(), $1, $2, now(), '{"total":1}'::jsonb) returning id`,
        [cohortId, userId],
      )
      // 舊的三欄 CSV：沒有 department_class 這一欄。
      await db.sql(
        `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized)
         values (gen_random_uuid(), $1, '410000009', '丙同學', 'bingtongxue')`,
        [String(version.rows[0]!.id)],
      )
      const row = await db.sql(`select department_class from roster_entries where student_no = '410000009'`)
      expect(row.rows[0]!.department_class).toBeNull()
    })
  })
})
