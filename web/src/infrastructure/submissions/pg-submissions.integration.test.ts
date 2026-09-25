import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { ItemInput } from '@/application/items'
import { PgItemCommand, PgItemQuery } from '@/infrastructure/items/pg-items'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgResponsePresence, responsePresenceReader } from '@/infrastructure/submissions/pg-response-presence'
import { categoryOf, completionOf, pendingCount, receiverStatus } from '@/application/submissions'
import { PgRosterQuery } from '@/infrastructure/submissions/pg-roster'
import { PgSubmissionCommand, PgSubmissionQuery } from '@/infrastructure/submissions/pg-submissions'

/**
 * 票 17：個人填報與送出（模組實作設計 05 §2、§3、§6、§10；產品模組 05 SUB-01、04、06、09、11、14、15、16、19 的個人部分）。
 *
 * 全部以正式執行角色 `fju_app` 連線（正式版本表不可變、草稿只能改內容欄，寫錯這裡會直接紅）。
 * 項目用票 15 的真用例建立與發布，名單就是發布時展開的那一份；業務鐘是可以撥的假鐘。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let teacherId: string
let businessNow = new Date('2026-10-01T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let items: PgItemCommand
let itemQuery: PgItemQuery
let submissions: PgSubmissionCommand
let query: PgSubmissionQuery

type Person = { id: string; name: string; cohortId: string }

function adminActor(): ResolvedActor {
  return { kind: 'authenticated', userId: adminId, roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

function studentActor(s: Person): ResolvedActor {
  return {
    kind: 'authenticated',
    userId: s.id,
    roles: ['student'],
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: [{ cohortId: s.cohortId, role: 'student' }],
  }
}

function teacherActor(): ResolvedActor {
  return { kind: 'authenticated', userId: teacherId, roles: ['teacher'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

let seq = 0
async function newCohort(status = 'active'): Promise<{ cohortId: string; stageId: string }> {
  seq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [`I17-${seq}`],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const stage = await owner.sql(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '成組期', '2026-09-15', 'system') returning id`,
    [cohortId],
  )
  if (status !== 'active') await owner.sql('update cohorts set status = $2 where id = $1', [cohortId, status])
  return { cohortId, stageId: String(stage.rows[0]!.id) }
}

async function newStudent(cohortId: string): Promise<Person> {
  seq += 1
  const studentNo = `41700${String(seq).padStart(4, '0')}`
  const name = `學生${seq}`
  const user = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `s${seq}-sub@example.com`],
  )
  const id = String(user.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)`,
    [id, name, studentNo, cohortId, `s${seq}@contact.example.com`],
  )
  await owner.sql('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, id])
  return { id, name, cohortId }
}

const FIELDS = [
  { key: 'topic', type: 'text', label: '想做的題目', required: true },
  { key: 'mail', type: 'email', label: '聯絡信箱', required: false },
  { key: 'kind', type: 'radio', label: '專題類型', required: true, options: ['一般專題', '產學合作'] },
]

function input(cohortId: string, stageId: string, patch: Partial<ItemInput> = {}): ItemInput {
  return {
    cohortId,
    placement: 'submission',
    title: '分組意向登記',
    summary: '',
    body: '請填想做的題目。',
    category: '',
    coverFileId: null,
    attachmentFileIds: [],
    audienceKind: 'cohort_students',
    groupIds: [],
    receiverUnit: 'individual',
    stageId,
    opensAt: '',
    dueAt: '2026-11-15T23:59',
    fields: FIELDS,
    ...patch,
  }
}

/** 建立並發布一份收件，回項目 id。 */
async function published(cohortId: string, stageId: string, patch: Partial<ItemInput> = {}): Promise<string> {
  const created = await items.create(adminActor(), input(cohortId, stageId, patch), randomUUID())
  if (!created.ok) throw new Error(`${created.code} ${created.message}`)
  const done = await items.publish(adminActor(), created.receipt.itemId, created.receipt.revision, { notify: false }, randomUUID())
  if (!done.ok) throw new Error(`${done.code} ${done.message}`)
  return created.receipt.itemId
}

/** 一屆＋一位學生＋一份已發布的個人收件。 */
async function scenario(patch: Partial<ItemInput> = {}) {
  const { cohortId, stageId } = await newCohort()
  const student = await newStudent(cohortId)
  const itemId = await published(cohortId, stageId, patch)
  return { cohortId, stageId, student, itemId }
}

async function mustSave(s: Person, itemId: string, revision: number, answers: unknown) {
  const saved = await submissions.saveDraft(studentActor(s), itemId, revision, answers, randomUUID())
  if (!saved.ok) throw new Error(`${saved.code} ${saved.message}`)
  return saved.receipt
}

async function versionCount(itemId: string): Promise<number> {
  return Number((await owner.sql('select count(*) as n from submission_versions where item_id = $1', [itemId])).rows[0]!.n)
}

const COMPLETE = { topic: '智慧校園導覽', mail: 'me@example.com', kind: '一般專題' }

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'submissions', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')

  const staff = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A1', 'a1-sub@example.com', true, now(), 'active'),
            (gen_random_uuid(), 'T1', 't1-sub@example.com', true, now(), 'active')
     returning id, name`,
  )
  adminId = String(staff.rows.find((r) => r.name === 'A1')!.id)
  teacherId = String(staff.rows.find((r) => r.name === 'T1')!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'admin', $1, now()), (gen_random_uuid(), $2, 'teacher', $1, now())`,
    [adminId, teacherId],
  )

  const storage = new FsFileStorage({
    root: () => '/tmp/fju-submissions-unused',
    environmentMaxBytes: () => 1024,
    ticketSecret: () => 'submissions-integration-secret-submissions',
    policies: {},
    db: () => app,
  })
  items = new PgItemCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    files: storage,
    responses: new PgResponsePresence(),
    businessClock,
    pool: () => app,
  })
  itemQuery = new PgItemQuery(() => app, responsePresenceReader(() => app))
  submissions = new PgSubmissionCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    businessClock,
    files: storage,
    events: new PgEventPublisher(),
    pool: () => app,
  })
  query = new PgSubmissionQuery(() => app)
})

afterEach(() => {
  businessNow = new Date('2026-10-01T02:00:00Z')
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('只看得到、只填得了自己在收件名單上的項目', () => {
  it('作業區只列本人目前名單上的個人收件；別屆、整組一份、草稿都不列', async () => {
    const { cohortId, stageId, student, itemId } = await scenario()
    const other = await newCohort()
    const outsider = await newStudent(other.cohortId)
    await published(other.cohortId, other.stageId, { title: '別屆的收件' })
    await published(cohortId, stageId, { title: '整組一份', receiverUnit: 'group' })
    await items.create(adminActor(), input(cohortId, stageId, { title: '還是草稿' }), randomUUID())

    const mine = await query.myItems(student.id)
    expect(mine.map((r) => r.title)).toEqual(['分組意向登記'])
    expect(mine[0]).toMatchObject({ itemId, hasDraft: false, latestVersionNo: null, exempt: false })
    expect((await query.myItems(outsider.id)).map((r) => r.title)).toEqual(['別屆的收件'])
    expect(await query.myItem(outsider.id, itemId)).toBeNull()
  })

  it('每一列帶屆別與階段序號（票 38 時間軸用身分比對階段）：兩段同名也分得開', async () => {
    const { cohortId, stageId, student } = await scenario()
    // 同一屆第 2 段，名稱跟第 1 段一樣（normalizeScheduleInput 允許同名）。
    const second = await owner.sql(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, 2, '成組期', '2026-11-01', 'system') returning id`,
      [cohortId],
    )
    await published(cohortId, String(second.rows[0]!.id), { title: '第二段的收件' })

    const mine = await query.myItems(student.id)
    const bySeq = Object.fromEntries(mine.map((r) => [r.title, [r.cohortId, r.stageSeq, r.stageName]]))
    expect(bySeq['分組意向登記']).toEqual([cohortId, 1, '成組期'])
    expect(bySeq['第二段的收件']).toEqual([cohortId, 2, '成組期'])
    expect(stageId).not.toBe(String(second.rows[0]!.id))
  })

  it('名單外的學生、老師、免填者都被拒絕，資料不變', async () => {
    const { student, itemId } = await scenario()
    const other = await newCohort()
    const outsider = await newStudent(other.cohortId)

    const denied = await submissions.saveDraft(studentActor(outsider), itemId, 0, COMPLETE, randomUUID())
    expect(denied).toMatchObject({ ok: false, code: 'NOT_IN_ROSTER' })
    expect(await submissions.saveDraft(teacherActor(), itemId, 0, COMPLETE, randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })

    await owner.sql(
      `update response_rosters set exempt = true, exempt_reason = '休學' where item_id = $1 and receiver_id = $2`,
      [itemId, student.id],
    )
    expect(await submissions.saveDraft(studentActor(student), itemId, 0, COMPLETE, randomUUID())).toMatchObject({
      ok: false,
      code: 'EXEMPTED',
    })
    expect(Number((await owner.sql('select count(*) as n from submission_drafts where item_id = $1', [itemId])).rows[0]!.n)).toBe(0)
  })

  it('屆別封存後不能再填', async () => {
    const { cohortId, student, itemId } = await scenario()
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])
    expect(await submissions.saveDraft(studentActor(student), itemId, 0, COMPLETE, randomUUID())).toMatchObject({
      ok: false,
      code: 'COHORT_ARCHIVED',
    })
  })
})

describe('尚未開放：看設定的開放時間，不看實際開放時間', () => {
  it('發布當下就記了實際開放時間，但設定的開放時間還沒到：存草稿與送出都被拒、不產生版本', async () => {
    // 10/01 發布，設定 11/01 08:00（臺灣）開放。
    const { student, itemId } = await scenario({ opensAt: '2026-11-01T08:00' })
    const head = (await owner.sql('select actual_opened_at from managed_items where id = $1', [itemId])).rows[0]!
    expect(head.actual_opened_at).not.toBeNull()

    const early = await submissions.saveDraft(studentActor(student), itemId, 0, COMPLETE, randomUUID())
    expect(early).toMatchObject({ ok: false, code: 'ITEM_NOT_OPEN' })
    expect(early.ok ? '' : early.message).toContain('2026/11/01 08:00')
    expect(await submissions.submit(studentActor(student), itemId, 1, randomUUID())).toMatchObject({ ok: false, code: 'ITEM_NOT_OPEN' })
    expect(await versionCount(itemId)).toBe(0)
    // 作業區照樣列出來（顯示「尚未開放」由畫面依開放時間判斷）。
    expect((await query.myItems(student.id))[0]).toMatchObject({ itemId, opensAt: new Date('2026-11-01T00:00:00Z') })

    businessNow = new Date('2026-11-01T00:00:00Z')
    await mustSave(student, itemId, 0, COMPLETE)
  })
})

describe('草稿：重新登入還在；兩邊同時改不無聲覆蓋', () => {
  it('存好的草稿之後再讀一次還在（不靠瀏覽器）', async () => {
    const { student, itemId } = await scenario()
    const saved = await mustSave(student, itemId, 0, { topic: '  第一版題目 ', kind: '產學合作' })
    expect(saved.revision).toBe(1)

    const detail = await query.myItem(student.id, itemId)
    expect(detail?.draft).toMatchObject({ revision: 1, answers: { topic: '第一版題目', kind: '產學合作' } })
    expect((await query.myItems(student.id))[0]).toMatchObject({ hasDraft: true })
  })

  it('兩個分頁讀同一版：後存的那一邊被要求重新載入，先存的內容不被蓋掉', async () => {
    const { student, itemId } = await scenario()
    await mustSave(student, itemId, 0, { topic: '共同起點' })

    await mustSave(student, itemId, 1, { topic: '分頁 B 的內容' })
    const stale = await submissions.saveDraft(studentActor(student), itemId, 1, { topic: '分頁 A 的舊內容' }, randomUUID())
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect((await query.myItem(student.id, itemId))?.draft).toMatchObject({ revision: 2, answers: { topic: '分頁 B 的內容' } })
  })

  it('兩邊同時第一次存：只有一邊成功，另一邊 CONFLICT', async () => {
    const { student, itemId } = await scenario()
    const [a, b] = await Promise.all([
      submissions.saveDraft(studentActor(student), itemId, 0, { topic: 'A' }, randomUUID()),
      submissions.saveDraft(studentActor(student), itemId, 0, { topic: 'B' }, randomUUID()),
    ])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect((a.ok ? b : a) as { code: string }).toMatchObject({ code: 'CONFLICT' })
    expect(Number((await owner.sql('select count(*) as n from submission_drafts where item_id = $1', [itemId])).rows[0]!.n)).toBe(1)
  })

  it('答案形狀不對直接拒絕（不存在的選項）', async () => {
    const { student, itemId } = await scenario()
    expect(await submissions.saveDraft(studentActor(student), itemId, 0, { kind: '學術研究' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      details: { field: 'kind' },
    })
  })
})

describe('正式送出', () => {
  it('送出前驗必填：缺欄位就拒絕、列出哪幾欄，不產生版本', async () => {
    const { student, itemId } = await scenario()
    await mustSave(student, itemId, 0, { mail: 'not-mail' })
    const result = await submissions.submit(studentActor(student), itemId, 1, randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { fields: ['topic', 'mail', 'kind'] } })
    expect(await versionCount(itemId)).toBe(0)
  })

  it('送出拿到回執：版本、收件時間（業務時間）、送出者、欄位版本；稽核不放回答內容', async () => {
    const { student, itemId } = await scenario()
    await mustSave(student, itemId, 0, COMPLETE)
    const requestId = randomUUID()
    const result = await submissions.submit(studentActor(student), itemId, 1, requestId)
    if (!result.ok) throw new Error(result.message)
    expect(result.receipt).toMatchObject({
      itemId,
      title: '分組意向登記',
      versionNo: 1,
      receivedBusinessAt: businessNow.toISOString(),
      submittedByName: student.name,
      schemaVersionNo: 1,
      requestId,
    })
    const row = (await owner.sql('select * from submission_versions where item_id = $1', [itemId])).rows[0]!
    expect(row).toMatchObject({ receiver_kind: 'user', receiver_id: student.id, version_no: 1, request_id: requestId, answers: COMPLETE })
    const audit = (await owner.sql(`select payload from audit_events where action = 'submission.submit' and target_id = $1`, [itemId])).rows
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit[0]!.payload)).not.toContain('智慧校園')
  })

  it('連點只算一次：同一個請求編號送兩次（含同時）只有一個版本、回執一樣', async () => {
    const { student, itemId } = await scenario()
    await mustSave(student, itemId, 0, COMPLETE)
    const requestId = randomUUID()
    const [first, second] = await Promise.all([
      submissions.submit(studentActor(student), itemId, 1, requestId),
      submissions.submit(studentActor(student), itemId, 1, requestId),
    ])
    const third = await submissions.submit(studentActor(student), itemId, 1, requestId)
    expect(first.ok && second.ok && third.ok).toBe(true)
    expect(first).toEqual(second)
    expect(third).toEqual(first)
    expect(await versionCount(itemId)).toBe(1)

    // 同一個編號拿去送別的東西：拒絕。
    expect(await submissions.submit(studentActor(student), itemId, 2, requestId)).toMatchObject({ ok: false, code: 'REQUEST_MISMATCH' })
  })

  it('斷線後回來重送同一個編號：就算已經過了截止，也拿回原本那張回執', async () => {
    const { student, itemId } = await scenario()
    await mustSave(student, itemId, 0, COMPLETE)
    businessNow = new Date('2026-11-15T15:59:30Z')
    const requestId = randomUUID()
    const first = await submissions.submit(studentActor(student), itemId, 1, requestId)
    expect(first.ok).toBe(true)

    businessNow = new Date('2026-11-15T16:05:00Z')
    expect(await submissions.submit(studentActor(student), itemId, 1, requestId)).toEqual(first)
    expect(await versionCount(itemId)).toBe(1)
  })

  it('截止前可重送：第 2 次成最新，第 1 次一個位元都不變；本人看得到每一次', async () => {
    const { student, itemId } = await scenario()
    await mustSave(student, itemId, 0, COMPLETE)
    const v1 = await submissions.submit(studentActor(student), itemId, 1, randomUUID())
    expect(v1).toMatchObject({ ok: true, receipt: { versionNo: 1 } })
    const before = (await owner.sql('select * from submission_versions where item_id = $1 and version_no = 1', [itemId])).rows[0]

    await mustSave(student, itemId, 1, { ...COMPLETE, topic: '改過的題目' })
    const v2 = await submissions.submit(studentActor(student), itemId, 2, randomUUID())
    expect(v2).toMatchObject({ ok: true, receipt: { versionNo: 2 } })
    const after = (await owner.sql('select * from submission_versions where item_id = $1 and version_no = 1', [itemId])).rows[0]
    expect(after).toEqual(before)

    const detail = await query.myItem(student.id, itemId)
    expect(detail?.versions.map((v) => v.versionNo)).toEqual([2, 1])
    expect(await query.myVersion(student.id, itemId, 1)).toMatchObject({ isLatest: false, answers: COMPLETE })
    expect(await query.myVersion(student.id, itemId, 2)).toMatchObject({ isLatest: true, answers: { topic: '改過的題目' } })
    expect((await query.myItems(student.id))[0]).toMatchObject({ latestVersionNo: 2 })

    // 別人看不到我的版本。
    const peer = await newStudent(student.cohortId)
    expect(await query.myVersion(peer.id, itemId, 1)).toBeNull()
  })

  it('舊頁面：草稿已在別處更新過，拿舊版本號送出被要求重新載入', async () => {
    const { student, itemId } = await scenario()
    await mustSave(student, itemId, 0, COMPLETE)
    await mustSave(student, itemId, 1, { ...COMPLETE, topic: '另一台裝置改的' })
    expect(await submissions.submit(studentActor(student), itemId, 1, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await versionCount(itemId)).toBe(0)
  })
})

describe('截止判定（業務時鐘，截止分鐘內都算準時）', () => {
  it('23:59:59 送得出去；00:00:00 被拒絕、草稿保留、不新增版本，也不能再存草稿', async () => {
    const { student, itemId } = await scenario({ dueAt: '2026-11-15T23:59' })
    await mustSave(student, itemId, 0, COMPLETE)

    businessNow = new Date('2026-11-15T15:59:59.999Z') // 臺灣 23:59:59
    expect(await submissions.submit(studentActor(student), itemId, 1, randomUUID())).toMatchObject({
      ok: true,
      receipt: { versionNo: 1, receivedBusinessAt: '2026-11-15T15:59:59.999Z' },
    })

    businessNow = new Date('2026-11-15T16:00:00Z') // 臺灣 11/16 00:00:00
    const late = await submissions.submit(studentActor(student), itemId, 1, randomUUID())
    expect(late).toMatchObject({ ok: false, code: 'DEADLINE_PASSED' })
    expect(late.ok ? '' : late.message).toContain('2026/11/15 23:59')
    expect(await submissions.saveDraft(studentActor(student), itemId, 1, COMPLETE, randomUUID())).toMatchObject({
      ok: false,
      code: 'DEADLINE_PASSED',
    })
    expect(await versionCount(itemId)).toBe(1)
    expect((await query.myItem(student.id, itemId))?.draft).toMatchObject({ revision: 1, answers: COMPLETE })
  })
})

describe('有人作答後，票 15 的收件單位鎖定真的生效', () => {
  it('沒人作答時可以切單位；有人存了草稿之後，切單位、改對象、改欄位都被拒，改標題與截止仍可', async () => {
    const { cohortId, stageId, student, itemId } = await scenario()
    const other = await newCohort()
    const other2 = await published(other.cohortId, other.stageId)
    void cohortId

    // 沒有任何回答：畫面不鎖。
    expect((await itemQuery.get(itemId))?.hasResponses).toBe(false)

    await mustSave(student, itemId, 0, { topic: '只存了草稿' })
    expect((await itemQuery.get(itemId))?.hasResponses).toBe(true)
    expect((await itemQuery.get(other2))?.hasResponses).toBe(false)

    const update = async (patch: Partial<ItemInput>) => {
      const head = await itemQuery.get(itemId)
      return items.updatePublished(adminActor(), itemId, head!.revision, input(head!.cohortId, stageId, patch), { notify: false }, randomUUID())
    }
    expect(await update({ receiverUnit: 'group' })).toMatchObject({ ok: false, code: 'ITEM_HAS_RESPONSES' })
    expect(await update({ fields: [...FIELDS, { key: 'extra', type: 'text', label: '多一欄', required: false }] })).toMatchObject({
      ok: false,
      code: 'ITEM_HAS_RESPONSES',
    })
    expect(await update({ title: '分組意向登記（更正）', dueAt: '2026-11-20T23:59' })).toMatchObject({ ok: true })
    expect((await query.myItem(student.id, itemId))?.title).toBe('分組意向登記（更正）')
  })

  it('完全空白的草稿不算作答（票 18）：打開就按存草稿不會把收件單位鎖住；填了一欄才鎖', async () => {
    const { stageId, student, itemId } = await scenario()
    // 畫面全空時按「正式送出」：先存一份空草稿，再被必填擋下。
    const blank = await mustSave(student, itemId, 0, { topic: '   ', kind: '' })
    expect(await submissions.submit(studentActor(student), itemId, blank.revision, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    expect((await owner.sql('select answers from submission_drafts where item_id = $1', [itemId])).rows[0]!.answers).toEqual({})
    expect((await itemQuery.get(itemId))?.hasResponses).toBe(false)

    const head = await itemQuery.get(itemId)
    const switched = await items.updatePublished(
      adminActor(),
      itemId,
      head!.revision,
      input(head!.cohortId, stageId, { fields: [...FIELDS, { key: 'extra', type: 'text', label: '多一欄', required: false }] }),
      { notify: false },
      randomUUID(),
    )
    expect(switched).toMatchObject({ ok: true })

    // 空白草稿之後照新欄位存得進去；有內容之後就鎖。
    await mustSave(student, itemId, blank.revision, { extra: '新欄位' })
    expect((await itemQuery.get(itemId))?.hasResponses).toBe(true)
  })

  it('學生第一次存草稿與管理員切單位同時發生：兩邊不會都成功', async () => {
    const { stageId, student, itemId } = await scenario()
    const head = await itemQuery.get(itemId)
    const [saved, switched] = await Promise.all([
      submissions.saveDraft(studentActor(student), itemId, 0, { topic: '同時' }, randomUUID()),
      items.updatePublished(
        adminActor(),
        itemId,
        head!.revision,
        input(head!.cohortId, stageId, { receiverUnit: 'group' }),
        { notify: false },
        randomUUID(),
      ),
    ])
    expect(saved.ok && switched.ok).toBe(false)
    if (saved.ok) expect(switched).toMatchObject({ code: 'ITEM_HAS_RESPONSES' })
    // 管理員先切成整組一份：這位學生沒有組別 → NOT_MEMBER（票 21 起組別收件先看組員身分）；
    // 切換還沒看到就讀到舊名單列的情形 → NOT_IN_ROSTER。兩種都是「沒存進去」。
    else expect(['NOT_MEMBER', 'NOT_IN_ROSTER']).toContain(saved.code)
  })
})

describe('收件名單頁（票 18）：三類分開、完成率、點人看版本', () => {
  /** 一屆五位學生＋一份已發布的個人收件，做出每一種情況。 */
  async function rosterScenario() {
    const { cohortId, stageId } = await newCohort()
    const done = await newStudent(cohortId)
    const drafting = await newStudent(cohortId)
    const exempted = await newStudent(cohortId)
    const removed = await newStudent(cohortId)
    const readded = await newStudent(cohortId)
    const itemId = await published(cohortId, stageId)

    // 交了兩次（重送）。
    const first = await mustSave(done, itemId, 0, COMPLETE)
    expect((await submissions.submit(studentActor(done), itemId, first.revision, randomUUID())).ok).toBe(true)
    const second = await mustSave(done, itemId, first.revision, { ...COMPLETE, topic: '改過的題目' })
    expect((await submissions.submit(studentActor(done), itemId, second.revision, randomUUID())).ok).toBe(true)
    // 只存了草稿。
    await mustSave(drafting, itemId, 0, { topic: '還在想' })
    // 交過之後被移出、交過之後移出又加回。
    for (const s of [removed, readded]) {
      const saved = await mustSave(s, itemId, 0, COMPLETE)
      expect((await submissions.submit(studentActor(s), itemId, saved.revision, randomUUID())).ok).toBe(true)
    }
    // 免填與移出由之後的票做成操作；這裡用 owner 連線直接寫成那個樣子。
    await owner.sql(`update response_rosters set exempt = true, exempt_reason = '休學' where item_id = $1 and receiver_id = $2`, [
      itemId,
      exempted.id,
    ])
    await owner.sql(
      `update response_rosters set eligible_to_business_at = eligible_from_business_at + interval '1 day', removed_reason = '轉系'
        where item_id = $1 and receiver_id = any($2::uuid[])`,
      [itemId, [removed.id, readded.id]],
    )
    await owner.sql(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, 'user', $3, $5::timestamptz + interval '2 days', 'admin', 'user', $4)`,
      [itemId, cohortId, readded.id, adminId, businessNow],
    )
    return { cohortId, itemId, done, drafting, exempted, removed, readded }
  }

  it('每位收件者只出現一次：目前名單、免填、已移出分開；分子只算目前名單裡交過的', async () => {
    const { itemId, done, drafting, exempted, removed, readded } = await rosterScenario()
    const roster = new PgRosterQuery(() => app)
    const result = await roster.roster(adminActor(), itemId)
    expect(result?.item).toMatchObject({ itemId, title: '分組意向登記', receiverUnit: 'individual', schemaVersionNo: 1 })
    const entries = result!.entries
    expect(entries).toHaveLength(5)
    const byId = new Map(entries.map((e) => [e.receiverId, e]))
    expect(entries.map((e) => categoryOf(e)).sort()).toEqual(['current', 'current', 'current', 'exempt', 'removed'])
    expect(byId.get(done.id)).toMatchObject({ latestVersionNo: 2, latestSubmittedByName: done.name, eligibleTo: null, source: 'auto' })
    expect(byId.get(done.id)?.studentNo).toMatch(/^41700/)
    expect(byId.get(drafting.id)).toMatchObject({ hasDraft: true, latestVersionNo: null })
    expect(byId.get(exempted.id)).toMatchObject({ exempt: true, exemptReason: '休學' })
    expect(byId.get(removed.id)).toMatchObject({ removedReason: '轉系', latestVersionNo: 1 })
    expect(byId.get(removed.id)?.eligibleTo).toBeInstanceOf(Date)
    // 加回的那一位：取目前那一列（管理員加入），回答仍算。
    expect(byId.get(readded.id)).toMatchObject({ eligibleTo: null, source: 'admin', latestVersionNo: 1 })

    // 分母＝done、drafting、readded；分子＝done、readded。
    expect(completionOf(result!.item, entries, businessNow)).toMatchObject({
      required: 3,
      done: 2,
      pending: 1,
      exempt: 1,
      removed: 1,
      percent: 67,
    })
  })

  it('學生作業區（首頁待繳數的來源）與名單頁對同一個人算出同一個狀態', async () => {
    const { itemId, done, drafting } = await rosterScenario()
    const entries = (await new PgRosterQuery(() => app).roster(adminActor(), itemId))!.entries
    for (const s of [done, drafting]) {
      const mine = (await query.myItems(s.id)).find((r) => r.itemId === itemId)!
      const entry = entries.find((e) => e.receiverId === s.id)!
      expect(receiverStatus(mine, mine, businessNow)).toEqual(receiverStatus(mine, entry, businessNow))
      expect(pendingCount([mine], businessNow)).toBe(s === drafting ? 1 : 0)
    }
  })

  it('點一個人：名單歷史、每一次正式送出與內容；已移出的人回答保留、仍查得到', async () => {
    const { itemId, done, removed, readded } = await rosterScenario()
    const roster = new PgRosterQuery(() => app)

    const detail = await roster.receiver(adminActor(), itemId, done.id)
    expect(detail?.versions.map((v) => v.versionNo)).toEqual([2, 1])
    expect(detail?.draftUpdatedAt).toBeInstanceOf(Date)
    expect(await roster.receiverVersion(adminActor(), itemId, done.id, 1)).toMatchObject({
      versionNo: 1,
      isLatest: false,
      answers: COMPLETE,
    })
    expect((await roster.receiverVersion(adminActor(), itemId, done.id, 2))?.answers).toMatchObject({ topic: '改過的題目' })

    const gone = await roster.receiver(adminActor(), itemId, removed.id)
    expect(gone?.entry).toMatchObject({ removedReason: '轉系' })
    expect(gone?.versions).toHaveLength(1)
    expect((await roster.receiverVersion(adminActor(), itemId, removed.id, 1))?.answers).toEqual(COMPLETE)

    const back = await roster.receiver(adminActor(), itemId, readded.id)
    expect(back?.spans.map((s) => [s.source, s.removedReason])).toEqual([
      ['admin', null],
      ['auto', '轉系'],
    ])
  })

  it('整組一份的收件也列得出名單（組別代號），還沒有任何組別版本', async () => {
    const { cohortId, stageId } = await newCohort()
    await owner.sql(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system')`,
      [cohortId],
    )
    const itemId = await published(cohortId, stageId, { receiverUnit: 'group', title: '整組一份的報告' })
    const result = await new PgRosterQuery(() => app).roster(adminActor(), itemId)
    expect(result?.item.receiverUnit).toBe('group')
    expect(result?.entries).toEqual([
      expect.objectContaining({ receiverKind: 'group', name: 'G01', groupCode: 'G01', studentNo: null, latestVersionNo: null }),
    ])
    expect(completionOf(result!.item, result!.entries, businessNow)).toMatchObject({ required: 1, done: 0 })
  })

  it('只有管理員拿得到：老師、學生（連本人）都是 null；不在名單上的人、別的項目也是 null', async () => {
    const { itemId, done } = await rosterScenario()
    const other = await scenario()
    const roster = new PgRosterQuery(() => app)
    const anonymous: ResolvedActor = { kind: 'anonymous' }
    for (const actor of [teacherActor(), studentActor(done), anonymous]) {
      expect(await roster.roster(actor, itemId)).toBeNull()
      expect(await roster.receiver(actor, itemId, done.id)).toBeNull()
      expect(await roster.receiverVersion(actor, itemId, done.id, 1)).toBeNull()
    }
    expect(await roster.receiver(adminActor(), itemId, other.student.id)).toBeNull()
    expect(await roster.receiverVersion(adminActor(), other.itemId, done.id, 1)).toBeNull()
    expect(await roster.roster(adminActor(), 'not-a-uuid')).toBeNull()
  })
})
