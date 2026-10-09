import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { readAuditLog } from '@/infrastructure/ops/pg-audit-log'

/**
 * 票 36「操作紀錄」頁的查詢：用 `fju_app`（正式站 app 的角色）讀，證明
 * 1. 依角色分頁與各分頁筆數正確；系統與背景工作歸「系統」；沒有角色的本人動作歸「本人申請」，
 *    除了「全部」以外的分頁加起來等於「全部」（2026-10-08 系3）；
 * 2. 磁碟量測（`storage.measured`）不列；超過 7 天的不列；
 * 3. 對象名稱：帳號＝姓名（profile 空白時退回帳號名）、組別＝代碼、屆別＝「名稱（代碼）」（系1）、
 *    註冊申請＝申請人姓名、活動＝標題；核准列帶核實方式與核實說明（系2）；
 * 4. 查詢結果**沒有 payload**（裡面的字串不會出現在回傳的任何欄位；核實說明是唯一取出的鍵）。
 */

let db: IsolatedDatabase
let app: Pool
const NOW = new Date('2026-09-25T06:00:00Z')
const SECRET = 'payload-should-never-leak-7f3a'

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'audit_log', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')

  const cohort = await db.sql(
    `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '115-AL', '115 紀錄', 'system') returning id`,
  )
  const cohortId = String(cohort.rows[0]!.id)
  const user = async (name: string, display: string) => {
    const row = await db.sql(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, false, now(), 'active') returning id`,
      [name, `${name}@example.com`],
    )
    const id = String(row.rows[0]!.id)
    await db.sql(
      `insert into user_profiles (user_id, display_name, name_normalized, contact_email) values ($1, $2, $2, $3)`,
      [id, display, `${name}@example.com`],
    )
    return id
  }
  const admin = await user('admin-al', '系辦甲')
  const teacher = await user('teacher-al', '陳老師')
  const student = await user('student-al', '   ')
  const applicant = await user('applicant-al', '林申請')
  const application = await db.sql(
    `insert into registration_applications
       (id, user_id, applied_name, student_no, phone, contact_email, login_email, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, '林申請', 'A1150001', '0912-000-000', 'applicant-al@example.com', 'applicant-al@example.com', 'user', $1)
     returning id`,
    [applicant],
  )
  const applicationId = String(application.rows[0]!.id)
  const activity = await db.sql(
    `insert into project_events (id, cohort_id, title, starts_at, audience_kind, created_by_kind)
     values (gen_random_uuid(), $1, '期末成果發表', '2026-12-20T06:00:00Z', 'cohort_students', 'system') returning id`,
    [cohortId],
  )
  const activityId = String(activity.rows[0]!.id)

  const insert = (values: {
    kind: 'user' | 'system' | 'worker'
    actor?: string | null
    role?: string | null
    action: string
    targetType: string
    targetId?: string | null
    cohort?: string | null
    reason?: string | null
    verification?: string | null
    payload?: Record<string, unknown>
    at: Date
  }) =>
    db.sql(
      `insert into audit_events
         (id, actor_kind, actor_user_id, role, action, target_type, target_id, scope, cohort_id, reason, real_at, business_at,
          payload, verification_method)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11::jsonb, $12)`,
      [
        values.kind,
        values.actor ?? null,
        values.role ?? null,
        values.action,
        values.targetType,
        values.targetId ?? null,
        values.cohort ? 'cohort' : 'global',
        values.cohort ?? null,
        values.reason ?? null,
        values.at,
        JSON.stringify({ ...values.payload, secret: SECRET }),
        values.verification ?? null,
      ],
    )
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000)

  await insert({
    kind: 'user',
    actor: admin,
    role: 'admin',
    action: 'account.approve',
    targetType: 'registration_application',
    targetId: applicationId,
    cohort: cohortId,
    verification: 'id_document',
    payload: { userId: applicant, verificationNote: '10/8 系辦櫃台核對學生證' },
    at: hoursAgo(0.5),
  })
  await insert({ kind: 'user', actor: admin, role: 'admin', action: 'account.disable', targetType: 'user', targetId: student, reason: '休學', at: hoursAgo(1) })
  await insert({ kind: 'user', actor: teacher, role: 'teacher', action: 'advisor.claim', targetType: 'cohort', targetId: cohortId, cohort: cohortId, at: hoursAgo(2) })
  await insert({ kind: 'user', actor: applicant, action: 'registration.apply', targetType: 'registration_application', targetId: applicationId, at: hoursAgo(2.5) })
  await insert({ kind: 'user', actor: student, role: 'student', action: 'submission.submit', targetType: 'item', at: hoursAgo(3) })
  await insert({ kind: 'user', actor: admin, role: 'admin', action: 'cohort.activity.create', targetType: 'project_event', targetId: activityId, cohort: cohortId, at: hoursAgo(3.5) })
  await insert({ kind: 'system', action: 'account.seed_first_admin', targetType: 'user', targetId: admin, at: hoursAgo(4) })
  await insert({ kind: 'worker', action: 'storage.measured', targetType: 'storage', at: hoursAgo(5) })
  await insert({ kind: 'user', actor: admin, role: 'admin', action: 'cohort.create', targetType: 'cohort', targetId: cohortId, at: hoursAgo(24 * 8) })
})

afterAll(async () => {
  await app?.end()
  await db?.close()
})

describe('readAuditLog', () => {
  it('全部分頁：新到舊、不含磁碟量測與 7 天前的紀錄；各分頁筆數與附理由筆數', async () => {
    const log = await readAuditLog(app, 'all', NOW)
    expect(log.entries.map((e) => e.action)).toEqual([
      'account.approve',
      'account.disable',
      'advisor.claim',
      'registration.apply',
      'submission.submit',
      'cohort.activity.create',
      'account.seed_first_admin',
    ])
    expect(log.counts).toEqual({ all: 7, admin: 3, teacher: 1, student: 1, other: 1, system: 1 })
    expect(log.withReason).toBe(1)
    expect(log.truncated).toBe(false)
  })

  it('系3：沒有角色的本人動作（送出註冊申請）歸「本人申請」，分頁加起來等於全部', async () => {
    const log = await readAuditLog(app, 'all', NOW)
    expect(log.counts.other).toBe(1)
    const { all, ...tabs } = log.counts
    expect(Object.values(tabs).reduce((sum, n) => sum + n, 0)).toBe(all)
    expect((await readAuditLog(app, 'other', NOW)).entries.map((e) => e.action)).toEqual(['registration.apply'])
  })

  it('系2：核准列看得到被核准的人、核實方式與核實說明；其他列沒有核實說明', async () => {
    const log = await readAuditLog(app, 'all', NOW)
    const byAction = Object.fromEntries(log.entries.map((e) => [e.action, e]))
    expect(byAction['account.approve']).toMatchObject({
      targetType: 'registration_application',
      targetName: '林申請',
      verificationMethod: 'id_document',
      verificationNote: '10/8 系辦櫃台核對學生證',
      cohortName: '115 紀錄',
    })
    expect(byAction['registration.apply']).toMatchObject({ targetName: '林申請', verificationMethod: null, verificationNote: null })
    expect(byAction['account.disable']).toMatchObject({ verificationNote: null })
    expect(byAction['cohort.activity.create']).toMatchObject({ targetName: '期末成果發表' })
  })

  it('依角色分頁；系統分頁收 system 與 worker', async () => {
    expect((await readAuditLog(app, 'teacher', NOW)).entries.map((e) => e.action)).toEqual(['advisor.claim'])
    expect((await readAuditLog(app, 'system', NOW)).entries.map((e) => e.actorKind)).toEqual(['system'])
  })

  it('操作者與對象的名字：profile 空白退回帳號名；屆別顯示「名稱（代碼）」；系統沒有操作者', async () => {
    const log = await readAuditLog(app, 'all', NOW)
    const byAction = Object.fromEntries(log.entries.map((e) => [e.action, e]))
    expect(byAction['account.disable']).toMatchObject({ actorName: '系辦甲', targetName: 'student-al', reason: '休學', role: 'admin' })
    expect(byAction['advisor.claim']).toMatchObject({ actorName: '陳老師', targetName: '115 紀錄（115-AL）', cohortCode: '115-AL' })
    expect(byAction['account.seed_first_admin']).toMatchObject({ actorName: null, targetName: '系辦甲' })
  })

  it('回傳內容沒有 payload', async () => {
    const log = await readAuditLog(app, 'all', NOW)
    expect(JSON.stringify(log)).not.toContain(SECRET)
    for (const e of log.entries) expect(Object.keys(e)).not.toContain('payload')
  })
})
