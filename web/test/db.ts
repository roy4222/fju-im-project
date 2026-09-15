/**
 * 整合測試的資料庫 harness（S00-03；T3 = application 用例＋真 PostgreSQL，Roy 2026-09-15 採預設）。
 *
 * 隔離方式是「每個測試一份自己的 PostgreSQL schema」：
 * 同一個資料庫、同一份 migration，但各自的 `search_path` 指向自己的 schema，
 * 所以兩個測試同時寫同名的表不會互相污染，測完把 schema `DROP ... CASCADE` 就乾淨了。
 * 比起每個測試開一個資料庫，這樣快很多，也還是打真的 PostgreSQL。
 */
import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@/infrastructure/db/schema'

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL_OWNER ??
  'postgres://fju_owner:fju_local_dev@127.0.0.1:55432/fju'

let counter = 0

function nextSchemaName(label?: string): string {
  counter += 1
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const safeLabel = (label ?? 'test').toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').slice(0, 20)
  return `t_${safeLabel}_${process.pid}_${counter}_${suffix}`
}

export type IsolatedDatabase = {
  /** 這個測試專屬的 schema 名稱。 */
  readonly schemaName: string
  /** 連線池；每條連線的 `search_path` 都已指向本 schema。 */
  readonly pool: Pool
  /** drizzle 實例，綁在同一個池上。 */
  readonly db: ReturnType<typeof drizzle<typeof schema>>
  /** 直接下 SQL。 */
  sql(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
  /** 借一條連線（要自己 release），用來手動控制交易。 */
  connect(): Promise<PoolClient>
  /** 丟掉整個 schema 並關閉連線池。 */
  close(): Promise<void>
}

/**
 * 開一個隔離的 schema。
 * `setup` 會在 schema 建好、`search_path` 設好之後執行，通常拿來套 migration。
 */
export async function createIsolatedDatabase(options?: {
  label?: string
  setup?: (db: IsolatedDatabase) => Promise<void>
}): Promise<IsolatedDatabase> {
  const schemaName = nextSchemaName(options?.label)

  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
  try {
    await admin.query(`CREATE SCHEMA "${schemaName}"`)
  } finally {
    await admin.end()
  }

  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 8,
    // 每條新連線都先把 search_path 指到自己的 schema。
    options: `-c search_path=${schemaName},public`,
  })

  const isolated: IsolatedDatabase = {
    schemaName,
    pool,
    db: drizzle(pool, { schema }),
    async sql(text, values) {
      const result = await pool.query(text, values as never[])
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 }
    },
    connect() {
      return pool.connect()
    },
    async close() {
      await pool.end()
      const cleanup = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      } finally {
        await cleanup.end()
      }
    },
  }

  if (options?.setup) {
    try {
      await options.setup(isolated)
    } catch (error) {
      await isolated.close()
      throw error
    }
  }

  return isolated
}

/** 用完自動清掉的版本。 */
export async function withIsolatedDatabase<T>(
  options: { label?: string; setup?: (db: IsolatedDatabase) => Promise<void> },
  body: (db: IsolatedDatabase) => Promise<T>,
): Promise<T> {
  const isolated = await createIsolatedDatabase(options)
  try {
    return await body(isolated)
  } finally {
    await isolated.close()
  }
}

/** 在一個交易裡跑完 body；body 丟例外就 ROLLBACK。 */
export async function inTransaction<T>(
  isolated: IsolatedDatabase,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await isolated.connect()
  try {
    await client.query('BEGIN')
    const result = await body(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** 測試環境有沒有起 postgres；沒起的話測試要明確失敗，不要靜靜跳過。 */
export async function assertTestDatabaseReachable(): Promise<void> {
  const probe = new Pool({ connectionString: TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 3_000 })
  try {
    await probe.query('select 1')
  } catch (error) {
    throw new Error(
      `連不到測試資料庫 ${TEST_DATABASE_URL.replace(/:[^:@]*@/, ':***@')}。` +
        '先在 repo 根跑 `docker compose up -d postgres`。原因：' +
        (error instanceof Error ? error.message : String(error)),
    )
  } finally {
    await probe.end()
  }
}
