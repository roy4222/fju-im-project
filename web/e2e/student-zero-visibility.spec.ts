import fs from 'node:fs'
import path from 'node:path'
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, type TestSession } from './session'
import { scanBody, type ScanHit } from './visibility-scan'

/**
 * 票 23（#234）「做完的樣子」第 4 條：學生任何頁面看不到分數，並有可重跑的掃描報告證明（GRD-11、S10-12）。
 *
 * 做法：
 * 1. 用 owner 連線種一組**完整的評分資料**：已鎖定的方案、兩位老師的指派、一份正式評分（77.31、63.47 → 70.39）、
 *    一份暫存（91.73 → 45.87）、一筆管理員更正（88.64）。數值刻意挑一般頁面不會剛好出現的。
 * 2. 以該組**學生本人**的登入狀態走遍學生可達的每一頁（側欄自動發現＋固定清單）與 API，
 *    每頁抓兩種原始回應：HTML（含內嵌 RSC payload）與 RSC 請求（`RSC: 1` 的 flight 資料），掃已知數值與評分欄位名。
 * 3. 學生直接開管理員、老師的評分網址：一律導去 /403；打管理員的匯出：一律 401／403；回應裡都沒有數值。
 * 4. 對照組：同一批數值在管理員頁、老師評閱桌**看得到**（證明掃描不是空轉），掃描器對故意放的分數欄位**抓得到**。
 *
 * 報告寫到 `e2e/.artifacts/student-zero-visibility.json`（也附在 Playwright 報告裡），終端機印一行摘要。
 * 重跑：`pnpm -C web test:e2e student-zero-visibility`（要 BASE_URL 與 DATABASE_URL_OWNER）。
 *
 * Server Action 沒辦法從瀏覽器外直接打：學生呼叫任何評分用例都是 FORBIDDEN 由整合測試 pg-grading.integration.test.ts 證明。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const REPORT_PATH = path.join(import.meta.dirname, '.artifacts', 'student-zero-visibility.json')

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `SCAN-${stamp}`
/** 種子資料的每一個分數、平均、更正值（和它們兩位小數的顯示）。 */
const KNOWN_VALUES = ['77.31', '63.47', '70.39', '91.73', '45.87', '45.865', '88.64']

let pool: Pool
let cohortId: string
let groupId: string
let studentSession: TestSession
let teacher1: TestSession

/** 一定要掃的學生頁與公開頁；側欄上的學生頁另外自動發現（新增學生頁忘了列也掃得到）。 */
const FIXED_PAGES = [
  '/',
  '/industry',
  '/news',
  '/rules',
  '/files',
  '/account',
  '/dashboard/student',
  '/dashboard/student/groups',
  '/dashboard/student/affairs',
  '/dashboard/student/inbox',
  '/dashboard/student/grading',
]
const APIS = ['/api/health', '/api/auth/get-session']
/** 管理員的匯出（票 20 組別名單、票 6 帳號）：學生從本站頁面送出（同源）也要被拒，回應不能帶任何資料。 */
const EXPORTS = ['/api/admin/groups/export', '/api/admin/accounts/export']

type Target = {
  url: string
  variant: 'html' | 'rsc' | 'json'
  status: number
  contentType: string
  bytes: number
  hits: ScanHit[]
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const fresh = async (role: 'teacher' | 'student') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  studentSession = await fresh('student')
  teacher1 = await fresh('teacher')
  const teacher2 = await fresh('teacher')

  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', (now() + interval '300 days')::date, false, 'system') returning id`,
    [CODE],
  )
  cohortId = cohort.rows[0]!.id
  const studentNo = `42399${String(Date.now()).slice(-4)}`
  await pool.query(
    `update user_profiles set display_name = '掃描學生', student_no = $2, cohort_id = $3, phone = '0912000000', contact_email = $4 where user_id = $1`,
    [studentSession.userId, studentNo, cohortId, `scan-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     select $1, '掃描學生', '掃描學生', $2, $3, '0912000000', $4 where not exists (select 1 from user_profiles where user_id = $1)`,
    [studentSession.userId, studentNo, cohortId, `scan-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, studentSession.userId])
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', 'active', now(), now(), 'system') returning id`,
    [cohortId],
  )
  groupId = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
    [groupId, cohortId, studentSession.userId],
  )
  await pool.query(`insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now(), $2)`, [
    groupId,
    studentSession.userId,
  ])
  // 主指導是評一：學生的「我的組別」會顯示老師，確認帶老師資訊的頁面也不夾帶評分。
  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '抽籤結果')`,
    [groupId, teacher1.userId, adminId],
  )

  const stages = JSON.stringify([
    {
      key: 's1',
      name: '系統驗收',
      weight: 100,
      letterMap: null,
      items: [
        { key: 'i1', name: '功能完整度', type: 'number', max: 100, weight: 50 },
        { key: 'i2', name: '文件', type: 'number', max: 100, weight: 50 },
      ],
    },
  ])
  const scheme = await pool.query<{ id: string }>(
    `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, '掃描方案', 'system') returning id`,
    [cohortId],
  )
  const version = await pool.query<{ id: string }>(
    `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, 'published', $3) returning id`,
    [scheme.rows[0]!.id, stages, adminId],
  )
  const versionId = version.rows[0]!.id
  await pool.query('update grading_schemes set current_version_id = $2 where id = $1', [scheme.rows[0]!.id, versionId])
  await pool.query(`insert into stage_requirements (group_id, stage_key, required_count, created_by_user_id) values ($1, 's1', 2, $2)`, [groupId, adminId])

  const assign = async (teacherId: string) =>
    (
      await pool.query<{ id: string }>(
        `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
         values (gen_random_uuid(), $1, 's1', $2, now(), $3) returning id`,
        [groupId, teacherId, adminId],
      )
    ).rows[0]!.id
  const evaluate = async (assignmentId: string, kind: 'draft' | 'final', scores: Record<string, string>) => {
    const e = await pool.query<{ id: string }>(
      `insert into evaluations (id, assignment_id, kind, scheme_version_id, scores, submitted_real_at, submitted_business_at, request_id)
       values (gen_random_uuid(), $1, $2, $3, $4::jsonb, now(), now(), gen_random_uuid()) returning id`,
      [assignmentId, kind, versionId, JSON.stringify(scores)],
    )
    await pool.query(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, $3)`, [
      e.rows[0]!.id,
      assignmentId,
      kind === 'final' ? 'counted' : 'draft',
    ])
  }
  await evaluate(await assign(teacher1.userId), 'final', { i1: '77.31', i2: '63.47' })
  await evaluate(await assign(teacher2.userId), 'draft', { i1: '91.73' })
  await pool.query(`update grading_scheme_versions set status = 'locked', locked_at = now() where id = $1`, [versionId])
  const override = await pool.query<{ id: string }>(
    `insert into grade_overrides (id, group_id, scheme_version_id, original_value, new_value, basis_hash, reason, actor_user_id, real_at)
     values (gen_random_uuid(), $1, $2, 70.39, 88.64, 'scan', '掃描用更正', $3, now()) returning id`,
    [groupId, versionId, adminId],
  )
  await pool.query(`insert into override_review_state (override_id) values ($1)`, [override.rows[0]!.id])
})

test.afterAll(async () => {
  await pool?.end()
})

async function fetchTarget(request: APIRequestContext, cookie: string, url: string, variant: Target['variant']): Promise<Target> {
  const headers: Record<string, string> = { cookie }
  // RSC 請求：帶 `RSC: 1` 並加 `_rsc` 參數（Next 對沒有這個參數的 RSC 請求會先 307 導去有參數的網址）。
  if (variant === 'rsc') headers.RSC = '1'
  const target = variant === 'rsc' ? `${url}${url.includes('?') ? '&' : '?'}_rsc` : url
  const response = await request.get(target, { headers, maxRedirects: 0 })
  const body = await response.text()
  return {
    url,
    variant,
    status: response.status(),
    contentType: response.headers()['content-type'] ?? '',
    bytes: body.length,
    hits: scanBody(body, KNOWN_VALUES),
  }
}

test('掃描器自己抓得到：故意放一個分數欄位與已知數值（反例，證明不是空轉）', () => {
  const planted = '<script>self.__next_f.push([1,"{\\"groupCode\\":\\"G01\\",\\"scores\\":{\\"i1\\":\\"77.31\\"}}"])</script>'
  const hits = scanBody(planted.replaceAll('\\"', '"'), KNOWN_VALUES)
  expect(hits.map((h) => h.kind).sort()).toEqual(['field', 'value'])
  expect(scanBody('<p>第 177.312 名</p><p>成績只有老師看得到</p>', KNOWN_VALUES)).toEqual([])
})

test('對照組：同一批數值在管理員頁與老師評閱桌看得到（授權的人看得到，掃描才有意義）', async ({ request }) => {
  const admin = await sharedTestSession(request, 'admin')
  const adminPage = await fetchTarget(request, admin.cookie, `/dashboard/admin/grading?cohort=${cohortId}`, 'html')
  expect(adminPage.status).toBe(200)
  expect(adminPage.hits.map((h) => h.match)).toEqual(expect.arrayContaining(['70.39', '45.87']))

  const bench = await fetchTarget(request, teacher1.cookie, `/dashboard/teacher/grading/${groupId}`, 'html')
  expect(bench.status).toBe(200)
  expect(bench.hits.map((h) => h.match)).toEqual(expect.arrayContaining(['77.31', '63.47', '70.39']))
})

test('學生零可見：學生可達的每一頁（HTML 與 RSC）與 API 都沒有分數與評分欄位；評分網址一律 403；產出報告', async ({ request }, testInfo) => {
  const cookie = studentSession.cookie

  // 側欄自動發現學生頁：新增學生頁時就算忘了加進 FIXED_PAGES 也會被掃到。
  const home = await request.get('/dashboard/student', { headers: { cookie } })
  expect(home.status()).toBe(200)
  const discovered = [...(await home.text()).matchAll(/href="(\/dashboard\/student[^"?#]*)"/g)].map((m) => m[1]!)
  const pages = [...new Set([...FIXED_PAGES, ...discovered])].sort()
  expect(pages).toContain('/dashboard/student/grading')

  const targets: Target[] = []
  for (const url of pages) {
    for (const variant of ['html', 'rsc'] as const) targets.push(await fetchTarget(request, cookie, url, variant))
  }
  for (const url of APIS) targets.push(await fetchTarget(request, cookie, url, 'json'))

  const forbiddenUrls = [
    `/dashboard/admin/grading?cohort=${cohortId}`,
    '/dashboard/teacher/grading',
    `/dashboard/teacher/grading/${groupId}`,
  ]
  const forbidden: (Target & { location: string | null })[] = []
  for (const url of forbiddenUrls) {
    const response = await request.get(url, { headers: { cookie }, maxRedirects: 0 })
    const body = await response.text()
    forbidden.push({
      url,
      variant: 'html',
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
      bytes: body.length,
      hits: scanBody(body, KNOWN_VALUES),
      location: response.headers()['location'] ?? null,
    })
  }

  const exportsDenied: Target[] = []
  for (const url of EXPORTS) {
    const response = await request.post(url, {
      headers: { cookie, origin: BASE_URL, 'content-type': 'application/json' },
      data: { cohortId, format: 'csv' },
      maxRedirects: 0,
    })
    const body = await response.text()
    exportsDenied.push({
      url,
      variant: 'json',
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
      bytes: body.length,
      hits: scanBody(body, KNOWN_VALUES),
    })
  }

  const hitCount = [...targets, ...forbidden, ...exportsDenied].reduce((sum, t) => sum + t.hits.length, 0)
  const report = {
    ticket: '票 23（#234）學生零可見掃描',
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    cohortCode: CODE,
    knownValues: KNOWN_VALUES,
    fieldPattern: String(/"(scores?|teacherScore|finalScore|stageScore|evaluationId|evaluations|grade|grades|rank|ranking|comment|comments|counted)"\s*:/),
    scanned: targets,
    forbidden,
    exportsDenied,
    summary: { pages: pages.length, responses: targets.length + forbidden.length + exportsDenied.length, hits: hitCount },
  }
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
  await testInfo.attach('student-zero-visibility.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
  console.log(
    `[學生零可見掃描] ${pages.length} 頁 × HTML／RSC＋${APIS.length} 支 API＋${forbidden.length} 個評分網址＋${exportsDenied.length} 支匯出，共 ${report.summary.responses} 份回應，命中 ${hitCount} 筆（報告：${path.relative(process.cwd(), REPORT_PATH)}）`,
  )

  for (const t of targets) {
    expect(t.status, `${t.variant} ${t.url} 學生應該打得開`).toBe(200)
    // 真的掃到 RSC flight 資料（不是被導走的空回應）。
    if (t.variant === 'rsc') expect(t.contentType, `${t.url} 的 RSC 回應`).toContain('text/x-component')
    expect(t.hits, `${t.variant} ${t.url} 不該有分數或評分欄位`).toEqual([])
  }
  for (const f of forbidden) {
    expect([302, 303, 307, 308], f.url).toContain(f.status)
    expect(f.location, f.url).toContain('/403')
    expect(f.hits, `${f.url} 的導向回應不該夾帶分數`).toEqual([])
  }
  for (const e of exportsDenied) {
    expect([401, 403], `${e.url} 學生匯出應該被拒`).toContain(e.status)
    expect(e.hits, `${e.url} 的拒絕回應不該夾帶分數`).toEqual([])
  }
  expect(hitCount).toBe(0)
})
