import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool, type PoolConfig } from 'pg'
import * as schema from '@/infrastructure/db/schema'

const DEFAULT_POOL_MAX = 10

/**
 * 應用連線（角色 `fju_app`，契約 01 §5）。migration 用的 owner 連線是另一條，
 * 由 migrate 容器帶 `DATABASE_URL_OWNER`（S00-04／S00-07）。
 *
 * 上限 `DB_POOL_MAX`（預設 10）：app 與 worker 共用這個檔，worker 容器設 2
 * （設計方案 §5.1 連線分配表）。值不是正整數就直接報錯，不默默退回預設。
 */
export function poolConfigFromEnv(env: Record<string, string | undefined>): PoolConfig {
  const url = env.DATABASE_URL
  if (!url) throw new Error('缺少 DATABASE_URL')
  return {
    connectionString: url,
    max: poolMax(env.DB_POOL_MAX),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  }
}

function poolMax(raw: string | undefined): number {
  const value = raw?.trim()
  if (!value) return DEFAULT_POOL_MAX
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`DB_POOL_MAX 必須是正整數，拿到「${raw}」`)
  }
  return Number(value)
}

/**
 * 池掛在 `globalThis`：Next 會把這個檔分別打包進頁面與 Route Handler，模組層級的變數
 * 各有一份，`DB_POOL_MAX=3` 實測會開到 6 條。掛在程序共用的物件上才是「一個程序一個池」。
 * 以連線設定為鍵：設定變了（只有測試會在同一程序換 `DATABASE_URL`）就換新池、關掉舊池。
 */
const holder = globalThis as typeof globalThis & { __fjuDbPool?: { key: string; pool: Pool } }

export function getPool(): Pool {
  const config = poolConfigFromEnv(process.env)
  const key = `${config.max}|${config.connectionString}`
  const current = holder.__fjuDbPool
  if (current?.key === key) return current.pool
  if (current) void current.pool.end().catch(() => undefined)
  const pool = new Pool(config)
  // 閒置連線被 PostgreSQL 斷掉時 pg 會發 'error'；沒有 listener 會讓整個程序崩潰。
  pool.on('error', (error) => console.error('[db] 閒置連線發生錯誤', error.message))
  holder.__fjuDbPool = { key, pool }
  return pool
}

export function getDb() {
  return drizzle(getPool(), { schema })
}

export type Db = ReturnType<typeof getDb>
