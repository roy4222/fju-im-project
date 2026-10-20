import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { ItemInput } from '@/application/items'
import type { SchemeStageInput } from '@/application/grading'
import type { Result } from '@/shared/result'
import { PgAccountCommand } from '@/infrastructure/accounts/account-command'
import { PgAccountDirectoryCommand } from '@/infrastructure/accounts/account-directory-command'
import { SessionRevocationExecutor } from '@/infrastructure/accounts/session-revocation'
import { PgRegistrationCommand } from '@/infrastructure/accounts/registration-command'
import { PgProfileEditCommand } from '@/infrastructure/accounts/pg-profile-edit'
import { PgRosterCommand } from '@/infrastructure/accounts/roster-command'
import { PgGroupImportCommand } from '@/infrastructure/groups/pg-group-import'
import { PgProfileCardCommand } from '@/infrastructure/accounts/profile-card-command'
import { PgCohortCommand, PgCohortStatusQuery } from '@/infrastructure/cohorts/pg-cohorts'
import { PgTimelineCommand } from '@/infrastructure/cohorts/pg-timeline'
import { PgGroupCommand, PgGroupQuery } from '@/infrastructure/groups/pg-groups'
import { PgAdvisorCommand } from '@/infrastructure/groups/pg-advisors'
import { PgOpportunityCommand } from '@/infrastructure/groups/pg-opportunities'
import { PgGradingCommand } from '@/infrastructure/grading/pg-grading'
import { PgGradebookQuery, PgGradingResultsCommand } from '@/infrastructure/grading/pg-grading-results'
import { PgGradingSettlementCommand } from '@/infrastructure/grading/pg-grade-settlements'
import { PgGradingStageSettingCommand } from '@/infrastructure/grading/pg-stage-settings'
import { PgGradeExporter } from '@/infrastructure/grading/pg-grade-export'
import { PgItemCommand } from '@/infrastructure/items/pg-items'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgTestNotificationCommand } from '@/infrastructure/notifications/pg-test-notification'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage, PgFileAdminCommand } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgSubmissionLateFlags } from '@/infrastructure/ops/submission-late-flags'
import { PgReminders } from '@/infrastructure/reminders/pg-reminders'
import { PgShowcaseCommand } from '@/infrastructure/showcase/pg-showcase'
import { PgSignoffCommand, PgSignoffQuery } from '@/infrastructure/signoff/pg-signoff'
import { PgConsentPublishHook } from '@/infrastructure/signoff/pg-consent-bridge'
import { PgResponsePresence } from '@/infrastructure/submissions/pg-response-presence'
import { PgSubmissionCommand, PgSubmissionQuery } from '@/infrastructure/submissions/pg-submissions'

/**
 * #715 / AC-55–56：經 application/index.ts 匯出的真命令，以 fju_app 執行。
 * 假設：封存拒絕寫入；鎖序決定送出結果；封存優先於重播、解封不延長截止。
 * 反證：錯誤碼不符、任一持久列變動、未實際等鎖、重播成功或逾期仍可送出。
 * 每列另跑 active 正例；準備資料、命令執行在 suite 的 beforeAll，並明確重設時鐘。
 * Review FIX：beforeEach 的錯誤也會被 it.fails 反轉；beforeAll 的錯誤必須讓整個 suite 失敗。
 * 拒絕與資料不變各一支測試、各一個 expect；已知漏擋／寫入缺陷分別標 it.fails，避免半套修補被掩蓋。
 * 全資料庫快照也含帳本、稽核、事件、到期工作、檔案與引用。
 * ⑤-12 ESCALATE 1 裁定：成果展示、榮譽為對外紀錄例外；D-08 匯出允許。
 * 盤點：rg 'export (interface|type) .*Command' application 與各模組 index.ts，再核對實作寫入點。
 * 全域設定、帳密／頭像、通知已讀、未綁屆別的產學題目及暫存 CSV 上傳不寫屆別工作資料。
 * 吃呼叫端 tx 的 signoff hook／EventPublisher 等由上層命令的同交易快照涵蓋；createForGroup 獨立列出。
 * 帳號停用的組長接任明訂略過封存屆（accounts/directory.ts、pg-groups.ts #leaderships）。
 * 新建屆別用於 fixture；unarchive 是 AC-56e 的明訂例外。
 * #715 主腦 10/21 04:30 裁定：六類維護操作也允許；下方以七列驗證（個資更正／移出分開）。
 * 本輪假設與反證：例外必須成功；未到期提案若改變、引用檔案若被刪、去識別化若破壞歷史，即推翻。
 */
let owner: IsolatedDatabase
let app: Pool
let root: string
let tables: string[]
let businessNow = new Date('2026-10-01T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow) }
let admin: ResolvedActor
let adminId: string
let sequence = 0
let commands: ReturnType<typeof makeCommands>

function receipt<T>(result: Result<T>) {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  return result.receipt
}

function actor(userId: string, role: 'admin' | 'teacher' | 'student', cohortId?: string): ResolvedActor {
  return { kind: 'authenticated', userId, roles: [role], status: 'active', mustChangePassword: false, loginMethod: 'password',
    cohortMemberships: cohortId ? [{ cohortId, role: 'student' }] : [] }
}

function makeCommands(pool: () => Pick<Pool, 'connect'> = () => app) {
  const common = { audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), events: new PgEventPublisher(), businessClock, pool }
  const files = new FsFileStorage({ root: () => root, environmentMaxBytes: () => 1024 * 1024,
    ticketSecret: () => 'c5-12-local-integration-ticket-secret', policies: {}, db: () => app })
  const dueWork = new PgDueWorkScheduler({ testKindsEnabled: false })
  const signoff = new PgSignoffCommand({ ...common, files })
  const consent = new PgConsentPublishHook({ ...common, signoff })
  const groups = new PgGroupCommand({ ...common, dueWork, signoff })
  return {
    cohorts: new PgCohortCommand(common), timeline: new PgTimelineCommand(common),
    groups, groupImport: new PgGroupImportCommand({ ...common, files, groups }),
    roster: new PgRosterCommand({ ...common, files, db: () => app, cohorts: new PgCohortStatusQuery(() => app) }),
    advisors: new PgAdvisorCommand({ ...common, files, signoff }), opportunities: new PgOpportunityCommand(common),
    grading: new PgGradingCommand(common), results: new PgGradingResultsCommand(common),
    settlements: new PgGradingSettlementCommand(common), stageSettings: new PgGradingStageSettingCommand(common),
    items: new PgItemCommand({ ...common, files, dueWork, responses: new PgResponsePresence(), consent }),
    submissions: new PgSubmissionCommand({ ...common, files }), signoff, consent,
    testNotification: new PgTestNotificationCommand({ ...common, enabled: true, reader: () => app }),
    showcase: new PgShowcaseCommand({ ...common, files }), reminders: new PgReminders({ ...common, reader: () => app }),
    fileAdmin: new PgFileAdminCommand({ ...common, db: () => app }),
    // 只替換外部 Better Auth 撤登入呼叫；去識別化與撤登入工作仍在隔離資料庫實跑。
    directory: new PgAccountDirectoryCommand({ ...common, db: () => app, leaders: groups,
      revocations: new SessionRevocationExecutor({ db: () => app, call: async () => undefined }) }),
    profile: new PgProfileCardCommand({ ...common, db: () => app }),
    // Better Auth 與寄信是外部邊界；只有新增學生兩列用此測試替身，屆別／身分／帳本仍走真 PostgreSQL。
    accounts: new PgAccountCommand({ ...common, db: () => app, sendSetupMail: async () => undefined, auth: {
      createUser: async (_headers, input) => {
        const userId = randomUUID()
        await owner.sql(`insert into users (id,name,email,email_verified,updated_at,status) values ($1,$2,$3,false,now(),'pending')`, [userId, input.name, input.email])
        return { userId }
      },
      setUserPassword: async () => { throw new Error('本案例不應更改密碼') },
      revokeUserSessions: async () => { throw new Error('本案例不應撤銷登入') },
    } }),
    profileEdit: new PgProfileEditCommand({ ...common, db: () => app }),
    registration: new PgRegistrationCommand({ ...common, db: () => app, cohorts: new PgCohortStatusQuery(() => app) }), files,
  }
}

async function user(role: 'admin' | 'teacher' | 'student', cohortId?: string) {
  const id = randomUUID()
  const name = `測試${++sequence}`
  const email = `c512-${sequence}@example.com`
  const studentNo = `412${String(sequence).padStart(6, '0')}`
  await owner.sql(`insert into users (id,name,email,email_verified,updated_at,status) values ($1,$2,$3,true,now(),'active')`, [id, name, email])
  await owner.sql(`insert into role_assignments (id,user_id,role,granted_by_user_id,granted_real_at) values (gen_random_uuid(),$1,$2,$1,now())`, [id, role])
  await owner.sql(`insert into user_profiles (user_id,display_name,name_normalized,student_no,cohort_id,contact_email)
    values ($1,$2,$2,$3,$4,$5)`, [id, name, role === 'student' ? studentNo : null, cohortId ?? null, email])
  if (cohortId) await owner.sql('insert into student_identities (cohort_id,student_no,user_id) values ($1,$2,$3)', [cohortId, studentNo, id])
  return { id, studentNo, email, actor: actor(id, role, cohortId) }
}

const SCHEDULE = { stages: [
  { name: '成組期', startDate: '2026-09-15' }, { name: '期中', startDate: '2026-11-01' },
  { name: '期末', startDate: '2027-01-10' }, { name: '成果', startDate: '2027-03-01' },
], yearEndDate: '2027-06-30' }
const ACTIVITY = { title: '發表會', description: '', startDate: '2026-12-20', endDate: '', allDay: false,
  startTime: '14:00', endTime: '16:00', audience: 'cohort_students' }
const STAGES: SchemeStageInput[] = [{ key: 's1', name: '系統驗收', weight: 100, items: [{ key: 'i1', name: '功能', type: 'number', max: 100, weight: 100 }] }]

async function scenario() {
  const code = `C512-${++sequence}`
  const cohortId = receipt(await commands.cohorts.create(admin, { code, name: code }, randomUUID())).cohortId
  receipt(await commands.timeline.saveSchedule(admin, cohortId, SCHEDULE, 1, randomUUID()))
  receipt(await commands.cohorts.activate(admin, cohortId, randomUUID()))
  receipt(await commands.cohorts.setGroupingSettings(admin, cohortId,
    { groupSizeMin: 2, groupSizeMax: 5, proposalDefaultDays: 7 }, await revision('cohorts', cohortId), randomUUID()))
  const student = await user('student', cohortId)
  const second = await user('student', cohortId)
  const spare = await user('student', cohortId)
  const teacher = await user('teacher')
  const groupId = randomUUID()
  await owner.sql(`insert into groups (id,cohort_id,code,group_type,established_real_at,established_business_at,created_by_kind)
    values ($1,$2,'G01','general',now(),$3,'system')`, [groupId, cohortId, businessNow])
  for (const member of [student, second]) {
    await owner.sql(`insert into group_memberships (id,group_id,cohort_id,user_id,valid_from,added_by_kind)
      values (gen_random_uuid(),$1,$2,$3,now()-interval '1 day','system')`, [groupId, cohortId, member.id])
  }
  await owner.sql(`insert into group_leaders (id,group_id,user_id,valid_from,changed_by_user_id)
    values (gen_random_uuid(),$1,$2,now()-interval '1 day',$3)`, [groupId, student.id, adminId])
  const stageId = String((await owner.sql('select id from cohort_stages where cohort_id=$1 and seq=1', [cohortId])).rows[0]!.id)
  return { cohortId, code, stageId, groupId, student, second, spare, teacher }
}
type Scenario = Awaited<ReturnType<typeof scenario>>

async function revision(table: 'cohorts' | 'groups' | 'managed_items' | 'project_events' | 'showcase_entries', id: string) {
  return Number((await owner.sql(`select revision from ${table} where id=$1`, [id])).rows[0]!.revision)
}
async function archive(s: { cohortId: string }) {
  receipt(await commands.cohorts.archive(admin, { cohortId: s.cohortId, reason: '年度完成' }, randomUUID()))
}
async function snapshot() {
  const state: Record<string, unknown> = {}
  for (const table of tables) {
    // 表名只來自 PostgreSQL catalog；jsonb 保留所有欄位與重複列，順序無關。
    const data = (await owner.sql(`select coalesce(jsonb_agg(row_data order by row_data::text),'[]'::jsonb) as data
      from (select to_jsonb(t) as row_data from "${owner.schemaName}"."${table}" t) rows`)).rows[0]!.data as unknown[]
    state[table] = { count: data.length, sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex') }
  }
  return state
}

function itemInput(s: Scenario, patch: Partial<ItemInput> = {}): ItemInput {
  return { cohortId: s.cohortId, placement: 'submission', title: '專題報告', summary: '', body: '請填寫', category: '',
    coverFileId: null, attachmentFileIds: [], audienceKind: 'cohort_students', groupIds: [], receiverUnit: 'individual',
    stageId: s.stageId, opensAt: '', dueAt: '2026-11-15T23:59',
    fields: [{ key: 'topic', type: 'text', label: '題目', required: true },
      { key: 'file', type: 'file', label: '附件', required: false, allowedTypes: ['pdf'], maxBytes: 1024 * 1024 }], ...patch }
}
async function item(s: Scenario, patch: Partial<ItemInput> = {}, publish = true) {
  const input = itemInput(s, patch)
  const created = receipt(await commands.items.create(admin, input, randomUUID()))
  if (publish) receipt(await commands.items.publish(admin, created.itemId, created.revision, { notify: false }, randomUUID()))
  return { itemId: created.itemId, input, revision: await revision('managed_items', created.itemId) }
}
async function assignment(s: Scenario) {
  const version = receipt(await commands.grading.createSchemeVersion(admin, { cohortId: s.cohortId, stages: STAGES }, randomUUID()))
  receipt(await commands.grading.publishScheme(admin, { versionId: version.versionId }, randomUUID()))
  receipt(await commands.grading.setRequirement(admin, { groupId: s.groupId, stageKey: 's1', requiredCount: 1, revision: 0 }, randomUUID()))
  return receipt(await commands.grading.assign(admin, { groupId: s.groupId, stageKey: 's1', teacherUserId: s.teacher.id }, randomUUID())).assignmentId
}
const scores = (assignmentId: string, value = '80') => ({ assignmentId, scores: { i1: value } })
async function signoffVersion(s: Scenario) {
  receipt(await commands.advisors.assign(admin, { groupId: s.groupId, revision: await revision('groups', s.groupId),
    teacherUserId: s.teacher.id, reason: '', gradingSelections: [] }, randomUUID()))
  return receipt(await commands.signoff.createVersion(admin, { groupId: s.groupId, purpose: 'result_confirmation', content: '同意專題進度',
    attachmentFileIds: [], showcaseEntryId: null }, randomUUID()))
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'c512-readonly', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await mkdtemp('/tmp/rv-c5-12-files-')
  commands = makeCommands()
  const administrator = await user('admin')
  adminId = administrator.id
  admin = administrator.actor
  tables = (await owner.sql(`select tablename from pg_tables where schemaname=current_schema() order by tablename`)).rows.map(r => String(r.tablename))
  expect(tables).toContain('operation_records')
  expect(tables.length).toBeGreaterThanOrEqual(72)
})
beforeEach(() => { businessNow = new Date('2026-10-01T02:00:00Z') })
afterAll(async () => {
  await app?.end()
  await owner?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

type Run = () => Promise<Result<unknown>>
type DenialCase = { name: string; prepare: (s: Scenario) => Promise<Run>; code?: string; issue?: string; writesWhenArchived?: boolean; activeReceipt?: object; refusal?: object }
const direct = (name: string, run: (s: Scenario) => ReturnType<Run>): DenialCase => ({ name, prepare: async s => () => run(s) })

async function uploadCsv(text: string) {
  const bytes = new TextEncoder().encode(text)
  const uploaded = receipt(await commands.advisors.startBatchUpload(admin, { fileName: 'rows.csv', declaredMime: 'text/csv', declaredSize: bytes.length }))
  return receipt(await commands.files.upload(adminId, uploaded.ticket, new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } }), bytes.length)).fileId
}

const denied: DenialCase[] = [
  direct('CohortCommand.setDefaultWorking', s => commands.cohorts.setDefaultWorking(admin, s.cohortId, randomUUID())),
  direct('CohortCommand.setRegistrationOpen', s => commands.cohorts.setRegistrationOpen(admin, s.cohortId, randomUUID())),
  direct('CohortCommand.activate', s => commands.cohorts.activate(admin, s.cohortId, randomUUID())),
  { ...direct('CohortCommand.archive', s => commands.cohorts.archive(admin, { cohortId: s.cohortId, reason: '再次封存' }, randomUUID())), code: 'CONFLICT' },
  direct('CohortCommand.setGroupingSettings', async s => commands.cohorts.setGroupingSettings(admin, s.cohortId,
    { groupSizeMin: 3, groupSizeMax: 5, proposalDefaultDays: 8 }, await revision('cohorts', s.cohortId), randomUUID())),
  direct('TimelineCommand.saveSchedule', async s => commands.timeline.saveSchedule(admin, s.cohortId,
    { ...SCHEDULE, yearEndDate: '2027-07-01' }, await revision('cohorts', s.cohortId), randomUUID())),
  direct('TimelineCommand.createActivity', s => commands.timeline.createActivity(admin, s.cohortId, ACTIVITY, randomUUID())),
  ...(['updateActivity', 'moveActivity', 'cancelActivity', 'deleteActivity'] as const).map(name => ({ name: `TimelineCommand.${name}`,
    prepare: async (s: Scenario): Promise<Run> => {
      const { activityId } = receipt(await commands.timeline.createActivity(admin, s.cohortId, ACTIVITY, randomUUID()))
      const rev = await revision('project_events', activityId)
      return () => name === 'updateActivity' ? commands.timeline.updateActivity(admin, activityId, { ...ACTIVITY, title: '新名稱' }, rev, randomUUID())
        : name === 'moveActivity' ? commands.timeline.moveActivity(admin, activityId, { startDate: '2026-12-21', endDate: '' }, rev, randomUUID())
          : commands.timeline[name](admin, activityId, rev, randomUUID())
    } })),
  direct('ProfileCardCommand.save', s => commands.profile.save(s.spare.actor, { bio: '自我介紹', skills: ['後端'], contactEmail: s.spare.email, openToJoin: true, revision: 1 }, randomUUID())),
  direct('GroupCommand.setOpenToJoin', s => commands.groups.setOpenToJoin(s.spare.actor, true, randomUUID())),
  ...(['saveDraft', 'submit', 'requestUpload', 'setAdvisorVisibility', 'reopen', 'setExempt'] as const).map(name => ({ name: `SubmissionCommand.${name}`,
    prepare: async (s: Scenario): Promise<Run> => {
      const i = await item(s)
      if (name === 'submit') receipt(await commands.submissions.saveDraft(s.student.actor, i.itemId, 0, { topic: '報告' }, randomUUID()))
      if (name === 'reopen') businessNow = new Date('2026-12-01T00:00:00Z')
      return () => {
        if (name === 'saveDraft') return commands.submissions.saveDraft(s.student.actor, i.itemId, 0, { topic: '報告' }, randomUUID())
        if (name === 'submit') return commands.submissions.submit(s.student.actor, i.itemId, 1, randomUUID())
        if (name === 'requestUpload') return commands.submissions.requestUpload(s.student.actor, i.itemId, 'file', { fileName: 'report.pdf', declaredMime: 'application/pdf', declaredSize: 100 })
        if (name === 'setAdvisorVisibility') return commands.submissions.setAdvisorVisibility(admin, i.itemId, true, randomUUID())
        if (name === 'reopen') return commands.submissions.reopen(admin, i.itemId, s.student.id, { dueAt: '2026-12-10T23:59' }, randomUUID())
        return commands.submissions.setExempt(admin, { itemId: i.itemId, receiverId: s.student.id, exempt: true }, randomUUID())
      }
    } })),
  ...(['propose', 'confirm', 'decline', 'withdrawConfirmation', 'withdrawProposal', 'voidProposal'] as const).map(name => ({
    name: `GroupCommand.${name}`, prepare: async (s: Scenario): Promise<Run> => {
      const invited = await user('student', s.cohortId)
      const input = { groupType: 'general', memberStudentNos: [invited.studentNo] }
      if (name === 'propose') return () => commands.groups.propose(s.spare.actor, input, randomUUID())
      const { proposalId } = receipt(await commands.groups.propose(s.spare.actor, input, randomUUID()))
      if (name === 'withdrawConfirmation') receipt(await commands.groups.confirm(invited.actor, proposalId, randomUUID()))
      return () => name === 'voidProposal' ? commands.groups.voidProposal(admin, proposalId, '結束提案', randomUUID())
        : commands.groups[name](name === 'withdrawProposal' ? s.spare.actor : invited.actor, proposalId, randomUUID())
    },
  })),
  direct('GroupCommand.addMember', async s => commands.groups.addMember(admin, { groupId: s.groupId, revision: await revision('groups', s.groupId), studentNo: s.spare.studentNo, reason: '' }, randomUUID())),
  direct('GroupCommand.removeMember', async s => commands.groups.removeMember(admin, { groupId: s.groupId, revision: await revision('groups', s.groupId), userId: s.second.id, successorLeaderUserId: null, reason: '' }, randomUUID())),
  direct('GroupCommand.changeLeader', async s => commands.groups.changeLeader(admin, { groupId: s.groupId, revision: await revision('groups', s.groupId), newLeaderUserId: s.second.id, reason: '' }, randomUUID())),
  direct('GroupCommand.dissolveGroup', async s => commands.groups.dissolveGroup(admin, { groupId: s.groupId, revision: await revision('groups', s.groupId), reason: '' }, randomUUID())),
  direct('AdvisorCommand.assign', async s => commands.advisors.assign(admin, { groupId: s.groupId, revision: await revision('groups', s.groupId), teacherUserId: s.teacher.id, reason: '', gradingSelections: [] }, randomUUID())),
  { name: 'AdvisorCommand.unassign', prepare: async s => {
    receipt(await commands.advisors.assign(admin, { groupId: s.groupId, revision: await revision('groups', s.groupId), teacherUserId: s.teacher.id, reason: '', gradingSelections: [] }, randomUUID()))
    return async () => commands.advisors.unassign(admin, { groupId: s.groupId, revision: await revision('groups', s.groupId), reason: '' }, randomUUID())
  } },
  ...(['link', 'request', 'unlink', 'decline', 'claim'] as const).map(name => ({ name: name === 'claim' ? 'AdvisorCommand.claim' : `OpportunityCommand.${name}`,
    prepare: async (s: Scenario): Promise<Run> => {
      receipt(await commands.opportunities.changeGroupType(admin, { groupId: s.groupId, revision: 1, groupType: 'industry', reason: '' }, randomUUID()))
      const opportunityId = receipt(await commands.opportunities.create(s.teacher.actor, { companyName: '合作公司', department: '研發部', content: '研究題目', requirements: '', notes: '', notesVisibility: 'internal', address: '', contactName: '', contactPhone: '', contactEmail: '', publish: true }, randomUUID())).opportunityId
      let linkId = ''
      if (name === 'unlink' || name === 'decline' || name === 'claim') {
        receipt(await commands.opportunities.request(s.student.actor, { groupId: s.groupId, revision: await revision('groups', s.groupId), opportunityId }, randomUUID()))
        linkId = String((await owner.sql('select id from opportunity_links where group_id=$1 and valid_to is null', [s.groupId])).rows[0]!.id)
      }
      return async () => {
        if (name === 'claim') return commands.advisors.claim(s.teacher.actor, { groupId: s.groupId }, randomUUID())
        if (name === 'decline') return commands.opportunities.decline(s.teacher.actor, { groupId: s.groupId, reason: '' }, randomUUID())
        if (name === 'unlink') return commands.opportunities.unlink(admin, { linkId, reason: '' }, randomUUID())
        const input = { groupId: s.groupId, revision: await revision('groups', s.groupId), opportunityId, reason: '' }
        return commands.opportunities[name](name === 'request' ? s.student.actor : admin, input, randomUUID())
      }
    },
  })),
  direct('OpportunityCommand.changeGroupType', async s => commands.opportunities.changeGroupType(admin, { groupId: s.groupId, revision: await revision('groups', s.groupId), groupType: 'industry', reason: '' }, randomUUID())),
  ...(['news', 'submission', 'rules', 'resource'] as const).map(placement => direct(`ItemCommand.create/${placement}`, s => commands.items.create(admin,
    itemInput(s, placement === 'submission' ? {} : { placement, audienceKind: 'public', receiverUnit: 'none', fields: [], dueAt: '' }), randomUUID()))),
  ...(['saveDraft', 'publish', 'updatePublished', 'withdraw', 'archive', 'republish', 'delete', 'setPinned'] as const).map(name => ({ name: `ItemCommand.${['withdraw', 'archive', 'republish'].includes(name) ? `changeStatus/${name}` : name}`,
    prepare: async (s: Scenario): Promise<Run> => {
      const i = await item(s, { placement: 'news', audienceKind: 'public', receiverUnit: 'none', fields: [], dueAt: '' }, !['saveDraft', 'publish', 'delete'].includes(name))
      if (name === 'republish') receipt(await commands.items.changeStatus(admin, i.itemId, i.revision, 'archive', randomUUID()))
      const rev = await revision('managed_items', i.itemId)
      return () => {
        if (name === 'saveDraft') return commands.items.saveDraft(admin, i.itemId, rev, { ...i.input, title: '新標題' }, randomUUID())
        if (name === 'publish') return commands.items.publish(admin, i.itemId, rev, { notify: true }, randomUUID())
        if (name === 'updatePublished') return commands.items.updatePublished(admin, i.itemId, rev, { ...i.input, title: '新標題' }, { notify: true }, randomUUID())
        if (name === 'delete') return commands.items.delete(admin, i.itemId, rev, randomUUID())
        if (name === 'setPinned') return commands.items.setPinned(admin, i.itemId, true, randomUUID())
        return commands.items.changeStatus(admin, i.itemId, rev, name, randomUUID())
      }
    },
  })),
  ...(['moveRule', 'reorderRules'] as const).map(name => ({ name: `ItemCommand.${name}`, prepare: async (s: Scenario): Promise<Run> => {
    const patch = { placement: 'rules', audienceKind: 'public', receiverUnit: 'none', fields: [], dueAt: '' } as const
    const first = await item(s, { ...patch, fields: [] })
    const second = await item(s, { ...patch, fields: [], title: '規則二' })
    return () => name === 'moveRule' ? commands.items.moveRule(admin, first.itemId, 'down', randomUUID())
      : commands.items.reorderRules(admin, s.cohortId, [second.itemId, first.itemId], randomUUID())
  } })),
  direct('ItemCommand.startUpload', s => commands.items.startUpload(admin, { cohortId: s.cohortId, placement: 'news', kind: 'attachment', fileName: 'report.pdf', declaredMime: 'application/pdf', declaredSize: 100 })),
  { name: 'FileStorage.upload/preArchiveTicket', issue: '#792 F4：封存前憑證仍可完成上傳', writesWhenArchived: true, prepare: async s => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n% 封存前取得憑證的工作附件\n')
    const ticket = receipt(await commands.items.startUpload(admin, { cohortId: s.cohortId, placement: 'news', kind: 'attachment',
      fileName: 'report.pdf', declaredMime: 'application/pdf', declaredSize: bytes.length }))
    return () => commands.files.upload(adminId, ticket.ticket,
      new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } }), bytes.length)
  } },
  ...(['fresh', 'replay'] as const).map(mode => ({ name: `ConsentPublishHook.createForGroup/${mode}`,
    ...(mode === 'replay' ? { issue: '#792 F5：補建同意書重播漏擋' } : {}),
    prepare: async (s: Scenario): Promise<Run> => {
      // 發布至少要有一組已指派老師。G02 正常建包，G01 無老師先跳過，之後才補建。
      const otherGroupId = randomUUID()
      await owner.sql(`insert into groups (id,cohort_id,code,group_type,established_real_at,established_business_at,created_by_kind)
        values ($1,$2,'G02','general',now(),$3,'system')`, [otherGroupId, s.cohortId, businessNow])
      await owner.sql(`insert into group_memberships (id,group_id,cohort_id,user_id,valid_from,added_by_kind)
        values (gen_random_uuid(),$1,$2,$3,now()-interval '1 day','system')`, [otherGroupId, s.cohortId, s.spare.id])
      receipt(await commands.advisors.assign(admin, { groupId: otherGroupId, revision: await revision('groups', otherGroupId),
        teacherUserId: s.teacher.id, reason: '', gradingSelections: [] }, randomUUID()))
      const i = await item(s, { receiverUnit: 'group', stageId: null, dueAt: '', fields: [],
        consentMode: 'form', consentPurpose: 'result_confirmation' })
      expect((await owner.sql('select group_id from signoff_packages where item_id=$1', [i.itemId])).rows)
        .toEqual([{ group_id: otherGroupId }])
      receipt(await commands.advisors.assign(admin, { groupId: s.groupId, revision: await revision('groups', s.groupId),
        teacherUserId: s.teacher.id, reason: '', gradingSelections: [] }, randomUUID()))
      const requestId = randomUUID()
      const run = () => commands.consent.createForGroup(admin, { itemId: i.itemId, groupId: s.groupId }, requestId)
      if (mode === 'replay') receipt(await run())
      return run
    },
  })),
  direct('GradingCommand.createSchemeVersion', s => commands.grading.createSchemeVersion(admin, { cohortId: s.cohortId, stages: STAGES }, randomUUID())),
  { name: 'GradingCommand.publishScheme', prepare: async s => {
    const { versionId } = receipt(await commands.grading.createSchemeVersion(admin, { cohortId: s.cohortId, stages: STAGES }, randomUUID()))
    return () => commands.grading.publishScheme(admin, { versionId }, randomUUID())
  } },
  ...(['setRequirement', 'assign', 'saveDraft', 'submitFinal'] as const).map(name => ({ name: `GradingCommand.${name}`, prepare: async (s: Scenario): Promise<Run> => {
    const id = await assignment(s)
    const anotherTeacher = await user('teacher')
    return () => name === 'setRequirement' ? commands.grading.setRequirement(admin, { groupId: s.groupId, stageKey: 's1', requiredCount: 2, revision: 1 }, randomUUID())
      : name === 'assign' ? commands.grading.assign(admin, { groupId: s.groupId, stageKey: 's1', teacherUserId: anotherTeacher.id }, randomUUID())
        : commands.grading[name](s.teacher.actor, scores(id), randomUUID())
  } })),
  { name: 'GradingStageSettingCommand.setStageSetting', prepare: async s => {
    await assignment(s)
    return () => commands.stageSettings.setStageSetting(admin, { cohortId: s.cohortId, stageKey: 's1', itemId: null, description: '評分說明', panelKey: null }, randomUUID())
  } },
  ...(['settleStage', 'releaseSettlement'] as const).map(name => ({ name: `GradingSettlementCommand.${name}`, prepare: async (s: Scenario): Promise<Run> => {
    await assignment(s)
    const input = { cohortId: s.cohortId, stageKey: 's1', reason: '' }
    if (name === 'settleStage') return () => commands.settlements.settleStage(admin, input, randomUUID())
    const { settlementId } = receipt(await commands.settlements.settleStage(admin, input, randomUUID()))
    return () => commands.settlements.releaseSettlement(admin, { settlementId, reason: '' }, randomUUID())
  } })),
  ...(['returnEvaluation', 'removeAssignment', 'override', 'resolveReview', 'applySchemeVersion'] as const).map(name => ({ name: `GradingResultsCommand.${name}`, prepare: async (s: Scenario): Promise<Run> => {
    const id = await assignment(s)
    const query = new PgGradebookQuery(() => app)
    const evaluation = receipt(await commands.grading.submitFinal(s.teacher.actor, scores(id), randomUUID()))
    if (name === 'returnEvaluation') return () => commands.results.returnEvaluation(admin, { evaluationId: evaluation.evaluationId, reason: '請重評' }, randomUUID())
    if (name === 'removeAssignment') {
      const preview = receipt(await query.previewReassignment(admin, id))
      return () => commands.results.removeAssignment(admin, { assignmentId: id, choice: 'replace', newTeacherUserId: null, reason: '', basisHash: preview.basisHash }, randomUUID())
    }
    if (name === 'applySchemeVersion') {
      const { versionId } = receipt(await commands.grading.createSchemeVersion(admin, { cohortId: s.cohortId, stages: [{ ...STAGES[0]!, name: '新方案' }] }, randomUUID()))
      const { token } = receipt(await query.previewSchemeVersion(admin, versionId))
      return () => commands.results.applySchemeVersion(admin, { versionId, token }, randomUUID())
    }
    let detail = receipt(await query.groupDetail(admin, s.groupId))
    if (name === 'override') return () => commands.results.override(admin, { groupId: s.groupId, newValue: '85', reason: '', basisHash: detail.basisHash }, randomUUID())
    const { overrideId } = receipt(await commands.results.override(admin, { groupId: s.groupId, newValue: '85', reason: '', basisHash: detail.basisHash }, randomUUID()))
    receipt(await commands.results.returnEvaluation(admin, { evaluationId: evaluation.evaluationId, reason: '重評' }, randomUUID()))
    receipt(await commands.grading.submitFinal(s.teacher.actor, scores(id, '90'), randomUUID()))
    detail = receipt(await query.groupDetail(admin, s.groupId))
    return () => commands.results.resolveReview(admin, { overrideId, decision: 'keep', newValue: null, reason: '確認維持更正值', basisHash: detail.basisHash }, randomUUID())
  } })),
  ...(['createVersion', 'respond', 'reset', 'reopen', 'voidVersion', 'remind'] as const).map(name => ({ name: `SignoffCommand.${name}`, prepare: async (s: Scenario): Promise<Run> => {
    const version = await signoffVersion(s)
    if (name === 'reopen') receipt(await commands.signoff.voidVersion(admin, { versionId: version.versionId, reason: '' }, randomUUID()))
    const checksum = String((await owner.sql('select content_checksum from signoff_package_versions where id=$1', [version.versionId])).rows[0]!.content_checksum)
    return () => {
      if (name === 'createVersion') return commands.signoff.createVersion(admin, { groupId: s.groupId, purpose: 'result_confirmation', content: '更新內容', attachmentFileIds: [], showcaseEntryId: null }, randomUUID())
      if (name === 'respond') return commands.signoff.respond(s.student.actor, { versionId: version.versionId, contentChecksum: checksum, decision: 'agree' }, randomUUID())
      return commands.signoff[name](admin, { versionId: version.versionId, reason: '' }, randomUUID())
    }
  } })),
  ...(['remindItem', 'remindOverdue', 'remindGrading'] as const).map(name => ({ name: `ReminderCommand.${name}`, prepare: async (s: Scenario): Promise<Run> => {
    const i = await item(s)
    await assignment(s)
    businessNow = new Date('2026-12-01T00:00:00Z')
    return () => name === 'remindItem' ? commands.reminders.remindItem(admin, { itemId: i.itemId }, randomUUID())
      : commands.reminders[name](admin, { cohortId: s.cohortId }, randomUUID())
  } })),

  { name: 'AdvisorCommand.executeBatch', activeReceipt: { counts: { assigned: 1, reassigned: 0, conflict: 0, failed: 0 } }, prepare: async s => {
    const fileId = await uploadCsv(`group_code,teacher_login_email\nG01,${s.teacher.email}\n`)
    return () => commands.advisors.executeBatch(admin, { fileId, cohortId: s.cohortId, reason: '指派', confirmReassign: true, revisions: { [s.groupId]: 1 } }, randomUUID())
  } },
  { name: 'GroupImportCommand.execute', activeReceipt: { createdGroups: 1, added: 0, skipped: 0, failed: 0 }, prepare: async s => {
    const fileId = await uploadCsv(`student_no,group_code\n${s.spare.studentNo},G02\n`)
    return () => commands.groupImport.execute(admin, { fileId, cohortId: s.cohortId }, randomUUID())
  } },
  { name: 'RosterCommand.importRoster', code: 'VALIDATION_FAILED', prepare: async s => {
    const bytes = new TextEncoder().encode(`student_no,name,cohort,email\n499123456,測試學生,${s.code},roster@example.com\n`)
    const ticket = receipt(await commands.roster.startUpload(admin, { fileName: 'roster.csv', declaredMime: 'text/csv', declaredSize: bytes.length }))
    const { fileId } = receipt(await commands.files.upload(adminId, ticket.ticket, new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } }), bytes.length))
    return () => commands.roster.importRoster(admin, { fileId, cohortId: s.cohortId, requestId: randomUUID() })
  } },
  // createDraft 綁定在學組別；歷屆新增改走 createBackfill（既有 ports.ts 的區別）。
  direct('ShowcaseCommand.createDraft/group', s => commands.showcase.createDraft(admin, { groupId: s.groupId }, randomUUID())),

  { name: 'RegistrationCommand.approve', code: 'VALIDATION_FAILED', prepare: async s => {
    const userId = randomUUID()
    const applicationId = randomUUID()
    const email = `pending-${userId}@example.com`
    await owner.sql(`insert into users (id,name,email,email_verified,updated_at,status) values ($1,'待審學生',$2,true,now(),'pending')`, [userId, email])
    await owner.sql(`insert into registration_applications (id,user_id,applied_name,student_no,phone,contact_email,login_email,created_by_kind,created_by_user_id)
      values ($1,$2,'待審學生','499123457','0912345678',$3,$3,'user',$2)`, [applicationId, userId, email])
    return () => commands.registration.approve(admin, { applicationId, revision: 1, verificationMethod: 'office_review', verificationNote: '', reason: '', cohortId: s.cohortId, requestId: randomUUID() })
  } },
  { name: 'ProfileEditCommand.edit/moveIntoCohort', code: 'VALIDATION_FAILED', prepare: async s => {
    const other = await scenario()
    return () => commands.profileEdit.edit(admin, { userId: other.spare.id, name: '轉入學生', role: 'student', studentNo: other.spare.studentNo, cohortId: s.cohortId, requestId: randomUUID() })
  } },

  ...(['createStudent', 'createMember'] as const).map(name => ({ name: `AccountCommand.${name}/student`, issue: '#790 F3：新增學生漏擋', writesWhenArchived: true, prepare: async (s: Scenario): Promise<Run> => {
    const input = { kind: 'student', name: '系辦新增學生', email: `new-${randomUUID()}@example.com`, studentNo: '499123458', cohortId: s.cohortId, requestId: randomUUID() }
    return () => commands.accounts[name](admin, new Headers(), input)
  } })),
  { name: 'RegistrationCommand.approveMany', activeReceipt: { approved: [{ appliedName: '批次學生' }], skipped: [] },
    // registration-command.ts #match 排除封存屆的名單；批次 API 以逐筆略過回報既有 no_match 拒絕。
    refusal: { ok: true, receipt: { approved: [], skipped: [{ reason: '名單比對不到，請個別審核' }] } }, prepare: async s => {
    const userId = randomUUID()
    const applicationId = randomUUID()
    const email = `bulk-${userId}@example.com`
    const studentNo = `498${String(++sequence).padStart(6, '0')}`
    const bytes = new TextEncoder().encode(`student_no,name,cohort,email\n${studentNo},批次學生,${s.code},${email}\n`)
    const ticket = receipt(await commands.roster.startUpload(admin, { fileName: 'bulk.csv', declaredMime: 'text/csv', declaredSize: bytes.length }))
    const { fileId } = receipt(await commands.files.upload(adminId, ticket.ticket, new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } }), bytes.length))
    receipt(await commands.roster.importRoster(admin, { fileId, cohortId: s.cohortId, requestId: randomUUID() }))
    await owner.sql(`insert into users (id,name,email,email_verified,updated_at,status) values ($1,'批次學生',$2,true,now(),'pending')`, [userId, email])
    await owner.sql(`insert into registration_applications (id,user_id,applied_name,student_no,phone,contact_email,login_email,created_by_kind,created_by_user_id)
      values ($1,$2,'批次學生',$4,'0912345678',$3,$3,'user',$2)`, [applicationId, userId, email, studentNo])
    return () => commands.registration.approveMany(admin, { items: [{ applicationId, revision: 1, requestId: randomUUID() }], previewSkipped: [], verificationMethod: '', verificationNote: '', reason: '' })
  } },
  ...(['saveDraft', 'submit', 'requestUpload'] as const).map(name => ({ name: `SubmissionCommand.${name}/group`, prepare: async (s: Scenario): Promise<Run> => {
    const i = await item(s, { receiverUnit: 'group', audienceKind: 'groups', groupIds: [s.groupId] })
    if (name === 'submit') receipt(await commands.submissions.saveDraft(s.student.actor, i.itemId, 0, { topic: '整組報告' }, randomUUID()))
    return () => name === 'saveDraft' ? commands.submissions.saveDraft(s.student.actor, i.itemId, 0, { topic: '整組報告' }, randomUUID())
      : name === 'submit' ? commands.submissions.submit(s.student.actor, i.itemId, 1, randomUUID())
        : commands.submissions.requestUpload(s.student.actor, i.itemId, 'file', { fileName: 'group.pdf', declaredMime: 'application/pdf', declaredSize: 100 })
  } })),
  { name: 'GroupCommand.confirm/establish', prepare: async s => {
    const invited = await user('student', s.cohortId)
    const { proposalId } = receipt(await commands.groups.propose(s.spare.actor, { groupType: 'general', memberStudentNos: [invited.studentNo] }, randomUUID()))
    receipt(await commands.groups.confirm(s.spare.actor, proposalId, randomUUID()))
    return () => commands.groups.confirm(invited.actor, proposalId, randomUUID())
  } },

]

// 每個命令一個具名表格列；新增命令時在這裡加列，不能用空 UUID 或未授權角色代替封存守門。
describe.each(denied)('AC-55 應拒絕：$name', testCase => {
  it('進行中的對照案例（證明輸入與授權有效）', async () => {
    const s = await scenario()
    const run = await testCase.prepare(s)
    const result = await run()
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, ...(testCase.activeReceipt ? { receipt: testCase.activeReceipt } : {}) })
  })
  describe('已封存', () => {
    let result: Result<unknown>
    let before: Awaited<ReturnType<typeof snapshot>>
    let after: Awaited<ReturnType<typeof snapshot>>
    beforeAll(async () => {
      businessNow = new Date('2026-10-01T02:00:00Z')
      const s = await scenario()
      const run = await testCase.prepare(s)
      await archive(s)
      before = await snapshot()
      result = await run()
      after = await snapshot()
    })
    // 任一部分先修好，對應的 it.fails 必須翻紅；不能靠另一個尚未修好的斷言保持綠燈。
    const checkRefusal = testCase.issue ? it.fails : it
    checkRefusal(`${testCase.issue ?? 'AC-55'} 拒絕`, () => {
      expect(result).toMatchObject(testCase.refusal ?? { ok: false, code: testCase.code ?? 'COHORT_ARCHIVED' })
    })
    const checkData = testCase.issue && testCase.writesWhenArchived ? it.fails : it
    checkData(`${testCase.issue ?? 'AC-55'} 所有資料不變`, () => {
      expect(after).toEqual(before)
    })
  })
})

// 已明訂允許的對外紀錄；依⑤-12 ESCALATE 1、ShowcaseCommand 與規格① §4.5。
const allowed: DenialCase[] = [
  direct('ShowcaseCommand.createBackfill（ports.ts：屆別可以已封存）', s => commands.showcase.createBackfill(admin, { cohortId: s.cohortId, title: '歷屆作品' }, randomUUID())),
  ...(['updateDraft', 'requestPosterUpload', 'publish', 'publishUpdate', 'setHomePosition', 'withdraw', 'republish', 'setAward', 'delete'] as const).map(name => ({
    name: `ShowcaseCommand.${name}（ports.ts W15：系辦維護跨屆公開紀錄）`, prepare: async (s: Scenario): Promise<Run> => {
      const { entryId } = receipt(await commands.showcase.createBackfill(admin, { cohortId: s.cohortId, title: '歷屆作品' }, randomUUID()))
      if (['publishUpdate', 'withdraw', 'republish'].includes(name)) {
        receipt(await commands.showcase.publish(admin, { entryId, revision: 1, consent: true }, randomUUID()))
      }
      if (name === 'republish') receipt(await commands.showcase.withdraw(admin, { entryId, revision: await revision('showcase_entries', entryId) }, randomUUID()))
      if (name === 'publishUpdate') receipt(await commands.showcase.updateDraft(admin, { entryId, revision: 1, title: '修訂作品', summary: '', videoUrl: '', posterFileId: null }, randomUUID()))
      return async () => {
        const ref = { entryId, revision: await revision('showcase_entries', entryId) }
        if (name === 'updateDraft') return commands.showcase.updateDraft(admin, { entryId, revision: 1, title: '修訂作品', summary: '摘要', videoUrl: '', posterFileId: null }, randomUUID())
        if (name === 'requestPosterUpload') return commands.showcase.requestPosterUpload(admin, { entryId, fileName: 'poster.png', declaredMime: 'image/png', declaredSize: 100 })
        if (name === 'publish' || name === 'publishUpdate') return commands.showcase[name](admin, { ...ref, consent: true }, randomUUID())
        if (name === 'setHomePosition') return commands.showcase.setHomePosition(admin, { ...ref, position: 1 }, randomUUID())
        if (name === 'setAward') return commands.showcase.setAward(admin, { ...ref, level: 'excellent', label: '優秀專題' }, randomUUID())
        return commands.showcase[name](admin, ref, randomUUID())
      }
    },
  })),
  direct('ItemCommand.create/honor（規格① 設計方案 §4.5：封存仍可新增榮譽）', s => commands.items.create(admin,
    itemInput(s, { placement: 'honor', audienceKind: 'public', receiverUnit: 'none', fields: [], dueAt: '', title: '專題競賽佳作' }), randomUUID())),
]

describe.each(allowed)('AC-55 允許例外：$name', testCase => {
  it('封存後成功，留下對外紀錄或上傳憑證', async () => {
    const s = await scenario()
    const run = await testCase.prepare(s)
    await archive(s)
    const before = await snapshot()
    expect(await run()).toMatchObject({ ok: true })
    expect(await snapshot()).not.toEqual(before)
    expect((await new PgCohortStatusQuery(() => app).get(s.cohortId))?.status).toBe('archived')
  })
})

type MaintenanceCase = { name: string; basis: string; prepare: (s: Scenario) => Promise<() => Promise<void>> }

// 每列依據都加上 #715 主腦裁定；命令、檔案 IO 與歷史資料均實跑。
const maintenanceAllowed: MaintenanceCase[] = [
  { name: 'TestNotificationCommand.send',
    basis: 'notifications/pg-test-notification.ts：維運測試通知；#788 Review 1 主腦裁定封存後仍允許',
    prepare: async s => async () => {
      const requestId = randomUUID()
      const sent = receipt(await commands.testNotification.send(admin,
        { recipientUserId: s.student.id, cohortId: s.cohortId, title: '封存屆維運測試' }, requestId))
      expect((await owner.sql('select type,cohort_id,recipients,payload from domain_events where id=$1', [sent.eventId])).rows)
        .toEqual([{ type: 'test.notification', cohort_id: s.cohortId, recipients: [s.student.id], payload: { title: '封存屆維運測試' } }])
      expect((await owner.sql("select target_id from audit_events where action='notification.test.send' and cohort_id=$1", [s.cohortId])).rows)
        .toEqual([{ target_id: s.student.id }])
    },
  },
  { name: 'ItemCommand.startUpload + FileStorage.upload/honor',
    basis: '規格① 設計方案 §4.5、#715 例外裁定及 #788 Review 1：封存屆榮譽附件上傳允許',
    prepare: async s => async () => {
      const bytes = new TextEncoder().encode('%PDF-1.4\n% 榮譽獎狀\n')
      // #789：上傳開始帶榮譽位置，封存屆別照樣放行，並實際把檔案綁到榮譽。
      const ticket = receipt(await commands.items.startUpload(admin, { cohortId: s.cohortId, placement: 'honor', kind: 'attachment',
        fileName: 'award.pdf', declaredMime: 'application/pdf', declaredSize: bytes.length }))
      const stored = receipt(await commands.files.upload(adminId, ticket.ticket,
        new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } }), bytes.length))
      const honor = receipt(await commands.items.create(admin, itemInput(s, { placement: 'honor', audienceKind: 'public',
        receiverUnit: 'none', fields: [], dueAt: '', title: '專題競賽佳作', attachmentFileIds: [stored.fileId] }), randomUUID()))
      const file = (await owner.sql('select status,cohort_id,storage_key from stored_files where id=$1', [stored.fileId])).rows[0]!
      expect(file).toMatchObject({ status: 'stored', cohort_id: s.cohortId })
      expect(await readFile(join(root, String(file.storage_key)))).toEqual(Buffer.from(bytes))
      expect((await owner.sql('select file_id from item_attachments where item_id=$1', [honor.itemId])).rows)
        .toEqual([{ file_id: stored.fileId }])
      expect((await owner.sql('select released_at from file_references where file_id=$1', [stored.fileId])).rows)
        .toEqual([{ released_at: null }])
    },
  },
  ...(['sameCohort', 'moveOut'] as const).map(mode => ({
    name: `ProfileEditCommand.edit/${mode}`,
    basis: 'infrastructure/accounts/pg-profile-edit.ts edit、規格② §3.8／AC-C2-22：有效分組先移出；主腦裁定允許原屆更正與移出封存屆',
    prepare: async (s: Scenario) => {
      const targetCohortId = mode === 'moveOut' ? (await scenario()).cohortId : s.cohortId
      // 沿用 AC-C2-22 的調屆前置條件，封存前先結束組員關聯；歷史列必須保留。
      if (mode === 'moveOut') receipt(await commands.groups.removeMember(admin, { groupId: s.groupId,
        revision: await revision('groups', s.groupId), userId: s.second.id, successorLeaderUserId: null, reason: '下屆續修' }, randomUUID()))
      return async () => {
        if (mode === 'moveOut') {
          // 保留首輪找到的反例：仍有有效分組的組長不是可調屆的輸入，封存不取消此限制。
          const before = await snapshot()
          expect(await commands.profileEdit.edit(admin, { userId: s.student.id, name: '仍在組內', role: 'student',
            studentNo: s.student.studentNo, cohortId: targetCohortId, requestId: randomUUID() })).toMatchObject({ ok: false, code: 'CONFLICT', details: { field: 'cohortId' } })
          expect(await snapshot()).toEqual(before)
        }
        const memberships = (await owner.sql('select * from group_memberships where user_id=$1 order by id', [s.second.id])).rows
        expect(memberships).toHaveLength(1)
        expect(memberships[0]!.valid_to).toEqual(mode === 'moveOut' ? expect.any(Date) : null)
        expect(await commands.profileEdit.edit(admin, { userId: s.second.id, name: '更正後姓名', role: 'student',
          studentNo: s.second.studentNo, cohortId: targetCohortId, requestId: randomUUID() })).toMatchObject({ ok: true })
        expect((await owner.sql('select display_name,cohort_id from user_profiles where user_id=$1', [s.second.id])).rows)
          .toEqual([{ display_name: '更正後姓名', cohort_id: targetCohortId }])
        expect((await owner.sql('select cohort_id,student_no from student_identities where user_id=$1', [s.second.id])).rows)
          .toEqual([{ cohort_id: targetCohortId, student_no: s.second.studentNo }])
        expect((await owner.sql('select * from group_memberships where user_id=$1 order by id', [s.second.id])).rows).toEqual(memberships)
      }
    },
  })),
  { name: 'ProposalExpiryHandler.expire', basis: 'groups/pg-groups.ts #expireLocked：只終止到期 open 提案；主腦裁定允許背景收尾', prepare: async s => {
    const invited = await user('student', s.cohortId)
    const { proposalId } = receipt(await commands.groups.propose(s.spare.actor, { groupType: 'general', memberStudentNos: [invited.studentNo] }, randomUUID()))
    businessNow = new Date('2026-10-06T02:00:00Z')
    const later = await user('student', s.cohortId)
    const laterInvitee = await user('student', s.cohortId)
    const future = receipt(await commands.groups.propose(later.actor, { groupType: 'general', memberStudentNos: [laterInvitee.studentNo] }, randomUUID()))
    businessNow = new Date('2026-10-09T02:00:00Z')
    return async () => {
      const before = await snapshot()
      expect(await commands.groups.expire(future.proposalId, 1)).toBe('not_due')
      expect(await snapshot()).toEqual(before)
      const pending = (await owner.sql('select * from group_proposals where id=$1', [future.proposalId])).rows
      expect(pending).toMatchObject([{ state: 'open' }])
      expect(await commands.groups.expire(proposalId, 1)).toBe('expired')
      expect((await owner.sql('select state,termination_kind,closed_by_kind from group_proposals where id=$1', [proposalId])).rows)
        .toEqual([{ state: 'terminated', termination_kind: 'expired', closed_by_kind: 'worker' }])
      expect((await owner.sql('select * from proposal_occupancy where proposal_id=$1', [proposalId])).rows).toEqual([])
      expect((await owner.sql('select state from due_work where subject_id=$1', [proposalId])).rows).toEqual([{ state: 'cancelled' }])
      expect((await owner.sql('select * from group_proposals where id=$1', [future.proposalId])).rows).toEqual(pending)
      expect((await owner.sql('select * from proposal_occupancy where proposal_id=$1', [future.proposalId])).rows).toHaveLength(2)
      const after = await snapshot()
      expect(await commands.groups.expire(proposalId, 1)).toBe('not_open')
      expect(await snapshot()).toEqual(after)
    }
  } },
  { name: 'FileAdminCommand.deleteUnreferenced', basis: 'ops/files.ts FileAdminCommand、file-storage.ts：引用仍為 CONFLICT；主腦裁定允許維運清理', prepare: async s => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n% 歷史附件\n')
    const upload = async () => {
      const ticket = receipt(await commands.items.startUpload(admin, { cohortId: s.cohortId, placement: 'news', kind: 'attachment',
        fileName: 'history.pdf', declaredMime: 'application/pdf', declaredSize: bytes.length }))
      return receipt(await commands.files.upload(adminId, ticket.ticket,
        new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } }), bytes.length)).fileId
    }
    const unreferenced = await upload()
    const referenced = await upload()
    const history = await item(s, { placement: 'news', audienceKind: 'public', receiverUnit: 'none', fields: [], dueAt: '', attachmentFileIds: [referenced] })
    receipt(await commands.items.changeStatus(admin, history.itemId, history.revision, 'archive', randomUUID()))
    return async () => {
      const file = (await owner.sql('select * from stored_files where id=$1', [referenced])).rows[0]!
      const refs = (await owner.sql('select * from file_references where file_id=$1 order by id', [referenced])).rows
      expect(refs).toMatchObject([{ released_at: null }])
      expect(await commands.fileAdmin.deleteUnreferenced(admin, unreferenced, randomUUID())).toMatchObject({ ok: true, receipt: { fileId: unreferenced } })
      expect((await owner.sql('select status from stored_files where id=$1', [unreferenced])).rows).toEqual([{ status: 'soft_deleted' }])
      const beforeRefusal = await snapshot()
      expect(await commands.fileAdmin.deleteUnreferenced(admin, referenced, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
      expect(await snapshot()).toEqual(beforeRefusal)
      expect((await owner.sql('select * from stored_files where id=$1', [referenced])).rows).toEqual([file])
      expect((await owner.sql('select * from file_references where file_id=$1 order by id', [referenced])).rows).toEqual(refs)
      expect(await readFile(join(root, String(file.storage_key)))).toEqual(Buffer.from(bytes))
    }
  } },
  { name: 'AccountDirectoryCommand.deidentify', basis: 'accounts/directory.ts ACC-14：保留歷史業務關聯；主腦裁定允許個資處理', prepare: async s => {
    const i = await item(s)
    receipt(await commands.submissions.saveDraft(s.student.actor, i.itemId, 0, { topic: '保留的正式繳交' }, randomUUID()))
    receipt(await commands.submissions.submit(s.student.actor, i.itemId, 1, randomUUID()))
    const assignmentId = await assignment(s)
    receipt(await commands.grading.submitFinal(s.teacher.actor, scores(assignmentId), randomUUID()))
    const { versionId } = await signoffVersion(s)
    const checksum = String((await owner.sql('select content_checksum from signoff_package_versions where id=$1', [versionId])).rows[0]!.content_checksum)
    receipt(await commands.signoff.respond(s.student.actor, { versionId, contentChecksum: checksum, decision: 'agree' }, randomUUID()))
    receipt(await commands.signoff.voidVersion(admin, { versionId, reason: '保留已結束的歷史版本' }, randomUUID()))
    return async () => {
      const before = await snapshot()
      expect((await owner.sql('select id from submission_versions where submitted_by_user_id=$1', [s.student.id])).rows).toHaveLength(1)
      expect((await owner.sql('select id from approvals where user_id=$1', [s.student.id])).rows).toHaveLength(1)
      expect(await commands.directory.deidentify(admin, { userId: s.student.id, reason: '本人申請', confirmText: s.student.email,
        requestId: randomUUID() }, { headers: new Headers() })).toMatchObject({ ok: true, receipt: { userId: s.student.id } })
      expect((await owner.sql('select status,email,deidentified_at from users where id=$1', [s.student.id])).rows)
        .toEqual([{ status: 'disabled', email: `deidentified-${s.student.id}@deidentified.invalid`, deidentified_at: expect.any(Date) }])
      expect((await owner.sql('select student_no,phone,contact_email from user_profiles where user_id=$1', [s.student.id])).rows)
        .toEqual([{ student_no: null, phone: null, contact_email: `deidentified-${s.student.id}@deidentified.invalid` }])
      const after = await snapshot()
      for (const table of ['groups', 'group_memberships', 'group_leaders', 'submission_versions', 'evaluator_assignments', 'evaluations',
        'evaluation_status', 'signoff_packages', 'signoff_package_versions', 'signoff_version_status', 'approvals']) {
        expect(before).toHaveProperty(table)
        expect(after[table], table).toEqual(before[table])
      }
    }
  } },
  { name: 'ProfileCardCommand.save/unchangedOpenToJoin', basis: 'accounts/profile-card-command.ts save：只在找組開關變動時擋封存；主腦裁定允許本人簡介', prepare: async s => async () => {
    expect((await owner.sql('select open_to_join from user_profiles where user_id=$1', [s.spare.id])).rows).toEqual([{ open_to_join: false }])
    expect(await commands.profile.save(s.spare.actor, { bio: '更新本人簡介', skills: ['後端'], contactEmail: s.spare.email,
      openToJoin: false, revision: 1 }, randomUUID())).toMatchObject({ ok: true, receipt: { revision: 2 } })
    expect((await owner.sql('select bio,skills,open_to_join,revision from user_profiles where user_id=$1', [s.spare.id])).rows)
      .toEqual([{ bio: '更新本人簡介', skills: ['後端'], open_to_join: false, revision: 2 }])
  } },
  { name: 'ItemCommand.renameResourceCategory', basis: 'items/ports.ts renameResourceCategory：封存資源也改共用分類名；主腦裁定允許跨屆分類維護', prepare: async s => {
    const alsoArchived = await scenario()
    const active = await scenario()
    const from = `原分類-${s.code}`
    const to = `新分類-${s.code}`
    const items: Awaited<ReturnType<typeof item>>[] = []
    for (const cohort of [s, alsoArchived, active]) {
      items.push(await item(cohort, { placement: 'resource', audienceKind: 'public', receiverUnit: 'none', fields: [], dueAt: '', category: from }))
    }
    const untouched = await item(s, { placement: 'resource', audienceKind: 'public', receiverUnit: 'none', fields: [], dueAt: '', category: '其他分類' })
    await archive(alsoArchived)
    return async () => {
      const before = await snapshot()
      expect(await commands.items.renameResourceCategory(admin, { from, to, requestId: randomUUID() })).toMatchObject({ ok: true, receipt: { from, to, count: 3 } })
      for (const i of items) {
        expect((await owner.sql('select category,revision from managed_items where id=$1', [i.itemId])).rows)
          .toEqual([{ category: to, revision: i.revision + 1 }])
      }
      expect((await owner.sql('select category,revision from managed_items where id=$1', [untouched.itemId])).rows)
        .toEqual([{ category: '其他分類', revision: untouched.revision }])
      expect((await snapshot()).item_versions).toEqual(before.item_versions)
      expect((await new PgCohortStatusQuery(() => app).get(alsoArchived.cohortId))?.status).toBe('archived')
      expect((await new PgCohortStatusQuery(() => app).get(active.cohortId))?.status).toBe('active')
    }
  } },
]

describe.each(maintenanceAllowed)('AC-55 主腦已裁定例外：$name', testCase => {
  it(`#715 主腦裁定：${testCase.basis}`, async () => {
    const s = await scenario()
    const check = await testCase.prepare(s)
    await archive(s)
    const before = await snapshot()
    await check()
    expect(await snapshot()).not.toEqual(before)
    expect((await new PgCohortStatusQuery(() => app).get(s.cohortId))?.status).toBe('archived')
  })
})

/** 真連線攔截只加同步屏障，不替換 SQL、回傳值或守門。release 還原池內 client。 */
function heldPool(match: (sql: string) => boolean) {
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let signal!: () => void
  const arrived = new Promise<void>(resolve => { signal = resolve })
  let pid = 0
  let held = false
  return { release, arrived, pid: () => pid, pool: () => ({ connect: async () => {
    const client = await app.connect()
    pid = Number((await client.query('select pg_backend_pid() as pid')).rows[0].pid)
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>
    const originalRelease = client.release.bind(client)
    Object.assign(client, { query: async (...args: unknown[]) => {
      const value = await query(...args)
      if (!held && typeof args[0] === 'string' && match(args[0])) {
        held = true
        signal()
        await released
      }
      return value
    }, release: (error?: Error | boolean) => {
      Object.assign(client, { query, release: originalRelease })
      originalRelease(error)
    } })
    return client
  } }) }
}

async function waitFor<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('同步屏障未到達')), 5000) })])
  } finally { clearTimeout(timer) }
}
async function waitForBlockedBy(blocker: number) {
  // 觀察真正的資料庫鎖相依，不用 Promise.all 的排程先後猜測哪方先持鎖。
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const found = await owner.sql(`select pid from pg_stat_activity
      where datname=current_database() and $1::int=any(pg_blocking_pids(pid))`, [blocker])
    if (found.rows.length) return Number(found.rows[0]!.pid)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('沒有觀察到封存與送出的鎖等待')
}
async function preparedSubmission() {
  const s = await scenario()
  const i = await item(s)
  receipt(await commands.submissions.saveDraft(s.student.actor, i.itemId, 0, { topic: '正式專題' }, randomUUID()))
  return { ...s, itemId: i.itemId }
}
async function versionCount(itemId: string) {
  return Number((await owner.sql('select count(*)::int as n from submission_versions where item_id=$1', [itemId])).rows[0]!.n)
}

it('AC-56a：送出通過 active 守門並持 FOR SHARE，封存等待；送出 commit 後才封存', async () => {
  const s = await preparedSubmission()
  // submit 取草稿列在 #guard 之後，這個屏障證明已通過 active 檢查。
  const gate = heldPool(sql => /from submission_drafts/.test(sql))
  const submitting = makeCommands(gate.pool).submissions.submit(s.student.actor, s.itemId, 1, randomUUID())
  let archiving: ReturnType<typeof commands.cohorts.archive> | undefined
  try {
    await waitFor(gate.arrived)
    archiving = commands.cohorts.archive(admin, { cohortId: s.cohortId, reason: '年度完成' }, randomUUID())
    const waiter = await waitForBlockedBy(gate.pid())
    expect(waiter).not.toBe(gate.pid())
    expect(await versionCount(s.itemId)).toBe(0)
    gate.release()
    expect(await submitting).toMatchObject({ ok: true })
    expect(await archiving).toMatchObject({ ok: true })
    expect(await versionCount(s.itemId)).toBe(1)
    const times = await owner.sql(`select e.real_at > v.received_real_at as archived_after_submission
      from cohort_status_events e join submission_versions v on v.item_id=$2
      where e.cohort_id=$1 and e.to_status='archived'`, [s.cohortId, s.itemId])
    expect(times.rows).toEqual([{ archived_after_submission: true }])
  } finally {
    gate.release()
    await Promise.allSettled([submitting, ...(archiving ? [archiving] : [])])
  }
})

it('AC-56b：封存先持 FOR UPDATE，送出等待；封存 commit 後送出被拒、不多版本', async () => {
  const s = await preparedSubmission()
  const gate = heldPool(sql => /from cohorts.*for update/s.test(sql))
  const archiving = makeCommands(gate.pool).cohorts.archive(admin, { cohortId: s.cohortId, reason: '年度完成' }, randomUUID())
  let submitting: ReturnType<typeof commands.submissions.submit> | undefined
  try {
    await waitFor(gate.arrived)
    submitting = commands.submissions.submit(s.student.actor, s.itemId, 1, randomUUID())
    const waiter = await waitForBlockedBy(gate.pid())
    expect(waiter).not.toBe(gate.pid())
    gate.release()
    expect(await archiving).toMatchObject({ ok: true })
    expect(await submitting).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
    expect(await versionCount(s.itemId)).toBe(0)
  } finally {
    gate.release()
    await Promise.allSettled([archiving, ...(submitting ? [submitting] : [])])
  }
})

describe('AC-56c：封存前成功的 requestId 封存後重播', () => {
  let replay: Result<unknown>
  let before: Awaited<ReturnType<typeof snapshot>>
  let after: Awaited<ReturnType<typeof snapshot>>
  beforeAll(async () => {
    businessNow = new Date('2026-10-01T02:00:00Z')
    const s = await preparedSubmission()
    const requestId = randomUUID()
    receipt(await commands.submissions.submit(s.student.actor, s.itemId, 1, requestId))
    await archive(s)
    before = await snapshot()
    replay = await commands.submissions.submit(s.student.actor, s.itemId, 1, requestId)
    after = await snapshot()
  })
  it('#789 F2：重播應回 COHORT_ARCHIVED 而非原回執', () => {
    expect(replay).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
  })
  it('#789 F2：重播沒有增加 operation_records 或修改其他資料', () => {
    expect(after).toEqual(before)
  })
})

// 同一類（#789 主腦 ESCALATE 2）：存草稿與三個系辦動作，封存前成功的 requestId 封存後重播也要擋。
type ReplayCase = { name: string; prepare: (s: Scenario) => Promise<Run> }
const replays: ReplayCase[] = (['saveDraft', 'setAdvisorVisibility', 'reopen', 'setExempt'] as const).map(name => ({
  name: `SubmissionCommand.${name}`,
  prepare: async (s: Scenario): Promise<Run> => {
    const i = await item(s)
    if (name === 'reopen') businessNow = new Date('2026-12-01T00:00:00Z')
    const requestId = randomUUID()
    const run: Run = () => {
      if (name === 'saveDraft') return commands.submissions.saveDraft(s.student.actor, i.itemId, 0, { topic: '報告' }, requestId)
      if (name === 'setAdvisorVisibility') return commands.submissions.setAdvisorVisibility(admin, i.itemId, true, requestId)
      if (name === 'reopen') return commands.submissions.reopen(admin, i.itemId, s.student.id, { dueAt: '2026-12-10T23:59' }, requestId)
      return commands.submissions.setExempt(admin, { itemId: i.itemId, receiverId: s.student.id, exempt: true }, requestId)
    }
    receipt(await run())
    return run
  },
}))

describe.each(replays)('AC-56c：封存前成功的 requestId 封存後重播：$name', testCase => {
  let replay: Result<unknown>
  let before: Awaited<ReturnType<typeof snapshot>>
  let after: Awaited<ReturnType<typeof snapshot>>
  beforeAll(async () => {
    businessNow = new Date('2026-10-01T02:00:00Z')
    const s = await scenario()
    const run = await testCase.prepare(s)
    await archive(s)
    before = await snapshot()
    replay = await run()
    after = await snapshot()
  })
  it('#789：重播回 COHORT_ARCHIVED 而非原回執', () => {
    expect(replay).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
  })
  it('#789：重播沒有增加 operation_records 或修改其他資料', () => {
    expect(after).toEqual(before)
  })
})

it('AC-56d：封存後仍能讀組別、繳交歷史、成績表與簽核歷史', async () => {
  const s = await preparedSubmission()
  receipt(await commands.submissions.submit(s.student.actor, s.itemId, 1, randomUUID()))
  const assignmentId = await assignment(s)
  receipt(await commands.grading.submitFinal(s.teacher.actor, scores(assignmentId), randomUUID()))
  const version = await signoffVersion(s)
  const groups = new PgGroupQuery(() => app)
  const submissions = new PgSubmissionQuery(() => app, new PgSubmissionLateFlags(() => app))
  const gradebook = new PgGradebookQuery(() => app)
  const signoffs = new PgSignoffQuery({ pool: () => app })
  const read = async () => ({ group: await groups.studentView(s.student.id, s.cohortId),
    submission: await submissions.myVersion(s.student.id, s.itemId, 1),
    grades: receipt(await gradebook.gradebook(admin, s.cohortId)), signoff: receipt(await signoffs.versionDetail(admin, version.versionId)) })
  const before = await read()
  expect(before.submission).not.toBeNull()
  expect(before.group.group?.id).toBe(s.groupId)
  expect(before.grades.groups).toHaveLength(1)
  expect(before.grades.groups[0]!.result.finalExact).toBe('80')
  expect(before.signoff.history).toMatchObject([{ versionId: version.versionId }])
  expect(before.signoff.contentHtml).toContain('同意專題進度')
  await archive(s)
  const state = await snapshot()
  const after = await read()
  expect(after.submission).toEqual(before.submission)
  expect(after.group).toEqual(before.group)
  expect(after.grades.groups).toEqual(before.grades.groups)
  expect(after.signoff.history).toEqual(before.signoff.history)
  expect(after.signoff.contentHtml).toBe(before.signoff.contentHtml)
  expect(after.signoff.progress).toEqual(before.signoff.progress)
  expect(await snapshot()).toEqual(state)
})

it.each(['csv', 'xlsx'] as const)('AC-55 / AC-56d / D-08：封存後成績匯出 %s', async format => {
  const s = await scenario()
  const id = await assignment(s)
  receipt(await commands.grading.submitFinal(s.teacher.actor, scores(id), randomUUID()))
  await archive(s)
  const exporter = new PgGradeExporter({ query: new PgGradebookQuery(() => app), audit: new PgAuditWriter(), pool: () => app })
  const exported = receipt(await exporter.exportGrades(admin, { cohortId: s.cohortId, format, filter: { stageKey: 'all', groupId: 'all', status: 'all' } }))
  expect(exported.groupCount).toBe(1)
  expect(exported.rowCount).toBeGreaterThan(0)
  expect(exported.body.length).toBeGreaterThan(0)
  if (format === 'csv') expect(exported.body).toContain('80')
  expect((await owner.sql("select count(*)::int as n from audit_events where cohort_id=$1 and action='grading.export'", [s.cohortId])).rows[0]!.n).toBe(1)
})
it.each(['csv', 'printable'] as const)('AC-55 / AC-56d / D-08：封存後簽核匯出 %s', async format => {
  const s = await scenario()
  const { versionId } = await signoffVersion(s)
  await archive(s)
  const exported = receipt(await commands.signoff.exportVersion(admin, { versionId, format }))
  expect(exported.body).toContain('G01')
  expect((await owner.sql('select count(*)::int as n from signoff_exports where version_id=$1', [versionId])).rows[0]!.n).toBe(1)
})

it('AC-56e：既有 unarchive 解封後，逾期作業仍回 DEADLINE_PASSED', async () => {
  const s = await preparedSubmission()
  await archive(s)
  receipt(await commands.cohorts.unarchive(admin, { cohortId: s.cohortId, reason: '更正資料' }, randomUUID()))
  businessNow = new Date('2026-12-01T00:00:00Z')
  const before = await snapshot()
  expect(await commands.submissions.submit(s.student.actor, s.itemId, 1, randomUUID())).toMatchObject({ ok: false, code: 'DEADLINE_PASSED' })
  expect(await snapshot()).toEqual(before)
  expect(await versionCount(s.itemId)).toBe(0)
})
