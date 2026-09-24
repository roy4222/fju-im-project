import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * S00-08：`/api/health` 的兩條路徑。
 *
 * 每個案例都重新 import 一次模組，因為連線池是模組層級快取的——
 * 換了 DATABASE_URL 就要拿到新的池。
 *
 * 連線刻意指到自己的隔離 schema（而不是 public），這樣不論本機或 CI，
 * 測試都不依賴「有人先對 public 跑過 migration」。
 */

const CONTRACT_KEYS = ['ok', 'version', 'commit', 'imageDigest', 'schemaVersion', 'worker']

let db: IsolatedDatabase
let migratedUrl: string

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'health', setup: migratedSchema })
  // migrate 腳本會寫這一列；隔離 schema 是直接套 SQL，所以自己補上。
  await db.sql("insert into schema_meta (key, value) values ('schema_version', '0001_s00_roles_and_immutability')")

  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)
  migratedUrl = url.toString()
})

afterAll(async () => {
  await db?.close()
})

afterEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
})

async function snapshotWith(databaseUrl: string) {
  vi.resetModules()
  vi.stubEnv('DATABASE_URL', databaseUrl)
  vi.stubEnv('APP_VERSION', '9.9.9')
  vi.stubEnv('GIT_COMMIT', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  vi.stubEnv('IMAGE_DIGEST', 'sha256:abc123')
  const { getHealthSnapshot } = await import('@/composition/health')
  return getHealthSnapshot()
}

describe('資料庫正常時', () => {
  it('回 ok，欄位名與契約 05 §1／§3 逐字一致', async () => {
    const snapshot = await snapshotWith(migratedUrl)
    expect(Object.keys(snapshot)).toEqual(CONTRACT_KEYS)
    expect(snapshot.ok).toBe(true)
    expect(snapshot.version).toBe('9.9.9')
    expect(snapshot.commit).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    expect(snapshot.imageDigest).toBe('sha256:abc123')
    expect(Object.keys(snapshot.worker)).toEqual(['version', 'lastTickAt'])
  })

  it('schemaVersion 讀的是 schema_meta 的值', async () => {
    const snapshot = await snapshotWith(migratedUrl)
    expect(snapshot.schemaVersion).toBe('0001_s00_roles_and_immutability')
  })
})

describe('背景工作的心跳（票 12）', () => {
  it('還沒有心跳：worker 兩欄 null、ok 仍是 true（還沒部署 worker 的環境）', async () => {
    await db.sql('delete from worker_heartbeat')
    const snapshot = await snapshotWith(migratedUrl)
    expect(snapshot.worker).toEqual({ version: null, lastTickAt: null })
    expect(snapshot.ok).toBe(true)
  })

  it('worker 在跑：回報版本與最後一次心跳', async () => {
    const tick = new Date(Date.now() - 3_000)
    await db.sql(
      `insert into worker_heartbeat (id, version, last_tick_real_at, updated_at) values (1, 'abc123', $1, $1)
       on conflict (id) do update set version = excluded.version, last_tick_real_at = excluded.last_tick_real_at`,
      [tick],
    )
    const snapshot = await snapshotWith(migratedUrl)
    expect(snapshot.worker).toEqual({ version: 'abc123', lastTickAt: tick.toISOString() })
    expect(snapshot.ok).toBe(true)
  })

  it('worker 停掉超過 5 分鐘：ok 變 false（Route Handler 回 503），lastTickAt 停在停機前', async () => {
    const tick = new Date(Date.now() - 6 * 60_000)
    await db.sql(`update worker_heartbeat set last_tick_real_at = $1 where id = 1`, [tick])
    const snapshot = await snapshotWith(migratedUrl)
    expect(snapshot.ok).toBe(false)
    expect(snapshot.worker.lastTickAt).toBe(tick.toISOString())
    await db.sql('delete from worker_heartbeat')
  })
})

describe('資料庫不可用時', () => {
  // 連到一個沒有人在聽的埠，模擬 DB 掛掉。
  const deadUrl = 'postgres://fju_app:whatever@127.0.0.1:1/fju'

  it('回 ok=false（Route Handler 轉成 503），不是丟例外', async () => {
    const snapshot = await snapshotWith(deadUrl)
    expect(snapshot.ok).toBe(false)
    expect(snapshot.schemaVersion).toBeNull()
  })

  it('回應裡沒有主機、埠、使用者或密碼', async () => {
    const snapshot = await snapshotWith(deadUrl)
    const serialized = JSON.stringify(snapshot)
    for (const secret of ['whatever', '127.0.0.1', 'fju_app', 'postgres://', ':1/']) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('壞掉時仍然回得出版本與 commit，讓部署腳本能分辨「舊版還活著」', async () => {
    const snapshot = await snapshotWith(deadUrl)
    expect(Object.keys(snapshot)).toEqual(CONTRACT_KEYS)
    expect(snapshot.version).toBe('9.9.9')
    expect(snapshot.commit).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  })
})

describe('schema_meta 還沒有 schema_version 時', () => {
  it('回 null，不是丟錯（migration 還沒寫進去的那一瞬間）', async () => {
    const fresh = await createIsolatedDatabase({ label: 'health-nometa', setup: migratedSchema })
    try {
      const url = new URL(TEST_DATABASE_URL)
      url.searchParams.set('options', `-c search_path=${fresh.schemaName}`)
      const snapshot = await snapshotWith(url.toString())
      expect(snapshot.ok).toBe(true)
      expect(snapshot.schemaVersion).toBeNull()
    } finally {
      await fresh.close()
    }
  })
})
