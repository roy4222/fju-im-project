import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { createBarrier, type Barrier } from '../../../test/barrier'
import type { ResolvedActor } from '@/application/accounts'
import { PgCohortCommand, PgCohortStatusQuery } from '@/infrastructure/cohorts/pg-cohorts'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'

/** 這個檔不測業務鐘；用真實時間就好（業務鐘的測試在 pg-business-clock.integration.test.ts）。 */
const realBusinessClock = { now: async () => new Date() }

/**
 * 票 5：建立屆別與兩個旗標（模組 02 §4「11.3」「開放註冊屆別」；模組實作設計 02 §3）。
 *
 * 用例以**正式執行角色 `fju_app`** 連線跑，順便證明權限矩陣給的權限夠用、沒有多給。
 */

let owner: IsolatedDatabase
let app: Pool
let command: PgCohortCommand
let query: PgCohortStatusQuery
let adminId: string
let teacherId: string

function authenticated(userId: string, patch: Partial<Extract<ResolvedActor, { kind: 'authenticated' }>> = {}) {
  return {
    kind: 'authenticated' as const,
    userId,
    roles: ['admin' as const],
    status: 'active' as const,
    mustChangePassword: false,
    cohortMemberships: [],
    ...patch,
  }
}

let seq = 0
const uniqueCode = (prefix: string) => `${prefix}-${(seq += 1)}`

async function count(sql: string, values: unknown[] = []): Promise<number> {
  const result = await owner.sql(sql, values)
  return Number(result.rows[0]!.n)
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'cohorts', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')

  command = new PgCohortCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    businessClock: realBusinessClock,
    pool: () => app,
  })
  query = new PgCohortStatusQuery(() => app)

  const users = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A1', 'a1-cohorts@example.com', false, now(), 'active'),
            (gen_random_uuid(), 'T1', 't1-cohorts@example.com', false, now(), 'active')
     returning id, name`,
  )
  adminId = String(users.rows.find((r) => r.name === 'A1')!.id)
  teacherId = String(users.rows.find((r) => r.name === 'T1')!.id)
})

/** 借一條 fju_app 連線；`begin` 之後的第一句先到屏障等另一方。 */
async function connectMeetingAt(barrier: Barrier): Promise<PoolClient> {
  const client = await app.connect()
  const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>
  let met = false
  const patched = async (...args: unknown[]) => {
    if (!met && args[0] !== 'begin') {
      met = true
      await barrier.arrive()
    }
    return original(...args)
  }
  Object.assign(client, { query: patched })
  const release = client.release.bind(client)
  Object.assign(client, {
    release: (error?: Error | boolean) => {
      Object.assign(client, { query: original, release })
      return release(error)
    },
  })
  return client
}

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('新增屆別', () => {
  it('建出籌備中的屆別，同時留稽核與帳本', async () => {
    const code = uniqueCode('115')
    const requestId = randomUUID()
    const result = await command.create(authenticated(adminId), { code, name: ' 115 學年度 ' }, requestId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.receipt).toMatchObject({ code, name: '115 學年度', requestId })

    const row = await owner.sql(
      `select status, is_default_working, is_registration_open, created_by_kind, created_by_user_id
       from cohorts where id = $1`,
      [result.receipt.cohortId],
    )
    expect(row.rows[0]).toEqual({
      status: 'preparing',
      is_default_working: false,
      is_registration_open: false,
      created_by_kind: 'user',
      created_by_user_id: adminId,
    })

    expect(
      await count(`select count(*) as n from audit_events where action = 'cohort.create' and target_id = $1`, [
        result.receipt.cohortId,
      ]),
    ).toBe(1)
    expect(await count(`select count(*) as n from operation_records where request_id = $1`, [requestId])).toBe(1)

    const listed = await query.list()
    expect(listed.find((c) => c.code === code)).toMatchObject({ status: 'preparing', name: '115 學年度' })
  })

  it('同一個請求編號重送：回第一次的回執，不會多一屆', async () => {
    const code = uniqueCode('115')
    const requestId = randomUUID()
    const first = await command.create(authenticated(adminId), { code, name: '重送' }, requestId)
    const second = await command.create(authenticated(adminId), { code, name: '重送' }, requestId)

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.receipt).toEqual(first.receipt)
    expect(await count(`select count(*) as n from cohorts where code = $1`, [code])).toBe(1)
  })

  it('同一個請求編號換了內容：REQUEST_MISMATCH', async () => {
    const requestId = randomUUID()
    await command.create(authenticated(adminId), { code: uniqueCode('115'), name: '甲' }, requestId)
    const second = await command.create(authenticated(adminId), { code: uniqueCode('115'), name: '乙' }, requestId)
    expect(second).toMatchObject({ ok: false, code: 'REQUEST_MISMATCH' })
  })

  it('代碼重複：CONFLICT，而且那次送出沒有留下帳本或稽核', async () => {
    const code = uniqueCode('115')
    await command.create(authenticated(adminId), { code, name: '第一個' }, randomUUID())

    const requestId = randomUUID()
    const again = await command.create(authenticated(adminId), { code, name: '第二個' }, requestId)
    expect(again).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await count(`select count(*) as n from cohorts where code = $1`, [code])).toBe(1)
    expect(await count(`select count(*) as n from operation_records where request_id = $1`, [requestId])).toBe(0)
  })

  it('空白代碼：VALIDATION_FAILED，什麼都沒寫', async () => {
    const before = await count(`select count(*) as n from cohorts`)
    const result = await command.create(authenticated(adminId), { code: '  ', name: '沒有代碼' }, randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await count(`select count(*) as n from cohorts`)).toBe(before)
  })

  it('不是管理員、未登入、還沒改密：都被擋，什麼都沒寫', async () => {
    const before = await count(`select count(*) as n from cohorts`)

    const teacher = await command.create(
      authenticated(teacherId, { roles: ['teacher'] }),
      { code: uniqueCode('X'), name: 'x' },
      randomUUID(),
    )
    expect(teacher).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    const anonymous = await command.create({ kind: 'anonymous' }, { code: uniqueCode('X'), name: 'x' }, randomUUID())
    expect(anonymous).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })

    const mustChange = await command.create(
      authenticated(adminId, { mustChangePassword: true }),
      { code: uniqueCode('X'), name: 'x' },
      randomUUID(),
    )
    expect(mustChange).toMatchObject({ ok: false, code: 'PASSWORD_CHANGE_REQUIRED' })

    expect(await count(`select count(*) as n from cohorts`)).toBe(before)
  })
})

describe('預設工作屆別與開放註冊屆別', () => {
  async function newCohort(prefix: string): Promise<{ id: string; code: string }> {
    const code = uniqueCode(prefix)
    const created = await command.create(authenticated(adminId), { code, name: code }, randomUUID())
    if (!created.ok) throw new Error(created.message)
    return { id: created.receipt.cohortId, code }
  }

  async function holders(column: 'is_default_working' | 'is_registration_open'): Promise<string[]> {
    const rows = await owner.sql(`select code from cohorts where ${column} order by code`)
    return rows.rows.map((r) => String(r.code))
  }

  it('一開始沒有開放註冊屆別：查詢明確回 null，不挑一屆來猜', async () => {
    await owner.sql(`update cohorts set is_registration_open = false, is_default_working = false`)
    expect(await query.registrationOpen()).toBeNull()
    expect(await query.defaultWorking()).toBeNull()
  })

  it('把開放註冊交給另一屆時，舊的自動取消；回執說出被取消的是哪一屆', async () => {
    const a = await newCohort('REG-A')
    const b = await newCohort('REG-B')

    const first = await command.setRegistrationOpen(authenticated(adminId), a.id, randomUUID())
    expect(first).toMatchObject({ ok: true, receipt: { code: a.code, previousCode: null } })
    expect((await query.registrationOpen())?.id).toBe(a.id)

    const second = await command.setRegistrationOpen(authenticated(adminId), b.id, randomUUID())
    expect(second).toMatchObject({
      ok: true,
      receipt: { flag: 'registrationOpen', code: b.code, previousCohortId: a.id, previousCode: a.code },
    })
    expect(await holders('is_registration_open')).toEqual([b.code])

    // 兩屆都被改過：revision 各加一次以上，更新者是 A1。
    const rows = await owner.sql(`select code, revision, updated_by_user_id from cohorts where id = any($1)`, [
      [a.id, b.id],
    ])
    for (const row of rows.rows) {
      expect(Number(row.revision)).toBeGreaterThan(1)
      expect(row.updated_by_user_id).toBe(adminId)
    }

    const audit = await owner.sql(
      `select payload from audit_events where action = 'cohort.set_registration_open' and target_id = $1`,
      [b.id],
    )
    expect(audit.rows[0]!.payload).toMatchObject({ previousCohortId: a.id, previousCode: a.code })
  })

  it('兩個旗標互不影響：預設工作屆別可以是另一屆', async () => {
    const reg = await newCohort('BOTH-R')
    const work = await newCohort('BOTH-W')
    await command.setRegistrationOpen(authenticated(adminId), reg.id, randomUUID())
    await command.setDefaultWorking(authenticated(adminId), work.id, randomUUID())

    expect((await query.registrationOpen())?.code).toBe(reg.code)
    expect((await query.defaultWorking())?.code).toBe(work.code)

    const next = await newCohort('BOTH-N')
    const switched = await command.setDefaultWorking(authenticated(adminId), next.id, randomUUID())
    expect(switched).toMatchObject({ ok: true, receipt: { previousCode: work.code } })
    expect(await holders('is_default_working')).toEqual([next.code])
    expect(await holders('is_registration_open')).toEqual([reg.code])
  })

  it('對已經持有旗標的那一屆再按一次：成功、不改資料、不多留稽核', async () => {
    const c = await newCohort('SAME')
    await command.setDefaultWorking(authenticated(adminId), c.id, randomUUID())
    const revision = Number((await owner.sql(`select revision from cohorts where id = $1`, [c.id])).rows[0]!.revision)

    const again = await command.setDefaultWorking(authenticated(adminId), c.id, randomUUID())
    expect(again).toMatchObject({ ok: true, receipt: { previousCohortId: null } })
    expect(Number((await owner.sql(`select revision from cohorts where id = $1`, [c.id])).rows[0]!.revision)).toBe(
      revision,
    )
    expect(
      await count(
        `select count(*) as n from audit_events where action = 'cohort.set_default_working' and target_id = $1`,
        [c.id],
      ),
    ).toBe(1)
  })

  it('同一個請求編號重送：只切換一次，回同一份回執', async () => {
    const a = await newCohort('RP-A')
    const b = await newCohort('RP-B')
    await command.setRegistrationOpen(authenticated(adminId), a.id, randomUUID())

    const requestId = randomUUID()
    const first = await command.setRegistrationOpen(authenticated(adminId), b.id, requestId)
    const second = await command.setRegistrationOpen(authenticated(adminId), b.id, requestId)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.receipt).toEqual(first.receipt)
    expect(second.receipt.previousCode).toBe(a.code)
  })

  it('兩個管理員同時把開放註冊交給不同的屆別：兩個都成功，最後只剩一屆持有', async () => {
    const a = await newCohort('RACE-A')
    const b = await newCohort('RACE-B')
    const c = await newCohort('RACE-C')
    await command.setRegistrationOpen(authenticated(adminId), a.id, randomUUID())

    // 兩個交易都開好之後在屏障會合，再一起往下跑——確實撞在一起，不靠 sleep 賭時間。
    // 沒有「同一個旗標排隊」的鎖時，後到的那個看不到前者剛設好的新持有者，會撞唯一索引。
    const barrier = createBarrier(2)
    const racing = new PgCohortCommand({
      audit: new PgAuditWriter(),
      ledger: new PgOperationLedger(() => app),
      events: new PgEventPublisher(),
      businessClock: realBusinessClock,
      pool: () => ({ connect: () => connectMeetingAt(barrier) }),
    })

    const [x, y] = await Promise.all([
      racing.setRegistrationOpen(authenticated(adminId), b.id, randomUUID()),
      racing.setRegistrationOpen(authenticated(adminId), c.id, randomUUID()),
    ])
    expect(x.ok, JSON.stringify(x)).toBe(true)
    expect(y.ok, JSON.stringify(y)).toBe(true)
    const held = await holders('is_registration_open')
    expect(held).toHaveLength(1)
    expect([b.code, c.code]).toContain(held[0])
  })

  it('已封存的屆別不能拿旗標；舊的持有者不變', async () => {
    const holder = await newCohort('ARC-H')
    const archived = await newCohort('ARC-X')
    await command.setRegistrationOpen(authenticated(adminId), holder.id, randomUUID())
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [archived.id])

    const result = await command.setRegistrationOpen(authenticated(adminId), archived.id, randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
    expect(await holders('is_registration_open')).toEqual([holder.code])
  })

  it('找不到的屆別、非管理員：被擋，旗標不動', async () => {
    const holder = await newCohort('NF-H')
    await command.setDefaultWorking(authenticated(adminId), holder.id, randomUUID())

    expect(await command.setDefaultWorking(authenticated(adminId), randomUUID(), randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    expect(await command.setDefaultWorking(authenticated(adminId), 'not-a-uuid', randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })

    const other = await newCohort('NF-O')
    expect(
      await command.setDefaultWorking(authenticated(teacherId, { roles: ['teacher'] }), other.id, randomUUID()),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await holders('is_default_working')).toEqual([holder.code])
  })
})
