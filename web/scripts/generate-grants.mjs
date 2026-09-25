#!/usr/bin/env node
/**
 * 從權限矩陣產生 GRANT 與不可變 trigger 的 SQL（契約 01 §5：「migration 由本表產生 GRANT」）。
 *
 *   node scripts/generate-grants.mjs            # 印出每一支 migration 的 SQL
 *   node scripts/generate-grants.mjs --write    # 寫回各 migration 的標記區塊
 *   node scripts/generate-grants.mjs --check    # 核對 migration 與矩陣一致（CI 用）
 *
 * 矩陣的每一列有 `slice`，決定這張表的 GRANT 產生到哪一支 migration：
 * S00 的表在 0001、S01 新增的表在 0002。每一支 migration 只處理自己那一批表，
 * 舊的 migration 不會因為後面切片新增表而被改動（已部署的 migration 不能動）。
 *
 * migration 裡用兩行標記把產生區塊框起來，人不要手改那一段——改矩陣再跑 --write。
 *
 * 舊表後來加欄（例如票 39 的 0011 給 `showcase_entries` 加獎項欄）：列的 `update` 陣列寫**最後**的樣子
 * （roles 測試照它逐欄驗），新加的欄另外記在 `updateAddedIn: { "<切片>": [欄...] }`。
 * 原切片的 migration 產生時扣掉這些欄（已部署的 0010 一字不變），新切片的 migration 只產生
 * `GRANT UPDATE (新欄) ON 表`——不 REVOKE、不碰其他權限。
 */
import fs from 'node:fs'
import path from 'node:path'

const webRoot = path.join(import.meta.dirname, '..')
const matrixPath = path.join(webRoot, 'src/infrastructure/db/permissions/matrix.json')

/** 切片 → 放 GRANT 產生區塊的 migration。新切片新增表時在這裡補一列。 */
const MIGRATION_BY_SLICE = {
  S00: 'drizzle/0001_s00_roles_and_immutability.sql',
  S01: 'drizzle/0002_s01_accounts_and_files.sql',
  S02: 'drizzle/0003_s02_timeline_and_events.sql',
  S03: 'drizzle/0004_s03_groups.sql',
  S04: 'drizzle/0005_s04_items.sql',
  S05: 'drizzle/0006_s05_submissions.sql',
  S06: 'drizzle/0007_s06_advisors.sql',
  S07: 'drizzle/0008_s07_group_submissions.sql',
  S10: 'drizzle/0009_s10_grading.sql',
  S11: 'drizzle/0010_s11_signoff_showcase.sql',
  T39: 'drizzle/0011_t39_showcase_stage_fields.sql',
}

const BEGIN = '-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>'
const END = '-- <<< 產生區塊結束 <<<'
const BREAK = '--> statement-breakpoint'

const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'))
const { app, backup } = matrix.roles

const list = (rows) => rows.map((r) => r.table).join(', ')

/** 這一列在 `slice` 之後的切片才加的可更新欄。 */
const addedLater = (row) => new Set(Object.values(row.updateAddedIn ?? {}).flat())

/** 原切片看到的列：可更新欄扣掉之後才加的（`'all'`／`'none'` 不受影響）。 */
function asOfOwnSlice(row) {
  if (!Array.isArray(row.update)) return row
  const later = addedLater(row)
  return { ...row, update: row.update.filter((c) => !later.has(c)) }
}

/** 只有「舊表加欄」的切片：逐表補 UPDATE 欄權限，其他一律不動。 */
function generateAmendments(amendments) {
  const statements = amendments.map(
    ({ row, columns }) =>
      `-- ${row.table}（${row.slice} 建）加欄後補的可更新欄；其餘權限照 ${row.slice} 的產生區塊\nGRANT UPDATE (${columns.join(', ')}) ON ${row.table} TO ${app};`,
  )
  return `${BEGIN}\n${statements.join(`\n${BREAK}\n\n`)}\n${END}`
}

function generate(tables) {
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

for (const row of matrix.tables) {
  for (const [slice, columns] of Object.entries(row.updateAddedIn ?? {})) {
    const missing = columns.filter((c) => !Array.isArray(row.update) || !row.update.includes(c))
    if (missing.length > 0) {
      console.error(`matrix.json 的 ${row.table}.updateAddedIn.${slice} 有 ${missing.join('、')}，但 update 陣列裡沒有。`)
      process.exit(1)
    }
  }
}

const amendmentsOf = (slice) =>
  matrix.tables
    .filter((t) => t.updateAddedIn?.[slice]?.length)
    .map((row) => ({ row, columns: row.updateAddedIn[slice] }))

const slices = [
  ...new Set([...matrix.tables.map((t) => t.slice), ...matrix.tables.flatMap((t) => Object.keys(t.updateAddedIn ?? {}))]),
].sort()
const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--write') ? 'write' : 'print'
let failed = false

for (const slice of slices) {
  const relative = MIGRATION_BY_SLICE[slice]
  if (!relative) {
    console.error(`matrix.json 有 slice "${slice}"，但 generate-grants.mjs 的 MIGRATION_BY_SLICE 沒有對應的 migration。`)
    process.exit(1)
  }

  const migrationPath = path.join(webRoot, relative)
  const own = matrix.tables.filter((t) => t.slice === slice).map(asOfOwnSlice)
  const amendments = amendmentsOf(slice)
  if (own.length > 0 && amendments.length > 0) {
    console.error(`切片 ${slice} 同時建新表又給舊表加欄；產生器目前只支援其中一種，請分開。`)
    process.exit(1)
  }
  const generated = own.length > 0 ? generate(own) : generateAmendments(amendments)
  const migration = fs.readFileSync(migrationPath, 'utf8')
  const beginAt = migration.indexOf(BEGIN)
  const endAt = migration.indexOf(END)

  if (beginAt === -1 || endAt === -1) {
    console.error(`${relative} 裡找不到產生區塊的標記。`)
    process.exit(1)
  }

  const current = migration.slice(beginAt, endAt + END.length)

  if (mode === 'check') {
    if (current === generated) {
      console.log(`${relative} 的 GRANT 區塊與權限矩陣一致（${slice}）。`)
    } else {
      console.error(`${relative} 的 GRANT 區塊與 permissions/matrix.json 不一致（${slice}）。`)
      console.error('改矩陣之後請跑 `pnpm -C web db:grants --write`，不要手改 migration 的產生區塊。')
      failed = true
    }
  } else if (mode === 'write') {
    fs.writeFileSync(migrationPath, migration.slice(0, beginAt) + generated + migration.slice(endAt + END.length))
    console.log(`已更新 ${relative} 的產生區塊（${slice}）。`)
  } else {
    console.log(`-- ${relative}（${slice}）`)
    console.log(generated)
    console.log('')
  }
}

process.exit(failed ? 1 : 0)
