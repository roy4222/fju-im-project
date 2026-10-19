import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { PgProfileCardCommand } from '@/infrastructure/accounts/profile-card-command'
import { PgGroupCommand } from '@/infrastructure/groups/pg-groups'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * C3-07：學生名片卡的讀與寫（C3 設計方案 §4.3、§4.5；AC-C3-06、07、10 的伺服器端）。
 *
 * 全部以正式執行角色 `fju_app` 連線：`user_profiles` 的 `bio`／`skills` 欄權限寫錯的話這裡直接紅。
 *
 * 「做完的樣子」對照：
 * 1. 學生存名片：`bio`、`skills`、`contact_email`、`open_to_join` 一次寫入、`revision`＋1、稽核只記改了哪幾欄（AC-C3-06）。
 * 2. 老師、系辦呼叫回 `FORBIDDEN`，`mine` 回 null（名片是學生自己的話）。
 * 3. 自介 51 字、第 9 個技能、13 字的技能都回 `VALIDATION_FAILED`；重複技能去空白後只留一個（AC-C3-07）。
 * 4. 已成組：自介、技能、Email 可以改；打開公開回 `ALREADY_MEMBER`；`setOpenToJoin(true)` 也是（AC-C3-10，既有保證）。
 * 5. 舊版本回 `CONFLICT`；同一個請求編號重送只做一次。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let teacherId: string
let cohortId: string
let command: PgProfileCardCommand
let groups: PgGroupCommand
const businessClock = { now: async () => new Date('2026-09-20T02:00:00Z') }

type Student = { id: string; cohortId: string; studentNo: string }
let seq = 0

async function newStudent(): Promise<Student> {
  seq += 1
  const studentNo = `41400${String(seq).padStart(4, '0')}`
  const user = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [`名片${seq}`, `card${seq}@example.com`],
  )
  const id = String(user.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email, department_class)
     values ($1, $2, $2, $3, $4, '0912345678', $5, '資管三甲')`,
    [id, `名片${seq}`, studentNo, cohortId, `card${seq}@contact.example.com`],
  )
  await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { id, cohortId, studentNo }
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

function staffActor(userId: string, role: 'admin' | 'teacher'): ResolvedActor {
  return { kind: 'authenticated', userId, roles: [role], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

type ProfileRow = { bio: string; skills: string[]; contact_email: string; open_to_join: boolean; revision: number }

async function profile(userId: string): Promise<ProfileRow> {
  const rows = await owner.sql('select bio, skills, contact_email, open_to_join, revision from user_profiles where user_id = $1', [userId])
  return rows.rows[0] as ProfileRow
}

async function audits(userId: string) {
  return (
    await owner.sql(`select payload from audit_events where action = 'account.profile_card_update' and actor_user_id = $1 order by real_at`, [userId])
  ).rows.map((r) => r.payload)
}

async function joinGroup(s: Student) {
  seq += 1
  const group = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [s.cohortId, `G${String(seq).padStart(2, '0')}`],
  )
  await owner.sql(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, now(), 'system', now(), now())`,
    [group.rows[0]!.id, s.cohortId, s.id],
  )
}

const input = { bio: '做過三個 Next.js 專案', skills: ['前端', '資料庫', 'Figma'], contactEmail: 'Me@Example.com', openToJoin: true }

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'profile-card', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  const deps = { audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), businessClock }
  command = new PgProfileCardCommand({ ...deps, db: () => app })
  groups = new PgGroupCommand({
    ...deps,
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    pool: () => app,
  })
  const staff = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A1', 'a1-card@example.com', true, now(), 'active'),
            (gen_random_uuid(), 'T1', 't1-card@example.com', true, now(), 'active')
     returning id, name`,
  )
  adminId = String(staff.rows.find((r) => r.name === 'A1')!.id)
  teacherId = String(staff.rows.find((r) => r.name === 'T1')!.id)
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, proposal_default_days, created_by_kind)
     values (gen_random_uuid(), 'C307', 'C307', 'active', '2027-06-30', 2, 5, 7, 'system') returning id`,
  )
  cohortId = String(cohort.rows[0]!.id)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('名片卡', () => {
  it('學生存名片：四欄一次寫入、revision＋1、稽核只記改了哪幾欄；mine 讀回來一樣', async () => {
    const s = await newStudent()
    const before = await command.mine(studentActor(s))
    expect(before).toMatchObject({
      id: s.id,
      studentNo: s.studentNo,
      departmentClass: '資管三甲',
      bio: '',
      skills: [],
      openToJoin: false,
      canOpenToJoin: true,
      avatarPreset: null,
      avatarFileId: null,
    })

    const saved = await command.save(studentActor(s), { ...input, revision: before!.revision }, randomUUID())
    expect(saved).toMatchObject({ ok: true, receipt: { revision: before!.revision + 1 } })
    expect(await profile(s.id)).toEqual({
      bio: '做過三個 Next.js 專案',
      skills: ['前端', '資料庫', 'Figma'],
      contact_email: 'me@example.com',
      open_to_join: true,
      revision: before!.revision + 1,
    })
    expect(await command.mine(studentActor(s))).toMatchObject({ bio: input.bio, skills: input.skills, openToJoin: true, contactEmail: 'me@example.com' })
    const [payload] = await audits(s.id)
    expect(payload).toEqual({ changed: ['bio', 'skills', 'contactEmail', 'openToJoin'], revision: before!.revision + 1, openToJoin: true })
    expect(JSON.stringify(payload)).not.toContain('Next.js')

    // 關掉公開：自介與技能留著。
    const off = await command.save(studentActor(s), { ...input, openToJoin: false, revision: before!.revision + 1 }, randomUUID())
    expect(off.ok).toBe(true)
    expect(await profile(s.id)).toMatchObject({ bio: input.bio, skills: input.skills, open_to_join: false })
  })

  it('老師、系辦呼叫回 FORBIDDEN、mine 回 null；資料不變', async () => {
    const s = await newStudent()
    const rev = (await profile(s.id)).revision
    for (const actor of [staffActor(teacherId, 'teacher'), staffActor(adminId, 'admin')]) {
      expect(await command.save(actor, { ...input, revision: rev }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(await command.mine(actor)).toBeNull()
    }
    expect(await command.save({ kind: 'anonymous' }, { ...input, revision: rev }, randomUUID())).toMatchObject({ ok: false })
    expect(await profile(s.id)).toMatchObject({ bio: '', open_to_join: false, revision: rev })
  })

  it('AC-C3-07：自介 51 字、第 9 個技能、13 字的技能回 VALIDATION_FAILED；重複技能去空白後只留一個', async () => {
    const s = await newStudent()
    const rev = (await profile(s.id)).revision
    const save = (patch: Partial<typeof input>) => command.save(studentActor(s), { ...input, ...patch, revision: rev }, randomUUID())
    expect(await save({ bio: '字'.repeat(51) })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: '自介最多 50 字。' })
    expect(await save({ skills: ['前端', '後端', '資料庫', '資料分析', 'AI', 'UI 設計', '簡報', '企劃', 'Figma'] })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: '最多 8 個技能。',
    })
    expect(await save({ skills: ['一'.repeat(13)] })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: '每個技能最多 12 字。' })
    expect(await save({ contactEmail: 'nope' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await profile(s.id)).toMatchObject({ bio: '', skills: [], revision: rev })

    expect(await save({ skills: ['前端', ' 前端 '] })).toMatchObject({ ok: true })
    expect((await profile(s.id)).skills).toEqual(['前端'])
  })

  it('AC-C3-10：已成組可以改自介、技能、Email；打開公開回 ALREADY_MEMBER，setOpenToJoin(true) 也是', async () => {
    const s = await newStudent()
    await joinGroup(s)
    const card = await command.mine(studentActor(s))
    expect(card).toMatchObject({ canOpenToJoin: false, openToJoin: false })

    expect(await command.save(studentActor(s), { ...input, revision: card!.revision }, randomUUID())).toMatchObject({
      ok: false,
      code: 'ALREADY_MEMBER',
    })
    expect(await groups.setOpenToJoin(studentActor(s), true, randomUUID())).toMatchObject({ ok: false, code: 'ALREADY_MEMBER' })

    const saved = await command.save(studentActor(s), { ...input, openToJoin: false, revision: card!.revision }, randomUUID())
    expect(saved).toMatchObject({ ok: true })
    expect(await profile(s.id)).toMatchObject({ bio: input.bio, skills: input.skills, open_to_join: false })
  })

  it('r1：另一個分頁先按「公開找隊員」開關，拿舊 revision 存名片回 CONFLICT，公開不會被默默關掉', async () => {
    const s = await newStudent()
    const stale = (await command.mine(studentActor(s)))!.revision
    expect(await groups.setOpenToJoin(studentActor(s), true, randomUUID())).toMatchObject({ ok: true })
    expect(await command.save(studentActor(s), { ...input, openToJoin: false, revision: stale }, randomUUID())).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })
    expect(await profile(s.id)).toMatchObject({ bio: '', open_to_join: true })
  })

  it('舊版本回 CONFLICT；同一個請求編號重送只做一次', async () => {
    const s = await newStudent()
    const rev = (await profile(s.id)).revision
    const requestId = randomUUID()
    const first = await command.save(studentActor(s), { ...input, revision: rev }, requestId)
    const again = await command.save(studentActor(s), { ...input, revision: rev }, requestId)
    expect(first).toMatchObject({ ok: true, receipt: { revision: rev + 1 } })
    expect(again).toMatchObject({ ok: true, receipt: { revision: rev + 1 } })
    expect(await audits(s.id)).toHaveLength(1)

    expect(await command.save(studentActor(s), { ...input, bio: '改一下', revision: rev }, randomUUID())).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })
    expect((await profile(s.id)).bio).toBe(input.bio)
  })
})
