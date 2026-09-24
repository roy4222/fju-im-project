import { beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, withIsolatedDatabase, type IsolatedDatabase } from '../../../test/db'
import { applyMigration, applyMigrations, migratedSchema } from '../../../test/migrations'

/**
 * 票 15（S04-01）：第五支 migration（模組 04 附錄 A 六張專題事務表＋模組 05 的收件名單表）。
 *
 * 驗三件事：
 * 1. 兩條升級路徑都通：空庫 S00→S04、以及「已經有組別與提案」的 S03 庫升版。
 * 2. 逐欄對照附錄 A（草稿工作副本的四欄是票 15 補的，註明在 schema/items.ts）。
 * 3. 約束用故意違反的寫入證明，不是只看 constraint 名字。
 */

const S03_LAST = '0004_s03_groups'
const S04_LAST = '0005_s04_items'

const S04_TABLES = [
  'form_schema_versions',
  'item_attachments',
  'item_audience_groups',
  'item_publications',
  'item_versions',
  'managed_items',
  'response_rosters',
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

/** 只跑到 S03 的庫：一位管理員、一屆、一段階段、一個組別與一位組員。 */
async function seedS03Data(db: IsolatedDatabase) {
  const user = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '既有使用者', 'existing-s03@example.com', true, now(), 'active') returning id`,
  )
  const userId = String(user.rows[0]!.id)
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
  const group = await db.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
    [cohortId],
  )
  await db.sql(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
     values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
    [group.rows[0]!.id, cohortId, userId],
  )
  return { userId, cohortId, stageId: String(stage.rows[0]!.id), groupId: String(group.rows[0]!.id) }
}

describe('S03→S04 升級', () => {
  it('空庫：0004 之後三十五張表，套上 0005 長出七張新表', async () => {
    await withIsolatedDatabase({ label: 's03-to-s04' }, async (db) => {
      await applyMigrations(db, S03_LAST)
      const afterS03 = await tableNames(db)
      expect(afterS03).toHaveLength(35)

      await applyMigration(db, S04_LAST)
      const afterS04 = await tableNames(db)
      expect(afterS04).toHaveLength(42)
      expect(afterS04.filter((t) => !afterS03.includes(t))).toEqual(S04_TABLES)
    })
  })

  it('舊表一欄都沒動（只新增表）', async () => {
    await withIsolatedDatabase({ label: 's03-untouched' }, async (db) => {
      await applyMigrations(db, S03_LAST)
      const before: Record<string, Record<string, string>> = {}
      for (const table of await tableNames(db)) before[table] = await columnsOf(db, table)

      await applyMigration(db, S04_LAST)
      for (const [table, columns] of Object.entries(before)) {
        expect(await columnsOf(db, table), `${table} 在 S04 被改動了`).toEqual(columns)
      }
    })
  })

  it('已有組別的庫升版：舊資料原封不動，升版後直接能建項目、指定那個組、建名單', async () => {
    await withIsolatedDatabase({ label: 's03-seeded-upgrade' }, async (db) => {
      await applyMigrations(db, S03_LAST)
      const { userId, cohortId, stageId, groupId } = await seedS03Data(db)

      await applyMigration(db, S04_LAST)

      expect(Number((await db.sql('select count(*) as n from group_memberships')).rows[0]!.n)).toBe(1)
      const item = await db.sql(
        `insert into managed_items
           (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, due_at, title, created_by_kind, created_by_user_id)
         values (gen_random_uuid(), $1, 'submission', 'groups', 'group', $2, now() + interval '7 days', '期中報告', 'user', $3)
         returning id`,
        [cohortId, stageId, userId],
      )
      const itemId = item.rows[0]!.id
      await db.sql('insert into item_audience_groups (item_id, group_id) values ($1, $2)', [itemId, groupId])
      await db.sql(
        `insert into response_rosters
           (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind)
         values (gen_random_uuid(), $1, $2, 'group', $3, now(), 'auto', 'system')`,
        [itemId, cohortId, groupId],
      )
    })
  })
})

describe('逐欄對照模組 04／05 附錄 A', () => {
  const EXPECTED_COLUMNS: Record<string, string[]> = {
    managed_items: [
      'id', 'cohort_id', 'placement', 'audience_kind', 'receiver_unit', 'stage_id', 'status', 'opens_at',
      'actual_opened_at', 'due_at', 'deadline_version', 'current_content_version_id', 'current_schema_version_id',
      'title', 'summary', 'revision', 'created_at', 'created_by_kind', 'created_by_user_id', 'updated_at',
      'updated_by_user_id',
      // 票 15：草稿工作副本（附錄 A 沒定正文放哪；發布時切進 item_versions／form_schema_versions）。
      'body_html', 'cover_file_id', 'category', 'draft_schema',
    ],
    item_audience_groups: ['item_id', 'group_id', 'created_at'],
    item_versions: [
      'id', 'item_id', 'version_no', 'title', 'summary', 'body_html', 'cover_file_id', 'category',
      'created_by_user_id', 'created_at',
    ],
    form_schema_versions: ['id', 'item_id', 'version_no', 'schema', 'created_by_user_id', 'created_at'],
    item_attachments: ['item_id', 'file_id', 'sort', 'created_at'],
    item_publications: [
      'id', 'item_id', 'action', 'content_version_id', 'schema_version_id', 'deadline_version', 'notify',
      'actor_user_id', 'real_at', 'business_at',
    ],
    response_rosters: [
      'id', 'item_id', 'cohort_id', 'receiver_kind', 'receiver_id', 'eligible_from_business_at',
      'eligible_to_business_at', 'source', 'exempt', 'exempt_reason', 'removed_reason', 'revision', 'created_at',
      'created_by_kind', 'created_by_user_id', 'updated_at', 'updated_by_user_id',
    ],
  }

  it.each(Object.entries(EXPECTED_COLUMNS))('%s 的欄位與附錄 A 一致', async (table, expected) => {
    await withIsolatedDatabase({ label: `cols-${table}`, setup: migratedSchema }, async (db) => {
      expect(Object.keys(await columnsOf(db, table)).sort()).toEqual([...expected].sort())
    })
  })
})

describe('約束反例', () => {
  async function seeded(db: IsolatedDatabase) {
    const user = await db.sql(
      `insert into users (id, name, email, email_verified, updated_at)
       values (gen_random_uuid(), 'A1', 'a1@example.com', false, now()) returning id`,
    )
    const userId = String(user.rows[0]!.id)
    const cohort = await db.sql(
      `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '115-I', '115', 'system') returning id`,
    )
    const cohortId = String(cohort.rows[0]!.id)
    const stage = await db.sql(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, 1, '成組期', '2026-09-15', 'system') returning id`,
      [cohortId],
    )
    const stageId = String(stage.rows[0]!.id)
    type ItemPatch = {
      placement?: string
      audience?: string
      unit?: string
      status?: string
      stage?: string | null
      opensAt?: string | null
      dueAt?: string | null
      actualOpenedAt?: string | null
      schema?: string
    }
    const insertItem = (patch: ItemPatch = {}) =>
      db.sql(
        `insert into managed_items
           (id, cohort_id, placement, audience_kind, receiver_unit, status, stage_id, opens_at, due_at, actual_opened_at,
            draft_schema, title, created_by_kind, created_by_user_id)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, '標題', 'user', $11)
         returning id`,
        [
          cohortId,
          patch.placement ?? 'submission',
          patch.audience ?? 'cohort_students',
          patch.unit ?? 'individual',
          patch.status ?? 'draft',
          patch.stage === undefined ? stageId : patch.stage,
          patch.opensAt ?? null,
          patch.dueAt === undefined ? '2026-11-15T15:59:00Z' : patch.dueAt,
          patch.actualOpenedAt ?? null,
          patch.schema ?? '{"fields":[]}',
          userId,
        ],
      )
    /** 替項目補齊兩個目前版本，讓「發布過」的 CHECK 先滿足，才驗得到後面的約束。 */
    const withVersions = async (itemId: unknown) => {
      const content = await db.sql(
        `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
         values (gen_random_uuid(), $1, 1, '標題', '', '', $2) returning id`,
        [itemId, userId],
      )
      const schema = await db.sql(
        `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
         values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
        [itemId, userId],
      )
      await db.sql(
        `update managed_items set current_content_version_id = $2, current_schema_version_id = $3,
                actual_opened_at = '2026-09-20T00:00:00Z'
          where id = $1`,
        [itemId, content.rows[0]!.id, schema.rows[0]!.id],
      )
    }
    return { userId, cohortId, stageId, insertItem, withVersions }
  }

  it('位置、對象、收件單位、狀態都是 CHECK 白名單', async () => {
    await withIsolatedDatabase({ label: 'items-enums', setup: migratedSchema }, async (db) => {
      const { insertItem, withVersions } = await seeded(db)
      await expect(insertItem({ placement: 'blog' })).rejects.toThrow(/managed_items_placement_check/)
      await expect(insertItem({ audience: 'everyone' })).rejects.toThrow(/managed_items_audience_kind_check/)
      await expect(insertItem({ unit: 'team' })).rejects.toThrow(/managed_items_receiver_unit_check/)
      const itemId = (await insertItem()).rows[0]!.id
      await withVersions(itemId)
      await expect(db.sql(`update managed_items set status = 'hidden' where id = $1`, [itemId])).rejects.toThrow(
        /managed_items_status_check/,
      )
    })
  })

  it('收件只能開給本屆學生或指定組別（不開公開、所有登入者、全部老師）', async () => {
    await withIsolatedDatabase({ label: 'items-receiver-audience', setup: migratedSchema }, async (db) => {
      const { insertItem } = await seeded(db)
      for (const audience of ['public', 'signed_in', 'teachers']) {
        await expect(insertItem({ audience })).rejects.toThrow(/managed_items_receiver_audience_check/)
      }
      await expect(insertItem({ audience: 'groups' })).resolves.toBeTruthy()
      // 公告不收件，對象不受限。
      await expect(insertItem({ placement: 'news', unit: 'none', audience: 'public' })).resolves.toBeTruthy()
    })
  })

  it('公告、資源不能設收件單位', async () => {
    await withIsolatedDatabase({ label: 'items-receiver-placement', setup: migratedSchema }, async (db) => {
      const { insertItem } = await seeded(db)
      await expect(insertItem({ placement: 'news' })).rejects.toThrow(/managed_items_receiver_placement_check/)
      await expect(insertItem({ placement: 'resource', unit: 'group' })).rejects.toThrow(
        /managed_items_receiver_placement_check/,
      )
    })
  })

  it('收件草稿可以先存一半；離開草稿就一定要有階段與截止', async () => {
    await withIsolatedDatabase({ label: 'items-schedule', setup: migratedSchema }, async (db) => {
      const { insertItem, withVersions } = await seeded(db)
      const itemId = (await insertItem({ stage: null, dueAt: null })).rows[0]!.id
      await withVersions(itemId)
      await expect(db.sql(`update managed_items set status = 'published' where id = $1`, [itemId])).rejects.toThrow(
        /managed_items_receiver_schedule_check/,
      )
      await db.sql(
        `update managed_items set stage_id = (select id from cohort_stages limit 1), due_at = '2026-11-15T15:59:00Z'
          where id = $1`,
        [itemId],
      )
      await expect(db.sql(`update managed_items set status = 'published' where id = $1`, [itemId])).resolves.toBeTruthy()
    })
  })

  it('截止不得早於開放（同一分鐘可以）', async () => {
    await withIsolatedDatabase({ label: 'items-due-open', setup: migratedSchema }, async (db) => {
      const { insertItem } = await seeded(db)
      await expect(
        insertItem({ opensAt: '2026-11-16T00:00:00Z', dueAt: '2026-11-15T15:59:00Z' }),
      ).rejects.toThrow(/managed_items_due_after_open_check/)
      await expect(
        insertItem({ actualOpenedAt: '2026-11-16T00:00:00Z', dueAt: '2026-11-15T15:59:00Z' }),
      ).rejects.toThrow(/managed_items_due_after_open_check/)
      await expect(insertItem({ opensAt: '2026-11-15T15:59:00Z' })).resolves.toBeTruthy()
    })
  })

  it('發布過就一定有實際開放時間與兩個目前版本', async () => {
    await withIsolatedDatabase({ label: 'items-published', setup: migratedSchema }, async (db) => {
      const { insertItem } = await seeded(db)
      await expect(
        insertItem({ placement: 'news', unit: 'none', status: 'published', actualOpenedAt: '2026-09-01T00:00:00Z' }),
      ).rejects.toThrow(/managed_items_published_check/)
    })
  })

  it('欄位草稿與版本的 schema 都要有 fields 陣列', async () => {
    await withIsolatedDatabase({ label: 'items-schema', setup: migratedSchema }, async (db) => {
      const { userId, insertItem } = await seeded(db)
      await expect(insertItem({ schema: '{"fields":{}}' })).rejects.toThrow(/managed_items_draft_schema_check/)
      const item = await insertItem()
      await expect(
        db.sql(
          `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
           values (gen_random_uuid(), $1, 1, '{}'::jsonb, $2)`,
          [item.rows[0]!.id, userId],
        ),
      ).rejects.toThrow(/form_schema_versions_schema_check/)
    })
  })

  it('內容版本號在項目內唯一', async () => {
    await withIsolatedDatabase({ label: 'items-version-unique', setup: migratedSchema }, async (db) => {
      const { userId, insertItem } = await seeded(db)
      const itemId = (await insertItem()).rows[0]!.id
      const insertVersion = () =>
        db.sql(
          `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
           values (gen_random_uuid(), $1, 1, 't', '', '', $2)`,
          [itemId, userId],
        )
      await insertVersion()
      await expect(insertVersion()).rejects.toThrow(/item_versions_item_version_unique/)
    })
  })

  it('發布紀錄的動作是白名單', async () => {
    await withIsolatedDatabase({ label: 'items-publication-action', setup: migratedSchema }, async (db) => {
      const { userId, insertItem } = await seeded(db)
      const itemId = (await insertItem()).rows[0]!.id
      await expect(
        db.sql(
          `insert into item_publications (id, item_id, action, notify, actor_user_id, real_at, business_at)
           values (gen_random_uuid(), $1, 'delete', false, $2, now(), now())`,
          [itemId, userId],
        ),
      ).rejects.toThrow(/item_publications_action_check/)
    })
  })

  describe('收件名單', () => {
    async function roster(db: IsolatedDatabase) {
      const base = await seeded(db)
      const itemId = String((await base.insertItem()).rows[0]!.id)
      const insert = (patch: { receiverId?: string; exempt?: boolean; exemptReason?: string | null; to?: string | null; removed?: string | null } = {}) =>
        db.sql(
          `insert into response_rosters
             (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, eligible_to_business_at,
              source, exempt, exempt_reason, removed_reason, created_by_kind)
           values (gen_random_uuid(), $1, $2, 'user', $3, '2026-09-20T00:00:00Z', $4, 'auto', $5, $6, $7, 'system')`,
          [
            itemId,
            base.cohortId,
            patch.receiverId ?? base.userId,
            patch.to ?? null,
            patch.exempt ?? false,
            patch.exemptReason ?? null,
            patch.removed ?? null,
          ],
        )
      return { ...base, itemId, insert }
    }

    it('同一個人同時只有一列有效；移出之後可以再加回來（新列）', async () => {
      await withIsolatedDatabase({ label: 'roster-unique', setup: migratedSchema }, async (db) => {
        const { insert } = await roster(db)
        await insert({ to: '2026-09-21T00:00:00Z', removed: '對象變更' })
        await insert()
        await expect(insert()).rejects.toThrow(/response_rosters_one_current/)
      })
    })

    it('免填一定有理由；移出一定同時有結束時間與理由', async () => {
      await withIsolatedDatabase({ label: 'roster-checks', setup: migratedSchema }, async (db) => {
        const { insert } = await roster(db)
        await expect(insert({ exempt: true, exemptReason: '  ' })).rejects.toThrow(/response_rosters_exempt_reason_check/)
        await expect(insert({ to: '2026-09-21T00:00:00Z' })).rejects.toThrow(/response_rosters_removed_check/)
        await expect(insert({ removed: '沒有時間' })).rejects.toThrow(/response_rosters_removed_check/)
        await expect(insert({ to: '2026-09-19T00:00:00Z', removed: '倒退' })).rejects.toThrow(
          /response_rosters_range_check/,
        )
      })
    })
  })
})
