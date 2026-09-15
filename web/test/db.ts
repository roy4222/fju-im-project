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

/**
 * 以 runtime 角色（`fju_app`／`fju_backup`）連到同一個隔離 schema。
 *
 * 角色由 migration 0001 建立但不設密碼（密碼是維運的事，契約 05 §6），
 * 所以這裡先用 owner 連線幫它設一個本機測試用的密碼再連。
 */
export async function poolAsRole(
  isolated: IsolatedDatabase,
  role: 'fju_app' | 'fju_backup',
  password = process.env[`TEST_${role.toUpperCase()}_PASSWORD`] ?? `${role}_local_test`,
): Promise<Pool> {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
  try {
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password.replaceAll("'", "''")}'`)
  } finally {
    await admin.end()
  }

  const url = new URL(TEST_DATABASE_URL)
  url.username = role
  url.password = password
  return new Pool({
    connectionString: url.toString(),
    max: 4,
    options: `-c search_path=${isolated.schemaName}`,
  })
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

/**
 * 開一個**獨立的資料庫**（不是 schema），跑完丟掉。
 *
 * 大部分測試用隔離 schema 就夠了，但「真的用 drizzle migrator 跑一次、再跑一次確認 no-op」
 * 必須讓 migration SQL 裡寫死的 `"public"."users"` 解析得到，所以要一個自己的資料庫。
 * `fju_owner` 在本機與 CI 都有 CREATEDB。
 */
export async function withTemporaryDatabase<T>(
  label: string,
  body: (url: string) => Promise<T>,
): Promise<T> {
  const name = nextSchemaName(label)
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.end()
  }

  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${name}`

  try {
    return await body(url.toString())
  } finally {
    const cleanup = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
    try {
      // 還連著的話 DROP 會失敗，先把其他連線踢掉。
      await cleanup.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [name],
      )
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}"`)
    } finally {
      await cleanup.end()
    }
  }
}
