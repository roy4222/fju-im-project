import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * S00-05：逐表權限矩陣與不可變資料保護（契約 01 §5）。
 *
 * 契約明寫「只測『禁止操作被拒』不算通過」，所以每一張表都同時測
 * 「該給的操作做得到」與「沒給的操作被拒」。
 */

let owner: IsolatedDatabase
let app: Pool
let backup: Pool
let userId: string
let cohortId: string
let eventId: string

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'roles', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  backup = await poolAsRole(owner, 'fju_backup')

  // 用 owner 準備幾筆 FK 目標，讓後面的測試不必互相依賴。
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
     values (gen_random_uuid(), 'test.created', 'global', 'item', gen_random_uuid(), 'system', now(), now()) returning id`,
  )
  eventId = String(event.rows[0]!.id)
})

afterAll(async () => {
  await app?.end()
  await backup?.end()
  await owner?.close()
})

/** 期待這個操作被 PostgreSQL 拒絕（權限不足或 trigger 擋下）。 */
async function expectDenied(pool: Pool, sql: string, values: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, values as never[])
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`這個操作應該被拒絕但成功了：${sql}`)
}

describe('fju_app：契約 01 §5 矩陣裡「有給」的操作做得到', () => {
  it('users S I U', async () => {
    await expect(app.query('select id from users')).resolves.toBeTruthy()
    const inserted = await app.query(
      `insert into users (id, name, email, email_verified, updated_at)
       values (gen_random_uuid(), 'app 建的', 'app@example.com', false, now()) returning id`,
    )
    expect(inserted.rowCount).toBe(1)
    await expect(app.query("update users set name = '改過' where id = $1", [userId])).resolves.toBeTruthy()
  })

  it('sessions S I U D', async () => {
    const session = await app.query(
      `insert into sessions (id, expires_at, token, updated_at, user_id, login_method)
       values (gen_random_uuid(), now() + interval '1 day', $1, now(), $2, 'password') returning id`,
      [`token-${Date.now()}`, userId],
    )
    const sessionId = session.rows[0].id
    await expect(app.query('select * from sessions where id = $1', [sessionId])).resolves.toBeTruthy()
    await expect(
      app.query("update sessions set login_method = 'google' where id = $1", [sessionId]),
    ).resolves.toBeTruthy()
    await expect(app.query('delete from sessions where id = $1', [sessionId])).resolves.toBeTruthy()
  })

  it('cohorts S I U', async () => {
    const cohort = await app.query(
      `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, 'app 建的', 'system') returning id`,
      [`116-${Date.now()}`],
    )
    await expect(
      app.query("update cohorts set status = 'active' where id = $1", [cohort.rows[0].id]),
    ).resolves.toBeTruthy()
  })

  it('audit_events S I（不可變，但要寫得進去）', async () => {
    const inserted = await app.query(
      `insert into audit_events (id, actor_kind, actor_user_id, action, target_type, scope, cohort_id, real_at, business_at)
       values (gen_random_uuid(), 'user', $1, 'account.approve', 'user', 'cohort', $2, now(), now()) returning id`,
      [userId, cohortId],
    )
    expect(inserted.rowCount).toBe(1)
    await expect(app.query('select count(*) from audit_events')).resolves.toBeTruthy()
  })

  it('operation_records：允許的四個欄位改得動', async () => {
    const record = await app.query(
      `insert into operation_records
         (id, actor_user_id, operation_kind, request_id, fingerprint, state, scope, committed_real_at, receipt_expires_at)
       values (gen_random_uuid(), $1, 'account.approve', gen_random_uuid(), 'fp', 'committed', 'global', now(), now() + interval '30 days')
       returning id`,
      [userId],
    )
    const id = record.rows[0].id
    // receipt_purge 會做的事。
    await expect(app.query('update operation_records set receipt = null where id = $1', [id])).resolves.toBeTruthy()
    await expect(
      app.query("update operation_records set state = 'failed', result_ref = '{}'::jsonb where id = $1", [id]),
    ).resolves.toBeTruthy()
  })

  it('event_projections 與 due_work S I U', async () => {
    await app.query(
      `insert into event_projections (event_id, consumer) values ($1, 'notifications')`,
      [eventId],
    )
    await expect(
      app.query("update event_projections set state = 'done', done_at = now() where event_id = $1", [eventId]),
    ).resolves.toBeTruthy()

    const work = await app.query(
      `insert into due_work (id, kind, subject_type, subject_id, due_business_at)
       values (gen_random_uuid(), 'receipt_purge', 'item', gen_random_uuid(), now()) returning id`,
    )
    await expect(
      app.query("update due_work set state = 'done' where id = $1", [work.rows[0].id]),
    ).resolves.toBeTruthy()
  })

  it('schema_meta 只有 S', async () => {
    await expect(app.query('select value from schema_meta')).resolves.toBeTruthy()
  })
})

describe('fju_app：矩陣裡「沒給」的操作要被拒', () => {
  it('schema_meta 不能寫（只有 migrate 能寫）', async () => {
    expect(await expectDenied(app, "insert into schema_meta (key, value) values ('x', 'y')")).toMatch(
      /permission denied/i,
    )
    expect(await expectDenied(app, "update schema_meta set value = 'x' where key = 'schema_version'")).toMatch(
      /permission denied/i,
    )
  })

  it('audit_events 不能 UPDATE／DELETE（先被權限擋）', async () => {
    expect(await expectDenied(app, "update audit_events set action = 'tampered'")).toMatch(/permission denied/i)
    expect(await expectDenied(app, 'delete from audit_events')).toMatch(/permission denied/i)
  })

  it('domain_events 不能 UPDATE／DELETE', async () => {
    expect(await expectDenied(app, "update domain_events set type = 'tampered'")).toMatch(/permission denied/i)
    expect(await expectDenied(app, 'delete from domain_events')).toMatch(/permission denied/i)
  })

  it('operation_records 不能改沒列在矩陣裡的欄位', async () => {
    expect(await expectDenied(app, "update operation_records set fingerprint = 'tampered'")).toMatch(
      /permission denied/i,
    )
    expect(await expectDenied(app, 'update operation_records set actor_user_id = gen_random_uuid()')).toMatch(
      /permission denied/i,
    )
  })

  it('users、accounts、cohorts 不能 DELETE（使用者列永不硬刪）', async () => {
    expect(await expectDenied(app, 'delete from users')).toMatch(/permission denied/i)
    expect(await expectDenied(app, 'delete from accounts')).toMatch(/permission denied/i)
    expect(await expectDenied(app, 'delete from cohorts')).toMatch(/permission denied/i)
  })

  it('所有表都不能 TRUNCATE，也不能下 DDL', async () => {
    expect(await expectDenied(app, 'truncate users')).toMatch(/permission denied|must be owner/i)
    expect(await expectDenied(app, 'alter table users add column hacked text')).toMatch(
      /permission denied|must be owner/i,
    )
    expect(await expectDenied(app, 'create table sneaky (id int)')).toMatch(/permission denied/i)
    expect(await expectDenied(app, 'drop table due_work')).toMatch(/permission denied|must be owner/i)
  })

  it('fju_app 不能 SET ROLE fju_owner', async () => {
    expect(await expectDenied(app, 'set role fju_owner')).toMatch(/permission denied|is not a member/i)
  })
})

describe('不可變表的第二層：trigger', () => {
  it('連 owner 自己想改 audit_events 也會被 trigger 擋下', async () => {
    await owner.sql(
      `insert into audit_events (id, actor_kind, action, target_type, scope, real_at, business_at)
       values (gen_random_uuid(), 'system', 'seed', 'user', 'global', now(), now())`,
    )
    await expect(owner.sql("update audit_events set action = 'tampered'")).rejects.toThrow(/不可變表/)
    await expect(owner.sql('delete from audit_events')).rejects.toThrow(/不可變表/)
    await expect(owner.sql('truncate audit_events')).rejects.toThrow(/不可變表/)
  })

  it('domain_events 同樣擋下 UPDATE、DELETE、TRUNCATE', async () => {
    await expect(owner.sql("update domain_events set type = 'tampered'")).rejects.toThrow(/不可變表/)
    await expect(owner.sql('delete from domain_events')).rejects.toThrow(/不可變表/)
    // TRUNCATE 會先撞到 event_projections 的 FK（PostgreSQL 在 statement trigger 之前就擋），
    // 所以這裡兩種理由都算通過——重點是「truncate 不了」。
    await expect(owner.sql('truncate domain_events')).rejects.toThrow(
      /不可變表|cannot truncate a table referenced in a foreign key constraint/,
    )
  })

  it('兩張不可變表都掛著 row 與 statement 兩個 trigger', async () => {
    const triggers = await owner.sql(
      `select c.relname as table_name, t.tgname
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and not t.tgisinternal
       order by 1, 2`,
      [owner.schemaName],
    )
    expect(triggers.rows.map((r) => `${r.table_name}.${r.tgname}`)).toEqual([
      'audit_events.audit_events_immutable_row',
      'audit_events.audit_events_immutable_truncate',
      'domain_events.domain_events_immutable_row',
      'domain_events.domain_events_immutable_truncate',
    ])
  })

  it('但 INSERT 仍然可以（不可變是「寫了就不能改」，不是「不能寫」）', async () => {
    const inserted = await owner.sql(
      `insert into domain_events (id, type, scope, source_type, source_id, actor_kind, occurred_real_at, occurred_business_at)
       values (gen_random_uuid(), 'test.appended', 'global', 'item', gen_random_uuid(), 'system', now(), now()) returning id`,
    )
    expect(inserted.rowCount).toBe(1)
  })
})

describe('fju_backup：讀全庫，不能寫', () => {
  it('每一張表都讀得到', async () => {
    for (const table of ['users', 'cohorts', 'audit_events', 'operation_records', 'schema_meta']) {
      await expect(backup.query(`select count(*) from ${table}`)).resolves.toBeTruthy()
    }
  })

  it('不能寫任何一張表', async () => {
    expect(
      await expectDenied(
        backup,
        `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), 'B', 'B', 'system')`,
      ),
    ).toMatch(/permission denied/i)
    expect(await expectDenied(backup, "update users set name = 'x'")).toMatch(/permission denied/i)
    expect(await expectDenied(backup, 'delete from sessions')).toMatch(/permission denied/i)
  })
})
