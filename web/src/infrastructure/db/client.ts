import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '@/infrastructure/db/schema'

/**
 * 應用連線（角色 `fju_app`，契約 01 §5）。migration 用的 owner 連線是另一條，
 * 由 migrate 容器帶 `DATABASE_URL_OWNER`（S00-04／S00-07）。
 */
function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('缺少 DATABASE_URL')
  return url
}

let pool: Pool | undefined

export function getPool(): Pool {
  pool ??= new Pool({ connectionString: connectionString() })
  return pool
}

export function getDb() {
  return drizzle(getPool(), { schema })
}

export type Db = ReturnType<typeof getDb>
