import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import {
  collectsResponses,
  describeDeadline,
  describeFailedChecks,
  failedChecks,
  ITEM_UPLOAD,
  describeRepublishExpired,
  isUuid,
  LIFECYCLE_LABEL,
  LIFECYCLE_NEXT_STATUS,
  lifecycleCheck,
  normalizeItemInput,
  publishChecks,
  sanitizeBody,
  snapshotDueAt,
  type AudienceKind,
  type EditablePlacement,
  type EditorOptions,
  type FormField,
  type ItemCommand,
  type ItemDetail,
  type ItemDraft,
  type ItemInput,
  type ItemListRow,
  type ItemQuery,
  type ItemReview,
  type ItemStatus,
  type LifecycleAction,
  type LifecycleReceipt,
  type Placement,
  type PublishReceipt,
  type ReceiverUnit,
  type RecipientPreview,
  type RecipientQueryInput,
  type ResponsePresence,
  type SaveReceipt,
  type StartItemUploadInput,
  type UpdateChange,
  type UpdateReceipt,
} from '@/application/items'
import type { DueWorkScheduler, EventPublisher } from '@/application/notifications'
import {
  canonicalJson,
  type AuditWriter,
  type FileRef,
  type FileStorage,
  type OperationLedger,
  type UploadTicket,
} from '@/application/ops'
import { authorizeAdmin, badRequestId, inTransaction, replayed, staleRevision, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { audienceUserIds, expandRecipients, memberUserIds, type ExpandedRecipients } from '@/infrastructure/items/recipients'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { reachFaultPoint } from '@/shared/fault-points'
import { err, ok, type Err, type Result } from '@/shared/result'
import { formatTaipeiMinute, isDeadlinePassed, RealClock, type Clock } from '@/shared/time'

/**
 * 專題事務的建立、存草稿、發布、發布更新（票 15；模組實作設計 04 §3、§6；模組 05 §5 `buildRoster`）。
 *
 * 每個寫入都是同一個形狀（契約 01 §8，照票 13 的 pg-groups）：業務時間在開交易**之前**讀一次 →
 * 開交易 → 鎖（`cohorts FOR SHARE` → `managed_items FOR UPDATE`，契約 01 §6 的鎖順序）→ 帳本 `begin`
 * → 檢查 → 寫入 → 事件／到期工作／稽核 → 帳本 `commit` → COMMIT。回 `Err` 或丟例外整筆回滾。
 *
 * 發布是**一筆交易**：切內容版本與欄位版本、寫實際開放時間、發布紀錄、依對象展開收件名單、
 * 排截止到期工作、發事件，任何一步失敗全部不留（整合測試用故障注入點 `item.publish.after-roster` 證明）。
 */

const SUBJECT_TYPE = 'item'
const FILE_REF_TYPE = 'item_attachment' as const
const ROSTER_REMOVED_BY_SETTINGS = '發布對象或收件單位變更'
const ROSTER_REMOVED_BY_WITHDRAW = '項目撤回成草稿'
const LIFECYCLE_ACTIONS: readonly LifecycleAction[] = ['withdraw', 'archive', 'republish']
const LIFECYCLE_EVENT: Readonly<Record<LifecycleAction, 'item.withdrawn' | 'item.archived' | 'item.republished'>> = {
  withdraw: 'item.withdrawn',
  archive: 'item.archived',
  republish: 'item.republished',
}
/** 封面允許的內容類型（`stored_files.mime_detected`，內容檢查後的正規值）。 */
const COVER_MIMES: readonly string[] = ['image/png', 'image/jpeg']

type ItemRow = {
  id: string
  cohort_id: string
  placement: Placement
  audience_kind: AudienceKind
  receiver_unit: ReceiverUnit
  stage_id: string | null
  status: ItemStatus
  opens_at: Date | null
  actual_opened_at: Date | null
  due_at: Date | null
  deadline_version: number
  current_content_version_id: string | null
  current_schema_version_id: string | null
  title: string
  summary: string
  body_html: string
  cover_file_id: string | null
  category: string | null
  registration_deadline: string | null
  event_date: string | null
  draft_schema: { fields: FormField[] }
  revision: number
}

type Locked = { item: ItemRow; cohortStatus: string; groupIds: string[]; attachmentIds: string[] }

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  dueWork: DueWorkScheduler<PoolClient>
  files: FileStorage<PoolClient>
  responses: ResponsePresence<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

function itemNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個項目，請回到專題事務列表重新整理。')
}

function cohortArchived(): Err {
  return err('COHORT_ARCHIVED', '這一屆已經封存，不能再建立或修改專題事務。')
}

/** 草稿寫進資料庫的樣子（時間轉 ISO，給帳本指紋用）。 */
function fingerprintOf(draft: ItemDraft, extra: Record<string, unknown> = {}): string {
  return sha256(
    canonicalJson({
      ...draft,
      opensAt: draft.opensAt?.toISOString() ?? null,
      dueAt: draft.dueAt?.toISOString() ?? null,
      ...extra,
    }),
  )
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return sameIds([...a].sort(), [...b].sort())
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null)
}

function fileSet(attachments: readonly string[], cover: string | null): string[] {
  return [...new Set(cover ? [...attachments, cover] : attachments)]
}

export class PgItemCommand implements ItemCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #dueWork: DueWorkScheduler<PoolClient>
  readonly #files: FileStorage<PoolClient>
  readonly #responses: ResponsePresence<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#events = deps.events
    this.#dueWork = deps.dueWork
    this.#files = deps.files
    this.#responses = deps.responses
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  // ── 建立與存草稿 ────────────────────────────────────────────────────────────

  async create(actor: ResolvedActor, input: ItemInput, requestId: string): Promise<Result<SaveReceipt>> {
    const denied = authorizeAdmin(actor, '建立專題事務')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    const normalized = this.#normalize(input)
    if (!normalized.ok) return normalized
    const draft = normalized.value
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const cohort = await tx.query<{ status: string }>('select status from cohorts where id = $1 for share', [draft.cohortId])
      if (!cohort.rows[0]) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'item.create',
          requestId,
          fingerprint: fingerprintOf(draft),
          scope: 'cohort',
          cohortId: draft.cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<SaveReceipt>(begun)
      if (cohort.rows[0].status === 'archived') return cohortArchived()

      const refs = await this.#checkReferences(tx, draft)
      if (refs) return refs

      const itemId = uuidv7()
      await tx.query(
        `insert into managed_items
           (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, due_at,
            title, summary, body_html, cover_file_id, category, draft_schema,
            created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id,
            registration_deadline, event_date)
         values ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
                 $15, 'user', $16, $15, $16, $17, $18)`,
        [
          itemId,
          draft.cohortId,
          draft.placement,
          draft.audienceKind,
          draft.receiverUnit,
          draft.stageId,
          draft.opensAt,
          draft.dueAt,
          draft.title,
          draft.summary,
          draft.body,
          draft.coverFileId,
          draft.category,
          JSON.stringify({ fields: draft.fields }),
          realAt,
          userId,
          draft.registrationDeadline,
          draft.eventDate,
        ],
      )
      await this.#replaceAudienceGroups(tx, itemId, draft.groupIds)
      const files = await this.#syncFiles(tx, itemId, userId, { attachments: [], cover: null }, draft)
      if (files) return files

      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'item.create',
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId: draft.cohortId,
        realAt,
        businessAt,
        payload: { placement: draft.placement, title: draft.title, receiverUnit: draft.receiverUnit },
      })
      const receipt = { itemId, revision: 1, status: 'draft' as const, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId } })
      return { ok: true as const, receipt }
    })
  }

  async saveDraft(
    actor: ResolvedActor,
    itemId: string,
    revision: number,
    input: ItemInput,
    requestId: string,
  ): Promise<Result<SaveReceipt>> {
    const denied = authorizeAdmin(actor, '編輯專題事務')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId)) return itemNotFound()
    const normalized = this.#normalize(input)
    if (!normalized.ok) return normalized
    const draft = normalized.value
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lock(tx, itemId)
      if (!locked) return itemNotFound()
      const { item } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'item.save_draft',
          requestId,
          fingerprint: fingerprintOf(draft, { itemId, revision }),
          scope: 'cohort',
          cohortId: item.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<SaveReceipt>(begun)
      if (locked.cohortStatus === 'archived') return cohortArchived()
      if (item.revision !== revision) return staleRevision()
      if (item.status !== 'draft') {
        return err('VALIDATION_FAILED', '這個項目已經發布了；已發布的修改請按「發布更新」。')
      }
      if (draft.cohortId !== item.cohort_id) return err('VALIDATION_FAILED', '項目建立後不能換屆別；請另建一筆。')

      const refs = await this.#checkReferences(tx, draft)
      if (refs) return refs
      const files = await this.#syncFiles(tx, itemId, userId, { attachments: locked.attachmentIds, cover: item.cover_file_id }, draft)
      if (files) return files
      await this.#writeHead(tx, itemId, draft, userId, realAt)
      await this.#replaceAudienceGroups(tx, itemId, draft.groupIds)

      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'item.save_draft',
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId: item.cohort_id,
        realAt,
        businessAt,
        payload: { placement: draft.placement, title: draft.title, revision: item.revision + 1 },
      })
      const receipt = {
        itemId,
        revision: item.revision + 1,
        status: 'draft' as const,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId } })
      return { ok: true as const, receipt }
    })
  }

  // ── 發布 ────────────────────────────────────────────────────────────────────

  async publish(
    actor: ResolvedActor,
    itemId: string,
    revision: number,
    options: { readonly notify: boolean },
    requestId: string,
  ): Promise<Result<PublishReceipt>> {
    const denied = authorizeAdmin(actor, '發布專題事務')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId)) return itemNotFound()
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lock(tx, itemId)
      if (!locked) return itemNotFound()
      const { item, groupIds } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'item.publish',
          requestId,
          fingerprint: sha256(canonicalJson({ itemId, revision, notify: options.notify })),
          scope: 'cohort',
          cohortId: item.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<PublishReceipt>(begun)
      if (locked.cohortStatus === 'archived') return cohortArchived()
      if (item.revision !== revision) return staleRevision()
      if (item.status !== 'draft') return err('VALIDATION_FAILED', '這個項目已經發布了，請重新整理頁面。')

      // 發布前檢查：畫面顯示的同一份清單，任何一條沒過就不寫任何東西（PUB-13）。
      // 開放時間：有設就用設定的；沒設＝發布即開放（這一刻）。撤回後再發布（票 16）用第一次的實際開放時間。
      const openAt = item.actual_opened_at ?? businessAt
      const failed = failedChecks(publishChecks(this.#stateOf(item, groupIds), openAt))
      if (failed.length > 0) {
        return err('VALIDATION_FAILED', describeFailedChecks(failed), { details: { checks: failed.map((c) => c.key) } })
      }
      const refs = await this.#checkReferences(tx, {
        cohortId: item.cohort_id,
        stageId: item.stage_id,
        groupIds,
        placement: item.placement,
      })
      if (refs) return refs

      const collects = item.receiver_unit !== 'none'
      const notify = collects || options.notify
      const contentVersionNo = await this.#insertContentVersion(tx, item, userId, realAt)
      const schemaVersionNo = await this.#insertSchemaVersion(tx, item, userId, realAt)
      await tx.query(
        `update managed_items
            set status = 'published', actual_opened_at = coalesce(actual_opened_at, $2),
                current_content_version_id = (select id from item_versions where item_id = $1 and version_no = $3),
                current_schema_version_id = (select id from form_schema_versions where item_id = $1 and version_no = $4),
                revision = revision + 1, updated_at = $5, updated_by_user_id = $6
          where id = $1`,
        [itemId, businessAt, contentVersionNo, schemaVersionNo, realAt, userId],
      )
      await this.#insertPublication(tx, itemId, 'publish', { contentVersionNo, schemaVersionNo }, item.deadline_version, notify, userId, realAt, businessAt)

      // 收件名單（模組 05 `buildRoster`）：依對象展開實際的人或組，發布同一筆交易寫進去。
      const expanded = await expandRecipients(tx, {
        cohortId: item.cohort_id,
        audienceKind: item.audience_kind,
        groupIds,
        receiverUnit: item.receiver_unit,
      })
      const rosterCount = collects ? await this.#insertRoster(tx, item, receiverKeys(expanded), userId, businessAt, realAt) : 0
      await reachFaultPoint('item.publish.after-roster')

      if (item.due_at) {
        await this.#dueWork.schedule(tx, {
          kind: 'deadline_snapshot',
          subject: { type: SUBJECT_TYPE, id: itemId },
          deadlineVersion: item.deadline_version,
          dueBusinessAt: snapshotDueAt(item.due_at),
        })
      }

      const recipients = notify ? expanded.notifyUserIds : []
      if (notify) {
        await this.#events.publish(tx, {
          type: collects ? 'item.published' : 'item.announced',
          scope: 'cohort',
          cohortId: item.cohort_id,
          source: { type: SUBJECT_TYPE, id: itemId, version: contentVersionNo },
          actor: { kind: 'user', userId },
          recipients,
          recipientBasis: collects
            ? { itemId, basis: 'response_rosters', receiverUnit: item.receiver_unit }
            : { itemId, basis: 'audience', audienceKind: item.audience_kind },
          payload: this.#eventPayload(item),
          occurredRealAt: realAt,
          occurredBusinessAt: businessAt,
        })
      }

      const actualOpenedAt = item.actual_opened_at ?? businessAt
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'item.publish',
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId: item.cohort_id,
        realAt,
        businessAt,
        payload: {
          placement: item.placement,
          audienceKind: item.audience_kind,
          receiverUnit: item.receiver_unit,
          rosterCount,
          contentVersionNo,
          schemaVersionNo,
          actualOpenedAt: actualOpenedAt.toISOString(),
          notify,
        },
      })

      const receipt = {
        itemId,
        title: item.title,
        placement: item.placement,
        receiverUnit: item.receiver_unit,
        revision: item.revision + 1,
        actualOpenedAt: actualOpenedAt.toISOString(),
        dueAt: item.due_at?.toISOString() ?? null,
        contentVersionNo,
        schemaVersionNo,
        rosterCount,
        notifiedCount: recipients.length,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId } })
      return { ok: true as const, receipt }
    })
  }

  // ── 發布更新 ────────────────────────────────────────────────────────────────

  async updatePublished(
    actor: ResolvedActor,
    itemId: string,
    revision: number,
    input: ItemInput,
    options: { readonly notify: boolean },
    requestId: string,
  ): Promise<Result<UpdateReceipt>> {
    const denied = authorizeAdmin(actor, '修改專題事務')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId)) return itemNotFound()
    const normalized = this.#normalize(input)
    if (!normalized.ok) return normalized
    const draft = normalized.value
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lock(tx, itemId)
      if (!locked) return itemNotFound()
      const { item, groupIds } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'item.update_published',
          requestId,
          fingerprint: fingerprintOf(draft, { itemId, revision, notify: options.notify }),
          scope: 'cohort',
          cohortId: item.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<UpdateReceipt>(begun)
      if (locked.cohortStatus === 'archived') return cohortArchived()
      if (item.revision !== revision) return staleRevision()
      if (item.status === 'draft') return err('VALIDATION_FAILED', '這個項目還是草稿；請按「存草稿」或「發布」。')
      if (item.status !== 'published') return err('VALIDATION_FAILED', '已下架的項目要先重新發布才能修改。')
      if (draft.cohortId !== item.cohort_id) return err('VALIDATION_FAILED', '項目建立後不能換屆別；請另建一筆。')
      if (draft.placement !== item.placement) {
        return err('VALIDATION_FAILED', '已發布的項目不能換發布位置；要換位置請另建一筆。')
      }
      if (!sameTime(draft.opensAt, item.opens_at)) {
        return err('VALIDATION_FAILED', '已發布的收件不能改開放時間（實際開放時間已經記下）。')
      }

      const contentChanged =
        draft.title !== item.title ||
        draft.summary !== item.summary ||
        draft.body !== item.body_html ||
        draft.category !== item.category ||
        draft.coverFileId !== item.cover_file_id ||
        !sameIds(draft.attachmentFileIds, locked.attachmentIds)
      const schemaChanged = canonicalJson(draft.fields) !== canonicalJson(item.draft_schema.fields ?? [])
      const unitChanged = draft.receiverUnit !== item.receiver_unit
      const audienceChanged = draft.audienceKind !== item.audience_kind || !sameSet(draft.groupIds, groupIds)
      const stageChanged = draft.stageId !== item.stage_id
      const deadlineChanged = !sameTime(draft.dueAt, item.due_at)
      // 競賽資訊的報名截止／活動日（0011）：發布設定，跟階段一樣記成「設定變更」。
      const competitionDatesChanged =
        draft.registrationDeadline !== item.registration_deadline || draft.eventDate !== item.event_date
      const settingsChanged = unitChanged || audienceChanged || stageChanged || competitionDatesChanged
      if (!contentChanged && !schemaChanged && !settingsChanged && !deadlineChanged) {
        return err('VALIDATION_FAILED', '沒有任何修改。')
      }

      // 有人作答後：收件單位鎖定，對象與欄位結構也不在這裡改（產品模組 04 §4.5；改結構與受眾變更在後面的票）。
      if ((unitChanged || audienceChanged || schemaChanged) && (await this.#responses.hasAnyResponse(tx, itemId))) {
        if (unitChanged) {
          return err('ITEM_HAS_RESPONSES', '已經有人作答，收件單位（個人一份／整組一份）不能再切換；需要另一種收件請另建一筆。')
        }
        if (audienceChanged) {
          return err('ITEM_HAS_RESPONSES', '已經有人作答，這裡不能直接改發布對象（名單與完成率要重算，功能在後續版本）。')
        }
        return err('ITEM_HAS_RESPONSES', '已經有人作答，收件欄位不能原地改；改結構要建立新欄位版本並預覽影響（功能在後續版本）。')
      }

      const failed = failedChecks(publishChecks(draft, item.actual_opened_at ?? businessAt))
      if (failed.length > 0) {
        return err('VALIDATION_FAILED', describeFailedChecks(failed), { details: { checks: failed.map((c) => c.key) } })
      }
      const refs = await this.#checkReferences(tx, draft)
      if (refs) return refs
      const files = await this.#syncFiles(tx, itemId, userId, { attachments: locked.attachmentIds, cover: item.cover_file_id }, draft)
      if (files) return files

      const deadlineVersion = deadlineChanged ? item.deadline_version + 1 : item.deadline_version
      await this.#writeHead(tx, itemId, draft, userId, realAt, deadlineVersion)
      if (audienceChanged) await this.#replaceAudienceGroups(tx, itemId, draft.groupIds)

      const changes: UpdateChange[] = []
      const next: ItemRow = {
        ...item,
        title: draft.title,
        summary: draft.summary,
        body_html: draft.body,
        category: draft.category,
        cover_file_id: draft.coverFileId,
        draft_schema: { fields: [...draft.fields] },
        audience_kind: draft.audienceKind,
        receiver_unit: draft.receiverUnit,
        stage_id: draft.stageId,
        due_at: draft.dueAt,
        registration_deadline: draft.registrationDeadline,
        event_date: draft.eventDate,
        deadline_version: deadlineVersion,
      }
      let contentVersionNo = await this.#currentVersionNo(tx, 'item_versions', item.current_content_version_id)
      let schemaVersionNo = await this.#currentVersionNo(tx, 'form_schema_versions', item.current_schema_version_id)
      if (contentChanged) {
        changes.push('content')
        contentVersionNo = await this.#insertContentVersion(tx, next, userId, realAt)
        await tx.query(
          `update managed_items set current_content_version_id =
             (select id from item_versions where item_id = $1 and version_no = $2) where id = $1`,
          [itemId, contentVersionNo],
        )
        await this.#insertPublication(tx, itemId, 'content_change', { contentVersionNo }, null, options.notify, userId, realAt, businessAt)
      }
      if (schemaChanged) {
        changes.push('schema')
        schemaVersionNo = await this.#insertSchemaVersion(tx, next, userId, realAt)
        await tx.query(
          `update managed_items set current_schema_version_id =
             (select id from form_schema_versions where item_id = $1 and version_no = $2) where id = $1`,
          [itemId, schemaVersionNo],
        )
        await this.#insertPublication(tx, itemId, 'schema_change', { schemaVersionNo }, null, options.notify, userId, realAt, businessAt)
      }

      // 對象或收件單位變了：名單重算。已不在新對象裡的收件者寫結束時間與理由（不刪列），新進的插新列。
      let rosterAdded: RosterKey[] = []
      let rosterRemoved = 0
      if (settingsChanged) {
        changes.push('settings')
        await this.#insertPublication(tx, itemId, 'settings_change', {}, null, options.notify, userId, realAt, businessAt)
      }
      if (collectsResponses(next.placement) && (unitChanged || audienceChanged)) {
        const expanded = await expandRecipients(tx, {
          cohortId: item.cohort_id,
          audienceKind: next.audience_kind,
          groupIds: draft.groupIds,
          receiverUnit: next.receiver_unit,
        })
        const result = await this.#rebuildRoster(tx, next, receiverKeys(expanded), userId, businessAt, realAt)
        rosterAdded = result.added
        rosterRemoved = result.removed
      }

      if (deadlineChanged) {
        changes.push('deadline')
        if (item.due_at) {
          await this.#dueWork.cancel(tx, {
            kind: 'deadline_snapshot',
            subject: { type: SUBJECT_TYPE, id: itemId },
            deadlineVersion: item.deadline_version,
          })
        }
        if (next.due_at) {
          await this.#dueWork.schedule(tx, {
            kind: 'deadline_snapshot',
            subject: { type: SUBJECT_TYPE, id: itemId },
            deadlineVersion,
            dueBusinessAt: snapshotDueAt(next.due_at),
          })
        }
        await this.#insertPublication(tx, itemId, 'deadline_change', {}, deadlineVersion, options.notify, userId, realAt, businessAt)
      }

      // 通知：新加入收件名單的人一定收「新收件」；其他人看管理員有沒有選通知（小幅修改由管理員選）。
      const addedUserIds = await this.#userIdsOf(tx, rosterAdded)
      let notifiedCount = 0
      if (addedUserIds.length > 0) {
        await this.#events.publish(tx, {
          type: 'item.published',
          scope: 'cohort',
          cohortId: item.cohort_id,
          source: { type: SUBJECT_TYPE, id: itemId, version: contentVersionNo },
          actor: { kind: 'user', userId },
          recipients: addedUserIds,
          recipientBasis: { itemId, basis: 'response_rosters.added' },
          payload: this.#eventPayload(next),
          occurredRealAt: realAt,
          occurredBusinessAt: businessAt,
        })
        notifiedCount += addedUserIds.length
      }
      if (options.notify) {
        const everyone = await expandRecipients(tx, {
          cohortId: item.cohort_id,
          audienceKind: next.audience_kind,
          groupIds: draft.groupIds,
          receiverUnit: next.receiver_unit,
        })
        const recipients = everyone.notifyUserIds.filter((id) => !addedUserIds.includes(id))
        if (recipients.length > 0 || addedUserIds.length === 0) {
          await this.#events.publish(tx, {
            type: 'item.updated',
            scope: 'cohort',
            cohortId: item.cohort_id,
            source: { type: SUBJECT_TYPE, id: itemId, version: contentVersionNo },
            actor: { kind: 'user', userId },
            recipients,
            recipientBasis: { itemId, basis: collectsResponses(next.placement) ? 'response_rosters' : 'audience', changes },
            payload: { ...this.#eventPayload(next), changes },
            occurredRealAt: realAt,
            occurredBusinessAt: businessAt,
          })
        }
        notifiedCount += recipients.length
      }

      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'item.update_published',
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId: item.cohort_id,
        realAt,
        businessAt,
        payload: {
          changes,
          notify: options.notify,
          contentVersionNo,
          schemaVersionNo,
          deadlineVersion,
          rosterAdded: rosterAdded.length,
          rosterRemoved,
        },
      })

      const receipt = {
        itemId,
        title: next.title,
        revision: item.revision + 1,
        changes,
        contentVersionNo,
        schemaVersionNo,
        dueAt: next.due_at?.toISOString() ?? null,
        rosterAdded: rosterAdded.length,
        rosterRemoved,
        notify: options.notify,
        notifiedCount,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId } })
      return { ok: true as const, receipt }
    })
  }

  // ── 上傳 ────────────────────────────────────────────────────────────────────

  async startUpload(actor: ResolvedActor, input: StartItemUploadInput): Promise<Result<UploadTicket>> {
    const denied = authorizeAdmin(actor, '上傳專題事務的附件')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(input.cohortId)) return err('VALIDATION_FAILED', '請先選擇屆別。')
    const rules = ITEM_UPLOAD[input.kind]
    if (!rules) return err('VALIDATION_FAILED', '上傳的種類不對。')
    const issued = await this.#files.issueUploadTicket(
      actor.userId,
      { fileName: input.fileName, declaredMime: input.declaredMime, declaredSize: input.declaredSize },
      { purpose: 'attachment', allowedTypes: rules.allowedTypes, maxBytes: rules.maxBytes, scope: { kind: 'cohort', cohortId: input.cohortId } },
    )
    if (!issued.ok) return issued
    const { ticket, fileId, maxBytes, expiresAt } = issued.receipt
    return ok({ ticket, fileId, maxBytes, expiresAt }, { requestId: issued.receipt.requestId, serverTime: issued.receipt.serverTime })
  }

  // ── 發布前檢查與預覽 ────────────────────────────────────────────────────────

  async review(actor: ResolvedActor, input: ItemInput, itemId: string | null): Promise<Result<ItemReview>> {
    const denied = authorizeAdmin(actor, '檢查專題事務')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (itemId !== null && !isUuid(itemId)) return itemNotFound()
    const normalized = this.#normalize(input)
    if (!normalized.ok) return normalized
    const draft = normalized.value
    const businessAt = await this.#businessClock.now()

    const client = await this.#pool().connect()
    try {
      let openAt = businessAt
      let hasResponses = false
      if (itemId) {
        const found = await client.query<{ actual_opened_at: Date | null }>(
          'select actual_opened_at from managed_items where id = $1',
          [itemId],
        )
        if (!found.rows[0]) return itemNotFound()
        openAt = found.rows[0].actual_opened_at ?? businessAt
        hasResponses = await this.#responses.hasAnyResponse(client, itemId)
      }
      const expanded = await expandRecipients(client, {
        cohortId: draft.cohortId,
        audienceKind: draft.audienceKind,
        groupIds: draft.groupIds,
        receiverUnit: draft.receiverUnit,
      })
      const realAt = this.#realClock.now()
      return ok(
        {
          checks: publishChecks(draft, openAt),
          recipients: {
            receiverUnit: expanded.receiverUnit,
            people: expanded.people,
            groups: expanded.groups,
            notifyCount: expanded.notifyUserIds.length,
          },
          bodyHtml: draft.body,
          deadlineText: draft.dueAt ? describeDeadline(draft.dueAt) : null,
          openText: draft.opensAt ? `${formatTaipeiMinute(draft.opensAt)} 開放（臺灣時間）` : '發布即開放',
          hasResponses,
        },
        { requestId: uuidv7(), serverTime: realAt.toISOString() },
      )
    } finally {
      client.release()
    }
  }

  // ── 撤回、下架、重新發布（票 16） ────────────────────────────────────────────

  /**
   * 生命週期三個動作（產品模組 04 §4.5）。交易形狀同 `publish`：業務時間先讀 → 鎖屆別與項目 → 帳本 →
   * 檢查（屆別封存、revision、狀態、撤回時有沒有回答）→ 寫入 → 發布紀錄、事件、稽核 → 帳本 commit。
   *
   * 三個動作都**不動** `actual_opened_at`、不切新內容／欄位版本（重新發布恢復的就是下架前那一版）。
   *
   * 撤回（→ 草稿）：
   * - 結束目前的收件名單（寫結束時間與理由，不刪列）：草稿沒有名單；再發布時 `publish` 依當下的對象重建。
   *   不這樣做的話，再發布插新名單會撞 `response_rosters_one_current`。
   * - 取消還沒到的截止工作，並把期限版本 +1：`due_work` 的識別鍵含期限版本、排程是 `ON CONFLICT DO NOTHING`，
   *   沿用舊版本再排會拿回那一列「已取消」的工作，等於沒排。撤回只在沒有任何回答時才允許，換版本不影響任何人。
   *
   * 下架：名單、回答、截止工作全部保留（PUB-11「既有回答與 audit 保留」；截止快照對結案的收件仍有意義）。
   * 重新發布：只把狀態改回發布中；截止工作照原本的期限版本補排一次（已經在就不重複）。
   * 公告／資源重新發布時勾了「重要」，另發 `item.announced` 依當下對象逐人通知（Roy 2026-09-25 定）。
   */
  async changeStatus(
    actor: ResolvedActor,
    itemId: string,
    revision: number,
    action: LifecycleAction,
    requestId: string,
    options: { readonly notify?: boolean } = {},
  ): Promise<Result<LifecycleReceipt>> {
    if (!LIFECYCLE_ACTIONS.includes(action)) return err('VALIDATION_FAILED', '不認得這個動作，請重新整理頁面。')
    const denied = authorizeAdmin(actor, `${LIFECYCLE_LABEL[action]}專題事務`)
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId)) return itemNotFound()
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lock(tx, itemId)
      if (!locked) return itemNotFound()
      const { item } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: `item.${action}`,
          requestId,
          // 只有重新發布看「重要」選項；其他動作的指紋維持原樣。
          fingerprint: sha256(
            canonicalJson(action === 'republish' ? { itemId, revision, action, notify: options.notify === true } : { itemId, revision, action }),
          ),
          scope: 'cohort',
          cohortId: item.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<LifecycleReceipt>(begun)
      if (locked.cohortStatus === 'archived') return cohortArchived()
      if (item.revision !== revision) return staleRevision()

      // 「有沒有人作答」只有撤回要問（票 17 接上的真查詢：有人存過草稿或正式送出就算）。
      const hasResponses = action === 'withdraw' ? await this.#responses.hasAnyResponse(tx, itemId) : false
      const allowed = lifecycleCheck(action, item.status, hasResponses)
      if (!allowed.ok) return err(allowed.code, allowed.message)

      if (action === 'republish') {
        // 重新發布＝回到發布中，所以發布前檢查照樣要過（開放時間用第一次的實際開放時間）；
        // 下架期間組別可能解散、階段可能被改，引用也再驗一次。
        const failed = failedChecks(publishChecks(this.#stateOf(item, locked.groupIds), item.actual_opened_at ?? businessAt))
        if (failed.length > 0) {
          return err('VALIDATION_FAILED', describeFailedChecks(failed).replace('還不能發布', '還不能重新發布'), {
            details: { checks: failed.map((c) => c.key) },
          })
        }
        // 已經截止的收件不能直接回到發布中（學生會看到一份收不了的收件）。
        if (collectsResponses(item.placement) && item.due_at && isDeadlinePassed(businessAt, item.due_at)) {
          return err('VALIDATION_FAILED', describeRepublishExpired(item.due_at), { details: { checks: ['due'] } })
        }
        const refs = await this.#checkReferences(tx, {
          cohortId: item.cohort_id,
          stageId: item.stage_id,
          groupIds: locked.groupIds,
          placement: item.placement,
        })
        if (refs) return refs
      }

      const status = LIFECYCLE_NEXT_STATUS[action]
      let deadlineVersion = item.deadline_version
      let rosterClosed = 0
      if (action === 'withdraw') {
        const closed = await tx.query(
          `update response_rosters
              set eligible_to_business_at = greatest($2::timestamptz, eligible_from_business_at), removed_reason = $3,
                  revision = revision + 1, updated_at = $4, updated_by_user_id = $5
            where item_id = $1 and eligible_to_business_at is null`,
          [itemId, businessAt, ROSTER_REMOVED_BY_WITHDRAW, realAt, userId],
        )
        rosterClosed = closed.rowCount ?? 0
        if (item.due_at) {
          await this.#dueWork.cancel(tx, {
            kind: 'deadline_snapshot',
            subject: { type: SUBJECT_TYPE, id: itemId },
            deadlineVersion: item.deadline_version,
          })
          deadlineVersion = item.deadline_version + 1
        }
      }
      if (action === 'republish' && item.due_at) {
        await this.#dueWork.schedule(tx, {
          kind: 'deadline_snapshot',
          subject: { type: SUBJECT_TYPE, id: itemId },
          deadlineVersion: item.deadline_version,
          dueBusinessAt: snapshotDueAt(item.due_at),
        })
      }

      await tx.query(
        `update managed_items
            set status = $2, deadline_version = $3, revision = revision + 1, updated_at = $4, updated_by_user_id = $5
          where id = $1`,
        [itemId, status, deadlineVersion, realAt, userId],
      )
      const contentVersionNo = await this.#currentVersionNo(tx, 'item_versions', item.current_content_version_id)
      const schemaVersionNo = await this.#currentVersionNo(tx, 'form_schema_versions', item.current_schema_version_id)
      // 重新發布公告／資源時勾了「重要」：依當下對象逐人通知（Roy 2026-09-25 定）。收件項目不適用
      // （收件的新收件通知在第一次發布時已經發過，重新發布不重發）。
      const announce = action === 'republish' && options.notify === true && item.receiver_unit === 'none'
      await this.#insertPublication(
        tx,
        itemId,
        action,
        { contentVersionNo, schemaVersionNo },
        deadlineVersion !== item.deadline_version ? deadlineVersion : null,
        announce,
        userId,
        realAt,
        businessAt,
      )

      await this.#events.publish(tx, {
        type: LIFECYCLE_EVENT[action],
        scope: 'cohort',
        cohortId: item.cohort_id,
        source: { type: SUBJECT_TYPE, id: itemId, version: contentVersionNo },
        actor: { kind: 'user', userId },
        // 產品事件矩陣沒有這三種通知：不發給任何人，事件只留紀錄。
        recipients: [],
        payload: { ...this.#eventPayload(item), from: item.status, to: status },
        occurredRealAt: realAt,
        occurredBusinessAt: businessAt,
      })
      let notifiedCount = 0
      if (announce) {
        const recipients = await audienceUserIds(tx, item.cohort_id, item.audience_kind, locked.groupIds)
        await this.#events.publish(tx, {
          type: 'item.announced',
          scope: 'cohort',
          cohortId: item.cohort_id,
          source: { type: SUBJECT_TYPE, id: itemId, version: contentVersionNo },
          actor: { kind: 'user', userId },
          recipients,
          recipientBasis: { itemId, basis: 'audience', audienceKind: item.audience_kind, trigger: 'republish' },
          payload: this.#eventPayload(item),
          occurredRealAt: realAt,
          occurredBusinessAt: businessAt,
        })
        notifiedCount = recipients.length
      }
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: `item.${action}`,
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId: item.cohort_id,
        realAt,
        businessAt,
        payload: {
          placement: item.placement,
          from: item.status,
          to: status,
          contentVersionNo,
          schemaVersionNo,
          rosterClosed,
          deadlineVersion,
          actualOpenedAt: item.actual_opened_at?.toISOString() ?? null,
          ...(action === 'republish' ? { notify: announce } : {}),
        },
      })

      const receipt = {
        itemId,
        title: item.title,
        action,
        status,
        revision: item.revision + 1,
        actualOpenedAt: item.actual_opened_at?.toISOString() ?? null,
        rosterClosed,
        ...(action === 'republish' ? { notifiedCount } : {}),
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId } })
      return { ok: true as const, receipt }
    })
  }

  // ── 內部 ────────────────────────────────────────────────────────────────────

  #normalize(input: ItemInput): { ok: true; value: ItemDraft } | Err {
    const normalized = normalizeItemInput(input)
    if (!normalized.ok) {
      return err('VALIDATION_FAILED', normalized.message, normalized.field ? { details: { field: normalized.field } } : undefined)
    }
    // 正文存清理後的受限 HTML（契約 03 §5）。
    return { ok: true, value: { ...normalized.value, body: sanitizeBody(normalized.value.body) } }
  }

  #stateOf(item: ItemRow, groupIds: readonly string[]) {
    return {
      placement: item.placement as EditablePlacement,
      title: item.title,
      audienceKind: item.audience_kind,
      groupIds,
      receiverUnit: item.receiver_unit,
      stageId: item.stage_id,
      opensAt: item.opens_at,
      dueAt: item.due_at,
      fields: item.draft_schema.fields ?? [],
    }
  }

  #eventPayload(item: ItemRow): Record<string, unknown> {
    return {
      title: item.title,
      itemId: item.id,
      placement: item.placement,
      receiverUnit: item.receiver_unit,
      dueAt: item.due_at?.toISOString() ?? null,
    }
  }

  /** 鎖序：屆別（共享）→ 項目（排他）。回傳項目、屆別狀態、目前的指定組別與附件順序。 */
  async #lock(tx: PoolClient, itemId: string): Promise<Locked | null> {
    const head = await tx.query<{ cohort_id: string }>('select cohort_id from managed_items where id = $1', [itemId])
    const cohortId = head.rows[0]?.cohort_id
    if (!cohortId) return null
    const cohort = await tx.query<{ status: string }>('select status from cohorts where id = $1 for share', [cohortId])
    const found = await tx.query<ItemRow>(
      `select id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, actual_opened_at, due_at,
              deadline_version, current_content_version_id, current_schema_version_id, title, summary, body_html,
              cover_file_id, category, to_char(registration_deadline, 'YYYY-MM-DD') as registration_deadline,
              to_char(event_date, 'YYYY-MM-DD') as event_date, draft_schema, revision
         from managed_items where id = $1 for update`,
      [itemId],
    )
    const item = found.rows[0]
    if (!item || !cohort.rows[0]) return null
    const groups = await tx.query<{ group_id: string }>(
      'select group_id from item_audience_groups where item_id = $1 order by group_id',
      [itemId],
    )
    const attachments = await tx.query<{ file_id: string }>(
      'select file_id from item_attachments where item_id = $1 order by sort, file_id',
      [itemId],
    )
    return {
      item,
      cohortStatus: cohort.rows[0].status,
      groupIds: groups.rows.map((r) => r.group_id),
      attachmentIds: attachments.rows.map((r) => r.file_id),
    }
  }

  /** 階段要屬於這一屆；指定的組別要是這一屆、已成立。 */
  async #checkReferences(
    tx: PoolClient,
    draft: Pick<ItemDraft, 'cohortId' | 'stageId' | 'groupIds'> & { placement: Placement },
  ): Promise<Err | null> {
    if (draft.stageId) {
      const stage = await tx.query('select 1 from cohort_stages where id = $1 and cohort_id = $2', [draft.stageId, draft.cohortId])
      if (stage.rowCount === 0) return err('VALIDATION_FAILED', '所屬階段不是這一屆的，請重新選擇。', { details: { field: 'stageId' } })
    }
    if (draft.groupIds.length > 0) {
      const groups = await tx.query<{ id: string }>(
        `select id from groups where id = any($1::uuid[]) and cohort_id = $2 and status = 'active'`,
        [draft.groupIds, draft.cohortId],
      )
      if (groups.rowCount !== draft.groupIds.length) {
        return err('VALIDATION_FAILED', '有指定的組別已經解散或不是這一屆的，請重新選擇組別。', { details: { field: 'groupIds' } })
      }
    }
    return null
  }

  async #writeHead(tx: PoolClient, itemId: string, draft: ItemDraft, userId: string, realAt: Date, deadlineVersion?: number) {
    await tx.query(
      `update managed_items
          set placement = $2, audience_kind = $3, receiver_unit = $4, stage_id = $5, opens_at = $6, due_at = $7,
              title = $8, summary = $9, body_html = $10, cover_file_id = $11, category = $12, draft_schema = $13::jsonb,
              deadline_version = coalesce($14, deadline_version),
              registration_deadline = $17, event_date = $18,
              revision = revision + 1, updated_at = $15, updated_by_user_id = $16
        where id = $1`,
      [
        itemId,
        draft.placement,
        draft.audienceKind,
        draft.receiverUnit,
        draft.stageId,
        draft.opensAt,
        draft.dueAt,
        draft.title,
        draft.summary,
        draft.body,
        draft.coverFileId,
        draft.category,
        JSON.stringify({ fields: draft.fields }),
        deadlineVersion ?? null,
        realAt,
        userId,
        draft.registrationDeadline,
        draft.eventDate,
      ],
    )
  }

  async #replaceAudienceGroups(tx: PoolClient, itemId: string, groupIds: readonly string[]) {
    await tx.query('delete from item_audience_groups where item_id = $1', [itemId])
    if (groupIds.length > 0) {
      await tx.query(
        `insert into item_audience_groups (item_id, group_id) select $1, g from unnest($2::uuid[]) as g`,
        [itemId, groupIds],
      )
    }
  }

  /**
   * 附件與封面：新出現的檔案綁上引用（共用檔案能力 `attach`：鎖檔案列、驗上傳者與用途），
   * 拿掉的檔案釋放引用（只設 `released_at`，契約 01 §11），附件順序照畫面。
   */
  async #syncFiles(
    tx: PoolClient,
    itemId: string,
    userId: string,
    current: { attachments: readonly string[]; cover: string | null },
    next: Pick<ItemDraft, 'attachmentFileIds' | 'coverFileId'>,
  ): Promise<Err | null> {
    const ref: FileRef = { refType: FILE_REF_TYPE, refId: itemId }
    // 封面只接受圖片：上傳 ticket 已經限 png／jpg，但附件也是同一個用途，這裡以內容檢查後的類型再擋一次，
    // 不讓一份 PDF 附件被指成封面。
    if (next.coverFileId && next.coverFileId !== current.cover) {
      const cover = await tx.query<{ mime_detected: string | null }>(
        `select mime_detected from stored_files where id = $1 and status = 'stored'`,
        [next.coverFileId],
      )
      const mime = cover.rows[0]?.mime_detected
      if (!mime || !COVER_MIMES.includes(mime)) {
        return err('FILE_TYPE_REJECTED', '封面只能用圖片（PNG 或 JPG），請重新上傳封面。', { details: { field: 'cover' } })
      }
    }
    const before = fileSet(current.attachments, current.cover)
    const after = fileSet(next.attachmentFileIds, next.coverFileId)
    for (const fileId of after.filter((id) => !before.includes(id))) {
      const attached = await this.#files.attach(tx, fileId, ref, { ownerUserId: userId, purpose: 'attachment' })
      if (!attached.ok) return attached
    }
    for (const fileId of before.filter((id) => !after.includes(id))) {
      await this.#files.release(tx, fileId, ref)
    }
    await tx.query(
      `delete from item_attachments where item_id = $1 and not (file_id = any($2::uuid[]))`,
      [itemId, next.attachmentFileIds],
    )
    for (const [index, fileId] of next.attachmentFileIds.entries()) {
      await tx.query(
        `insert into item_attachments (item_id, file_id, sort) values ($1, $2, $3)
         on conflict (item_id, file_id) do update set sort = excluded.sort`,
        [itemId, fileId, index + 1],
      )
    }
    return null
  }

  async #insertContentVersion(tx: PoolClient, item: ItemRow, userId: string, realAt: Date): Promise<number> {
    const inserted = await tx.query<{ version_no: number }>(
      `insert into item_versions (id, item_id, version_no, title, summary, body_html, cover_file_id, category, created_by_user_id, created_at)
       select $1, $2, coalesce(max(version_no), 0) + 1, $3, $4, $5, $6, $7, $8, $9 from item_versions where item_id = $2
       returning version_no`,
      [uuidv7(), item.id, item.title, item.summary, item.body_html, item.cover_file_id, item.category, userId, realAt],
    )
    return inserted.rows[0]!.version_no
  }

  async #insertSchemaVersion(tx: PoolClient, item: ItemRow, userId: string, realAt: Date): Promise<number> {
    const inserted = await tx.query<{ version_no: number }>(
      `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id, created_at)
       select $1, $2, coalesce(max(version_no), 0) + 1, $3::jsonb, $4, $5 from form_schema_versions where item_id = $2
       returning version_no`,
      [uuidv7(), item.id, JSON.stringify({ fields: item.draft_schema.fields ?? [] }), userId, realAt],
    )
    return inserted.rows[0]!.version_no
  }

  async #currentVersionNo(tx: PoolClient, table: 'item_versions' | 'form_schema_versions', id: string | null): Promise<number> {
    if (!id) return 0
    const found = await tx.query<{ version_no: number }>(`select version_no from ${table} where id = $1`, [id])
    return found.rows[0]?.version_no ?? 0
  }

  async #insertPublication(
    tx: PoolClient,
    itemId: string,
    action: 'publish' | 'content_change' | 'schema_change' | 'settings_change' | 'deadline_change' | LifecycleAction,
    versions: { contentVersionNo?: number; schemaVersionNo?: number },
    deadlineVersion: number | null,
    notify: boolean,
    userId: string,
    realAt: Date,
    businessAt: Date,
  ) {
    await tx.query(
      `insert into item_publications
         (id, item_id, action, content_version_id, schema_version_id, deadline_version, notify, actor_user_id, real_at, business_at)
       values ($1, $2, $3,
               (select id from item_versions where item_id = $2 and version_no = $4),
               (select id from form_schema_versions where item_id = $2 and version_no = $5),
               $6, $7, $8, $9, $10)`,
      [
        uuidv7(),
        itemId,
        action,
        versions.contentVersionNo ?? null,
        versions.schemaVersionNo ?? null,
        deadlineVersion,
        notify,
        userId,
        realAt,
        businessAt,
      ],
    )
  }

  /** 名單列：依 id 排序插入（兩筆交易同時寫同一份名單時不會互鎖）。回傳插了幾列。 */
  async #insertRoster(
    tx: PoolClient,
    item: ItemRow,
    keys: readonly RosterKey[],
    userId: string,
    businessAt: Date,
    realAt: Date,
  ): Promise<number> {
    if (keys.length === 0) return 0
    const sorted = [...keys].sort((a, b) => a.id.localeCompare(b.id))
    await tx.query(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source,
          created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
       select gen_random_uuid(), $1, $2, k, r, $3, 'auto', $4, 'user', $5, $4, $5
         from unnest($6::text[], $7::uuid[]) as t(k, r)`,
      [item.id, item.cohort_id, businessAt, realAt, userId, sorted.map((k) => k.kind), sorted.map((k) => k.id)],
    )
    return sorted.length
  }

  async #rebuildRoster(
    tx: PoolClient,
    item: ItemRow,
    keys: readonly RosterKey[],
    userId: string,
    businessAt: Date,
    realAt: Date,
  ): Promise<{ added: RosterKey[]; removed: number }> {
    const current = await tx.query<{ receiver_kind: 'user' | 'group'; receiver_id: string }>(
      `select receiver_kind, receiver_id from response_rosters
        where item_id = $1 and eligible_to_business_at is null for update`,
      [item.id],
    )
    const key = (k: RosterKey) => `${k.kind}:${k.id}`
    const wanted = new Set(keys.map(key))
    const existing = current.rows.map((r) => ({ kind: r.receiver_kind, id: r.receiver_id }))
    const have = new Set(existing.map(key))
    const removed = existing.filter((k) => !wanted.has(key(k)))
    const added = keys.filter((k) => !have.has(key(k)))
    for (const k of removed) {
      await tx.query(
        `update response_rosters
            set eligible_to_business_at = greatest($4::timestamptz, eligible_from_business_at), removed_reason = $5,
                revision = revision + 1, updated_at = $6, updated_by_user_id = $7
          where item_id = $1 and receiver_kind = $2 and receiver_id = $3 and eligible_to_business_at is null`,
        [item.id, k.kind, k.id, businessAt, ROSTER_REMOVED_BY_SETTINGS, realAt, userId],
      )
    }
    await this.#insertRoster(tx, item, added, userId, businessAt, realAt)
    return { added, removed: removed.length }
  }

  async #userIdsOf(tx: PoolClient, keys: readonly RosterKey[]): Promise<string[]> {
    const users = keys.filter((k) => k.kind === 'user').map((k) => k.id)
    const groups = keys.filter((k) => k.kind === 'group').map((k) => k.id)
    return [...new Set([...users, ...(await memberUserIds(tx, groups))])].sort()
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'items', body, (constraint) =>
      constraint === 'response_rosters_one_current'
        ? err('CONFLICT', '收件名單剛剛被同時修改，請重新整理頁面再試一次。')
        : err('CONFLICT', '剛剛有人同時修改了這個項目，請重新整理頁面再試一次。'),
    )
  }
}

type RosterKey = { readonly kind: 'user' | 'group'; readonly id: string }

function receiverKeys(expanded: ExpandedRecipients): RosterKey[] {
  if (expanded.receiverUnit === 'individual') return expanded.people.map((p) => ({ kind: 'user' as const, id: p.userId }))
  if (expanded.receiverUnit === 'group') return expanded.groups.map((g) => ({ kind: 'group' as const, id: g.groupId }))
  return []
}

// ── 查詢 ──────────────────────────────────────────────────────────────────────

type ListRow = {
  id: string
  placement: Placement
  title: string
  status: ItemStatus
  audience_kind: AudienceKind
  group_codes: string[] | null
  receiver_unit: ReceiverUnit
  due_at: Date | null
  actual_opened_at: Date | null
  updated_at: Date
  roster_count: string
}

export class PgItemQuery implements ItemQuery {
  readonly #reader: () => Pick<Pool, 'query'>
  readonly #responses: { hasAnyResponse(itemId: string): Promise<boolean> }

  /**
   * `responses`：編輯器顯示「已有人作答、收件單位鎖定」用（票 17 的真查詢，由 composition 注入）。
   * 刻意沒有預設值——漏接就是恆 false，鎖定在畫面上永遠不亮。
   */
  constructor(reader: () => Pick<Pool, 'query'>, responses: { hasAnyResponse(itemId: string): Promise<boolean> }) {
    this.#reader = reader
    this.#responses = responses
  }

  async list(cohortId: string): Promise<ItemListRow[]> {
    if (!isUuid(cohortId)) return []
    const rows = await this.#reader().query<ListRow>(
      `select m.id, m.placement, m.title, m.status, m.audience_kind, m.receiver_unit, m.due_at, m.actual_opened_at,
              m.updated_at,
              (select array_agg(g.code order by g.code) from item_audience_groups a join groups g on g.id = a.group_id
                where a.item_id = m.id) as group_codes,
              (select count(*) from response_rosters r where r.item_id = m.id and r.eligible_to_business_at is null and not r.exempt)
                as roster_count
         from managed_items m
        where m.cohort_id = $1
        order by m.updated_at desc`,
      [cohortId],
    )
    return rows.rows.map((r) => ({
      id: r.id,
      placement: r.placement,
      title: r.title,
      status: r.status,
      audienceKind: r.audience_kind,
      audienceGroupCodes: r.group_codes ?? [],
      receiverUnit: r.receiver_unit,
      dueAt: r.due_at,
      actualOpenedAt: r.actual_opened_at,
      updatedAt: r.updated_at,
      rosterCount: Number(r.roster_count),
    }))
  }

  async get(itemId: string): Promise<ItemDetail | null> {
    if (!isUuid(itemId)) return null
    const db = this.#reader()
    const found = await db.query<
      Omit<ItemRow, 'registration_deadline' | 'event_date'> & {
        updated_at: Date
        content_no: number | null
        schema_no: number | null
        roster_count: string
        registration_deadline_day: string | null
        event_date_day: string | null
      }
    >(
      `select m.*, cv.version_no as content_no, sv.version_no as schema_no,
              to_char(m.registration_deadline, 'YYYY-MM-DD') as registration_deadline_day,
              to_char(m.event_date, 'YYYY-MM-DD') as event_date_day,
              (select count(*) from response_rosters r where r.item_id = m.id and r.eligible_to_business_at is null and not r.exempt)
                as roster_count
         from managed_items m
         left join item_versions cv on cv.id = m.current_content_version_id
         left join form_schema_versions sv on sv.id = m.current_schema_version_id
        where m.id = $1`,
      [itemId],
    )
    const item = found.rows[0]
    if (!item) return null
    const [groups, files, publications] = await Promise.all([
      db.query<{ group_id: string }>('select group_id from item_audience_groups where item_id = $1 order by group_id', [itemId]),
      db.query<{ id: string; original_name: string; size_bytes: string | null; sort: number | null }>(
        `select f.id, f.original_name, f.size_bytes, a.sort
           from stored_files f
           left join item_attachments a on a.file_id = f.id and a.item_id = $1
          where f.id in (select file_id from item_attachments where item_id = $1) or f.id = $2
          order by a.sort nulls last`,
        [itemId, item.cover_file_id],
      ),
      db.query<{ action: string; notify: boolean; actor_name: string; real_at: Date }>(
        `select p.action, p.notify, coalesce(pp.display_name, u.name) as actor_name, p.real_at
           from item_publications p
           join users u on u.id = p.actor_user_id
           left join user_profiles pp on pp.user_id = p.actor_user_id
          where p.item_id = $1 order by p.real_at desc, p.id desc limit 30`,
        [itemId],
      ),
    ])
    const summary = (row: { id: string; original_name: string; size_bytes: string | null }) => ({
      fileId: row.id,
      name: row.original_name,
      sizeBytes: Number(row.size_bytes ?? 0),
    })
    const coverRow = files.rows.find((f) => f.id === item.cover_file_id)
    return {
      id: item.id,
      cohortId: item.cohort_id,
      placement: item.placement,
      status: item.status,
      title: item.title,
      summary: item.summary,
      bodyHtml: item.body_html,
      category: item.category,
      cover: coverRow ? summary(coverRow) : null,
      attachments: files.rows.filter((f) => f.sort !== null).map(summary),
      audienceKind: item.audience_kind,
      groupIds: groups.rows.map((g) => g.group_id),
      receiverUnit: item.receiver_unit,
      stageId: item.stage_id,
      opensAt: item.opens_at,
      actualOpenedAt: item.actual_opened_at,
      dueAt: item.due_at,
      registrationDeadline: item.registration_deadline_day,
      eventDate: item.event_date_day,
      deadlineVersion: item.deadline_version,
      fields: item.draft_schema.fields ?? [],
      revision: item.revision,
      contentVersionNo: item.content_no,
      schemaVersionNo: item.schema_no,
      rosterCount: Number(item.roster_count),
      updatedAt: item.updated_at,
      hasResponses: await this.#responses.hasAnyResponse(itemId),
      publications: publications.rows.map((p) => ({
        action: p.action,
        notify: p.notify,
        actorName: p.actor_name,
        realAt: p.real_at,
      })),
    }
  }

  async editorOptions(cohortId: string): Promise<EditorOptions> {
    if (!isUuid(cohortId)) return { stages: [], groups: [] }
    const db = this.#reader()
    const [stages, groups] = await Promise.all([
      db.query<{ id: string; seq: number; name: string; start_date: string }>(
        `select id, seq, name, to_char(start_date, 'YYYY-MM-DD') as start_date
           from cohort_stages where cohort_id = $1 order by seq`,
        [cohortId],
      ),
      db.query<{ id: string; code: string; member_count: string }>(
        `select g.id, g.code,
                (select count(*) from group_memberships m where m.group_id = g.id and m.valid_to is null) as member_count
           from groups g where g.cohort_id = $1 and g.status = 'active' order by g.code`,
        [cohortId],
      ),
    ])
    return {
      stages: stages.rows.map((s) => ({ id: s.id, seq: s.seq, name: s.name, startDate: s.start_date })),
      groups: groups.rows.map((g) => ({ id: g.id, code: g.code, memberCount: Number(g.member_count) })),
    }
  }

  async previewRecipients(input: RecipientQueryInput): Promise<RecipientPreview> {
    if (!isUuid(input.cohortId) || input.groupIds.some((id) => !isUuid(id))) {
      return { receiverUnit: input.receiverUnit, people: [], groups: [], notifyCount: 0 }
    }
    const expanded = await expandRecipients(this.#reader(), input)
    return {
      receiverUnit: expanded.receiverUnit,
      people: expanded.people,
      groups: expanded.groups,
      notifyCount: expanded.notifyUserIds.length,
    }
  }
}
