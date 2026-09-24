import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import { groupingDeadline, stagePositionAt, type BusinessClockSource, type CohortStatus } from '@/application/cohorts'
import {
  canManageOpportunity,
  canViewOpportunities,
  GROUP_TYPE_LABEL,
  isUuid,
  leaderTypeChangeBlockers,
  normalizeLinkReason,
  normalizeOpportunityInput,
  normalizeReason,
  opportunityName,
  opportunitySummary,
  parseGroupType,
  type ChangeGroupTypeInput,
  type CreateOpportunityInput,
  type GroupingPeriodState,
  type GroupOpportunityLink,
  type GroupType,
  type GroupTypeReceipt,
  type LeaderPanel,
  type LinkedGroupRef,
  type LinkOpportunityInput,
  type LinkReceipt,
  type ManagedOpportunity,
  type NormalizedOpportunity,
  type NotesVisibility,
  type OpportunityAction,
  type OpportunityCard,
  type OpportunityCommand,
  type OpportunityListFilter,
  type OpportunityPage,
  type OpportunityQuery,
  type OpportunityReceipt,
  type OpportunityStatus,
  type OpportunityStatusInput,
  type UnlinkOpportunityInput,
  type UpdateOpportunityInput,
} from '@/application/groups'
import { sanitizeBody } from '@/application/items'
import type { EventPublisher } from '@/application/notifications'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import { badRequestId, inTransaction, replayed, staleRevision, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { personName } from '@/infrastructure/db/person-name'
import { loadSchedule } from '@/infrastructure/groups/pg-groups'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 產學合作案、組別連結與組別類型變更（票 20；產品模組 03 §4「5.3」「6.1–6.3」；模組實作設計 03 §5）。
 *
 * 寫入的形狀同分組其他用例（契約 01 §8）：業務時間在開交易前讀一次 → 開交易 → 鎖 → 帳本 `begin` → 業務寫入
 * → 事件、稽核 → 帳本 `commit`。
 *
 * - 合作案本身不屬於任何一屆（`scope='global'`）；連結與類型變更屬於組別那一屆（`scope='cohort'`）。
 * - 鎖順序照分組：`cohorts FOR SHARE` → `groups FOR NO KEY UPDATE` → `industry_opportunities FOR SHARE`。
 *   連結、換案、解除、改類型都把組別版本加一：組長畫面上的「改類型」「換案」帶著版本，別人先動過就 `CONFLICT`。
 * - 一組同時最多連一案由資料庫守（`opportunity_links_one_active` 部分唯一）；組別列鎖是第一道，部分唯一是後備。
 *
 * 可見性由**查詢層**守（6.2）：列表與一般的詳情查詢根本不 select 地址、聯絡人、電話、Email 與內部備註；
 * 只有看的人是案主或系辦時，才另外發一次 select 把私有欄位讀出來。正文照老師打的字存，輸出前一律經
 * `sanitizeBody`（純文字轉段落並逃逸；有標籤就照公告正文的白名單清洗）。
 */

type OpportunityRow = {
  id: string
  owner_teacher_user_id: string
  owner_name: string
  company_name: string
  department: string
  content: string
  requirements: string
  /** 公開查詢：備註是內部的就是 null（SQL 裡就擋掉）。 */
  notes: string | null
  notes_visibility: NotesVisibility
  status: OpportunityStatus
  published_business_at: Date | null
  withdrawn_business_at: Date | null
  revision: number
  linked_count: string
}

type PrivateRow = {
  notes: string | null
  address: string | null
  contact_name: string | null
  contact_phone: string | null
  contact_email: string | null
}

type GroupRow = {
  id: string
  cohort_id: string
  code: string
  group_type: GroupType
  status: 'active' | 'dissolved'
  revision: number
}

type CohortRow = { id: string; code: string; status: CohortStatus }

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

/**
 * 公開欄位（登入者可見）。**不含**地址、聯絡人、電話、Email；備註只有「登入者可見」的才帶出來。
 * 所有對「看的人不一定是案主」的查詢都只用這一段。
 */
const PUBLIC_SELECT = `
  select o.id, o.owner_teacher_user_id, ${personName('p', 'u')} as owner_name,
         o.company_name, o.department, o.content, o.requirements,
         case when o.notes_visibility = 'signed_in' then o.notes end as notes,
         o.notes_visibility, o.status, o.published_business_at, o.withdrawn_business_at, o.revision,
         (select count(*) from opportunity_links l where l.opportunity_id = o.id and l.valid_to is null) as linked_count
    from industry_opportunities o
    join users u on u.id = o.owner_teacher_user_id
    left join user_profiles p on p.user_id = o.owner_teacher_user_id`

function notFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個合作案，請重新整理頁面。')
}

function groupNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個組別，請重新整理頁面。')
}

/** 能用業務功能的帳號（帳號狀態閘門）。 */
function gate(actor: ResolvedActor): Err | null {
  const blocked = statusGate(actor, 'business')
  return blocked ? err(blocked, '請先登入並完成帳號設定。') : null
}

function isAdminActor(actor: ResolvedActor): boolean {
  return actor.kind === 'authenticated' && actor.roles.includes('admin')
}

function roleOf(actor: ResolvedActor): 'student' | 'teacher' | 'admin' {
  if (isAdminActor(actor)) return 'admin'
  return actor.kind === 'authenticated' && actor.roles.includes('teacher') ? 'teacher' : 'student'
}

function safeHtml(text: string): string {
  return text.trim() === '' ? '' : sanitizeBody(text)
}

function toCard(row: OpportunityRow): OpportunityCard {
  return {
    id: row.id,
    companyName: row.company_name,
    department: row.department,
    summary: opportunitySummary(row.content),
    ownerUserId: row.owner_teacher_user_id,
    ownerName: row.owner_name,
    status: row.status,
    publishedAt: row.published_business_at,
    linkedGroupCount: Number(row.linked_count),
  }
}

export class PgOpportunityCommand implements OpportunityCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#events = deps.events
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  // ── 合作案本身 ──────────────────────────────────────────────────────────────

  async create(actor: ResolvedActor, input: CreateOpportunityInput, requestId: string): Promise<Result<OpportunityReceipt>> {
    const blocked = gate(actor)
    if (blocked) return blocked
    if (actor.kind !== 'authenticated' || !actor.roles.includes('teacher')) {
      return err('FORBIDDEN', '只有老師可以建立合作案（負責老師由登入帳號帶入）。')
    }
    if (!isUuid(requestId)) return badRequestId()
    const normalized = normalizeOpportunityInput(input)
    if (!normalized.ok) return normalized
    const fields = normalized.value
    const publish = input.publish === true
    const teacherId = actor.userId
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: teacherId,
          operationKind: 'opportunity.create',
          requestId,
          fingerprint: sha256(canonicalJson({ ...fields, publish })),
          scope: 'global',
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<OpportunityReceipt>(begun)

      const id = uuidv7()
      const status: OpportunityStatus = publish ? 'published' : 'draft'
      await tx.query(
        `insert into industry_opportunities
           (id, owner_teacher_user_id, company_name, department, content, requirements, notes, notes_visibility,
            address, contact_name, contact_phone, contact_email, status, published_business_at, revision,
            created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $15, 'user', $2, $15, $2)`,
        [
          id,
          teacherId,
          fields.companyName,
          fields.department,
          fields.content,
          fields.requirements,
          fields.notes,
          fields.notesVisibility,
          fields.address,
          fields.contactName,
          fields.contactPhone,
          fields.contactEmail,
          status,
          publish ? businessNow : null,
          realAt,
        ],
      )
      if (publish) await this.#publishedEvent(tx, id, 1, teacherId, realAt, businessNow)
      await this.#auditOpportunity(tx, actor, 'opportunity.create', id, realAt, businessNow, { status })
      const receipt = this.#receipt(id, fields, 'created', status, 1, requestId, realAt)
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { opportunityId: id } })
      return { ok: true as const, receipt }
    })
  }

  async update(actor: ResolvedActor, input: UpdateOpportunityInput, requestId: string): Promise<Result<OpportunityReceipt>> {
    const blocked = gate(actor)
    if (blocked) return blocked
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(String(input.opportunityId ?? ''))) return notFound()
    if (!Number.isInteger(input.revision)) return staleRevision()
    const normalized = normalizeOpportunityInput(input)
    if (!normalized.ok) return normalized
    const fields = normalized.value
    const actorId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const current = await this.#lockOpportunity(tx, input.opportunityId)
      if (!current) return notFound()
      if (!canManageOpportunity(actor, current.owner_teacher_user_id)) {
        return err('FORBIDDEN', '只有負責老師與系辦可以修改這個合作案。')
      }
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: actorId,
          operationKind: 'opportunity.update',
          requestId,
          fingerprint: sha256(canonicalJson({ id: current.id, revision: input.revision, ...fields })),
          scope: 'global',
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<OpportunityReceipt>(begun)
      if (current.revision !== input.revision) return staleRevision()
      if (current.status === 'withdrawn') {
        // 已連結的組員看到的是下架前發布的內容（6.3「看不到後續私有草稿」）；下架中改內容會讓他們看到沒發布過的版本。
        return err('VALIDATION_FAILED', '已下架的合作案不能修改；要改請先重新發布。')
      }

      const updated = await tx.query<{ revision: number }>(
        `update industry_opportunities
            set company_name = $2, department = $3, content = $4, requirements = $5, notes = $6, notes_visibility = $7,
                address = $8, contact_name = $9, contact_phone = $10, contact_email = $11,
                revision = revision + 1, updated_at = $12, updated_by_user_id = $13
          where id = $1 returning revision`,
        [
          current.id,
          fields.companyName,
          fields.department,
          fields.content,
          fields.requirements,
          fields.notes,
          fields.notesVisibility,
          fields.address,
          fields.contactName,
          fields.contactPhone,
          fields.contactEmail,
          realAt,
          actorId,
        ],
      )
      const revision = updated.rows[0]!.revision
      await this.#auditOpportunity(tx, actor, 'opportunity.update', current.id, realAt, businessNow, { revision })
      const receipt = this.#receipt(current.id, fields, 'updated', current.status, revision, requestId, realAt)
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { opportunityId: current.id } })
      return { ok: true as const, receipt }
    })
  }

  async publish(actor: ResolvedActor, input: OpportunityStatusInput, requestId: string): Promise<Result<OpportunityReceipt>> {
    return this.#changeStatus(actor, input, requestId, 'publish')
  }

  async withdraw(actor: ResolvedActor, input: OpportunityStatusInput, requestId: string): Promise<Result<OpportunityReceipt>> {
    return this.#changeStatus(actor, input, requestId, 'withdraw')
  }

  async #changeStatus(
    actor: ResolvedActor,
    input: OpportunityStatusInput,
    requestId: string,
    kind: 'publish' | 'withdraw',
  ): Promise<Result<OpportunityReceipt>> {
    const blocked = gate(actor)
    if (blocked) return blocked
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(String(input.opportunityId ?? ''))) return notFound()
    if (!Number.isInteger(input.revision)) return staleRevision()
    const actorId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const current = await this.#lockOpportunity(tx, input.opportunityId)
      if (!current) return notFound()
      if (!canManageOpportunity(actor, current.owner_teacher_user_id)) {
        return err('FORBIDDEN', `只有負責老師與系辦可以${kind === 'publish' ? '發布' : '下架'}這個合作案。`)
      }
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: actorId,
          operationKind: `opportunity.${kind}`,
          requestId,
          fingerprint: sha256(canonicalJson({ id: current.id, revision: input.revision })),
          scope: 'global',
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<OpportunityReceipt>(begun)
      if (current.revision !== input.revision) return staleRevision()

      let action: OpportunityAction
      let status: OpportunityStatus
      if (kind === 'publish') {
        if (current.status === 'published') return err('VALIDATION_FAILED', '這個合作案已經在發布中。')
        action = current.status === 'withdrawn' ? 'republished' : 'published'
        status = 'published'
      } else {
        if (current.status !== 'published') return err('VALIDATION_FAILED', '只有發布中的合作案可以下架。')
        action = 'withdrawn'
        status = 'withdrawn'
      }
      const updated = await tx.query<{ revision: number }>(
        `update industry_opportunities
            set status = $2,
                published_business_at = case when $2 = 'published' then $3 else published_business_at end,
                withdrawn_business_at = case when $2 = 'withdrawn' then $3 else withdrawn_business_at end,
                revision = revision + 1, updated_at = $4, updated_by_user_id = $5
          where id = $1 returning revision`,
        [current.id, status, businessNow, realAt, actorId],
      )
      const revision = updated.rows[0]!.revision
      if (status === 'published') {
        await this.#publishedEvent(tx, current.id, revision, actorId, realAt, businessNow)
      } else {
        await this.#events.publish(tx, {
          type: 'opportunity.withdrawn',
          scope: 'global',
          source: { type: 'industry_opportunity', id: current.id, version: revision },
          actor: { kind: 'user', userId: actorId },
          recipients: [],
          payload: { opportunityId: current.id },
          occurredRealAt: realAt,
          occurredBusinessAt: businessNow,
        })
      }
      await this.#auditOpportunity(tx, actor, `opportunity.${action === 'republished' ? 'republish' : kind}`, current.id, realAt, businessNow, {
        from: current.status,
        to: status,
        revision,
      })
      const receipt = this.#receipt(
        current.id,
        { companyName: current.company_name, department: current.department },
        action,
        status,
        revision,
        requestId,
        realAt,
      )
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { opportunityId: current.id } })
      return { ok: true as const, receipt }
    })
  }

  // ── 組別連結 ────────────────────────────────────────────────────────────────

  async link(actor: ResolvedActor, input: LinkOpportunityInput, requestId: string): Promise<Result<LinkReceipt>> {
    const blocked = gate(actor)
    if (blocked) return blocked
    if (actor.kind !== 'authenticated') return err('UNAUTHENTICATED', '請先登入。')
    const admin = isAdminActor(actor)
    if (!admin && !actor.roles.includes('student')) return err('FORBIDDEN', '只有組長或系辦可以連結合作案。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(String(input.groupId ?? ''))) return groupNotFound()
    if (!isUuid(String(input.opportunityId ?? ''))) return err('VALIDATION_FAILED', '請選要連結的合作案。', { details: { field: 'opportunityId' } })
    if (!Number.isInteger(input.revision)) return staleRevision()
    const actorId = actor.userId
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await lockGroup(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { group, cohort } = locked
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: actorId,
          operationKind: 'opportunity.link',
          requestId,
          fingerprint: sha256(
            canonicalJson({ groupId: group.id, revision: input.revision, opportunityId: input.opportunityId, reason: String(input.reason ?? '').trim() }),
          ),
          scope: 'cohort',
          cohortId: group.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<LinkReceipt>(begun)
      const closed = writeBlocked(cohort, group, '連結合作案')
      if (closed) return closed
      if (!admin && !(await isCurrentLeader(tx, group.id, actorId))) {
        return err('FORBIDDEN', '只有組長可以連結或更換合作案；請請組長操作。')
      }
      if (group.revision !== input.revision) return staleRevision()
      if (group.group_type !== 'industry') {
        return err('OPPORTUNITY_NOT_LINKABLE', `${group.code} 是一般專題，不能連結合作案；要改成產學合作請先改組別類型。`)
      }

      const target = await tx.query<{ id: string; owner_teacher_user_id: string; company_name: string; department: string; status: OpportunityStatus }>(
        `select id, owner_teacher_user_id, company_name, department, status from industry_opportunities where id = $1 for share`,
        [input.opportunityId],
      )
      const opportunity = target.rows[0]
      // 別人的草稿當作不存在（不透露草稿）；已下架的明講不收新連結。
      if (!opportunity || (opportunity.status === 'draft' && !admin)) return notFound()
      const name = opportunityName({ companyName: opportunity.company_name, department: opportunity.department })
      if (opportunity.status !== 'published') {
        return err('OPPORTUNITY_NOT_LINKABLE', `「${name}」${opportunity.status === 'withdrawn' ? '已下架，不接受新連結' : '還沒發布，不能連結'}。`)
      }

      const current = await activeLink(tx, group.id)
      if (current?.opportunity_id === opportunity.id) return err('VALIDATION_FAILED', `${group.code} 已經連結「${name}」了。`)
      let reason: string | null = null
      if (current) {
        const normalized = normalizeLinkReason(String(input.reason ?? ''), '換案')
        if (!normalized.ok) return normalized
        reason = normalized.value
        await endLink(tx, current.id, businessNow, realAt, actorId, reason)
      }
      const linkId = uuidv7()
      await tx.query(
        `insert into opportunity_links (id, group_id, opportunity_id, valid_from, linked_by_user_id, previous_link_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [linkId, group.id, opportunity.id, businessNow, actorId, current?.id ?? null, realAt],
      )
      const revision = await bumpGroup(tx, group.id, realAt, actorId)
      const memberIds = await activeMemberIds(tx, group.id)
      const common = {
        scope: 'cohort' as const,
        cohortId: group.cohort_id,
        source: { type: 'industry_opportunity', id: opportunity.id, version: revision },
        actor: { kind: 'user' as const, userId: actorId },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      }
      if (current) {
        await this.#events.publish(tx, {
          ...common,
          type: 'opportunity.switched',
          recipients: [...memberIds, current.owner_teacher_user_id, opportunity.owner_teacher_user_id],
          recipientBasis: {
            groupId: group.id,
            basis: 'group_memberships+opportunity_owners',
            revision,
            previousOwnerUserId: current.owner_teacher_user_id,
            ownerUserId: opportunity.owner_teacher_user_id,
          },
          payload: {
            title: `組別 ${group.code} 的合作案從「${current.name}」換成「${name}」`,
            groupId: group.id,
            code: group.code,
            opportunityId: opportunity.id,
            previousOpportunityId: current.opportunity_id,
          },
        })
      } else {
        await this.#events.publish(tx, {
          ...common,
          type: 'opportunity.linked',
          recipients: [],
          payload: { groupId: group.id, code: group.code, opportunityId: opportunity.id },
        })
      }
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: actorId,
        role: admin ? 'admin' : 'student',
        action: current ? 'opportunity.switch' : 'opportunity.link',
        targetType: 'group',
        targetId: group.id,
        scope: 'cohort',
        cohortId: group.cohort_id,
        reason,
        realAt,
        businessAt: businessNow,
        payload: { linkId, opportunityId: opportunity.id, previousLinkId: current?.id ?? null, previousOpportunityId: current?.opportunity_id ?? null, revision },
      })
      const receipt = {
        groupId: group.id,
        groupCode: group.code,
        change: current ? ('switched' as const) : ('linked' as const),
        opportunityName: name,
        previousOpportunityName: current?.name ?? null,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { groupId: group.id, linkId } })
      return { ok: true as const, receipt }
    })
  }

  async unlink(actor: ResolvedActor, input: UnlinkOpportunityInput, requestId: string): Promise<Result<LinkReceipt>> {
    const blocked = gate(actor)
    if (blocked) return blocked
    if (actor.kind !== 'authenticated') return err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(String(input.linkId ?? ''))) return err('VALIDATION_FAILED', '找不到這個連結，請重新整理頁面。')
    const reason = normalizeLinkReason(String(input.reason ?? ''), '解除連結')
    if (!reason.ok) return reason
    const actorId = actor.userId
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      // 先（不上鎖）看是誰的案、判權限：不是案主也不是系辦就直接拒絕，不去鎖別人的組別列（PR #266 審查建議）。
      // 案主（`owner_teacher_user_id`）建立後不會換人，所以鎖之前讀到的就是判斷依據。
      const found = await tx.query<{ group_id: string; owner_teacher_user_id: string }>(
        `select l.group_id, o.owner_teacher_user_id
           from opportunity_links l join industry_opportunities o on o.id = l.opportunity_id
          where l.id = $1`,
        [input.linkId],
      )
      const target = found.rows[0]
      if (!target) return err('VALIDATION_FAILED', '找不到這個連結，請重新整理頁面。')
      if (!canManageOpportunity(actor, target.owner_teacher_user_id)) {
        return err('FORBIDDEN', '只有這個合作案的負責老師與系辦可以解除連結。')
      }
      // 鎖序跟連結、換案一樣：先組別列、再連結列。
      const locked = await lockGroup(tx, target.group_id)
      if (!locked) return groupNotFound()
      const { group, cohort } = locked
      const link = await tx.query<{
        id: string
        valid_to: Date | null
        opportunity_id: string
        company_name: string
        department: string
      }>(
        `select l.id, l.valid_to, o.id as opportunity_id, o.company_name, o.department
           from opportunity_links l join industry_opportunities o on o.id = l.opportunity_id
          where l.id = $1 for update of l`,
        [input.linkId],
      )
      const row = link.rows[0]!
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: actorId,
          operationKind: 'opportunity.unlink',
          requestId,
          fingerprint: sha256(canonicalJson({ linkId: row.id, reason: reason.value })),
          scope: 'cohort',
          cohortId: group.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<LinkReceipt>(begun)
      const closed = writeBlocked(cohort, group, '解除合作案連結')
      if (closed) return closed
      if (row.valid_to) return err('VALIDATION_FAILED', `${group.code} 和這個合作案的連結已經解除（或已換案）了，請重新整理頁面。`)

      await endLink(tx, row.id, businessNow, realAt, actorId, reason.value)
      const revision = await bumpGroup(tx, group.id, realAt, actorId)
      const memberIds = await activeMemberIds(tx, group.id)
      const name = opportunityName({ companyName: row.company_name, department: row.department })
      await this.#events.publish(tx, {
        type: 'opportunity.unlinked',
        scope: 'cohort',
        cohortId: group.cohort_id,
        source: { type: 'industry_opportunity', id: row.opportunity_id, version: revision },
        actor: { kind: 'user', userId: actorId },
        recipients: [...memberIds, target.owner_teacher_user_id],
        recipientBasis: { groupId: group.id, basis: 'group_memberships+opportunity_owner', revision, ownerUserId: target.owner_teacher_user_id },
        payload: {
          title: `組別 ${group.code} 與「${name}」的連結已解除`,
          groupId: group.id,
          code: group.code,
          opportunityId: row.opportunity_id,
        },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: actorId,
        role: isAdminActor(actor) ? 'admin' : 'teacher',
        action: 'opportunity.unlink',
        targetType: 'group',
        targetId: group.id,
        scope: 'cohort',
        cohortId: group.cohort_id,
        reason: reason.value,
        realAt,
        businessAt: businessNow,
        payload: { linkId: row.id, opportunityId: row.opportunity_id, revision },
      })
      const receipt = {
        groupId: group.id,
        groupCode: group.code,
        change: 'unlinked' as const,
        opportunityName: name,
        previousOpportunityName: null,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { groupId: group.id, linkId: row.id } })
      return { ok: true as const, receipt }
    })
  }

  // ── 組別類型 ────────────────────────────────────────────────────────────────

  async changeGroupType(actor: ResolvedActor, input: ChangeGroupTypeInput, requestId: string): Promise<Result<GroupTypeReceipt>> {
    const blocked = gate(actor)
    if (blocked) return blocked
    if (actor.kind !== 'authenticated') return err('UNAUTHENTICATED', '請先登入。')
    const admin = isAdminActor(actor)
    if (!admin && !actor.roles.includes('student')) return err('FORBIDDEN', '只有組長或系辦可以改組別類型。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(String(input.groupId ?? ''))) return groupNotFound()
    if (!Number.isInteger(input.revision)) return staleRevision()
    const to = parseGroupType(String(input.groupType ?? ''))
    if (!to) return err('VALIDATION_FAILED', '請選組別類型（一般專題或產學合作）。', { details: { field: 'groupType' } })
    let reason: string | null = null
    if (admin) {
      const normalized = normalizeReason(String(input.reason ?? ''), '改組別類型')
      if (!normalized.ok) return normalized
      reason = normalized.value
    } else if (String(input.reason ?? '').trim().length > 200) {
      return err('VALIDATION_FAILED', '說明最多 200 個字。', { details: { field: 'reason' } })
    } else {
      reason = String(input.reason ?? '').trim() || null
    }
    const actorId = actor.userId
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await lockGroup(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { group, cohort } = locked
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: actorId,
          operationKind: 'group.type.change',
          requestId,
          fingerprint: sha256(canonicalJson({ groupId: group.id, revision: input.revision, to, reason })),
          scope: 'cohort',
          cohortId: group.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<GroupTypeReceipt>(begun)
      const closed = writeBlocked(cohort, group, '改組別類型')
      if (closed) return closed
      if (!admin && !(await isCurrentLeader(tx, group.id, actorId))) {
        return err('FORBIDDEN', '只有組長可以改組別類型。')
      }
      if (group.revision !== input.revision) return staleRevision()
      if (group.group_type === to) return err('VALIDATION_FAILED', `${group.code} 已經是${GROUP_TYPE_LABEL[to]}。`)

      const advisor = await tx.query<{ name: string }>(
        `select ${personName('p', 'u')} as name
           from advisor_assignments a join users u on u.id = a.teacher_user_id
           left join user_profiles p on p.user_id = a.teacher_user_id
          where a.group_id = $1 and a.valid_to is null`,
        [group.id],
      )
      const link = await activeLink(tx, group.id)
      if (!admin) {
        const blockers = leaderTypeChangeBlockers({
          groupingPeriod: await groupingPeriodAt(tx, group.cohort_id, businessNow),
          hasAdvisor: advisor.rows.length > 0,
          hasLink: link !== null,
        })
        if (blockers.length > 0) {
          return err('FORBIDDEN', `目前不能自己改組別類型（${blockers.join('、')}）；請聯絡系辦處理。`, {
            next: { kind: 'contact_office' },
          })
        }
      }

      await tx.query(`update groups set group_type = $2 where id = $1`, [group.id, to])
      const revision = await bumpGroup(tx, group.id, realAt, actorId)
      // 系辦改類型：既有主指導與合作案連結保留（5.3「不可靜默刪關聯」），回執與稽核寫明。
      const keptRelations = [
        ...(advisor.rows[0] ? [`指導老師 ${advisor.rows[0].name}`] : []),
        ...(link ? [`合作案「${link.name}」的連結`] : []),
      ]
      await this.#events.publish(tx, {
        type: 'group.type_changed',
        scope: 'cohort',
        cohortId: group.cohort_id,
        source: { type: 'group', id: group.id, version: revision },
        actor: { kind: 'user', userId: actorId },
        recipients: [],
        payload: { groupId: group.id, code: group.code, from: group.group_type, to },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: actorId,
        role: admin ? 'admin' : 'student',
        action: 'group.type.change',
        targetType: 'group',
        targetId: group.id,
        scope: 'cohort',
        cohortId: group.cohort_id,
        reason,
        realAt,
        businessAt: businessNow,
        payload: { from: group.group_type, to, revision, keptAdvisor: advisor.rows.length > 0, keptLinkId: link?.id ?? null },
      })
      const receipt = {
        groupId: group.id,
        groupCode: group.code,
        from: group.group_type,
        to,
        keptRelations: admin ? keptRelations : [],
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { groupId: group.id } })
      return { ok: true as const, receipt }
    })
  }

  // ── 共用 ────────────────────────────────────────────────────────────────────

  async #lockOpportunity(tx: PoolClient, id: string) {
    const rows = await tx.query<{
      id: string
      owner_teacher_user_id: string
      company_name: string
      department: string
      status: OpportunityStatus
      revision: number
    }>(
      `select id, owner_teacher_user_id, company_name, department, status, revision
         from industry_opportunities where id = $1 for update`,
      [id],
    )
    return rows.rows[0] ?? null
  }

  async #publishedEvent(tx: PoolClient, id: string, revision: number, actorId: string, realAt: Date, businessAt: Date) {
    await this.#events.publish(tx, {
      type: 'opportunity.published',
      scope: 'global',
      source: { type: 'industry_opportunity', id, version: revision },
      actor: { kind: 'user', userId: actorId },
      recipients: [],
      payload: { opportunityId: id },
      occurredRealAt: realAt,
      occurredBusinessAt: businessAt,
    })
  }

  async #auditOpportunity(
    tx: PoolClient,
    actor: ResolvedActor,
    action: string,
    id: string,
    realAt: Date,
    businessAt: Date,
    payload: Record<string, unknown>,
  ) {
    // 只記狀態與版本，不記聯絡資料（契約 01 §4.3：稽核不含私有正文）。
    await this.#audit.append(tx, {
      actorKind: 'user',
      actorUserId: actor.kind === 'authenticated' ? actor.userId : null,
      role: roleOf(actor),
      action,
      targetType: 'industry_opportunity',
      targetId: id,
      scope: 'global',
      realAt,
      businessAt,
      payload,
    })
  }

  #receipt(
    id: string,
    fields: Pick<NormalizedOpportunity, 'companyName' | 'department'>,
    action: OpportunityAction,
    status: OpportunityStatus,
    revision: number,
    requestId: string,
    realAt: Date,
  ) {
    return {
      opportunityId: id,
      name: opportunityName(fields),
      action,
      status,
      revision,
      requestId,
      serverTime: realAt.toISOString(),
    }
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'opportunities', body, (constraint) =>
      constraint === 'opportunity_links_one_active'
        ? err('CONFLICT', '這組剛剛已經連結了其他合作案；請重新整理頁面再試。')
        : err('CONFLICT', '剛剛有人同時修改了同一份資料，請重新整理頁面再試一次。'),
    )
  }
}

// ── 交易內的小工具 ────────────────────────────────────────────────────────────

/** 鎖順序：屆別 FOR SHARE → 組別 FOR NO KEY UPDATE（同 `pg-advisors.ts`）。 */
async function lockGroup(tx: PoolClient, groupId: string): Promise<{ group: GroupRow; cohort: CohortRow } | null> {
  const owner = await tx.query<{ cohort_id: string }>('select cohort_id from groups where id = $1', [groupId])
  const cohortId = owner.rows[0]?.cohort_id
  if (!cohortId) return null
  const cohort = await tx.query<CohortRow>('select id, code, status from cohorts where id = $1 for share', [cohortId])
  const found = await tx.query<GroupRow>(
    'select id, cohort_id, code, group_type, status, revision from groups where id = $1 for no key update',
    [groupId],
  )
  const group = found.rows[0]
  if (!group || !cohort.rows[0]) return null
  return { group, cohort: cohort.rows[0] }
}

function writeBlocked(cohort: CohortRow, group: GroupRow, what: string): Err | null {
  if (cohort.status === 'archived') return err('COHORT_ARCHIVED', `${cohort.code} 已封存，分組資料只能查看。`)
  if (group.status === 'dissolved') return err('GROUP_DISSOLVED', `${group.code} 已解散，不能再${what}。`)
  return null
}

async function isCurrentLeader(tx: Pick<PoolClient, 'query'>, groupId: string, userId: string): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from group_leaders l
      where l.group_id = $1 and l.user_id = $2 and l.valid_to is null
        and exists (select 1 from group_memberships m where m.group_id = $1 and m.user_id = $2 and m.valid_to is null)`,
    [groupId, userId],
  )
  return rows.rows.length > 0
}

async function activeLink(
  tx: Pick<PoolClient, 'query'>,
  groupId: string,
): Promise<{ id: string; opportunity_id: string; owner_teacher_user_id: string; name: string; status: OpportunityStatus } | null> {
  const rows = await tx.query<{ id: string; opportunity_id: string; owner_teacher_user_id: string; company_name: string; department: string; status: OpportunityStatus }>(
    `select l.id, l.opportunity_id, o.owner_teacher_user_id, o.company_name, o.department, o.status
       from opportunity_links l join industry_opportunities o on o.id = l.opportunity_id
      where l.group_id = $1 and l.valid_to is null`,
    [groupId],
  )
  const row = rows.rows[0]
  return row
    ? {
        id: row.id,
        opportunity_id: row.opportunity_id,
        owner_teacher_user_id: row.owner_teacher_user_id,
        name: opportunityName({ companyName: row.company_name, department: row.department }),
        status: row.status,
      }
    : null
}

async function endLink(tx: PoolClient, linkId: string, businessAt: Date, realAt: Date, actorId: string, reason: string) {
  await tx.query(
    `update opportunity_links
        set valid_to = greatest(valid_from, $2), ended_real_at = $3, ended_by_user_id = $4, end_reason = $5
      where id = $1`,
    [linkId, businessAt, realAt, actorId, reason],
  )
}

async function bumpGroup(tx: PoolClient, groupId: string, realAt: Date, actorId: string): Promise<number> {
  const bumped = await tx.query<{ revision: number }>(
    `update groups set revision = revision + 1, updated_at = $2, updated_by_user_id = $3 where id = $1 returning revision`,
    [groupId, realAt, actorId],
  )
  return bumped.rows[0]!.revision
}

async function activeMemberIds(tx: Pick<PoolClient, 'query'>, groupId: string): Promise<string[]> {
  const rows = await tx.query<{ user_id: string }>('select user_id from group_memberships where group_id = $1 and valid_to is null', [
    groupId,
  ])
  return rows.rows.map((r) => r.user_id)
}

/** 此刻相對於成組期的位置：階段沒設定、還沒開始、成組期內、已過成組截止（第 2 階段開始日 00:00）。 */
async function groupingPeriodAt(db: Pick<PoolClient, 'query'>, cohortId: string, businessNow: Date): Promise<GroupingPeriodState> {
  const yearEnd = await db.query<{ year_end_date: string | null }>(
    `select to_char(year_end_date, 'YYYY-MM-DD') as year_end_date from cohorts where id = $1`,
    [cohortId],
  )
  const schedule = await loadSchedule(db, cohortId, yearEnd.rows[0]?.year_end_date ?? null)
  const deadline = groupingDeadline(schedule)
  const position = stagePositionAt(schedule, businessNow)
  if (!deadline || position.kind === 'unconfigured') return 'unconfigured'
  if (position.kind === 'not_started') return 'not_started'
  return businessNow.getTime() < deadline.getTime() ? 'open' : 'ended'
}

// ── 查詢 ──────────────────────────────────────────────────────────────────────

export class PgOpportunityQuery implements OpportunityQuery {
  readonly #reader: () => Pick<Pool, 'query'>
  readonly #businessClock: BusinessClockSource

  constructor(deps: { businessClock: BusinessClockSource; reader?: () => Pick<Pool, 'query'> }) {
    this.#reader = deps.reader ?? getPool
    this.#businessClock = deps.businessClock
  }

  async list(actor: ResolvedActor, filter: OpportunityListFilter = {}): Promise<OpportunityCard[]> {
    if (!canViewOpportunities(actor)) return []
    const where = [`o.status = 'published'`]
    const values: unknown[] = []
    if (filter.ownerUserId && isUuid(filter.ownerUserId)) {
      values.push(filter.ownerUserId)
      where.push(`o.owner_teacher_user_id = $${values.length}`)
    }
    const q = (filter.q ?? '').trim().slice(0, 100)
    if (q) {
      values.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      const n = values.length
      where.push(
        `(o.company_name ilike $${n} or o.department ilike $${n} or o.content ilike $${n}
          or ${personName('p', 'u')} ilike $${n})`,
      )
    }
    const order =
      filter.sort === 'company'
        ? 'o.company_name, o.published_business_at desc'
        : filter.sort === 'oldest'
          ? 'o.published_business_at asc, o.id'
          : 'o.published_business_at desc, o.id desc'
    const rows = await this.#reader().query<OpportunityRow>(`${PUBLIC_SELECT} where ${where.join(' and ')} order by ${order}`, values)
    const cards = rows.rows.map(toCard)
    if (filter.linked === 'open') return cards.filter((c) => c.linkedGroupCount === 0)
    if (filter.linked === 'linked') return cards.filter((c) => c.linkedGroupCount > 0)
    return cards
  }

  async open(actor: ResolvedActor, opportunityId: string): Promise<OpportunityPage> {
    if (actor.kind !== 'authenticated' || !canViewOpportunities(actor)) return { access: 'need_login' }
    if (!isUuid(String(opportunityId ?? ''))) return { access: 'not_found' }
    const db = this.#reader()
    const found = await db.query<OpportunityRow>(`${PUBLIC_SELECT} where o.id = $1`, [opportunityId])
    const row = found.rows[0]
    if (!row) return { access: 'not_found' }
    const manage = canManageOpportunity(actor, row.owner_teacher_user_id)

    let access: 'visible' | 'withdrawn_linked' = 'visible'
    if (!manage) {
      // 草稿：不透露存在。
      if (row.status === 'draft') return { access: 'not_found' }
      if (row.status === 'withdrawn') {
        // 下架後，組別仍連著它的組員看得到原本已發布的公開欄位；其他人只看到下架說明。
        const member = await db.query(
          `select 1 from opportunity_links l
             join group_memberships m on m.group_id = l.group_id and m.valid_to is null
            where l.opportunity_id = $1 and l.valid_to is null and m.user_id = $2`,
          [row.id, actor.userId],
        )
        if (member.rows.length === 0) return { access: 'withdrawn' }
        access = 'withdrawn_linked'
      }
    }

    // 私有欄位：只有案主與系辦才發這一次 select（查詢層擋，不是畫面藏）。
    let privateRow: PrivateRow | null = null
    if (manage) {
      const secret = await db.query<PrivateRow>(
        `select notes, address, contact_name, contact_phone, contact_email from industry_opportunities where id = $1`,
        [row.id],
      )
      privateRow = secret.rows[0] ?? null
    }
    const links = await linkedGroups(db, [row.id])
    const notes = manage ? (privateRow?.notes ?? null) : row.notes
    return {
      access,
      opportunity: {
        ...toCard(row),
        contentHtml: safeHtml(row.content),
        requirementsHtml: safeHtml(row.requirements),
        notesHtml: notes ? safeHtml(notes) : null,
        notesVisibility: row.notes_visibility,
        contact: privateRow
          ? {
              address: privateRow.address,
              contactName: privateRow.contact_name,
              contactPhone: privateRow.contact_phone,
              contactEmail: privateRow.contact_email,
            }
          : null,
        linkedGroups: links.get(row.id) ?? [],
        canManage: manage,
      },
    }
  }

  async manageList(actor: ResolvedActor): Promise<ManagedOpportunity[]> {
    if (actor.kind !== 'authenticated' || !canViewOpportunities(actor)) return []
    const admin = isAdminActor(actor)
    if (!admin && !actor.roles.includes('teacher')) return []
    const rows = await this.#reader().query<{
      id: string
      owner_teacher_user_id: string
      owner_name: string
      company_name: string
      department: string
      content: string
      requirements: string
      notes: string | null
      notes_visibility: NotesVisibility
      address: string | null
      contact_name: string | null
      contact_phone: string | null
      contact_email: string | null
      status: OpportunityStatus
      revision: number
      published_business_at: Date | null
      withdrawn_business_at: Date | null
    }>(
      // 老師只拿到自己是案主的列（where 條件在 SQL 裡），系辦拿全部。
      `select o.id, o.owner_teacher_user_id, ${personName('p', 'u')} as owner_name,
              o.company_name, o.department, o.content, o.requirements, o.notes, o.notes_visibility,
              o.address, o.contact_name, o.contact_phone, o.contact_email,
              o.status, o.revision, o.published_business_at, o.withdrawn_business_at
         from industry_opportunities o
         join users u on u.id = o.owner_teacher_user_id
         left join user_profiles p on p.user_id = o.owner_teacher_user_id
        where ($1::uuid is null or o.owner_teacher_user_id = $1)
        order by case o.status when 'published' then 0 when 'draft' then 1 else 2 end, o.created_at desc`,
      [admin ? null : actor.userId],
    )
    const links = await linkedGroups(this.#reader(), rows.rows.map((r) => r.id))
    return rows.rows.map((r) => ({
      id: r.id,
      ownerUserId: r.owner_teacher_user_id,
      ownerName: r.owner_name,
      status: r.status,
      revision: r.revision,
      publishedAt: r.published_business_at,
      withdrawnAt: r.withdrawn_business_at,
      fields: {
        companyName: r.company_name,
        department: r.department,
        content: r.content,
        requirements: r.requirements,
        notes: r.notes,
        notesVisibility: r.notes_visibility,
        address: r.address,
        contactName: r.contact_name,
        contactPhone: r.contact_phone,
        contactEmail: r.contact_email,
      },
      links: links.get(r.id) ?? [],
    }))
  }

  async leaderPanel(actor: ResolvedActor, cohortId: string): Promise<LeaderPanel | null> {
    if (actor.kind !== 'authenticated' || !canViewOpportunities(actor) || !isUuid(String(cohortId ?? ''))) return null
    const db = this.#reader()
    const found = await db.query<{ id: string; code: string; group_type: GroupType; revision: number; is_leader: boolean }>(
      `select g.id, g.code, g.group_type, g.revision,
              exists (select 1 from group_leaders l where l.group_id = g.id and l.user_id = $1 and l.valid_to is null) as is_leader
         from group_memberships m join groups g on g.id = m.group_id
        where m.user_id = $1 and m.cohort_id = $2 and m.valid_to is null and g.status = 'active'`,
      [actor.userId, cohortId],
    )
    const group = found.rows[0]
    if (!group) return null
    const link = await activeLink(db, group.id)
    const advisor = await db.query('select 1 from advisor_assignments where group_id = $1 and valid_to is null', [group.id])
    const blockers = leaderTypeChangeBlockers({
      groupingPeriod: await groupingPeriodAt(db, cohortId, await this.#businessClock.now()),
      hasAdvisor: advisor.rows.length > 0,
      hasLink: link !== null,
    })
    const linkable = (await this.list(actor)).filter((c) => c.id !== link?.opportunity_id)
    const current: GroupOpportunityLink | null = link
      ? { linkId: link.id, opportunityId: link.opportunity_id, name: link.name, status: link.status }
      : null
    return {
      groupId: group.id,
      groupCode: group.code,
      groupType: group.group_type,
      revision: group.revision,
      isLeader: group.is_leader,
      link: current,
      typeChangeBlockers: blockers,
      linkable,
    }
  }
}

async function linkedGroups(db: Pick<Pool, 'query'>, opportunityIds: string[]): Promise<Map<string, LinkedGroupRef[]>> {
  const result = new Map<string, LinkedGroupRef[]>()
  if (opportunityIds.length === 0) return result
  const rows = await db.query<{ opportunity_id: string; link_id: string; group_id: string; code: string; cohort_code: string; valid_from: Date }>(
    `select l.opportunity_id, l.id as link_id, g.id as group_id, g.code, c.code as cohort_code, l.valid_from
       from opportunity_links l
       join groups g on g.id = l.group_id
       join cohorts c on c.id = g.cohort_id
      where l.opportunity_id = any($1::uuid[]) and l.valid_to is null
      order by c.code desc, g.code`,
    [opportunityIds],
  )
  for (const r of rows.rows) {
    const list = result.get(r.opportunity_id) ?? []
    list.push({ linkId: r.link_id, groupId: r.group_id, groupCode: r.code, cohortCode: r.cohort_code, linkedAt: r.valid_from })
    result.set(r.opportunity_id, list)
  }
  return result
}
