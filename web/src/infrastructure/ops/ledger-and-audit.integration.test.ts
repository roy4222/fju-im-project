import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { createBarrier } from '../../../test/barrier'
import { canonicalJson, receiptExpiryFrom } from '@/application/ops'
import { PgAuditWriter, sha256 } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * S01-03：操作帳本與稽核紀錄（契約 01 §4.3、§4.4、§8）。
 *
 * 帳本要證明的是「重送不會做第二次」，所以測試用**兩條真的資料庫連線**同時送同一個
 * requestId，並用同步屏障讓它們確實撞在一起——不是用 sleep 賭時間。
 */

let db: IsolatedDatabase
let userId: string
let cohortId: string

// 查回執不在用例交易裡，所以帳本要知道去哪條連線讀；測試指到自己的隔離 schema。
const ledger = new PgOperationLedger(() => db.pool)
const audit = new PgAuditWriter()

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'ledger', setup: migratedSchema })

  const user = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), '帳本測試', 'ledger@example.com', false, now(), 'active') returning id`,
  )
  userId = String(user.rows[0]!.id)
  const cohort = await db.sql(
    `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '115-L', '115 帳本', 'system') returning id`,
  )
  cohortId = String(cohort.rows[0]!.id)
})

afterAll(async () => {
  await db?.close()
})

let seq = 0
const nextRequestId = () => {
  seq += 1
  return `11111111-1111-4111-8111-${String(seq).padStart(12, '0')}`
}

function operation(requestId: string, body: Record<string, unknown>) {
  return {
    actorUserId: userId,
    operationKind: 'account.approve',
    requestId,
    fingerprint: sha256(canonicalJson(body)),
    scope: 'global' as const,
  }
}

/** 在一個交易裡跑 body；結束時 COMMIT（或依 body 的結果 ROLLBACK）。 */
async function inTx<T>(fn: (tx: PoolClient) => Promise<T>, { rollback = false } = {}): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query(rollback ? 'rollback' : 'commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

describe('帳本：同一個請求編號只做一次', () => {
  it('第一次是 fresh，第二次是 replay 並回原本的回執', async () => {
    const requestId = nextRequestId()
    const body = { applicationId: 'a1', verificationMethod: 'id_document' }

    const first = await inTx(async (tx) => {
      const begun = await ledger.begin(tx, operation(requestId, body), new Date())
      expect(begun.outcome).toBe('fresh')
      if (begun.outcome !== 'fresh') throw new Error('unreachable')
      await ledger.commit(tx, begun.recordId, {
        receipt: { message: '已核准' },
        resultRef: { userId: 'u1', revision: 3 },
      })
      return begun.recordId
    })

    const second = await inTx((tx) => ledger.begin(tx, operation(requestId, body), new Date()))
    expect(second.outcome).toBe('replay')
    if (second.outcome !== 'replay') throw new Error('unreachable')
    expect(second.recordId).toBe(first)
    expect(second.receipt).toEqual({ message: '已核准' })
    expect(second.resultRef).toEqual({ userId: 'u1', revision: 3 })
    expect(second.receiptExpired).toBe(false)

    // 重播不會多出一列。
    const count = await db.sql(
      `select count(*)::int as n from operation_records where request_id = $1`,
      [requestId],
    )
    expect(count.rows[0]!.n).toBe(1)
  })

  it('同編號不同內容 → mismatch（不是靜靜覆蓋）', async () => {
    const requestId = nextRequestId()
    await inTx(async (tx) => {
      const begun = await ledger.begin(tx, operation(requestId, { a: 1 }), new Date())
      expect(begun.outcome).toBe('fresh')
    })

    const second = await inTx((tx) => ledger.begin(tx, operation(requestId, { a: 2 }), new Date()))
    expect(second.outcome).toBe('mismatch')
  })

  it('欄位順序不同但內容相同，算同一個請求（不會被誤判成 mismatch）', async () => {
    const requestId = nextRequestId()
    await inTx((tx) => ledger.begin(tx, operation(requestId, { a: 1, b: 2 }), new Date()))
    const second = await inTx((tx) => ledger.begin(tx, operation(requestId, { b: 2, a: 1 }), new Date()))
    expect(second.outcome).toBe('replay')
  })

  it('不同的請求編號各自獨立', async () => {
    const body = { same: 'content' }
    const a = await inTx((tx) => ledger.begin(tx, operation(nextRequestId(), body), new Date()))
    const b = await inTx((tx) => ledger.begin(tx, operation(nextRequestId(), body), new Date()))
    expect(a.outcome).toBe('fresh')
    expect(b.outcome).toBe('fresh')
  })

  it('用例的交易回滾時，帳本列也跟著不見（不留 failed 列）', async () => {
    const requestId = nextRequestId()
    await inTx(async (tx) => {
      const begun = await ledger.begin(tx, operation(requestId, { x: 1 }), new Date())
      expect(begun.outcome).toBe('fresh')
    }, { rollback: true })

    const count = await db.sql(
      `select count(*)::int as n from operation_records where request_id = $1`,
      [requestId],
    )
    expect(count.rows[0]!.n).toBe(0)

    // 回滾之後同一個編號重送，應該是「第一次」而不是 replay。
    const retry = await inTx((tx) => ledger.begin(tx, operation(requestId, { x: 1 }), new Date()))
    expect(retry.outcome).toBe('fresh')
  })
})

describe('帳本：兩條連線同時送同一個請求編號（契約 01 §8）', () => {
  it('只有一個成功執行，另一個拿到 replay，而且只留一列', async () => {
    const requestId = nextRequestId()
    const body = { applicationId: 'race', verificationMethod: 'school_channel' }
    const barrier = createBarrier(2, { timeoutMs: 10_000 })

    async function attempt(label: string) {
      const client = await db.connect()
      try {
        await client.query('begin')
        // 兩邊都在「開始交易之後、寫帳本之前」等對方到齊，確保真的同時打進去。
        await barrier.arrive()
        const result = await ledger.begin(client, operation(requestId, body), new Date())
        if (result.outcome === 'fresh') {
          await ledger.commit(client, result.recordId, { receipt: { by: label }, resultRef: {} })
        }
        await client.query('commit')
        return result.outcome
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    }

    const outcomes = await Promise.all([attempt('A'), attempt('B')])
    expect(outcomes.filter((o) => o === 'fresh'), '只能有一個是第一次').toHaveLength(1)
    expect(outcomes.filter((o) => o === 'replay'), '另一個必須是重播').toHaveLength(1)

    const rows = await db.sql(
      `select count(*)::int as n from operation_records where request_id = $1`,
      [requestId],
    )
    expect(rows.rows[0]!.n, '資料庫裡只能有一列').toBe(1)
  })

  it('同時送但內容不同：一個成功，另一個是 mismatch', async () => {
    const requestId = nextRequestId()
    const barrier = createBarrier(2, { timeoutMs: 10_000 })

    async function attempt(payload: Record<string, unknown>) {
      const client = await db.connect()
      try {
        await client.query('begin')
        await barrier.arrive()
        const result = await ledger.begin(client, operation(requestId, payload), new Date())
        await client.query('commit')
        return result.outcome
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    }

    const outcomes = await Promise.all([attempt({ v: 1 }), attempt({ v: 2 })])
    expect(outcomes.filter((o) => o === 'fresh')).toHaveLength(1)
    expect(outcomes.filter((o) => o === 'mismatch')).toHaveLength(1)
  })
})

describe('帳本：查回執', () => {
  it('查得到本人的紀錄', async () => {
    const requestId = nextRequestId()
    await inTx(async (tx) => {
      const begun = await ledger.begin(tx, operation(requestId, { q: 1 }), new Date())
      if (begun.outcome !== 'fresh') throw new Error('unreachable')
      await ledger.commit(tx, begun.recordId, { receipt: { ok: true }, resultRef: { id: 'x' } })
    })

    const found = await ledger.get(userId, 'account.approve', requestId)
    expect(found.outcome).toBe('replay')
    if (found.outcome !== 'replay') throw new Error('unreachable')
    expect(found.receipt).toEqual({ ok: true })
  })

  it('回執被清掉之後，結果參照還在（契約 01 §4.4）', async () => {
    const requestId = nextRequestId()
    await inTx(async (tx) => {
      const begun = await ledger.begin(tx, operation(requestId, { q: 2 }), new Date())
      if (begun.outcome !== 'fresh') throw new Error('unreachable')
      await ledger.commit(tx, begun.recordId, { receipt: { secretish: false }, resultRef: { id: 'keep-me' } })
    })

    // 模擬 worker 的 receipt_purge：只清 receipt，不動 result_ref。
    await db.sql(`update operation_records set receipt = null where request_id = $1`, [requestId])

    const found = await ledger.get(userId, 'account.approve', requestId)
    if (found.outcome !== 'replay') throw new Error('unreachable')
    expect(found.receiptExpired).toBe(true)
    expect(found.resultRef).toEqual({ id: 'keep-me' })
  })

  it('回執到期時間是 committed + 30 天', async () => {
    const requestId = nextRequestId()
    const committed = new Date('2026-09-15T04:00:00.000Z')
    await inTx((tx) => ledger.begin(tx, operation(requestId, { q: 3 }), committed))

    const row = await db.sql(
      `select committed_real_at, receipt_expires_at from operation_records where request_id = $1`,
      [requestId],
    )
    const expires = new Date(String(row.rows[0]!.receipt_expires_at))
    expect(expires.toISOString()).toBe(receiptExpiryFrom(committed).toISOString())
  })
})

describe('稽核紀錄', () => {
  it('雙時間欄分開存（契約 01 §1）', async () => {
    const realAt = new Date('2026-09-15T04:00:00.000Z')
    // 業務鐘在 staging 可以被推開，所以兩個時間**本來就可能不同**；分開存才追溯得了。
    const businessAt = new Date('2026-10-01T04:00:00.000Z')

    const id = await inTx((tx) =>
      audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'account.approve',
        targetType: 'user',
        targetId: userId,
        scope: 'cohort',
        cohortId,
        reason: '當面核對證件',
        verificationMethod: 'id_document',
        realAt,
        businessAt,
        payload: { revision: 3 },
      }),
    )

    const row = await db.sql('select * from audit_events where id = $1', [id])
    expect(row.rowCount).toBe(1)
    const event = row.rows[0]!
    expect(new Date(String(event.real_at)).toISOString()).toBe(realAt.toISOString())
    expect(new Date(String(event.business_at)).toISOString()).toBe(businessAt.toISOString())
    expect(event.verification_method).toBe('id_document')
    expect(event.payload).toEqual({ revision: 3 })
  })

  it('system 與 worker 不帶 actor_user_id（契約 01 §1 的 actor 規則）', async () => {
    const id = await inTx((tx) =>
      audit.append(tx, {
        actorKind: 'worker',
        action: 'session.revoke',
        targetType: 'user',
        targetId: userId,
        scope: 'global',
        realAt: new Date(),
        businessAt: new Date(),
      }),
    )
    const row = await db.sql('select actor_kind, actor_user_id from audit_events where id = $1', [id])
    expect(row.rows[0]!.actor_kind).toBe('worker')
    expect(row.rows[0]!.actor_user_id).toBeNull()
  })

  it('actor 規則違反時資料庫直接擋下（user 卻沒有 actor_user_id）', async () => {
    await expect(
      inTx((tx) =>
        audit.append(tx, {
          actorKind: 'user',
          actorUserId: null,
          action: 'bad',
          targetType: 'user',
          scope: 'global',
          realAt: new Date(),
          businessAt: new Date(),
        }),
      ),
    ).rejects.toThrow(/audit_events_actor_check/)
  })

  it('用例回滾時稽核也跟著不見（同一個交易）', async () => {
    const before = await db.sql(`select count(*)::int as n from audit_events`)
    await inTx(
      (tx) =>
        audit.append(tx, {
          actorKind: 'system',
          action: 'should.rollback',
          targetType: 'user',
          scope: 'global',
          realAt: new Date(),
          businessAt: new Date(),
        }),
      { rollback: true },
    )
    const after = await db.sql(`select count(*)::int as n from audit_events`)
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n)
  })

  it('寫進去就改不掉（trigger 第二層；S00-05 已驗權限，這裡驗 app 的實際寫入）', async () => {
    const id = await inTx((tx) =>
      audit.append(tx, {
        actorKind: 'system',
        action: 'immutable.check',
        targetType: 'user',
        scope: 'global',
        realAt: new Date(),
        businessAt: new Date(),
      }),
    )
    await expect(db.sql(`update audit_events set action = 'tampered' where id = $1`, [id])).rejects.toThrow(
      /不可變表/,
    )
    await expect(db.sql(`delete from audit_events where id = $1`, [id])).rejects.toThrow(/不可變表/)
  })

  it('以 `fju_app` 的身分也寫得進去、改不動（契約 01 §5 的正向用例）', async () => {
    const app = await poolAsRole(db, 'fju_app')
    try {
      const inserted = await app.query(
        `insert into audit_events (id, actor_kind, action, target_type, scope, real_at, business_at)
         values (gen_random_uuid(), 'system', 'app.write', 'user', 'global', now(), now()) returning id`,
      )
      expect(inserted.rowCount).toBe(1)
      await expect(
        app.query(`update audit_events set action = 'x' where id = $1`, [inserted.rows[0].id]),
      ).rejects.toThrow(/permission denied/i)
    } finally {
      await app.end()
    }
  })
})
