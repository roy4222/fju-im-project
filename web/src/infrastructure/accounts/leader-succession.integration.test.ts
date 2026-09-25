import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AccountDirectoryCommand, ResolvedActor } from '@/application/accounts'
import type { PgGroupCommand } from '@/infrastructure/groups/pg-groups'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 票 42：停用組長時要同時指定接任（產品模組 03「組長」；GRP-18「移出或停用組長時系統要求指定接任，否則不能完成操作」）。
 *
 * 真的 PostgreSQL（隔離 schema），**全程以 `fju_app` 連線**；停用用例注入分組模組的 `LeaderSuccessionHook`，
 * 撤 session 換成空函式（這裡不驗 Better Auth，票 9 的整合測試驗過）。
 * 每個成功或拒絕都核對不變量「每組恰一位有效組長，而且是有效成員」；拒絕的案例另外證明資料完全沒動。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let groups: PgGroupCommand
let accounts: AccountDirectoryCommand
const businessClock = { now: async () => new Date('2026-09-20T02:00:00Z') }
const context = { headers: new Headers() }

type Student = { id: string; studentNo: string; name: string; cohortId: string }

function adminActor(): ResolvedActor {
  return { kind: 'authenticated', userId: adminId, roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

function studentActor(s: Student): ResolvedActor {
  return {
    kind: 'authenticated',
    userId: s.id,
    roles: ['student'],
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: [{ cohortId: s.cohortId, role: 'student' }],
  }
}

let cohortSeq = 0
async function newCohort(size = { min: 2, max: 5 }): Promise<string> {
  cohortSeq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, proposal_default_days, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', $2, $3, 7, 'system') returning id`,
    [`T42-${cohortSeq}`, size.min, size.max],
  )
  const cohortId = String(cohort.rows[0]!.id)
  for (const [i, [name, date]] of [
    ['成組期', '2026-09-15'],
    ['期中', '2026-11-01'],
    ['期末', '2027-01-10'],
    ['成果', '2027-03-01'],
  ].entries()) {
    await owner.sql(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, name, date],
    )
  }
  return cohortId
}

let studentSeq = 0
async function newStudent(cohortId: string): Promise<Student> {
  studentSeq += 1
  const studentNo = `41442${String(studentSeq).padStart(4, '0')}`
  const name = `組員${studentSeq}`
  const email = `t42-${studentSeq}@example.com`
  const user = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, email],
  )
  const id = String(user.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912345678', $5)`,
    [id, name, studentNo, cohortId, `contact-${email}`],
  )
  await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { id, studentNo, name, cohortId }
}

/** 走一次真的提案＋全員確認成立一組；第一位是提案人＝組長。 */
async function establishGroup(members: Student[]): Promise<{ groupId: string; code: string }> {
  const proposed = await groups.propose(
    studentActor(members[0]!),
    { groupType: 'general', memberStudentNos: members.slice(1).map((s) => s.studentNo) },
    randomUUID(),
  )
  if (!proposed.ok) throw new Error(`${proposed.code} ${proposed.message}`)
  for (const m of members) {
    const confirmed = await groups.confirm(studentActor(m), proposed.receipt.proposalId, randomUUID())
    if (!confirmed.ok) throw new Error(`${confirmed.code} ${confirmed.message}`)
  }
  const row = await owner.sql(
    `select g.id, g.code from group_proposals p join groups g on g.id = p.established_group_id where p.id = $1`,
    [proposed.receipt.proposalId],
  )
  return { groupId: String(row.rows[0]!.id), code: String(row.rows[0]!.code) }
}

async function groupWith(n: number, size = { min: 2, max: 5 }) {
  const cohortId = await newCohort(size)
  const members: Student[] = []
  for (let i = 0; i < n; i += 1) members.push(await newStudent(cohortId))
  const group = await establishGroup(members)
  return { cohortId, members, leader: members[0]!, ...group }
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

async function statusOf(userId: string): Promise<string> {
  return String((await owner.sql('select status from users where id = $1', [userId])).rows[0]!.status)
}

async function revisionOf(groupId: string): Promise<number> {
  return Number((await owner.sql('select revision from groups where id = $1', [groupId])).rows[0]!.revision)
}

/** 不變量：每組恰一位有效組長，而且是有效成員。回傳組長 id。 */
async function expectOneLeaderWhoIsMember(groupId: string): Promise<string> {
  const leaders = await owner.sql('select user_id from group_leaders where group_id = $1 and valid_to is null', [groupId])
  expect(leaders.rows).toHaveLength(1)
  const leaderId = String(leaders.rows[0]!.user_id)
  const members = await owner.sql('select user_id from group_memberships where group_id = $1 and valid_to is null', [groupId])
  expect(members.rows.map((r) => String(r.user_id))).toContain(leaderId)
  return leaderId
}

/** 拒絕的證據：帳號狀態、狀態事件、組長列、組別版本、事件、稽核都沒動。 */
async function snapshot(userId: string, groupId: string) {
  return {
    status: await statusOf(userId),
    statusEvents: await count('select count(*) as n from user_status_events where user_id = $1', [userId]),
    leaderRows: await count('select count(*) as n from group_leaders where group_id = $1', [groupId]),
    revision: await revisionOf(groupId),
    leaderEvents: await count(`select count(*) as n from domain_events where type = 'group.leader_changed' and source_id = $1`, [groupId]),
    disableAudits: await count(`select count(*) as n from audit_events where action = 'account.disable' and target_id = $1`, [userId]),
  }
}

function disable(userId: string, successorLeaders?: { groupId: string; userId: string }[], requestId = randomUUID(), reason = '休學') {
  return accounts.disable(adminActor(), { userId, reason, requestId, ...(successorLeaders ? { successorLeaders } : {}) }, context)
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 't42-succession', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')

  const url = new URL(TEST_DATABASE_URL)
  url.username = 'fju_app'
  url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
  url.searchParams.set('options', `-c search_path=${owner.schemaName}`)
  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:3000')

  const { PgGroupCommand } = await import('@/infrastructure/groups/pg-groups')
  const { PgAccountDirectoryCommand } = await import('@/infrastructure/accounts/account-directory-command')
  const { SessionRevocationExecutor } = await import('@/infrastructure/accounts/session-revocation')
  const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
  const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
  const { PgEventPublisher } = await import('@/infrastructure/notifications/pg-event-publisher')
  const { PgDueWorkScheduler } = await import('@/infrastructure/notifications/pg-due-work-scheduler')

  groups = new PgGroupCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    businessClock,
    pool: () => app,
  })
  accounts = new PgAccountDirectoryCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    db: () => app,
    revocations: new SessionRevocationExecutor({ db: () => app, call: async () => undefined }),
    leaders: groups,
  })

  const staff = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A1', 'a1-t42@example.com', true, now(), 'active') returning id`,
  )
  adminId = String(staff.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'admin', $1, now())`,
    [adminId],
  )
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.end()
  await owner?.close()
})

describe('停用組長：一定要同時指定接任（GRP-18）', () => {
  it('沒指定接任就不能停用；帳號、組長、組別版本、事件、稽核全部沒動', async () => {
    const g = await groupWith(3)
    const before = await snapshot(g.leader.id, g.groupId)

    const result = await disable(g.leader.id)
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'successorLeaderUserId' } })
    if (!result.ok) expect(result.message).toContain(`${g.code} 的組長`)

    expect(await snapshot(g.leader.id, g.groupId)).toEqual(before)
    expect(await expectOneLeaderWhoIsMember(g.groupId)).toBe(g.leader.id)
  })

  it('對話框的選項：列出他擔任組長的組，候選人是其他有效成員（停用中的成員不列）', async () => {
    const g = await groupWith(4)
    const [, b, c, d] = g.members
    // 先停用一位普通組員：不是組長，不需要接任。
    expect(await disable(d!.id)).toMatchObject({ ok: true })

    const options = await accounts.successionOptions(adminActor(), g.leader.id)
    expect(options.ok).toBe(true)
    if (!options.ok) return
    expect(options.receipt.leaderships).toHaveLength(1)
    expect(options.receipt.leaderships[0]).toMatchObject({ groupId: g.groupId, groupCode: g.code })
    expect(options.receipt.leaderships[0]!.candidates.map((x) => x.userId).sort()).toEqual([b!.id, c!.id].sort())

    // 不是組長：空陣列。非管理員：拒絕。
    const plain = await accounts.successionOptions(adminActor(), b!.id)
    expect(plain.ok && plain.receipt.leaderships).toEqual([])
    expect(await accounts.successionOptions(studentActor(b!), g.leader.id)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('接任是停用中的成員、或不是這組的人 → 拒絕，資料不動', async () => {
    const g = await groupWith(3)
    const other = await groupWith(2)
    const [, b, c] = g.members
    expect(await disable(c!.id)).toMatchObject({ ok: true })
    const before = await snapshot(g.leader.id, g.groupId)

    expect(await disable(g.leader.id, [{ groupId: g.groupId, userId: c!.id }])).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      details: { field: 'successorLeaderUserId' },
    })
    expect(await disable(g.leader.id, [{ groupId: g.groupId, userId: other.members[1]!.id }])).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    expect(await disable(g.leader.id, [{ groupId: g.groupId, userId: g.leader.id }])).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    // 接任的組不是他當組長的組 → 組長資料對不上。
    expect(await disable(g.leader.id, [{ groupId: other.groupId, userId: other.members[1]!.id }])).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })
    expect(await snapshot(g.leader.id, g.groupId)).toEqual(before)
    expect(await expectOneLeaderWhoIsMember(g.groupId)).toBe(g.leader.id)
    // b 仍是合法接任人（上面的拒絕沒把他弄壞）。
    expect(b).toBeDefined()
  })

  it('指定接任：停用與換組長同一筆交易完成；只換組長不重簽；全組收到通知；重送同一請求拿同一張回執', async () => {
    const g = await groupWith(3)
    const [, b] = g.members
    const revision = await revisionOf(g.groupId)
    const requestId = randomUUID()

    const result = await disable(g.leader.id, [{ groupId: g.groupId, userId: b!.id }], requestId)
    expect(result).toMatchObject({ ok: true, receipt: { status: 'disabled', successions: [{ groupCode: g.code, leaderName: b!.name }] } })

    expect(await statusOf(g.leader.id)).toBe('disabled')
    expect(await expectOneLeaderWhoIsMember(g.groupId)).toBe(b!.id)
    expect(await revisionOf(g.groupId)).toBe(revision + 1)
    // 停用不是移出：原組長仍是組員列（帳號停用而已）。
    expect(
      await count('select count(*) as n from group_memberships where group_id = $1 and user_id = $2 and valid_to is null', [g.groupId, g.leader.id]),
    ).toBe(1)
    // 舊組長列有結束時間、新列記下是誰、為什麼換。
    const history = await owner.sql(
      `select user_id, valid_to, reason, changed_by_user_id from group_leaders where group_id = $1 order by created_at, valid_from`,
      [g.groupId],
    )
    expect(history.rows).toHaveLength(2)
    expect(history.rows[0]).toMatchObject({ user_id: g.leader.id })
    expect(history.rows[0]!.valid_to).not.toBeNull()
    expect(history.rows[1]).toMatchObject({ user_id: b!.id, reason: '帳號停用：休學', changed_by_user_id: adminId })

    const events = await owner.sql(`select type, recipients from domain_events where source_id = $1 and type like 'group.%' order by occurred_real_at, id`, [
      g.groupId,
    ])
    const leaderEvents = events.rows.filter((e) => e.type === 'group.leader_changed')
    expect(leaderEvents).toHaveLength(1)
    expect([...(leaderEvents[0]!.recipients as string[])].sort()).toEqual(g.members.map((m) => m.id).sort())
    expect(events.rows.some((e) => e.type === 'group.members_changed')).toBe(false)

    const audit = await owner.sql(
      `select reason, payload from audit_events where action = 'group.leader.change' and target_id = $1`,
      [g.groupId],
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]).toMatchObject({
      reason: '帳號停用：休學',
      payload: { previousLeaderUserId: g.leader.id, leaderUserId: b!.id, cause: 'account_disable' },
    })
    expect(await count(`select count(*) as n from audit_events where action = 'account.disable' and target_id = $1`, [g.leader.id])).toBe(1)

    // 重送：同一張回執，不會再換一次。換了接任人卻用同一個請求編號 → REQUEST_MISMATCH。
    const replay = await disable(g.leader.id, [{ groupId: g.groupId, userId: b!.id }], requestId)
    expect(replay).toMatchObject({ ok: true, receipt: { successions: [{ groupCode: g.code }] } })
    expect(await count('select count(*) as n from group_leaders where group_id = $1', [g.groupId])).toBe(2)
    expect(await disable(g.leader.id, [{ groupId: g.groupId, userId: g.members[2]!.id }], requestId)).toMatchObject({
      ok: false,
      code: 'REQUEST_MISMATCH',
    })

    // 恢復原組長：不會把組長換回去（換組長留紀錄即可，不自動還原）。
    expect(await accounts.restore(adminActor(), { userId: g.leader.id, reason: '復學', requestId: randomUUID() }, context)).toMatchObject({
      ok: true,
      receipt: { status: 'active' },
    })
    expect(await expectOneLeaderWhoIsMember(g.groupId)).toBe(b!.id)
  })

  it('不是組長卻帶了接任 → 拒絕（組長資料對不上）', async () => {
    const g = await groupWith(3)
    const [, b, c] = g.members
    expect(await disable(b!.id, [{ groupId: g.groupId, userId: c!.id }])).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await statusOf(b!.id)).toBe('active')
  })

  it('這組沒有其他可以接任的有效成員 → 不能停用，請先到分組總覽處理', async () => {
    const g = await groupWith(2)
    expect(await disable(g.members[1]!.id)).toMatchObject({ ok: true })
    const before = await snapshot(g.leader.id, g.groupId)

    const result = await disable(g.leader.id)
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!result.ok) expect(result.message).toContain('沒有其他可以接任的有效成員')
    expect(await snapshot(g.leader.id, g.groupId)).toEqual(before)
  })

  it('封存屆別的組是唯讀歷史：停用當年的組長不需要接任，組長列也不動', async () => {
    const g = await groupWith(3)
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [g.cohortId])
    const leaderRows = await count('select count(*) as n from group_leaders where group_id = $1', [g.groupId])

    expect(await accounts.successionOptions(adminActor(), g.leader.id)).toMatchObject({ ok: true, receipt: { leaderships: [] } })
    expect(await disable(g.leader.id)).toMatchObject({ ok: true, receipt: { status: 'disabled' } })
    expect(await count('select count(*) as n from group_leaders where group_id = $1', [g.groupId])).toBe(leaderRows)
  })
})

describe('批次停用不能繞過接任', () => {
  it('預覽把組長列成「略過」、請逐筆停用；偽造的名單把組長塞回來 → 名單有變動，整批不做', async () => {
    const g = await groupWith(3)
    const [, b] = g.members
    const text = `${g.leader.studentNo}\n${b!.studentNo}`

    const preview = await accounts.previewBulkDisable(adminActor(), text)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.receipt.hits.map((h) => h.userId)).toEqual([b!.id])
    expect(preview.receipt.skipped).toHaveLength(1)
    expect(preview.receipt.skipped[0]).toMatchObject({ studentNo: g.leader.studentNo })
    expect(preview.receipt.skipped[0]!.reason).toContain('組長')

    const forged = await accounts.bulkDisable(
      adminActor(),
      { text, expectedUserIds: [g.leader.id, b!.id], reason: '休學', requestId: randomUUID() },
      context,
    )
    expect(forged).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await statusOf(g.leader.id)).toBe('active')
    expect(await statusOf(b!.id)).toBe('active')

    // 照預覽送：只停用 b，組長不動。
    expect(
      await accounts.bulkDisable(adminActor(), { text, expectedUserIds: [b!.id], reason: '休學', requestId: randomUUID() }, context),
    ).toMatchObject({ ok: true, receipt: { disabled: 1 } })
    expect(await statusOf(g.leader.id)).toBe('active')
    expect(await expectOneLeaderWhoIsMember(g.groupId)).toBe(g.leader.id)
  })
})

describe('停用中的人不能被指定為組長', () => {
  it('管理員換組長、移出組長時指定的接任，帳號已停用 → 拒絕', async () => {
    const g = await groupWith(4)
    const [, b, c] = g.members
    expect(await disable(c!.id)).toMatchObject({ ok: true })

    const revision = await revisionOf(g.groupId)
    expect(
      await groups.changeLeader(adminActor(), { groupId: g.groupId, revision, newLeaderUserId: c!.id, reason: '換人' }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'newLeaderUserId' } })
    expect(
      await groups.removeMember(
        adminActor(),
        { groupId: g.groupId, revision, userId: g.leader.id, reason: '轉組', successorLeaderUserId: c!.id },
        randomUUID(),
      ),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'successorLeaderUserId' } })
    expect(await expectOneLeaderWhoIsMember(g.groupId)).toBe(g.leader.id)

    // 有效成員照舊可以接任。
    expect(
      await groups.changeLeader(adminActor(), { groupId: g.groupId, revision, newLeaderUserId: b!.id, reason: '換人' }, randomUUID()),
    ).toMatchObject({ ok: true })
    expect(await expectOneLeaderWhoIsMember(g.groupId)).toBe(b!.id)
  })
})
