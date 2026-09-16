import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  inTransaction,
  withIsolatedDatabase,
  type IsolatedDatabase,
} from './db'
import { createBarrier } from './barrier'
import { enableFaultInjection, failAt, injectFault } from './fault-injection'
import { buildRunManifest, writeRunManifest } from './run-manifest'
import { reachFaultPoint } from '@/shared/fault-points'

/**
 * harness 的自測（S00-03 完成定義）。證明三件事：
 * 1. 兩個測試並行寫同名的表不會互相污染。
 * 2. 屏障能讓兩筆交易在指定點會合，重現真正的鎖等待。
 * 3. 故障注入點在沒開旗標時是 no-op，開了才會生效。
 */

beforeAll(async () => {
  await assertTestDatabaseReachable()
})

describe('隔離：兩個測試並行寫同名的表', () => {
  it('各自的 schema 互不干擾', async () => {
    const [a, b] = await Promise.all([
      createIsolatedDatabase({ label: 'parallel-a' }),
      createIsolatedDatabase({ label: 'parallel-b' }),
    ])
    try {
      expect(a.schemaName).not.toBe(b.schemaName)

      // 兩邊同時建同名的表、寫不同的資料。
      await Promise.all([
        a.sql('create table widgets (id int primary key, owner text not null)'),
        b.sql('create table widgets (id int primary key, owner text not null)'),
      ])
      await Promise.all([
        a.sql("insert into widgets values (1, 'a'), (2, 'a')"),
        b.sql("insert into widgets values (1, 'b')"),
      ])

      const rowsA = await a.sql('select owner from widgets order by id')
      const rowsB = await b.sql('select owner from widgets order by id')
      expect(rowsA.rows).toEqual([{ owner: 'a' }, { owner: 'a' }])
      expect(rowsB.rows).toEqual([{ owner: 'b' }])
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })

  it('close() 之後 schema 真的不見了', async () => {
    const db = await createIsolatedDatabase({ label: 'dropped' })
    const name = db.schemaName
    await db.sql('create table leftovers (id int)')
    await db.close()

    await withIsolatedDatabase({ label: 'checker' }, async (checker) => {
      const found = await checker.sql('select 1 from information_schema.schemata where schema_name = $1', [name])
      expect(found.rowCount).toBe(0)
    })
  })
})

/**
 * 等到指定的那條連線真的卡在鎖上為止。
 *
 * 用 `pg_stat_activity` 問那一個 backend 的 `wait_event_type`，不是用時間猜。
 *
 * 兩次修錯的紀錄，免得下次又踩：
 * 1. 一開始用 `setImmediate` 賭一個 tick 夠第二筆去撞鎖——CI 負載高時會輸。
 * 2. 接著改問「有沒有人在等鎖」，但整個測試庫是共用的，別的測試在等鎖時會提早返回；
 *    改問「`counters` 這張表上有沒有未授予的鎖」又不成立——`SELECT … FOR UPDATE`
 *    被擋住時，等的是 `transactionid`／`tuple` 鎖（在等前一筆交易結束），
 *    **不是** relation 鎖，那張表的 RowShareLock 兩邊都是 granted。
 *
 * 所以綁 pid：只看我們自己那條連線有沒有在 `Lock` 上等。
 */
async function waitUntilBlocked(db: IsolatedDatabase, pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const waiting = await db.sql(
      `select count(*)::int as n from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`,
      [pid],
    )
    if (Number(waiting.rows[0]!.n) > 0) return
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs}ms，pid ${pid} 都沒有卡在鎖上`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('屏障：兩筆交易在指定點會合', () => {
  it('兩筆交易同時搶同一列，後到的那筆被擋住直到先到的 commit', async () => {
    await withIsolatedDatabase({ label: 'barrier' }, async (db) => {
      await db.sql('create table counters (id int primary key, value int not null)')
      await db.sql('insert into counters values (1, 0)')

      const bothInTransaction = createBarrier(2)
      const order: string[] = []
      /** 第二筆交易的 backend pid；它在會合之前填好，第一筆會合之後才讀。 */
      let secondPid = 0

      const first = (async () => {
        const client = await db.connect()
        try {
          await client.query('begin')
          await client.query('select * from counters where id = 1 for update')
          order.push('first-locked')
          // 等第二筆也進到交易裡，確定兩邊真的同時在跑。
          await bothInTransaction.arrive()
          // 等到第二筆**真的**卡在鎖上才往下走（原本是賭一個 tick，CI 上會輸）。
          await waitUntilBlocked(db, secondPid)
          await client.query('update counters set value = value + 1 where id = 1')
          await client.query('commit')
          order.push('first-committed')
        } finally {
          client.release()
        }
      })()

      const second = (async () => {
        const client = await db.connect()
        try {
          await client.query('begin')
          // 先把自己的 backend pid 留給第一筆，它才知道要等誰。
          const pid = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
          secondPid = Number(pid.rows[0]!.pid)
          await bothInTransaction.arrive()
          // 這行會卡住，直到第一筆 commit 放開鎖。
          await client.query('select * from counters where id = 1 for update')
          order.push('second-acquired-lock')
          await client.query('update counters set value = value + 10 where id = 1')
          await client.query('commit')
        } finally {
          client.release()
        }
      })()

      await Promise.all([first, second])

      expect(order).toEqual(['first-locked', 'first-committed', 'second-acquired-lock'])
      const value = await db.sql('select value from counters where id = 1')
      expect(value.rows[0]).toEqual({ value: 11 })
    })
  })

  it('人數沒到齊就等，逾時會明確報錯而不是靜靜過去', async () => {
    const barrier = createBarrier(2, { timeoutMs: 50 })
    await expect(barrier.arrive()).rejects.toThrow(/屏障等了 50ms/)
  })

  it('abort 會叫醒還在等的人', async () => {
    const barrier = createBarrier(2)
    const waiting = barrier.arrive()
    barrier.abort('測試主動中止')
    await expect(waiting).rejects.toThrow(/測試主動中止/)
  })
})

describe('交易 helper', () => {
  it('body 丟例外就整筆 rollback', async () => {
    await withIsolatedDatabase({ label: 'rollback' }, async (db) => {
      await db.sql('create table notes (id int primary key)')
      await expect(
        inTransaction(db, async (client) => {
          await client.query('insert into notes values (1)')
          throw new Error('故意失敗')
        }),
      ).rejects.toThrow('故意失敗')
      const rows = await db.sql('select * from notes')
      expect(rows.rowCount).toBe(0)
    })
  })
})

describe('故障注入', () => {
  it('沒開旗標時注入點完全不做事', async () => {
    delete process.env.FAULT_INJECTION_ENABLED
    await expect(reachFaultPoint('uow.before-commit')).resolves.toBeUndefined()
  })

  it('開了旗標才會執行注入的行為', async () => {
    const disable = enableFaultInjection()
    try {
      const calls: string[] = []
      injectFault('uow.after-commit', () => {
        calls.push('hit')
      })
      await reachFaultPoint('uow.after-commit')
      await reachFaultPoint('uow.before-commit')
      expect(calls).toEqual(['hit'])

      failAt('worker.before-handler')
      await expect(reachFaultPoint('worker.before-handler')).rejects.toThrow(/注入的故障/)
    } finally {
      disable()
    }
  })

  it('關掉旗標後註冊會被拒絕，避免不小心留在 production 路徑上', () => {
    delete process.env.FAULT_INJECTION_ENABLED
    expect(() => injectFault('uow.before-commit', () => {})).toThrow(/FAULT_INJECTION_ENABLED/)
  })
})

describe('run manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-run-'))

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('寫出契約 04 §7 要求的最小欄位', () => {
    const manifest = buildRunManifest({ runId: 'harness-selftest', kind: 'partial', dataset: 'empty' })
    const file = writeRunManifest(dir, manifest)
    const written = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(Object.keys(written).sort()).toEqual(
      [
        'businessClockStart',
        'commit',
        'dataset',
        'env',
        'imageDigest',
        'kind',
        'operator',
        'runId',
        'schemaVersion',
        'startedAt',
        'workerVersion',
      ].sort(),
    )
    expect(written.commit).toMatch(/^[0-9a-f]{40}$|^unknown$/)
    expect(written.env).toBe('local')
  })
})
