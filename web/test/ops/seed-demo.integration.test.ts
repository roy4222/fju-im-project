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

/**
 * N-01：已下架那則公告（暑期自學營）的發布日、正文寫的結束日、下架日（臺灣日期）。
 * 正文的結束日跟著平移，所以一定落在發布日與下架日之間。
 */
async function archivedNewsDates(sql: IsolatedDatabase['sql']) {
  const r = await sql(
    `select v.body_html,
            (select to_char(p.business_at at time zone 'Asia/Taipei', 'YYYY-MM-DD') from item_publications p where p.item_id = m.id and p.action = 'publish' order by p.business_at limit 1) as published,
            (select to_char(p.business_at at time zone 'Asia/Taipei', 'YYYY-MM-DD') from item_publications p where p.item_id = m.id and p.action = 'archive') as archived
       from managed_items m join item_versions v on v.item_id = m.id
      where m.title = '暑期程式設計自學營報名（已結束）' and m.status = 'archived'
      order by v.version_no desc limit 1`,
  )
  const row = r.rows[0]!
  return { body: String(row.body_html), published: String(row.published), archived: String(row.archived) }
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

  it('N-01：內文提到的日期跟活動、截止日同一條時間線（原型 8/20 的說明會，平移 +39 天後兩邊都是 9/28），沒有留下記號', async () => {
    const events = await db.sql(
      `select title, to_char(starts_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') as starts,
              to_char(ends_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') as ends
         from project_events where title in ('114 學年度專題說明會', '雲端服務實務工作坊', '全國大專資訊應用服務創新競賽報名截止', '智慧製造大數據分析競賽決賽')
        order by starts_at`,
    )
    // C3-01：每筆都有結束；全天的結束＝次日 00:00。
    expect(events.rows.map((e) => [e.title, e.starts, e.ends])).toEqual([
      ['114 學年度專題說明會', '2026-09-28 13:10', '2026-09-28 15:00'],
      ['雲端服務實務工作坊', '2026-10-06 09:00', '2026-10-06 12:00'],
      ['智慧製造大數據分析競賽決賽', '2026-10-11 00:00', '2026-10-12 00:00'],
      ['全國大專資訊應用服務創新競賽報名截止', '2026-11-11 00:00', '2026-11-12 00:00'],
    ])
    const text = async (title: string) => {
      const r = await db.sql(
        `select v.title || ' ' || v.summary || ' ' || v.body_html as text from item_versions v join managed_items m on m.id = v.item_id
          where m.title = $1 order by v.version_no desc limit 1`,
        [title],
      )
      return String(r.rows[0]!.text)
    }
    expect(await text('專題說明會出席與分組意向登記')).toContain('登記 9/28 說明會出席人數')
    expect(await text('說明會出席與分組意向登記期限提醒')).toContain('將於 9 月 23 日截止')
    expect(await text('雲端服務實務工作坊（10/6）開放登記')).toContain('將於 10 月 6 日舉行')
    expect(await text('第 31 屆全國大專校院資訊應用服務創新競賽開始報名')).toContain('報名期限至 2026 年 11 月 11 日止')
    expect(await text('2026 全國智慧製造大數據分析競賽入圍名單公告')).toContain('決賽日期為 10 月 11 日')
    const form = await db.sql(
      `select f.schema::text as schema from form_schema_versions f join managed_items m on m.id = f.item_id where m.title = '專題說明會出席與分組意向登記'`,
    )
    expect(String(form.rows[0]!.schema)).toContain('9/28 專題說明會請至少一位組員出席')
    const leftover = await db.sql(
      `select (select count(*) from item_versions where title || summary || body_html like '%{{%')::int
            + (select count(*) from managed_items where title like '%{{%')::int
            + (select count(*) from form_schema_versions where schema::text like '%{{%')::int as n`,
    )
    expect(Number(leftover.rows[0]!.n)).toBe(0)
    // 已下架的公告：原型 7/31 結束，跨月平移成 9/8，落在發布日與下架日之間。
    const archived = await archivedNewsDates(db.sql)
    expect(archived.body).toContain('已於 9 月 8 日結束')
    expect(archived.published < '2026-09-08' && '2026-09-08' < archived.archived).toBe(true)
  })

  it('C3-01（AC-C3-49 前置）：活動都有結束、含跨三天的佈展；頭像、名片、g-03 待確認、提案是產學', async () => {
    const open = await db.sql(`select count(*)::int as n from project_events where all_day and ends_at is null`)
    expect(open.rows).toEqual([{ n: 0 }])
    const setup = await db.sql(
      `select e.audience_kind, e.all_day, to_char(e.starts_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') as starts,
              to_char(e.ends_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') as ends
         from project_events e join cohorts c on c.id = e.cohort_id where c.code = 'DEMO-114' and e.title = '成果展佈展'`,
    )
    expect(setup.rows).toEqual([{ audience_kind: 'teachers', all_day: true, starts: '2027-06-11 00:00', ends: '2027-06-14 00:00' }])
    const events = await db.sql(
      `select count(*)::int as n from project_events e join cohorts c on c.id = e.cohort_id where c.code = 'DEMO-114'`,
    )
    expect(events.rows).toEqual([{ n: 6 }])

    // 示範屆別的老師與學生都有預設頭像，而且彼此不同。
    const avatars = await db.sql(
      `select count(*)::int as people, count(p.avatar_preset)::int as with_avatar, count(distinct p.avatar_preset)::int as distinct_avatar
         from user_profiles p join users u on u.id = p.user_id join role_assignments r on r.user_id = u.id and r.revoked_real_at is null
        where u.email like '%@demo.invalid' and r.role in ('teacher', 'student')
          and (p.cohort_id is null or p.cohort_id in (select id from cohorts where code = 'DEMO-114'))`,
    )
    expect(avatars.rows[0]).toMatchObject({ with_avatar: avatars.rows[0]!.people, distinct_avatar: avatars.rows[0]!.people })
    expect(Number(avatars.rows[0]!.people)).toBeGreaterThan(50)

    // 未分組四人有名片；至少兩人公開找隊員；技能涵蓋預設清單至少 6 種。
    const cards = await db.sql(
      `select p.display_name, p.bio, p.skills, p.open_to_join from user_profiles p join users u on u.id = p.user_id
        where u.email like '%@demo.invalid' and p.bio <> '' order by p.student_no`,
    )
    expect(cards.rows.map((r) => r.display_name)).toEqual(['應宥丞', '解雨萱', '鞠柏宇', '冷佳霓'])
    for (const row of cards.rows) {
      expect([...String(row.bio)].length).toBeLessThanOrEqual(50)
      expect((row.skills as string[]).length).toBeGreaterThanOrEqual(2)
    }
    expect(cards.rows.filter((r) => r.open_to_join).length).toBeGreaterThanOrEqual(2)
    const presets = ['前端', '後端', '資料庫', '資料分析', 'AI', 'UI 設計', '簡報', '企劃', 'Python', 'JavaScript', 'Figma']
    const used = new Set(cards.rows.flatMap((r) => r.skills as string[]))
    expect(presets.filter((p) => used.has(p)).length).toBeGreaterThanOrEqual(6)

    // g-02 已確認（有指導老師＝負責老師）；g-03 待老師確認、沒有指導老師。
    const links = await db.sql(
      `select g.code, l.state, (select count(*)::int from advisor_assignments a where a.group_id = g.id and a.valid_to is null) as advisors,
              (select a.teacher_user_id = o.owner_teacher_user_id from advisor_assignments a where a.group_id = g.id and a.valid_to is null) as owner_advises
         from opportunity_links l join groups g on g.id = l.group_id join industry_opportunities o on o.id = l.opportunity_id
         join cohorts c on c.id = g.cohort_id where c.code = 'DEMO-114' and g.code in ('G02', 'G03') order by g.code`,
    )
    expect(links.rows).toEqual([
      { code: 'G02', state: 'active', advisors: 1, owner_advises: true },
      { code: 'G03', state: 'pending', advisors: 0, owner_advises: null },
    ])

    // 建立中的那份提案是產學合作、選了 ind-03（昱鋼精機）。
    const proposal = await db.sql(
      `select p.group_type, p.state, o.company_name from group_proposals p join cohorts c on c.id = p.cohort_id
         left join industry_opportunities o on o.id = p.opportunity_id where c.code = 'DEMO-114'`,
    )
    expect(proposal.rows).toEqual([{ group_type: 'industry', state: 'open', company_name: '昱鋼精機工業' }])
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

  it('第三波（W8，AC-27）：新後台每個功能都有示範資料可點', async () => {
    const items = await db.sql(
      `select m.title, m.placement, m.status, m.audience_kind, m.receiver_unit, m.awarded_on::text as awarded_on,
              (select array_agg(g.code order by g.code) from item_audience_groups a join groups g on g.id = a.group_id where a.item_id = m.id) as groups,
              (select count(*) from item_versions v where v.item_id = m.id)::int as versions,
              (select array_agg(p.action order by p.real_at) from item_publications p where p.item_id = m.id) as actions,
              (select count(*) from submission_versions s where s.item_id = m.id)::int as submissions,
              (select count(*) from response_rosters r where r.item_id = m.id)::int as roster,
              (select count(*) from response_rosters r where r.item_id = m.id and not exists (
                 select 1 from submission_versions s where s.item_id = m.id and s.receiver_kind = r.receiver_kind and s.receiver_id = r.receiver_id))::int as missing,
              m.due_at < now() as past_due
         from managed_items m join cohorts c on c.id = m.cohort_id
        where c.code = 'DEMO-114' and m.title = any($1::text[])
        order by m.title`,
      [
        [
          '（草稿）期末成果展場地與時段調查',
          '暑期程式設計自學營報名（已結束）',
          '指導老師：系統驗收評分作業時程',
          '第 01 組：期中進度會議改期',
          '暑期企業參訪報名表（已下架）',
          '專題說明會個人心得',
          '大專校院資訊應用服務創新競賽 校內初選',
        ],
      ],
    )
    const byTitle = Object.fromEntries(items.rows.map((r) => [String(r.title), r]))
    expect(Object.keys(byTitle)).toHaveLength(7)

    // 草稿公告：從沒發布（沒有版本、沒有發布紀錄）——可以直接刪。
    expect(byTitle['（草稿）期末成果展場地與時段調查']).toMatchObject({ placement: 'news', status: 'draft', versions: 0, actions: null })
    // 已下架公告：發布過再下架——可以重新發布，也可以刪。
    expect(byTitle['暑期程式設計自學營報名（已結束）']).toMatchObject({ status: 'archived', versions: 1, actions: ['publish', 'archive'] })
    // 老師首頁公告（Q13、Q14）：一則給全部老師、一則只給第 01 組。
    expect(byTitle['指導老師：系統驗收評分作業時程']).toMatchObject({ status: 'published', audience_kind: 'teachers', groups: null })
    expect(byTitle['第 01 組：期中進度會議改期']).toMatchObject({ status: 'published', audience_kind: 'groups', groups: ['G01'] })
    // Q28：已有組別交件、之後下架的收件——只能下架不能刪。
    expect(byTitle['暑期企業參訪報名表（已下架）']).toMatchObject({
      placement: 'submission',
      status: 'archived',
      receiver_unit: 'group',
      submissions: 3,
      roster: 9,
      actions: ['publish', 'archive'],
    })
    // 補交：每人一份、已截止，第 07 組只有一位沒交。
    expect(byTitle['專題說明會個人心得']).toMatchObject({
      status: 'published',
      receiver_unit: 'individual',
      audience_kind: 'groups',
      groups: ['G07'],
      roster: 5,
      submissions: 4,
      missing: 1,
      past_due: true,
    })
    // 本屆一則草稿榮譽（測發布）：有得獎日期、還沒發布。
    expect(byTitle['大專校院資訊應用服務創新競賽 校內初選']).toMatchObject({ placement: 'honor', status: 'draft', versions: 0 })
    expect(byTitle['大專校院資訊應用服務創新競賽 校內初選']!.awarded_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // 訪客看不到草稿、已下架、給老師與給組別的公告；公開榮譽榜也只有原本 6 則。
    const query = new PgPublicItemQuery(clock, () => db.pool)
    const publicNews = (await query.list(ANONYMOUS, 'news', { limit: 50 })).map((n) => n.title)
    for (const title of Object.keys(byTitle)) expect(publicNews).not.toContain(title)
    expect(await query.list(ANONYMOUS, 'honor', { limit: 20 })).toHaveLength(6)

    // 首頁輪播順序（W0 的 home_position）：有獎項的兩件歷屆作品排第 1、2，其他沒排。
    const positions = await db.sql(
      `select d.title, e.home_position from showcase_entries e join showcase_drafts d on d.entry_id = e.id
        where e.home_position is not null order by e.home_position`,
    )
    expect(positions.rows.map((r) => [r.title, r.home_position])).toEqual([
      ['城市微光：公共資訊可讀性改善', 1],
      ['備援：中小企業備份稽核工具', 2],
    ])

    // 本屆的精選草稿（測發布＋獎項）：每組一份，還是 9 件。
    const drafts = await db.sql(
      `select count(*)::int as n from showcase_entries e join cohorts c on c.id = e.cohort_id where c.code = 'DEMO-114' and e.status = 'draft'`,
    )
    expect(Number(drafts.rows[0]!.n)).toBe(9)
  })

  it('C1-17（AC-36、AC-33）：老師作業、同意書作業連 6 包、系統驗收文件＋評分項目設定；規則第八節不寫死比例', async () => {
    const items = await db.sql(
      `select m.title, m.placement, m.status, m.audience_kind, m.receiver_unit, m.consent_mode, m.consent_purpose,
              m.stage_id, m.due_at is not null and m.due_at > $2::timestamptz as due_after_anchor,
              (select array_agg(g.code order by g.code) from item_audience_groups a join groups g on g.id = a.group_id where a.item_id = m.id) as groups,
              (select count(*) from response_rosters r where r.item_id = m.id)::int as roster,
              (select count(*) from submission_versions s where s.item_id = m.id)::int as submissions,
              (select count(*) from submission_files f join submission_versions s on s.id = f.submission_version_id where s.item_id = m.id)::int as files
         from managed_items m join cohorts c on c.id = m.cohort_id
        where c.code = 'DEMO-114' and m.title = any($1::text[])
        order by m.title`,
      [['指導意願調查表（老師）', '專題成果授權同意書', '系統驗收文件'], `${ANCHOR}T12:00:00+08:00`],
    )
    const byTitle = Object.fromEntries(items.rows.map((r) => [String(r.title), r]))
    expect(Object.keys(byTitle)).toHaveLength(3)
    // 給老師的作業（T3）：每位老師一份，4 位裡 2 位已交。
    expect(byTitle['指導意願調查表（老師）']).toMatchObject({
      placement: 'submission',
      status: 'published',
      audience_kind: 'teachers',
      receiver_unit: 'individual',
      consent_mode: null,
      consent_purpose: null,
      stage_id: null,
      roster: 4,
      submissions: 2,
    })
    // 站內同意書作業：最終文件授權、整組收件，對象＝有主指導的 6 組；不收繳交（「已交」看簽核包）。
    expect(byTitle['專題成果授權同意書']).toMatchObject({
      placement: 'submission',
      status: 'published',
      audience_kind: 'groups',
      receiver_unit: 'group',
      consent_mode: 'form',
      consent_purpose: 'final_document',
      stage_id: null,
      groups: ['G01', 'G02', 'G04', 'G05', 'G07', 'G08'],
      roster: 6,
      submissions: 0,
    })
    // 系統驗收文件（T2-2）：整組一份、截止在今天之後，3 組已交而且都附 PDF。
    expect(byTitle['系統驗收文件']).toMatchObject({
      placement: 'submission',
      status: 'published',
      audience_kind: 'cohort_students',
      receiver_unit: 'group',
      consent_mode: null,
      consent_purpose: null,
      stage_id: null,
      due_after_anchor: true,
      roster: 9,
      submissions: 3,
      files: 3,
    })
    const pdfs = await db.sql(
      `select f.mime_detected, f.purpose, f.status,
              (select array_agg(r.ref_type order by r.ref_type) from file_references r where r.file_id = f.id and r.released_at is null) as refs
         from submission_files sf join stored_files f on f.id = sf.file_id
         join submission_versions s on s.id = sf.submission_version_id join managed_items m on m.id = s.item_id
        where m.title = '系統驗收文件'`,
    )
    for (const row of pdfs.rows) {
      expect(row).toMatchObject({ mime_detected: 'application/pdf', purpose: 'submission', status: 'stored', refs: ['draft', 'submission_version'] })
    }

    // 6 包都掛在同意書作業底下、用途仍是最終文件授權、授權範圍照原樣；逐人同意仍 28 筆。
    const packages = await db.sql(
      `select g.code, p.purpose, m.title as item, v.authorization_scope -> 'usages' as usages, v.authorization_scope ->> 'title' as scope_title,
              (select d.title from showcase_drafts d join showcase_entries e on e.id = d.entry_id where e.group_id = p.group_id) as draft_title
         from signoff_packages p join groups g on g.id = p.group_id
         left join managed_items m on m.id = p.item_id
         join signoff_package_versions v on v.id = p.current_version_id
        order by g.code`,
    )
    expect(packages.rows.map((r) => r.code)).toEqual(['G01', 'G02', 'G04', 'G05', 'G07', 'G08'])
    for (const row of packages.rows) {
      expect(row, String(row.code)).toMatchObject({ purpose: 'final_document', item: '專題成果授權同意書', usages: ['public_showcase'] })
      expect(row.scope_title).toBe(row.draft_title)
    }
    const approvals = await db.sql(`select count(*)::int as n from approvals`)
    expect(Number(approvals.rows[0]!.n)).toBe(28)

    // 評分項目的對應作業與說明：系統驗收→系統驗收文件；專題發表只有說明；示範不設評審組。
    const settings = await db.sql(
      `select s.stage_key, m.title as item, s.description, s.panel_key
         from grading_stage_settings s join cohorts c on c.id = s.cohort_id left join managed_items m on m.id = s.item_id
        where c.code = 'DEMO-114' order by s.stage_key`,
    )
    expect(settings.rows).toEqual([
      { stage_key: 's1', item: '系統驗收文件', description: null, panel_key: null },
      { stage_key: 's2', item: null, description: '依發表當天表現評分', panel_key: null },
    ])

    // AC-33（正文）：第八節不寫死 60%／40%，改指到評分規則。
    const query = new PgPublicItemQuery(clock, () => db.pool)
    const eighth = (await query.fullText(ANONYMOUS, 'rules')).find((r) => r.title.startsWith('八、'))!
    expect(eighth.bodyHtml).not.toMatch(/60\s*%|40\s*%/)
    expect(eighth.bodyHtml).toContain('評分方式與比例以本站「評分規則」為準')
  })

  it('C2-12：示範有一位 email_roster_match 自動開通的學生，已核准、有學號占用、不在待審', async () => {
    const row = await db.sql(
      `select ra.state, ra.verification_method, u.status,
              exists (select 1 from student_identities si where si.user_id = u.id) as has_identity
         from registration_applications ra join users u on u.id = ra.user_id
        where ra.student_no = $1`,
      ['411410889'],
    )
    expect(row.rows).toEqual([{ state: 'approved', verification_method: 'email_roster_match', status: 'active', has_identity: true }])
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

  it('0023 之前就灌過的測試站（C3-01）：再跑只補頭像、名片、產學待確認、提案、活動結束與佈展（空著的才填、改過的不動），重跑第二次不變', async () => {
    const demoCohort = `(select id from cohorts where code = 'DEMO-114')`
    // 模擬「部署 0023 前已經灌好」：新欄位都是預設值、全天活動沒有結束、提案是一般組、沒有佈展那筆。
    await db.sql(`update user_profiles set avatar_preset = null, bio = '', skills = '[]'::jsonb
                   where user_id in (select id from users where email like '%@demo.invalid')`)
    await db.sql(`update opportunity_links set state = 'active'`)
    await db.sql(`update group_proposals set group_type = 'general', opportunity_id = null where cohort_id = ${demoCohort}`)
    // 不再模擬「全天活動沒有結束」：0024（C3-06）起 CHECK 規定全天活動必有結束時間，舊資料由 migration 回填
    // （回填與新 CHECK 的證明在 migrations.integration.test.ts 的 0024 案例）。
    await db.sql(`delete from project_events where title = '成果展佈展' and cohort_id = ${demoCohort}`)
    // 本人改過的：解雨萱自己選了頭像、寫了名片，不能被蓋掉。
    await db.sql(`update user_profiles set avatar_preset = 99, bio = '本人寫的', skills = '["Go"]'::jsonb
                   where user_id = (select id from users where email = '411410422@demo.invalid')`)
    const before = await tableCounts()

    const r = runSeed()
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/補上 C3-01 的頭像、名片、產學待確認與活動結束 \d+ 列/)
    expect(await tableCounts()).toEqual({ ...before, project_events: before.project_events! + 1 })

    const open = await db.sql(`select count(*)::int as n from project_events where all_day and ends_at is null`)
    expect(open.rows).toEqual([{ n: 0 }])
    const self = await db.sql(`select avatar_preset, bio, skills from user_profiles where user_id = (select id from users where email = '411410422@demo.invalid')`)
    expect(self.rows).toEqual([{ avatar_preset: 99, bio: '本人寫的', skills: ['Go'] }])
    const missing = await db.sql(
      `select count(*)::int as n from user_profiles p join role_assignments r on r.user_id = p.user_id and r.revoked_real_at is null
        where r.role in ('teacher', 'student')
          and p.user_id in (select id from users where email like '%@demo.invalid') and p.avatar_preset is null
          and (p.cohort_id is null or p.cohort_id = ${demoCohort})`,
    )
    expect(missing.rows).toEqual([{ n: 0 }])
    const cards = await db.sql(`select count(*)::int as n from user_profiles where bio <> '' and user_id in (select id from users where email like '%@demo.invalid')`)
    expect(cards.rows).toEqual([{ n: 4 }])
    const links = await db.sql(
      `select g.code, l.state from opportunity_links l join groups g on g.id = l.group_id where g.cohort_id = ${demoCohort} and l.state = 'pending'`,
    )
    expect(links.rows).toEqual([{ code: 'G03', state: 'pending' }])
    const proposal = await db.sql(`select group_type, opportunity_id is not null as has_opportunity from group_proposals where cohort_id = ${demoCohort}`)
    expect(proposal.rows).toEqual([{ group_type: 'industry', has_opportunity: true }])

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
    // 第四節已經有第 2 版（例如系辦改過又改回舊內文）：新版本號要接在最大版本號後面，不能撞 UNIQUE(item_id, version_no)。
    await db.sql(`insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
                  select gen_random_uuid(), v.item_id, 2, v.title, v.summary, v.body_html, v.created_by_user_id
                    from item_versions v join managed_items m on m.id = v.item_id
                   where m.placement = 'rules' and m.title like '四、%' and v.version_no = 1
                     and m.cohort_id in (select id from cohorts where code = 'DEMO-114')`)
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
    const fourth = await db.sql(`select v.version_no from managed_items m join item_versions v on v.id = m.current_content_version_id
                                  where m.placement = 'rules' and m.title like '四、%'
                                    and m.cohort_id in (select id from cohorts where code = 'DEMO-114')`)
    expect(fourth.rows[0]!.version_no).toBe(3)

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
    // 管理員讓逾期的示範學生補交（第三波 W0 的 submission_reopens，不可變表）：要跟著示範項目一起清掉。
    await db.sql(
      `insert into submission_reopens (id, item_id, receiver_kind, receiver_id, due_at, reason, created_by_user_id)
       select gen_random_uuid(), r.item_id, r.receiver_kind, r.receiver_id, now() + interval '3 days', '示範：讓他補交', $1
         from response_rosters r join managed_items m on m.id = r.item_id
        where m.title = '專題說明會個人心得' and not exists (
          select 1 from submission_versions s where s.item_id = r.item_id and s.receiver_id = r.receiver_id)`,
      [real.adminId],
    )
    expect(Number((await db.sql(`select count(*)::int as n from submission_reopens`)).rows[0]!.n)).toBe(1)
    const r = runSeed(['--remove'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('示範資料已清除')
    expect(Number((await db.sql(`select count(*)::int as n from submission_reopens`)).rows[0]!.n)).toBe(0)

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

describe('seed-demo.mjs：跨年灌資料（N-01）', () => {
  // 原型今天 2026-08-17 → 2027-02-01，平移 +168 天：7/31 變 2027-01-15、10/3 變 2027-03-20。
  const YEAR_ANCHOR = '2027-02-01'
  let yearDb: IsolatedDatabase
  let yearFiles: string

  beforeAll(async () => {
    yearDb = await createIsolatedDatabase({ label: 'seed-demo-year', setup: migratedSchema })
    yearFiles = fs.mkdtempSync(path.join(os.tmpdir(), 'fju-seed-demo-year-'))
  })

  afterAll(async () => {
    await yearDb?.close()
    if (yearFiles) fs.rmSync(yearFiles, { recursive: true, force: true })
  })

  it('內文日期跟著跨年平移：已下架公告的結束日在發布日與下架日之間，報名截止寫成新的年份', async () => {
    const url = new URL(TEST_DATABASE_URL)
    url.searchParams.set('options', `-c search_path=${yearDb.schemaName}`)
    const r = runSeed([], { DATABASE_URL_OWNER: url.toString(), FILES_ROOT: yearFiles, DEMO_ANCHOR_DATE: YEAR_ANCHOR })
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('日期平移 168 天')

    const archived = await archivedNewsDates(yearDb.sql)
    expect(archived.body).toContain('已於 1 月 15 日結束')
    expect(archived.published < '2027-01-15' && '2027-01-15' < archived.archived).toBe(true)

    const news = await yearDb.sql(
      `select v.summary from item_versions v join managed_items m on m.id = v.item_id
        where m.title = '第 31 屆全國大專校院資訊應用服務創新競賽開始報名' order by v.version_no desc limit 1`,
    )
    expect(String(news.rows[0]!.summary)).toContain('報名至 2027 年 3 月 20 日止')
    const leftover = await yearDb.sql(`select count(*)::int as n from item_versions where title || summary || body_html like '%{{%'`)
    expect(Number(leftover.rows[0]!.n)).toBe(0)
  })
})
