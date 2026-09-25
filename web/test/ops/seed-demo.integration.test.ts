import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ANONYMOUS } from '@/application/accounts'
import { PgPublicItemQuery } from '@/infrastructure/items/pg-public-items'
import { assertTestDatabaseReachable, createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '../db'
import { migratedSchema } from '../migrations'

/**
 * 票 32（#281）：web/scripts/seed-demo.mjs 在真的資料庫上灌示範資料、再清掉。
 *
 * 真的跑腳本（子程序），每一步回資料庫核對：
 * - 只准測試站（正式站在連資料庫前就拒絕，見 seed-demo-guard.test.ts；這裡再確認一次什麼都沒寫）。
 * - 建出來的東西前台看得到（訪客看得到公開公告與封面）、示範帳號登不進來（沒有密碼）。
 * - 冪等：重跑不多寫任何一列；遺失的實體檔會補回。
 * - --remove 只刪示範資料：先放一批「真資料」（另一屆、另一個帳號、一則公告），清完它們原封不動；
 *   不可變表的 trigger 清完後照樣擋；真資料引用示範資料時整批不刪。
 */

const webRoot = path.join(import.meta.dirname, '..', '..')
const ANCHOR = '2026-09-25'

let db: IsolatedDatabase
let schemaUrl: string
let filesRoot: string

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'seed-demo', setup: migratedSchema })
  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)
  schemaUrl = url.toString()
  filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-seed-demo-files-'))
})

afterAll(async () => {
  await db?.close()
  if (filesRoot) fs.rmSync(filesRoot, { recursive: true, force: true })
})

function runSeed(args: string[] = [], env: Record<string, string | undefined> = {}) {
  const result = spawnSync('node', ['scripts/seed-demo.mjs', ...args], {
    cwd: webRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL_OWNER: schemaUrl, FJU_SITE: 'test', FILES_ROOT: filesRoot, DEMO_ANCHOR_DATE: ANCHOR, ...env },
    timeout: 60_000,
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** 每張表的筆數（冪等與「只刪示範資料」都拿它比）。 */
async function tableCounts(): Promise<Record<string, number>> {
  const tables = await db.sql(
    `select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
    [db.schemaName],
  )
  const counts: Record<string, number> = {}
  for (const r of tables.rows) {
    const name = String(r.table_name)
    const c = await db.sql(`select count(*)::int as n from "${name}"`)
    counts[name] = Number(c.rows[0]!.n)
  }
  return counts
}

function filesOnDisk(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(path.relative(filesRoot, full))
    }
  }
  walk(filesRoot)
  return out.sort()
}

const clock = { now: async () => new Date(`${ANCHOR}T12:00:00+08:00`) }

/** 「真資料」：另一屆、一位真的管理員、一則那一屆的公開公告（直接寫表，跟示範資料無關）。 */
async function seedRealData() {
  const admin = await db.sql(
    `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), '真的管理員', 'real-admin@example.test', true, now(), 'active') returning id`,
  )
  const adminId = String(admin.rows[0]!.id)
  const cohort = await db.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind, is_default_working, is_registration_open)
     values (gen_random_uuid(), 'REAL-115', '真的 115 屆', 'active', '2027-06-30', 'system', true, true) returning id`,
  )
  const cohortId = String(cohort.rows[0]!.id)
  const item = await db.sql(
    `insert into managed_items (id, cohort_id, placement, audience_kind, title, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, 'news', 'public', '真的公告', 'user', $2) returning id`,
    [cohortId, adminId],
  )
  const itemId = String(item.rows[0]!.id)
  await db.sql(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id) values (gen_random_uuid(), $1, 1, '真的公告', '', '', $2)`,
    [itemId, adminId],
  )
  await db.sql(
    `insert into audit_events (id, actor_kind, actor_user_id, action, target_type, target_id, scope, cohort_id, real_at, business_at)
     values (gen_random_uuid(), 'user', $1, 'item.publish', 'managed_item', $2, 'cohort', $3, now(), now())`,
    [adminId, itemId, cohortId],
  )
  return { adminId, cohortId, itemId }
}

describe('seed-demo.mjs', () => {
  let real: Awaited<ReturnType<typeof seedRealData>>
  let afterFirst: Record<string, number>

  it('非測試站：拒絕，而且一列都沒寫', async () => {
    const before = await tableCounts()
    const r = runSeed([], { FJU_SITE: 'prod' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('拒絕執行')
    expect(await tableCounts()).toEqual(before)
  })

  it('第一次：建出示範屆別與它底下的內容，兩個全系旗標不動', async () => {
    real = await seedRealData()
    const r = runSeed()
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('示範資料已建立')

    const cohort = await db.sql(`select code, name, status, is_default_working, is_registration_open from cohorts where code = 'DEMO-114'`)
    expect(cohort.rows[0]).toMatchObject({ name: '示範 114 屆', status: 'active', is_default_working: false, is_registration_open: false })
    // 真的那一屆還是預設工作屆別與開放註冊屆別。
    const flags = await db.sql(`select code from cohorts where is_default_working or is_registration_open`)
    expect(flags.rows.map((x) => x.code)).toEqual(['REAL-115'])

    const counts = await db.sql(
      `select (select count(*) from groups g join cohorts c on c.id = g.cohort_id where c.code = 'DEMO-114')::int as groups,
              (select count(*) from industry_opportunities where status = 'published')::int as industry,
              (select count(*) from submission_versions)::int as submissions,
              (select count(*) from evaluations)::int as evaluations,
              (select count(*) from signoff_package_versions)::int as signoffs`,
    )
    expect(counts.rows[0]).toMatchObject({ groups: 9, industry: 4 })
    expect(Number(counts.rows[0]!.submissions)).toBeGreaterThan(0)
    expect(Number(counts.rows[0]!.evaluations)).toBeGreaterThan(0)
    expect(Number(counts.rows[0]!.signoffs)).toBeGreaterThan(0)
    afterFirst = await tableCounts()
  })

  it('示範帳號登不進來：一律 @demo.invalid、沒有任何密碼；建立者是停用、沒有角色', async () => {
    const users = await db.sql(`select email, status from users where email like '%@demo.invalid'`)
    expect(users.rowCount).toBeGreaterThan(50)
    const passwords = await db.sql(
      `select count(*)::int as n from accounts a join users u on u.id = a.user_id where u.email like '%@demo.invalid'`,
    )
    expect(Number(passwords.rows[0]!.n)).toBe(0)
    const office = await db.sql(
      `select u.status, (select count(*) from role_assignments r where r.user_id = u.id)::int as roles
         from users u where u.email = 'office@demo.invalid'`,
    )
    expect(office.rows[0]).toMatchObject({ status: 'disabled', roles: 0 })
    // 沒發任何通知、沒排任何到期工作。
    const quiet = await db.sql(
      `select (select count(*) from domain_events)::int as events, (select count(*) from due_work)::int as due, (select count(*) from notifications)::int as notes`,
    )
    expect(quiet.rows[0]).toMatchObject({ events: 0, due: 0, notes: 0 })
  })

  it('訪客在前台看得到示範公告（照原型順序）與封面，封面檔真的在 FILES_ROOT', async () => {
    const query = new PgPublicItemQuery(clock, () => db.pool)
    const news = await query.list(ANONYMOUS, 'news', { limit: 20 })
    const titles = news.map((n) => n.title)
    expect(titles.slice(0, 3)).toEqual([
      '114 學年度專題分組作業與指導老師意願調查開始受理',
      '專題規則修訂：系統驗收評分項目調整為七項',
      '第 31 屆全國大專校院資訊應用服務創新競賽開始報名',
    ])
    // 只給本屆學生的那一則，訪客看不到。
    expect(titles).not.toContain('說明會出席與分組意向登記期限提醒')
    expect(news[0]!.cover).not.toBeNull()
    expect(news[0]!.attachments.map((a) => a.name)).toEqual(['114 專題分組作業說明.pdf', '指導老師名單與研究領域.pdf'])

    const rules = await query.fullText(ANONYMOUS, 'rules')
    expect(rules.map((r) => r.title)[0]).toBe('一、專題課程目的')
    expect(rules).toHaveLength(9)

    const stored = await db.sql(`select storage_key, checksum from stored_files where status = 'stored'`)
    expect(stored.rowCount).toBeGreaterThan(0)
    expect(filesOnDisk()).toEqual(stored.rows.map((r) => String(r.storage_key)).sort())
  })

  it('重跑：已存在就不動（每張表筆數一樣），遺失的實體檔會補回', async () => {
    const [victim] = filesOnDisk()
    fs.rmSync(path.join(filesRoot, victim!))
    const r = runSeed()
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('示範資料已存在')
    expect(r.stdout).toContain('補回 1 個')
    expect(await tableCounts()).toEqual(afterFirst)
    expect(fs.existsSync(path.join(filesRoot, victim!))).toBe(true)
  })

  it('真資料引用示範資料時，--remove 整批不刪、說明是哪一條外鍵', async () => {
    // 把一位示範學生塞進真的那一屆的一個組（真資料引用示範帳號）。
    const group = await db.sql(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
      [real.cohortId],
    )
    const groupId = String(group.rows[0]!.id)
    await db.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       select gen_random_uuid(), $1, $2, id, now(), 'system' from users where email = '411410411@demo.invalid'`,
      [groupId, real.cohortId],
    )
    const before = await tableCounts()
    const r = runSeed(['--remove'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('清不掉')
    expect(r.stderr).toContain('什麼都沒刪')
    expect(await tableCounts()).toEqual(before)

    // 解除那筆關係（直接刪測試造的列），之後就清得掉。
    await db.sql(`delete from group_memberships where group_id = $1`, [groupId])
    await db.sql(`delete from groups where id = $1`, [groupId])
  })

  it('--remove：示範資料全部清掉（含實體檔），真資料一列不少，不可變表照樣擋', async () => {
    // 管理員在後台改過示範項目的截止，會排一件截止快照（due_work 沒有外鍵，要跟著清掉，不然 worker 會去處理不存在的項目）。
    await db.sql(
      `insert into due_work (id, kind, subject_type, subject_id, due_business_at)
       select gen_random_uuid(), 'deadline_snapshot', 'managed_item', m.id, now()
         from managed_items m join cohorts c on c.id = m.cohort_id where c.code = 'DEMO-114' and m.due_at is not null limit 1`,
    )
    const realDue = await db.sql(
      `insert into due_work (id, kind, subject_type, subject_id, due_business_at) values (gen_random_uuid(), 'deadline_snapshot', 'managed_item', $1, now()) returning id`,
      [real.itemId],
    )
    const r = runSeed(['--remove'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('示範資料已清除')

    const left = await db.sql(
      `select (select count(*) from cohorts where code = 'DEMO-114')::int as cohorts,
              (select count(*) from users where email like '%@demo.invalid')::int as users,
              (select count(*) from stored_files)::int as files,
              (select count(*) from industry_opportunities)::int as industry`,
    )
    expect(left.rows[0]).toMatchObject({ cohorts: 0, users: 0, files: 0, industry: 0 })
    expect(filesOnDisk()).toEqual([])

    // 真資料：那一屆、那位管理員、那則公告與它的版本、那筆屆別範圍的稽核都還在。
    const kept = await db.sql(
      `select (select count(*) from cohorts where id = $1)::int as cohort,
              (select count(*) from users where id = $2)::int as admin,
              (select count(*) from managed_items where id = $3)::int as item,
              (select count(*) from item_versions where item_id = $3)::int as versions,
              (select count(*) from audit_events where cohort_id = $1)::int as audit`,
      [real.cohortId, real.adminId, real.itemId],
    )
    expect(kept.rows[0]).toMatchObject({ cohort: 1, admin: 1, item: 1, versions: 1, audit: 1 })
    const due = await db.sql(`select id from due_work`)
    expect(due.rows.map((x) => x.id)).toEqual([realDue.rows[0]!.id])

    // trigger 在交易結束後都回到啟用：不可變表連 owner 都刪不掉。
    const disabled = await db.sql(
      `select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and not t.tgisinternal and t.tgenabled = 'D'`,
      [db.schemaName],
    )
    expect(Number(disabled.rows[0]!.n)).toBe(0)
    await expect(db.sql(`delete from item_versions where item_id = $1`, [real.itemId])).rejects.toThrow(/不可變/)

    // 稽核留兩筆全系範圍的紀錄：建立與清除。
    const audit = await db.sql(`select action from audit_events where payload->>'source' = 'seed:demo' order by real_at`)
    expect(audit.rows.map((x) => x.action)).toEqual(['demo.seed', 'demo.remove'])
  })

  it('清完再跑 --remove：沒事做；再建一次也建得回來', async () => {
    const again = runSeed(['--remove'])
    expect(again.code, again.stderr).toBe(0)
    expect(again.stdout).toContain('沒有示範資料')

    const reseed = runSeed()
    expect(reseed.code, reseed.stderr).toBe(0)
    expect(reseed.stdout).toContain('示範資料已建立')
  })
})
