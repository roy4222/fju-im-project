import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { PERMISSION_MATRIX, updatableColumns } from '@/infrastructure/db/permissions/matrix'

/**
 * S00-05：逐表權限矩陣與不可變資料保護（契約 01 §5）。
 *
 * 測試是**矩陣驅動**的：直接讀 `permissions/matrix.json`，對每一張表的每一格
 * 同時驗「該准的准」與「該擋的擋」。契約 01 §5 明寫只測禁止不算通過；
 * 反過來也一樣——只測允許的話，多給一個 DELETE 也不會有人發現（review R7）。
 *
 * 新增表要在 matrix.json 補一列，並在下面的 SAMPLES 補一個樣本列，否則測試會直接紅。
 */

let owner: IsolatedDatabase
let app: Pool
let backup: Pool
let userId: string
let cohortId: string
let eventId: string

/**
 * 每張表的樣本資料：怎麼插一列、改哪一欄是「允許的」、改哪一欄是「不該被允許的」。
 * `insert` 回傳的 SQL 必須是合法的一列（含 FK 與 CHECK）。
 */
type Sample = {
  insert: () => { sql: string; values: unknown[] }
  /** 不可變 trigger 的測試要挑一欄來改；UPDATE 權限本身是逐欄自動驗的，不靠這個。 */
  updatable: { column: string; value: unknown }
  /** 刪除用的條件；矩陣說不給 DELETE 的表也要能組出語句，才驗得到拒絕。 */
  deleteWhere?: string
}

let uniqueCounter = 0
const unique = (prefix: string) => `${prefix}-${Date.now()}-${(uniqueCounter += 1)}`

const SAMPLES: Record<string, Sample> = {
  users: {
    insert: () => ({
      sql: `insert into users (id, name, email, email_verified, updated_at)
            values (gen_random_uuid(), 'app 建的', $1, false, now())`,
      values: [`${unique('u')}@example.com`],
    }),
    updatable: { column: 'name', value: '改過的名字' },
  },
  accounts: {
    insert: () => ({
      sql: `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
            values (gen_random_uuid(), $1, 'credential', $2, now(), now())`,
      values: [unique('acct'), userId],
    }),
    updatable: { column: 'scope', value: 'openid email' },
  },
  sessions: {
    insert: () => ({
      sql: `insert into sessions (id, expires_at, token, updated_at, user_id, login_method)
            values (gen_random_uuid(), now() + interval '1 day', $1, now(), $2, 'password')`,
      values: [unique('token'), userId],
    }),
    updatable: { column: 'login_method', value: 'google' },
    deleteWhere: 'true',
  },
  verifications: {
    insert: () => ({
      sql: `insert into verifications (id, identifier, value, expires_at, created_at, updated_at)
            values (gen_random_uuid(), $1, 'code', now() + interval '1 hour', now(), now())`,
      values: [unique('ident')],
    }),
    updatable: { column: 'value', value: 'newcode' },
    deleteWhere: 'true',
  },
  cohorts: {
    insert: () => ({
      sql: `insert into cohorts (id, code, name, created_by_kind)
            values (gen_random_uuid(), $1, 'app 建的屆別', 'system')`,
      values: [unique('cohort')],
    }),
    updatable: { column: 'name', value: '改過的屆別' },
  },
  schema_meta: {
    insert: () => ({ sql: `insert into schema_meta (key, value) values ($1, 'x')`, values: [unique('k')] }),
    updatable: { column: 'value', value: 'tampered' },
  },
  audit_events: {
    insert: () => ({
      sql: `insert into audit_events (id, actor_kind, actor_user_id, action, target_type, scope, cohort_id, real_at, business_at)
            values (gen_random_uuid(), 'user', $1, 'account.approve', 'user', 'cohort', $2, now(), now())`,
      values: [userId, cohortId],
    }),
    updatable: { column: 'action', value: 'tampered' },
  },
  operation_records: {
    insert: () => ({
      sql: `insert into operation_records
              (id, actor_user_id, operation_kind, request_id, fingerprint, state, scope, committed_real_at, receipt_expires_at)
            values (gen_random_uuid(), $1, 'account.approve', gen_random_uuid(), 'fp', 'committed', 'global', now(), now() + interval '30 days')`,
      values: [userId],
    }),
    updatable: { column: 'state', value: 'failed' },
  },
  domain_events: {
    insert: () => ({
      sql: `insert into domain_events (id, type, scope, source_type, source_id, actor_kind, occurred_real_at, occurred_business_at)
            values (gen_random_uuid(), 'test.created', 'global', 'item', gen_random_uuid(), 'system', now(), now())`,
      values: [],
    }),
    updatable: { column: 'type', value: 'tampered' },
  },
  event_projections: {
    insert: () => ({
      sql: `insert into event_projections (event_id, consumer) values ($1, 'digest')`,
      values: [eventId],
    }),
    updatable: { column: 'state', value: 'done' },
  },
  due_work: {
    insert: () => ({
      sql: `insert into due_work (id, kind, subject_type, subject_id, deadline_version, due_business_at)
            values (gen_random_uuid(), 'receipt_purge', 'item', gen_random_uuid(), $1, now())`,
      values: [(uniqueCounter += 1)],
    }),
    updatable: { column: 'state', value: 'done' },
  },
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'roles', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  backup = await poolAsRole(owner, 'fju_backup')

  const user = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at)
     values (gen_random_uuid(), '測試', 'roles@example.com', false, now()) returning id`,
  )
  userId = String(user.rows[0]!.id)
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '115-R', '115 角色', 'system') returning id`,
  )
  cohortId = String(cohort.rows[0]!.id)
  const event = await owner.sql(
    `insert into domain_events (id, type, scope, source_type, source_id, actor_kind, occurred_real_at, occurred_business_at)
     values (gen_random_uuid(), 'test.seed', 'global', 'item', gen_random_uuid(), 'system', now(), now()) returning id`,
  )
  eventId = String(event.rows[0]!.id)
})

afterAll(async () => {
  await app?.end()
  await backup?.end()
  await owner?.close()
})

/** 這張表在測試 schema 裡實際有哪些欄位。 */
async function tableColumns(table: string): Promise<string[]> {
  const rows = await owner.sql(
    `select column_name from information_schema.columns
     where table_schema = $1 and table_name = $2 order by ordinal_position`,
    [owner.schemaName, table],
  )
  return rows.rows.map((r) => String(r.column_name))
}

async function expectDenied(pool: Pool, sql: string, values: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, values as never[])
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`這個操作應該被拒絕但成功了：${sql}`)
}

describe('矩陣與樣本資料同步', () => {
  it('每一張表都有樣本列（新增表沒補就紅）', () => {
    for (const row of PERMISSION_MATRIX) {
      expect(SAMPLES[row.table], `matrix.json 有 ${row.table} 但 SAMPLES 沒有`).toBeTruthy()
    }
    for (const table of Object.keys(SAMPLES)) {
      expect(
        PERMISSION_MATRIX.some((row) => row.table === table),
        `SAMPLES 有 ${table} 但 matrix.json 沒有`,
      ).toBe(true)
    }
  })

  it('矩陣白名單裡的欄位都真的存在（抓 matrix.json 的錯字）', async () => {
    for (const row of PERMISSION_MATRIX) {
      const allowed = updatableColumns(row)
      if (allowed === null || allowed.length === 0) continue
      const columns = await tableColumns(row.table)
      for (const column of allowed) {
        expect(columns, `matrix.json 的 ${row.table}.${column} 在資料表裡不存在`).toContain(column)
      }
    }
  })
})

// 逐表逐格：該准的准、該擋的擋。
describe.each(PERMISSION_MATRIX.map((row) => [row.table, row] as const))('fju_app × %s', (table, row) => {
  const sample = () => SAMPLES[table]!

  it(`SELECT ${row.select ? '允許' : '拒絕'}`, async () => {
    if (row.select) {
      await expect(app.query(`select count(*) from ${table}`)).resolves.toBeTruthy()
    } else {
      expect(await expectDenied(app, `select count(*) from ${table}`)).toMatch(/permission denied/i)
    }
  })

  it(`INSERT ${row.insert ? '允許' : '拒絕'}`, async () => {
    const { sql, values } = sample().insert()
    if (row.insert) {
      await expect(app.query(sql, values as never[])).resolves.toBeTruthy()
    } else {
      expect(await expectDenied(app, sql, values)).toMatch(/permission denied/i)
    }
  })

  it(`UPDATE 逐欄驗證（矩陣：${Array.isArray(row.update) ? row.update.join('／') : row.update}）`, async () => {
    const columns = await tableColumns(table)
    expect(columns.length, `${table} 讀不到欄位`).toBeGreaterThan(0)
    const allowed = updatableColumns(row)

    // `set col = col where false` 只驗權限：不改任何資料，也不會撞到 CHECK 或 NOT NULL，
    // 但 PostgreSQL 一樣會做欄級權限檢查。這樣才能**每一欄都驗**，不是抽一欄代表全部。
    const problems: string[] = []
    for (const column of columns) {
      const shouldBeAllowed = allowed === null || allowed.includes(column)
      try {
        await app.query(`update ${table} set "${column}" = "${column}" where false`)
        if (!shouldBeAllowed) problems.push(`${column}：矩陣沒給 UPDATE，卻改得動`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (shouldBeAllowed) {
          problems.push(`${column}：矩陣有給 UPDATE，卻被拒（${message}）`)
        } else if (!/permission denied/i.test(message)) {
          problems.push(`${column}：被拒但理由不是權限（${message}）`)
        }
      }
    }
    expect(problems, `${table} 的欄級 UPDATE 權限與矩陣不符`).toEqual([])
  })

  it(`DELETE ${row.delete ? '允許' : '拒絕'}`, async () => {
    const statement = `delete from ${table} where ${sample().deleteWhere ?? 'false'}`
    if (row.delete) {
      await expect(app.query(statement)).resolves.toBeTruthy()
    } else {
      expect(await expectDenied(app, statement)).toMatch(/permission denied/i)
    }
  })

  it('TRUNCATE 與 DDL 一律拒絕', async () => {
    expect(await expectDenied(app, `truncate ${table}`)).toMatch(/permission denied|must be owner/i)
    expect(await expectDenied(app, `alter table ${table} add column hacked text`)).toMatch(
      /permission denied|must be owner/i,
    )
    expect(await expectDenied(app, `drop table ${table}`)).toMatch(/permission denied|must be owner/i)
  })
})

describe('fju_app 的整體限制', () => {
  it('不能 SET ROLE fju_owner', async () => {
    expect(await expectDenied(app, 'set role fju_owner')).toMatch(/permission denied|is not a member/i)
  })

  it('不能在 schema 裡建東西', async () => {
    expect(await expectDenied(app, 'create table sneaky (id int)')).toMatch(/permission denied/i)
  })
})

const immutableTables = PERMISSION_MATRIX.filter((row) => row.immutable)

describe.each(immutableTables.map((row) => [row.table] as const))(
  '不可變表的第二層：%s 的 trigger',
  (table) => {
    it('連 owner 自己都改不動、刪不掉', async () => {
      await expect(owner.sql(`update ${table} set ${SAMPLES[table]!.updatable.column} = 'tampered'`)).rejects.toThrow(
        /不可變表/,
      )
      await expect(owner.sql(`delete from ${table}`)).rejects.toThrow(/不可變表/)
    })

    it('TRUNCATE 也擋得住', async () => {
      // domain_events 會先撞到 event_projections 的 FK（PostgreSQL 在 statement trigger 之前就擋），
      // 兩種理由都算通過——重點是 truncate 不了。
      await expect(owner.sql(`truncate ${table}`)).rejects.toThrow(
        /不可變表|cannot truncate a table referenced in a foreign key constraint/,
      )
    })

    it('INSERT 仍然可以（不可變是「寫了就不能改」，不是「不能寫」）', async () => {
      const { sql, values } = SAMPLES[table]!.insert()
      await expect(owner.sql(sql, values)).resolves.toBeTruthy()
    })

    it('掛著 row 與 statement 兩個 trigger', async () => {
      const triggers = await owner.sql(
        `select t.tgname from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relname = $2 and not t.tgisinternal
         order by t.tgname`,
        [owner.schemaName, table],
      )
      expect(triggers.rows.map((r) => String(r.tgname))).toEqual([
        `${table}_immutable_row`,
        `${table}_immutable_truncate`,
      ])
    })
  },
)

describe('可變表不該掛不可變 trigger', () => {
  it('只有矩陣標 immutable 的表有 trigger', async () => {
    const triggers = await owner.sql(
      `select c.relname from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and not t.tgisinternal
       group by c.relname order by c.relname`,
      [owner.schemaName],
    )
    expect(triggers.rows.map((r) => String(r.relname))).toEqual(immutableTables.map((row) => row.table).sort())
  })
})

describe('fju_backup：讀全庫，不能寫', () => {
  it.each(PERMISSION_MATRIX.map((row) => [row.table] as const))('%s 讀得到', async (table) => {
    await expect(backup.query(`select count(*) from ${table}`)).resolves.toBeTruthy()
  })

  it.each(PERMISSION_MATRIX.map((row) => [row.table] as const))('%s 寫不進去', async (table) => {
    const { sql, values } = SAMPLES[table]!.insert()
    expect(await expectDenied(backup, sql, values)).toMatch(/permission denied/i)
    expect(
      await expectDenied(backup, `update ${table} set ${SAMPLES[table]!.updatable.column} = $1`, ['x']),
    ).toMatch(/permission denied/i)
  })
})
