import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ANONYMOUS } from '@/application/accounts'
import { competitionStatus } from '@/application/items'
import { PgPublicItemQuery } from '@/infrastructure/items/pg-public-items'
import { PgPublicShowcaseQuery } from '@/infrastructure/showcase/pg-public-showcase'
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

/** 第一批（DEMO-114）的樣子：補第二批前後要一模一樣（補上的那則競賽公告與畢業學長姐帳號不算）。 */
async function firstBatchFingerprint() {
  const r = await db.sql(
    `select (select md5(string_agg(m.id::text || ':' || m.revision || ':' || m.status || ':' || m.updated_at::text, ',' order by m.id))
               from managed_items m join cohorts c on c.id = m.cohort_id
              where c.code = 'DEMO-114' and m.title <> '跨域設計專題成果展') as items,
            (select md5(string_agg(u.id::text || ':' || u.status || ':' || u.updated_at::text, ',' order by u.id))
               from users u where u.email like '%@demo.invalid' and u.email not like '4104105%' and u.email not like '4094105%') as users,
            (select md5(string_agg(e.id::text || ':' || e.status || ':' || e.revision, ',' order by e.id))
               from showcase_entries e join cohorts c on c.id = e.cohort_id where c.code = 'DEMO-114') as showcase,
            (select count(*) from groups g join cohorts c on c.id = g.cohort_id where c.code = 'DEMO-114')::int as groups,
            (select count(*) from submission_versions)::int as submissions,
            (select count(*) from approvals)::int as approvals,
            (select count(*) from evaluations)::int as evaluations`,
  )
  return r.rows[0]
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

  it('第一次（只建第一批＝#290 已經灌過的測試站）：建出示範屆別與它底下的內容，兩個全系旗標不動', async () => {
    real = await seedRealData()
    const r = runSeed([], { DEMO_PHASES: 'current' })
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('示範資料已建立')
    const history = await db.sql(`select count(*)::int as n from cohorts where code in ('DEMO-113', 'DEMO-112')`)
    expect(Number(history.rows[0]!.n)).toBe(0)

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
  })

  it('第一批已在時再跑：只補第二批（歷屆專題、榮譽榜、競賽），第一批一列不動', async () => {
    const before = await firstBatchFingerprint()
    const r = runSeed()
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('補上第二批')
    expect(await firstBatchFingerprint()).toEqual(before)

    // 兩個歷屆示範屆別：已封存、旗標不動。
    const cohorts = await db.sql(
      `select code, status, is_default_working, is_registration_open from cohorts where code in ('DEMO-113', 'DEMO-112') order by code`,
    )
    expect(cohorts.rows).toEqual([
      { code: 'DEMO-112', status: 'archived', is_default_working: false, is_registration_open: false },
      { code: 'DEMO-113', status: 'archived', is_default_working: false, is_registration_open: false },
    ])

    // 已發布的精選：八件，目前版本接得上、有海報；海報同時被草稿與發布的那一版引用（#293 的資料契約）。
    const showcase = await db.sql(
      `select v.title, c.code, g.code as group_code, v.poster_file_id, v.authorization_kind, v.pii_check,
              (select array_agg(r.ref_type order by r.ref_type) from file_references r
                where r.file_id = v.poster_file_id and r.released_at is null) as refs,
              (select purpose from stored_files f where f.id = v.poster_file_id) as purpose,
              (select count(*) from group_memberships m where m.group_id = e.group_id and m.valid_to is null)::int as members,
              (select count(*) from advisor_assignments a where a.group_id = e.group_id and a.valid_to is null)::int as advisors
         from showcase_entries e
         join showcase_versions v on v.id = e.current_version_id and v.entry_id = e.id
         join cohorts c on c.id = e.cohort_id
         left join groups g on g.id = e.group_id
        where e.status = 'published'
        order by c.code desc, g.code`,
    )
    expect(showcase.rowCount).toBe(8)
    expect(showcase.rows.map((x) => x.code)).toEqual([...Array(4).fill('DEMO-113'), ...Array(4).fill('DEMO-112')])
    for (const row of showcase.rows) {
      expect(row.poster_file_id, String(row.title)).not.toBeNull()
      expect(row.purpose).toBe('poster')
      expect(row.refs).toEqual(['showcase_draft', 'showcase_version'])
      expect(row.authorization_kind).toBe('external')
      expect(row.pii_check).toMatchObject({ passed: true })
      expect(row.advisors).toBe(1)
    }
    expect(showcase.rows.find((x) => x.title === '城市微光：公共資訊可讀性改善')).toMatchObject({ members: 5 })
    // 第一批（DEMO-114）的精選還是草稿。
    const drafts = await db.sql(
      `select count(*)::int as n from showcase_entries e join cohorts c on c.id = e.cohort_id where c.code = 'DEMO-114' and e.status = 'draft'`,
    )
    expect(Number(drafts.rows[0]!.n)).toBe(9)

    // 前台（#293）直接查：訪客的優秀專題是其中有獎項等級的五件（票 39，照原型 p-1、p-2、p-7、p-4、p-6）、都有海報，
    // 草稿不混進來；屆別 pill 只有兩個歷屆。沒得獎的三件（p-3、p-5、p-8）訪客打開詳情是「需要登入」。
    const showcaseQuery = new PgPublicShowcaseQuery(() => db.pool)
    const featured = await showcaseQuery.featured({ sort: 'excellent' })
    expect(featured.map((c) => [c.title, c.award, c.awardLabel])).toEqual([
      ['城市微光：公共資訊可讀性改善', 'excellent', '113 學年度校級優秀專題'],
      ['備援：中小企業備份稽核工具', 'excellent', '112 學年度校級優秀專題・全國賽佳作'],
      ['拾語：課堂討論脈絡整理器', 'merit', '113 學年度專題發表 佳作'],
      ['校園閒置空間共享媒合平台', 'merit', '113 學年度專題發表 佳作'],
      ['無障礙報名流程重構', 'merit', '112 學年度專題發表 佳作'],
    ])
    expect(featured.every((c) => c.posterFileId !== null)).toBe(true)
    expect(await showcaseQuery.cohorts({ featuredOnly: true })).toEqual(['DEMO-113', 'DEMO-112'])
    const detail = await showcaseQuery.entry(ANONYMOUS, featured[0]!.id)
    expect(detail.access === 'visible' && detail.people).toBeNull()
    const plain = await db.sql(`select e.id from showcase_entries e join showcase_versions v on v.id = e.current_version_id
                                  where v.title = '菜市場數位帳本'`)
    expect(await showcaseQuery.entry(ANONYMOUS, String(plain.rows[0]!.id))).toEqual({ access: 'need_login' })

    // 榮譽榜與競賽資訊：訪客看得到（榮譽有封面，發布日＝原型的得獎日，年份不平移）。
    const query = new PgPublicItemQuery(clock, () => db.pool)
    const honors = await query.list(ANONYMOUS, 'honor', { limit: 20 })
    expect(honors.map((h) => h.title)).toEqual([
      '全國大專校院資訊應用服務創新競賽',
      '跨域設計專題成果展',
      '校級學生專題成果競賽',
      '全國智慧製造大數據分析競賽',
      '大專校院資訊服務創新競賽 北區賽',
      '校級學生專題成果競賽',
    ])
    expect(honors.every((h) => h.cover !== null)).toBe(true)
    expect(honors.map((h) => h.publishedAt.toISOString().slice(0, 4))).toEqual(['2026', '2026', '2026', '2025', '2025', '2025'])
    // 得獎日期（票 39）＝原型的 date，不平移。
    expect(honors.map((h) => h.awardedOn)).toEqual(['2026-07-07', '2026-06-15', '2026-05-20', '2025-12-02', '2025-11-14', '2025-05-22'])
    const competitions = await query.list(ANONYMOUS, 'news', { category: '競賽資訊', limit: 20 })
    expect(competitions.map((c) => c.title)).toEqual([
      '第 31 屆全國大專校院資訊應用服務創新競賽開始報名',
      '2026 全國智慧製造大數據分析競賽入圍名單公告',
      '跨域設計專題成果展',
    ])
    // 競賽日期（票 39）跟公告同一條時間線平移（原型今天 2026-08-17 → ANCHOR 2026-09-25，+39 天），
    // 所以狀態跟原型一樣：報名中、決賽／結果、已結束。
    expect(competitions.map((c) => [c.registrationDeadline, c.eventDate])).toEqual([
      ['2026-11-11', null],
      ['2026-09-08', '2026-10-11'],
      ['2026-07-29', '2026-08-13'],
    ])
    expect(competitions.map((c) => competitionStatus(c, ANCHOR))).toEqual(['open', 'result', 'closed'])
    // 階段說明（票 39）：四段都有。
    const stages = await db.sql(
      `select s.description from cohort_stages s join cohorts c on c.id = s.cohort_id where c.code = 'DEMO-114' order by s.seq`,
    )
    expect(stages.rows.every((r) => String(r.description).length > 0)).toBe(true)
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
    // 沒發任何通知、沒排任何到期工作；唯一的事件是簽核逐人同意必須掛的 vote_recorded，而且沒有投影（背景工作不碰）。
    const quiet = await db.sql(
      `select (select count(*) from event_projections)::int as projections, (select count(*) from due_work)::int as due,
              (select count(*) from notifications)::int as notes,
              (select count(*) from domain_events where type <> 'signoff.vote_recorded')::int as other_events`,
    )
    expect(quiet.rows[0]).toMatchObject({ projections: 0, due: 0, notes: 0, other_events: 0 })

    // 簽核狀態跟逐人同意一致：已完成＝學生全同意＋主指導同意；等待指導老師＝學生全同意；其他＝收集中。
    const signoff = await db.sql(
      `select g.code, s.state,
              (select count(*) from approvals a where a.version_id = v.id and a.role = 'student' and a.result = 'agree')::int as students,
              (select count(*) from approvals a where a.version_id = v.id and a.role = 'advisor')::int as advisor,
              jsonb_array_length(v.participants -> 'students') as total
         from signoff_package_versions v join signoff_packages p on p.id = v.package_id join groups g on g.id = p.group_id
         join signoff_version_status s on s.version_id = v.id order by g.code`,
    )
    for (const row of signoff.rows) {
      const expected = Number(row.advisor) > 0 ? 'complete' : row.students === row.total ? 'teacher_pending' : 'collecting'
      expect(row.state, String(row.code)).toBe(expected)
    }
    expect(signoff.rows.map((r) => `${r.code}:${r.state}`)).toEqual([
      'G01:complete',
      'G02:teacher_pending',
      'G04:complete',
      'G05:collecting',
      'G07:collecting',
      'G08:complete',
    ])
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
    // 原型 /rules：清單是編號清單、註解是灰底框（<blockquote>），而且消毒後還在。
    expect(rules[0]!.bodyHtml).toContain('<ol><li>')
    expect(rules[0]!.bodyHtml).not.toContain('<ul>')
    expect(rules.find((r) => r.title.startsWith('四、'))!.bodyHtml).toMatch(/<blockquote><p>註一/)

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

  it('0011 之前就灌過的測試站：再跑只補票 39 的欄位（空著的才填、系辦改過的不動），重跑第二次不變', async () => {
    // 模擬「部署 0011 前已經灌好」：新欄位都是空的；另外系辦在後台改過第 2 階段的說明。
    await db.sql(`update cohort_stages set description = '' where cohort_id in (select id from cohorts where code = 'DEMO-114')`)
    await db.sql(`update cohort_stages set description = '系辦改過的說明' where seq = 2
                   and cohort_id in (select id from cohorts where code = 'DEMO-114')`)
    await db.sql(`update showcase_entries set award_level = null, award_label = null`)
    await db.sql(`update managed_items set registration_deadline = null, event_date = null, awarded_on = null`)
    const before = await tableCounts()

    const r = runSeed()
    expect(r.code, r.stderr).toBe(0)
    // 3 段說明（第 2 段系辦改過不動）＋5 件獎項＋6 則得獎日期＋3 則競賽日期。
    expect(r.stdout).toContain('補上票 39 的欄位 17 列')
    expect(await tableCounts()).toEqual(before)
    const showcaseQuery = new PgPublicShowcaseQuery(() => db.pool)
    expect((await showcaseQuery.featured()).length).toBe(5)
    const stage2 = await db.sql(`select s.description from cohort_stages s join cohorts c on c.id = s.cohort_id
                                  where c.code = 'DEMO-114' and s.seq = 2`)
    expect(stage2.rows[0]!.description).toBe('系辦改過的說明')
    const query = new PgPublicItemQuery(clock, () => db.pool)
    const competitions = await query.list(ANONYMOUS, 'news', { category: '競賽資訊', limit: 20 })
    expect(competitions.map((c) => competitionStatus(c, ANCHOR))).toEqual(['open', 'result', 'closed'])

    const again = runSeed()
    expect(again.code, again.stderr).toBe(0)
    expect(again.stdout).toContain('不做任何事')
  })

  it('早期灌過的測試站（規則還是項目符號＋一般段落）：再跑換成編號清單與註解框、多一個版本；系辦改過的節不動；重跑不變', async () => {
    // 模擬舊格式：把 <ol> 換回 <ul>、拿掉註解框（#290 當時的內文）。第一節當成系辦改過。
    await db.sql(`update managed_items set body_html = replace(replace(replace(replace(body_html, '<ol>', '<ul>'), '</ol>', '</ul>'), '<blockquote>', ''), '</blockquote>', '')
                   where placement = 'rules' and cohort_id in (select id from cohorts where code = 'DEMO-114')`)
    await db.sql(`update managed_items set body_html = '<p>系辦改過的規則</p>'
                   where placement = 'rules' and title = '一、專題課程目的' and cohort_id in (select id from cohorts where code = 'DEMO-114')`)
    const versionsBefore = Number((await db.sql(`select count(*)::int as n from item_versions`)).rows[0]!.n)

    const r = runSeed()
    expect(r.code, r.stderr).toBe(0)
    // 9 節裡 8 節換掉（第一節系辦改過不動）；第三節只有段落、沒有清單與註解，新舊一樣也不算。
    const query = new PgPublicItemQuery(clock, () => db.pool)
    const rules = await query.fullText(ANONYMOUS, 'rules')
    expect(rules[0]!.bodyHtml).toBe('<p>系辦改過的規則</p>')
    expect(rules.find((x) => x.title.startsWith('四、'))!.bodyHtml).toMatch(/<blockquote><p>註一/)
    expect(rules.slice(1).every((x) => !x.bodyHtml.includes('<ul>'))).toBe(true)
    const changed = Number(/規則內文換成編號清單與註解框 (\d+) 節/.exec(r.stdout)?.[1] ?? 0)
    expect(changed).toBeGreaterThan(0)
    const versionsAfter = Number((await db.sql(`select count(*)::int as n from item_versions`)).rows[0]!.n)
    expect(versionsAfter - versionsBefore).toBe(changed)
    // 項目指到新版本，新版本的內文跟項目一樣（跟正式的「改內容」一致）。
    const mismatch = await db.sql(`select count(*)::int as n from managed_items m join item_versions v on v.id = m.current_content_version_id
                                     where m.placement = 'rules' and v.body_html <> m.body_html
                                       and m.title <> '一、專題課程目的'`)
    expect(mismatch.rows[0]!.n).toBe(0)

    const again = runSeed()
    expect(again.code, again.stderr).toBe(0)
    expect(again.stdout).toContain('不做任何事')
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
      `select (select count(*) from cohorts where code in ('DEMO-114', 'DEMO-113', 'DEMO-112'))::int as cohorts,
              (select count(*) from users where email like '%@demo.invalid')::int as users,
              (select count(*) from stored_files)::int as files,
              (select count(*) from industry_opportunities)::int as industry,
              (select count(*) from showcase_versions)::int as showcase,
              (select count(*) from managed_items where placement = 'honor')::int as honors`,
    )
    expect(left.rows[0]).toMatchObject({ cohorts: 0, users: 0, files: 0, industry: 0, showcase: 0, honors: 0 })
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

    // 稽核只有全系範圍的紀錄：兩批各一筆建立、一筆清除。
    const audit = await db.sql(`select action from audit_events where payload->>'source' = 'seed:demo' order by real_at`)
    expect(audit.rows.map((x) => x.action)).toEqual(['demo.seed', 'demo.seed', 'demo.remove'])
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
