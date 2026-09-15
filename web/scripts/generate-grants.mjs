#!/usr/bin/env node
/**
 * 從權限矩陣產生 GRANT 與不可變 trigger 的 SQL（契約 01 §5：「migration 由本表產生 GRANT」）。
 *
 *   node scripts/generate-grants.mjs            # 印出 SQL
 *   node scripts/generate-grants.mjs --write    # 寫回 migration 的標記區塊
 *   node scripts/generate-grants.mjs --check    # 核對 migration 與矩陣一致（CI 用）
 *
 * migration 裡用兩行標記把產生區塊框起來，人不要手改那一段——改矩陣再跑 --write。
 */
import fs from 'node:fs'
import path from 'node:path'

const webRoot = path.join(import.meta.dirname, '..')
const matrixPath = path.join(webRoot, 'src/infrastructure/db/permissions/matrix.json')
const migrationPath = path.join(webRoot, 'drizzle/0001_s00_roles_and_immutability.sql')

const BEGIN = '-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>'
const END = '-- <<< 產生區塊結束 <<<'
const BREAK = '--> statement-breakpoint'

const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'))
const { app, backup } = matrix.roles
const tables = matrix.tables

const list = (rows) => rows.map((r) => r.table).join(', ')

function generate() {
  const statements = []

  statements.push(
    `-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。\nREVOKE ALL ON ${list(tables)}\n  FROM ${app}, ${backup};`,
  )

  const selectable = tables.filter((t) => t.select)
  if (selectable.length > 0) {
    statements.push(`GRANT SELECT ON ${list(selectable)} TO ${app};`)
  }

  const insertable = tables.filter((t) => t.insert)
  if (insertable.length > 0) {
    statements.push(`GRANT INSERT ON ${list(insertable)} TO ${app};`)
  }

  const fullUpdate = tables.filter((t) => t.update === 'all')
  if (fullUpdate.length > 0) {
    statements.push(`GRANT UPDATE ON ${list(fullUpdate)} TO ${app};`)
  }

  for (const t of tables.filter((t) => Array.isArray(t.update))) {
    statements.push(`-- ${t.note}\nGRANT UPDATE (${t.update.join(', ')}) ON ${t.table} TO ${app};`)
  }

  const deletable = tables.filter((t) => t.delete)
  if (deletable.length > 0) {
    statements.push(`GRANT DELETE ON ${list(deletable)} TO ${app};`)
  }

  statements.push(
    `-- 備份角色讀全庫；唯一能寫的 backup_runs 在 S12 才建（matrix.json 的 backupWrites 記著）。\nGRANT pg_read_all_data TO ${backup};`,
  )

  const immutable = tables.filter((t) => t.immutable)
  if (immutable.length > 0) {
    statements.push(
      `-- 不可變表的第二層保護：除了不給 UPDATE／DELETE，trigger 也一律拒絕。\nCREATE OR REPLACE FUNCTION fju_reject_mutation() RETURNS trigger\nLANGUAGE plpgsql AS $$\nBEGIN\n  RAISE EXCEPTION '% 是不可變表，不接受 %（契約 01 §5）', TG_TABLE_NAME, TG_OP\n    USING ERRCODE = 'restrict_violation';\nEND $$;`,
    )
    for (const t of immutable) {
      statements.push(
        `DROP TRIGGER IF EXISTS ${t.table}_immutable_row ON ${t.table};`,
        `CREATE TRIGGER ${t.table}_immutable_row\n  BEFORE UPDATE OR DELETE ON ${t.table}\n  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();`,
        `DROP TRIGGER IF EXISTS ${t.table}_immutable_truncate ON ${t.table};`,
        `CREATE TRIGGER ${t.table}_immutable_truncate\n  BEFORE TRUNCATE ON ${t.table}\n  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();`,
      )
    }
  }

  return `${BEGIN}\n${statements.join(`\n${BREAK}\n\n`)}\n${END}`
}

const generated = generate()
const migration = fs.readFileSync(migrationPath, 'utf8')
const beginAt = migration.indexOf(BEGIN)
const endAt = migration.indexOf(END)

if (beginAt === -1 || endAt === -1) {
  console.error(`${path.relative(webRoot, migrationPath)} 裡找不到產生區塊的標記。`)
  process.exit(1)
}

const current = migration.slice(beginAt, endAt + END.length)

if (process.argv.includes('--check')) {
  if (current === generated) {
    console.log('migration 的 GRANT 區塊與權限矩陣一致。')
    process.exit(0)
  }
  console.error('migration 的 GRANT 區塊與 permissions/matrix.json 不一致。')
  console.error('改矩陣之後請跑 `pnpm -C web db:grants --write`，不要手改 migration 的產生區塊。')
  process.exit(1)
}

if (process.argv.includes('--write')) {
  fs.writeFileSync(migrationPath, migration.slice(0, beginAt) + generated + migration.slice(endAt + END.length))
  console.log(`已更新 ${path.relative(webRoot, migrationPath)} 的產生區塊。`)
  process.exit(0)
}

console.log(generated)
