import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { ItemInput } from '@/application/items'
import type { Mailer, MailMessage, MailSendResult } from '@/application/mail'
import { describeGradingReminder, describeItemReminder, describeOverdueReminder } from '@/application/reminders'
import { PgItemCommand } from '@/infrastructure/items/pg-items'
import { CaptureMailer } from '@/infrastructure/mail/capture-mailer'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgInbox, resolveSource } from '@/infrastructure/notifications/pg-inbox'
import { PgNotificationProjector } from '@/infrastructure/notifications/pg-projector'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgReminders } from '@/infrastructure/reminders/pg-reminders'
import { PgSignoffCommand } from '@/infrastructure/signoff/pg-signoff'
import { PgResponsePresence } from '@/infrastructure/submissions/pg-response-presence'

/**
 * C1-05：催繳後端（C 階段規格① §1.5、§3.5、§8；AC-12、AC-34 後端）。全部以正式執行角色 `fju_app` 連線。
 *
 * - AC-12：一份已截止、3 人未交的作業 → 站內通知 3 則「{標題} 尚未繳交，截止 {時間}」、`mail_outbox` 3 封 `reminder`、
 *   稽核 `item.remind` 一筆；再按一次 → CONFLICT 帶 `nextAllowedAt`（明天同一時間）；滿 24 小時可再催。
 * - 收件人：整組展開組員、免填與移出不催、停用帳號不催；站內同意書看簽核包（還沒表態的人、等老師時＝主指導、沒建包的組排除）。
 * - AC-34：逾期卡一次催全部逾期作業（1 小時前催過的那份略過並回報）；評分卡只催未送齊的老師、每人「您還有 N 份評分未送出」，
 *   老師的通知匣看得到標題、連到評分清單。
 * - 寄信在 commit 之後、失敗不回滾；一封卡住有逾時，不讓整個請求卡住。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let adminId: string
let items: PgItemCommand
let signoff: PgSignoffCommand
let reminders: PgReminders
let businessNow = new Date('2026-11-20T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }
let realNow = new Date('2026-11-20T02:00:00Z')
const realClock = { now: () => new Date(realNow.getTime()) }
const SITE = 'http://127.0.0.1:3000'

type Role = 'admin' | 'teacher' | 'student'
function actor(userId: string, roles: Role[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [], loginMethod: 'password' }
}
const admin = () => actor(adminId, ['admin'])

let seq = 0
async function newUser(name: string, role: Role, cohortId?: string): Promise<{ id: string; email: string }> {
  seq += 1
  const email = `rm${seq}-${randomUUID().slice(0, 8)}@example.com`
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, email],
  )
  const id = String(row.rows[0]!.id)
  await owner.sql(`insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`, [
    id,
    role,
  ])
  if (role === 'student' && cohortId) {
    const studentNo = `4130${String(seq).padStart(5, '0')}`
    await owner.sql(
      `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email) values ($1, $2, $2, $3, $4, $5)`,
      [id, name, studentNo, cohortId, `c-${email}`],
    )
    await owner.sql('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, id])
  }
  return { id, email }
}
type Person = Awaited<ReturnType<typeof newUser>>

async function newCohort(): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind) values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [`RM-${seq}`],
  )
  return String(row.rows[0]!.id)
}

async function newGroup(cohortId: string, members: Person[], advisor?: Person): Promise<{ id: string; code: string }> {
  seq += 1
  const code = `G${seq}`
  const row = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortId, code],
  )
  const id = String(row.rows[0]!.id)
  for (const m of members) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now() - interval '1 day', 'system')`,
      [id, cohortId, m.id],
    )
  }
  await owner.sql(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now() - interval '1 day', $2)`,
    [id, members[0]!.id],
  )
  if (advisor) {
    await owner.sql(
      `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
       values (gen_random_uuid(), $1, $2, 'admin', now() - interval '1 day', $3, '指派')`,
      [id, advisor.id, adminId],
    )
  }
  return { id, code }
}

function itemInput(cohortId: string, patch: Partial<ItemInput> = {}): ItemInput {
  return {
    cohortId,
    placement: 'submission',
    title: '期中報告',
    summary: '',
    body: '請繳交期中報告。',
    category: '',
    coverFileId: null,
    attachmentFileIds: [],
    audienceKind: 'cohort_students',
    groupIds: [],
    receiverUnit: 'individual',
    stageId: null,
    opensAt: '',
    dueAt: '2026-11-15T23:59',
    fields: [{ key: 'topic', type: 'text', label: '題目', required: true }],
    ...patch,
  } as ItemInput
}

/** 用正式用例建立並發布（名單就是發布時展開的那一份）。發布時把業務鐘撥回截止前，發完再撥回來。 */
async function published(cohortId: string, patch: Partial<ItemInput> = {}): Promise<string> {
  const keep = businessNow
  businessNow = new Date('2026-11-01T02:00:00Z')
  try {
    const created = await items.create(admin(), itemInput(cohortId, patch), randomUUID())
    if (!created.ok) throw new Error(`${created.code} ${created.message}`)
    const done = await items.publish(admin(), created.receipt.itemId, created.receipt.revision, { notify: false }, randomUUID())
    if (!done.ok) throw new Error(`${done.code} ${done.message}`)
    return created.receipt.itemId
  } finally {
    businessNow = keep
  }
}

/** 這位收件者（人或組）正式送出過第 1 版。 */
async function submitted(itemId: string, kind: 'user' | 'group', receiverId: string, by: string) {
  const schema = await owner.sql('select current_schema_version_id as id from managed_items where id = $1', [itemId])
  await owner.sql(
    `insert into submission_versions
       (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
        received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
     values (gen_random_uuid(), $1, $2, $3, 1, $4, '{"topic":"x"}'::jsonb, $5, now(), '2026-11-10T02:00:00Z', gen_random_uuid(),
             case when $2 = 'group' then '[]'::jsonb end, 1)`,
    [itemId, kind, receiverId, String(schema.rows[0]!.id), by],
  )
}

async function rows(sql: string, values: unknown[] = []) {
  return (await owner.sql(sql, values)).rows
}

async function remindedEvents(sourceId: string, type = 'item.reminded') {
  return rows(`select recipients, payload, source_type from domain_events where type = $1 and source_id = $2 order by occurred_real_at`, [type, sourceId])
}

async function outbox(emails: readonly string[]) {
  return rows(`select to_email, template, status, subject, body_text from mail_outbox where to_email = any($1) order by to_email`, [emails])
}

const projector = () => new PgNotificationProjector({ pool: () => app, events: new PgEventPublisher(), businessClock, log: () => undefined })
const inbox = () => new PgInbox({ db: () => app })

function must<R>(r: { ok: true; receipt: R } | { ok: false; code: string; message: string }): R {
  if (!r.ok) throw new Error(`${r.code} ${r.message}`)
  return r.receipt
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'reminders', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-reminders-'))
  adminId = (await newUser('系辦', 'admin')).id
  const storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 10 * 1024 * 1024,
    ticketSecret: () => 'reminders-secret-reminders-secret-0000',
    policies: {},
    db: () => app,
  })
  const common = { audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), businessClock, pool: () => app }
  items = new PgItemCommand({
    ...common,
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    files: storage,
    responses: new PgResponsePresence(),
  })
  signoff = new PgSignoffCommand({ ...common, events: new PgEventPublisher(), files: storage, realClock })
  reminders = new PgReminders({
    ...common,
    events: new PgEventPublisher(),
    reader: () => app,
    realClock,
    mail: { mailer: new CaptureMailer({ db: () => app }), siteUrl: `${SITE}/` },
  })
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('AC-12：催一份已截止、3 人未交的作業', () => {
  it('第一次：通知 3 人、outbox 3 封 reminder、稽核 item.remind 一筆；第二次 CONFLICT 帶 nextAllowedAt；滿 24 小時可再催', async () => {
    realNow = new Date('2026-11-20T02:00:00Z')
    const cohortId = await newCohort()
    const students = [await newUser('甲', 'student', cohortId), await newUser('乙', 'student', cohortId), await newUser('丙', 'student', cohortId), await newUser('丁', 'student', cohortId)]
    const itemId = await published(cohortId)
    await submitted(itemId, 'user', students[0]!.id, students[0]!.id)
    const late = students.slice(1)

    const first = must(await reminders.remindItem(admin(), { itemId }, randomUUID()))
    expect(first).toMatchObject({ itemId, title: '期中報告', notified: 3, mailed: 3, remindedAt: '2026-11-20T02:00:00.000Z' })
    expect(first.nextAllowedAt).toEqual(new Date('2026-11-21T02:00:00Z'))
    expect(describeItemReminder(first)).toBe('已通知 3 人')

    const events = await remindedEvents(itemId)
    expect(events).toHaveLength(1)
    expect(events[0]!.source_type).toBe('item')
    expect([...(events[0]!.recipients as string[])].sort()).toEqual(late.map((s) => s.id).sort())
    expect((events[0]!.payload as { title: string }).title).toBe('期中報告 尚未繳交，截止 2026/11/15 23:59')

    const mails = await outbox(students.map((s) => s.email))
    expect(mails.map((m) => [m.to_email, m.template, m.status])).toEqual(
      late.map((s) => [s.email, 'reminder', 'captured']).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    )
    expect(mails[0]!.body_text).toBe(`期中報告 尚未繳交，截止 2026/11/15 23:59。請到 ${SITE}/dashboard/student/affairs/${itemId} 查看並完成。`)
    expect(await rows(`select actor_user_id, target_id from audit_events where action = 'item.remind' and target_id = $1`, [itemId])).toEqual([
      { actor_user_id: adminId, target_id: itemId },
    ])

    // 站內通知：3 位未交的學生各一則（截止類），已交的沒有；點進去是作業區那一份。
    await projector().runOnce()
    for (const s of late) {
      const page = await inbox().list(actor(s.id, ['student']), { kind: 'all' }, null)
      const mine = page.items.filter((n) => n.title === '期中報告 尚未繳交，截止 2026/11/15 23:59')
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({ kind: 'due', source: { state: 'ok', href: `/dashboard/student/affairs/${itemId}` } })
    }
    expect((await inbox().list(actor(students[0]!.id, ['student']), { kind: 'all' }, null)).items.filter((n) => n.kind === 'due')).toEqual([])

    // 第二次（一分鐘後）：冷卻中，CONFLICT 帶下一次可催的時間；不寫事件、不寄信。
    realNow = new Date('2026-11-20T02:01:00Z')
    const again = await reminders.remindItem(admin(), { itemId }, randomUUID())
    expect(again).toMatchObject({
      ok: false,
      code: 'CONFLICT',
      message: '「期中報告」上次催繳在 2026/11/20 10:00，24 小時內不能再催（2026/11/21 10:00 之後可以）。',
      details: { lastRemindedAt: '2026-11-20T02:00:00.000Z', nextAllowedAt: '2026-11-21T02:00:00.000Z' },
    })
    expect(await remindedEvents(itemId)).toHaveLength(1)
    expect(await outbox(students.map((s) => s.email))).toHaveLength(3)

    const last = must(await reminders.lastReminded(admin(), 'item', itemId))
    expect(last).toMatchObject({ at: new Date('2026-11-20T02:00:00Z'), nextAllowedAt: new Date('2026-11-21T02:00:00Z') })

    // 滿 24 小時：可以再催。
    realNow = new Date('2026-11-21T02:00:00Z')
    expect(must(await reminders.remindItem(admin(), { itemId }, randomUUID())).notified).toBe(3)
    expect(await remindedEvents(itemId)).toHaveLength(2)
    expect(must(await reminders.lastReminded(admin(), 'item', itemId)).nextAllowedAt).toEqual(new Date('2026-11-22T02:00:00Z'))
  })

  it('同一個請求編號再送：回第一次的回執（nextAllowedAt 仍是 Date），不再發事件；連按兩下（兩個請求同時到）只送出一次', async () => {
    realNow = new Date('2026-11-20T03:00:00Z')
    const cohortId = await newCohort()
    await newUser('戊', 'student', cohortId)
    const itemId = await published(cohortId)
    const requestId = randomUUID()
    const first = must(await reminders.remindItem(admin(), { itemId }, requestId))
    const replay = must(await reminders.remindItem(admin(), { itemId }, requestId))
    expect(replay).toMatchObject({ itemId, notified: 1 })
    expect(replay.nextAllowedAt).toBeInstanceOf(Date)
    expect(replay.nextAllowedAt).toEqual(first.nextAllowedAt)
    expect(await remindedEvents(itemId)).toHaveLength(1)

    const other = await published(cohortId, { title: '期末報告' })
    const both = await Promise.all([
      reminders.remindItem(admin(), { itemId: other }, randomUUID()),
      reminders.remindItem(admin(), { itemId: other }, randomUUID()),
    ])
    expect(both.filter((r) => r.ok)).toHaveLength(1)
    expect(both.filter((r) => !r.ok && r.code === 'CONFLICT')).toHaveLength(1)
    expect(await remindedEvents(other)).toHaveLength(1)
  })

  it('權限與驗證：非管理員 FORBIDDEN；草稿與公告 VALIDATION_FAILED；全員已交 CONFLICT', async () => {
    const cohortId = await newCohort()
    const s = await newUser('己', 'student', cohortId)
    const itemId = await published(cohortId)
    expect(await reminders.remindItem(actor(s.id, ['student']), { itemId }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const draft = must(await items.create(admin(), itemInput(cohortId, { title: '草稿' }), randomUUID()))
    expect(await reminders.remindItem(admin(), { itemId: draft.itemId }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await reminders.remindItem(admin(), { itemId: randomUUID() }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    await submitted(itemId, 'user', s.id, s.id)
    expect(await reminders.remindItem(admin(), { itemId }, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await remindedEvents(itemId)).toHaveLength(0)
  })
})

describe('收件人', () => {
  it('整組收件：未交的組展開成有效組員；已交、免填的組不催；停用帳號不催；老師不收', async () => {
    realNow = new Date('2026-11-20T04:00:00Z')
    const cohortId = await newCohort()
    const teacher = await newUser('指導老師', 'teacher')
    const a = [await newUser('A1', 'student', cohortId), await newUser('A2', 'student', cohortId)]
    const b = [await newUser('B1', 'student', cohortId)]
    const c = [await newUser('C1', 'student', cohortId), await newUser('C2', 'student', cohortId)]
    const d = [await newUser('D1', 'student', cohortId)]
    const ga = await newGroup(cohortId, a, teacher)
    const gb = await newGroup(cohortId, b)
    await newGroup(cohortId, c)
    const gd = await newGroup(cohortId, d)
    const itemId = await published(cohortId, { receiverUnit: 'group' })
    await submitted(itemId, 'group', gb.id, b[0]!.id)
    await owner.sql(`update response_rosters set exempt = true where item_id = $1 and receiver_id = $2`, [itemId, gd.id])
    await owner.sql(`update users set status = 'disabled' where id = $1`, [c[1]!.id])

    const r = must(await reminders.remindItem(admin(), { itemId }, randomUUID()))
    expect(r.notified).toBe(3)
    const [event] = await remindedEvents(itemId)
    expect([...(event!.recipients as string[])].sort()).toEqual([a[0]!.id, a[1]!.id, c[0]!.id].sort())
    expect(ga.id).toBeTruthy()
  })

  it('站內同意書：還沒表態的人（收集中只催學生）、等老師時只催主指導；沒建包的組整組排除；完成的組不催', async () => {
    realNow = new Date('2026-11-20T05:00:00Z')
    const cohortId = await newCohort()
    const t1 = await newUser('甲老師', 'teacher')
    const t2 = await newUser('乙老師', 'teacher')
    const g1m = [await newUser('一號', 'student', cohortId), await newUser('二號', 'student', cohortId)]
    const g2m = [await newUser('三號', 'student', cohortId)]
    const g3m = [await newUser('四號', 'student', cohortId)]
    const g1 = await newGroup(cohortId, g1m, t1)
    const g2 = await newGroup(cohortId, g2m, t2)
    await newGroup(cohortId, g3m) // 沒有主指導 → 沒建包
    const itemId = await published(cohortId, { receiverUnit: 'group', title: '期中結果確認' })
    await owner.sql(`update managed_items set consent_mode = 'form', consent_purpose = 'result_confirmation' where id = $1`, [itemId])
    // 包由 C1-03 的 hook 在發布時建；這裡用既有建版用例建好再接上作業。
    const v1 = must(await signoff.createVersion(admin(), { groupId: g1.id, purpose: 'result_confirmation', content: '確認期中結果。', attachmentFileIds: [], showcaseEntryId: null }, randomUUID()))
    const v2 = must(await signoff.createVersion(admin(), { groupId: g2.id, purpose: 'result_confirmation', content: '確認期中結果。', attachmentFileIds: [], showcaseEntryId: null }, randomUUID()))
    await owner.sql(`update signoff_packages set item_id = $1 where group_id = any($2::uuid[])`, [itemId, [g1.id, g2.id]])
    const checksum = String((await rows('select content_checksum from signoff_package_versions where id = $1', [v1.versionId]))[0]!.content_checksum)
    must(await signoff.respond(actor(g1m[0]!.id, ['student']), { versionId: v1.versionId, contentChecksum: checksum, decision: 'agree', reason: null }, randomUUID()))
    // 第二組唯一的學生同意 → 等老師。
    const checksum2 = String((await rows('select content_checksum from signoff_package_versions where id = $1', [v2.versionId]))[0]!.content_checksum)
    must(await signoff.respond(actor(g2m[0]!.id, ['student']), { versionId: v2.versionId, contentChecksum: checksum2, decision: 'agree', reason: null }, randomUUID()))

    const r = must(await reminders.remindItem(admin(), { itemId }, randomUUID()))
    expect(r.notified).toBe(2)
    const [event] = await remindedEvents(itemId)
    expect([...(event!.recipients as string[])].sort()).toEqual([g1m[1]!.id, t2.id].sort())
    const mails = await outbox([g1m[1]!.email, t2.email])
    expect(mails.find((m) => m.to_email === t2.email)!.body_text).toContain(`${SITE}/dashboard/teacher/signoff`)
    expect(mails.find((m) => m.to_email === g1m[1]!.email)!.body_text).toContain(`${SITE}/dashboard/student/signoff`)
  })
})

describe('AC-34：系辦首頁逾期卡與評分卡', () => {
  it('逾期卡：每份逾期作業各催一次，1 小時前剛催過的略過並回報；還沒截止的作業不催；只催逾期未繳的人', async () => {
    realNow = new Date('2026-11-20T06:00:00Z')
    const cohortId = await newCohort()
    const s = [await newUser('子', 'student', cohortId), await newUser('丑', 'student', cohortId), await newUser('寅', 'student', cohortId)]
    const recent = await published(cohortId, { title: '週報一' })
    const overdue = await published(cohortId, { title: '週報二' })
    await published(cohortId, { title: '還沒截止', dueAt: '2026-12-31T23:59' })
    await submitted(overdue, 'user', s[0]!.id, s[0]!.id)
    // 系辦開放「寅」補交到月底：還沒逾期，逾期卡不催他。
    await owner.sql(
      `insert into submission_reopens (id, item_id, receiver_kind, receiver_id, due_at, reason, created_by_user_id)
       values (gen_random_uuid(), $1, 'user', $2, '2026-11-30T15:59:00Z', '補交', $3)`,
      [overdue, s[2]!.id, adminId],
    )
    must(await reminders.remindItem(admin(), { itemId: recent }, randomUUID()))

    realNow = new Date('2026-11-20T07:00:00Z')
    const r = must(await reminders.remindOverdue(admin(), { cohortId }, randomUUID()))
    expect(r.items.map((i) => [i.title, i.notified, i.skippedCooldown]).sort()).toEqual([
      ['週報一', 0, true],
      ['週報二', 1, false],
    ])
    expect(r.notified).toBe(1)
    expect(describeOverdueReminder(r)).toBe('已通知 1 人（1 份作業 24 小時內催過，略過）')
    expect((await remindedEvents(overdue))[0]!.recipients).toEqual([s[1]!.id])
    expect(await remindedEvents(recent)).toHaveLength(1)

    // 剛催過的那份再按：兩份都在冷卻中 → 全部略過。
    const again = must(await reminders.remindOverdue(admin(), { cohortId }, randomUUID()))
    expect(again.items.every((i) => i.skippedCooldown)).toBe(true)
    expect(again.notified).toBe(0)
  })

  it('評分卡：未送齊的老師各一則「您還有 N 份評分未送出」，送齊的不催；解散組與舊階段的指派不算；冷卻以屆為單位', async () => {
    realNow = new Date('2026-11-20T08:00:00Z')
    const cohortId = await newCohort()
    const [t1, t2, t3] = [await newUser('一老師', 'teacher'), await newUser('二老師', 'teacher'), await newUser('三老師', 'teacher')]
    const m = [await newUser('學1', 'student', cohortId), await newUser('學2', 'student', cohortId), await newUser('學3', 'student', cohortId)]
    const g1 = await newGroup(cohortId, [m[0]!])
    const g2 = await newGroup(cohortId, [m[1]!])
    const g3 = await newGroup(cohortId, [m[2]!])
    await owner.sql(`update groups set status = 'dissolved', dissolved_real_at = now(), dissolve_reason = '解散' where id = $1`, [g3.id])

    const scheme = String((await rows(`insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, '評分', 'system') returning id`, [cohortId]))[0]!.id)
    const stages = JSON.stringify([{ key: 's1', name: '期中', weight: 100, letterMap: null, items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }] }])
    const version = String(
      (await rows(
        `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, created_by_user_id) values (gen_random_uuid(), $1, 1, $2::jsonb, 'published', $3) returning id`,
        [scheme, stages, adminId],
      ))[0]!.id,
    )
    await owner.sql('update grading_schemes set current_version_id = $1 where id = $2', [version, scheme])
    const assign = async (groupId: string, teacherId: string, stageKey = 's1') =>
      String(
        (await rows(
          `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id) values (gen_random_uuid(), $1, $2, $3, now(), $4) returning id`,
          [groupId, stageKey, teacherId, adminId],
        ))[0]!.id,
      )
    const counted = async (assignmentId: string) => {
      const e = String(
        (await rows(
          `insert into evaluations (id, assignment_id, kind, scheme_version_id, scores, submitted_real_at, submitted_business_at, request_id)
           values (gen_random_uuid(), $1, 'final', $2, '{"i1":90}'::jsonb, now(), now(), gen_random_uuid()) returning id`,
          [assignmentId, version],
        ))[0]!.id,
      )
      await owner.sql(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [e, assignmentId])
    }
    // 一老師：2 份、送 1 → 差 1；二老師：1 份、0 → 差 1；三老師：1 份已送＋解散組 1 份＋舊階段 1 份 → 不催。
    await counted(await assign(g1.id, t1.id))
    await assign(g2.id, t1.id)
    await assign(g1.id, t2.id)
    await counted(await assign(g2.id, t3.id))
    await assign(g3.id, t3.id)
    await assign(g1.id, t3.id, 'old')

    const r = must(await reminders.remindGrading(admin(), { cohortId }, randomUUID()))
    expect(r).toMatchObject({ cohortId, notified: 2, mailed: 2 })
    expect(r.nextAllowedAt).toEqual(new Date('2026-11-21T08:00:00Z'))
    expect(describeGradingReminder(r)).toBe('已通知 2 位老師')
    const events = await remindedEvents(cohortId, 'grading.reminded')
    expect(events.map((e) => [e.source_type, (e.recipients as string[])[0], (e.payload as { title: string }).title]).sort()).toEqual(
      [
        ['grading_cohort', t1.id, '您還有 1 份評分未送出'],
        ['grading_cohort', t2.id, '您還有 1 份評分未送出'],
      ].sort(),
    )
    const mails = await outbox([t1.email, t2.email, t3.email])
    expect(mails.map((x) => [x.to_email, x.template])).toEqual([[t1.email, 'reminder'], [t2.email, 'reminder']].sort((a, b) => a[0]!.localeCompare(b[0]!)))
    expect(mails[0]!.body_text).toBe(`您還有 1 份評分未送出。請到 ${SITE}/dashboard/teacher/grading 完成評分並送出。`)
    expect(await rows(`select count(*)::int as n from audit_events where action = 'grading.remind' and target_id = $1`, [cohortId])).toEqual([{ n: 1 }])

    // 老師的通知匣看得到標題、連到評分清單；別的老師打不開這一則；學生身分拿到這種來源是 forbidden。
    await projector().runOnce()
    const page = await inbox().list(actor(t1.id, ['teacher']), { kind: 'all' }, null)
    const note = page.items.find((n) => n.title === '您還有 1 份評分未送出')!
    expect(note).toMatchObject({ kind: 'grading', source: { state: 'ok', href: '/dashboard/teacher/grading' } })
    expect(must(await inbox().open(actor(t1.id, ['teacher']), note.id)).href).toBe('/dashboard/teacher/grading')
    expect(await inbox().open(actor(t3.id, ['teacher']), note.id)).toMatchObject({ ok: false })
    expect(resolveSource({ source_ref: { type: 'grading_cohort', id: cohortId }, cohort_status: 'active' }, ['student'])).toEqual({ state: 'forbidden' })
    expect(resolveSource({ source_ref: { type: 'grading_cohort', id: cohortId }, cohort_status: 'active' }, ['admin'])).toEqual({ state: 'forbidden' })

    // 冷卻以屆為單位。
    realNow = new Date('2026-11-20T09:00:00Z')
    expect(await reminders.remindGrading(admin(), { cohortId }, randomUUID())).toMatchObject({
      ok: false,
      code: 'CONFLICT',
      details: { nextAllowedAt: '2026-11-21T08:00:00.000Z' },
    })
    expect(must(await reminders.lastReminded(admin(), 'grading', cohortId)).nextAllowedAt).toEqual(new Date('2026-11-21T08:00:00Z'))
  })
})

describe('寄信在 commit 之後、盡力而為', () => {
  it('寄信失敗或卡住：催繳照樣成功（站內通知已寫）、mailed 只算寄出的；卡住的那封逾時不讓請求卡住', async () => {
    realNow = new Date('2026-11-20T10:00:00Z')
    const cohortId = await newCohort()
    const s = [await newUser('辰', 'student', cohortId), await newUser('巳', 'student', cohortId), await newUser('午', 'student', cohortId)]
    const itemId = await published(cohortId)
    const capture = new CaptureMailer({ db: () => app })
    const flaky: Mailer = {
      send: (message: MailMessage): Promise<MailSendResult> => {
        if (message.to === s[0]!.email) return new Promise(() => undefined) // 永遠不回
        if (message.to === s[1]!.email) return Promise.resolve({ ok: false, code: 'MAIL_FAILED', outboxId: randomUUID() })
        return capture.send(message)
      },
    }
    const withFlaky = new PgReminders({
      audit: new PgAuditWriter(),
      ledger: new PgOperationLedger(() => app),
      events: new PgEventPublisher(),
      businessClock,
      pool: () => app,
      reader: () => app,
      realClock,
      mail: { mailer: flaky, siteUrl: SITE },
      mailTimeoutMs: 200,
    })
    const started = Date.now()
    const r = must(await withFlaky.remindItem(admin(), { itemId }, randomUUID()))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(r).toMatchObject({ notified: 3, mailed: 1 })
    expect(await remindedEvents(itemId)).toHaveLength(1)
    expect((await outbox(s.map((x) => x.email))).map((m) => m.to_email)).toEqual([s[2]!.email])
  })
})
