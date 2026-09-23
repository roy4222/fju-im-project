/**
 * 在測試用的隔離 schema 裡套 migration。
 *
 * 正式環境走 `scripts/migrate.mjs`（drizzle 的 migrator＋追蹤表）；測試這邊直接依
 * journal 順序執行純 SQL，因為每個測試都是全新的空 schema，不需要追蹤表。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { IsolatedDatabase } from './db'

const drizzleDir = path.join(import.meta.dirname, '..', 'drizzle')

type JournalEntry = { idx: number; tag: string }

export function migrationTags(): string[] {
  const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[]
  }
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => entry.tag)
}

export function readMigrationSql(tag: string): string {
  return fs.readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8')
}

/**
 * drizzle-kit 會把 FK 目標寫成 `"public"."users"`。正式環境本來就在 public，沒問題；
 * 但測試是在自己的 schema 裡跑，寫死 public 會讓 FK 指到不存在的表，所以這裡把限定拿掉，
 * 讓它照連線的 `search_path` 解析。
 */
function unqualifyPublicSchema(sql: string): string {
  return sql.replaceAll('"public".', '')
}

/** 把一支 migration 的 SQL 拆成可逐句執行的敘述。 */
function statementsOf(tag: string): string[] {
  return unqualifyPublicSchema(readMigrationSql(tag))
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 套一支 migration。 */
export async function applyMigration(isolated: IsolatedDatabase, tag: string): Promise<void> {
  for (const statement of statementsOf(tag)) {
    await isolated.sql(statement)
  }
}

/**
 * 依 journal 順序套 migration。
 *
 * `upTo` 給的話就停在那一支（含），用來重現「前一版的資料庫」再升版
 * （契約 01 §12 的 CI 項：空庫升級、前一版 seed 庫升版）。
 */
export async function applyMigrations(isolated: IsolatedDatabase, upTo?: string): Promise<string[]> {
  const all = migrationTags()
  if (upTo !== undefined && !all.includes(upTo)) {
    throw new Error(`journal 裡沒有 migration ${upTo}`)
  }
  const tags = upTo === undefined ? all : all.slice(0, all.indexOf(upTo) + 1)
  for (const tag of tags) {
    await applyMigration(isolated, tag)
  }
  return tags
}

/** 給 `createIsolatedDatabase({ setup: migratedSchema })` 用。 */
export const migratedSchema = async (isolated: IsolatedDatabase): Promise<void> => {
  await applyMigrations(isolated)
}

/**
 * 用正式環境那支 drizzle migrator 套 migration（`scripts/migrate.mjs` 的核心）。
 *
 * 回傳這次之後 `__drizzle_migrations` 裡的筆數——第二次呼叫筆數不變就是 no-op。
 */
export async function runDrizzleMigrator(databaseUrl: string): Promise<number> {
  const { Pool } = await import('pg')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const { migrate } = await import('drizzle-orm/node-postgres/migrator')

  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: drizzleDir,
      migrationsTable: '__drizzle_migrations',
      migrationsSchema: 'public',
    })
    const applied = await pool.query('select count(*)::int as n from public.__drizzle_migrations')
    return Number(applied.rows[0].n)
  } finally {
    await pool.end()
  }
}
