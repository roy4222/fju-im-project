import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { CreateVersionInput, RespondInput } from '@/application/signoff'
import { PgAdvisorCommand } from '@/infrastructure/groups/pg-advisors'
import { PgGroupCommand } from '@/infrastructure/groups/pg-groups'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter, sha256 } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { createPosterPolicy } from '@/infrastructure/showcase/poster-policy'
import { PgSignoffCommand, PgSignoffQuery } from '@/infrastructure/signoff/pg-signoff'
import { createSubmissionFilePolicy } from '@/infrastructure/submissions/submission-file-policy'

/**
 * 票 26（#237）：逐人同意、老師同意與簽核管理。全部以正式執行角色 `fju_app` 連線。
 *
 * - 逐人表態（SGN-02）：每人一票、紀錄帶當時姓名學號、這次登入方式、按鈕原文、事件 ID、雙時間；最後一位學生同意才輪到老師。
 * - **不可代簽**（SGN-08）：管理員、別組學生、別的老師、帶著別人的請求編號重放、塞「替誰」的欄位，一律投不到別人頭上。
 * - 老師提前按（SGN-03）被拒；老師最後同意完成（SGN-04）；不同意／退回理由必填（SGN-05）；三人組 3／3（SGN-07）。
 * - 並發：最後兩位學生同時按只轉一次；同一人連按只記一票；表態與成員異動、改主指導同時只會一先一後。
 * - 失效（SGN-09）：成員或主指導變更同交易失效、不自動建新版、失效通知只給系辦；舊老師不能再投、新老師接新版。
 * - 重置、重開（＝建新版本）、作廢：理由必填、舊同意留歷史不計入新版、已完成的保留為歷史。
 * - 提醒：收件人＝還沒表態的人（含還沒輪到的老師），24 小時內不重複。
 * - 匯出：CSV 明細欄位齊全、防公式注入、沒有 IP／瀏覽器欄；可列印頁逸出；每次匯出存檔並留一筆紀錄。
 * - 附件下載：被簽核版本引用的附件，該版參與學生可下載；換掉的快照主指導不行。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let storage: FsFileStorage
let signoff: PgSignoffCommand
let query: PgSignoffQuery
let groups: PgGroupCommand
let advisors: PgAdvisorCommand
let adminId: string
const businessClock = { now: async () => new Date('2027-01-05T02:00:00Z') }
/** 可以撥的真實時鐘（提醒的 24 小時用）。 */
let realNow = new Date('2027-01-05T02:00:00Z')
const realClock = { now: () => new Date(realNow.getTime()) }

type Role = 'admin' | 'teacher' | 'student'
function actor(userId: string, roles: Role[], loginMethod: 'google' | 'password' | null = 'password'): ResolvedActor {
  return {
    kind: 'authenticated',
    userId,
    roles,
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: [],
    ...(loginMethod ? { loginMethod } : {}),
  }
}
const admin = () => actor(adminId, ['admin'])

let seq = 0
async function newUser(name: string, role: Role, cohortId?: string) {
  seq += 1
  const email = `sa${seq}-${randomUUID().slice(0, 8)}@example.com`
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, email],
  )
  const id = String(row.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
    [id, role],
  )
  const studentNo = role === 'student' ? `4120${String(seq).padStart(5, '0')}` : null
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email) values ($1, $2, $2, $3, $4, $5)`,
    [id, name, studentNo, cohortId ?? null, `c-${email}`],
  )
  if (studentNo && cohortId) {
    await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  }
  return { id, name, studentNo }
}
type Person = Awaited<ReturnType<typeof newUser>>

async function scenario(options: { size?: number } = {}) {
  seq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 3, 5, 'system') returning id`,
    [`SA-${seq}`],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const members: Person[] = []
  for (let i = 0; i < (options.size ?? 5); i += 1) members.push(await newUser(`學生${seq}-${i + 1}`, 'student', cohortId))
  const teacher = await newUser(`老師${seq}`, 'teacher')
  const group = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
    [cohortId],
  )
  const groupId = String(group.rows[0]!.id)
  for (const m of members) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now() - interval '1 day', 'system')`,
      [groupId, cohortId, m.id],
    )
  }
  await owner.sql(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now() - interval '1 day', $3)`,
    [groupId, members[0]!.id, adminId],
  )
  await owner.sql(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now() - interval '1 day', $3, '指派')`,
    [groupId, teacher.id, adminId],
  )
  return { cohortId, groupId, members, teacher }
}
type Scenario = Awaited<ReturnType<typeof scenario>>

/** 這一組正式送出過一個 PDF（票 21 的結果）；檔案本體也寫到磁碟，下載測試讀得到。 */
async function submittedFile(s: Scenario, name = '期末報告.pdf'): Promise<string> {
  const item = await owner.sql(
    `insert into managed_items (id, cohort_id, placement, audience_kind, title, created_by_kind)
     values (gen_random_uuid(), $1, 'news', 'public', '期末報告繳交', 'system') returning id`,
    [s.cohortId],
  )
  const itemId = String(item.rows[0]!.id)
  const schema = await owner.sql(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
    [itemId, adminId],
  )
  // 送出當下只有前兩位在組裡（之後加入、建版前已在組裡的參與者，票 22 的政策本來拿不到）。
  const snapshot = JSON.stringify(s.members.slice(0, 2).map((m) => m.id))
  const version = await owner.sql(
    `insert into submission_versions
       (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
        received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
     values (gen_random_uuid(), $1, 'group', $2, 1, $3, '{}'::jsonb, $4, now(), now(), gen_random_uuid(), $5::jsonb, 1) returning id`,
    [itemId, s.groupId, String(schema.rows[0]!.id), s.members[0]!.id, snapshot],
  )
  const versionId = String(version.rows[0]!.id)
  const bytes = Buffer.from(`%PDF-1.7\n${name}\n`)
  const checksum = sha256(bytes.toString())
  const key = `files/2027/01/${randomUUID()}`
  await fs.mkdir(path.dirname(path.join(root, key)), { recursive: true })
  await fs.writeFile(path.join(root, key), bytes)
  const file = await owner.sql(
    `insert into stored_files (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared, mime_detected,
                               extension, checksum, status, storage_key, uploaded_real_at, finalized_at)
     values (gen_random_uuid(), $1, 'cohort', $2, 'submission', $3, $4, 'application/pdf', 'application/pdf', 'pdf', $5,
             'stored', $6, now(), now()) returning id`,
    [s.members[0]!.id, s.cohortId, name, bytes.length, checksum, key],
  )
  const fileId = String(file.rows[0]!.id)
  await owner.sql(`insert into submission_files (submission_version_id, file_id, field_key, checksum) values ($1, $2, 'report', $3)`, [
    versionId,
    fileId,
    checksum,
  ])
  await owner.sql(`insert into file_references (id, file_id, ref_type, ref_id) values (gen_random_uuid(), $1, 'submission_version', $2)`, [
    fileId,
    versionId,
  ])
  return fileId
}

function input(s: Scenario, overrides: Partial<CreateVersionInput> = {}): CreateVersionInput {
  return {
    groupId: s.groupId,
    purpose: 'result_confirmation',
    content: '本組確認期中結果如下。',
    attachmentFileIds: [],
    showcaseEntryId: null,
    ...overrides,
  }
}

async function mustCreate(s: Scenario, overrides: Partial<CreateVersionInput> = {}) {
  const r = await signoff.createVersion(admin(), input(s, overrides), randomUUID())
  if (!r.ok) throw new Error(`${r.code} ${r.message}`)
  return r.receipt
}

async function checksumOf(versionId: string): Promise<string> {
  return String((await owner.sql('select content_checksum from signoff_package_versions where id = $1', [versionId])).rows[0]!.content_checksum)
}

async function vote(who: ResolvedActor, versionId: string, decision: RespondInput['decision'] = 'agree', reason: string | null = null, requestId = randomUUID()) {
  return signoff.respond(who, { versionId, contentChecksum: await checksumOf(versionId), decision, reason }, requestId)
}

async function mustVote(who: ResolvedActor, versionId: string, decision: RespondInput['decision'] = 'agree', reason: string | null = null) {
  const r = await vote(who, versionId, decision, reason)
  if (!r.ok) throw new Error(`${r.code} ${r.message}`)
  return r.receipt
}

const student = (p: Person, loginMethod: 'google' | 'password' = 'password') => actor(p.id, ['student'], loginMethod)
const teacherOf = (s: Scenario) => actor(s.teacher.id, ['teacher'])

async function statusOf(versionId: string) {
  return (await owner.sql('select state, cause, completed_real_at from signoff_version_status where version_id = $1', [versionId])).rows[0]!
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

async function approvalsOf(versionId: string): Promise<number> {
  return count('select count(*) as n from approvals where version_id = $1', [versionId])
}

async function recipientsOf(type: string, sourceId: string): Promise<string[]> {
  const rows = await owner.sql(`select recipients from domain_events where type = $1 and source_id = $2 order by occurred_real_at`, [type, sourceId])
  return rows.rows.flatMap((r) => (r.recipients as string[]).map(String)).sort()
}

async function revisionOf(groupId: string): Promise<number> {
  return Number((await owner.sql('select revision from groups where id = $1', [groupId])).rows[0]!.revision)
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'signoff_votes', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-signoff-votes-'))
  const a = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), '系辦甲', 'sa-admin@example.com', true, now(), 'active') returning id`,
  )
  adminId = String(a.rows[0]!.id)
  // 有效的管理員角色（失效通知、退回通知的收件人）。
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'admin', $1, now())`,
    [adminId],
  )
  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'signoff-votes-secret-signoff-votes-secret',
    policies: { poster: createPosterPolicy(() => app), submission: createSubmissionFilePolicy(() => app) },
    db: () => app,
  })
  const common = { audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), businessClock, pool: () => app }
  signoff = new PgSignoffCommand({ ...common, events: new PgEventPublisher(), files: storage, realClock })
  query = new PgSignoffQuery({ pool: () => app })
  groups = new PgGroupCommand({ ...common, events: new PgEventPublisher(), dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }), signoff })
  advisors = new PgAdvisorCommand({ ...common, events: new PgEventPublisher(), files: storage, signoff })
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('逐人表態與老師最後同意（SGN-02、03、04、07）', () => {
  it('五位學生各自同意：紀錄帶當時姓名學號、這次登入方式、按鈕原文、事件 ID、雙時間；第五位同意才轉等老師，輪到老師只通知主指導', async () => {
    const s = await scenario()
    const v = await mustCreate(s)
    for (const [i, m] of s.members.slice(0, 4).entries()) {
      const r = await mustVote(student(m, i === 0 ? 'google' : 'password'), v.versionId)
      expect(r).toMatchObject({ state: 'collecting', agreed: i + 1, total: 5, role: 'student', result: 'agree' })
    }
    expect((await statusOf(v.versionId)).state).toBe('collecting')
    expect(await recipientsOf('signoff.teacher_turn', v.versionId)).toEqual([])

    const last = await mustVote(student(s.members[4]!), v.versionId)
    expect(last).toMatchObject({ state: 'teacher_pending', agreed: 5, total: 5 })
    expect(await recipientsOf('signoff.teacher_turn', v.versionId)).toEqual([s.teacher.id])

    const rows = (
      await owner.sql(
        `select a.user_id, a.role, a.display_name_at, a.student_no_at, a.result, a.login_method, a.button_text, a.request_id,
                a.real_at, a.business_at, e.type as event_type
           from approvals a join domain_events e on e.id = a.event_id
          where a.version_id = $1 order by a.real_at`,
        [v.versionId],
      )
    ).rows
    expect(rows).toHaveLength(5)
    const first = rows.find((r) => r.user_id === s.members[0]!.id)!
    expect(first).toMatchObject({
      role: 'student',
      display_name_at: s.members[0]!.name,
      student_no_at: s.members[0]!.studentNo,
      result: 'agree',
      login_method: 'google',
      button_text: '我已閱讀並同意',
      event_type: 'signoff.vote_recorded',
    })
    expect(rows.filter((r) => r.login_method === 'password')).toHaveLength(4)
    expect(new Date(first.business_at as string).toISOString()).toBe('2027-01-05T02:00:00.000Z')
    // 沒有 IP、瀏覽器、token 欄。
    const columns = (await owner.sql(`select column_name from information_schema.columns where table_name = 'approvals'`)).rows.map((r) => r.column_name)
    expect(columns.some((c) => /ip|agent|token|browser/i.test(String(c)))).toBe(false)
  })

  it('學生沒全同意，老師提前按被拒（STUDENTS_PENDING）且沒有寫任何列；全員同意後老師同意＝完成，完成通知給完成當下的組員與主指導', async () => {
    const s = await scenario()
    const v = await mustCreate(s)
    for (const m of s.members.slice(0, 4)) await mustVote(student(m), v.versionId)
    const early = await vote(teacherOf(s), v.versionId)
    expect(early).toMatchObject({ ok: false, code: 'STUDENTS_PENDING' })
    expect(await approvalsOf(v.versionId)).toBe(4)

    await mustVote(student(s.members[4]!), v.versionId)
    const done = await mustVote(teacherOf(s), v.versionId)
    expect(done).toMatchObject({ state: 'complete', role: 'advisor', result: 'agree' })
    const status = await statusOf(v.versionId)
    expect(status.state).toBe('complete')
    expect(status.completed_real_at).not.toBeNull()
    const advisorRow = (await owner.sql(`select role, student_no_at, button_text from approvals where version_id = $1 and user_id = $2`, [v.versionId, s.teacher.id])).rows[0]!
    expect(advisorRow).toEqual({ role: 'advisor', student_no_at: null, button_text: '以指導老師身分同意' })
    expect(await recipientsOf('signoff.completed', v.versionId)).toEqual([...s.members.map((m) => m.id), s.teacher.id].sort())

    // 已完成再按：已投票。
    expect(await vote(teacherOf(s), v.versionId)).toMatchObject({ ok: false, code: 'ALREADY_VOTED' })
  })

  it('三人組按實際三人：3／3 就輪到老師，不等不存在的第四、五人（SGN-07）', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    for (const m of s.members.slice(0, 2)) await mustVote(student(m), v.versionId)
    expect(await mustVote(student(s.members[2]!), v.versionId)).toMatchObject({ state: 'teacher_pending', agreed: 3, total: 3 })
    expect(await mustVote(teacherOf(s), v.versionId)).toMatchObject({ state: 'complete' })
  })

  it('三個角色的進度同一份：數字、缺誰、我的表態一致（SGN-10）', async () => {
    const s = await scenario()
    const v = await mustCreate(s)
    await mustVote(student(s.members[0]!), v.versionId)
    await mustVote(student(s.members[1]!), v.versionId)
    const board = await query.adminBoard(admin(), s.cohortId)
    if (!board.ok) throw new Error(board.message)
    const adminProgress = board.receipt.groups[0]!.packages.result_confirmation!.progress
    const mine = (await query.studentView(student(s.members[0]!))).versions[0]!
    const teacherCard = (await query.teacherView(teacherOf(s)))[0]!
    expect(adminProgress.agreed).toBe(2)
    expect(mine.progress).toEqual(adminProgress)
    expect(teacherCard.current.progress).toEqual(adminProgress)
    expect(adminProgress.missing).toEqual([...s.members.slice(2).map((m) => m.name), `${s.teacher.name}（主指導）`])
    expect(mine.viewer).toMatchObject({ role: 'student', voted: 'agree', canRespond: false })
    const other = (await query.studentView(student(s.members[3]!))).versions[0]!
    expect(other.viewer).toMatchObject({ role: 'student', voted: null, canRespond: true })
    expect(teacherCard.mine).toEqual({ isSnapshotAdvisor: true, voted: null })
  })
})

describe('不同意與退回（SGN-05）', () => {
  it('不同意沒填理由被拒；有理由就回到修正中，理由記在狀態與紀錄上；之後誰都不能再投；退回通知給系辦與主指導', async () => {
    const s = await scenario()
    const v = await mustCreate(s)
    await mustVote(student(s.members[0]!), v.versionId)
    expect(await vote(student(s.members[1]!), v.versionId, 'reject', '   ')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await approvalsOf(v.versionId)).toBe(1)

    const r = await mustVote(student(s.members[1]!), v.versionId, 'reject', '第三章數據有誤')
    expect(r).toMatchObject({ state: 'revision', result: 'disagree' })
    expect(await statusOf(v.versionId)).toMatchObject({ state: 'revision', cause: '第三章數據有誤' })
    const row = (await owner.sql(`select result, reason, button_text from approvals where version_id = $1 and user_id = $2`, [v.versionId, s.members[1]!.id])).rows[0]!
    expect(row).toEqual({ result: 'disagree', reason: '第三章數據有誤', button_text: '不同意並退回修正' })
    expect(await recipientsOf('signoff.returned', v.versionId)).toEqual([adminId, s.teacher.id].sort())
    expect(await vote(student(s.members[2]!), v.versionId)).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('老師退回（理由必填）→ 修正中，紀錄 result=return', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    for (const m of s.members) await mustVote(student(m), v.versionId)
    expect(await vote(teacherOf(s), v.versionId, 'reject', '')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await mustVote(teacherOf(s), v.versionId, 'reject', '結論要補實驗')).toMatchObject({ state: 'revision', result: 'return' })
    expect(await recipientsOf('signoff.returned', v.versionId)).toEqual([adminId])
  })
})

describe('不可代簽（SGN-08）與重放', () => {
  it('管理員直接呼叫 → FORBIDDEN；別組學生、別的老師 → NOT_PARTICIPANT；讀不到登入方式 → UNAUTHENTICATED；內容核對碼不符 → VERSION_SUPERSEDED；全部沒寫任何列', async () => {
    const s = await scenario()
    const other = await scenario()
    const v = await mustCreate(s)
    expect(await vote(admin(), v.versionId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await vote(student(other.members[0]!), v.versionId)).toMatchObject({ ok: false, code: 'NOT_PARTICIPANT' })
    expect(await vote(teacherOf(other), v.versionId)).toMatchObject({ ok: false, code: 'NOT_PARTICIPANT' })
    expect(await vote(actor(s.members[0]!.id, ['student'], null), v.versionId)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    const stale = await signoff.respond(student(s.members[0]!), { versionId: v.versionId, contentChecksum: sha256('舊頁的內容'), decision: 'agree' }, randomUUID())
    expect(stale).toMatchObject({ ok: false, code: 'VERSION_SUPERSEDED' })
    expect(await approvalsOf(v.versionId)).toBe(0)
  })

  it('輸入裡塞「替誰」的欄位沒有用：管理員塞了照樣 FORBIDDEN；學生 B 塞 A 的 id，記下的是 B 自己的一票', async () => {
    const s = await scenario()
    const v = await mustCreate(s)
    const checksum = await checksumOf(v.versionId)
    const smuggled = { versionId: v.versionId, contentChecksum: checksum, decision: 'agree', userId: s.members[0]!.id, onBehalfOf: s.members[0]!.id }
    expect(await signoff.respond(admin(), smuggled as unknown as RespondInput, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const b = await signoff.respond(student(s.members[1]!), smuggled as unknown as RespondInput, randomUUID())
    expect(b.ok).toBe(true)
    const voters = (await owner.sql('select user_id from approvals where version_id = $1', [v.versionId])).rows.map((r) => r.user_id)
    expect(voters).toEqual([s.members[1]!.id])
  })

  it('同一個請求編號重送回原回執、只記一票；別人拿同一個請求編號重放，記的是他自己的票、不是原投票人的', async () => {
    const s = await scenario()
    const v = await mustCreate(s)
    const requestId = randomUUID()
    const first = await vote(student(s.members[0]!), v.versionId, 'agree', null, requestId)
    const again = await vote(student(s.members[0]!), v.versionId, 'agree', null, requestId)
    expect(first.ok && again.ok).toBe(true)
    if (first.ok && again.ok) expect(again.receipt.approvalId).toBe(first.receipt.approvalId)
    expect(await approvalsOf(v.versionId)).toBe(1)

    const replay = await vote(student(s.members[1]!), v.versionId, 'agree', null, requestId)
    expect(replay.ok).toBe(true)
    const rows = (await owner.sql('select user_id from approvals where version_id = $1 order by real_at', [v.versionId])).rows.map((r) => r.user_id)
    expect(rows.sort()).toEqual([s.members[0]!.id, s.members[1]!.id].sort())
    // 管理員拿學生的請求編號重放：不會拿到學生的回執，照樣被拒。
    expect(await vote(admin(), v.versionId, 'agree', null, requestId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('資料庫層：fju_app 改不了、刪不了同意紀錄', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    await mustVote(student(s.members[0]!), v.versionId)
    await expect(app.query(`update approvals set user_id = $1 where version_id = $2`, [s.members[1]!.id, v.versionId])).rejects.toThrow()
    await expect(app.query(`delete from approvals where version_id = $1`, [v.versionId])).rejects.toThrow()
  })
})

describe('並發', () => {
  it('最後兩位學生同時同意：兩票都記、狀態轉一次、輪到老師的事件只有一則', async () => {
    const s = await scenario()
    const v = await mustCreate(s)
    for (const m of s.members.slice(0, 3)) await mustVote(student(m), v.versionId)
    const checksum = await checksumOf(v.versionId)
    const results = await Promise.all(
      s.members.slice(3).map((m) => signoff.respond(student(m), { versionId: v.versionId, contentChecksum: checksum, decision: 'agree' }, randomUUID())),
    )
    expect(results.every((r) => r.ok)).toBe(true)
    expect(await approvalsOf(v.versionId)).toBe(5)
    expect((await statusOf(v.versionId)).state).toBe('teacher_pending')
    expect(await count(`select count(*) as n from domain_events where type = 'signoff.teacher_turn' and source_id = $1`, [v.versionId])).toBe(1)
  })

  it('同一位學生用兩個請求編號同時按：只記一票，另一筆 ALREADY_VOTED', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    const checksum = await checksumOf(v.versionId)
    const results = await Promise.all(
      [0, 1].map(() => signoff.respond(student(s.members[0]!), { versionId: v.versionId, contentChecksum: checksum, decision: 'agree' }, randomUUID())),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'ALREADY_VOTED' })
    expect(await approvalsOf(v.versionId)).toBe(1)
  })

  it('表態與加入組員同時送出：只會一先一後——票記在舊版、舊版隨後失效，或表態看到已失效被拒；失效的版本不會多出失效後的票', async () => {
    for (let round = 0; round < 3; round += 1) {
      const s = await scenario({ size: 3 })
      const v = await mustCreate(s)
      const newcomer = await newUser(`並發新人${round}`, 'student', s.cohortId)
      const revision = await revisionOf(s.groupId)
      const checksum = await checksumOf(v.versionId)
      const [voted, added] = await Promise.all([
        signoff.respond(student(s.members[0]!), { versionId: v.versionId, contentChecksum: checksum, decision: 'agree' }, randomUUID()),
        groups.addMember(admin(), { groupId: s.groupId, revision, studentNo: newcomer.studentNo!, reason: '並發' }, randomUUID()),
      ])
      expect(added.ok).toBe(true)
      expect((await statusOf(v.versionId)).state).toBe('superseded')
      if (voted.ok) {
        expect(await approvalsOf(v.versionId)).toBe(1)
        // 票一定在失效之前：兩個事件 ID 都是 uuidv7（依產生先後排序），表態那一則早於失效那一則。
        const voteEvent = String((await owner.sql('select event_id from approvals where version_id = $1', [v.versionId])).rows[0]!.event_id)
        const supersededEvent = String(
          (await owner.sql(`select id from domain_events where type = 'signoff.superseded' and source_id = $1`, [v.versionId])).rows[0]!.id,
        )
        expect(voteEvent < supersededEvent).toBe(true)
      } else {
        expect(voted.code).toBe('VERSION_SUPERSEDED')
        expect(await approvalsOf(v.versionId)).toBe(0)
      }
    }
  })

  it('老師最後同意與改派主指導同時送出：只會一先一後（完成後才失效，或老師被拒）', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    for (const m of s.members) await mustVote(student(m), v.versionId)
    const next = await newUser('接手老師', 'teacher')
    const revision = await revisionOf(s.groupId)
    const checksum = await checksumOf(v.versionId)
    const [voted, reassigned] = await Promise.all([
      signoff.respond(teacherOf(s), { versionId: v.versionId, contentChecksum: checksum, decision: 'agree' }, randomUUID()),
      advisors.assign(admin(), { groupId: s.groupId, revision, teacherUserId: next.id, reason: '改派', gradingSelections: [] }, randomUUID()),
    ])
    expect(reassigned.ok).toBe(true)
    // 已完成的目前版本遇到主指導變更也一樣失效（S11-08）。
    expect(await statusOf(v.versionId)).toMatchObject({ state: 'superseded', cause: 'advisor_change' })
    if (!voted.ok) expect(voted.code).toBe('VERSION_SUPERSEDED')
    expect(await count(`select count(*) as n from approvals where version_id = $1 and role = 'advisor'`, [v.versionId])).toBe(voted.ok ? 1 : 0)
  })
})

describe('成員或主指導改變 → 目前版本失效（S11-08、SGN-09）', () => {
  it('改派主指導：同交易失效（指導老師變更）、不自動建新版、失效通知只給系辦；舊老師不能再投；系辦建新版後舊老師不是參與者、新老師等學生', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    for (const m of s.members) await mustVote(student(m), v.versionId)
    const before = await count(`select count(*) as n from signoff_package_versions`)
    const next = await newUser('新指導老師', 'teacher')
    const reassigned = await advisors.assign(
      admin(),
      { groupId: s.groupId, revision: await revisionOf(s.groupId), teacherUserId: next.id, reason: '老師休假', gradingSelections: [] },
      randomUUID(),
    )
    expect(reassigned.ok).toBe(true)
    if (reassigned.ok) expect(reassigned.receipt.supersededSignoffCount).toBe(1)
    expect(await statusOf(v.versionId)).toMatchObject({ state: 'superseded', cause: 'advisor_change' })
    expect(await count(`select count(*) as n from signoff_package_versions`)).toBe(before)
    expect(await approvalsOf(v.versionId)).toBe(3)
    // 失效通知：只有系辦（有效管理員）；學生與老師都不收。
    expect(await recipientsOf('signoff.superseded', v.versionId)).toEqual([adminId])

    const old = await vote(teacherOf(s), v.versionId)
    expect(old).toMatchObject({ ok: false, code: 'VERSION_SUPERSEDED' })
    if (!old.ok) expect(old.message).toContain('指導老師變更')

    const v2 = await mustCreate(s)
    expect(await vote(teacherOf(s), v2.versionId)).toMatchObject({ ok: false, code: 'NOT_PARTICIPANT' })
    expect(await vote(actor(next.id, ['teacher']), v2.versionId)).toMatchObject({ ok: false, code: 'STUDENTS_PENDING' })
    // 新版依新集合重算，不沿用舊票。
    expect(await approvalsOf(v2.versionId)).toBe(0)
    const detail = await query.versionDetail(actor(next.id, ['teacher']), v2.versionId)
    expect(detail.ok && detail.receipt.participants.advisor.userId).toBe(next.id)
  })

  it('解除主指導也失效；首次指派沒有進行中的版本什麼都不動', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    const removed = await advisors.unassign(admin(), { groupId: s.groupId, revision: await revisionOf(s.groupId), reason: '解除' }, randomUUID())
    expect(removed.ok).toBe(true)
    expect(await statusOf(v.versionId)).toMatchObject({ state: 'superseded', cause: 'advisor_change' })
    const again = await advisors.assign(
      admin(),
      { groupId: s.groupId, revision: await revisionOf(s.groupId), teacherUserId: s.teacher.id, reason: '重新指派', gradingSelections: [] },
      randomUUID(),
    )
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.receipt.supersededSignoffCount).toBe(0)
    expect(await count(`select count(*) as n from domain_events where type = 'signoff.superseded' and source_id = $1`, [v.versionId])).toBe(1)
  })

  it('加入組員：失效通知只給系辦；新加入者讀得到失效原因，對舊版不能投（NOT_PARTICIPANT 或 VERSION_SUPERSEDED）', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    const newcomer = await newUser('轉學生', 'student', s.cohortId)
    await groups.addMember(admin(), { groupId: s.groupId, revision: await revisionOf(s.groupId), studentNo: newcomer.studentNo!, reason: '加入' }, randomUUID())
    expect(await recipientsOf('signoff.superseded', v.versionId)).toEqual([adminId])
    const view = await query.studentView(student(newcomer))
    expect(view.versions[0]).toMatchObject({ versionId: v.versionId, state: 'superseded', cause: 'member_change' })
    expect(view.versions[0]!.viewer).toMatchObject({ role: null, canRespond: false })
    expect(await vote(student(newcomer), v.versionId)).toMatchObject({ ok: false, code: 'VERSION_SUPERSEDED' })
  })
})

describe('重置、重開（建新版本）、作廢（S11-07、S11-12）', () => {
  it('重置收集中的版本：理由必填；建新版（原因＝系辦重置）、參與者依此刻重算、附件轉綁；舊版已失效、舊票留著不計入新版；同請求編號只建一版', async () => {
    const s = await scenario()
    const fileId = await submittedFile(s)
    const v = await mustCreate(s, { attachmentFileIds: [fileId] })
    await mustVote(student(s.members[0]!), v.versionId)
    await mustVote(student(s.members[1]!), v.versionId)
    expect(await signoff.reset(admin(), { versionId: v.versionId, reason: ' ' }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await signoff.reopen(admin(), { versionId: v.versionId, reason: '想重開' }, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await signoff.reset(student(s.members[0]!), { versionId: v.versionId, reason: '學生重置' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })

    const requestId = randomUUID()
    const r = await signoff.reset(admin(), { versionId: v.versionId, reason: '附件放錯版' }, requestId)
    if (!r.ok) throw new Error(r.message)
    const replay = await signoff.reset(admin(), { versionId: v.versionId, reason: '附件放錯版' }, requestId)
    expect(replay.ok && replay.receipt.versionId).toBe(r.receipt.versionId)
    expect(r.receipt).toMatchObject({ kind: 'reset', versionNo: 2, fromVersionNo: 1, supersededVersionNo: 1, studentCount: 5 })

    expect(await statusOf(v.versionId)).toMatchObject({ state: 'superseded', cause: 'reset' })
    expect(await statusOf(r.receipt.versionId)).toMatchObject({ state: 'collecting' })
    expect(await approvalsOf(v.versionId)).toBe(2)
    expect(await approvalsOf(r.receipt.versionId)).toBe(0)
    const newRow = (await owner.sql('select supersede_cause, content_checksum, attachment_file_versions from signoff_package_versions where id = $1', [r.receipt.versionId])).rows[0]!
    expect(newRow.supersede_cause).toBe('reset')
    expect(newRow.content_checksum).toBe(await checksumOf(v.versionId))
    expect((newRow.attachment_file_versions as { fileId: string }[]).map((a) => a.fileId)).toEqual([fileId])
    expect(
      await count(`select count(*) as n from file_references where file_id = $1 and ref_type = 'signoff_version' and ref_id = $2 and released_at is null`, [
        fileId,
        r.receipt.versionId,
      ]),
    ).toBe(1)
    expect(await recipientsOf('signoff.version_created', r.receipt.versionId)).toEqual(s.members.map((m) => m.id).sort())
    // 系辦自己的動作造成的失效：留事件、不通知。
    expect(await recipientsOf('signoff.superseded', v.versionId)).toEqual([])
    const audit = (await owner.sql(`select reason from audit_events where action = 'signoff.version_reset' and target_id = $1`, [v.versionId])).rows[0]!
    expect(audit.reason).toBe('附件放錯版')
    // 舊頁再按：已失效。
    expect(await vote(student(s.members[2]!), v.versionId)).toMatchObject({ ok: false, code: 'VERSION_SUPERSEDED' })
  })

  it('重置已完成的版本：舊版保留為已完成的歷史紀錄；新版重新收集', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    for (const m of s.members) await mustVote(student(m), v.versionId)
    await mustVote(teacherOf(s), v.versionId)
    const r = await signoff.reset(admin(), { versionId: v.versionId, reason: '校方要求重簽' }, randomUUID())
    expect(r).toMatchObject({ ok: true, receipt: { supersededVersionNo: null, versionNo: 2 } })
    expect((await statusOf(v.versionId)).state).toBe('complete')
    const detail = await query.versionDetail(admin(), v.versionId)
    expect(detail.ok && detail.receipt.isCurrent).toBe(false)
  })

  it('重開退回的版本＝建新版：舊版改已失效（系辦重置）；重開組員變更而失效的版本，新版原因沿用「組員變更」', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    await mustVote(student(s.members[0]!), v.versionId, 'reject', '錯字')
    expect(await signoff.reset(admin(), { versionId: v.versionId, reason: '重置' }, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
    const r = await signoff.reopen(admin(), { versionId: v.versionId, reason: '已修正錯字' }, randomUUID())
    if (!r.ok) throw new Error(r.message)
    expect(r.receipt.kind).toBe('reopen')
    expect(await statusOf(v.versionId)).toMatchObject({ state: 'superseded', cause: 'reset' })

    const newcomer = await newUser('新組員', 'student', s.cohortId)
    await groups.addMember(admin(), { groupId: s.groupId, revision: await revisionOf(s.groupId), studentNo: newcomer.studentNo!, reason: '加入' }, randomUUID())
    const r3 = await signoff.reopen(admin(), { versionId: r.receipt.versionId, reason: '依新組員重簽' }, randomUUID())
    if (!r3.ok) throw new Error(r3.message)
    expect(r3.receipt.studentCount).toBe(4)
    const cause = (await owner.sql('select supersede_cause from signoff_package_versions where id = $1', [r3.receipt.versionId])).rows[0]!.supersede_cause
    expect(cause).toBe('member_change')
    expect(await statusOf(r.receipt.versionId)).toMatchObject({ state: 'superseded', cause: 'member_change' })
  })

  it('作廢：理由必填、之後誰都不能投（CONFLICT）；已作廢不能再作廢；重開後又能收集', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    expect(await signoff.voidVersion(admin(), { versionId: v.versionId, reason: '' }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await signoff.voidVersion(admin(), { versionId: v.versionId, reason: '這組改期' }, randomUUID())).toMatchObject({ ok: true })
    expect(await statusOf(v.versionId)).toMatchObject({ state: 'void', cause: '這組改期' })
    expect(await vote(student(s.members[0]!), v.versionId)).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await signoff.voidVersion(admin(), { versionId: v.versionId, reason: '再一次' }, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
    const r = await signoff.reopen(admin(), { versionId: v.versionId, reason: '恢復' }, randomUUID())
    if (!r.ok) throw new Error(r.message)
    expect((await statusOf(v.versionId)).state).toBe('void')
    expect(await mustVote(student(s.members[0]!), r.receipt.versionId)).toMatchObject({ state: 'collecting' })
  })
})

describe('提醒未同意者（S11-11）', () => {
  it('收件人＝還沒表態的學生＋主指導（還沒輪到也算）；已同意的人不收；24 小時內再按被拒並說上次時間；過了 24 小時可以再提醒', async () => {
    realNow = new Date('2027-01-05T02:00:00Z')
    const s = await scenario()
    const v = await mustCreate(s)
    await mustVote(student(s.members[0]!), v.versionId)
    await mustVote(student(s.members[1]!), v.versionId)
    expect(await signoff.remind(student(s.members[0]!), { versionId: v.versionId }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    const r = await signoff.remind(admin(), { versionId: v.versionId }, randomUUID())
    expect(r).toMatchObject({ ok: true, receipt: { studentCount: 3, advisorIncluded: true } })
    expect(await recipientsOf('signoff.reminded', v.versionId)).toEqual([...s.members.slice(2).map((m) => m.id), s.teacher.id].sort())

    realNow = new Date('2027-01-06T01:59:00Z')
    const again = await signoff.remind(admin(), { versionId: v.versionId }, randomUUID())
    expect(again).toMatchObject({ ok: false, code: 'CONFLICT' })
    if (!again.ok) expect(again.message).toContain('已於 2027/01/05 10:00 提醒')
    const detail = await query.versionDetail(admin(), v.versionId)
    expect(detail.ok && detail.receipt.lastRemindedAt?.toISOString()).toBe('2027-01-05T02:00:00.000Z')

    realNow = new Date('2027-01-06T02:01:00Z')
    expect(await signoff.remind(admin(), { versionId: v.versionId }, randomUUID())).toMatchObject({ ok: true })
    expect(await count(`select count(*) as n from domain_events where type = 'signoff.reminded' and source_id = $1`, [v.versionId])).toBe(2)
    realNow = new Date('2027-01-05T02:00:00Z')
  })

  it('連按兩下（兩個請求編號同時送）：只送出一次；已完成的版本不能提醒', async () => {
    realNow = new Date('2027-02-01T02:00:00Z')
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s)
    const results = await Promise.all([0, 1].map(() => signoff.remind(admin(), { versionId: v.versionId }, randomUUID())))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(await count(`select count(*) as n from domain_events where type = 'signoff.reminded' and source_id = $1`, [v.versionId])).toBe(1)
    for (const m of s.members) await mustVote(student(m), v.versionId)
    await mustVote(teacherOf(s), v.versionId)
    expect(await signoff.remind(admin(), { versionId: v.versionId }, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
    realNow = new Date('2027-01-05T02:00:00Z')
  })
})

describe('匯出（S11-09、SGN-11）', () => {
  it('CSV：欄位齊全、每列帶版本與 checksum、登入方式、按鈕原文；理由以 = 開頭仍是文字；沒有 IP／瀏覽器欄；每次匯出存檔＋一筆紀錄', async () => {
    const s = await scenario({ size: 3 })
    const fileId = await submittedFile(s)
    const v = await mustCreate(s, { attachmentFileIds: [fileId] })
    await mustVote(student(s.members[0]!, 'google'), v.versionId)
    await mustVote(student(s.members[1]!), v.versionId, 'reject', '=HYPERLINK("http://evil","點我"),含逗號\n換行')
    expect(await signoff.exportVersion(student(s.members[0]!), { versionId: v.versionId, format: 'csv' })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await signoff.exportVersion(admin(), { versionId: v.versionId, format: 'pdf' as 'csv' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })

    const r = await signoff.exportVersion(admin(), { versionId: v.versionId, format: 'csv' })
    if (!r.ok) throw new Error(r.message)
    const csv = r.receipt.body
    expect(csv.startsWith('﻿')).toBe(true)
    const header = csv.slice(1).split('\r\n')[0]!
    for (const col of ['屆別', '組別', '簽核用途', '版本', '內容 checksum', '附件版本', '應簽參與者集合', '事件 ID', '當時姓名', '學號', '角色', '這次登入方式', '按鈕原文', '結果', '理由', '真實時間（臺灣）', '業務時間（臺灣）']) {
      expect(header).toContain(`"${col}"`)
    }
    expect(header).not.toMatch(/IP|瀏覽器|token/i)
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""點我""),含逗號\n換行"`)
    expect(csv).toContain('"Google"')
    expect(csv).toContain(`"${await checksumOf(v.versionId)}"`)
    expect(csv).toContain(`"${s.members[0]!.studentNo}"`)
    expect(csv).toContain('"建立版本"')

    const exported = (
      await owner.sql(
        `select e.format, e.exported_by_user_id, f.purpose, f.status, f.storage_key, f.checksum,
                (select count(*) from file_references r where r.file_id = f.id and r.ref_type = 'export' and r.ref_id = e.id) as refs
           from signoff_exports e join stored_files f on f.id = e.file_id where e.id = $1`,
        [r.receipt.exportId],
      )
    ).rows[0]!
    expect(exported).toMatchObject({ format: 'csv', exported_by_user_id: adminId, purpose: 'export', status: 'stored', refs: '1' })
    expect(await fs.readFile(path.join(root, String(exported.storage_key)), 'utf8')).toBe(csv)
    await signoff.exportVersion(admin(), { versionId: v.versionId, format: 'printable' })
    expect(await count('select count(*) as n from signoff_exports where version_id = $1', [v.versionId])).toBe(2)
    await expect(app.query(`update signoff_exports set format = 'csv' where version_id = $1`, [v.versionId])).rejects.toThrow()
  })

  it('可列印頁：全文、參與者、歷程、狀態與「行政採認待確認」；理由裡的 HTML 被逸出；已失效的版本也能匯出、狀態照實寫', async () => {
    const s = await scenario({ size: 3 })
    const v = await mustCreate(s, { content: '<p>同意書全文</p><script>alert(1)</script>' })
    await mustVote(student(s.members[0]!), v.versionId, 'reject', '<img src=x onerror=alert(1)>')
    await signoff.reopen(admin(), { versionId: v.versionId, reason: '重開' }, randomUUID())
    const r = await signoff.exportVersion(admin(), { versionId: v.versionId, format: 'printable' })
    if (!r.ok) throw new Error(r.message)
    const html = r.receipt.body
    expect(r.receipt.mime).toContain('text/html')
    expect(html).toContain('站內內容確認與同意紀錄，行政採認待確認')
    expect(html).toContain('<p>同意書全文</p>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('已失效（系辦重置）')
    expect(html).toContain('系辦重開新版')
    for (const m of s.members) expect(html).toContain(m.name)
  })
})

describe('附件下載：被簽核版本引用的檔案（#272 存疑點 5）', () => {
  it('快照裡的學生：送出後才加入、之後又被移出，仍下載得到自己簽過那一版的附件；不是參與者的被移出者、別組學生不行', async () => {
    const s = await scenario({ size: 4 })
    const other = await scenario({ size: 3 })
    const fileId = await submittedFile(s) // 送出當下只有 members[0..1]
    await mustCreate(s, { attachmentFileIds: [fileId] })
    const late = s.members[2]!
    expect((await storage.authorizeDownload(student(late), fileId)).ok).toBe(true)
    expect(await storage.authorizeDownload(student(other.members[0]!), fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    // 建版之後才加入、再被移出的人（不是這一版的參與者，也不在送出快照裡）。
    const newcomer = await newUser('過客', 'student', s.cohortId)
    await groups.addMember(admin(), { groupId: s.groupId, revision: await revisionOf(s.groupId), studentNo: newcomer.studentNo!, reason: '加入' }, randomUUID())
    await groups.removeMember(
      admin(),
      { groupId: s.groupId, revision: await revisionOf(s.groupId), userId: newcomer.id, successorLeaderUserId: null, reason: '退出' },
      randomUUID(),
    )
    await groups.removeMember(
      admin(),
      { groupId: s.groupId, revision: await revisionOf(s.groupId), userId: late.id, successorLeaderUserId: null, reason: '退選' },
      randomUUID(),
    )
    expect((await storage.authorizeDownload(student(late), fileId)).ok).toBe(true)
    expect(await storage.authorizeDownload(student(newcomer), fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('快照主指導：此刻仍是主指導才可以；改派後舊老師不行、新老師可以（新老師靠目前主指導那一條）', async () => {
    const s = await scenario({ size: 3 })
    const fileId = await submittedFile(s)
    await mustCreate(s, { attachmentFileIds: [fileId] })
    expect((await storage.authorizeDownload(teacherOf(s), fileId)).ok).toBe(true)
    const next = await newUser('接手老師', 'teacher')
    await advisors.assign(admin(), { groupId: s.groupId, revision: await revisionOf(s.groupId), teacherUserId: next.id, reason: '改派', gradingSelections: [] }, randomUUID())
    expect(await storage.authorizeDownload(teacherOf(s), fileId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect((await storage.authorizeDownload(actor(next.id, ['teacher']), fileId)).ok).toBe(true)
  })
})
