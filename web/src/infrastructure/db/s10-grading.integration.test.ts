import { beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, poolAsRole, withIsolatedDatabase, type IsolatedDatabase } from '../../../test/db'
import { applyMigration, applyMigrations, migratedSchema } from '../../../test/migrations'

/**
 * 票 23（S10）：第十支 migration（模組 06 附錄 A 的評分九表）。
 *
 * 驗四件事：
 * 1. 兩條升級路徑都通：空庫 S00→S10、以及「已經有組別、主指導、繳交」的 S07 庫升版（舊表一欄不動、舊資料原封不動）。
 * 2. 逐欄對照附錄 A（含本支刻意多記的欄位）。
 * 3. 資料庫的兩條「只有一個」：同指派一筆採計、同組同階段同老師一筆有效指派。
 * 4. 手寫 trigger：方案版本內容不可改、狀態只前進；評分狀態只走規定的轉換（正式送出的不可改）；
 *    結束的指派不能復活；老師輸入、狀態紀錄、更正三張不可變。
 */

const S07_LAST = '0008_s07_group_submissions'
const S10_LAST = '0009_s10_grading'
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

/** 一屆、一位老師、一個組別（S07 就有的東西）。 */
async function seedGroup(db: IsolatedDatabase) {
  const suffix = Math.random().toString(36).slice(2)
  const user = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '老師', $1, true, now(), 'active') returning id`,
    [`s10-${suffix}@example.com`],
  )
  const teacherId = String(user.rows[0]!.id)
  const cohort = await db.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, '115', 'active', '2027-06-30', 'system') returning id`,
    [`115-${suffix}`],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const group = await db.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
    [cohortId],
  )
  const groupId = String(group.rows[0]!.id)
  await db.sql(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $2, '抽籤結果')`,
    [groupId, teacherId],
  )
  return { teacherId, cohortId, groupId }
}

const STAGES = JSON.stringify([
  { key: 'mid', name: '系統驗收', weight: 60, items: [{ key: 'demo', name: '展示', max: 100, weight: 100, type: 'number' }] },
  { key: 'final', name: '專題發表', weight: 40, items: [{ key: 'talk', name: '發表', max: 100, weight: 100, type: 'number' }] },
])

/** 在 S10 的表上建：方案、已發布版本、一筆有效指派。 */
async function seedGrading(db: Pick<IsolatedDatabase, 'sql'>, g: Awaited<ReturnType<typeof seedGroup>>) {
  const scheme = await db.sql(
    `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, '115 評分方案', 'system') returning id`,
    [g.cohortId],
  )
  const schemeId = String(scheme.rows[0]!.id)
  const version = await db.sql(
    `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, 'published', $3) returning id`,
    [schemeId, STAGES, g.teacherId],
  )
  const versionId = String(version.rows[0]!.id)
  await db.sql('update grading_schemes set current_version_id = $2 where id = $1', [schemeId, versionId])
  const assignment = await db.sql(
    `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
     values (gen_random_uuid(), $1, 'mid', $2, now(), $2) returning id`,
    [g.groupId, g.teacherId],
  )
  return { schemeId, versionId, assignmentId: String(assignment.rows[0]!.id) }
}

async function insertEvaluation(
  db: Pick<IsolatedDatabase, 'sql'>,
  assignmentId: string,
  versionId: string,
  kind: 'draft' | 'final',
): Promise<string> {
  const row = await db.sql(
    `insert into evaluations (id, assignment_id, kind, scheme_version_id, scores, submitted_real_at, submitted_business_at, request_id)
     values (gen_random_uuid(), $1, $2, $3, '{"demo": 80}'::jsonb, now(), now(), gen_random_uuid()) returning id`,
    [assignmentId, kind, versionId],
  )
  return String(row.rows[0]!.id)
}

describe('S07→S10 升級', () => {
  it('空庫：0008 之後四十九張表，套上 0009 長出評分九張新表', async () => {
    await withIsolatedDatabase({ label: 's07-to-s10' }, async (db) => {
      await applyMigrations(db, S07_LAST)
      const afterS07 = await tableNames(db)
      expect(afterS07).toHaveLength(49)

      await applyMigration(db, S10_LAST)
      const afterS10 = await tableNames(db)
      expect(afterS10).toHaveLength(58)
      expect(afterS10.filter((t) => !afterS07.includes(t))).toEqual(S10_TABLES)
    })
  })

  it('已有組別與主指導的庫升版：舊表一欄都沒動、舊資料原封不動，升版後就能建方案與指派', async () => {
    await withIsolatedDatabase({ label: 's07-seeded-upgrade' }, async (db) => {
      await applyMigrations(db, S07_LAST)
      const before: Record<string, Record<string, string>> = {}
      for (const table of await tableNames(db)) before[table] = await columnsOf(db, table)
      const seeded = await seedGroup(db)
      const snapshot = async () =>
        (
          await db.sql(
            `select (select row_to_json(g) from groups g where g.id = $1) as grp,
                    (select json_agg(a) from advisor_assignments a where a.group_id = $1) as advisors,
                    (select row_to_json(c) from cohorts c where c.id = $2) as cohort`,
            [seeded.groupId, seeded.cohortId],
          )
        ).rows[0]
      const beforeRows = await snapshot()

      await applyMigration(db, S10_LAST)

      for (const [table, columns] of Object.entries(before)) {
        expect(await columnsOf(db, table), `${table} 在 S10 被改動了`).toEqual(columns)
      }
      expect(await snapshot()).toEqual(beforeRows)
      const g = await seedGrading(db, seeded)
      const evaluationId = await insertEvaluation(db, g.assignmentId, g.versionId, 'final')
      await db.sql(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [
        evaluationId,
        g.assignmentId,
      ])
    })
  })
})

describe('逐欄對照附錄 A', () => {
  /** 欄位 → 可不可以 NULL。附錄 A 以外多記的欄位在 schema/grading.ts 檔頭說明。 */
  const EXPECTED: Record<string, Record<string, 'YES' | 'NO'>> = {
    grading_schemes: {
      id: 'NO', cohort_id: 'NO', name: 'NO', current_version_id: 'YES', revision: 'NO',
      created_at: 'NO', created_by_kind: 'NO', created_by_user_id: 'YES', updated_at: 'NO', updated_by_user_id: 'YES',
    },
    grading_scheme_versions: {
      id: 'NO', scheme_id: 'NO', version_no: 'NO', stages: 'NO', status: 'NO', locked_at: 'YES',
      created_at: 'NO', created_by_user_id: 'NO',
    },
    stage_requirements: {
      group_id: 'NO', stage_key: 'NO', required_count: 'NO', revision: 'NO',
      created_at: 'NO', created_by_user_id: 'NO', updated_at: 'NO', updated_by_user_id: 'YES',
    },
    evaluator_assignments: {
      id: 'NO', group_id: 'NO', stage_key: 'NO', teacher_user_id: 'NO', valid_from: 'NO', valid_to: 'YES',
      removal_choice: 'YES', reason: 'YES', assigned_by_user_id: 'NO', previous_assignment_id: 'YES',
      ended_real_at: 'YES', ended_by_user_id: 'YES', revision: 'NO', created_at: 'NO', updated_at: 'NO',
    },
    evaluations: {
      id: 'NO', assignment_id: 'NO', kind: 'NO', scheme_version_id: 'NO', scores: 'NO',
      submitted_real_at: 'NO', submitted_business_at: 'NO', request_id: 'NO',
    },
    evaluation_status: {
      evaluation_id: 'NO', assignment_id: 'NO', state: 'NO', revision: 'NO', created_at: 'NO', updated_at: 'NO',
      updated_by_user_id: 'YES',
    },
    evaluation_status_events: {
      id: 'NO', evaluation_id: 'NO', from_state: 'YES', to_state: 'NO', reason: 'YES', actor_kind: 'NO',
      actor_user_id: 'YES', real_at: 'NO',
    },
    grade_overrides: {
      id: 'NO', group_id: 'NO', scheme_version_id: 'NO', original_value: 'NO', new_value: 'NO', basis_hash: 'NO',
      reason: 'NO', actor_user_id: 'NO', real_at: 'NO',
    },
    override_review_state: {
      override_id: 'NO', state: 'NO', resolved_by_user_id: 'YES', resolved_at: 'YES', revision: 'NO', updated_at: 'NO',
    },
  }

  it.each(Object.entries(EXPECTED))('%s 的欄位與可否為 NULL 一致', async (table, expected) => {
    await withIsolatedDatabase({ label: `cols-${table}`, setup: migratedSchema }, async (db) => {
      const columns = await columnsOf(db, table)
      expect(Object.keys(columns).sort()).toEqual(Object.keys(expected).sort())
      for (const [name, nullable] of Object.entries(expected)) expect(columns[name], name).toMatch(new RegExp(`/${nullable}$`))
    })
  })

  it('更正的原值與新值是 numeric(10,4)（decimal，不是浮點）', async () => {
    await withIsolatedDatabase({ label: 'override-numeric', setup: migratedSchema }, async (db) => {
      const rows = await db.sql(
        `select column_name, numeric_precision, numeric_scale from information_schema.columns
         where table_schema = $1 and table_name = 'grade_overrides' and column_name in ('original_value', 'new_value')`,
        [db.schemaName],
      )
      for (const r of rows.rows) expect([r.numeric_precision, r.numeric_scale]).toEqual([10, 4])
    })
  })
})

describe('資料庫守的「只有一個」', () => {
  it('同一個指派只能有一筆採計（部分唯一）；退回之後可以再有一筆', async () => {
    await withIsolatedDatabase({ label: 'one-counted', setup: migratedSchema }, async (db) => {
      const g = await seedGrading(db, await seedGroup(db))
      const first = await insertEvaluation(db, g.assignmentId, g.versionId, 'final')
      const second = await insertEvaluation(db, g.assignmentId, g.versionId, 'final')
      await db.sql(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [first, g.assignmentId])
      await expect(
        db.sql(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [second, g.assignmentId]),
      ).rejects.toMatchObject({ constraint: 'evaluation_status_one_counted' })

      await db.sql(`update evaluation_status set state = 'returned' where evaluation_id = $1`, [first])
      await db.sql(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [second, g.assignmentId])
    })
  })

  it('同組同階段同一位老師只能有一筆有效指派；結束之後可以再指派（插新的一列）', async () => {
    await withIsolatedDatabase({ label: 'one-active-assignment', setup: migratedSchema }, async (db) => {
      const s = await seedGroup(db)
      const g = await seedGrading(db, s)
      const again = () =>
        db.sql(
          `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
           values (gen_random_uuid(), $1, 'mid', $2, now(), $2)`,
          [s.groupId, s.teacherId],
        )
      await expect(again()).rejects.toMatchObject({ constraint: 'evaluator_assignments_one_active' })
      // 別的階段可以。
      await db.sql(
        `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
         values (gen_random_uuid(), $1, 'final', $2, now(), $2)`,
        [s.groupId, s.teacherId],
      )
      await db.sql(
        `update evaluator_assignments set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2, reason = '改由別人評', removal_choice = 'keep'
          where id = $1`,
        [g.assignmentId, s.teacherId],
      )
      await again()
    })
  })

  it('指派結束要有理由；只有結束的指派才有「移除方式」', async () => {
    await withIsolatedDatabase({ label: 'assignment-checks', setup: migratedSchema }, async (db) => {
      const s = await seedGroup(db)
      const g = await seedGrading(db, s)
      await expect(
        db.sql(`update evaluator_assignments set valid_to = now(), ended_real_at = now() where id = $1`, [g.assignmentId]),
      ).rejects.toMatchObject({ constraint: 'evaluator_assignments_ended_check' })
      await expect(db.sql(`update evaluator_assignments set removal_choice = 'keep' where id = $1`, [g.assignmentId])).rejects.toMatchObject({
        constraint: 'evaluator_assignments_ended_check',
      })
      await expect(
        db.sql(
          `update evaluator_assignments set valid_to = now(), ended_real_at = now(), reason = '移除', removal_choice = 'nope' where id = $1`,
          [g.assignmentId],
        ),
      ).rejects.toMatchObject({ constraint: 'evaluator_assignments_removal_choice_check' })
    })
  })

  it('一屆只有一個評分方案；同方案的版本號不重複', async () => {
    await withIsolatedDatabase({ label: 'scheme-unique', setup: migratedSchema }, async (db) => {
      const s = await seedGroup(db)
      const g = await seedGrading(db, s)
      await expect(
        db.sql(`insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, '第二個', 'system')`, [
          s.cohortId,
        ]),
      ).rejects.toMatchObject({ constraint: 'grading_schemes_cohort_unique' })
      await expect(
        db.sql(
          `insert into grading_scheme_versions (id, scheme_id, version_no, stages, created_by_user_id) values (gen_random_uuid(), $1, 1, '[]'::jsonb, $2)`,
          [g.schemeId, s.teacherId],
        ),
      ).rejects.toMatchObject({ constraint: 'grading_scheme_versions_no_unique' })
    })
  })
})

describe('手寫 trigger', () => {
  it('方案版本：內容連 owner 都改不動；狀態只能往前（published→locked 可以，locked→published 不行）；不能刪', async () => {
    await withIsolatedDatabase({ label: 'version-guard', setup: migratedSchema }, async (db) => {
      const g = await seedGrading(db, await seedGroup(db))
      await expect(db.sql(`update grading_scheme_versions set stages = '[]'::jsonb where id = $1`, [g.versionId])).rejects.toThrow(
        /內容寫了就不能改/,
      )
      await expect(db.sql(`update grading_scheme_versions set status = 'draft' where id = $1`, [g.versionId])).rejects.toThrow(/只能往前/)
      await db.sql(`update grading_scheme_versions set status = 'locked', locked_at = now() where id = $1`, [g.versionId])
      await expect(
        db.sql(`update grading_scheme_versions set status = 'published', locked_at = null where id = $1`, [g.versionId]),
      ).rejects.toThrow(/只能往前/)
      await expect(db.sql(`update grading_scheme_versions set locked_at = now() - interval '1 day' where id = $1`, [g.versionId])).rejects.toThrow(
        /已鎖定/,
      )
      await expect(db.sql(`delete from grading_scheme_versions where id = $1`, [g.versionId])).rejects.toThrow(/不可變/)
      // 鎖定一定要有時間、有時間一定是鎖定（CHECK）。
      await expect(
        db.sql(
          `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id)
           values (gen_random_uuid(), $1, 9, '[]'::jsonb, 'locked', (select created_by_user_id from grading_scheme_versions where id = $2))`,
          [g.schemeId, g.versionId],
        ),
      ).rejects.toMatchObject({ constraint: 'grading_scheme_versions_locked_at_check' })
    })
  })

  it('評分狀態：新建要和輸入種類對得上；正式送出（counted）不能改回暫存；暫存不能變採計', async () => {
    await withIsolatedDatabase({ label: 'status-guard', setup: migratedSchema }, async (db) => {
      const g = await seedGrading(db, await seedGroup(db))
      const draft = await insertEvaluation(db, g.assignmentId, g.versionId, 'draft')
      const final = await insertEvaluation(db, g.assignmentId, g.versionId, 'final')
      await expect(
        db.sql(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [draft, g.assignmentId]),
      ).rejects.toThrow(/新建時只能是/)
      await expect(
        db.sql(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'draft')`, [final, g.assignmentId]),
      ).rejects.toThrow(/新建時只能是/)

      await db.sql(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'draft')`, [draft, g.assignmentId])
      await db.sql(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [final, g.assignmentId])
      await expect(db.sql(`update evaluation_status set state = 'counted' where evaluation_id = $1`, [draft])).rejects.toThrow(/不能從 draft 改成 counted/)
      await expect(db.sql(`update evaluation_status set state = 'draft' where evaluation_id = $1`, [final])).rejects.toThrow(/不能從 counted 改成 draft/)
      await expect(db.sql(`delete from evaluation_status where evaluation_id = $1`, [final])).rejects.toThrow(/不可變/)
      // 退回是終點。
      await db.sql(`update evaluation_status set state = 'returned' where evaluation_id = $1`, [final])
      await expect(db.sql(`update evaluation_status set state = 'counted' where evaluation_id = $1`, [final])).rejects.toThrow(
        /不能從 returned 改成 counted/,
      )
    })
  })

  it('評分狀態的指派要和輸入一致', async () => {
    await withIsolatedDatabase({ label: 'status-assignment', setup: migratedSchema }, async (db) => {
      const s = await seedGroup(db)
      const g = await seedGrading(db, s)
      const other = await db.sql(
        `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
         values (gen_random_uuid(), $1, 'final', $2, now(), $2) returning id`,
        [s.groupId, s.teacherId],
      )
      const final = await insertEvaluation(db, g.assignmentId, g.versionId, 'final')
      await expect(
        db.sql(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [final, other.rows[0]!.id]),
      ).rejects.toThrow(/指派要和那筆老師輸入一致/)
    })
  })

  it('結束的指派不能復活，也不能改結束資訊；指派的組別、老師寫了就不動', async () => {
    await withIsolatedDatabase({ label: 'assignment-guard', setup: migratedSchema }, async (db) => {
      const s = await seedGroup(db)
      const g = await seedGrading(db, s)
      await expect(db.sql(`update evaluator_assignments set stage_key = 'final' where id = $1`, [g.assignmentId])).rejects.toThrow(/寫了就不能改/)
      await db.sql(
        `update evaluator_assignments set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2, reason = '移除' where id = $1`,
        [g.assignmentId, s.teacherId],
      )
      await expect(
        db.sql(`update evaluator_assignments set valid_to = null, ended_real_at = null, ended_by_user_id = null, reason = null where id = $1`, [
          g.assignmentId,
        ]),
      ).rejects.toThrow(/不能改或復活/)
      await expect(db.sql(`delete from evaluator_assignments where id = $1`, [g.assignmentId])).rejects.toThrow(/不可變/)
    })
  })

  it('fju_app：老師輸入只能插、不能改刪；方案版本的內容欄不給改；正式送出的狀態改回暫存被 trigger 擋', async () => {
    await withIsolatedDatabase({ label: 's10-app-role', setup: migratedSchema }, async (db) => {
      const g = await seedGrading(db, await seedGroup(db))
      const app = await poolAsRole(db, 'fju_app')
      try {
        const inserted = await app.query(
          `insert into evaluations (id, assignment_id, kind, scheme_version_id, scores, submitted_real_at, submitted_business_at, request_id)
           values (gen_random_uuid(), $1, 'final', $2, '{"demo": 90}'::jsonb, now(), now(), gen_random_uuid()) returning id`,
          [g.assignmentId, g.versionId],
        )
        const id = inserted.rows[0]!.id as string
        await app.query(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [id, g.assignmentId])
        await expect(app.query(`update evaluations set scores = '{"demo": 100}'::jsonb`)).rejects.toMatchObject({ code: '42501' })
        await expect(app.query('delete from evaluations')).rejects.toMatchObject({ code: '42501' })
        await expect(app.query(`update grading_scheme_versions set stages = '[]'::jsonb`)).rejects.toMatchObject({ code: '42501' })
        await expect(app.query(`update evaluation_status set state = 'draft' where evaluation_id = $1`, [id])).rejects.toThrow(/不能從 counted/)
        await expect(app.query(`update evaluation_status set assignment_id = assignment_id`)).rejects.toMatchObject({ code: '42501' })
      } finally {
        await app.end()
      }
      await expect(db.sql(`update evaluations set scores = '{}'::jsonb`)).rejects.toThrow(/不可變/)
    })
  })
})
