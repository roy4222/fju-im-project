import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { PgGroupQuery } from '@/infrastructure/groups/pg-groups'

/**
 * AD-12：系辦屆別卡的學生數、組數（`GroupQuery.countsByCohort`）。
 *
 * 一句 SQL 算完全部屆別（不逐屆查）；口徑要跟 `overview()` 一模一樣——每一屆都拿兩邊的結果對照。
 * 以正式執行角色 `fju_app` 連線，讀不到的表這裡會直接紅。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
const businessNow = new Date('2026-09-25T02:00:00Z')

let seq = 0
async function newUser(name: string, status = 'active'): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), $3) returning id`,
    [name, `u${seq}-counts@example.com`, status],
  )
  return String(row.rows[0]!.id)
}

async function newCohort(status: 'preparing' | 'active' | 'archived'): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, $2, '2027-06-30', 'system') returning id`,
    [`AD12-${seq}`, status],
  )
  return String(row.rows[0]!.id)
}

async function newStudent(cohortId: string, status = 'active'): Promise<string> {
  seq += 1
  const studentNo = `41512${String(seq).padStart(4, '0')}`
  const id = await newUser(`學生${seq}`, status)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912345678', $5)`,
    [id, `學生${seq}`, studentNo, cohortId, `c${seq}@example.com`],
  )
  await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return id
}

/** 已成立的組別，直接寫好成立後的樣子（成組流程是票 13 的事）。 */
async function newGroup(cohortId: string, code: string, memberIds: string[]): Promise<string> {
  const row = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), $3, 'system') returning id`,
    [cohortId, code, businessNow],
  )
  const id = String(row.rows[0]!.id)
  for (const userId of memberIds) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [id, cohortId, userId, businessNow],
    )
  }
  return id
}

async function students(cohortId: string, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i += 1) ids.push(await newStudent(cohortId))
  return ids
}

/** `overview()` 算出來的同一組數字（現在屆別卡以前的算法）。 */
async function fromOverview(query: PgGroupQuery, cohortId: string) {
  const o = await query.overview(cohortId, { history: false })
  return { groups: o.groups.length, students: o.groups.reduce((sum, g) => sum + g.members.length, 0) + o.ungrouped.length }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'group-counts', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  adminId = await newUser('A1')
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('countsByCohort', () => {
  it('還沒有任何屆別：回空的 Map', async () => {
    expect((await new PgGroupQuery(() => app).countsByCohort()).size).toBe(0)
  })

  it('多屆（含封存屆、空屆）一句 SQL 算完，每屆都跟 overview 一致', async () => {
    // 進行中的一屆：一組 3 人、一組已解散（2 人，成員列沒結束）、2 位未分組、
    // 1 位退組（成員列已結束 → 算未分組）、1 位停用（不算）。
    const active = await newCohort('active')
    const [a1, a2, a3] = await students(active, 3)
    await newGroup(active, 'G01', [a1!, a2!, a3!])
    const dissolvedMembers = await students(active, 2)
    const dissolved = await newGroup(active, 'G02', dissolvedMembers)
    await owner.sql(`update groups set status = 'dissolved', dissolved_real_at = now(), dissolve_reason = '測試' where id = $1`, [
      dissolved,
    ])
    await students(active, 2)
    const left = await newStudent(active)
    const leftGroup = await newGroup(active, 'G03', [left])
    await owner.sql(`update group_memberships set valid_to = $2, removal_reason = '測試' where group_id = $1`, [
      leftGroup,
      new Date(businessNow.getTime() + 1000),
    ])
    await newStudent(active, 'disabled')

    // 封存屆：一組 2 人＋1 位未分組，照樣要算。
    const archived = await newCohort('archived')
    await newGroup(archived, 'G01', await students(archived, 2))
    await students(archived, 1)

    // 籌備中、什麼都沒有的一屆：不在 Map 裡（呼叫端當 0）。
    const empty = await newCohort('preparing')

    let statements = 0
    const counting = new PgGroupQuery(() => ({
      query: ((...args: Parameters<Pool['query']>) => {
        statements += 1
        return (app.query as (...a: unknown[]) => unknown)(...args)
      }) as Pool['query'],
    }))
    const counts = await counting.countsByCohort()
    expect(statements).toBe(1)

    // G01、G03 是 active（G03 成員已退）；G02 已解散。學生：G01 3 人＋未分組 2＋退組 1＝6。
    expect(counts.get(active)).toEqual({ groups: 2, students: 6 })
    expect(counts.get(archived)).toEqual({ groups: 1, students: 3 })
    expect(counts.has(empty)).toBe(false)

    const query = new PgGroupQuery(() => app)
    for (const cohortId of [active, archived, empty]) {
      expect(counts.get(cohortId) ?? { groups: 0, students: 0 }).toEqual(await fromOverview(query, cohortId))
    }
  })
})
