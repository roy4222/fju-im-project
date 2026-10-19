import fs from 'node:fs/promises'
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * C3-16（#663）：系辦匯入分組（設計方案③ §6.4；AC-C3-21、22）。
 *
 * 系辦在「全部組別」按「匯入」→ 下載範本 → 選 CSV → 看六類預覽 → 執行 → 結果表（可下載）。
 * 逐列交易、簽核 hook、重送同 requestId 不重複由整合測試 `pg-group-import.integration.test.ts` 證明；這裡走真的畫面。
 *
 * 學生與組別直接用 owner 連線建好（成組流程是別張票的事）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `C316-${stamp}`

let pool: Pool
let cohortId: string
let adminId: string
type Student = { id: string; studentNo: string }

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

let seq = 0
async function insertStudent(): Promise<Student> {
  seq += 1
  const studentNo = `416${String(Date.now()).slice(-5)}${String(seq).padStart(2, '0')}`
  const name = `匯入${seq}號`
  const user = await pool.query<{ id: string }>(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `c316-${stamp.toLowerCase()}-${seq}@example.com`],
  )
  const id = user.rows[0]!.id
  await pool.query(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)`,
    [id, name, studentNo, cohortId, `c316-${seq}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { id, studentNo }
}

async function insertStudents(n: number): Promise<Student[]> {
  const list: Student[] = []
  for (let i = 0; i < n; i += 1) list.push(await insertStudent())
  return list
}

async function insertGroup(code: string, members: Student[]): Promise<string> {
  const at = new Date(Date.now() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                         created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
     values (gen_random_uuid(), $1, $2, 'general', 'active', $4, $4, $4, 'user', $3, $4, $3) returning id`,
    [cohortId, code, members[0]!.id, at],
  )
  const id = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
     select gen_random_uuid(), $1, $2, u, $4, 'user', $3, $4, $4 from unnest($5::uuid[]) as u`,
    [id, cohortId, members[0]!.id, at, members.map((m) => m.id)],
  )
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at) values (gen_random_uuid(), $1, $2, $3, $2, $3)`,
    [id, members[0]!.id, at],
  )
  return id
}

/** 一份建立中的組別（提案人＝e 已確認、另一位待確認），兩人都被占住。 */
async function insertOpenProposal(proposer: Student, invitee: Student): Promise<void> {
  const expires = new Date(Date.now() + 5 * 86_400_000)
  const proposal = await pool.query<{ id: string }>(
    `insert into group_proposals (id, cohort_id, proposer_user_id, group_type, expires_business_at, state, created_real_at, created_business_at, updated_at)
     values (gen_random_uuid(), $1, $2, 'general', $3, 'open', now(), now(), now()) returning id`,
    [cohortId, proposer.id, expires],
  )
  const proposalId = proposal.rows[0]!.id
  await pool.query(
    `insert into proposal_invitations (id, proposal_id, user_id, state, decided_real_at)
     values (gen_random_uuid(), $1, $2, 'confirmed', now()), (gen_random_uuid(), $1, $3, 'pending', null)`,
    [proposalId, proposer.id, invitee.id],
  )
  await pool.query(`insert into proposal_occupancy (user_id, proposal_id) values ($1, $3), ($2, $3)`, [proposer.id, invitee.id, proposalId])
}

let g01: string
let a: Student, b: Student, c: Student, d: Student
let e: Student, f: Student, h: Student
let six: Student[]

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()

  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, group_size_min, group_size_max, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 2, 5, 'system') returning id`,
    [CODE, `${CODE} 匯入分組測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id

  // AC-C3-21：a、b、c、d 未分組；G01 已存在（3 人）。
  g01 = await insertGroup('G01', await insertStudents(3))
  ;[a, b, c, d] = (await insertStudents(4)) as [Student, Student, Student, Student]
  // AC-C3-22：e 在建立中的組別；f 已在 G02；h 代碼格式錯；六個學號同填 G10。
  e = (await insertStudents(1))[0]!
  await insertOpenProposal(e, (await insertStudents(1))[0]!)
  const g02Members = await insertStudents(2)
  await insertGroup('G02', g02Members)
  f = g02Members[0]!
  h = (await insertStudents(1))[0]!
  six = await insertStudents(6)
})

test.afterAll(async () => {
  await pool?.end()
})

async function openAdminPage(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '分組', exact: true, level: 1 })).toBeVisible()
}

async function openImport(page: Page) {
  await page.getByRole('button', { name: '匯入', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '匯入分組' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function choose(dialog: ReturnType<Page['getByRole']>, name: string, csv: string) {
  // 對話框按「匯入」才載入，文字與上限載入後才能選檔。
  await expect(dialog.getByText(/上限 /)).toBeVisible()
  await dialog.getByLabel('選擇分組匯入 CSV 檔').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') })
  await expect(dialog.getByRole('heading', { name: `預覽・${name}` })).toBeVisible()
}

async function groupOf(code: string) {
  const rows = await pool.query<{ id: string; group_type: string; created_by_kind: string }>(
    `select id, group_type, created_by_kind from groups where cohort_id = $1 and code = $2`,
    [cohortId, code],
  )
  return rows.rows[0]
}

test('AC-C3-21：下載範本 → 選檔 → 預覽（建新組、加入）→ 執行；G07 成立且 a 是組長、c 加入 G01、全組收成組通知；結果表可下載', async ({ page }) => {
  await openAdminPage(page)
  const dialog = await openImport(page)

  // 下載範本：欄名正確。
  const templateDownload = page.waitForEvent('download')
  await dialog.getByRole('link', { name: '下載範本' }).click()
  const template = await templateDownload
  const templateText = await fs.readFile((await template.path())!, 'utf8')
  expect(templateText.replace(/^\uFEFF/, '').split(/\r?\n/)[0]).toBe('學號,組別代碼,類型')

  await choose(dialog, 'ac21.csv', `學號,組別代碼,類型\n${a.studentNo},G07,一般\n${b.studentNo},G07,\n${c.studentNo},G01,\n${d.studentNo},G09,產學\n`)
  await expect(dialog.getByTestId('group-import-count-create')).toHaveText('3')
  await expect(dialog.getByTestId('group-import-count-add')).toHaveText('1')
  await expect(dialog.getByTestId('group-import-row-2')).toHaveAttribute('data-kind', 'create')
  await expect(dialog.getByTestId('group-import-row-2')).toContainText('建新組 G07（一般）・組長')
  await expect(dialog.getByTestId('group-import-row-3')).toHaveAttribute('data-kind', 'create')
  await expect(dialog.getByTestId('group-import-row-4')).toHaveAttribute('data-kind', 'add')
  await expect(dialog.getByTestId('group-import-row-4')).toContainText('加入 G01')
  await expect(dialog.getByTestId('group-import-row-5')).toContainText('建新組 G09（產學）・組長')
  await dialog.screenshot({ path: test.info().outputPath('ac-c3-21-preview.png') })

  await dialog.getByRole('button', { name: '執行', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('已匯入：新組 2、加入 1。')
  await expect(dialog.getByTestId('group-import-result-4')).toContainText('已加入')

  const resultDownload = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '下載結果表' }).click()
  const result = await fs.readFile((await (await resultDownload).path())!, 'utf8')
  expect(result).toContain('"行號","學號","姓名","組別代碼","結果","說明"')
  expect(result).toContain(`"4","${c.studentNo}"`)

  const g07 = (await groupOf('G07'))!
  expect(g07).toMatchObject({ group_type: 'general', created_by_kind: 'user' })
  const leader = await pool.query<{ user_id: string }>('select user_id from group_leaders where group_id = $1 and valid_to is null', [g07.id])
  expect(leader.rows.map((r) => r.user_id)).toEqual([a.id])
  expect((await groupOf('G09'))!.group_type).toBe('industry')
  const g01Members = await pool.query<{ user_id: string; removal_reason: string | null }>(
    'select user_id, removal_reason from group_memberships where group_id = $1 and valid_to is null',
    [g01],
  )
  expect(g01Members.rows.find((r) => r.user_id === c.id)).toMatchObject({ removal_reason: null })
  const established = await pool.query<{ recipients: string[] }>(
    `select recipients from domain_events where type = 'group.established' and source_id = $1`,
    [g07.id],
  )
  expect(established.rows.map((r) => [...r.recipients].sort())).toEqual([[a.id, b.id].sort()])
  const changed = await pool.query(`select 1 from domain_events where type = 'group.members_changed' and source_id = $1`, [g01])
  expect(changed.rowCount).toBe(1)

  // 關掉對話框後頁面已更新。
  await dialog.getByRole('button', { name: '關閉' }).click()
  await expect(page.getByRole('region', { name: '全部組別' })).toContainText('G07')
})

test('AC-C3-22：建立中、已在別組、不在本屆、代碼格式錯、超過 5 人各寫原因；「執行」仍可按，只做可做的列，結果表逐列寫原因', async ({ page }) => {
  await openAdminPage(page)
  const dialog = await openImport(page)
  const csv = [
    '學號,組別代碼,類型',
    `${e.studentNo},G08,`,
    `${f.studentNo},G08,`,
    `499999999,G08,`,
    `${h.studentNo},G1,`,
    ...six.map((s) => `${s.studentNo},G10,`),
  ].join('\n')
  await choose(dialog, 'ac22.csv', csv)

  const row = (line: number) => dialog.getByTestId(`group-import-row-${line}`)
  await expect(row(2)).toHaveAttribute('data-kind', 'conflict_proposal')
  await expect(row(2)).toContainText('在建立中的組別裡，請先終止')
  await expect(row(3)).toHaveAttribute('data-kind', 'conflict_other_group')
  await expect(row(3)).toContainText('已在 G02')
  await expect(row(4)).toHaveAttribute('data-kind', 'invalid')
  await expect(row(4)).toContainText('不在本屆名單')
  await expect(row(5)).toHaveAttribute('data-kind', 'invalid')
  await expect(row(5)).toContainText('代碼格式要像 G01')
  for (let line = 6; line <= 11; line += 1) {
    await expect(row(line)).toHaveAttribute('data-kind', 'invalid')
    await expect(row(line)).toContainText('超過每組 5 人')
  }
  await expect(dialog.getByTestId('group-import-count-invalid')).toHaveText('8')
  await dialog.screenshot({ path: test.info().outputPath('ac-c3-22-preview.png') })

  const execute = dialog.getByRole('button', { name: '執行', exact: true })
  await expect(execute).toBeEnabled()
  await execute.click()
  await expect(dialog.getByRole('status')).toHaveText('已匯入：新組 0、加入 0；10 列沒有匯入，原因寫在結果表。')
  await expect(dialog.getByTestId('group-import-result-2')).toContainText('在建立中的組別裡，請先終止')
  await expect(dialog.getByTestId('group-import-result-3')).toContainText('已在 G02')
  await expect(dialog.getByTestId('group-import-result-4')).toContainText('不在本屆名單')
  await expect(dialog.getByTestId('group-import-result-5')).toContainText('代碼格式要像 G01')
  await expect(dialog.getByTestId('group-import-result-11')).toContainText('超過每組 5 人')
  expect(await groupOf('G08')).toBeUndefined()
  expect(await groupOf('G10')).toBeUndefined()
})
