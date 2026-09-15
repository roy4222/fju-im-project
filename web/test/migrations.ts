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

/** 依 journal 順序把全部 migration 套到這個 schema 上。 */
export async function applyMigrations(isolated: IsolatedDatabase): Promise<string[]> {
  const tags = migrationTags()
  for (const tag of tags) {
    const statements = unqualifyPublicSchema(readMigrationSql(tag))
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const statement of statements) {
      await isolated.sql(statement)
    }
  }
  return tags
}

/** 給 `createIsolatedDatabase({ setup: migratedSchema })` 用。 */
export const migratedSchema = async (isolated: IsolatedDatabase): Promise<void> => {
  await applyMigrations(isolated)
}
