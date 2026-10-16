#!/usr/bin/env node
/**
 * 量測資料集放大（共用 SH-0，設計方案 §7.4.1 第 5 步）。
 *
 *   DATABASE_URL_OWNER=… node scripts/perf/dataset.mjs x3
 *
 * 在 normal（seed-demo＋量測帳號）之上，把示範屆別 DEMO-114 的下列資料各複製兩份（×3）：
 * 本屆學生、組別與成員、發布中作業與繳交、每人通知、同意書版本。新列一律新 uuid；學號、Email、組別代碼加
 * `-p2`／`-p3` 後綴；複製出來的列彼此照原本的關係接好（例如複製的組員指向複製的組別與複製的學生）。
 * 老師、系辦、屆別、階段、檔案不複製（複製的組別仍掛原本的指導老師，老師端的量也跟著 ×3）。
 *
 * **只動下面 TABLES 列的表**；整段一個交易，任一步失敗 rollback。跑完印出每張表複製前後列數。
 * 只給隔離量測庫用（perf:db up --dataset x3 會叫它）；不要對測試站或正式站跑。
 */
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { fail, ownerUrl, parseArgs } from './db.mjs'

const COHORT_CODE = 'DEMO-114'
const COPIES = [2, 3]

const STUDENTS = `select user_id from student_identities where cohort_id = $1`
const GROUPS = `select id from groups where cohort_id = $1`
const ITEMS = `select id from managed_items where cohort_id = $1 and placement in ('submission', 'requirement') and status = 'published'`
const VERSIONS = `select v.id from signoff_package_versions v join signoff_packages p on p.id = v.package_id where p.cohort_id = $1`
const NOTIFS = `select id from notifications where cohort_id = $1 or recipient_user_id in (${STUDENTS})`

/**
 * 會動的表（依外鍵先後）。`where`：原始列的範圍（$1＝屆別 id；複製前取一次快照，複製後再數一次要剛好 ×3）。
 * `suffix`：加 -pN 的文字欄（email 加在 @ 前）。`late`：互相指向的外鍵，先填原值、全部插完再改成複製後的 id。
 * `fresh`：沒有對應原列、但要每份都不同的 uuid 欄（唯一鍵的一部分）。
 * `insertAs`＋`restore`：trigger 只准用某個初始值新建的表，先用初始值插，再依 `restore.key` 對回原列把欄位改回來。
 */
export const TABLES = [
  { table: 'users', where: `id in (${STUDENTS})`, suffix: ['email'] },
  { table: 'user_profiles', where: `user_id in (${STUDENTS})`, suffix: ['student_no', 'contact_email'] },
  { table: 'role_assignments', where: `user_id in (${STUDENTS}) and role = 'student'` },
  { table: 'student_identities', where: `cohort_id = $1`, suffix: ['student_no'] },
  { table: 'groups', where: `cohort_id = $1`, suffix: ['code'] },
  { table: 'group_memberships', where: `group_id in (${GROUPS})` },
  { table: 'group_leaders', where: `group_id in (${GROUPS})` },
  { table: 'advisor_assignments', where: `group_id in (${GROUPS})` },
  { table: 'managed_items', where: `id in (${ITEMS})`, late: ['current_content_version_id', 'current_schema_version_id'] },
  { table: 'item_versions', where: `item_id in (${ITEMS})` },
  { table: 'form_schema_versions', where: `item_id in (${ITEMS})` },
  { table: 'item_publications', where: `item_id in (${ITEMS})` },
  { table: 'item_audience_groups', where: `item_id in (${ITEMS})` },
  { table: 'item_attachments', where: `item_id in (${ITEMS})` },
  { table: 'response_rosters', where: `item_id in (${ITEMS})` },
  { table: 'submission_drafts', where: `item_id in (${ITEMS})` },
  { table: 'submission_versions', where: `item_id in (${ITEMS})`, fresh: ['request_id'] },
  { table: 'submission_files', where: `submission_version_id in (select id from submission_versions where item_id in (${ITEMS}))` },
  {
    table: 'domain_events',
    where: `id in (select event_id from approvals where version_id in (${VERSIONS}) union select event_id from notifications where id in (${NOTIFS}))`,
  },
  { table: 'notifications', where: `id in (${NOTIFS})` },
  { table: 'signoff_packages', where: `cohort_id = $1`, late: ['current_version_id'] },
  { table: 'signoff_package_versions', where: `id in (${VERSIONS})` },
  // 版本狀態的 trigger 只准新建成 collecting：先插 collecting，再照原列改回實際狀態（同 seed-demo 的順序）。
  {
    table: 'signoff_version_status',
    where: `version_id in (${VERSIONS})`,
    insertAs: { state: `'collecting'`, cause: 'null', completed_real_at: 'null' },
    restore: { key: 'version_id', cols: ['state', 'cause', 'completed_real_at'] },
  },
  { table: 'approvals', where: `version_id in (${VERSIONS})`, suffix: ['student_no_at'], fresh: ['request_id'] },
]

const q = (name) => `"${name.replace(/"/g, '""')}"`

async function columns(client, table) {
  const { rows } = await client.query(
    `select column_name, data_type, is_generated, identity_generation from information_schema.columns
      where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table],
  )
  if (rows.length === 0) throw new Error(`沒有 ${table} 這張表`)
  return rows.filter((c) => c.is_generated !== 'ALWAYS' && c.identity_generation !== 'ALWAYS')
}

function valueExpr(col, def, k) {
  const c = q(col.column_name)
  if (def.insertAs?.[col.column_name]) return def.insertAs[col.column_name]
  if (def.suffix?.includes(col.column_name)) {
    return col.column_name.includes('email')
      ? `case when ${c} is null then null else regexp_replace(${c}, '@', '-p${k}@') end`
      : `case when ${c} is null then null else ${c} || '-p${k}' end`
  }
  if (col.data_type !== 'uuid') return c
  if (def.fresh?.includes(col.column_name)) return `case when ${c} is null then null else gen_random_uuid() end`
  if (def.late?.includes(col.column_name)) return c
  return `pg_temp.perf_map(${c}, ${k})`
}

async function x3() {
  const pool = new Pool({ connectionString: ownerUrl(), max: 1 })
  const client = await pool.connect()
  try {
    await client.query('begin')
    const cohort = await client.query('select id from cohorts where code = $1', [COHORT_CODE])
    if (cohort.rowCount === 0) throw new Error(`找不到屆別 ${COHORT_CODE}（先 perf:db up --dataset normal）`)
    const cohortId = cohort.rows[0].id
    const already = await client.query(`select 1 from groups where cohort_id = $1 and code like '%-p2' limit 1`, [cohortId])
    if (already.rowCount > 0) throw new Error('已經是 x3 了（有 -p2 的組別）；要重來請 perf:db down 再 up --dataset x3。')

    await client.query(`create temp table perf_id_map (old uuid not null, k int not null, new uuid not null, primary key (old, k)) on commit drop`)
    await client.query(`create function pg_temp.perf_map(v uuid, k int) returns uuid language sql stable as
      $$ select coalesce((select new from perf_id_map m where m.old = v and m.k = perf_map.k), v) $$`)

    // 1. 先把每張表的原始列拍快照（之後插入的複製列不會混進來），並替有 id 的列配好新 id。
    const before = new Map()
    const cols = new Map()
    for (const def of TABLES) {
      cols.set(def.table, await columns(client, def.table))
      await client.query(`create temp table ${q(`orig_${def.table}`)} on commit drop as select * from ${q(def.table)} where ${def.where}`, [cohortId])
      before.set(def.table, Number((await client.query(`select count(*)::int as n from ${q(`orig_${def.table}`)}`)).rows[0].n))
      if (cols.get(def.table).some((c) => c.column_name === 'id' && c.data_type === 'uuid')) {
        for (const k of COPIES) {
          await client.query(`insert into perf_id_map select id, ${k}, gen_random_uuid() from ${q(`orig_${def.table}`)}`)
        }
      }
    }

    // 2. 依外鍵先後插入兩份複製。
    for (const k of COPIES) {
      for (const def of TABLES) {
        const list = cols.get(def.table)
        await client.query(
          `insert into ${q(def.table)} (${list.map((c) => q(c.column_name)).join(', ')})
           select ${list.map((c) => valueExpr(c, def, k)).join(', ')} from ${q(`orig_${def.table}`)}`,
        )
      }
      // 3. 互相指向的外鍵：子表都插好了，改指複製後的 id。
      for (const def of TABLES.filter((d) => d.late)) {
        const sets = def.late.map((c) => `${q(c)} = pg_temp.perf_map(${q(c)}, ${k})`).join(', ')
        await client.query(`update ${q(def.table)} t set ${sets} where t.id in (select new from perf_id_map m join ${q(`orig_${def.table}`)} o on o.id = m.old where m.k = ${k})`)
      }
      for (const def of TABLES.filter((d) => d.restore)) {
        const { key, cols: back } = def.restore
        const sets = back.map((c) => `${q(c)} = o.${q(c)}`).join(', ')
        await client.query(`update ${q(def.table)} t set ${sets} from ${q(`orig_${def.table}`)} o where t.${q(key)} = pg_temp.perf_map(o.${q(key)}, ${k})`)
      }
    }

    // 4. 複製後再用同一個範圍數一次。
    const report = []
    let bad = 0
    for (const def of TABLES) {
      const after = Number((await client.query(`select count(*)::int as n from ${q(def.table)} where ${def.where}`, [cohortId])).rows[0].n)
      const b = before.get(def.table)
      const ok = after === b * 3
      if (!ok) bad++
      report.push({ table: def.table, before: b, after, ok })
    }
    if (bad > 0) {
      console.table(report)
      throw new Error(`${bad} 張表複製後不是 ×3，rollback。`)
    }
    await client.query('commit')
    console.log(`資料集 x3 完成（${COHORT_CODE}）：`)
    for (const r of report) console.log(`  ${r.table.padEnd(26)} ${String(r.before).padStart(5)} → ${String(r.after).padStart(5)}  ${r.before === 0 ? '（原本就沒有）' : '×3'}`)
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseArgs(process.argv.slice(2))
  if (opts._[0] === 'x3') await x3()
  else fail('用法：dataset.mjs x3')
}
