import { beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, poolAsRole, withIsolatedDatabase, type IsolatedDatabase } from '../../../test/db'
import { applyMigration, applyMigrations, migratedSchema } from '../../../test/migrations'

/**
 * 票 25（S11）：第十一支 migration（模組 07 附錄 A 的簽核五表、模組 09 附錄 A 的精選三表）。
 *
 * 驗五件事：
 * 1. 兩條升級路徑都通：空庫 S00→S11、以及「已經有組別、主指導、評分」的 S10 庫升版（舊表一欄不動、舊資料原封不動）。
 * 2. 逐欄對照附錄 A（含本支刻意多記的欄位）。
 * 3. 資料庫的「只有一個」：一組一用途一個簽核包、同包版本號不重複、一人一票、一組一屆一個精選條目。
 * 4. 不可變：版本內容、同意、匯出、精選版本連 owner 都改不動；版本 checksum 一定等於全文的 sha256。
 * 5. 手寫 trigger：最終文件授權一定帶授權範圍、期中結果確認一定不帶；版本狀態新建只能收集中、作廢是終點、
 *    已失效只能再作廢、不能刪；fju_app 也一樣被擋。
 */

const S10_LAST = '0009_s10_grading'
const S11_LAST = '0010_s11_signoff_showcase'
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

/** 一屆、一位老師（主指導）、一位學生、一個組別（S10 就有的東西）。 */
async function seedGroup(db: Pick<IsolatedDatabase, 'sql'>) {
  const suffix = Math.random().toString(36).slice(2)
  const teacher = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '老師', $1, true, now(), 'active') returning id`,
    [`s11-t-${suffix}@example.com`],
  )
  const teacherId = String(teacher.rows[0]!.id)
  const student = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '學生', $1, true, now(), 'active') returning id`,
    [`s11-s-${suffix}@example.com`],
  )
  const studentId = String(student.rows[0]!.id)
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
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, now(), 'system', now(), now())`,
    [groupId, cohortId, studentId],
  )
  await db.sql(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $2, '抽籤結果')`,
    [groupId, teacherId],
  )
  return { teacherId, studentId, cohortId, groupId }
}

type Seeded = Awaited<ReturnType<typeof seedGroup>>

const SCOPE = JSON.stringify({ usages: ['public_showcase'], title: '題目', summaryChecksum: 'a'.repeat(64), assets: [], videoUrl: null })

async function insertPackage(db: Pick<IsolatedDatabase, 'sql'>, g: Seeded, purpose: 'final_document' | 'result_confirmation') {
  const row = await db.sql(
    `insert into signoff_packages (id, group_id, cohort_id, purpose, created_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, $4) returning id`,
    [g.groupId, g.cohortId, purpose, g.teacherId],
  )
  return String(row.rows[0]!.id)
}

async function insertVersion(
  db: Pick<IsolatedDatabase, 'sql'>,
  packageId: string,
  userId: string,
  options: { scope?: string | null; content?: string; checksum?: string } = {},
) {
  const content = options.content ?? '<p>同意書全文</p>'
  const row = await db.sql(
    `insert into signoff_package_versions
       (id, package_id, version_no, content_text, content_checksum, participants, authorization_scope,
        created_by_user_id, created_real_at, created_business_at)
     values (gen_random_uuid(), $1, (select coalesce(max(version_no), 0) + 1 from signoff_package_versions where package_id = $1),
             $2, coalesce($3, encode(sha256(convert_to($2, 'UTF8')), 'hex')), '{"students":[],"advisor":null}'::jsonb, $4::jsonb,
             $5, now(), now())
     returning id`,
    [packageId, content, options.checksum ?? null, options.scope ?? null, userId],
  )
  return String(row.rows[0]!.id)
}

describe('S10→S11 升級', () => {
  it('空庫：0009 之後五十八張表，套上 0010 長出簽核與精選八張新表', async () => {
    await withIsolatedDatabase({ label: 's10-to-s11' }, async (db) => {
      await applyMigrations(db, S10_LAST)
      const afterS10 = await tableNames(db)
      expect(afterS10).toHaveLength(58)

      await applyMigration(db, S11_LAST)
      const afterS11 = await tableNames(db)
      expect(afterS11).toHaveLength(66)
      expect(afterS11.filter((t) => !afterS10.includes(t))).toEqual(S11_TABLES)
    })
  })

  it('已有組別、成員、主指導與評分的庫升版：舊表一欄都沒動、舊資料原封不動，升版後就能建簽核版本與精選草稿', async () => {
    await withIsolatedDatabase({ label: 's10-seeded-upgrade' }, async (db) => {
      await applyMigrations(db, S10_LAST)
      const before: Record<string, Record<string, string>> = {}
      for (const table of await tableNames(db)) before[table] = await columnsOf(db, table)
      const seeded = await seedGroup(db)
      await db.sql(
        `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, '方案', 'system')`,
        [seeded.cohortId],
      )
      const snapshot = async () =>
        (
          await db.sql(
            `select (select row_to_json(g) from groups g where g.id = $1) as grp,
                    (select json_agg(m) from group_memberships m where m.group_id = $1) as members,
                    (select json_agg(a) from advisor_assignments a where a.group_id = $1) as advisors,
                    (select json_agg(s) from grading_schemes s where s.cohort_id = $2) as schemes,
                    (select row_to_json(c) from cohorts c where c.id = $2) as cohort`,
            [seeded.groupId, seeded.cohortId],
          )
        ).rows[0]
      const beforeRows = await snapshot()

      await applyMigration(db, S11_LAST)

      for (const [table, columns] of Object.entries(before)) {
        expect(await columnsOf(db, table), `${table} 在 S11 被改動了`).toEqual(columns)
      }
      expect(await snapshot()).toEqual(beforeRows)
      const packageId = await insertPackage(db, seeded, 'result_confirmation')
      const versionId = await insertVersion(db, packageId, seeded.teacherId)
      await db.sql(`insert into signoff_version_status (version_id, state) values ($1, 'collecting')`, [versionId])
      await db.sql('update signoff_packages set current_version_id = $2 where id = $1', [packageId, versionId])
      const entry = await db.sql(
        `insert into showcase_entries (id, cohort_id, group_id, created_by_user_id) values (gen_random_uuid(), $1, $2, $3) returning id`,
        [seeded.cohortId, seeded.groupId, seeded.teacherId],
      )
      await db.sql(`insert into showcase_drafts (entry_id, summary_checksum) values ($1, $2)`, [
        String(entry.rows[0]!.id),
        'b'.repeat(64),
      ])
    })
  })
})

describe('逐欄對照附錄 A', () => {
  /** 欄位 → 可不可以 NULL。附錄 A 以外多記的欄位在 schema/signoff.ts、schema/showcase.ts 檔頭說明。 */
  const EXPECTED: Record<string, Record<string, 'YES' | 'NO'>> = {
    signoff_packages: {
      id: 'NO', group_id: 'NO', cohort_id: 'NO', purpose: 'NO', current_version_id: 'YES', revision: 'NO',
      created_at: 'NO', created_by_user_id: 'NO', updated_at: 'NO', updated_by_user_id: 'YES',
    },
    signoff_package_versions: {
      id: 'NO', package_id: 'NO', version_no: 'NO', content_text: 'NO', content_checksum: 'NO',
      attachment_file_versions: 'NO', participants: 'NO', supersede_cause: 'YES', authorization_scope: 'YES',
      created_by_user_id: 'NO', created_real_at: 'NO', created_business_at: 'NO',
    },
    signoff_version_status: {
      version_id: 'NO', state: 'NO', cause: 'YES', completed_real_at: 'YES', revision: 'NO',
      created_at: 'NO', updated_at: 'NO', updated_by_user_id: 'YES',
    },
    approvals: {
      id: 'NO', version_id: 'NO', user_id: 'NO', role: 'NO', display_name_at: 'NO', student_no_at: 'YES',
      result: 'NO', reason: 'YES', login_method: 'NO', button_text: 'NO', event_id: 'NO', request_id: 'NO',
      real_at: 'NO', business_at: 'NO',
    },
    signoff_exports: {
      id: 'NO', version_id: 'NO', format: 'NO', file_id: 'NO', exported_by_user_id: 'NO', real_at: 'NO',
    },
    showcase_entries: {
      id: 'NO', cohort_id: 'NO', group_id: 'YES', status: 'NO', current_version_id: 'YES', revision: 'NO',
      created_at: 'NO', created_by_user_id: 'NO', updated_at: 'NO', updated_by_user_id: 'YES',
    },
    showcase_drafts: {
      entry_id: 'NO', title: 'NO', summary: 'NO', summary_checksum: 'NO', video_url: 'YES', poster_file_id: 'YES',
      poster_checksum: 'YES', authorization_kind: 'YES', authorization_ref: 'YES', revision: 'NO',
      created_at: 'NO', updated_at: 'NO', updated_by_user_id: 'YES',
    },
    showcase_versions: {
      id: 'NO', entry_id: 'NO', version_no: 'NO', title: 'NO', summary: 'NO', summary_checksum: 'NO', video_url: 'YES',
      poster_file_id: 'YES', poster_checksum: 'YES', authorization_kind: 'NO', authorization_ref: 'NO', pii_check: 'NO',
      created_by_user_id: 'NO', created_real_at: 'NO',
    },
  }

  it.each(Object.entries(EXPECTED))('%s 的欄位與可否為 NULL 一致', async (table, expected) => {
    await withIsolatedDatabase({ label: `cols-${table}`, setup: migratedSchema }, async (db) => {
      const columns = await columnsOf(db, table)
      expect(Object.keys(columns).sort()).toEqual(Object.keys(expected).sort())
      for (const [name, nullable] of Object.entries(expected)) expect(columns[name], name).toMatch(new RegExp(`/${nullable}$`))
    })
  })

  it('兩個「目前版本」指標都有 FK：簽核包指向版本內容、精選條目指向（S11 還是空的）精選版本', async () => {
    await withIsolatedDatabase({ label: 'current-fk', setup: migratedSchema }, async (db) => {
      const g = await seedGroup(db)
      const packageId = await insertPackage(db, g, 'result_confirmation')
      await expect(
        db.sql('update signoff_packages set current_version_id = gen_random_uuid() where id = $1', [packageId]),
      ).rejects.toThrow(/foreign key/)
      const entry = await db.sql(
        `insert into showcase_entries (id, cohort_id, group_id, created_by_user_id) values (gen_random_uuid(), $1, $2, $3) returning id`,
        [g.cohortId, g.groupId, g.teacherId],
      )
      await expect(
        db.sql('update showcase_entries set current_version_id = gen_random_uuid() where id = $1', [String(entry.rows[0]!.id)]),
      ).rejects.toThrow(/foreign key/)
      expect((await db.sql('select count(*)::int as n from showcase_versions')).rows[0]!.n).toBe(0)
    })
  })
})

describe('資料庫守的「只有一個」', () => {
  it('一組一用途一個簽核包；同包版本號不重複', async () => {
    await withIsolatedDatabase({ label: 'one-package', setup: migratedSchema }, async (db) => {
      const g = await seedGroup(db)
      const packageId = await insertPackage(db, g, 'result_confirmation')
      await insertPackage(db, g, 'final_document')
      await expect(insertPackage(db, g, 'result_confirmation')).rejects.toThrow(/signoff_packages_group_purpose_unique/)
      await db.sql(
        `insert into signoff_package_versions
           (id, package_id, version_no, content_text, content_checksum, participants, created_by_user_id, created_real_at, created_business_at)
         values (gen_random_uuid(), $1, 1, 'a', encode(sha256(convert_to('a', 'UTF8')), 'hex'), '{"students":[]}', $2, now(), now())`,
        [packageId, g.teacherId],
      )
      await expect(
        db.sql(
          `insert into signoff_package_versions
             (id, package_id, version_no, content_text, content_checksum, participants, created_by_user_id, created_real_at, created_business_at)
           values (gen_random_uuid(), $1, 1, 'b', encode(sha256(convert_to('b', 'UTF8')), 'hex'), '{"students":[]}', $2, now(), now())`,
          [packageId, g.teacherId],
        ),
      ).rejects.toThrow(/signoff_package_versions_no_unique/)
    })
  })

  it('一人一票；學生只能同意／不同意、主指導只能同意／退回；不同意與退回一定有理由；老師沒有學號', async () => {
    await withIsolatedDatabase({ label: 'one-vote', setup: migratedSchema }, async (db) => {
      const g = await seedGroup(db)
      const versionId = await insertVersion(db, await insertPackage(db, g, 'result_confirmation'), g.teacherId)
      const event = await db.sql(
        `insert into domain_events (id, type, scope, source_type, source_id, actor_kind, occurred_real_at, occurred_business_at)
         values (gen_random_uuid(), 'test.notification', 'global', 'test', gen_random_uuid(), 'system', now(), now()) returning id`,
      )
      const eventId = String(event.rows[0]!.id)
      const vote = (userId: string, role: string, result: string, reason: string | null, studentNo: string | null) =>
        db.sql(
          `insert into approvals (id, version_id, user_id, role, display_name_at, student_no_at, result, reason, login_method,
                                  button_text, event_id, request_id, real_at, business_at)
           values (gen_random_uuid(), $1, $2, $3, '某人', $4, $5, $6, 'password', '我已閱讀並同意', $7, gen_random_uuid(), now(), now())`,
          [versionId, userId, role, studentNo, result, reason, eventId],
        )
      await vote(g.studentId, 'student', 'agree', null, '411000001')
      await expect(vote(g.studentId, 'student', 'agree', null, '411000001')).rejects.toThrow(/approvals_one_vote/)
      await expect(vote(g.teacherId, 'advisor', 'disagree', '理由', null)).rejects.toThrow(/approvals_result_check/)
      await expect(vote(g.teacherId, 'advisor', 'return', '  ', null)).rejects.toThrow(/approvals_reason_check/)
      await expect(vote(g.teacherId, 'advisor', 'agree', null, '411000002')).rejects.toThrow(/approvals_student_no_check/)
      await vote(g.teacherId, 'advisor', 'return', '請補附件', null)
    })
  })

  it('一組一屆一個精選條目；沒有組別的（歷屆補登）不受限', async () => {
    await withIsolatedDatabase({ label: 'one-entry', setup: migratedSchema }, async (db) => {
      const g = await seedGroup(db)
      const entry = (groupId: string | null) =>
        db.sql(`insert into showcase_entries (id, cohort_id, group_id, created_by_user_id) values (gen_random_uuid(), $1, $2, $3)`, [
          g.cohortId,
          groupId,
          g.teacherId,
        ])
      await entry(g.groupId)
      await expect(entry(g.groupId)).rejects.toThrow(/showcase_entries_one_per_group/)
      await entry(null)
      await entry(null)
    })
  })
})

describe('內容不可變與 checksum', () => {
  it('版本內容連 owner 都改不動、刪不掉；checksum 對不上全文的 sha256 就寫不進去', async () => {
    await withIsolatedDatabase({ label: 'version-immutable', setup: migratedSchema }, async (db) => {
      const g = await seedGroup(db)
      const packageId = await insertPackage(db, g, 'result_confirmation')
      const versionId = await insertVersion(db, packageId, g.teacherId)
      await expect(
        db.sql(`update signoff_package_versions set content_text = '<p>偷改</p>' where id = $1`, [versionId]),
      ).rejects.toThrow(/不可變表/)
      await expect(db.sql('delete from signoff_package_versions where id = $1', [versionId])).rejects.toThrow(/不可變表/)
      await expect(insertVersion(db, packageId, g.teacherId, { checksum: 'c'.repeat(64) })).rejects.toThrow(
        /signoff_package_versions_checksum_check/,
      )
      await expect(insertVersion(db, packageId, g.teacherId, { content: '   ' })).rejects.toThrow(
        /signoff_package_versions_content_check/,
      )
    })
  })

  it('fju_app 也不能改版本內容與精選版本（沒有 UPDATE 權限）', async () => {
    await withIsolatedDatabase({ label: 'version-app', setup: migratedSchema }, async (db) => {
      const g = await seedGroup(db)
      const versionId = await insertVersion(db, await insertPackage(db, g, 'result_confirmation'), g.teacherId)
      const app = await poolAsRole(db, 'fju_app')
      try {
        await expect(
          app.query(`update signoff_package_versions set content_text = 'x' where id = $1`, [versionId]),
        ).rejects.toThrow(/permission denied/)
        await expect(app.query(`update showcase_versions set title = 'x'`)).rejects.toThrow(/permission denied/)
        await expect(app.query('delete from signoff_version_status')).rejects.toThrow(/permission denied/)
      } finally {
        await app.end()
      }
    })
  })
})

describe('授權範圍與用途（手寫 trigger）', () => {
  it('最終文件授權沒帶授權範圍被拒；期中結果確認帶了也被拒；各自對的形狀可以寫', async () => {
    await withIsolatedDatabase({ label: 'scope-guard', setup: migratedSchema }, async (db) => {
      const g = await seedGroup(db)
      const finalPackage = await insertPackage(db, g, 'final_document')
      const midPackage = await insertPackage(db, g, 'result_confirmation')
      await expect(insertVersion(db, finalPackage, g.teacherId)).rejects.toThrow(/一定要帶授權範圍/)
      await expect(insertVersion(db, midPackage, g.teacherId, { scope: SCOPE })).rejects.toThrow(/不帶授權範圍/)
      await insertVersion(db, finalPackage, g.teacherId, { scope: SCOPE })
      await insertVersion(db, midPackage, g.teacherId)
      // fju_app 走同一個 trigger。
      const app = await poolAsRole(db, 'fju_app')
      try {
        await expect(
          app.query(
            `insert into signoff_package_versions
               (id, package_id, version_no, content_text, content_checksum, participants, created_by_user_id, created_real_at, created_business_at)
             values (gen_random_uuid(), $1, 99, 'a', encode(sha256(convert_to('a', 'UTF8')), 'hex'), '{"students":[]}', $2, now(), now())`,
            [finalPackage, g.teacherId],
          ),
        ).rejects.toThrow(/一定要帶授權範圍/)
      } finally {
        await app.end()
      }
    })
  })
})

describe('版本狀態（手寫 trigger）', () => {
  async function seedStatus(db: IsolatedDatabase) {
    const g = await seedGroup(db)
    const versionId = await insertVersion(db, await insertPackage(db, g, 'result_confirmation'), g.teacherId)
    await db.sql(`insert into signoff_version_status (version_id, state) values ($1, 'collecting')`, [versionId])
    return { g, versionId }
  }

  it('新建只能是收集中', async () => {
    await withIsolatedDatabase({ label: 'status-insert', setup: migratedSchema }, async (db) => {
      const g = await seedGroup(db)
      const versionId = await insertVersion(db, await insertPackage(db, g, 'result_confirmation'), g.teacherId)
      await expect(
        db.sql(`insert into signoff_version_status (version_id, state) values ($1, 'complete')`, [versionId]),
      ).rejects.toThrow(/只能是 collecting/)
    })
  })

  it('收集中可以往下走；已失效只能再作廢、不能回來收票；作廢是終點；原因必填', async () => {
    await withIsolatedDatabase({ label: 'status-guard', setup: migratedSchema }, async (db) => {
      const { versionId } = await seedStatus(db)
      await db.sql(`update signoff_version_status set state = 'teacher_pending' where version_id = $1`, [versionId])
      await expect(
        db.sql(`update signoff_version_status set state = 'superseded' where version_id = $1`, [versionId]),
      ).rejects.toThrow(/signoff_version_status_cause_check/)
      await db.sql(`update signoff_version_status set state = 'superseded', cause = 'member_change' where version_id = $1`, [
        versionId,
      ])
      await expect(
        db.sql(`update signoff_version_status set state = 'collecting' where version_id = $1`, [versionId]),
      ).rejects.toThrow(/已失效的簽核版本不能回到/)
      await db.sql(`update signoff_version_status set state = 'void', cause = '測試作廢' where version_id = $1`, [versionId])
      await expect(
        db.sql(`update signoff_version_status set state = 'collecting' where version_id = $1`, [versionId]),
      ).rejects.toThrow(/已作廢/)
      await expect(
        db.sql(`update signoff_version_status set cause = '改理由' where version_id = $1`, [versionId]),
      ).rejects.toThrow(/已作廢/)
    })
  })

  it('完成一定有完成時間；非法狀態被 CHECK 擋；不能刪也不能 truncate', async () => {
    await withIsolatedDatabase({ label: 'status-misc', setup: migratedSchema }, async (db) => {
      const { versionId } = await seedStatus(db)
      await expect(
        db.sql(`update signoff_version_status set state = 'complete' where version_id = $1`, [versionId]),
      ).rejects.toThrow(/signoff_version_status_completed_check/)
      await expect(
        db.sql(`update signoff_version_status set state = 'approved' where version_id = $1`, [versionId]),
      ).rejects.toThrow(/signoff_version_status_state_check/)
      await expect(db.sql('delete from signoff_version_status where version_id = $1', [versionId])).rejects.toThrow(/不可變表/)
      await expect(db.sql('truncate signoff_version_status')).rejects.toThrow(/不可變表|cannot truncate/)
    })
  })

  it('fju_app 改到終點狀態一樣被 trigger 擋', async () => {
    await withIsolatedDatabase({ label: 'status-app', setup: migratedSchema }, async (db) => {
      const { versionId } = await seedStatus(db)
      await db.sql(`update signoff_version_status set state = 'void', cause = '作廢' where version_id = $1`, [versionId])
      const app = await poolAsRole(db, 'fju_app')
      try {
        await expect(
          app.query(`update signoff_version_status set state = 'collecting', cause = null where version_id = $1`, [versionId]),
        ).rejects.toThrow(/已作廢/)
      } finally {
        await app.end()
      }
    })
  })
})

describe('精選草稿的 CHECK', () => {
  it('海報檔與 checksum 成對、授權種類與參照成對、影片連結要是 http(s)、長度上限', async () => {
    await withIsolatedDatabase({ label: 'draft-checks', setup: migratedSchema }, async (db) => {
      const g = await seedGroup(db)
      const entry = await db.sql(
        `insert into showcase_entries (id, cohort_id, group_id, created_by_user_id) values (gen_random_uuid(), $1, $2, $3) returning id`,
        [g.cohortId, g.groupId, g.teacherId],
      )
      const entryId = String(entry.rows[0]!.id)
      await db.sql(`insert into showcase_drafts (entry_id, summary_checksum) values ($1, $2)`, [entryId, 'd'.repeat(64)])
      const update = (set: string, values: unknown[] = []) =>
        db.sql(`update showcase_drafts set ${set} where entry_id = $1`, [entryId, ...values])
      await expect(update(`poster_checksum = 'x'`)).rejects.toThrow(/showcase_drafts_poster_check/)
      await expect(update(`authorization_kind = 'signoff'`)).rejects.toThrow(/showcase_drafts_authorization_check/)
      await expect(update(`video_url = 'javascript:alert(1)'`)).rejects.toThrow(/showcase_drafts_video_url_check/)
      await expect(update(`title = repeat('字', 201)`)).rejects.toThrow(/showcase_drafts_title_check/)
      await expect(update(`summary_checksum = 'nothex'`)).rejects.toThrow(/showcase_drafts_summary_checksum_check/)
      await update(`video_url = 'https://youtu.be/abc', title = '題目', authorization_kind = 'signoff', authorization_ref = gen_random_uuid()`)
    })
  })
})
