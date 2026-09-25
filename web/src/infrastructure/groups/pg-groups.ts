import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import {
  groupingDeadline,
  stagePositionAt,
  type BusinessClockSource,
  type CohortSchedule,
  type CohortStatus,
} from '@/application/cohorts'
import {
  canViewTeammates,
  decideLeaderChange,
  decideRemoval,
  GROUP_TYPE_LABEL,
  groupSizeWarning,
  isUuid,
  nextGroupCode,
  normalizeProposeInput,
  normalizeReason,
  normalizeVoidReason,
  opportunityName,
  proposalExpiry,
  studentCohortOf,
  TERMINATION_KIND_LABEL,
  type AddMemberInput,
  type AdvisorSource,
  type ChangeLeaderInput,
  type CohortGroupingOverview,
  type ConfirmReceipt,
  type ExpireOutcome,
  type GroupCommand,
  type GroupHistoryEntry,
  type GroupQuery,
  type GroupSummary,
  type GroupType,
  type InvitationState,
  type LeaderChangeReceipt,
  type MemberChangeReceipt,
  type OpportunityStatus,
  type ProposalExpiryHandler,
  type ProposalState,
  type ProposalSummary,
  type ProposeInput,
  type ProposeReceipt,
  type RemoveMemberInput,
  type SetOpenToJoinReceipt,
  type StudentGroupView,
  type TeacherOption,
  type TeammateListing,
  type TerminateReceipt,
  type TerminationKind,
  type UngroupedStudent,
} from '@/application/groups'
import type { DueWorkScheduler, EventPublisher } from '@/application/notifications'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import type { SignoffParticipantHook } from '@/application/signoff'
import {
  authorizeAdmin,
  badRequestId,
  inTransaction,
  replayed,
  staleRevision,
  type PoolSource,
} from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { personName } from '@/infrastructure/db/person-name'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { reachFaultPoint } from '@/shared/fault-points'
import { err, type Err, type Result } from '@/shared/result'
import { formatTaipeiDate, formatTaipeiMinute, RealClock, type Clock } from '@/shared/time'

/**
 * 找組員、提案與成組（票 13；模組實作設計 03 §3、§6；產品模組 03 §5.1、§5.2、「提案終止」「組長」）。
 *
 * 每個寫入都是同一個形狀（契約 01 §8）：開交易 → 鎖 → 帳本 `begin` → 業務寫入 → 事件／到期工作／稽核
 * → 帳本 `commit` → COMMIT。回 `Err` 整筆回滾。業務時間在開交易**之前**讀一次（票 11 審查建議）。
 *
 * 鎖的順序照契約 01 §6：`cohorts FOR SHARE` → `group_proposals FOR UPDATE` → 邀請列 →（成立時）
 * 組別代碼的 advisory lock。兩位成員同時按確認會在提案列排隊，後到的看到的是前者寫完的樣子。
 *
 * 「同一時間只能一個」都由資料庫守：
 * - 占用表 `proposal_occupancy` 主鍵是 user_id：兩個提案同時邀同一人，後到的撞到 → `INVITED_ELSEWHERE`。
 * - `group_memberships_one_active`：成立瞬間發現有人已在別組 → 回到 savepoint、整份以 `conflict` 終止。
 * 發起時**先插占用、再查有沒有組**：若同一人正好在別的提案成立中，插占用會等那筆交易結束，
 * 之後的查詢就看得到剛成立的組員資格（READ COMMITTED 每句重新取快照），不會留下一份註定衝突的提案。
 *
 * 票 14 管理員加人：「發起」與「加人」各自先寫自己的表再查對方的表，單靠 READ COMMITTED 兩邊可能都看不到對方
 * 還沒 commit 的那筆。所以兩邊都先拿**每位學生一把**的 advisory lock（`groups.student:<id>`，依 id 排序），
 * 後到的等前者 commit 再查：發起那邊看到他已有組 → `ALREADY_MEMBER`；加人那邊看到他被占住 → `INVITED_ELSEWHERE`。
 * 成立（最後一位確認）不拿這把鎖：它只動已被占住的人，而加人遇到被占住的人一律拒絕。
 */

const DUE_KIND = 'proposal_expiry' as const
const SUBJECT_TYPE = 'group_proposal'

/** 一屆裡「這個學生的分組狀態」的鎖（見檔頭）。 */
async function lockStudents(tx: PoolClient, userIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(userIds)].sort()) {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`groups.student:${id}`])
  }
}

function cohortArchived(): Err {
  return err('COHORT_ARCHIVED', '這一屆已封存，分組資料只能查看。')
}

type ProposalRow = {
  id: string
  cohort_id: string
  proposer_user_id: string
  group_type: GroupType
  expires_business_at: Date
  state: ProposalState
  termination_kind: TerminationKind | null
  deadline_version: number
  established_group_id: string | null
}

type InvitationRow = { user_id: string; state: InvitationState }

type CohortRow = {
  id: string
  code: string
  status: CohortStatus
  group_size_min: number
  group_size_max: number
  proposal_default_days: number
}

type GroupRow = { id: string; cohort_id: string; code: string; status: 'active' | 'dissolved'; revision: number }

function groupNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個組別，請重新整理頁面。')
}

/** 管理員調整組員／換組長的共同前置（不碰資料庫）：授權、請求編號、組別 id、版本、理由。 */
function prepareGroupChange(
  actor: ResolvedActor,
  input: { readonly groupId: string; readonly revision: number; readonly reason: string },
  requestId: string,
  what: string,
): { ok: true; adminId: string; reason: string } | Err {
  const denied = authorizeAdmin(actor, what)
  if (denied) return denied
  if (!isUuid(requestId)) return badRequestId()
  if (!isUuid(String(input.groupId ?? ''))) return groupNotFound()
  if (!Number.isInteger(input.revision)) return staleRevision()
  const reason = normalizeReason(String(input.reason ?? ''), what)
  if (!reason.ok) return reason
  return { ok: true, adminId: actor.kind === 'authenticated' ? actor.userId : '', reason: reason.value }
}

/** 鎖到組別之後的共同拒絕：屆別封存、組別已解散、版本過舊。 */
function groupWriteBlocked(cohort: CohortRow, group: GroupRow, revision: number): Err | null {
  if (cohort.status === 'archived') return cohortArchived()
  if (group.status === 'dissolved') return err('GROUP_DISSOLVED', `${group.code} 已解散，不能再調整。`)
  if (group.revision !== revision) return staleRevision()
  return null
}

type Closer = { readonly kind: 'user'; readonly userId: string; readonly role: 'student' | 'admin' } | { readonly kind: 'worker' | 'system' }

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  dueWork: DueWorkScheduler<PoolClient>
  businessClock: BusinessClockSource
  /**
   * 票 25：成員集合改變時，同一筆交易讓這一組目前的簽核版本失效（模組 07 §5 `supersedeForParticipantChange`）。
   * 可以不給（票 13／14 的舊測試不需要簽核）；正式組裝一定有（`composition/groups.ts`）。
   */
  signoff?: SignoffParticipantHook<PoolClient>
  pool?: PoolSource
  realClock?: Clock
}

function proposalNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這份提案，請重新整理頁面。')
}

function proposalNotOpen(): Err {
  return err('PROPOSAL_NOT_OPEN', '這份提案已經成立或終止了，請重新整理頁面看最新狀態。')
}

function proposalOverdue(expiresAt: Date): Err {
  return err(
    'PROPOSAL_NOT_OPEN',
    `這份提案已經過了到期時間（${formatTaipeiMinute(expiresAt)}），系統會把它終止並釋放所有人。`,
  )
}

/** 學生用例的門：帳號狀態 → 角色 → 屆別。 */
function authorizeStudent(actor: ResolvedActor): { ok: true; userId: string; cohortId: string } | Err {
  const blocked = statusGate(actor, 'business')
  if (blocked) return err(blocked, '請先登入並完成帳號設定。')
  if (actor.kind !== 'authenticated' || !actor.roles.includes('student')) {
    return err('FORBIDDEN', '只有學生可以分組。')
  }
  const cohortId = studentCohortOf(actor)
  if (!cohortId) return err('VALIDATION_FAILED', '你的帳號還沒有屆別，請聯絡系辦。', { next: { kind: 'contact_office' } })
  return { ok: true, userId: actor.userId, cohortId }
}

/** 一屆的階段表（成組期判斷用）。票 20 的組長改類型（`pg-opportunities.ts`）也用這一份。 */
export async function loadSchedule(
  tx: Pick<PoolClient, 'query'>,
  cohortId: string,
  yearEndDate: string | null,
): Promise<CohortSchedule> {
  const stages = await tx.query<{ seq: number; name: string; start_date: string; deadline_version: number }>(
    `select seq, name, to_char(start_date, 'YYYY-MM-DD') as start_date, deadline_version
       from cohort_stages where cohort_id = $1 order by seq`,
    [cohortId],
  )
  return {
    stages: stages.rows.map((r) => ({ seq: r.seq, name: r.name, startDate: r.start_date, deadlineVersion: r.deadline_version })),
    yearEndDate,
  }
}

export class PgGroupCommand implements GroupCommand, ProposalExpiryHandler {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #dueWork: DueWorkScheduler<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock
  readonly #signoff: SignoffParticipantHook<PoolClient> | undefined

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#events = deps.events
    this.#dueWork = deps.dueWork
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
    this.#signoff = deps.signoff
  }

  // ── 公開找組員 ──────────────────────────────────────────────────────────────

  async setOpenToJoin(actor: ResolvedActor, open: boolean, requestId: string): Promise<Result<SetOpenToJoinReceipt>> {
    const who = authorizeStudent(actor)
    if (!who.ok) return who
    if (!isUuid(requestId)) return badRequestId()
    const { userId, cohortId } = who
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'group.set_open_to_join',
          requestId,
          fingerprint: sha256(canonicalJson({ open })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<SetOpenToJoinReceipt>(begun)

      const profile = await tx.query<{ open_to_join: boolean }>(
        'select open_to_join from user_profiles where user_id = $1 for update',
        [userId],
      )
      if (!profile.rows[0]) return err('VALIDATION_FAILED', '找不到你的個人資料，請聯絡系辦。')

      if (open && (await this.#activeMembers(tx, cohortId, [userId])).length > 0) {
        return err('ALREADY_MEMBER', '你已經有組別了，不需要公開找組員。')
      }

      if (profile.rows[0].open_to_join !== open) {
        await tx.query(
          'update user_profiles set open_to_join = $2, updated_at = $3, updated_by_user_id = $1 where user_id = $1',
          [userId, open, realAt],
        )
        await this.#audit.append(tx, {
          actorKind: 'user',
          actorUserId: userId,
          role: 'student',
          action: 'group.set_open_to_join',
          targetType: 'user',
          targetId: userId,
          scope: 'cohort',
          cohortId,
          realAt,
          businessAt,
          payload: { openToJoin: open },
        })
      }

      const receipt = { openToJoin: open, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { userId } })
      return { ok: true as const, receipt }
    })
  }

  // ── 發起提案 ────────────────────────────────────────────────────────────────

  async propose(actor: ResolvedActor, input: ProposeInput, requestId: string): Promise<Result<ProposeReceipt>> {
    const who = authorizeStudent(actor)
    if (!who.ok) return who
    if (!isUuid(requestId)) return badRequestId()
    const { userId: proposerId, cohortId } = who
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const cohort = await this.#shareCohort(tx, cohortId)
      if (!cohort) return err('VALIDATION_FAILED', '找不到你的屆別，請聯絡系辦。')

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: proposerId,
          operationKind: 'group.propose',
          requestId,
          fingerprint: sha256(
            canonicalJson({ groupType: input.groupType, members: input.memberStudentNos.map((n) => n.trim()) }),
          ),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<ProposeReceipt>(begun)
      if (cohort.status === 'archived') return err('COHORT_ARCHIVED', `${cohort.code} 已封存，不能再分組。`)

      const me = await tx.query<{ student_no: string | null; name: string }>(
        `select p.student_no, ${personName('p', 'u')} as name
           from users u left join user_profiles p on p.user_id = u.id where u.id = $1`,
        [proposerId],
      )
      const proposerName = me.rows[0]?.name ?? ''
      const normalized = normalizeProposeInput(
        input,
        { min: cohort.group_size_min, max: cohort.group_size_max },
        me.rows[0]?.student_no ?? null,
      )
      if (!normalized.ok) return normalized
      const { groupType, memberStudentNos } = normalized.value

      // 成組期：第 1 階段；截止＝第 2 階段開始日 00:00（見 groupingDeadline 的說明）。
      const yearEnd = await tx.query<{ year_end_date: string | null }>(
        `select to_char(year_end_date, 'YYYY-MM-DD') as year_end_date from cohorts where id = $1`,
        [cohortId],
      )
      const schedule = await loadSchedule(tx, cohortId, yearEnd.rows[0]?.year_end_date ?? null)
      const deadline = groupingDeadline(schedule)
      const position = stagePositionAt(schedule, businessNow)
      if (!deadline || position.kind === 'unconfigured') {
        return err('VALIDATION_FAILED', '系辦還沒設定本屆的成組期，暫時不能發起提案。', { next: { kind: 'contact_office' } })
      }
      if (businessNow.getTime() >= deadline.getTime()) {
        return err('DEADLINE_PASSED', `成組期已經結束（${formatTaipeiMinute(deadline)} 截止），不能再發起提案；需要分組請聯絡系辦。`)
      }
      if (position.kind === 'not_started') {
        return err('VALIDATION_FAILED', `成組期從 ${formatTaipeiDate(position.firstStartDate)} 才開始。`)
      }

      // 其他組員：同屆、有效學號（student_identities＝已核准）、帳號正常、目前是學生。
      const found = await tx.query<{ user_id: string; student_no: string; name: string }>(
        `select si.user_id, si.student_no, ${personName('p', 'u')} as name
           from student_identities si
           join users u on u.id = si.user_id
           left join user_profiles p on p.user_id = si.user_id
          where si.cohort_id = $1 and si.student_no = any($2::text[])
            and u.status = 'active' and u.deidentified_at is null
            and exists (select 1 from role_assignments r
                         where r.user_id = u.id and r.role = 'student' and r.revoked_real_at is null)`,
        [cohortId, memberStudentNos],
      )
      const byNo = new Map(found.rows.map((r) => [r.student_no, r]))
      const missing = memberStudentNos.filter((no) => !byNo.has(no))
      if (missing.length > 0) {
        return err('VALIDATION_FAILED', `找不到這些同屆同學：${missing.join('、')}。請確認學號，對方要是本屆已核准的學生。`, {
          details: { field: 'memberStudentNos', studentNos: missing },
        })
      }
      const members = memberStudentNos.map((no) => byNo.get(no)!).filter((m) => m.user_id !== proposerId)
      const everyone = [proposerId, ...members.map((m) => m.user_id)]
      const nameOf = new Map<string, string>([[proposerId, proposerName], ...members.map((m) => [m.user_id, m.name] as const)])

      // 和管理員加人互斥（見檔頭）。
      await lockStudents(tx, everyone)
      // 過了到期時間、背景工作還沒收的提案：先終止並釋放（不然這些人會被一份死掉的提案卡住）。
      await this.#expireOverdueOccupying(tx, everyone, businessNow)

      const proposalId = uuidv7()
      const expiresAt = proposalExpiry(businessNow, cohort.proposal_default_days, deadline)
      await tx.query(
        `insert into group_proposals
           (id, cohort_id, proposer_user_id, group_type, expires_business_at, state, deadline_version,
            created_real_at, created_business_at, updated_at)
         values ($1, $2, $3, $4, $5, 'open', 1, $6, $7, $6)`,
        [proposalId, cohortId, proposerId, groupType, expiresAt, realAt, businessNow],
      )

      // 先占住，再查組員資格（見檔頭）。依 id 排序插入，兩個提案互邀時不會互相死鎖。
      const sorted = [...everyone].sort()
      const occupied = await tx.query<{ user_id: string }>(
        `insert into proposal_occupancy (user_id, proposal_id, created_at)
         select u, $2, $3 from unnest($1::uuid[]) as u
         on conflict (user_id) do nothing
         returning user_id`,
        [sorted, proposalId, realAt],
      )
      if (occupied.rowCount !== everyone.length) {
        const got = new Set(occupied.rows.map((r) => r.user_id))
        const taken = everyone.filter((id) => !got.has(id))
        if (taken.includes(proposerId)) {
          return err('INVITED_ELSEWHERE', '你已經在另一份進行中的提案裡，要先等它結束（或撤回）才能再發起。')
        }
        return err('INVITED_ELSEWHERE', `${taken.map((id) => nameOf.get(id)).join('、')} 正在別的提案裡等確認，現在不能邀請。`, {
          details: { userIds: taken },
        })
      }

      const grouped = await this.#activeMembers(tx, cohortId, everyone)
      if (grouped.length > 0) {
        if (grouped.includes(proposerId)) return err('ALREADY_MEMBER', '你已經有組別了，不能再發起提案。')
        return err('ALREADY_MEMBER', `${grouped.map((id) => nameOf.get(id)).join('、')} 已經有組別了。`, {
          details: { userIds: grouped },
        })
      }

      await tx.query(
        `insert into proposal_invitations (id, proposal_id, user_id, state, created_at)
         select gen_random_uuid(), $1, u, 'pending', $3 from unnest($2::uuid[]) as u`,
        [proposalId, everyone, realAt],
      )
      await this.#dueWork.schedule(tx, {
        kind: DUE_KIND,
        subject: { type: SUBJECT_TYPE, id: proposalId },
        deadlineVersion: 1,
        dueBusinessAt: expiresAt,
      })
      await this.#events.publish(tx, {
        type: 'proposal.invited',
        scope: 'cohort',
        cohortId,
        source: { type: SUBJECT_TYPE, id: proposalId, version: 1 },
        actor: { kind: 'user', userId: proposerId },
        recipients: everyone,
        recipientBasis: { proposalId, basis: 'proposal_invitations' },
        payload: {
          title: `${proposerName} 邀請你組成${GROUP_TYPE_LABEL[groupType]}組別，請在 ${formatTaipeiMinute(expiresAt)} 前確認`,
          proposalId,
          expiresBusinessAt: expiresAt.toISOString(),
        },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: proposerId,
        role: 'student',
        action: 'group.proposal.create',
        targetType: SUBJECT_TYPE,
        targetId: proposalId,
        scope: 'cohort',
        cohortId,
        realAt,
        businessAt: businessNow,
        payload: { groupType, memberUserIds: everyone, expiresBusinessAt: expiresAt.toISOString() },
      })

      const receipt = {
        proposalId,
        memberCount: everyone.length,
        expiresBusinessAt: expiresAt.toISOString(),
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { proposalId } })
      return { ok: true as const, receipt }
    })
  }

  // ── 確認與成立 ──────────────────────────────────────────────────────────────

  async confirm(actor: ResolvedActor, proposalId: string, requestId: string): Promise<Result<ConfirmReceipt>> {
    const who = authorizeStudent(actor)
    if (!who.ok) return who
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(proposalId)) return proposalNotFound()
    const { userId } = who
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lockProposal(tx, proposalId)
      if (!locked) return proposalNotFound()
      const { proposal, invitations } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'group.proposal.confirm',
          requestId,
          fingerprint: sha256(canonicalJson({ proposalId })),
          scope: 'cohort',
          cohortId: proposal.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<ConfirmReceipt>(begun)
      if (locked.cohortStatus === 'archived') return cohortArchived()

      const mine = invitations.find((i) => i.user_id === userId)
      if (!mine) return err('FORBIDDEN', '你不在這份提案的名單裡。')

      const total = invitations.length
      const countConfirmed = () => invitations.filter((i) => i.state === 'confirmed').length
      const receiptOf = (outcome: ConfirmReceipt['outcome'], confirmedCount: number, groupCode: string | null) => ({
        proposalId,
        outcome,
        confirmedCount,
        memberCount: total,
        groupCode,
        requestId,
        serverTime: realAt.toISOString(),
      })

      // 按兩次（或網路重送但換了請求編號）：不是錯誤，回目前的樣子。
      if (mine.state === 'confirmed') {
        const code = proposal.established_group_id ? await this.#groupCode(tx, proposal.established_group_id) : null
        const receipt = receiptOf('already_confirmed', countConfirmed(), code)
        await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { proposalId } })
        return { ok: true as const, receipt }
      }
      if (proposal.state !== 'open' || mine.state !== 'pending') return proposalNotOpen()
      if (businessNow.getTime() >= proposal.expires_business_at.getTime()) return proposalOverdue(proposal.expires_business_at)

      await tx.query(
        `update proposal_invitations set state = 'confirmed', decided_real_at = $3
          where proposal_id = $1 and user_id = $2`,
        [proposalId, userId, realAt],
      )
      mine.state = 'confirmed'
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'student',
        action: 'group.proposal.confirm',
        targetType: SUBJECT_TYPE,
        targetId: proposalId,
        scope: 'cohort',
        cohortId: proposal.cohort_id,
        realAt,
        businessAt: businessNow,
      })

      const confirmed = countConfirmed()
      let receipt: ReturnType<typeof receiptOf>
      if (confirmed < total) {
        receipt = receiptOf('confirmed', confirmed, null)
      } else {
        const established = await this.#establish(tx, proposal, invitations, userId, realAt, businessNow)
        receipt = established.ok
          ? receiptOf('established', confirmed, established.code)
          : receiptOf('conflict', confirmed, null)
      }

      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { proposalId } })
      return { ok: true as const, receipt }
    })
  }

  /**
   * 成立（在最後一位確認的那筆交易裡）：組別＋全員 membership＋組長（提案人）一起寫，提案轉成立、
   * 占用釋放、到期工作取消、全員收到成立通知。
   *
   * 成立前先查一次「有沒有人已經在別組」；萬一還是撞到 `group_memberships_one_active`
   * （極端的並發），回到 savepoint，整份以 `conflict` 終止——不會留下半套組別。
   */
  async #establish(
    tx: PoolClient,
    proposal: ProposalRow,
    invitations: InvitationRow[],
    confirmerId: string,
    realAt: Date,
    businessNow: Date,
  ): Promise<{ ok: true; code: string } | { ok: false }> {
    const everyone = invitations.map((i) => i.user_id)
    const conflict = async () => {
      await this.#terminate(tx, proposal, everyone, {
        kind: 'conflict',
        closer: { kind: 'user', userId: confirmerId, role: 'student' },
        realAt,
        businessAt: businessNow,
      })
      return { ok: false as const }
    }

    // 同一屆的組別代碼排隊配（屆別內遞增），兩組同時成立不會搶到同一個號碼。
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`groups.code:${proposal.cohort_id}`])
    if ((await this.#activeMembers(tx, proposal.cohort_id, everyone)).length > 0) return conflict()

    const groupId = uuidv7()
    const existing = await tx.query<{ code: string }>('select code from groups where cohort_id = $1', [proposal.cohort_id])
    const code = nextGroupCode(existing.rows.map((r) => r.code))

    await tx.query('savepoint establish_group')
    try {
      await tx.query(
        `insert into groups
           (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
            created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
         values ($1, $2, $3, $4, 'active', $5, $6, $5, 'user', $7, $5, $7)`,
        [groupId, proposal.cohort_id, code, proposal.group_type, realAt, businessNow, confirmerId],
      )
      // 組員資格的「加入者」是提案人（模組 03 附錄 A：提案成立＝user（提案人））。
      await tx.query(
        `insert into group_memberships
           (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
         select gen_random_uuid(), $1, $2, u, $3, 'user', $4, $5, $5 from unnest($6::uuid[]) as u`,
        [groupId, proposal.cohort_id, businessNow, proposal.proposer_user_id, realAt, everyone],
      )
      await tx.query(
        `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at)
         values ($1, $2, $3, $4, $3, $5)`,
        [uuidv7(), groupId, proposal.proposer_user_id, businessNow, realAt],
      )
      await tx.query('release savepoint establish_group')
    } catch (error) {
      const pgError = error as { code?: string; constraint?: string }
      if (pgError?.code === '23505' && pgError.constraint === 'group_memberships_one_active') {
        await tx.query('rollback to savepoint establish_group')
        return conflict()
      }
      throw error
    }

    await tx.query(
      `update group_proposals
          set state = 'established', established_group_id = $2, closed_real_at = $3, closed_business_at = $4,
              closed_by_kind = 'user', closed_by_user_id = $5, revision = revision + 1, updated_at = $3
        where id = $1`,
      [proposal.id, groupId, realAt, businessNow, confirmerId],
    )
    await tx.query('delete from proposal_occupancy where proposal_id = $1', [proposal.id])
    await reachFaultPoint('group.establish.after-release')
    await this.#dueWork.cancel(tx, {
      kind: DUE_KIND,
      subject: { type: SUBJECT_TYPE, id: proposal.id },
      deadlineVersion: proposal.deadline_version,
    })
    await this.#events.publish(tx, {
      type: 'group.established',
      scope: 'cohort',
      cohortId: proposal.cohort_id,
      source: { type: 'group', id: groupId, version: 1 },
      actor: { kind: 'user', userId: confirmerId },
      recipients: everyone,
      recipientBasis: { groupId, proposalId: proposal.id, basis: 'group_memberships' },
      payload: { title: `組別 ${code} 成立了`, groupId, code, proposalId: proposal.id },
      occurredRealAt: realAt,
      occurredBusinessAt: businessNow,
    })
    await this.#audit.append(tx, {
      actorKind: 'user',
      actorUserId: confirmerId,
      role: 'student',
      action: 'group.establish',
      targetType: 'group',
      targetId: groupId,
      scope: 'cohort',
      cohortId: proposal.cohort_id,
      realAt,
      businessAt: businessNow,
      payload: { code, proposalId: proposal.id, memberUserIds: everyone, leaderUserId: proposal.proposer_user_id },
    })
    return { ok: true, code }
  }

  // ── 終止：拒絕、撤回同意、提案人撤回、管理員作廢 ──────────────────────────────

  decline(actor: ResolvedActor, proposalId: string, requestId: string): Promise<Result<TerminateReceipt>> {
    return this.#studentTerminate(actor, proposalId, requestId, 'group.proposal.decline', (proposal, mine, userId) => {
      if (proposal.proposer_user_id === userId) {
        return err('VALIDATION_FAILED', '你是提案人：要結束這份提案請按「撤回提案」。')
      }
      if (mine.state === 'confirmed') {
        return err('VALIDATION_FAILED', '你已經確認了；要改變主意請按「撤回同意」。')
      }
      return { kind: 'declined', myState: 'declined' }
    })
  }

  withdrawConfirmation(actor: ResolvedActor, proposalId: string, requestId: string): Promise<Result<TerminateReceipt>> {
    return this.#studentTerminate(actor, proposalId, requestId, 'group.proposal.withdraw_confirmation', (proposal, mine, userId) => {
      if (proposal.proposer_user_id === userId) {
        return err('VALIDATION_FAILED', '你是提案人：要結束這份提案請按「撤回提案」。')
      }
      if (mine.state !== 'confirmed') return err('VALIDATION_FAILED', '你還沒確認，不需要撤回；不想加入請按「拒絕」。')
      return { kind: 'member_withdrew', myState: 'withdrawn' }
    })
  }

  withdrawProposal(actor: ResolvedActor, proposalId: string, requestId: string): Promise<Result<TerminateReceipt>> {
    return this.#studentTerminate(actor, proposalId, requestId, 'group.proposal.withdraw', (proposal, _mine, userId) => {
      if (proposal.proposer_user_id !== userId) return err('FORBIDDEN', '只有提案人可以撤回整份提案。')
      return { kind: 'proposer_withdrew', myState: 'withdrawn' }
    })
  }

  async #studentTerminate(
    actor: ResolvedActor,
    proposalId: string,
    requestId: string,
    operationKind: string,
    decide: (
      proposal: ProposalRow,
      mine: InvitationRow,
      userId: string,
    ) => Err | { kind: TerminationKind; myState: 'declined' | 'withdrawn' },
  ): Promise<Result<TerminateReceipt>> {
    const who = authorizeStudent(actor)
    if (!who.ok) return who
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(proposalId)) return proposalNotFound()
    const { userId } = who
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lockProposal(tx, proposalId)
      if (!locked) return proposalNotFound()
      const { proposal, invitations } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind,
          requestId,
          fingerprint: sha256(canonicalJson({ proposalId })),
          scope: 'cohort',
          cohortId: proposal.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<TerminateReceipt>(begun)
      if (locked.cohortStatus === 'archived') return cohortArchived()

      const mine = invitations.find((i) => i.user_id === userId)
      if (!mine) return err('FORBIDDEN', '你不在這份提案的名單裡。')
      if (proposal.state !== 'open') {
        return proposal.state === 'established'
          ? err('PROPOSAL_NOT_OPEN', '組別已經成立了；成立後的成員異動要請系辦處理。')
          : proposalNotOpen()
      }
      if (businessNow.getTime() >= proposal.expires_business_at.getTime()) return proposalOverdue(proposal.expires_business_at)

      const decision = decide(proposal, mine, userId)
      if ('ok' in decision) return decision

      await this.#terminate(tx, proposal, invitations.map((i) => i.user_id), {
        kind: decision.kind,
        closer: { kind: 'user', userId, role: 'student' },
        own: { userId, state: decision.myState },
        realAt,
        businessAt: businessNow,
      })

      const receipt = { proposalId, terminationKind: decision.kind, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { proposalId } })
      return { ok: true as const, receipt }
    })
  }

  async voidProposal(
    actor: ResolvedActor,
    proposalId: string,
    reason: string,
    requestId: string,
  ): Promise<Result<TerminateReceipt>> {
    const denied = authorizeAdmin(actor, '作廢提案')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(proposalId)) return proposalNotFound()
    const normalized = normalizeVoidReason(reason)
    if (!normalized.ok) return normalized
    const userId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lockProposal(tx, proposalId)
      if (!locked) return proposalNotFound()
      const { proposal, invitations } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'group.proposal.void',
          requestId,
          fingerprint: sha256(canonicalJson({ proposalId, reason: normalized.value })),
          scope: 'cohort',
          cohortId: proposal.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<TerminateReceipt>(begun)
      if (locked.cohortStatus === 'archived') return cohortArchived()
      if (proposal.state !== 'open') return proposalNotOpen()

      await this.#terminate(tx, proposal, invitations.map((i) => i.user_id), {
        kind: 'admin_voided',
        closer: { kind: 'user', userId, role: 'admin' },
        reason: normalized.value,
        realAt,
        businessAt: businessNow,
      })

      const receipt = { proposalId, terminationKind: 'admin_voided' as const, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { proposalId } })
      return { ok: true as const, receipt }
    })
  }

  // ── 管理員調整組員與換組長（票 14） ─────────────────────────────────────────────

  async addMember(actor: ResolvedActor, input: AddMemberInput, requestId: string): Promise<Result<MemberChangeReceipt>> {
    const prepared = prepareGroupChange(actor, input, requestId, '加入組員')
    if (!prepared.ok) return prepared
    const studentNo = String(input.studentNo ?? '').trim()
    if (!studentNo) return err('VALIDATION_FAILED', '請選要加入的學生。', { details: { field: 'studentNo' } })
    const { adminId, reason } = prepared
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lockGroup(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { group, cohort } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'group.member.add',
          requestId,
          fingerprint: sha256(canonicalJson({ groupId: group.id, revision: input.revision, studentNo, reason })),
          scope: 'cohort',
          cohortId: group.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<MemberChangeReceipt>(begun)
      const blocked = groupWriteBlocked(cohort, group, input.revision)
      if (blocked) return blocked

      // 同屆、已核准（有 student_identities）、帳號正常、目前是學生——和發起提案同一條條件。
      const found = await tx.query<{ user_id: string; name: string }>(
        `select si.user_id, ${personName('p', 'u')} as name
           from student_identities si
           join users u on u.id = si.user_id
           left join user_profiles p on p.user_id = si.user_id
          where si.cohort_id = $1 and si.student_no = $2
            and u.status = 'active' and u.deidentified_at is null
            and exists (select 1 from role_assignments r
                         where r.user_id = u.id and r.role = 'student' and r.revoked_real_at is null)`,
        [group.cohort_id, studentNo],
      )
      const student = found.rows[0]
      if (!student) {
        return err('VALIDATION_FAILED', `找不到 ${cohort.code} 已核准、帳號正常的學生「${studentNo}」。`, {
          details: { field: 'studentNo' },
        })
      }

      // 和發起提案互斥（見檔頭）；逾期還沒被收掉的提案先收掉，不讓死掉的提案卡住人。
      await lockStudents(tx, [student.user_id])
      await this.#expireOverdueOccupying(tx, [student.user_id], businessNow)

      const occupying = await tx.query<{ proposer_name: string }>(
        `select ${personName('pp', 'pu')} as proposer_name
           from proposal_occupancy o
           join group_proposals gp on gp.id = o.proposal_id
           join users pu on pu.id = gp.proposer_user_id
           left join user_profiles pp on pp.user_id = gp.proposer_user_id
          where o.user_id = $1`,
        [student.user_id],
      )
      if (occupying.rows[0]) {
        // 不替他終止那份提案（會連帶釋放其他同學）：請管理員先作廢，理由另外記。
        return err(
          'INVITED_ELSEWHERE',
          `${student.name} 正在 ${occupying.rows[0].proposer_name} 發起的提案裡等確認。要加入請先在「進行中的提案」作廢那份提案，或等它結束。`,
        )
      }

      const current = await tx.query<{ group_id: string; code: string }>(
        `select m.group_id, g.code from group_memberships m join groups g on g.id = m.group_id
          where m.user_id = $1 and m.cohort_id = $2 and m.valid_to is null`,
        [student.user_id, group.cohort_id],
      )
      if (current.rows[0]) {
        return err(
          'ALREADY_MEMBER',
          current.rows[0].group_id === group.id
            ? `${student.name} 已經是 ${group.code} 的成員了。`
            : `${student.name} 已經在 ${current.rows[0].code}，一人同屆只能在一組；要換組請先從原組移出。`,
        )
      }

      await reachFaultPoint('group.member.add.before-insert')
      const membershipId = uuidv7()
      await tx.query(
        `insert into group_memberships
           (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'user', $6, $7, $7)`,
        [membershipId, group.id, group.cohort_id, student.user_id, businessNow, adminId, realAt],
      )
      const revision = await this.#bumpGroup(tx, group.id, adminId, realAt)
      const members = await this.#currentMembers(tx, group.id)
      const sizeWarning = groupSizeWarning(members.length, { min: cohort.group_size_min, max: cohort.group_size_max })
      const advisorId = await this.#currentAdvisorId(tx, group.id)

      await this.#events.publish(tx, {
        type: 'group.members_changed',
        scope: 'cohort',
        cohortId: group.cohort_id,
        source: { type: 'group', id: group.id, version: revision },
        actor: { kind: 'user', userId: adminId },
        // 異動後全體成員＋目前主指導（產品 08 §4；票 19 補上主指導）。
        recipients: [...members.map((m) => m.user_id), ...(advisorId ? [advisorId] : [])],
        recipientBasis: { groupId: group.id, basis: 'group_memberships+advisor', revision, advisorUserId: advisorId },
        payload: {
          title: `系辦把 ${student.name} 加入組別 ${group.code}`,
          groupId: group.id,
          code: group.code,
          change: 'added',
          userId: student.user_id,
        },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      // 成員集合變了：這一組目前的簽核版本同交易失效（舊同意留歷史、不自動建新版；票 25）。
      const signoff = await this.#supersedeSignoff(tx, group.id, adminId, realAt, businessNow)
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'group.member.add',
        targetType: 'group',
        targetId: group.id,
        scope: 'cohort',
        cohortId: group.cohort_id,
        reason,
        realAt,
        businessAt: businessNow,
        payload: {
          userId: student.user_id,
          membershipId,
          memberCount: members.length,
          sizeWarning,
          supersededSignoffVersionIds: signoff,
        },
      })

      const receipt = {
        groupId: group.id,
        groupCode: group.code,
        change: 'added' as const,
        memberName: student.name,
        memberCount: members.length,
        sizeWarning,
        newLeaderName: null,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { groupId: group.id, membershipId } })
      return { ok: true as const, receipt }
    })
  }

  async removeMember(actor: ResolvedActor, input: RemoveMemberInput, requestId: string): Promise<Result<MemberChangeReceipt>> {
    const prepared = prepareGroupChange(actor, input, requestId, '移出組員')
    if (!prepared.ok) return prepared
    if (!isUuid(String(input.userId ?? ''))) return err('VALIDATION_FAILED', '請選要移出的成員。', { details: { field: 'userId' } })
    const successorId = input.successorLeaderUserId ? String(input.successorLeaderUserId) : null
    if (successorId && !isUuid(successorId)) {
      return err('VALIDATION_FAILED', '請選接任的組長。', { details: { field: 'successorLeaderUserId' } })
    }
    const { adminId, reason } = prepared
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lockGroup(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { group, cohort } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'group.member.remove',
          requestId,
          fingerprint: sha256(
            canonicalJson({ groupId: group.id, revision: input.revision, userId: input.userId, successorId, reason }),
          ),
          scope: 'cohort',
          cohortId: group.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<MemberChangeReceipt>(begun)
      const blocked = groupWriteBlocked(cohort, group, input.revision)
      if (blocked) return blocked

      const before = await this.#currentMembers(tx, group.id)
      const leader = await this.#currentLeader(tx, group.id)
      const decision = decideRemoval({
        memberIds: before.map((m) => m.user_id),
        leaderId: leader?.user_id ?? null,
        targetId: input.userId,
        successorId,
      })
      if (!decision.ok) return decision
      const target = before.find((m) => m.user_id === input.userId)!
      const nameOf = new Map(before.map((m) => [m.user_id, m.name]))

      // 先換組長再結束組員資格：任何時刻這組都恰有一位有效組長，而且是有效成員。
      if (decision.leaderChange && leader && successorId) {
        await this.#replaceLeader(tx, group.id, leader.id, successorId, adminId, reason, realAt, businessNow)
      }
      await tx.query(
        `update group_memberships set valid_to = greatest(valid_from, $2), removal_reason = $3, updated_at = $4
          where id = $1`,
        [target.id, businessNow, reason, realAt],
      )
      const revision = await this.#bumpGroup(tx, group.id, adminId, realAt)
      const after = before.filter((m) => m.user_id !== target.user_id)
      const sizeWarning = groupSizeWarning(after.length, { min: cohort.group_size_min, max: cohort.group_size_max })
      const newLeaderName = decision.leaderChange && successorId ? (nameOf.get(successorId) ?? null) : null
      const advisorId = await this.#currentAdvisorId(tx, group.id)

      await this.#events.publish(tx, {
        type: 'group.members_changed',
        scope: 'cohort',
        cohortId: group.cohort_id,
        source: { type: 'group', id: group.id, version: revision },
        actor: { kind: 'user', userId: adminId },
        // 異動後全體成員＋目前主指導（產品 08 §4；票 19 補上主指導）；被移出的人收下面那一則。
        recipients: [...after.map((m) => m.user_id), ...(advisorId ? [advisorId] : [])],
        recipientBasis: { groupId: group.id, basis: 'group_memberships+advisor', revision, advisorUserId: advisorId },
        payload: {
          title: `系辦把 ${target.name} 移出組別 ${group.code}${newLeaderName ? `，組長改由 ${newLeaderName} 接任` : ''}`,
          groupId: group.id,
          code: group.code,
          change: 'removed',
          userId: target.user_id,
          ...(decision.leaderChange ? { leaderUserId: successorId } : {}),
        },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      // 被移出的人只收本人的異動說明（產品 08 §4），不帶組別內容與理由。
      await this.#events.publish(tx, {
        type: 'group.member_removed',
        scope: 'cohort',
        cohortId: group.cohort_id,
        source: { type: 'group', id: group.id, version: revision },
        actor: { kind: 'user', userId: adminId },
        recipients: [target.user_id],
        recipientBasis: { groupId: group.id, basis: 'removed_member', membershipId: target.id },
        payload: { title: `系辦已把你移出組別 ${group.code}；有疑問請聯絡系辦`, groupId: group.id, code: group.code },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      // 成員集合變了：這一組目前的簽核版本同交易失效（舊同意留歷史、不自動建新版；票 25）。
      const signoff = await this.#supersedeSignoff(tx, group.id, adminId, realAt, businessNow)
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'group.member.remove',
        targetType: 'group',
        targetId: group.id,
        scope: 'cohort',
        cohortId: group.cohort_id,
        reason,
        realAt,
        businessAt: businessNow,
        payload: {
          userId: target.user_id,
          membershipId: target.id,
          memberCount: after.length,
          sizeWarning,
          successorLeaderUserId: decision.leaderChange ? successorId : null,
          supersededSignoffVersionIds: signoff,
        },
      })

      const receipt = {
        groupId: group.id,
        groupCode: group.code,
        change: 'removed' as const,
        memberName: target.name,
        memberCount: after.length,
        sizeWarning,
        newLeaderName,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { groupId: group.id, membershipId: target.id } })
      return { ok: true as const, receipt }
    })
  }

  /** 票 25：成員集合改變 → 目前簽核版本失效（沒注入簽核時什麼都不做）。回傳失效的版本 id，記進稽核。 */
  async #supersedeSignoff(tx: PoolClient, groupId: string, adminId: string, realAt: Date, businessAt: Date): Promise<readonly string[]> {
    if (!this.#signoff) return []
    const result = await this.#signoff.supersedeForParticipantChange(tx, {
      groupId,
      cause: 'member_change',
      actorUserId: adminId,
      realAt,
      businessAt,
    })
    return result.supersededVersionIds
  }

  async changeLeader(actor: ResolvedActor, input: ChangeLeaderInput, requestId: string): Promise<Result<LeaderChangeReceipt>> {
    const prepared = prepareGroupChange(actor, input, requestId, '換組長')
    if (!prepared.ok) return prepared
    if (!isUuid(String(input.newLeaderUserId ?? ''))) {
      return err('VALIDATION_FAILED', '請選新組長。', { details: { field: 'newLeaderUserId' } })
    }
    const { adminId, reason } = prepared
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lockGroup(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { group, cohort } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'group.leader.change',
          requestId,
          fingerprint: sha256(
            canonicalJson({ groupId: group.id, revision: input.revision, newLeaderUserId: input.newLeaderUserId, reason }),
          ),
          scope: 'cohort',
          cohortId: group.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<LeaderChangeReceipt>(begun)
      const blocked = groupWriteBlocked(cohort, group, input.revision)
      if (blocked) return blocked

      const members = await this.#currentMembers(tx, group.id)
      const leader = await this.#currentLeader(tx, group.id)
      const decision = decideLeaderChange({
        memberIds: members.map((m) => m.user_id),
        leaderId: leader?.user_id ?? null,
        newLeaderId: input.newLeaderUserId,
      })
      if (!decision.ok) return decision
      const nameOf = new Map(members.map((m) => [m.user_id, m.name]))
      const leaderName = nameOf.get(input.newLeaderUserId)!
      const previousLeaderName = leader ? (nameOf.get(leader.user_id) ?? null) : null

      await this.#replaceLeader(tx, group.id, leader?.id ?? null, input.newLeaderUserId, adminId, reason, realAt, businessNow)
      const revision = await this.#bumpGroup(tx, group.id, adminId, realAt)

      // 成員集合沒變：不發 group.members_changed（不重簽）。
      await this.#events.publish(tx, {
        type: 'group.leader_changed',
        scope: 'cohort',
        cohortId: group.cohort_id,
        source: { type: 'group', id: group.id, version: revision },
        actor: { kind: 'user', userId: adminId },
        recipients: members.map((m) => m.user_id),
        recipientBasis: { groupId: group.id, basis: 'group_memberships', revision },
        payload: {
          title: `組別 ${group.code} 的組長換成 ${leaderName}`,
          groupId: group.id,
          code: group.code,
          leaderUserId: input.newLeaderUserId,
        },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'group.leader.change',
        targetType: 'group',
        targetId: group.id,
        scope: 'cohort',
        cohortId: group.cohort_id,
        reason,
        realAt,
        businessAt: businessNow,
        payload: { previousLeaderUserId: leader?.user_id ?? null, leaderUserId: input.newLeaderUserId },
      })

      const receipt = {
        groupId: group.id,
        groupCode: group.code,
        previousLeaderName,
        leaderName,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { groupId: group.id } })
      return { ok: true as const, receipt }
    })
  }

  /** 鎖順序：屆別 FOR SHARE → 組別 FOR UPDATE（模組實作設計 03 §6「成員異動：groups FOR UPDATE」）。 */
  async #lockGroup(tx: PoolClient, groupId: string): Promise<{ group: GroupRow; cohort: CohortRow } | null> {
    const owner = await tx.query<{ cohort_id: string }>('select cohort_id from groups where id = $1', [groupId])
    const cohortId = owner.rows[0]?.cohort_id
    if (!cohortId) return null
    const cohort = await this.#shareCohort(tx, cohortId)
    const found = await tx.query<GroupRow>('select id, cohort_id, code, status, revision from groups where id = $1 for update', [
      groupId,
    ])
    const group = found.rows[0]
    if (!group || !cohort) return null
    return { group, cohort }
  }

  async #currentMembers(tx: PoolClient, groupId: string): Promise<{ id: string; user_id: string; name: string }[]> {
    const rows = await tx.query<{ id: string; user_id: string; name: string }>(
      `select m.id, m.user_id, ${personName('p', 'u')} as name
         from group_memberships m
         join users u on u.id = m.user_id
         left join user_profiles p on p.user_id = m.user_id
        where m.group_id = $1 and m.valid_to is null
        order by p.student_no, m.user_id`,
      [groupId],
    )
    return rows.rows
  }

  /** 目前的主指導（票 19 `advisor_assignments`）；還沒指派是 null。 */
  async #currentAdvisorId(tx: PoolClient, groupId: string): Promise<string | null> {
    const rows = await tx.query<{ teacher_user_id: string }>(
      'select teacher_user_id from advisor_assignments where group_id = $1 and valid_to is null',
      [groupId],
    )
    return rows.rows[0]?.teacher_user_id ?? null
  }

  async #currentLeader(tx: PoolClient, groupId: string): Promise<{ id: string; user_id: string } | null> {
    const rows = await tx.query<{ id: string; user_id: string }>(
      'select id, user_id from group_leaders where group_id = $1 and valid_to is null',
      [groupId],
    )
    return rows.rows[0] ?? null
  }

  /** 結束舊組長列、插入新組長列（同一交易；部分唯一保證同時最多一位）。 */
  async #replaceLeader(
    tx: PoolClient,
    groupId: string,
    currentLeaderRowId: string | null,
    newLeaderId: string,
    adminId: string,
    reason: string,
    realAt: Date,
    businessNow: Date,
  ): Promise<void> {
    if (currentLeaderRowId) {
      await tx.query('update group_leaders set valid_to = greatest(valid_from, $2) where id = $1', [
        currentLeaderRowId,
        businessNow,
      ])
    }
    await tx.query(
      `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, reason, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv7(), groupId, newLeaderId, businessNow, adminId, reason, realAt],
    )
  }

  async #bumpGroup(tx: PoolClient, groupId: string, adminId: string, realAt: Date): Promise<number> {
    const rows = await tx.query<{ revision: number }>(
      `update groups set revision = revision + 1, updated_at = $2, updated_by_user_id = $3 where id = $1 returning revision`,
      [groupId, realAt, adminId],
    )
    return rows.rows[0]!.revision
  }

  // ── 到期（背景工作呼叫） ─────────────────────────────────────────────────────

  async expire(proposalId: string, deadlineVersion: number): Promise<ExpireOutcome> {
    if (!isUuid(proposalId)) return 'not_found'
    const businessNow = await this.#businessClock.now()

    const client = await this.#pool().connect()
    try {
      await client.query('begin')
      const outcome = await this.#expireLocked(client, proposalId, deadlineVersion, businessNow)
      await client.query('commit')
      return outcome
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async #expireLocked(
    tx: PoolClient,
    proposalId: string,
    deadlineVersion: number | null,
    businessNow: Date,
    closer: Closer = { kind: 'worker' },
  ): Promise<ExpireOutcome> {
    const locked = await this.#lockProposal(tx, proposalId)
    if (!locked) return 'not_found'
    const { proposal, invitations } = locked
    if (proposal.state !== 'open') return 'not_open'
    if (deadlineVersion !== null && proposal.deadline_version !== deadlineVersion) return 'stale_version'
    if (businessNow.getTime() < proposal.expires_business_at.getTime()) return 'not_due'

    await this.#terminate(tx, proposal, invitations.map((i) => i.user_id), {
      kind: 'expired',
      closer,
      realAt: this.#realClock.now(),
      businessAt: businessNow,
    })
    return 'expired'
  }

  /** 發起前：這些人若被「已過期、還沒被背景工作收掉」的提案占住，先把那些提案以逾期終止。 */
  async #expireOverdueOccupying(tx: PoolClient, userIds: string[], businessNow: Date): Promise<void> {
    const overdue = await tx.query<{ proposal_id: string }>(
      `select distinct o.proposal_id from proposal_occupancy o
         join group_proposals p on p.id = o.proposal_id
        where o.user_id = any($1::uuid[]) and p.state = 'open' and p.expires_business_at <= $2
        order by o.proposal_id`,
      [userIds, businessNow],
    )
    for (const row of overdue.rows) {
      await this.#expireLocked(tx, row.proposal_id, null, businessNow, { kind: 'system' })
    }
  }

  // ── 共用 ────────────────────────────────────────────────────────────────────

  /**
   * 整份終止：本人那一列標拒絕／撤回，其他還在等或已確認的轉「釋放」（不覆寫他們的確認時間），
   * 提案轉終止、占用全刪、到期工作取消、提案人與全部被邀請者各一則終止通知（事件層去重）。
   */
  async #terminate(
    tx: PoolClient,
    proposal: ProposalRow,
    everyone: string[],
    change: {
      kind: TerminationKind
      closer: Closer
      own?: { userId: string; state: 'declined' | 'withdrawn' }
      reason?: string
      realAt: Date
      businessAt: Date
    },
  ): Promise<void> {
    const { kind, closer, own, realAt, businessAt } = change
    if (own) {
      await tx.query(
        `update proposal_invitations set state = $3, decided_real_at = $4 where proposal_id = $1 and user_id = $2`,
        [proposal.id, own.userId, own.state, realAt],
      )
    }
    await tx.query(
      `update proposal_invitations set state = 'released'
        where proposal_id = $1 and state in ('pending','confirmed')`,
      [proposal.id],
    )
    const closedByUser = closer.kind === 'user' ? closer.userId : null
    await tx.query(
      `update group_proposals
          set state = 'terminated', termination_kind = $2, reason = $3, closed_real_at = $4, closed_business_at = $5,
              closed_by_kind = $6, closed_by_user_id = $7, revision = revision + 1, updated_at = $4
        where id = $1`,
      [proposal.id, kind, change.reason ?? null, realAt, businessAt, closer.kind, closedByUser],
    )
    await tx.query('delete from proposal_occupancy where proposal_id = $1', [proposal.id])
    await this.#dueWork.cancel(tx, {
      kind: DUE_KIND,
      subject: { type: SUBJECT_TYPE, id: proposal.id },
      deadlineVersion: proposal.deadline_version,
    })
    await this.#events.publish(tx, {
      type: 'proposal.terminated',
      scope: 'cohort',
      cohortId: proposal.cohort_id,
      source: { type: SUBJECT_TYPE, id: proposal.id, version: null },
      actor: closer.kind === 'user' ? { kind: 'user', userId: closer.userId } : { kind: closer.kind },
      recipients: [proposal.proposer_user_id, ...everyone],
      recipientBasis: { proposalId: proposal.id, basis: 'proposal_invitations' },
      // 管理員作廢的理由不進 payload：學生的通知只說「管理員作廢」。
      payload: {
        title: `分組提案已終止（${TERMINATION_KIND_LABEL[kind]}），所有人都已釋放`,
        proposalId: proposal.id,
        terminationKind: kind,
      },
      occurredRealAt: realAt,
      occurredBusinessAt: businessAt,
    })
    await this.#audit.append(tx, {
      actorKind: closer.kind,
      actorUserId: closedByUser,
      role: closer.kind === 'user' ? closer.role : null,
      action: 'group.proposal.terminate',
      targetType: SUBJECT_TYPE,
      targetId: proposal.id,
      scope: 'cohort',
      cohortId: proposal.cohort_id,
      reason: change.reason ?? null,
      realAt,
      businessAt,
      payload: { terminationKind: kind, memberUserIds: everyone },
    })
  }

  async #shareCohort(tx: PoolClient, cohortId: string): Promise<CohortRow | null> {
    const found = await tx.query<CohortRow>(
      `select id, code, status, group_size_min, group_size_max, proposal_default_days
         from cohorts where id = $1 for share`,
      [cohortId],
    )
    return found.rows[0] ?? null
  }

  /** 鎖順序：屆別 FOR SHARE → 提案 FOR UPDATE → 邀請列 FOR UPDATE。 */
  async #lockProposal(
    tx: PoolClient,
    proposalId: string,
  ): Promise<{ proposal: ProposalRow; invitations: InvitationRow[]; cohortStatus: CohortStatus } | null> {
    const owner = await tx.query<{ cohort_id: string }>('select cohort_id from group_proposals where id = $1', [proposalId])
    const cohortId = owner.rows[0]?.cohort_id
    if (!cohortId) return null
    const cohort = await tx.query<{ status: CohortStatus }>('select status from cohorts where id = $1 for share', [cohortId])
    const found = await tx.query<ProposalRow>(
      `select id, cohort_id, proposer_user_id, group_type, expires_business_at, state, termination_kind,
              deadline_version, established_group_id
         from group_proposals where id = $1 for update`,
      [proposalId],
    )
    const proposal = found.rows[0]
    if (!proposal) return null
    const invitations = await tx.query<InvitationRow>(
      'select user_id, state from proposal_invitations where proposal_id = $1 order by user_id for update',
      [proposalId],
    )
    return { proposal, invitations: invitations.rows, cohortStatus: cohort.rows[0]?.status ?? 'archived' }
  }

  async #activeMembers(tx: PoolClient, cohortId: string, userIds: string[]): Promise<string[]> {
    const rows = await tx.query<{ user_id: string }>(
      `select user_id from group_memberships
        where cohort_id = $1 and user_id = any($2::uuid[]) and valid_to is null`,
      [cohortId, userIds],
    )
    return rows.rows.map((r) => r.user_id)
  }

  async #groupCode(tx: PoolClient, groupId: string): Promise<string | null> {
    const rows = await tx.query<{ code: string }>('select code from groups where id = $1', [groupId])
    return rows.rows[0]?.code ?? null
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'groups', body, (constraint) =>
      constraint === 'group_memberships_one_active'
        ? err('ALREADY_MEMBER', '有成員剛剛已經加入別的組，請重新整理頁面。')
        : err('CONFLICT', '剛剛有人同時修改了這份提案，請重新整理頁面再試一次。'),
    )
  }
}

// ── 查詢 ──────────────────────────────────────────────────────────────────────

type ProposalListRow = {
  id: string
  cohort_id: string
  group_type: GroupType
  state: ProposalState
  proposer_user_id: string
  proposer_name: string
  expires_business_at: Date
  created_business_at: Date
  closed_business_at: Date | null
  termination_kind: TerminationKind | null
  reason: string | null
  group_code: string | null
}

type InvitationListRow = {
  proposal_id: string
  user_id: string
  name: string
  student_no: string | null
  state: InvitationState
  decided_real_at: Date | null
}

const PROPOSAL_SELECT = `
  select p.id, p.cohort_id, p.group_type, p.state, p.proposer_user_id,
         ${personName('pp', 'pu')} as proposer_name,
         p.expires_business_at, p.created_business_at, p.closed_business_at, p.termination_kind, p.reason,
         g.code as group_code
    from group_proposals p
    join users pu on pu.id = p.proposer_user_id
    left join user_profiles pp on pp.user_id = p.proposer_user_id
    left join groups g on g.id = p.established_group_id`

export class PgGroupQuery implements GroupQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  async studentView(userId: string, cohortId: string): Promise<StudentGroupView> {
    const db = this.#reader()
    const membership = await db.query<{ group_id: string }>(
      `select group_id from group_memberships where user_id = $1 and cohort_id = $2 and valid_to is null`,
      [userId, cohortId],
    )
    const groupId = membership.rows[0]?.group_id
    const group = groupId ? ((await this.#groups(`g.id = $1`, [groupId], false))[0] ?? null) : null

    const mine = await this.#proposals(
      `where p.cohort_id = $1 and exists (select 1 from proposal_invitations i where i.proposal_id = p.id and i.user_id = $2)
       order by p.created_real_at desc limit 20`,
      [cohortId, userId],
      false,
    )
    const profile = await db.query<{ open_to_join: boolean }>('select open_to_join from user_profiles where user_id = $1', [userId])

    return {
      cohortId,
      group,
      openProposal: mine.find((p) => p.state === 'open') ?? null,
      history: mine.filter((p) => p.state !== 'open'),
      openToJoin: profile.rows[0]?.open_to_join ?? false,
    }
  }

  async teammates(actor: ResolvedActor, cohortId: string): Promise<TeammateListing[]> {
    if (!isUuid(cohortId) || !canViewTeammates(actor, cohortId)) return []
    const viewer = actor.kind === 'authenticated' ? actor.userId : null
    const rows = await this.#reader().query<{ name: string; student_no: string; contact_email: string }>(
      // 人名一律走 `personName`：display_name 是空字串時退回帳號名稱（票 13、14 審查建議），名單不會出現空名字。
      `select ${personName('p', 'u')} as name, p.student_no, p.contact_email
         from user_profiles p
         join users u on u.id = p.user_id
        where p.cohort_id = $1 and p.open_to_join and p.student_no is not null
          and u.status = 'active' and u.deidentified_at is null
          and ($2::uuid is null or u.id <> $2)
          and exists (select 1 from role_assignments r
                       where r.user_id = u.id and r.role = 'student' and r.revoked_real_at is null)
          and not exists (select 1 from group_memberships m
                           where m.user_id = u.id and m.cohort_id = $1 and m.valid_to is null)
        order by p.student_no`,
      [cohortId, viewer],
    )
    // 白名單三欄：就算上面的 SQL 被改成多選幾欄，也不會流到畫面。
    return rows.rows.map((r) => ({ name: r.name, studentNo: r.student_no, contactEmail: r.contact_email }))
  }

  async overview(cohortId: string): Promise<CohortGroupingOverview> {
    if (!isUuid(cohortId)) return { groups: [], openProposals: [], closedProposals: [], ungrouped: [] }
    const groups = await this.#groups(`g.cohort_id = $1 and g.status = 'active'`, [cohortId], true)
    const openProposals = await this.#proposals(`where p.cohort_id = $1 and p.state = 'open' order by p.expires_business_at`, [cohortId], true)
    const closedProposals = await this.#proposals(
      `where p.cohort_id = $1 and p.state = 'terminated' order by p.closed_real_at desc limit 20`,
      [cohortId],
      true,
    )
    const ungrouped = await this.#reader().query<{ name: string; student_no: string; open_to_join: boolean; in_proposal: boolean }>(
      `select ${personName('p', 'u')} as name, p.student_no, p.open_to_join,
              exists (select 1 from proposal_occupancy o where o.user_id = u.id) as in_proposal
         from user_profiles p
         join users u on u.id = p.user_id
        where p.cohort_id = $1 and p.student_no is not null
          and u.status = 'active' and u.deidentified_at is null
          and exists (select 1 from role_assignments r
                       where r.user_id = u.id and r.role = 'student' and r.revoked_real_at is null)
          and not exists (select 1 from group_memberships m
                           where m.user_id = u.id and m.cohort_id = $1 and m.valid_to is null)
        order by p.student_no`,
      [cohortId],
    )
    return {
      groups,
      openProposals,
      closedProposals,
      ungrouped: ungrouped.rows.map(
        (r): UngroupedStudent => ({ name: r.name, studentNo: r.student_no, openToJoin: r.open_to_join, inProposal: r.in_proposal }),
      ),
    }
  }

  async cohortGroups(cohortId: string): Promise<GroupSummary[]> {
    if (!isUuid(cohortId)) return []
    return this.#groups(`g.cohort_id = $1 and g.status = 'active'`, [cohortId], false)
  }

  async teacherOptions(): Promise<TeacherOption[]> {
    const rows = await this.#reader().query<{ user_id: string; name: string; email: string }>(
      `select u.id as user_id, ${personName('p', 'u')} as name, u.email
         from users u
         left join user_profiles p on p.user_id = u.id
        where u.status = 'active' and u.deidentified_at is null
          and exists (select 1 from role_assignments r
                       where r.user_id = u.id and r.role = 'teacher' and r.revoked_real_at is null)
        order by name, u.email`,
    )
    return rows.rows.map((r) => ({ userId: r.user_id, name: r.name, loginEmail: r.email }))
  }

  async advisedGroupCount(teacherUserId: string): Promise<number> {
    if (!isUuid(teacherUserId)) return 0
    const rows = await this.#reader().query<{ n: string }>(
      `select count(*) as n
         from advisor_assignments a
         join groups g on g.id = a.group_id
         join cohorts c on c.id = g.cohort_id
        where a.teacher_user_id = $1 and a.valid_to is null and g.status = 'active' and c.status <> 'archived'`,
      [teacherUserId],
    )
    return Number(rows.rows[0]?.n ?? 0)
  }

  /** `forAdmin`：歷程帶理由與操作的管理員；學生看的一律不帶（和作廢理由同一政策）。 */
  async #groups(where: string, values: unknown[], forAdmin: boolean): Promise<GroupSummary[]> {
    const db = this.#reader()
    const groups = await db.query<{
      id: string
      cohort_id: string
      code: string
      group_type: GroupType
      established_business_at: Date
      revision: number
    }>(
      `select g.id, g.cohort_id, g.code, g.group_type, g.established_business_at, g.revision
         from groups g where ${where} order by g.code`,
      values,
    )
    if (groups.rows.length === 0) return []
    const ids = groups.rows.map((g) => g.id)
    const members = await db.query<{
      group_id: string
      user_id: string
      name: string
      student_no: string | null
      is_leader: boolean
      login_email: string | null
    }>(
      // 登入信箱（票 20 複製本組信箱、匯出）只在管理員的查詢裡 select；學生與老師的查詢連這一欄都不讀。
      `select m.group_id, m.user_id, ${personName('p', 'u')} as name, p.student_no,
              exists (select 1 from group_leaders l
                       where l.group_id = m.group_id and l.user_id = m.user_id and l.valid_to is null) as is_leader,
              ${forAdmin ? 'u.email' : 'null::text'} as login_email
         from group_memberships m
         join users u on u.id = m.user_id
         left join user_profiles p on p.user_id = m.user_id
        where m.group_id = any($1::uuid[]) and m.valid_to is null
        order by is_leader desc, p.student_no`,
      [ids],
    )
    const advisors = await db.query<{
      group_id: string
      teacher_user_id: string
      teacher_name: string
      source: AdvisorSource
      valid_from: Date
    }>(
      `select a.group_id, a.teacher_user_id, ${personName('p', 'u')} as teacher_name,
              a.source, a.valid_from
         from advisor_assignments a
         join users u on u.id = a.teacher_user_id
         left join user_profiles p on p.user_id = a.teacher_user_id
        where a.group_id = any($1::uuid[]) and a.valid_to is null`,
      [ids],
    )
    const advisorOf = new Map(
      advisors.rows.map((a) => [
        a.group_id,
        { teacherUserId: a.teacher_user_id, teacherName: a.teacher_name, source: a.source, since: a.valid_from },
      ]),
    )
    // 目前連結的合作案（票 20）：只帶名稱（公司＋部門，登入者可見的公開欄位）與狀態。
    const links = await db.query<{
      group_id: string
      link_id: string
      opportunity_id: string
      company_name: string
      department: string
      status: OpportunityStatus
    }>(
      `select l.group_id, l.id as link_id, o.id as opportunity_id, o.company_name, o.department, o.status
         from opportunity_links l
         join industry_opportunities o on o.id = l.opportunity_id
        where l.group_id = any($1::uuid[]) and l.valid_to is null`,
      [ids],
    )
    const linkOf = new Map(
      links.rows.map((l) => [
        l.group_id,
        {
          linkId: l.link_id,
          opportunityId: l.opportunity_id,
          name: opportunityName({ companyName: l.company_name, department: l.department }),
          status: l.status,
        },
      ]),
    )
    const history = await this.#history(ids, forAdmin)
    return groups.rows.map((g) => ({
      id: g.id,
      cohortId: g.cohort_id,
      code: g.code,
      groupType: g.group_type,
      establishedBusinessAt: g.established_business_at,
      revision: g.revision,
      members: members.rows
        .filter((m) => m.group_id === g.id)
        .map((m) => ({
          userId: m.user_id,
          name: m.name,
          studentNo: m.student_no,
          isLeader: m.is_leader,
          loginEmail: forAdmin ? m.login_email : null,
        })),
      advisor: advisorOf.get(g.id) ?? null,
      opportunity: linkOf.get(g.id) ?? null,
      history: history.get(g.id) ?? [],
    }))
  }

  /**
   * 組別歷程：成立後的組員加入／移出（`group_memberships`）與組長更換（`group_leaders` 第二列起）。
   * 依真實時間排序（業務鐘可能被撥回，用它排會亂）。`group_memberships` 沒有「加入理由」欄（票 14 不加 migration），
   * 所以管理員加入的理由記在稽核（`audit_events.reason`，payload 帶 membershipId），
   * 「這筆是成立後由管理員加入的」也以那筆稽核為準；移出理由在 `removal_reason`、換組長理由在 `group_leaders.reason`。
   */
  async #history(groupIds: string[], forAdmin: boolean): Promise<Map<string, GroupHistoryEntry[]>> {
    const db = this.#reader()
    const memberships = await db.query<{
      group_id: string
      name: string
      valid_from: Date
      valid_to: Date | null
      created_at: Date
      updated_at: Date
      added_after_establish: boolean
      added_by_name: string | null
      add_reason: string | null
      removal_reason: string | null
      removed_by_name: string | null
    }>(
      `select m.group_id, ${personName('p', 'u')} as name, m.valid_from, m.valid_to, m.created_at, m.updated_at,
              exists (select 1 from audit_events a
                       where a.target_type = 'group' and a.target_id = m.group_id and a.action = 'group.member.add'
                         and a.payload->>'membershipId' = m.id::text) as added_after_establish,
              ${personName('ap', 'au')} as added_by_name,
              m.removal_reason,
              (select a.reason from audit_events a
                where a.target_type = 'group' and a.target_id = m.group_id and a.action = 'group.member.add'
                  and a.payload->>'membershipId' = m.id::text
                limit 1) as add_reason,
              (select ${personName('rp', 'ru')} from audit_events a
                 join users ru on ru.id = a.actor_user_id
                 left join user_profiles rp on rp.user_id = ru.id
                where a.target_type = 'group' and a.target_id = m.group_id and a.action = 'group.member.remove'
                  and a.payload->>'membershipId' = m.id::text
                limit 1) as removed_by_name
         from group_memberships m
         join users u on u.id = m.user_id
         left join user_profiles p on p.user_id = m.user_id
         left join users au on au.id = m.added_by_user_id
         left join user_profiles ap on ap.user_id = m.added_by_user_id
        where m.group_id = any($1::uuid[])`,
      [groupIds],
    )
    const leaders = await db.query<{
      group_id: string
      name: string
      valid_from: Date
      created_at: Date
      reason: string | null
      by_name: string | null
    }>(
      `select l.group_id, ${personName('p', 'u')} as name, l.valid_from, l.created_at, l.reason,
              ${personName('bp', 'bu')} as by_name
         from group_leaders l
         join users u on u.id = l.user_id
         left join user_profiles p on p.user_id = l.user_id
         left join users bu on bu.id = l.changed_by_user_id
         left join user_profiles bp on bp.user_id = l.changed_by_user_id
        where l.group_id = any($1::uuid[])
        order by l.group_id, l.created_at, l.id`,
      [groupIds],
    )

    const entries = new Map<string, { sortKey: number; entry: GroupHistoryEntry }[]>()
    // 票 20 加的兩欄（類型變更前後、換案前的合作案）只有自己的種類會帶；其他種類一律 null。
    type EntryInput = Omit<GroupHistoryEntry, 'groupTypes' | 'previousOpportunityName'> &
      Partial<Pick<GroupHistoryEntry, 'groupTypes' | 'previousOpportunityName'>>
    const push = (groupId: string, sortKey: Date, input: EntryInput) => {
      const entry: GroupHistoryEntry = { groupTypes: null, previousOpportunityName: null, ...input }
      const list = entries.get(groupId) ?? []
      list.push({ sortKey: sortKey.getTime(), entry })
      entries.set(groupId, list)
    }
    const admin = <T>(value: T): T | null => (forAdmin ? value : null)

    for (const m of memberships.rows) {
      if (m.added_after_establish) {
        push(m.group_id, m.created_at, {
          kind: 'member_added',
          at: m.valid_from,
          userName: m.name,
          previousLeaderName: null,
          previousAdvisorName: null,
          byName: admin(m.added_by_name),
          reason: admin(m.add_reason),
        })
      }
      if (m.valid_to) {
        push(m.group_id, m.updated_at, {
          kind: 'member_removed',
          at: m.valid_to,
          userName: m.name,
          previousLeaderName: null,
          previousAdvisorName: null,
          byName: admin(m.removed_by_name),
          reason: admin(m.removal_reason),
        })
      }
    }
    // 第一列是成立時的組長（提案人），不算「更換」。
    let previous: { groupId: string; name: string } | null = null
    for (const l of leaders.rows) {
      if (previous && previous.groupId === l.group_id) {
        push(l.group_id, l.created_at, {
          kind: 'leader_changed',
          at: l.valid_from,
          userName: l.name,
          previousLeaderName: previous.name,
          previousAdvisorName: null,
          byName: admin(l.by_name),
          reason: admin(l.reason),
        })
      }
      previous = { groupId: l.group_id, name: l.name }
    }

    // 主指導（票 19）：每一列的開始是一次指派（首次、認領或重派）；重派的新列用 `previous_assignment_id`
    // 指向它接手的那一列。結束了、又沒有被任何一列接手的，就是被解除。
    const advisors = await db.query<{
      id: string
      group_id: string
      name: string
      source: AdvisorSource
      valid_from: Date
      valid_to: Date | null
      created_at: Date
      ended_real_at: Date | null
      previous_assignment_id: string | null
      reason: string | null
      end_reason: string | null
      by_name: string | null
      ended_by_name: string | null
    }>(
      `select a.id, a.group_id, ${personName('p', 'u')} as name, a.source,
              a.valid_from, a.valid_to, a.created_at, a.ended_real_at, a.previous_assignment_id, a.reason, a.end_reason,
              ${personName('bp', 'bu')} as by_name,
              ${personName('ep', 'eu')} as ended_by_name
         from advisor_assignments a
         join users u on u.id = a.teacher_user_id
         left join user_profiles p on p.user_id = a.teacher_user_id
         left join users bu on bu.id = a.assigned_by_user_id
         left join user_profiles bp on bp.user_id = a.assigned_by_user_id
         left join users eu on eu.id = a.ended_by_user_id
         left join user_profiles ep on ep.user_id = a.ended_by_user_id
        where a.group_id = any($1::uuid[])`,
      [groupIds],
    )
    const advisorName = new Map(advisors.rows.map((a) => [a.id, a.name]))
    const replacedIds = new Set(advisors.rows.map((a) => a.previous_assignment_id).filter((id): id is string => id !== null))
    for (const a of advisors.rows) {
      push(a.group_id, a.created_at, {
        kind: 'advisor_assigned',
        at: a.valid_from,
        userName: a.name,
        previousLeaderName: null,
        previousAdvisorName: a.previous_assignment_id ? (advisorName.get(a.previous_assignment_id) ?? null) : null,
        // 認領是老師自己：「誰操作」就是他本人，不另外列。
        byName: a.source === 'claim' ? null : admin(a.by_name),
        reason: admin(a.reason),
      })
      if (a.valid_to && a.ended_real_at && !replacedIds.has(a.id)) {
        push(a.group_id, a.ended_real_at, {
          kind: 'advisor_removed',
          at: a.valid_to,
          userName: a.name,
          previousLeaderName: null,
          previousAdvisorName: null,
          byName: admin(a.ended_by_name),
          reason: admin(a.end_reason),
        })
      }
    }

    // 組別類型變更（票 20）：沒有歷史表（不加 migration），事實記在稽核 `group.type.change`（payload 帶前後類型）。
    // 組長自己改的，操作者就是組長本人，學生也看得到是誰改的；系辦改的只在管理員的查詢裡帶名字與理由。
    const typeChanges = await db.query<{
      group_id: string
      from_type: GroupType
      to_type: GroupType
      business_at: Date
      real_at: Date
      role: string | null
      actor_name: string | null
      reason: string | null
    }>(
      `select a.target_id as group_id, a.payload->>'from' as from_type, a.payload->>'to' as to_type,
              a.business_at, a.real_at, a.role, a.reason,
              ${personName('p', 'u')} as actor_name
         from audit_events a
         left join users u on u.id = a.actor_user_id
         left join user_profiles p on p.user_id = a.actor_user_id
        where a.target_type = 'group' and a.action = 'group.type.change' and a.target_id = any($1::uuid[])`,
      [groupIds],
    )
    for (const t of typeChanges.rows) {
      const byAdmin = t.role === 'admin'
      push(t.group_id, t.real_at, {
        kind: 'type_changed',
        at: t.business_at,
        userName: byAdmin ? '系辦' : (t.actor_name ?? ''),
        previousLeaderName: null,
        previousAdvisorName: null,
        byName: byAdmin ? admin(t.actor_name) : null,
        reason: admin(t.reason),
        groupTypes: { from: t.from_type, to: t.to_type },
      })
    }

    // 合作案連結（票 20）：每一列的開始是一次連結（首次或換案，換案的新列用 `previous_link_id` 指向舊列）；
    // 結束了、又沒有被任何一列接手的，就是被解除。和主指導同一套做法。
    const opportunityLinks = await db.query<{
      id: string
      group_id: string
      name: string
      valid_from: Date
      valid_to: Date | null
      created_at: Date
      ended_real_at: Date | null
      previous_link_id: string | null
      end_reason: string | null
      by_name: string | null
      ended_by_name: string | null
    }>(
      `select l.id, l.group_id, o.company_name || '・' || o.department as name, l.valid_from, l.valid_to, l.created_at,
              l.ended_real_at, l.previous_link_id, l.end_reason,
              ${personName('bp', 'bu')} as by_name,
              ${personName('ep', 'eu')} as ended_by_name
         from opportunity_links l
         join industry_opportunities o on o.id = l.opportunity_id
         left join users bu on bu.id = l.linked_by_user_id
         left join user_profiles bp on bp.user_id = l.linked_by_user_id
         left join users eu on eu.id = l.ended_by_user_id
         left join user_profiles ep on ep.user_id = l.ended_by_user_id
        where l.group_id = any($1::uuid[])`,
      [groupIds],
    )
    const linkName = new Map(opportunityLinks.rows.map((l) => [l.id, l.name]))
    const linkById = new Map(opportunityLinks.rows.map((l) => [l.id, l]))
    const replacedLinks = new Set(
      opportunityLinks.rows.map((l) => l.previous_link_id).filter((id): id is string => id !== null),
    )
    for (const l of opportunityLinks.rows) {
      const previous = l.previous_link_id ? linkById.get(l.previous_link_id) : undefined
      push(l.group_id, l.created_at, {
        kind: 'opportunity_linked',
        at: l.valid_from,
        userName: l.name,
        previousLeaderName: null,
        previousAdvisorName: null,
        byName: admin(l.by_name),
        // 換案的理由記在被結束的那一列（`end_reason`）。
        reason: admin(previous?.end_reason ?? null),
        previousOpportunityName: l.previous_link_id ? (linkName.get(l.previous_link_id) ?? null) : null,
      })
      if (l.valid_to && l.ended_real_at && !replacedLinks.has(l.id)) {
        push(l.group_id, l.ended_real_at, {
          kind: 'opportunity_unlinked',
          at: l.valid_to,
          userName: l.name,
          previousLeaderName: null,
          previousAdvisorName: null,
          byName: admin(l.ended_by_name),
          reason: admin(l.end_reason),
        })
      }
    }

    const result = new Map<string, GroupHistoryEntry[]>()
    for (const [groupId, list] of entries) {
      result.set(
        groupId,
        list.sort((a, b) => a.sortKey - b.sortKey).map((x) => x.entry),
      )
    }
    return result
  }

  async #proposals(tail: string, values: unknown[], withReason: boolean): Promise<ProposalSummary[]> {
    const db = this.#reader()
    const proposals = await db.query<ProposalListRow>(`${PROPOSAL_SELECT} ${tail}`, values)
    if (proposals.rows.length === 0) return []
    const invitations = await db.query<InvitationListRow>(
      `select i.proposal_id, i.user_id, ${personName('p', 'u')} as name, p.student_no, i.state, i.decided_real_at
         from proposal_invitations i
         join users u on u.id = i.user_id
         left join user_profiles p on p.user_id = i.user_id
        where i.proposal_id = any($1::uuid[])
        order by i.proposal_id, (i.user_id = (select proposer_user_id from group_proposals where id = i.proposal_id)) desc,
                 p.student_no`,
      [proposals.rows.map((p) => p.id)],
    )
    return proposals.rows.map((p) => ({
      id: p.id,
      cohortId: p.cohort_id,
      groupType: p.group_type,
      state: p.state,
      proposerUserId: p.proposer_user_id,
      proposerName: p.proposer_name,
      expiresBusinessAt: p.expires_business_at,
      createdBusinessAt: p.created_business_at,
      closedBusinessAt: p.closed_business_at,
      terminationKind: p.termination_kind,
      reason: withReason ? p.reason : null,
      establishedGroupCode: p.group_code,
      invitations: invitations.rows
        .filter((i) => i.proposal_id === p.id)
        .map((i) => ({ userId: i.user_id, name: i.name, studentNo: i.student_no, state: i.state, decidedRealAt: i.decided_real_at })),
    }))
  }
}
