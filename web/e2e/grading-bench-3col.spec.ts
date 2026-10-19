import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * C1-12（#643）：老師評分清單＋三欄批改頁，照驗收案例① AC-27、AC-28、AC-28a（畫面）、AC-29 逐條走真的畫面。
 *
 * 種子（設計方案① AC-26 的狀態，用 owner 連線直接建；評分規則與繳交流程各有自己的 e2e）：
 * - 方案兩個評分項目：「系統驗收」(s1) 對應作業 A「系統驗收文件」、「專題發表」(s2) 不對應作業、說明「依發表當天表現評分」。
 *   另有整組作業 B「期中報告」（沒對應任何評分項目）。
 * - G1 交了 A 兩次（第 1 版一個 PDF、第 2 版 PDF＋PNG）、也交了 B；G2 交了 A 一次（一個 PDF）；G3 都沒交。
 * - 老師丙：三組的 s1、s2 都評。老師丁：只評 G1 的 s2。老師戊：只評 G1 的 s1。
 *
 * 附件下載的讀權（AC-28a 的 403／200）由 C1-02 的 `version-access` 決定；這裡從畫面那一側再確認一次。
 * 設 `C1_12_SCREENSHOT_DIR` 時另存三欄頁的截圖（人工驗收證據）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const shotDir = process.env.C1_12_SCREENSHOT_DIR

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `C112-${stamp}`
const DAY = 86_400_000
const TITLE_A = `${CODE} 系統驗收文件`
const TITLE_B = `${CODE} 期中報告`
const DESCRIPTION = '依發表當天表現評分'
const CODE2 = `C112B-${stamp}`
const NAME2 = `第二屆${stamp.slice(-3)}`
const TITLE_C = `${CODE2} 系統驗收文件`
const TITLE_D = `${CODE2} 發表投影片`

const STAGES = [
  {
    key: 's1',
    name: '系統驗收',
    weight: 60,
    letterMap: null,
    items: [
      { key: 'i1', name: '功能', type: 'number', max: 100, weight: 50 },
      { key: 'i2', name: '文件', type: 'number', max: 100, weight: 50 },
    ],
  },
  { key: 's2', name: '專題發表', weight: 40, letterMap: null, items: [{ key: 'total', name: '總分', type: 'number', max: 100, weight: 100 }] },
]

let pool: Pool
let adminId: string
let cohortId: string
let bing: TestSession
let ding: TestSession
let wu: TestSession
/** 兩個屆別都有指派的老師（Review 第 1 輪）。 */
let ji: TestSession
const groupIds = new Map<string, string>()
/** 每個種好的檔案：檔名 → id。 */
const fileIds = new Map<string, string>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 跟清單一樣的台北「m/d」。 */
function monthDay(date: Date): string {
  const [, m, d] = ymd(date).split('-')
  return `${Number(m)}/${Number(d)}`
}

function textPdf(line: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = `BT /F1 28 Tf 72 760 Td (${line}) Tj ET`
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAD0lEQVR4nGNgME5DIJwcAIc5By0Ywt6kAAAAAElFTkSuQmCC', 'base64')

type SeedFile = { name: string; mime: string; extension: string; bytes: Buffer }
const pdf = (name: string): SeedFile => ({ name, mime: 'application/pdf', extension: 'pdf', bytes: textPdf(name.replace(/[^A-Za-z0-9 ]/g, '') || 'C1-12') })

let seq = 0
async function insertStudent(): Promise<string> {
  seq += 1
  const studentNo = `43${String(Date.now()).slice(-6)}${seq}`
  const user = await pool.query<{ id: string }>(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [`批改學生${seq}`, `c112-${stamp.toLowerCase()}-${seq}@example.com`],
  )
  const id = user.rows[0]!.id
  await pool.query(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)`,
    [id, `批改學生${seq}`, studentNo, cohortId, `c112-${seq}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return id
}

async function insertGroup(code: string, member: string): Promise<string> {
  const at = new Date(Date.now() - DAY)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', 'active', $3, $3, 'system') returning id`,
    [cohortId, code, at],
  )
  const id = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
    [id, cohortId, member, at],
  )
  await pool.query(`insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, $3, $2)`, [id, member, at])
  groupIds.set(code, id)
  return id
}

/** 已發布的整組作業（沒有欄位，只收附件），回 `{ itemId, schemaId }`。 */
async function groupItem(stageId: string, title: string) {
  const item = await pool.query<{ id: string }>(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, due_at,
        title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
     values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'group', $2, 'draft', now() + interval '10 days',
             $3, 'C1-12 e2e', '<p>請繳交。</p>', '{"fields":[]}'::jsonb, 'user', $4, $4)
     returning id`,
    [cohortId, stageId, title, adminId],
  )
  const itemId = item.rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, 'C1-12 e2e', '<p>請繳交。</p>', $3) returning id`,
    [itemId, title, adminId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
    [itemId, adminId],
  )
  await pool.query(
    `update managed_items set status = 'published', actual_opened_at = now() - interval '1 day', current_content_version_id = $2, current_schema_version_id = $3
      where id = $1`,
    [itemId, content.rows[0]!.id, schema.rows[0]!.id],
  )
  return { itemId, schemaId: schema.rows[0]!.id }
}

/** 一組對一份作業的一次正式送出（附檔）；檔案本體寫進 app 的 `FILES_ROOT`（有設時）。 */
async function submit(item: { itemId: string; schemaId: string }, groupId: string, by: string, versionNo: number, files: readonly SeedFile[], at: Date) {
  const version = await pool.query<{ id: string }>(
    `insert into submission_versions
       (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
        received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
     values (gen_random_uuid(), $1, 'group', $2, $3, $4, '{}'::jsonb, $5, $6, $6, gen_random_uuid(), '[]'::jsonb, 1) returning id`,
    [item.itemId, groupId, versionNo, item.schemaId, by, at],
  )
  const versionId = version.rows[0]!.id
  const filesRoot = process.env.FILES_ROOT
  for (const [i, f] of files.entries()) {
    const id = randomUUID()
    const storageKey = `e2e-c112/${stamp}/${id}`
    if (filesRoot) {
      await fs.mkdir(path.join(filesRoot, path.dirname(storageKey)), { recursive: true })
      await fs.writeFile(path.join(filesRoot, storageKey), f.bytes)
    }
    const checksum = createHash('sha256').update(f.bytes).digest('hex')
    await pool.query(
      `insert into stored_files (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared, mime_detected,
                                 extension, checksum, status, storage_key, uploaded_real_at, finalized_at)
       values ($1, $2, 'cohort', $3, 'submission', $4, $5, $6, $6, $7, $8, 'stored', $9, now(), now())`,
      [id, by, cohortId, f.name, f.bytes.length, f.mime, f.extension, checksum, storageKey],
    )
    await pool.query(`insert into submission_files (submission_version_id, file_id, field_key, checksum) values ($1, $2, $3, $4)`, [versionId, id, `f${i}`, checksum])
    await pool.query(`insert into file_references (id, file_id, ref_type, ref_id) values (gen_random_uuid(), $1, 'submission_version', $2)`, [id, versionId])
    fileIds.set(f.name, id)
  }
}

async function assign(groupId: string, stageKey: string, teacherId: string) {
  await pool.query(
    `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, now() - interval '1 hour', $4)`,
    [groupId, stageKey, teacherId, adminId],
  )
}

const submittedAt = new Date(Date.now() - 2 * 3600_000)

/** 建一個進行中的屆別與一個階段（作業要掛階段）；把全域 `cohortId` 換成它，回階段 id。 */
async function insertCohort(code: string, name: string): Promise<string> {
  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'active', $3, 'system') returning id`,
      [code, name, ymd(new Date(Date.now() + 300 * DAY))],
    )
  ).rows[0]!.id
  return (
    await pool.query<{ id: string }>(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, 1, '期末', $2, 'system') returning id`,
      [cohortId, ymd(new Date(Date.now() - 30 * DAY))],
    )
  ).rows[0]!.id
}

/** 目前屆別發布一份方案（`STAGES`），每組每個評分項目要 3 位老師評。 */
async function publishScheme(name: string, groups: readonly string[]) {
  const scheme = await pool.query<{ id: string }>(
    `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
    [cohortId, name],
  )
  const versionId = (
    await pool.query<{ id: string }>(
      `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id)
       values (gen_random_uuid(), $1, 1, $2::jsonb, 'published', $3) returning id`,
      [scheme.rows[0]!.id, JSON.stringify(STAGES), adminId],
    )
  ).rows[0]!.id
  await pool.query('update grading_schemes set current_version_id = $2 where id = $1', [scheme.rows[0]!.id, versionId])
  for (const groupId of groups) {
    for (const stageKey of ['s1', 's2']) {
      await pool.query(`insert into stage_requirements (group_id, stage_key, required_count, created_by_user_id) values ($1, $2, 3, $3)`, [
        groupId,
        stageKey,
        adminId,
      ])
    }
  }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  const fresh = async () => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, 'teacher')
    } finally {
      await context.dispose()
    }
  }
  bing = await fresh()
  ding = await fresh()
  wu = await fresh()

  ji = await fresh()

  const stageId = await insertCohort(CODE, CODE)
  const students = [await insertStudent(), await insertStudent(), await insertStudent()]
  const g1 = await insertGroup('G1', students[0]!)
  const g2 = await insertGroup('G2', students[1]!)
  const g3 = await insertGroup('G3', students[2]!)

  await publishScheme(`${CODE} 評分方案`, [g1, g2, g3])

  const itemA = await groupItem(stageId, TITLE_A)
  const itemB = await groupItem(stageId, TITLE_B)
  await pool.query(`insert into grading_stage_settings (cohort_id, stage_key, item_id, updated_by_user_id) values ($1, 's1', $2, $3)`, [
    cohortId,
    itemA.itemId,
    adminId,
  ])
  await pool.query(`insert into grading_stage_settings (cohort_id, stage_key, description, updated_by_user_id) values ($1, 's2', $2, $3)`, [
    cohortId,
    DESCRIPTION,
    adminId,
  ])

  await submit(itemA, g1, students[0]!, 1, [pdf('G1-v1-draft.pdf')], new Date(submittedAt.getTime() - DAY))
  await submit(itemA, g1, students[0]!, 2, [pdf('G1-v2-report.pdf'), { name: 'G1-v2-diagram.png', mime: 'image/png', extension: 'png', bytes: PNG }], submittedAt)
  await submit(itemB, g1, students[0]!, 1, [pdf('G1-midterm.pdf')], submittedAt)
  await submit(itemA, g2, students[1]!, 1, [pdf('G2-report.pdf')], submittedAt)

  for (const groupId of [g1, g2, g3]) {
    await assign(groupId, 's1', bing.userId)
    await assign(groupId, 's2', bing.userId)
  }
  await assign(g1, 's2', ding.userId)
  await assign(g1, 's1', wu.userId)

  // Review 第 1 輪：老師己同時評兩個進行中屆別，兩份方案都有 s1（系統驗收）、s2（專題發表）。
  // 第一屆只評 G1 的 s1；第二屆評 H1 的 s1、s2 與 H2 的 s1。第二屆 s1、s2 都對應作業（C、D），H1 兩份都交了。
  await assign(g1, 's1', ji.userId)
  const firstCohort = cohortId
  const stage2 = await insertCohort(CODE2, NAME2)
  const others = [await insertStudent(), await insertStudent()]
  const h1 = await insertGroup('H1', others[0]!)
  const h2 = await insertGroup('H2', others[1]!)
  await publishScheme(`${CODE2} 評分方案`, [h1, h2])
  const itemC = await groupItem(stage2, TITLE_C)
  const itemD = await groupItem(stage2, TITLE_D)
  for (const [stageKey, item] of [['s1', itemC], ['s2', itemD]] as const) {
    await pool.query(`insert into grading_stage_settings (cohort_id, stage_key, item_id, updated_by_user_id) values ($1, $2, $3, $4)`, [
      cohortId,
      stageKey,
      item.itemId,
      adminId,
    ])
  }
  await submit(itemC, h1, others[0]!, 1, [pdf('H1-acceptance.pdf')], submittedAt)
  await submit(itemD, h1, others[0]!, 1, [pdf('H1-talk.pdf')], submittedAt)
  await assign(h1, 's1', ji.userId)
  await assign(h1, 's2', ji.userId)
  await assign(h2, 's1', ji.userId)
  cohortId = firstCohort
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function shoot(page: Page, name: string) {
  if (!shotDir) return
  await fs.mkdir(shotDir, { recursive: true })
  await page.screenshot({ path: path.join(shotDir, name), fullPage: true })
}

/** 用某位老師的 cookie 打附件下載端點（不跟轉址），回狀態碼。 */
async function downloadStatus(request: APIRequestContext, session: TestSession, fileName: string): Promise<number> {
  const response = await request.get(`/api/files/${fileIds.get(fileName)}`, { headers: { cookie: session.cookie }, maxRedirects: 0 })
  return response.status()
}

const benchUrl = (code: string, stageKey: string) => `/dashboard/teacher/grading/${groupIds.get(code)}?stage=${stageKey}`

test('AC-27：丙的評分清單——「系統驗收」區段 3 列（組別、狀態、附件、成績、批改）；有交的寫「N 個檔案・m/d 交」，沒交與「專題發表」一律「—」', async ({ page }) => {
  await signIn(page, bing)
  await page.goto('/dashboard/teacher/grading')
  await expect(page.getByText('草稿只有你和系辦看得到。')).toBeVisible()

  const acceptance = page.getByRole('table', { name: '系統驗收評分清單' })
  await expect(acceptance.getByRole('columnheader')).toHaveText(['組別', '狀態', '附件', '成績', '動作'])
  const rows = acceptance.getByTestId('grading-entry')
  await expect(rows).toHaveCount(3)
  const row = (code: string) => rows.filter({ has: page.getByText(code, { exact: true }) })
  await expect(row('G1').getByTestId('entry-attachment')).toHaveText(`2 個檔案・${monthDay(submittedAt)} 交`)
  await expect(row('G2').getByTestId('entry-attachment')).toHaveText(`1 個檔案・${monthDay(submittedAt)} 交`)
  await expect(row('G3').getByTestId('entry-attachment')).toHaveText('—')
  for (const code of ['G1', 'G2', 'G3']) {
    await expect(row(code)).toContainText('待評')
    await expect(row(code).getByTestId('entry-score')).toHaveText('—')
    await expect(row(code).getByRole('link', { name: `批改：${code}` })).toHaveAttribute('href', `${benchUrl(code, 's1')}`)
  }
  await expect(page.getByRole('region', { name: '系統驗收' }).getByTestId('grading-progress')).toHaveText('已評 0／3 組')

  const talk = page.getByRole('table', { name: '專題發表評分清單' })
  await expect(talk.getByTestId('grading-entry')).toHaveCount(3)
  await expect(talk.getByTestId('entry-attachment')).toHaveText(['—', '—', '—'])
  await shoot(page, 'ac27-overview.png')
})

test('AC-28：丙按 G1「批改」→ 三欄：左＝3 組（G1 高亮）＋上一組／下一組＋「繳交版本」只列系統驗收文件；中＝PDF 內嵌；右＝細項與評語。送出 → 已送出；下一組 → G2、高亮換、右欄清空', async ({ page }) => {
  await signIn(page, bing)
  await page.goto('/dashboard/teacher/grading')
  await page.getByRole('table', { name: '系統驗收評分清單' }).getByRole('link', { name: '批改：G1' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/teacher/grading/${groupIds.get('G1')}\\?stage=s1$`))

  // 左欄：本評分項目分給我的 3 組，目前組高亮；第一組「上一組」停用。
  const rail = page.getByRole('list', { name: '本評分項目的組別' })
  await expect(rail.getByTestId('rail-group')).toHaveCount(3)
  await expect(rail.getByRole('link', { name: /^G1/ })).toHaveAttribute('aria-current', 'page')
  await expect(rail.getByRole('link', { name: /^G2/ })).not.toHaveAttribute('aria-current', 'page')
  const switcher = page.getByRole('navigation', { name: '切換組別' })
  await expect(switcher.getByRole('link', { name: '上一組' })).toHaveAttribute('aria-disabled', 'true')

  // 「繳交版本」只有系統驗收文件的兩版（新到舊），沒有期中報告。
  const picker = page.getByTestId('submission-picker')
  await expect(picker).toHaveAttribute('data-hydrated', '')
  await expect(picker).toContainText(TITLE_A)
  await expect(page.getByRole('main')).not.toContainText(TITLE_B)
  await expect(page.getByRole('main')).not.toContainText('G1-midterm.pdf')
  const versions = picker.getByLabel('繳交版本')
  await expect(versions.locator('option')).toHaveCount(2)
  await expect(versions.locator('option').first()).toContainText('第 2 版')
  await expect(versions.locator('option').nth(1)).toContainText('第 1 版')
  const files = picker.getByRole('list', { name: '檔案' }).getByTestId('attachment')
  await expect(files).toHaveText([/G1-v2-report\.pdf/, /G1-v2-diagram\.png/])

  // 中欄：預設是第 2 版的 PDF，內嵌預覽。
  const pane = page.getByRole('region', { name: '文件預覽' })
  await expect(pane.locator('iframe')).toHaveAttribute('src', `/api/files/${fileIds.get('G1-v2-report.pdf')}/preview`)
  await shoot(page, 'ac28-three-columns.png')
  // 切到 PNG → 中欄換成圖片；切到第 1 版 → 檔案清單與中欄跟著換。
  await files.filter({ hasText: 'G1-v2-diagram.png' }).getByRole('button').click()
  await expect(pane.locator('iframe')).toHaveAttribute('src', `/api/files/${fileIds.get('G1-v2-diagram.png')}/preview`)
  await versions.selectOption({ label: (await versions.locator('option').nth(1).textContent())! })
  await expect(files).toHaveText([/G1-v1-draft\.pdf/])
  await expect(pane.locator('iframe')).toHaveAttribute('src', `/api/files/${fileIds.get('G1-v1-draft.pdf')}/preview`)

  // 右欄：細項分數（必填）、評語（選填）、「送出」。
  const bench = page.getByRole('region', { name: 'G1「系統驗收」評分表' })
  await expect(bench).toHaveAttribute('data-hydrated', '')
  await expect(bench.getByRole('button', { name: '儲存草稿' })).toBeVisible()
  await bench.getByLabel('1. 功能').fill('80')
  await bench.getByLabel('2. 文件').fill('90')
  await bench.getByLabel('評語（選填，最多 500 字）').fill('文件完整')
  await bench.getByRole('button', { name: '送出', exact: true }).click()
  await page.getByRole('dialog', { name: '確認送出' }).getByRole('button', { name: '確認送出' }).click()
  const receipt = page.getByRole('dialog', { name: '已送出' })
  await expect(receipt).toContainText('G1・系統驗收')
  await receipt.getByRole('button', { name: '知道了' }).click()
  await expect(bench.getByTestId('resubmit')).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('my-status')).toHaveText('已送出')
  await expect(page.getByRole('list', { name: '本評分項目的組別' }).getByRole('link', { name: /^G1/ })).toContainText('已送出')

  // 下一組：網址 groupId 換、左欄高亮換、右欄是 G2 自己的空白表單。
  await page.getByRole('navigation', { name: '切換組別' }).getByRole('link', { name: /^下一組/ }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/teacher/grading/${groupIds.get('G2')}\\?stage=s1$`))
  await expect(page.getByRole('list', { name: '本評分項目的組別' }).getByRole('link', { name: /^G2/ })).toHaveAttribute('aria-current', 'page')
  const next = page.getByRole('region', { name: 'G2「系統驗收」評分表' })
  await expect(next.getByLabel('1. 功能')).toHaveValue('')
  await expect(next.getByLabel('評語（選填，最多 500 字）')).toHaveValue('')
  await expect(page.getByTestId('submission-picker').getByLabel('繳交版本').locator('option')).toHaveCount(1)

  // 清單上 G1 變「已送出」、成績欄有分數。
  await page.goto('/dashboard/teacher/grading')
  const g1 = page.getByRole('table', { name: '系統驗收評分清單' }).getByTestId('grading-entry').filter({ has: page.getByText('G1', { exact: true }) })
  await expect(g1).toContainText('已送出')
  await expect(g1.getByTestId('entry-score')).toHaveText('85.00')
})

test('AC-29：丙切到「專題發表」批改 G1 → 中欄是標題＋「依發表當天表現評分」＋「這個項目不看作業，直接填分」，左欄沒有繳交；右欄照方案細項填分', async ({ page }) => {
  await signIn(page, bing)
  await page.goto(benchUrl('G1', 's1'))
  await page.getByRole('navigation', { name: '選擇評分項目' }).getByRole('link', { name: '專題發表' }).click()
  await expect(page).toHaveURL(/\?stage=s2$/)
  const pane = page.getByRole('region', { name: '文件預覽' })
  await expect(pane.getByRole('heading', { name: '專題發表' })).toBeVisible()
  await expect(pane).toContainText(DESCRIPTION)
  await expect(pane).toContainText('這個項目不看作業，直接填分')
  await expect(pane.locator('iframe')).toHaveCount(0)
  await expect(page.getByTestId('submission-picker')).toHaveCount(0)
  await expect(page.getByRole('list', { name: '本評分項目的組別' }).getByTestId('rail-group')).toHaveCount(3)
  const bench = page.getByRole('region', { name: 'G1「專題發表」評分表' })
  await expect(bench.getByLabel('1. 總分')).toBeVisible()
  await shoot(page, 'ac29-no-linked-item.png')
})

test('AC-28a（畫面）：丁只評 G1 的 s2——s2 頁沒有任何版本、打 s1 被拒、下載 A／B 附件都 403；戊只評 s1——只列 A 的版本、下載 A 成功、B 被拒', async ({ page }) => {
  const filesRoot = process.env.FILES_ROOT
  await signIn(page, ding)
  await page.goto(benchUrl('G1', 's2'))
  await expect(page.getByRole('region', { name: 'G1「專題發表」評分表' })).toBeVisible()
  await expect(page.getByTestId('no-linked-item')).toContainText('這個項目不看作業，直接填分')
  await expect(page.getByTestId('submission-picker')).toHaveCount(0)
  await expect(page.getByRole('main')).not.toContainText(TITLE_A)
  await expect(page.getByRole('main')).not.toContainText(TITLE_B)
  await expect(page.getByRole('list', { name: '本評分項目的組別' }).getByTestId('rail-group')).toHaveCount(1)
  await shoot(page, 'ac28a-ding-s2.png')

  await page.goto(benchUrl('G1', 's1'))
  await expect(page.getByRole('heading', { name: '找不到這個頁面' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText('G1-v2-report.pdf')
  expect(await downloadStatus(page.request, ding, 'G1-v2-report.pdf')).toBe(403)
  expect(await downloadStatus(page.request, ding, 'G1-midterm.pdf')).toBe(403)

  await signIn(page, wu)
  await page.goto(benchUrl('G1', 's1'))
  const picker = page.getByTestId('submission-picker')
  await expect(picker).toContainText(TITLE_A)
  await expect(picker.getByLabel('繳交版本').locator('option')).toHaveCount(2)
  await expect(page.getByRole('main')).not.toContainText(TITLE_B)
  await expect(page.getByRole('main')).not.toContainText('G1-midterm.pdf')
  await shoot(page, 'ac28a-wu-s1.png')
  if (filesRoot) expect(await downloadStatus(page.request, wu, 'G1-v2-report.pdf')).toBe(200)
  expect(await downloadStatus(page.request, wu, 'G1-midterm.pdf')).toBe(403)
})

test('Review 第 1 輪①：s1、s2 都對應作業時，從 s1 切到 s2 → 中欄預覽的是 s2 作業的檔案（不沿用 s1 的選取）', async ({ page }) => {
  await signIn(page, ji)
  await page.goto(benchUrl('H1', 's1'))
  const picker = page.getByTestId('submission-picker')
  await expect(picker).toHaveAttribute('data-hydrated', '')
  await expect(picker).toContainText(TITLE_C)
  const pane = page.getByRole('region', { name: '文件預覽' })
  await expect(pane.locator('iframe')).toHaveAttribute('src', `/api/files/${fileIds.get('H1-acceptance.pdf')}/preview`)

  await page.getByRole('navigation', { name: '選擇評分項目' }).getByRole('link', { name: '專題發表' }).click()
  await expect(page).toHaveURL(/\?stage=s2$/)
  await expect(page.getByRole('region', { name: 'H1「專題發表」評分表' })).toBeVisible()
  await expect(page.getByTestId('submission-picker')).toContainText(TITLE_D)
  await expect(page.getByTestId('submission-picker').getByRole('list', { name: '檔案' })).toContainText('H1-talk.pdf')
  await expect(pane).not.toContainText('這一版沒有附件')
  await expect(pane.locator('iframe')).toHaveAttribute('src', `/api/files/${fileIds.get('H1-talk.pdf')}/preview`)
})

test('Review 第 1 輪②：老師在兩個屆別都有 s1 → 清單分成兩區、標題帶屆別；批改頁左欄與上一組／下一組只有本屆的組', async ({ page }) => {
  await signIn(page, ji)
  await page.goto('/dashboard/teacher/grading')
  const first = page.getByRole('table', { name: `${CODE}（${CODE}）・系統驗收評分清單` })
  const second = page.getByRole('table', { name: `${NAME2}（${CODE2}）・系統驗收評分清單` })
  await expect(first.getByTestId('grading-entry')).toHaveCount(1)
  await expect(first).toContainText('G1')
  await expect(second.getByTestId('grading-entry')).toHaveCount(2)
  await expect(second).toContainText('H1')
  await expect(second).toContainText('H2')
  await expect(second).not.toContainText('G1')
  await expect(page.getByRole('heading', { name: `${NAME2}（${CODE2}）・系統驗收` })).toBeVisible()
  await expect(page.getByRole('table', { name: `${NAME2}（${CODE2}）・專題發表評分清單` }).getByTestId('grading-entry')).toHaveCount(1)
  await shoot(page, 'review1-two-cohorts.png')

  // 第一屆 G1 的批改頁：左欄只有 G1，沒有第二屆的 H1、H2；上一組、下一組都停用。
  await page.goto(benchUrl('G1', 's1'))
  const rail = page.getByRole('list', { name: '本評分項目的組別' })
  await expect(rail.getByTestId('rail-group')).toHaveCount(1)
  await expect(rail).not.toContainText('H1')
  const switcher = page.getByRole('navigation', { name: '切換組別' })
  await expect(switcher.getByRole('link', { name: '上一組' })).toHaveAttribute('aria-disabled', 'true')
  await expect(switcher.getByRole('link', { name: '下一組' })).toHaveAttribute('aria-disabled', 'true')

  // 第二屆 H1：左欄只有 H1、H2，下一組是 H2。
  await page.goto(benchUrl('H1', 's1'))
  await expect(page.getByRole('list', { name: '本評分項目的組別' }).getByTestId('rail-group')).toHaveText([/^H1/, /^H2/])
  await expect(page.getByRole('navigation', { name: '切換組別' }).getByRole('link', { name: /^下一組/ })).toHaveAttribute('href', benchUrl('H2', 's1'))
})
