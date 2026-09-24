import { beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, withIsolatedDatabase, type IsolatedDatabase } from '../../../test/db'
import { applyMigration, applyMigrations, migratedSchema } from '../../../test/migrations'

/**
 * 票 13（S03-01）：第四支 migration（模組 03 附錄 A 六張分組表；cohorts 三欄、user_profiles 一欄、三條 CHECK）。
 *
 * 驗三件事：
 * 1. 兩條升級路徑都通：空庫 S00→S03、以及「已經有資料」的 S02 庫升版（票 11 之後測試站就有階段與事件了）。
 * 2. 逐欄對照附錄 A（2026-09-24 定案拿掉 `groups.exception_basis`）。
 * 3. 約束用故意違反的寫入證明，不是只看 constraint 名字。
 */

const S02_LAST = '0003_s02_timeline_and_events'
const S03_LAST = '0004_s03_groups'

const S03_TABLES = [
  'group_leaders',
  'group_memberships',
  'group_proposals',
  'groups',
  'proposal_invitations',
  'proposal_occupancy',
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

/** 只跑到 S02 的庫：一位管理員、一屆進行中（年度結束日刻意是 NULL——S01 期間允許）、一屆籌備中、一段階段。 */
async function seedS02Data(db: IsolatedDatabase) {
  const user = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '既有管理員', 'existing-s02@example.com', true, now(), 'active') returning id`,
  )
  const userId = String(user.rows[0]!.id)
  const legacy = await db.sql(
    `insert into cohorts (id, code, name, status, created_by_kind) values (gen_random_uuid(), '114', '114', 'active', 'system') returning id`,
  )
  const current = await db.sql(
    `insert into cohorts (id, code, name, year_end_date, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), '115', '115', '2027-06-30', 'user', $1) returning id`,
    [userId],
  )
  await db.sql(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '成組期', '2026-09-15', 'system')`,
    [current.rows[0]!.id],
  )
  await db.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email, cohort_id)
     values ($1, '既有管理員', '既有管理員', 'existing-s02@example.com', $2)`,
    [userId, current.rows[0]!.id],
  )
  return { userId, legacyId: String(legacy.rows[0]!.id), currentId: String(current.rows[0]!.id) }
}

describe('S02→S03 升級', () => {
  it('空庫：0003 之後二十九張表，套上 0004 長出六張新表', async () => {
    await withIsolatedDatabase({ label: 's02-to-s03' }, async (db) => {
      await applyMigrations(db, S02_LAST)
      const afterS02 = await tableNames(db)
      expect(afterS02).toHaveLength(29)

      await applyMigration(db, S03_LAST)
      const afterS03 = await tableNames(db)
      expect(afterS03).toHaveLength(35)
      expect(afterS03.filter((t) => !afterS02.includes(t))).toEqual(S03_TABLES)
    })
  })

  it('舊表只多四欄：cohorts 三欄（都有預設值）、user_profiles 一欄；其餘一欄都沒動', async () => {
    await withIsolatedDatabase({ label: 's02-untouched' }, async (db) => {
      await applyMigrations(db, S02_LAST)
      const before: Record<string, Record<string, string>> = {}
      for (const table of await tableNames(db)) before[table] = await columnsOf(db, table)

      await applyMigration(db, S03_LAST)
      const added: Record<string, Record<string, string>> = {
        cohorts: { proposal_default_days: 'integer/NO', group_size_min: 'integer/NO', group_size_max: 'integer/NO' },
        user_profiles: { open_to_join: 'boolean/NO' },
      }
      for (const [table, columns] of Object.entries(before)) {
        expect(await columnsOf(db, table), `${table} 在 S03 被改動了`).toEqual({ ...columns, ...(added[table] ?? {}) })
      }
    })
  })

  it('已有資料的庫升版：舊屆別補上預設（5 人、7 天）、個資沒公開；進行中卻沒有年度結束日的舊列不擋升版（NOT VALID）', async () => {
    await withIsolatedDatabase({ label: 's02-seeded-upgrade' }, async (db) => {
      await applyMigrations(db, S02_LAST)
      const { userId, legacyId, currentId } = await seedS02Data(db)

      await applyMigration(db, S03_LAST)

      const cohorts = await db.sql(
        `select id, status, year_end_date, group_size_min, group_size_max, proposal_default_days from cohorts order by code`,
      )
      expect(cohorts.rows).toEqual([
        { id: legacyId, status: 'active', year_end_date: null, group_size_min: 5, group_size_max: 5, proposal_default_days: 7 },
        { id: currentId, status: 'preparing', year_end_date: expect.anything(), group_size_min: 5, group_size_max: 5, proposal_default_days: 7 },
      ])
      expect((await db.sql('select open_to_join from user_profiles where user_id = $1', [userId])).rows).toEqual([
        { open_to_join: false },
      ])
      expect(Number((await db.sql('select count(*) as n from cohort_stages')).rows[0]!.n)).toBe(1)

      // 約束是 NOT VALID：舊列留著，但之後的寫入都要檢查。
      const constraint = await db.sql(
        `select convalidated from pg_constraint where conname = 'cohorts_active_year_end_check'
           and connamespace = (select oid from pg_namespace where nspname = $1)`,
        [db.schemaName],
      )
      expect(constraint.rows).toEqual([{ convalidated: false }])
      await expect(
        db.sql(`insert into cohorts (id, code, name, status, created_by_kind) values (gen_random_uuid(), '116', '116', 'active', 'system')`),
      ).rejects.toThrow(/cohorts_active_year_end_check/)

      // 升版後就能直接接新表。
      await db.sql(
        `insert into group_proposals (id, cohort_id, proposer_user_id, group_type, expires_business_at, created_real_at, created_business_at)
         values (gen_random_uuid(), $1, $2, 'general', now(), now(), now())`,
        [currentId, userId],
      )
    })
  })
})

describe('逐欄對照模組 03 附錄 A', () => {
  const EXPECTED_COLUMNS: Record<string, string[]> = {
    group_proposals: [
      'id', 'cohort_id', 'proposer_user_id', 'group_type', 'expires_business_at', 'state', 'termination_kind', 'reason',
      'established_group_id', 'deadline_version', 'revision', 'created_real_at', 'created_business_at',
      'closed_real_at', 'closed_business_at', 'closed_by_kind', 'closed_by_user_id', 'updated_at',
    ],
    proposal_invitations: ['id', 'proposal_id', 'user_id', 'state', 'decided_real_at', 'created_at'],
    proposal_occupancy: ['user_id', 'proposal_id', 'created_at'],
    groups: [
      'id', 'cohort_id', 'code', 'group_type', 'status', 'established_real_at', 'established_business_at',
      'dissolved_real_at', 'dissolve_reason', 'revision', 'created_at', 'created_by_kind', 'created_by_user_id',
      'updated_at', 'updated_by_user_id',
    ],
    group_memberships: [
      'id', 'group_id', 'cohort_id', 'user_id', 'valid_from', 'valid_to', 'added_by_kind', 'added_by_user_id',
      'removal_reason', 'created_at', 'updated_at',
    ],
    group_leaders: ['id', 'group_id', 'user_id', 'valid_from', 'valid_to', 'changed_by_user_id', 'reason', 'created_at'],
  }

  it.each(Object.entries(EXPECTED_COLUMNS))('%s 的欄位與附錄 A 一致', async (table, expected) => {
    await withIsolatedDatabase({ label: `cols-${table}`, setup: migratedSchema }, async (db) => {
      expect(Object.keys(await columnsOf(db, table)).sort()).toEqual([...expected].sort())
    })
  })

  it('例外組已取消（2026-09-24）：groups 沒有 exception_basis', async () => {
    await withIsolatedDatabase({ label: 'no-exception', setup: migratedSchema }, async (db) => {
      expect(Object.keys(await columnsOf(db, 'groups'))).not.toContain('exception_basis')
    })
  })
})

describe('約束反例', () => {
  async function seeded(db: IsolatedDatabase) {
    const users = await db.sql(
      `insert into users (id, name, email, email_verified, updated_at)
       values (gen_random_uuid(), 'U1', 'u1@example.com', false, now()), (gen_random_uuid(), 'U2', 'u2@example.com', false, now())
       returning id`,
    )
    const cohort = await db.sql(
      `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '115-G', '115', 'system') returning id`,
    )
    const cohortId = String(cohort.rows[0]!.id)
    const insertProposal = (patch: { state?: string; kind?: string | null; reason?: string | null; closed?: boolean } = {}) =>
      db.sql(
        `insert into group_proposals
           (id, cohort_id, proposer_user_id, group_type, expires_business_at, state, termination_kind, reason,
            created_real_at, created_business_at, closed_real_at, closed_business_at, closed_by_kind)
         values (gen_random_uuid(), $1, $2, 'general', now(), $3, $4, $5, now(), now(),
                 case when $6 then now() end, case when $6 then now() end, case when $6 then 'system' end)
         returning id`,
        [cohortId, users.rows[0]!.id, patch.state ?? 'open', patch.kind ?? null, patch.reason ?? null, patch.closed ?? false],
      )
    const insertGroup = (code: string) =>
      db.sql(
        `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
         values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
        [cohortId, code],
      )
    return {
      userA: String(users.rows[0]!.id),
      userB: String(users.rows[1]!.id),
      cohortId,
      insertProposal,
      insertGroup,
    }
  }

  it('group_proposals：標了終止就要有終止原因；管理員作廢一定要有理由；成立要指向組別', async () => {
    await withIsolatedDatabase({ label: 'proposal-checks', setup: migratedSchema }, async (db) => {
      const { insertProposal } = await seeded(db)
      await expect(insertProposal({ state: 'terminated', closed: true })).rejects.toThrow(/group_proposals_terminated_kind_check/)
      await expect(insertProposal({ state: 'terminated', kind: 'admin_voided', closed: true })).rejects.toThrow(
        /group_proposals_admin_voided_reason_check/,
      )
      await expect(insertProposal({ state: 'terminated', kind: 'admin_voided', reason: '  ', closed: true })).rejects.toThrow(
        /group_proposals_admin_voided_reason_check/,
      )
      await expect(insertProposal({ state: 'terminated', kind: 'nope', closed: true })).rejects.toThrow(
        /group_proposals_termination_kind_check/,
      )
      await expect(insertProposal({ state: 'established', closed: true })).rejects.toThrow(/group_proposals_established_group_check/)
      await expect(insertProposal({ state: 'open', closed: true })).rejects.toThrow(/group_proposals_closed_check/)
      await expect(insertProposal({ state: 'terminated', kind: 'admin_voided', reason: '名單有誤', closed: true })).resolves.toBeTruthy()
      await expect(insertProposal({ state: 'terminated', kind: 'declined', closed: true })).resolves.toBeTruthy()
    })
  })

  it('proposal_occupancy：一個人同時只能被一份提案占住（主鍵）', async () => {
    await withIsolatedDatabase({ label: 'occupancy-pk', setup: migratedSchema }, async (db) => {
      const { userB, insertProposal } = await seeded(db)
      const p1 = String((await insertProposal()).rows[0]!.id)
      const p2 = String((await insertProposal()).rows[0]!.id)
      await db.sql('insert into proposal_occupancy (user_id, proposal_id) values ($1, $2)', [userB, p1])
      await expect(db.sql('insert into proposal_occupancy (user_id, proposal_id) values ($1, $2)', [userB, p2])).rejects.toThrow(
        /proposal_occupancy_pkey/,
      )
    })
  })

  it('proposal_invitations：同一份提案同一人一列；狀態只收白名單', async () => {
    await withIsolatedDatabase({ label: 'invitation-unique', setup: migratedSchema }, async (db) => {
      const { userB, insertProposal } = await seeded(db)
      const p = String((await insertProposal()).rows[0]!.id)
      const insert = (state = 'pending') =>
        db.sql('insert into proposal_invitations (id, proposal_id, user_id, state) values (gen_random_uuid(), $1, $2, $3)', [p, userB, state])
      await expect(insert('maybe')).rejects.toThrow(/proposal_invitations_state_check/)
      await insert()
      await expect(insert()).rejects.toThrow(/proposal_invitations_proposal_user_unique/)
    })
  })

  it('group_memberships：一人同屆只能有一個有效組；結束後可以再加入別組', async () => {
    await withIsolatedDatabase({ label: 'membership-unique', setup: migratedSchema }, async (db) => {
      const { userB, cohortId, insertGroup } = await seeded(db)
      const g1 = String((await insertGroup('G01')).rows[0]!.id)
      const g2 = String((await insertGroup('G02')).rows[0]!.id)
      const join = (groupId: string) =>
        db.sql(
          `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
           values (gen_random_uuid(), $1, $2, $3, now(), 'system') returning id`,
          [groupId, cohortId, userB],
        )
      const first = String((await join(g1)).rows[0]!.id)
      await expect(join(g2)).rejects.toThrow(/group_memberships_one_active/)
      await db.sql(`update group_memberships set valid_to = now(), removal_reason = '測試' where id = $1`, [first])
      await expect(join(g2)).resolves.toBeTruthy()
    })
  })

  it('group_leaders：一組同時只有一位有效組長', async () => {
    await withIsolatedDatabase({ label: 'leader-unique', setup: migratedSchema }, async (db) => {
      const { userA, userB, insertGroup } = await seeded(db)
      const g = String((await insertGroup('G01')).rows[0]!.id)
      const lead = (userId: string) =>
        db.sql(
          `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id)
           values (gen_random_uuid(), $1, $2, now(), $2)`,
          [g, userId],
        )
      await lead(userA)
      await expect(lead(userB)).rejects.toThrow(/group_leaders_one_active/)
    })
  })

  it('groups：同屆代碼不重複；解散一定有時間與理由', async () => {
    await withIsolatedDatabase({ label: 'group-checks', setup: migratedSchema }, async (db) => {
      const { cohortId, insertGroup } = await seeded(db)
      await insertGroup('G01')
      await expect(insertGroup('G01')).rejects.toThrow(/groups_cohort_code_unique/)
      await expect(
        db.sql(
          `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, dissolved_real_at, created_by_kind)
           values (gen_random_uuid(), $1, 'G02', 'general', 'dissolved', now(), now(), now(), 'system')`,
          [cohortId],
        ),
      ).rejects.toThrow(/groups_dissolved_check/)
    })
  })

  it('cohorts：每組人數最少 ≥ 1、最少 ≤ 最多；提案天數 > 0', async () => {
    await withIsolatedDatabase({ label: 'cohort-grouping', setup: migratedSchema }, async (db) => {
      const insert = (min: number, max: number, days = 7) =>
        db.sql(
          `insert into cohorts (id, code, name, group_size_min, group_size_max, proposal_default_days, created_by_kind)
           values (gen_random_uuid(), gen_random_uuid()::text, 'c', $1, $2, $3, 'system')`,
          [min, max, days],
        )
      await expect(insert(0, 5)).rejects.toThrow(/cohorts_group_size_check/)
      await expect(insert(6, 5)).rejects.toThrow(/cohorts_group_size_check/)
      await expect(insert(5, 5, 0)).rejects.toThrow(/cohorts_proposal_default_days_check/)
      await expect(insert(3, 6, 5)).resolves.toBeTruthy()
    })
  })
})
