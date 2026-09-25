import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { readAuditLog } from '@/infrastructure/ops/pg-audit-log'

/**
 * 票 36「操作紀錄」頁的查詢：用 `fju_app`（正式站 app 的角色）讀，證明
 * 1. 依角色分頁與各分頁筆數正確；系統與背景工作歸「系統」；
 * 2. 磁碟量測（`storage.measured`）不列；超過 7 天的不列；
 * 3. 對象名稱：帳號＝姓名（profile 空白時退回帳號名）、組別與屆別＝代碼；
 * 4. 查詢結果**沒有 payload**（裡面的字串不會出現在回傳的任何欄位）。
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

  const insert = (values: {
    kind: 'user' | 'system' | 'worker'
    actor?: string | null
    role?: string | null
    action: string
    targetType: string
    targetId?: string | null
    cohort?: string | null
    reason?: string | null
    at: Date
  }) =>
    db.sql(
      `insert into audit_events
         (id, actor_kind, actor_user_id, role, action, target_type, target_id, scope, cohort_id, reason, real_at, business_at, payload)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11::jsonb)`,
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
        JSON.stringify({ secret: SECRET }),
      ],
    )
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000)

  await insert({ kind: 'user', actor: admin, role: 'admin', action: 'account.disable', targetType: 'user', targetId: student, reason: '休學', at: hoursAgo(1) })
  await insert({ kind: 'user', actor: teacher, role: 'teacher', action: 'advisor.claim', targetType: 'cohort', targetId: cohortId, cohort: cohortId, at: hoursAgo(2) })
  await insert({ kind: 'user', actor: student, role: 'student', action: 'submission.submit', targetType: 'item', at: hoursAgo(3) })
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
      'account.disable',
      'advisor.claim',
      'submission.submit',
      'account.seed_first_admin',
    ])
    expect(log.counts).toEqual({ all: 4, admin: 1, teacher: 1, student: 1, system: 1 })
    expect(log.withReason).toBe(1)
    expect(log.truncated).toBe(false)
  })

  it('依角色分頁；系統分頁收 system 與 worker', async () => {
    expect((await readAuditLog(app, 'teacher', NOW)).entries.map((e) => e.action)).toEqual(['advisor.claim'])
    expect((await readAuditLog(app, 'system', NOW)).entries.map((e) => e.actorKind)).toEqual(['system'])
  })

  it('操作者與對象的名字：profile 空白退回帳號名；屆別顯示代碼；系統沒有操作者', async () => {
    const log = await readAuditLog(app, 'all', NOW)
    const byAction = Object.fromEntries(log.entries.map((e) => [e.action, e]))
    expect(byAction['account.disable']).toMatchObject({ actorName: '系辦甲', targetName: 'student-al', reason: '休學', role: 'admin' })
    expect(byAction['advisor.claim']).toMatchObject({ actorName: '陳老師', targetName: '115-AL', cohortCode: '115-AL' })
    expect(byAction['account.seed_first_admin']).toMatchObject({ actorName: null, targetName: '系辦甲' })
  })

  it('回傳內容沒有 payload', async () => {
    const log = await readAuditLog(app, 'all', NOW)
    expect(JSON.stringify(log)).not.toContain(SECRET)
    for (const e of log.entries) expect(Object.keys(e)).not.toContain('payload')
  })
})
