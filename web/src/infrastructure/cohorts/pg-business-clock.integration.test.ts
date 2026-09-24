import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { PgBusinessClock } from '@/infrastructure/cohorts/pg-business-clock'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { FixedClock } from '@/shared/time'

/**
 * 票 11（S02-02）：模擬業務鐘（產品模組 02 §4「模擬業務日期規則」）。
 *
 * - 測試站：管理員可設到秒、可前進可倒退；每次留操作者、原因、真實時間、前後業務時間；取最新一筆。
 * - 正式站（開關 false）：用例一律拒絕、什麼都不寫；業務時間就是真實時間，就算表裡有列也不讀。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let teacherId: string
const real = new FixedClock(new Date('2026-09-24T01:00:00Z'))

function actor(userId: string, roles: ('admin' | 'teacher')[] = ['admin']): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

function clock(enabled: boolean): PgBusinessClock {
  return new PgBusinessClock({
    enabled,
    environment: 'staging',
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    pool: () => app,
    reader: () => app,
    realClock: real,
  })
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'clock', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  const users = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A1', 'a1-clock@example.com', false, now(), 'active'),
            (gen_random_uuid(), 'T1', 't1-clock@example.com', false, now(), 'active')
     returning id, name`,
  )
  adminId = String(users.rows.find((r) => r.name === 'A1')!.id)
  teacherId = String(users.rows.find((r) => r.name === 'T1')!.id)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('正式站（BUSINESS_CLOCK_OVERRIDE_ENABLED=false）', () => {
  it('設定用例一律 FORBIDDEN（管理員也一樣），不寫紀錄、不寫帳本', async () => {
    const requestId = randomUUID()
    const result = await clock(false).set(actor(adminId), { businessAt: '2027-03-01T10:00:00', reason: '想偷改' }, requestId)
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await count('select count(*) as n from business_clock_overrides')).toBe(0)
    expect(await count('select count(*) as n from operation_records where request_id = $1', [requestId])).toBe(0)
  })

  it('業務時間＝真實時間；表裡就算被塞了列也不讀', async () => {
    await owner.sql(
      `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
       values (gen_random_uuid(), 'staging', '2030-01-01T00:00:00Z', now(), $1, '不該生效')`,
      [adminId],
    )
    const production = clock(false)
    expect((await production.now()).toISOString()).toBe(real.now().toISOString())
    expect(await production.history(10)).toEqual([])
    expect((await production.state()).enabled).toBe(false)
    await owner.sql(`alter table business_clock_overrides disable trigger business_clock_overrides_immutable_row`)
    await owner.sql(`delete from business_clock_overrides`)
    await owner.sql(`alter table business_clock_overrides enable trigger business_clock_overrides_immutable_row`)
  })
})

describe('測試站（BUSINESS_CLOCK_OVERRIDE_ENABLED=true）', () => {
  it('沒設定過：業務時間＝真實時間', async () => {
    expect((await clock(true).now()).toISOString()).toBe(real.now().toISOString())
  })

  it('設到某一秒：留操作者、原因、真實時間、前後業務時間；之後業務鐘從那一秒繼續走', async () => {
    const staging = clock(true)
    const result = await staging.set(actor(adminId), { businessAt: '2027-03-01T10:00:00', reason: '驗期末截止' }, randomUUID())
    expect(result).toMatchObject({
      ok: true,
      receipt: { businessAt: '2027-03-01T02:00:00.000Z', previousBusinessAt: '2026-09-24T01:00:00.000Z' },
    })

    const rows = await owner.sql(
      `select environment, business_at, real_at, previous_business_at, set_by_user_id, reason from business_clock_overrides`,
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ environment: 'staging', set_by_user_id: adminId, reason: '驗期末截止' })
    expect((rows.rows[0]!.real_at as Date).toISOString()).toBe('2026-09-24T01:00:00.000Z')
    expect((rows.rows[0]!.previous_business_at as Date).toISOString()).toBe('2026-09-24T01:00:00.000Z')

    real.set(new Date('2026-09-24T01:00:07Z'))
    expect((await staging.now()).toISOString()).toBe('2027-03-01T02:00:07.000Z')

    expect(
      await count(`select count(*) as n from audit_events where action = 'business_clock.set' and actor_user_id = $1`, [adminId]),
    ).toBe(1)
  })

  it('可以倒退；紀錄只增不改、取最新一筆；「設定前」是當下的業務時間', async () => {
    const staging = clock(true)
    const result = await staging.set(actor(adminId), { businessAt: '2026-10-01T00:00:00', reason: '回撥驗邊界' }, randomUUID())
    expect(result).toMatchObject({ ok: true, receipt: { previousBusinessAt: '2027-03-01T02:00:07.000Z' } })
    expect((await staging.now()).toISOString()).toBe('2026-09-30T16:00:00.000Z')

    const history = await staging.history(10)
    expect(history.map((h) => h.reason)).toEqual(['回撥驗邊界', '驗期末截止'])
    expect(history[0]!.setByName).toBe('A1')
  })

  it('紀錄不可變：fju_app 改不了也刪不掉', async () => {
    await expect(app.query(`update business_clock_overrides set reason = 'x'`)).rejects.toThrow(/permission denied/i)
    await expect(app.query(`delete from business_clock_overrides`)).rejects.toThrow(/permission denied/i)
  })

  it('原因必填；時間格式不對拒絕；都不寫紀錄', async () => {
    const before = await count('select count(*) as n from business_clock_overrides')
    expect(await clock(true).set(actor(adminId), { businessAt: '2027-03-01T10:00:00', reason: ' ' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    expect(await clock(true).set(actor(adminId), { businessAt: 'tomorrow', reason: 'x' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    expect(await count('select count(*) as n from business_clock_overrides')).toBe(before)
  })

  it('老師直接呼叫：FORBIDDEN', async () => {
    expect(await clock(true).set(actor(teacherId, ['teacher']), { businessAt: '2027-03-01T10:00:00', reason: 'x' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
  })

  it('同一個請求編號重送：回第一次的回執，不多一筆', async () => {
    const staging = clock(true)
    const requestId = randomUUID()
    const before = await count('select count(*) as n from business_clock_overrides')
    const first = await staging.set(actor(adminId), { businessAt: '2027-01-10T00:00:00', reason: '重送' }, requestId)
    const second = await staging.set(actor(adminId), { businessAt: '2027-01-10T00:00:00', reason: '重送' }, requestId)
    expect(second).toEqual(first)
    expect(await count('select count(*) as n from business_clock_overrides')).toBe(before + 1)
  })

  it('environment 欄只收 local／staging（正式站不該有列）', async () => {
    await expect(
      owner.sql(
        `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
         values (gen_random_uuid(), 'production', now(), now(), $1, 'x')`,
        [adminId],
      ),
    ).rejects.toThrow(/business_clock_overrides_environment_check/)
  })
})
