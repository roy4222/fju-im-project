#!/usr/bin/env node
/**
 * 套用 migration（契約 01 §12；Compose 的 migrate 服務跑這支）。
 *
 * 用 **owner** 連線（`DATABASE_URL_OWNER`）——app 的 `fju_app` 沒有 DDL 權限。
 * 跑完把最後一支 migration 的名字寫進 `schema_meta.schema_version`，`/api/health` 讀它。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

const webRoot = path.join(import.meta.dirname, '..')
const migrationsFolder = path.join(webRoot, 'drizzle')

const url = process.env.DATABASE_URL_OWNER
if (!url) {
  console.error('缺少 DATABASE_URL_OWNER（migration 要用 owner 連線，fju_app 沒有 DDL 權限）。')
  process.exit(1)
}

const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'))
const latestTag = [...journal.entries].sort((a, b) => a.idx - b.idx).at(-1)?.tag
if (!latestTag) {
  console.error('drizzle/meta/_journal.json 裡沒有任何 migration。')
  process.exit(1)
}

const pool = new Pool({ connectionString: url, max: 1 })
try {
  await migrate(drizzle(pool), { migrationsFolder, migrationsTable: '__drizzle_migrations', migrationsSchema: 'public' })
  await pool.query(
    `insert into schema_meta (key, value, updated_at) values ('schema_version', $1, now())
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [latestTag],
  )
  console.log(`migration 完成；schema_meta.schema_version = ${latestTag}`)
  // ops/deploy.sh 從這一行取出要比對的 schemaVersion（契約 05 §3 健康判定）。
  console.log(`SCHEMA_VERSION=${latestTag}`)
} finally {
  await pool.end()
}
