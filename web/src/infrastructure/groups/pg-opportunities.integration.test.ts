import { randomUUID } from 'node:crypto'
import { unzipSync, strFromU8 } from 'fflate'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { normalizeRosterFilter, type OpportunityInput } from '@/application/groups'
import { PgGroupQuery } from '@/infrastructure/groups/pg-groups'
import { PgOpportunityCommand, PgOpportunityQuery } from '@/infrastructure/groups/pg-opportunities'
import { PgGroupRosterExporter } from '@/infrastructure/groups/pg-roster-export'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * 票 20：產學合作案、組別連結、組長改類型、組別名單匯出（產品模組 03 §4「5.3」「5.5」「6.1–6.3」；
 * GRP-08、GRP-14、GRP-15、GRP-16、GRP-19；執行手冊 C18）。
 *
 * 全部以正式執行角色 `fju_app` 連線（`opportunity_links` 只能改結束欄，寫錯的話這裡直接紅）。
 * 聯絡資訊的可見性看的是**查詢回來的物件**：不是畫面藏起來，而是非案主的查詢結果裡根本沒有那幾個值。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let businessNow = new Date('2026-09-25T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let command: PgOpportunityCommand
let query: PgOpportunityQuery
let groupQuery: PgGroupQuery

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
const adminActor = () => actor(adminId, ['admin'])
const anonymous: ResolvedActor = { kind: 'anonymous' }

let seq = 0
async function newUser(name: string, email = `u${(seq += 1)}-${randomUUID().slice(0, 8)}@example.com`): Promise<string> {
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, email],
  )
  return String(row.rows[0]!.id)
}

async function newTeacher(name: string): Promise<string> {
  const id = await newUser(name, `t${(seq += 1)}-${randomUUID().slice(0, 8)}@fju.edu.tw`)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'teacher', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email, profile_completed_at)
     values ($1, $2, $2, $3, now())`,
    [id, name, `${name}@contact.example.com`],
  )
  return id
}

async function newCohort(stages: [string, string] = ['2026-09-01', '2026-10-15']): Promise<{ id: string; code: string }> {
  const code = `T20-${(seq += 1)}`
  const row = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [code],
  )
  const id = String(row.rows[0]!.id)
  for (const [index, start] of stages.entries()) {
    await owner.sql(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [id, index + 1, `第 ${index + 1} 階段`, start],
    )
  }
  return { id, code }
}

type Student = { id: string; studentNo: string; name: string; email: string }
async function newStudent(cohortId: string, name = `學生${seq + 1}`): Promise<Student> {
  seq += 1
  const studentNo = `0412${String(seq).padStart(5, '0')}`
  const email = `s${seq}-${randomUUID().slice(0, 6)}@school.example.org`
  const id = await newUser(name, email)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912345678', $5)`,
    [id, name, studentNo, cohortId, `contact-${seq}@example.com`],
  )
  await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { id, studentNo, name, email }
}

type Group = { id: string; code: string; members: Student[]; leader: Student }
async function newGroup(cohortId: string, code: string, type: 'general' | 'industry', size = 3): Promise<Group> {
  const members: Student[] = []
  for (let i = 0; i < size; i += 1) members.push(await newStudent(cohortId))
  const row = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, $3, now(), $4, 'system') returning id`,
    [cohortId, code, type, businessNow],
  )
  const id = String(row.rows[0]!.id)
  for (const m of members) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [id, cohortId, m.id, businessNow],
    )
  }
  await owner.sql(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, $3, $2)`,
    [id, members[0]!.id, businessNow],
  )
  return { id, code, members, leader: members[0]! }
}

async function revisionOf(groupId: string): Promise<number> {
  return Number((await owner.sql('select revision from groups where id = $1', [groupId])).rows[0]!.revision)
}

async function opportunityRevision(id: string): Promise<number> {
  return Number((await owner.sql('select revision from industry_opportunities where id = $1', [id])).rows[0]!.revision)
}

const CONTACT = {
  address: '新北市新莊區中正路 510 號',
  contactName: '王經理',
  contactPhone: '02-2905-0000',
  contactEmail: 'secret-contact@company.example.com',
}

function input(overrides: Partial<OpportunityInput> = {}): OpportunityInput {
  return {
    companyName: '輔仁零售',
    department: '資訊部',
    content: '門市補貨預測',
    requirements: '會 Python',
    notes: '內部備註：預算 20 萬',
    notesVisibility: 'internal',
    ...CONTACT,
    ...overrides,
  }
}

async function createOpportunity(teacherId: string, options: { publish?: boolean; overrides?: Partial<OpportunityInput> } = {}) {
  const result = await command.create(
    actor(teacherId, ['teacher']),
    { ...input(options.overrides), publish: options.publish ?? true },
    randomUUID(),
  )
  if (!result.ok) throw new Error(result.message)
  return result.receipt.opportunityId
}

async function events(type: string, groupId: string) {
  const rows = await owner.sql(
    `select recipients, payload from domain_events where type = $1 and payload->>'groupId' = $2 order by occurred_real_at, id`,
    [type, groupId],
  )
  return rows.rows.map((r) => ({ recipients: [...(r.recipients as string[])].sort(), payload: r.payload as Record<string, unknown> }))
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'opportunities', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  adminId = await newUser('A1')
  command = new PgOpportunityCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    businessClock,
    pool: () => app,
  })
  query = new PgOpportunityQuery({ businessClock, reader: () => app })
  groupQuery = new PgGroupQuery(() => app)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

afterEach(async () => {
  businessNow = new Date('2026-09-25T02:00:00Z')
  // 不變量：一組同時最多連結一個合作案。
  const rows = await owner.sql(`select group_id from opportunity_links where valid_to is null group by group_id having count(*) > 1`)
  expect(rows.rows).toEqual([])
})

describe('合作案：建立、發布、下架、重新發布（6.1、GRP-08）', () => {
  it('老師建立草稿 → 發布 → 下架 → 重新發布；每一步版本加一、留稽核', async () => {
    const t = await newTeacher('案主甲')
    const created = await command.create(actor(t, ['teacher']), { ...input(), publish: false }, randomUUID())
    expect(created.ok && created.receipt.status).toBe('draft')
    const id = created.ok ? created.receipt.opportunityId : ''

    const published = await command.publish(actor(t, ['teacher']), { opportunityId: id, revision: 1 }, randomUUID())
    expect(published.ok && published.receipt.action).toBe('published')
    const withdrawn = await command.withdraw(actor(t, ['teacher']), { opportunityId: id, revision: 2 }, randomUUID())
    expect(withdrawn.ok && withdrawn.receipt.status).toBe('withdrawn')
    const republished = await command.publish(actor(t, ['teacher']), { opportunityId: id, revision: 3 }, randomUUID())
    expect(republished.ok && republished.receipt.action).toBe('republished')

    const audits = await owner.sql(
      `select action from audit_events where target_type = 'industry_opportunity' and target_id = $1 order by real_at, id`,
      [id],
    )
    expect(audits.rows.map((r) => r.action)).toEqual([
      'opportunity.create',
      'opportunity.publish',
      'opportunity.withdraw',
      'opportunity.republish',
    ])
    // 稽核不帶聯絡資料（契約 01 §4.3）。
    const payloads = await owner.sql(`select payload::text as p from audit_events where target_id = $1`, [id])
    expect(payloads.rows.map((r) => String(r.p)).join()).not.toContain(CONTACT.contactPhone)
  })

  it('別的老師、學生不能改；學生不能建立；舊版本 CONFLICT；已下架不能改內容', async () => {
    const t = await newTeacher('案主乙')
    const other = await newTeacher('旁觀老師')
    const cohort = await newCohort()
    const s = await newStudent(cohort.id)
    const id = await createOpportunity(t)

    const byOther = await command.update(actor(other, ['teacher']), { ...input(), opportunityId: id, revision: 1 }, randomUUID())
    expect(byOther.ok ? 'ok' : byOther.code).toBe('FORBIDDEN')
    const byStudent = await command.create(actor(s.id, ['student']), { ...input(), publish: true }, randomUUID())
    expect(byStudent.ok ? 'ok' : byStudent.code).toBe('FORBIDDEN')
    const withdrawByOther = await command.withdraw(actor(other, ['teacher']), { opportunityId: id, revision: 1 }, randomUUID())
    expect(withdrawByOther.ok ? 'ok' : withdrawByOther.code).toBe('FORBIDDEN')

    const byAdmin = await command.update(adminActor(), { ...input({ department: '研發部' }), opportunityId: id, revision: 1 }, randomUUID())
    expect(byAdmin.ok).toBe(true)
    const stale = await command.update(actor(t, ['teacher']), { ...input(), opportunityId: id, revision: 1 }, randomUUID())
    expect(stale.ok ? 'ok' : stale.code).toBe('CONFLICT')

    await command.withdraw(actor(t, ['teacher']), { opportunityId: id, revision: 2 }, randomUUID())
    const editWithdrawn = await command.update(actor(t, ['teacher']), { ...input(), opportunityId: id, revision: 3 }, randomUUID())
    expect(editWithdrawn.ok ? 'ok' : editWithdrawn.message).toContain('先重新發布')
  })

  it('必填與格式：公司、部門、內容必填；Email、電話格式；長度上限', async () => {
    const t = await newTeacher('案主丙')
    const missing = await command.create(actor(t, ['teacher']), { ...input({ companyName: '  ' }), publish: true }, randomUUID())
    expect(missing.ok ? 'ok' : missing.details).toEqual({ field: 'companyName' })
    const badEmail = await command.create(actor(t, ['teacher']), { ...input({ contactEmail: 'nope' }), publish: true }, randomUUID())
    expect(badEmail.ok ? 'ok' : badEmail.details).toEqual({ field: 'contactEmail' })
    const tooLong = await command.create(actor(t, ['teacher']), { ...input({ content: 'x'.repeat(5001) }), publish: true }, randomUUID())
    expect(tooLong.ok ? 'ok' : tooLong.details).toEqual({ field: 'content' })
  })

  it('同一個請求編號重送只建立一次', async () => {
    const t = await newTeacher('案主丁')
    const requestId = randomUUID()
    const first = await command.create(actor(t, ['teacher']), { ...input({ companyName: '重送公司' }), publish: true }, requestId)
    const second = await command.create(actor(t, ['teacher']), { ...input({ companyName: '重送公司' }), publish: true }, requestId)
    expect(first.ok && second.ok && first.receipt.opportunityId === second.receipt.opportunityId).toBe(true)
    const count = await owner.sql(`select count(*) as n from industry_opportunities where company_name = '重送公司'`)
    expect(Number(count.rows[0]!.n)).toBe(1)
  })
})

describe('聯絡資訊只有案主與系辦看得到（6.2；查詢層擋）', () => {
  it('列表：任何人都拿不到私有欄位；訪客與待審帳號拿不到任何東西；草稿不在列表', async () => {
    const t = await newTeacher('案主戊')
    const cohort = await newCohort()
    const s = await newStudent(cohort.id)
    const published = await createOpportunity(t, { overrides: { companyName: '列表公司' } })
    const draft = await createOpportunity(t, { publish: false, overrides: { companyName: '草稿公司' } })

    for (const viewer of [actor(s.id, ['student']), actor(t, ['teacher']), adminActor()]) {
      const cards = await query.list(viewer)
      expect(cards.map((c) => c.id)).toContain(published)
      expect(cards.map((c) => c.id)).not.toContain(draft)
      const text = JSON.stringify(cards)
      for (const secret of Object.values(CONTACT)) expect(text).not.toContain(secret)
      expect(text).not.toContain('內部備註')
    }
    expect(await query.list(anonymous)).toEqual([])
    const pending: ResolvedActor = { ...actor(s.id, ['student']), status: 'pending' } as ResolvedActor
    expect(await query.list(pending)).toEqual([])
  })

  it('學生後台「產學合作」卡片（票 38）：只有已發布的案；草稿、已下架不在；每張卡只有公開欄位；別屆學生看到同一份', async () => {
    const t = await newTeacher('案主己')
    const cohortA = await newCohort()
    const cohortB = await newCohort()
    const s = await newStudent(cohortA.id)
    const other = await newStudent(cohortB.id)
    const published = await createOpportunity(t, { overrides: { companyName: '學生頁公司' } })
    const draft = await createOpportunity(t, { publish: false, overrides: { companyName: '學生頁草稿' } })
    const gone = await createOpportunity(t, { overrides: { companyName: '學生頁下架' } })
    const withdrawn = await command.withdraw(actor(t, ['teacher']), { opportunityId: gone, revision: await opportunityRevision(gone) }, randomUUID())
    expect(withdrawn.ok).toBe(true)

    const cards = await query.list(actor(s.id, ['student']))
    const ids = cards.map((c) => c.id)
    expect(ids).toContain(published)
    expect(ids).not.toContain(draft)
    expect(ids).not.toContain(gone)
    expect(cards.every((c) => c.status === 'published')).toBe(true)
    // 欄位白名單：多出任何欄位（聯絡資料、內部備註、原始內容）這裡就會紅。
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual(
        ['companyName', 'department', 'id', 'linkedGroupCount', 'ownerName', 'ownerUserId', 'publishedAt', 'status', 'summary'].sort(),
      )
    }
    const text = JSON.stringify(cards)
    for (const secret of Object.values(CONTACT)) expect(text).not.toContain(secret)
    expect(text).not.toContain('學生頁草稿')
    expect(text).not.toContain('學生頁下架')
    // 合作案不分屆：別屆學生看到的是同一份已發布清單。
    expect((await query.list(actor(other.id, ['student']))).map((c) => c.id)).toEqual(ids)
  })

  it('詳情：案主與系辦有 contact 與內部備註；其他老師、學生是 null 而且整個結果裡找不到那幾個值；訪客要登入', async () => {
    const t = await newTeacher('案主己')
    const other = await newTeacher('其他老師')
    const cohort = await newCohort()
    const s = await newStudent(cohort.id)
    const id = await createOpportunity(t)

    for (const manager of [actor(t, ['teacher']), adminActor()]) {
      const page = await query.open(manager, id)
      expect(page.access).toBe('visible')
      if (page.access !== 'visible') continue
      expect(page.opportunity.contact).toEqual(CONTACT)
      expect(page.opportunity.notesHtml).toContain('內部備註')
      expect(page.opportunity.canManage).toBe(true)
    }
    for (const viewer of [actor(other, ['teacher']), actor(s.id, ['student'])]) {
      const page = await query.open(viewer, id)
      expect(page.access).toBe('visible')
      if (page.access !== 'visible') continue
      expect(page.opportunity.contact).toBeNull()
      expect(page.opportunity.notesHtml).toBeNull()
      expect(page.opportunity.canManage).toBe(false)
      const text = JSON.stringify(page)
      for (const secret of Object.values(CONTACT)) expect(text).not.toContain(secret)
    }
    expect((await query.open(anonymous, id)).access).toBe('need_login')
  })

  it('備註選「登入者可見」時學生看得到；草稿對別人是 not_found（不透露存在）', async () => {
    const t = await newTeacher('案主庚')
    const cohort = await newCohort()
    const s = await newStudent(cohort.id)
    const open = await createOpportunity(t, { overrides: { notes: '歡迎大三同學', notesVisibility: 'signed_in' } })
    const page = await query.open(actor(s.id, ['student']), open)
    expect(page.access === 'visible' && page.opportunity.notesHtml).toContain('歡迎大三同學')

    const draft = await createOpportunity(t, { publish: false })
    expect((await query.open(actor(s.id, ['student']), draft)).access).toBe('not_found')
    expect((await query.open(actor(t, ['teacher']), draft)).access).toBe('visible')
  })

  it('內容若有 HTML 一律清洗：script、事件屬性、javascript: 連結都不會出來；純文字轉段落並逃逸', async () => {
    const t = await newTeacher('案主辛')
    const cohort = await newCohort()
    const s = await newStudent(cohort.id)
    const id = await createOpportunity(t, {
      overrides: {
        content: '<p onclick="steal()">需求<script>alert(1)</script></p><a href="javascript:alert(2)">點我</a><img src=x onerror=alert(3)>',
        requirements: '1 < 2 & 需要 "熱情"\n第二行',
      },
    })
    const page = await query.open(actor(s.id, ['student']), id)
    if (page.access !== 'visible') throw new Error('should be visible')
    const html = page.opportunity.contentHtml
    expect(html).toContain('需求')
    expect(html).not.toMatch(/<script|onclick|onerror|javascript:|<img/i)
    expect(page.opportunity.requirementsHtml).toBe('<p>1 &lt; 2 &amp; 需要 "熱情"<br />第二行</p>')
    // 列表摘要是純文字。
    const card = (await query.list(actor(s.id, ['student']))).find((c) => c.id === id)!
    expect(card.summary).not.toContain('<')
  })
})

describe('組別與合作案的連結（6.3、GRP-15、GRP-19）', () => {
  it('組長連結已發布的案；非組長、一般組、草稿、已下架都被拒；一案可多組', async () => {
    const t = await newTeacher('案主壬')
    const cohort = await newCohort()
    const g1 = await newGroup(cohort.id, 'G01', 'industry')
    const g2 = await newGroup(cohort.id, 'G02', 'industry')
    const general = await newGroup(cohort.id, 'G03', 'general')
    const c1 = await createOpportunity(t, { overrides: { companyName: 'C1 公司' } })
    const draft = await createOpportunity(t, { publish: false, overrides: { companyName: '草稿' } })

    const notLeader = await command.link(
      actor(g1.members[1]!.id, ['student']),
      { groupId: g1.id, revision: await revisionOf(g1.id), opportunityId: c1, reason: '' },
      randomUUID(),
    )
    expect(notLeader.ok ? 'ok' : notLeader.code).toBe('FORBIDDEN')
    const generalLink = await command.link(
      actor(general.leader.id, ['student']),
      { groupId: general.id, revision: await revisionOf(general.id), opportunityId: c1, reason: '' },
      randomUUID(),
    )
    expect(generalLink.ok ? 'ok' : generalLink.code).toBe('OPPORTUNITY_NOT_LINKABLE')
    const draftLink = await command.link(
      actor(g1.leader.id, ['student']),
      { groupId: g1.id, revision: await revisionOf(g1.id), opportunityId: draft, reason: '' },
      randomUUID(),
    )
    expect(draftLink.ok ? 'ok' : draftLink.message).toContain('找不到')

    const linked = await command.link(
      actor(g1.leader.id, ['student']),
      { groupId: g1.id, revision: await revisionOf(g1.id), opportunityId: c1, reason: '' },
      randomUUID(),
    )
    expect(linked.ok && linked.receipt.change).toBe('linked')
    const linked2 = await command.link(
      actor(g2.leader.id, ['student']),
      { groupId: g2.id, revision: await revisionOf(g2.id), opportunityId: c1, reason: '' },
      randomUUID(),
    )
    expect(linked2.ok).toBe(true)
    // 首次連結不在通知矩陣：事件沒有收件人。
    expect((await events('opportunity.linked', g1.id))[0]?.recipients).toEqual([])

    const page = await query.open(actor(t, ['teacher']), c1)
    expect(page.access === 'visible' && page.opportunity.linkedGroups.map((l) => l.groupCode)).toEqual(['G01', 'G02'])
    // 屆別帶名稱（系1）：畫面標「第 43 屆（115）・G01」，不只代碼。
    await owner.sql(`update cohorts set name = '第 43 屆' where id = (select cohort_id from groups where id = $1)`, [g1.id])
    const named = await query.open(actor(t, ['teacher']), c1)
    expect(named.access === 'visible' && named.opportunity.linkedGroups.map((l) => l.cohortName)).toEqual(['第 43 屆', '第 43 屆'])
    // 連結不讓案主成為主指導。
    const advisor = await owner.sql('select count(*) as n from advisor_assignments where group_id = $1', [g1.id])
    expect(Number(advisor.rows[0]!.n)).toBe(0)

    // 下架後不收新連結。
    const g4 = await newGroup(cohort.id, 'G04', 'industry')
    await command.withdraw(actor(t, ['teacher']), { opportunityId: c1, revision: await opportunityRevision(c1) }, randomUUID())
    const afterWithdraw = await command.link(
      actor(g4.leader.id, ['student']),
      { groupId: g4.id, revision: await revisionOf(g4.id), opportunityId: c1, reason: '' },
      randomUUID(),
    )
    expect(afterWithdraw.ok ? 'ok' : afterWithdraw.code).toBe('OPPORTUNITY_NOT_LINKABLE')
  })

  it('案主老師直接連結（TE-B3）：不必是指導老師、不發通知、稽核記老師；非案主老師被拒、已連別案 CONFLICT（AC-TE-39、AC-A-11～13）', async () => {
    const t1 = await newTeacher('別案案主')
    const t2 = await newTeacher('案主 T2')
    const t3 = await newTeacher('老師 T3')
    const cohort = await newCohort()
    const g1 = await newGroup(cohort.id, 'G01', 'industry')
    const g2 = await newGroup(cohort.id, 'G02', 'industry')
    const general = await newGroup(cohort.id, 'G03', 'general')
    const c0 = await createOpportunity(t1, { overrides: { companyName: '別案公司' } })
    const c1 = await createOpportunity(t2, { overrides: { companyName: 'C1 公司' } })
    const c2 = await createOpportunity(t3, { overrides: { companyName: 'C2 公司' } })
    await command.link(actor(g2.leader.id, ['student']), { groupId: g2.id, revision: await revisionOf(g2.id), opportunityId: c0, reason: '' }, randomUUID())

    // 對話框選項：只列未連案的產學組（組長名＋版本）；學生拿不到。
    const before = (await query.teacherLinkTargets(actor(t2, ['teacher']))).filter((o) => o.cohortCode === cohort.code)
    expect(before).toEqual([
      { groupId: g1.id, groupCode: 'G01', cohortCode: cohort.code, cohortName: cohort.code, leaderName: g1.leader.name, revision: await revisionOf(g1.id) },
    ])
    expect(await query.teacherLinkTargets(actor(g1.leader.id, ['student']))).toEqual([])

    // AC-A-12：T3 把 G01 連到 T2 的案 → FORBIDDEN。
    const byOther = await command.link(actor(t3, ['teacher']), { groupId: g1.id, revision: await revisionOf(g1.id), opportunityId: c1, reason: '' }, randomUUID())
    expect(byOther.ok ? 'ok' : [byOther.code, byOther.message]).toEqual(['FORBIDDEN', '只能把組別連到自己負責的合作案。'])
    // T2 連到不是自己的 C2 也一樣被拒。
    const toC2 = await command.link(actor(t2, ['teacher']), { groupId: g1.id, revision: await revisionOf(g1.id), opportunityId: c2, reason: '' }, randomUUID())
    expect(toC2.ok ? 'ok' : toC2.code).toBe('FORBIDDEN')
    // 一般組照樣不能連。
    const toGeneral = await command.link(
      actor(t2, ['teacher']),
      { groupId: general.id, revision: await revisionOf(general.id), opportunityId: c1, reason: '' },
      randomUUID(),
    )
    expect(toGeneral.ok ? 'ok' : toGeneral.code).toBe('OPPORTUNITY_NOT_LINKABLE')

    // AC-A-11／AC-TE-39：T2（不是 G01 指導老師）連到自己的 C1 → 成功、一筆連結、不發通知、稽核記老師。
    const linked = await command.link(actor(t2, ['teacher']), { groupId: g1.id, revision: await revisionOf(g1.id), opportunityId: c1, reason: '' }, randomUUID())
    expect(linked.ok && linked.receipt.change).toBe('linked')
    const links = await owner.sql('select opportunity_id, linked_by_user_id from opportunity_links where group_id = $1', [g1.id])
    expect(links.rows).toEqual([{ opportunity_id: c1, linked_by_user_id: t2 }])
    expect((await events('opportunity.linked', g1.id)).map((e) => e.recipients)).toEqual([[]])
    expect(await events('opportunity.switched', g1.id)).toEqual([])
    const audit = await owner.sql(`select actor_user_id, role from audit_events where action = 'opportunity.link' and target_id = $1`, [g1.id])
    expect(audit.rows).toEqual([{ actor_user_id: t2, role: 'teacher' }])
    const advisor = await owner.sql('select count(*) as n from advisor_assignments where group_id = $1', [g1.id])
    expect(Number(advisor.rows[0]!.n)).toBe(0)
    // 案主的管理列標出誰連的；連好之後 G01 不再是選項。
    const managed = (await query.manageList(actor(t2, ['teacher']))).find((o) => o.id === c1)!
    expect(managed.links.map((l) => [l.groupCode, l.linkedByName])).toEqual([['G01', '案主 T2']])
    expect((await query.teacherLinkTargets(actor(t2, ['teacher']))).filter((o) => o.cohortCode === cohort.code)).toEqual([])

    // AC-A-13：已連到別案的 G02 → CONFLICT（案主不能換案；換案只有組長／系辦）。
    const switching = await command.link(actor(t2, ['teacher']), { groupId: g2.id, revision: await revisionOf(g2.id), opportunityId: c1, reason: '更適合' }, randomUUID())
    expect(switching.ok ? 'ok' : [switching.code, switching.message]).toEqual(['CONFLICT', '這一組已連到別的合作案。'])
    const g2Links = await owner.sql('select opportunity_id from opportunity_links where group_id = $1 and valid_to is null', [g2.id])
    expect(g2Links.rows).toEqual([{ opportunity_id: c0 }])

    // 沒有組長、老師、系辦身分的帳號：用一句話講清楚誰可以。
    const nobody = await command.link(actor(t3, []), { groupId: g1.id, revision: await revisionOf(g1.id), opportunityId: c1, reason: '' }, randomUUID())
    expect(nobody.ok ? 'ok' : nobody.message).toBe('只有組長、合作案負責老師或系辦可以連結合作案。')

    // 封存屆別的組不能連。
    const archivedCohort = await newCohort()
    const g9 = await newGroup(archivedCohort.id, 'G09', 'industry')
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [archivedCohort.id])
    const archived = await command.link(actor(t2, ['teacher']), { groupId: g9.id, revision: await revisionOf(g9.id), opportunityId: c1, reason: '' }, randomUUID())
    expect(archived.ok ? 'ok' : archived.code).toBe('COHORT_ARCHIVED')
  })

  it('非案主老師連別人的案：組別已封存、已解散、不存在都先回 FORBIDDEN，不透露組別狀態（Review #568、AC-A-12）', async () => {
    const t2 = await newTeacher('案主 T2 守衛')
    const outsider = await newTeacher('老師 T3 守衛')
    const c1 = await createOpportunity(t2, { overrides: { companyName: '守衛順序公司' } })
    const draft = await createOpportunity(t2, { publish: false, overrides: { companyName: '守衛草稿' } })
    const cohort = await newCohort()
    const active = await newGroup(cohort.id, 'G71', 'industry')
    const dissolved = await newGroup(cohort.id, 'G72', 'industry')
    await owner.sql(`update groups set status = 'dissolved', dissolved_real_at = now(), dissolve_reason = '測試' where id = $1`, [dissolved.id])
    const archivedCohort = await newCohort()
    const archived = await newGroup(archivedCohort.id, 'G73', 'industry')
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [archivedCohort.id])

    const cases: [string, string, string][] = [
      ['active', active.id, c1],
      ['archived', archived.id, c1],
      ['dissolved', dissolved.id, c1],
      ['missing', randomUUID(), c1],
      ['draft', archived.id, draft],
      ['missing-opportunity', archived.id, randomUUID()],
    ]
    for (const [label, groupId, opportunityId] of cases) {
      const result = await command.link(actor(outsider, ['teacher']), { groupId, revision: 0, opportunityId, reason: '' }, randomUUID())
      expect(result.ok ? 'ok' : [label, result.code, result.message]).toEqual([label, 'FORBIDDEN', '只能把組別連到自己負責的合作案。'])
    }
    // 案主本人照常看到組別狀態（授權過了才講狀態）。
    const ownerArchived = await command.link(actor(t2, ['teacher']), { groupId: archived.id, revision: 0, opportunityId: c1, reason: '' }, randomUUID())
    expect(ownerArchived.ok ? 'ok' : ownerArchived.code).toBe('COHORT_ARCHIVED')
    const ownerDissolved = await command.link(actor(t2, ['teacher']), { groupId: dissolved.id, revision: 0, opportunityId: c1, reason: '' }, randomUUID())
    expect(ownerDissolved.ok ? 'ok' : ownerDissolved.code).toBe('GROUP_DISSOLVED')
    const ownerMissing = await command.link(actor(t2, ['teacher']), { groupId: randomUUID(), revision: 0, opportunityId: c1, reason: '' }, randomUUID())
    expect(ownerMissing.ok ? 'ok' : ownerMissing.code).toBe('VALIDATION_FAILED')
  })

  it('換案：理由選填（C3-05）、保留前後關係、通知全組與新舊兩位案主；舊畫面版本 CONFLICT', async () => {
    const t1 = await newTeacher('C1 案主')
    const t2 = await newTeacher('C2 案主')
    const cohort = await newCohort()
    const g = await newGroup(cohort.id, 'G01', 'industry')
    const c1 = await createOpportunity(t1, { overrides: { companyName: '甲公司' } })
    const c2 = await createOpportunity(t2, { overrides: { companyName: '乙公司' } })
    const leader = actor(g.leader.id, ['student'])
    await command.link(leader, { groupId: g.id, revision: await revisionOf(g.id), opportunityId: c1, reason: '' }, randomUUID())

    const staleRevision = (await revisionOf(g.id)) - 1
    const stale = await command.link(leader, { groupId: g.id, revision: staleRevision, opportunityId: c2, reason: '題目更適合' }, randomUUID())
    expect(stale.ok ? 'ok' : stale.code).toBe('CONFLICT')

    const switched = await command.link(
      leader,
      { groupId: g.id, revision: await revisionOf(g.id), opportunityId: c2, reason: '題目更適合' },
      randomUUID(),
    )
    expect(switched.ok && switched.receipt).toMatchObject({ change: 'switched', previousOpportunityName: '甲公司・資訊部' })

    const rows = await owner.sql(
      `select id, opportunity_id, valid_to, end_reason, previous_link_id from opportunity_links where group_id = $1 order by created_at, id`,
      [g.id],
    )
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows[0]!.end_reason).toBe('題目更適合')
    expect(rows.rows[1]!.previous_link_id).toBe(rows.rows[0]!.id)
    expect(rows.rows[1]!.valid_to).toBeNull()

    const notified = await events('opportunity.switched', g.id)
    expect(notified[0]!.recipients).toEqual([...g.members.map((m) => m.id), t1, t2].sort())
    expect(JSON.stringify(notified[0]!.payload)).not.toContain('題目更適合')

    // 組別歷程：學生看得到換案（不帶理由），管理員看得到理由。
    const view = await groupQuery.studentView(g.leader.id, cohort.id)
    const entry = view.group!.history.find((h) => h.kind === 'opportunity_linked' && h.previousOpportunityName)
    expect(entry).toMatchObject({ userName: '乙公司・資訊部', previousOpportunityName: '甲公司・資訊部', reason: null })
    const adminView = (await groupQuery.overview(cohort.id)).groups.find((x) => x.id === g.id)!
    expect(adminView.history.find((h) => h.kind === 'opportunity_linked' && h.previousOpportunityName)?.reason).toBe('題目更適合')
    expect(adminView.opportunity?.name).toBe('乙公司・資訊部')

    // 理由留空也能換案（C3-05）：舊連結的 end_reason 為 NULL 或空字串，ended_by_user_id 有值。
    const blank = await command.link(leader, { groupId: g.id, revision: await revisionOf(g.id), opportunityId: c1, reason: ' ' }, randomUUID())
    expect(blank.ok && blank.receipt).toMatchObject({ change: 'switched', previousOpportunityName: '乙公司・資訊部' })
    const ended = await owner.sql(
      `select end_reason, ended_by_user_id from opportunity_links where id = $1`,
      [rows.rows[1]!.id],
    )
    expect(ended.rows[0]!.ended_by_user_id).toBe(g.leader.id)
    expect(['', null]).toContain(ended.rows[0]!.end_reason)
  })

  it('案主解除（理由選填，C3-05）通知該組與案主；別的老師不能解除；下架保留關係、重新發布不恢復已解除的連結', async () => {
    const t = await newTeacher('案主癸')
    const other = await newTeacher('路人老師')
    const cohort = await newCohort()
    const g1 = await newGroup(cohort.id, 'G01', 'industry')
    const g2 = await newGroup(cohort.id, 'G02', 'industry')
    const outsider = await newStudent(cohort.id)
    const c = await createOpportunity(t)
    for (const g of [g1, g2]) {
      await command.link(actor(g.leader.id, ['student']), { groupId: g.id, revision: await revisionOf(g.id), opportunityId: c, reason: '' }, randomUUID())
    }
    const linkOf = async (groupId: string) =>
      String((await owner.sql('select id from opportunity_links where group_id = $1 and valid_to is null', [groupId])).rows[0]!.id)

    const before = await revisionOf(g1.id)
    const byOther = await command.unlink(actor(other, ['teacher']), { linkId: await linkOf(g1.id), reason: '不適合' }, randomUUID())
    expect(byOther.ok ? 'ok' : byOther.code).toBe('FORBIDDEN')
    // 權限先判：被拒的人不碰組別、連結也還在（PR #266 審查建議：鎖組別列移到權限檢查之後）。
    expect(await revisionOf(g1.id)).toBe(before)
    expect(await linkOf(g1.id)).toBeTruthy()
    const g1Link = await linkOf(g1.id)
    const unlinked = await command.unlink(actor(t, ['teacher']), { linkId: g1Link, reason: '' }, randomUUID())
    expect(unlinked.ok && unlinked.receipt.change).toBe('unlinked')
    const ended = (await owner.sql('select end_reason, ended_by_user_id from opportunity_links where id = $1', [g1Link])).rows[0]!
    expect(ended.ended_by_user_id).toBe(t)
    expect(['', null]).toContain(ended.end_reason)
    const notified = await events('opportunity.unlinked', g1.id)
    expect(notified[0]!.recipients).toEqual([...g1.members.map((m) => m.id), t].sort())

    // 下架：G2 的連結保留；G2 組員看得到原本已發布的內容並標示下架，其他學生看到下架說明。
    await command.withdraw(actor(t, ['teacher']), { opportunityId: c, revision: await opportunityRevision(c) }, randomUUID())
    const memberView = await query.open(actor(g2.members[2]!.id, ['student']), c)
    expect(memberView.access).toBe('withdrawn_linked')
    if (memberView.access === 'withdrawn_linked') expect(memberView.opportunity.contact).toBeNull()
    expect((await query.open(actor(outsider.id, ['student']), c)).access).toBe('withdrawn')
    expect((await query.list(actor(outsider.id, ['student']))).map((x) => x.id)).not.toContain(c)

    // 重新發布：列表恢復，G1 的連結不會回來。
    await command.publish(actor(t, ['teacher']), { opportunityId: c, revision: await opportunityRevision(c) }, randomUUID())
    const page = await query.open(adminActor(), c)
    expect(page.access === 'visible' && page.opportunity.linkedGroups.map((l) => l.groupCode)).toEqual(['G02'])
  })
})

describe('系辦新增合作案並指定負責老師（第三波 W11）', () => {
  it('純系辦帳號建立：案主是選的老師；那位老師的管理清單列出它；發布後登入者的列表看得到；稽核記系辦與負責老師', async () => {
    const t = await newTeacher('受指定老師')
    const cohort = await newCohort()
    const s = await newStudent(cohort.id)
    const created = await command.create(adminActor(), { ...input({ companyName: '系辦建的公司' }), publish: true, ownerTeacherUserId: t }, randomUUID())
    expect(created).toMatchObject({ ok: true, receipt: { action: 'created', status: 'published' } })
    const id = created.ok ? created.receipt.opportunityId : ''

    const row = await owner.sql('select owner_teacher_user_id, created_by_user_id from industry_opportunities where id = $1', [id])
    expect(row.rows[0]).toEqual({ owner_teacher_user_id: t, created_by_user_id: adminId })
    expect((await query.manageList(actor(t, ['teacher']))).map((o) => o.id)).toContain(id)
    const card = (await query.list(actor(s.id, ['student']))).find((o) => o.id === id)
    expect(card).toMatchObject({ ownerUserId: t, ownerName: '受指定老師' })
    // 負責老師（案主）看得到聯絡資訊。
    const ownerView = await query.open(actor(t, ['teacher']), id)
    expect(ownerView.access === 'visible' && ownerView.opportunity.contact?.contactEmail).toBe(CONTACT.contactEmail)

    const audit = await owner.sql(
      `select actor_user_id, role, payload->>'ownerTeacherUserId' as owner from audit_events
        where action = 'opportunity.create' and target_id = $1`,
      [id],
    )
    expect(audit.rows).toEqual([{ actor_user_id: adminId, role: 'admin', owner: t }])
  })

  it('系辦沒選負責老師、選的人不是老師或已停用：被拒並指出負責老師欄；都不留資料', async () => {
    const t = await newTeacher('停用老師')
    await owner.sql(`update users set status = 'disabled' where id = $1`, [t])
    const notTeacher = await newUser('不是老師')
    const before = Number((await owner.sql('select count(*) as n from industry_opportunities')).rows[0]!.n)
    for (const ownerTeacherUserId of ['', notTeacher, t, adminId, 'not-a-uuid']) {
      const result = await command.create(adminActor(), { ...input(), publish: true, ownerTeacherUserId }, randomUUID())
      expect(result.ok ? 'ok' : result.details).toEqual({ field: 'ownerTeacherUserId' })
    }
    expect(Number((await owner.sql('select count(*) as n from industry_opportunities')).rows[0]!.n)).toBe(before)
  })

  it('老師新增照舊（案主＝本人）；老師帶別人的 ID：FORBIDDEN；學生帶老師 ID：FORBIDDEN', async () => {
    const t = await newTeacher('自己建老師')
    const other = await newTeacher('別的老師')
    const cohort = await newCohort()
    const s = await newStudent(cohort.id)
    const own = await command.create(actor(t, ['teacher']), { ...input(), publish: false, ownerTeacherUserId: t }, randomUUID())
    expect(own.ok).toBe(true)
    if (own.ok) {
      const row = await owner.sql('select owner_teacher_user_id from industry_opportunities where id = $1', [own.receipt.opportunityId])
      expect(row.rows[0]!.owner_teacher_user_id).toBe(t)
    }
    const forOther = await command.create(actor(t, ['teacher']), { ...input(), publish: false, ownerTeacherUserId: other }, randomUUID())
    expect(forOther.ok ? 'ok' : forOther.code).toBe('FORBIDDEN')
    const byStudent = await command.create(actor(s.id, ['student']), { ...input(), publish: false, ownerTeacherUserId: t }, randomUUID())
    expect(byStudent.ok ? 'ok' : byStudent.code).toBe('FORBIDDEN')
  })
})

describe('刪除合作案（第三波 W11）', () => {
  it('已下架、沒連組別的可以刪：打刪除標記不刪列；列表、詳情、管理清單都不再有；留 opportunity.deleted 稽核；重送只做一次', async () => {
    const t = await newTeacher('刪除案主')
    const cohort = await newCohort()
    const s = await newStudent(cohort.id)
    const id = await createOpportunity(t)
    await command.withdraw(actor(t, ['teacher']), { opportunityId: id, revision: 1 }, randomUUID())

    const requestId = randomUUID()
    const deleted = await command.delete(adminActor(), { opportunityId: id, revision: 2 }, requestId)
    expect(deleted).toMatchObject({ ok: true, receipt: { action: 'deleted', name: '輔仁零售・資訊部' } })

    const row = await owner.sql('select status, deleted_at, deleted_by_user_id from industry_opportunities where id = $1', [id])
    expect(row.rows[0]).toMatchObject({ status: 'withdrawn', deleted_by_user_id: adminId })
    expect(row.rows[0]!.deleted_at).toBeInstanceOf(Date)
    expect((await query.manageList(adminActor())).map((o) => o.id)).not.toContain(id)
    expect((await query.manageList(actor(t, ['teacher']))).map((o) => o.id)).not.toContain(id)
    expect((await query.open(adminActor(), id)).access).toBe('not_found')
    expect((await query.open(actor(s.id, ['student']), id)).access).toBe('not_found')

    const audit = await owner.sql(
      `select payload->>'status' as status, payload->>'name' as name, payload->>'ownerTeacherUserId' as owner
         from audit_events where action = 'opportunity.deleted' and target_id = $1`,
      [id],
    )
    expect(audit.rows).toEqual([{ status: 'withdrawn', name: '輔仁零售・資訊部', owner: t }])

    expect(await command.delete(adminActor(), { opportunityId: id, revision: 2 }, requestId)).toMatchObject({ ok: true })
    expect(Number((await owner.sql(`select count(*) as n from audit_events where action = 'opportunity.deleted' and target_id = $1`, [id])).rows[0]!.n)).toBe(1)
  })

  it('草稿也可以刪；刪除後不能再發布、修改或刪第二次', async () => {
    const t = await newTeacher('草稿案主')
    const id = await createOpportunity(t, { publish: false })
    expect(await command.delete(adminActor(), { opportunityId: id, revision: 1 }, randomUUID())).toMatchObject({ ok: true })
    for (const result of [
      await command.publish(actor(t, ['teacher']), { opportunityId: id, revision: 2 }, randomUUID()),
      await command.update(adminActor(), { ...input(), opportunityId: id, revision: 2 }, randomUUID()),
      await command.delete(adminActor(), { opportunityId: id, revision: 2 }, randomUUID()),
    ]) {
      expect(result.ok ? 'ok' : result.message).toContain('找不到這個合作案')
    }
  })

  it('發布中的被擋並說明要先下架；連著組別的被擋並說明要先解除連結；解除後就能刪', async () => {
    const t = await newTeacher('連結案主')
    const cohort = await newCohort()
    const g = await newGroup(cohort.id, 'G07', 'industry')
    const id = await createOpportunity(t)

    const published = await command.delete(adminActor(), { opportunityId: id, revision: 1 }, randomUUID())
    expect(published.ok ? 'ok' : published.message).toContain('要先「下架」')

    await command.link(actor(g.leader.id, ['student']), { groupId: g.id, revision: await revisionOf(g.id), opportunityId: id, reason: '' }, randomUUID())
    await command.withdraw(actor(t, ['teacher']), { opportunityId: id, revision: await opportunityRevision(id) }, randomUUID())
    const linked = await command.delete(adminActor(), { opportunityId: id, revision: await opportunityRevision(id) }, randomUUID())
    expect(linked.ok ? 'ok' : linked.message).toContain('要先「解除」連結')
    expect(linked.ok ? '' : linked.message).toContain('G07')
    expect(Number((await owner.sql('select count(*) as n from industry_opportunities where id = $1 and deleted_at is not null', [id])).rows[0]!.n)).toBe(0)

    const link = String((await owner.sql('select id from opportunity_links where group_id = $1 and valid_to is null', [g.id])).rows[0]!.id)
    await command.unlink(adminActor(), { linkId: link, reason: '題目取消' }, randomUUID())
    expect(await command.delete(adminActor(), { opportunityId: id, revision: await opportunityRevision(id) }, randomUUID())).toMatchObject({ ok: true })
    // 已刪的案不能再被連結（當作不存在）。
    const relink = await command.link(
      actor(g.leader.id, ['student']),
      { groupId: g.id, revision: await revisionOf(g.id), opportunityId: id, reason: '' },
      randomUUID(),
    )
    expect(relink.ok ? 'ok' : relink.message).toContain('找不到這個合作案')
  })

  it('只有系辦能刪：案主老師、學生 FORBIDDEN；舊版本 CONFLICT', async () => {
    const t = await newTeacher('不能刪的案主')
    const cohort = await newCohort()
    const s = await newStudent(cohort.id)
    const id = await createOpportunity(t, { publish: false })
    for (const who of [actor(t, ['teacher']), actor(s.id, ['student'])]) {
      const result = await command.delete(who, { opportunityId: id, revision: 1 }, randomUUID())
      expect(result.ok ? 'ok' : result.code).toBe('FORBIDDEN')
    }
    expect(await command.delete(adminActor(), { opportunityId: id, revision: 0 }, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
  })
})

describe('組長改組別類型（5.3、GRP-14）', () => {
  it('成組期內、沒有主指導、沒有合作案：組長可以改，留稽核與歷程', async () => {
    const cohort = await newCohort()
    const g = await newGroup(cohort.id, 'G01', 'general')
    const result = await command.changeGroupType(
      actor(g.leader.id, ['student']),
      { groupId: g.id, revision: await revisionOf(g.id), groupType: 'industry', reason: '' },
      randomUUID(),
    )
    expect(result.ok && result.receipt).toMatchObject({ from: 'general', to: 'industry' })
    const view = await groupQuery.studentView(g.members[1]!.id, cohort.id)
    expect(view.group?.groupType).toBe('industry')
    expect(view.group?.history.find((h) => h.kind === 'type_changed')).toMatchObject({
      groupTypes: { from: 'general', to: 'industry' },
      userName: g.leader.name,
    })
    const panel = await query.leaderPanel(actor(g.leader.id, ['student']), cohort.id)
    expect(panel?.typeChangeBlockers).toEqual([])
  })

  it('階段還沒設定、成組期還沒開始：說明是哪一種，不說「成組期已結束」', async () => {
    const unconfigured = await newCohort()
    await owner.sql('delete from cohort_stages where cohort_id = $1', [unconfigured.id])
    const g1 = await newGroup(unconfigured.id, 'G01', 'general')
    const early = await newCohort(['2026-12-01', '2027-01-15'])
    const g2 = await newGroup(early.id, 'G01', 'general')
    for (const [cohort, g, blocker] of [
      [unconfigured, g1, '這一屆還沒設定分組期'],
      [early, g2, '分組期還沒開始'],
    ] as const) {
      const refused = await command.changeGroupType(
        actor(g.leader.id, ['student']),
        { groupId: g.id, revision: await revisionOf(g.id), groupType: 'industry', reason: '' },
        randomUUID(),
      )
      expect(refused.ok ? 'ok' : refused.message).toBe(`目前不能自己改組別類型（${blocker}）；請聯絡系辦處理。`)
      expect((await query.leaderPanel(actor(g.leader.id, ['student']), cohort.id))?.typeChangeBlockers).toEqual([blocker])
    }
  })

  it('非組長、有主指導、有合作案、成組期已過：組長不能改，說明是哪一條並請系辦處理', async () => {
    const t = await newTeacher('指導老師')
    const cohort = await newCohort()
    const g = await newGroup(cohort.id, 'G01', 'industry')

    const notLeader = await command.changeGroupType(
      actor(g.members[1]!.id, ['student']),
      { groupId: g.id, revision: await revisionOf(g.id), groupType: 'general', reason: '' },
      randomUUID(),
    )
    expect(notLeader.ok ? 'ok' : notLeader.code).toBe('FORBIDDEN')

    const c = await createOpportunity(t)
    await command.link(actor(g.leader.id, ['student']), { groupId: g.id, revision: await revisionOf(g.id), opportunityId: c, reason: '' }, randomUUID())
    await owner.sql(
      `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id)
       values (gen_random_uuid(), $1, $2, 'claim', $3, $2)`,
      [g.id, t, businessNow],
    )
    businessNow = new Date('2026-10-20T02:00:00Z')
    const blocked = await command.changeGroupType(
      actor(g.leader.id, ['student']),
      { groupId: g.id, revision: await revisionOf(g.id), groupType: 'general', reason: '' },
      randomUUID(),
    )
    expect(blocked.ok ? 'ok' : blocked.message).toBe('目前不能自己改組別類型（分組期已結束、已經有指導老師、已經連結合作案）；請聯絡系辦處理。')
    const panel = await query.leaderPanel(actor(g.leader.id, ['student']), cohort.id)
    expect(panel?.typeChangeBlockers).toEqual(['分組期已結束', '已經有指導老師', '已經連結合作案'])

    // 系辦處理：理由選填（C3-05，這裡留空），保留主指導與合作案連結（不靜默刪關聯）。
    const byAdmin = await command.changeGroupType(
      adminActor(),
      { groupId: g.id, revision: await revisionOf(g.id), groupType: 'general', reason: '' },
      randomUUID(),
    )
    expect(byAdmin.ok && byAdmin.receipt.keptRelations).toEqual(['指導老師 指導老師', '合作案「輔仁零售・資訊部」的連結'])
    const links = await owner.sql('select count(*) as n from opportunity_links where group_id = $1 and valid_to is null', [g.id])
    expect(Number(links.rows[0]!.n)).toBe(1)
  })

  it('屆別封存後唯讀', async () => {
    const cohort = await newCohort()
    const g = await newGroup(cohort.id, 'G01', 'general')
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohort.id])
    const result = await command.changeGroupType(
      adminActor(),
      { groupId: g.id, revision: await revisionOf(g.id), groupType: 'industry', reason: '補登' },
      randomUUID(),
    )
    expect(result.ok ? 'ok' : result.code).toBe('COHORT_ARCHIVED')
  })
})

describe('組別名單：登入信箱與匯出（5.5、GRP-16、C18）', () => {
  it('登入信箱只在管理員的查詢裡；學生與老師的查詢是 null', async () => {
    const cohort = await newCohort()
    const g = await newGroup(cohort.id, 'G01', 'general')
    const adminGroups = (await groupQuery.overview(cohort.id)).groups
    expect(adminGroups[0]!.members.map((m) => m.loginEmail).sort()).toEqual(g.members.map((m) => m.email).sort())
    const studentView = await groupQuery.studentView(g.leader.id, cohort.id)
    expect(studentView.group!.members.every((m) => m.loginEmail === null)).toBe(true)
    const teacherView = await groupQuery.cohortGroups(cohort.id)
    expect(teacherView[0]!.members.every((m) => m.loginEmail === null)).toBe(true)
  })

  it('CSV：每位組員一列、帶登入信箱、學號保留前導零、公式字首被保護；勾選只收本屆；非管理員被拒', async () => {
    const cohort = await newCohort()
    const other = await newCohort()
    const g1 = await newGroup(cohort.id, 'G01', 'industry')
    const g2 = await newGroup(cohort.id, 'G02', 'general', 2)
    const foreign = await newGroup(other.id, 'G01', 'general')
    await owner.sql(`update user_profiles set display_name = '=HYPERLINK("http://x")' where user_id = $1`, [g2.members[1]!.id])
    const exporter = new PgGroupRosterExporter({ query: groupQuery, audit: new PgAuditWriter(), pool: () => app })

    const byIds = await exporter.exportRoster(adminActor(), {
      cohortId: cohort.id,
      format: 'csv',
      selection: { kind: 'ids', groupIds: [g2.id, foreign.id] },
    })
    if (!byIds.ok) throw new Error(byIds.message)
    expect(byIds.receipt.groupCount).toBe(1)
    const csv = String(byIds.receipt.body)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).trim().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('"登入信箱"')
    expect(csv).toContain(`"${g2.members[0]!.studentNo}"`)
    expect(g2.members[0]!.studentNo.startsWith('0')).toBe(true)
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`)
    expect(csv).toContain(g2.members[1]!.email)
    expect(csv).not.toContain(foreign.members[0]!.email)
    expect(csv).not.toContain(g1.members[0]!.email)

    const byFilter = await exporter.exportRoster(adminActor(), {
      cohortId: cohort.id,
      format: 'csv',
      selection: { kind: 'filter', filter: normalizeRosterFilter({ type: 'industry' }) },
    })
    expect(byFilter.ok && byFilter.receipt).toMatchObject({ groupCount: 1, rowCount: 3 })

    const t = await newTeacher('匯出老師')
    for (const viewer of [actor(t, ['teacher']), actor(g1.leader.id, ['student'])]) {
      const denied = await exporter.exportRoster(viewer, { cohortId: cohort.id, format: 'csv', selection: { kind: 'ids', groupIds: [g1.id] } })
      expect(denied.ok ? 'ok' : denied.code).toBe('FORBIDDEN')
    }
    const audits = await owner.sql(`select payload from audit_events where action = 'group.export' and cohort_id = $1`, [cohort.id])
    expect(audits.rows).toHaveLength(2)
    expect(JSON.stringify(audits.rows)).not.toContain('@')
  })

  it('XLSX：解開是合法的工作表，學號與 = 開頭都是文字儲存格', async () => {
    const cohort = await newCohort()
    const g = await newGroup(cohort.id, 'G01', 'general', 2)
    await owner.sql(`update user_profiles set display_name = '=1+1 <壞>' where user_id = $1`, [g.members[1]!.id])
    const exporter = new PgGroupRosterExporter({ query: groupQuery, audit: new PgAuditWriter(), pool: () => app })
    const result = await exporter.exportRoster(adminActor(), {
      cohortId: cohort.id,
      format: 'xlsx',
      selection: { kind: 'filter', filter: normalizeRosterFilter({}) },
    })
    if (!result.ok) throw new Error(result.message)
    const files = unzipSync(result.receipt.body as Uint8Array)
    expect(Object.keys(files).sort()).toEqual(
      ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort(),
    )
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!)
    expect(sheet).not.toContain('<f>')
    expect(sheet).toContain(`<t xml:space="preserve">${g.members[0]!.studentNo}</t>`)
    expect(sheet).toContain('<t xml:space="preserve">=1+1 &lt;壞&gt;</t>')
    expect(sheet).toContain(g.members[1]!.email)
  })
})

describe('合作案選項查詢 linkOptions（AC-AD-34）', () => {
  // `linkOptions` 不分屆別：同檔其他案例種的已發布合作案都會被查到，所以這裡自己開一份 schema，裡面只有本案例種的六筆。
  let linkOwner: IsolatedDatabase
  let linkApp: Pool
  let linkAdminId: string
  let linkStudentId: string
  let linkTeacherId: string
  let calls: { text: string; values: unknown[] }[] = []
  let linkQuery: PgOpportunityQuery

  async function seedUser(name: string, role: 'admin' | 'teacher' | 'student', displayName?: string): Promise<string> {
    const row = await linkOwner.sql(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [name, `${role}-${randomUUID().slice(0, 8)}@fju.edu.tw`],
    )
    const id = String(row.rows[0]!.id)
    if (displayName) {
      await linkOwner.sql(
        `insert into user_profiles (user_id, display_name, name_normalized, contact_email, profile_completed_at)
         values ($1, $2, $2, $3, now())`,
        [id, displayName, `${id}@contact.example.com`],
      )
    }
    return id
  }

  async function seedOpportunity(companyName: string, status: 'draft' | 'published' | 'withdrawn', deleted = false) {
    await linkOwner.sql(
      `insert into industry_opportunities
         (id, owner_teacher_user_id, company_name, department, content, requirements, notes, address, contact_name,
          contact_phone, contact_email, status, published_business_at, withdrawn_business_at, created_by_kind, created_by_user_id,
          deleted_at, deleted_by_user_id)
       values (gen_random_uuid(), $1, $2, $3, '內容', '條件', '內部備註', '地址', '聯絡人', '02-0000-0000', 'secret@company.example.com',
               $4, case when $4 = 'draft' then null else now() end, case when $4 = 'withdrawn' then now() else null end, 'user', $1,
               case when $5 then now() else null end, case when $5 then $6::uuid else null end)`,
      [linkTeacherId, companyName, `${companyName}部`, status, deleted, linkAdminId],
    )
  }

  const linkActor = (userId: string, role: 'admin' | 'teacher' | 'student') => actor(userId, [role])

  beforeAll(async () => {
    linkOwner = await createIsolatedDatabase({ label: 'link_options', setup: migratedSchema })
    linkApp = await poolAsRole(linkOwner, 'fju_app')
    linkAdminId = await seedUser('A1', 'admin')
    linkStudentId = await seedUser('S1', 'student')
    linkTeacherId = await seedUser('t-account', 'teacher', '李老師')
    await seedOpportunity('甲', 'published')
    await seedOpportunity('丙', 'published')
    await seedOpportunity('戊', 'published')
    await seedOpportunity('草稿公司', 'draft')
    await seedOpportunity('下架公司', 'withdrawn')
    await seedOpportunity('已刪公司', 'withdrawn', true)
    const counted = {
      query: (text: string, values: unknown[]) => {
        calls.push({ text, values })
        return linkApp.query(text, values)
      },
    } as unknown as Pick<Pool, 'query'>
    linkQuery = new PgOpportunityQuery({ businessClock, reader: () => counted })
  })

  afterAll(async () => {
    await linkApp?.end()
    await linkOwner?.close()
  })

  async function options(who: ResolvedActor, opts?: Parameters<PgOpportunityQuery['linkOptions']>[1]) {
    calls = []
    const result = await linkQuery.linkOptions(who, opts)
    return { result, calls: [...calls] }
  }

  it('只回已發布、四個欄位、依公司名排序；可分頁、可搜尋、limit 夾到 200；學生回空陣列；一次一句 SQL', async () => {
    const admin = linkActor(linkAdminId, 'admin')
    const sorted = (
      await linkOwner.sql(`select company_name from industry_opportunities where company_name in ('甲', '丙', '戊') order by company_name`)
    ).rows.map((r) => String(r.company_name))

    const all = await options(admin)
    expect(all.result.map((o) => o.companyName)).toEqual(sorted)
    expect(all.calls).toHaveLength(1)
    for (const o of all.result) {
      expect(Object.keys(o).sort()).toEqual(['companyName', 'department', 'id', 'ownerName'])
      expect(o.department).toBe(`${o.companyName}部`)
      expect(o.ownerName).toBe('李老師')
    }
    expect(JSON.stringify(all.result)).not.toContain('secret@company.example.com')
    expect(all.calls[0]!.values).toContain(50)

    const firstPage = await options(admin, { limit: 2 })
    expect(firstPage.result.map((o) => o.companyName)).toEqual(sorted.slice(0, 2))
    expect(firstPage.calls).toHaveLength(1)

    const secondPage = await options(admin, { limit: 2, offset: 2 })
    expect(secondPage.result.map((o) => o.companyName)).toEqual(sorted.slice(2))
    expect(secondPage.calls).toHaveLength(1)

    const searched = await options(admin, { q: '甲' })
    expect(searched.result.map((o) => o.companyName)).toEqual(['甲'])
    expect(searched.calls).toHaveLength(1)
    // q 是參數、萬用字元被跳脫：搜「%」不會變成全部。
    expect((await options(admin, { q: '%' })).result).toEqual([])

    const capped = await options(admin, { limit: 1000 })
    expect(capped.result).toHaveLength(3)
    expect(capped.calls).toHaveLength(1)
    expect(capped.calls[0]!.values).toContain(200)
    expect(capped.calls[0]!.values).not.toContain(1000)
    expect((await options(admin, { limit: 0 })).calls[0]!.values).toContain(50)

    const teacher = await options(linkActor(linkTeacherId, 'teacher'))
    expect(teacher.result).toHaveLength(3)

    const student = await options(linkActor(linkStudentId, 'student'))
    expect(student.result).toEqual([])
    expect(student.calls).toHaveLength(0)
    expect((await options(anonymous)).result).toEqual([])
  })
})
