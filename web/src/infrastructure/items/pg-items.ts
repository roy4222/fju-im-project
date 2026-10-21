import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import {
  CATEGORY_MAX_LENGTH,
  collectsResponses,
  describeDeadline,
  describeFailedChecks,
  failedChecks,
  ITEM_UPLOAD,
  describeRepublishExpired,
  deleteCheck,
  editableInArchivedCohort,
  HONOR_PLACEMENT,
  isConsentForm,
  isUuid,
  LIFECYCLE_LABEL,
  LIFECYCLE_NEXT_STATUS,
  lifecycleCheck,
  noopConsentPublishHook,
  normalizeItemInput,
  pinDenial,
  publishChecks,
  sanitizeBody,
  snapshotDueAt,
  storedPlacementOf,
  type AudienceKind,
  type ConsentItem,
  type ConsentMode,
  type ConsentPublished,
  type ConsentPublishHook,
  type ConsentPurpose,
  type DeleteReceipt,
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
  type PinReceipt,
  type Placement,
  type PublishReceipt,
  type ReceiverUnit,
  type RecipientPreview,
  type RecipientQueryInput,
  type RenameCategoryReceipt,
  type ResponsePresence,
  type RuleOrderReceipt,
  type RulesReorderReceipt,
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
import { personAvatar } from '@/infrastructure/db/person-avatar'
import { audienceUserIds, expandRecipients as expandAudience, memberUserIds, type ExpandedRecipients } from '@/infrastructure/items/recipients'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { reachFaultPoint } from '@/shared/fault-points'
import { err, ok, type Err, type Result } from '@/shared/result'
import { formatTaipeiMinute, isDeadlinePassed, RealClock, type Clock } from '@/shared/time'

/**
 * 專題事務的建立、存草稿、發布、發布更新（票 15；模組實作設計 04 §3、§6；模組 05 §5 `buildRoster`）。
 *
 * 每個寫入都是同一個形狀（契約 01 §8，照票 13 的 pg-groups）：業務時間在開交易**之前**讀一次 →
 * 開交易 → 鎖（`cohorts FOR SHARE` → `managed_items FOR UPDATE` → `stored_files FOR UPDATE`，契約 01 §6 的鎖順序；
 * 會改規則集合的路徑在最前面多一層屆別規則鎖，全表見 `lockRuleSet`）→ 帳本 `begin`
 * → 檢查 → 寫入 → 事件／到期工作／稽核 → 帳本 `commit` → COMMIT。回 `Err` 或丟例外整筆回滾。
 *
 * 發布是**一筆交易**：切內容版本與欄位版本、寫實際開放時間、發布紀錄、依對象展開收件名單、
 * 排截止到期工作、發事件，任何一步失敗全部不留（整合測試用故障注入點 `item.publish.after-roster` 證明）。
 */

const SUBJECT_TYPE = 'item'
const FILE_REF_TYPE = 'item_attachment' as const
const ROSTER_REMOVED_BY_SETTINGS = '誰看得到或繳交方式變更'
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
  consent_mode: ConsentMode | null
  consent_purpose: ConsentPurpose | null
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
  awarded_on: string | null
  pinned_at: Date | null
  draft_schema: { fields: FormField[] }
  revision: number
}

type Locked = { item: ItemRow; cohortStatus: string; groupIds: string[]; attachmentIds: string[]; deleted: boolean }

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  dueWork: DueWorkScheduler<PoolClient>
  files: FileStorage<PoolClient>
  responses: ResponsePresence<PoolClient>
  businessClock: BusinessClockSource
  /** 站內同意書發布、改內容、移出對象時建包／建新版／作廢（C1-03 接上；預設什麼都不做）。 */
  consent?: ConsentPublishHook<PoolClient>
  pool?: PoolSource
  realClock?: Clock
}

/**
 * 規則章節位置（A-14；Q198）的鎖與重編。
 *
 * 本模組**所有**寫入的全域鎖序（契約 01 §6 的 `cohorts → managed_items → stored_files`，前面多一層規則集合）：
 *
 *   1. 規則集合 advisory lock（`items.rules:<屆別>`，交易級）
 *   2. `cohorts FOR SHARE`
 *   3. `managed_items FOR UPDATE`：拿了 1 的路徑一次鎖**整屆規則列＋目標項目**（依 id）；沒拿 1 的路徑只鎖自己那一列
 *   4. `stored_files FOR UPDATE`（`#syncFiles` → `files.attach`，依檔案 id）
 *   5. 之後只剩同一項目自己的子表（`item_attachments`、`file_references`、`response_rosters`、版本、名單）與純插入
 *
 * | 路徑 | 1 規則集合 | 2 屆別 | 3 項目列 | 4 檔案列 |
 * |---|---|---|---|---|
 * | `create`（規則） | 拿 | 共享 | 整屆規則列（新列只有自己看得到） | 附件、封面 |
 * | `create`（其他） | — | 共享 | — | 附件、封面 |
 * | `saveDraft`（換進或換出規則） | 拿 | 共享 | 整屆規則列＋自己 | 附件、封面 |
 * | `saveDraft`（不換集合，含規則改內容） | — | 共享 | 自己 | 附件、封面 |
 * | `delete`（規則） | 拿 | 共享 | 整屆規則列（含自己） | — |
 * | `moveRule` | 拿 | 共享 | 整屆規則列（含自己） | — |
 * | `publish`、`updatePublished`、`changeStatus`、`setPinned`、`delete`（其他） | — | 共享 | 自己 | `updatePublished` 的附件、封面 |
 *
 * 真正擋住等待環的是第 3 步：**會改到別人那一列**（整屆重編、交換）的交易，在碰任何檔案列之前就把它可能改到的每一列都
 * 鎖好；其他交易只鎖自己一列再鎖檔案。兩邊都是「項目列 → 檔案列」，不會一方握著檔案列等項目列、另一方握著項目列等檔案列
 * （Review 第 2 輪的反例）。第 1 步讓會改集合的交易彼此排隊（並行把兩筆草稿改成規則不會拿到同一個號、移動時集合不會被別人
 * 換掉；Review 第 1 輪的反例），而且在拿任何列鎖之前就拿，所以不會握著列等它。集合內依 id 鎖不是防環的關鍵（拿了 advisory
 * 的交易彼此不會同時走到第 3 步），只是便宜的保險；檔案列依 id 則擋掉兩筆同時附上同一組檔案、順序相反的互等。
 *
 * 要不要拿第 1 步，在鎖任何列之前用不加鎖的讀決定（`headOf`）；鎖到之後 placement 跟當時讀到的不同就回 `staleRevision`，
 * 不在沒拿規則鎖的情況下動集合。這個判斷放在帳本 `begin` 的 replay／mismatch 之後、業務寫入之前：同一個請求編號並行重送時，
 * 第二筆排在規則鎖後面才鎖到，看到的位置是第一筆剛換的，要先拿回原回執而不是回 CONFLICT（契約 01 §8；Review 第 3 輪）。
 * 帳本前只剩「找不到項目／屆別」：列不存在時帳本列的 `cohort_id` 無從取得（且有 FK），是結構性的；已刪除的列只有 `delete`
 * 自己用 `includeDeleted` 先過帳本，其他路徑在帳本前就回找不到，是 `#lock` 註解裡的既定選擇，不是本次並行重送的情境。
 *
 * 位置一律在規則鎖下整屆重編成 1..n（順序 `rules_position asc nulls last, actual_opened_at asc, id asc`，
 * 跟前台、系辦清單同一個）：NULL、重複、缺號（刪掉中間一章）都在同一筆交易裡收掉。新加入的規則位置是 NULL，重編後排最後。
 * 重編與交換只會 UPDATE 到 `lockRuleSet` 已鎖住的列。
 */
async function lockRuleSet(tx: PoolClient, cohortId: string, itemId: string | null): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('items.rules:' || $1::uuid::text, 0))`, [cohortId])
  await tx.query('select 1 from cohorts where id = $1 for share', [cohortId])
  await tx.query(
    `select id from managed_items
      where cohort_id = $1 and ((placement = 'rules' and deleted_at is null) or id = $2)
      order by id for update`,
    [cohortId, itemId],
  )
}

async function renumberRules(tx: PoolClient, cohortId: string): Promise<void> {
  await tx.query(
    `update managed_items m set rules_position = v.pos
       from (select id, row_number() over (order by rules_position asc nulls last, actual_opened_at asc, id asc) as pos
               from managed_items where cohort_id = $1 and placement = 'rules' and deleted_at is null) v
      where m.id = v.id and m.rules_position is distinct from v.pos`,
    [cohortId],
  )
}

/** 不加鎖先讀項目的屆別與位置（屆別建立後不會換），決定要不要先拿規則鎖。 */
async function headOf(tx: PoolClient, itemId: string): Promise<{ cohort_id: string; placement: string } | null> {
  const head = await tx.query<{ cohort_id: string; placement: string }>(
    'select cohort_id, placement from managed_items where id = $1',
    [itemId],
  )
  return head.rows[0] ?? null
}

function itemNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個項目，請回到公告與作業列表重新整理。')
}

function cohortArchived(): Err {
  return err('COHORT_ARCHIVED', '這一屆已經封存，不能再建立或修改公告或作業。')
}

/**
 * 屆別封存擋不擋這次寫入：封存屆別一律擋，**除了榮譽**（跨屆的公開紀錄，第三波 W1）。
 * 存草稿會換位置，所以原本的位置與要存的位置都要是榮譽才放行。
 */
function archivedBlocks(cohortStatus: string, ...placements: readonly string[]): boolean {
  return cohortStatus === 'archived' && !placements.every((p) => editableInArchivedCohort(p))
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

/** 欄位的「結構」：拿掉欄名與說明（AC-5 有人作答後仍可改）。空的選項清單當成沒有，檔案型別不看勾選順序。 */
function fieldStructure(field: FormField) {
  return {
    key: field.key,
    type: field.type,
    required: field.required,
    options: field.options && field.options.length > 0 ? field.options : null,
    fileRules: field.fileRules ? { allowedTypes: [...field.fileRules.allowedTypes].sort(), maxMiB: field.fileRules.maxMiB } : null,
  }
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

/** 有老師角色、帳號正常的人（給老師的作業的收件名單；老師不分屆，「該屆啟用中老師」就是全部啟用中的老師）。 */
const ACTIVE_TEACHER = `
  u.status = 'active' and u.deidentified_at is null
  and exists (select 1 from role_assignments r where r.user_id = u.id and r.role = 'teacher' and r.revoked_real_at is null)`

/**
 * 依對象展開收件者（`recipients.ts` 的 `expandRecipients`），多一種：給老師的作業（C 階段規格① T3）。
 * 對象「全部老師」＋個人一份 → 名單是啟用中、有老師角色的帳號，每人一列（預覽與建名單同一段）。
 */
async function expandRecipients(
  db: Pick<Pool, 'query'> | PoolClient,
  input: RecipientQueryInput,
): Promise<ExpandedRecipients> {
  if (input.audienceKind !== 'teachers' || input.receiverUnit !== 'individual') return expandAudience(db, input)
  const rows = await db.query<{ user_id: string; name: string }>(
    `select u.id as user_id, coalesce(p.display_name, u.name) as name
       from users u left join user_profiles p on p.user_id = u.id
      where ${ACTIVE_TEACHER}
      order by name, u.id`,
  )
  const people = rows.rows.map((r) => ({ userId: r.user_id, name: r.name, studentNo: null, groupCode: null }))
  return { receiverUnit: 'individual', people, groups: [], notifyUserIds: [...new Set(people.map((p) => p.userId))].sort() }
}

/**
 * 站內同意書發布前要查資料庫的兩件事（`publishChecks` 的 `consentFacts`）：對象組裡有主指導的組數、
 * 最終文件授權時還沒有成果展示草稿的組代號。對象組＝本屆全部已成立組（本屆學生）或指定組別。
 */
async function consentFactsOf(
  db: Pick<Pool, 'query'> | PoolClient,
  input: { cohortId: string; audienceKind: AudienceKind; groupIds: readonly string[]; purpose: ConsentPurpose | null },
): Promise<{ advisedGroupCount: number; groupsWithoutShowcaseDraft: string[] }> {
  const scoped = input.audienceKind === 'groups' ? input.groupIds : null
  const rows = await db.query<{ code: string; advised: boolean; has_draft: boolean }>(
    `select g.code,
            exists (select 1 from advisor_assignments a where a.group_id = g.id and a.valid_to is null) as advised,
            exists (select 1 from showcase_entries e join showcase_drafts d on d.entry_id = e.id
                     where e.group_id = g.id and e.cohort_id = g.cohort_id and e.deleted_at is null) as has_draft
       from groups g
      where g.cohort_id = $1 and g.status = 'active' and ($2::uuid[] is null or g.id = any($2::uuid[]))
      order by g.code`,
    [input.cohortId, scoped],
  )
  return {
    advisedGroupCount: rows.rows.filter((r) => r.advised).length,
    groupsWithoutShowcaseDraft: input.purpose === 'final_document' ? rows.rows.filter((r) => !r.has_draft).map((r) => r.code) : [],
  }
}

/** 資源分類名的整理（同表單的分類欄：控制字元換空白、去頭尾空白、40 字以內）。 */
function cleanCategory(value: unknown): string {
  if (typeof value !== 'string') return ''
  return [...value].map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch)).join('').trim()
}

export class PgItemCommand implements ItemCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #dueWork: DueWorkScheduler<PoolClient>
  readonly #files: FileStorage<PoolClient>
  readonly #responses: ResponsePresence<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #consent: ConsentPublishHook<PoolClient>
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
    this.#consent = deps.consent ?? (noopConsentPublishHook as ConsentPublishHook<PoolClient>)
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  // ── 建立與存草稿 ────────────────────────────────────────────────────────────

  async create(actor: ResolvedActor, input: ItemInput, requestId: string): Promise<Result<SaveReceipt>> {
    const denied = authorizeAdmin(actor, '建立公告或作業')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    const normalized = this.#normalize(input)
    if (!normalized.ok) return normalized
    const draft = normalized.value
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      // 新規則會加進同屆規則集合：先拿規則鎖、鎖住整屆規則列，之後才鎖檔案（鎖序見 `lockRuleSet`）。
      if (draft.placement === 'rules' && isUuid(draft.cohortId)) await lockRuleSet(tx, draft.cohortId, null)
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
      if (archivedBlocks(cohort.rows[0].status, draft.placement)) return cohortArchived()

      const refs = await this.#checkReferences(tx, draft)
      if (refs) return refs

      const itemId = uuidv7()
      await tx.query(
        `insert into managed_items
           (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, due_at,
            title, summary, body_html, cover_file_id, category, draft_schema,
            created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id,
            registration_deadline, event_date, awarded_on, consent_mode, consent_purpose)
         values ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
                 $15, 'user', $16, $15, $16, $17, $18, $19, $20, $21)`,
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
          draft.awardedOn,
          draft.consentMode,
          draft.consentPurpose,
        ],
      )
      // 新規則排到同屆最後（位置 NULL → 重編成 n）。
      if (draft.placement === 'rules') await renumberRules(tx, draft.cohortId)
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
        payload: {
          placement: draft.placement,
          title: draft.title,
          receiverUnit: draft.receiverUnit,
          ...(draft.consentMode ? { consentMode: draft.consentMode, consentPurpose: draft.consentPurpose } : {}),
        },
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
    const denied = authorizeAdmin(actor, '編輯公告或作業')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId)) return itemNotFound()
    const normalized = this.#normalize(input)
    if (!normalized.ok) return normalized
    const draft = normalized.value
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      // 換進或換出規則會改同屆規則集合：先拿規則鎖、鎖住整屆規則列＋自己，之後才鎖檔案（鎖序見 `lockRuleSet`）。
      // 規則改內容、公告改公告不動集合，只鎖自己那一列。
      const head = await headOf(tx, itemId)
      const setChanges =
        head !== null && head.placement !== draft.placement && (head.placement === 'rules' || draft.placement === 'rules')
      if (setChanges) await lockRuleSet(tx, head.cohort_id, itemId)
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
      // 要不要拿規則鎖是照不加鎖讀到的 placement 決定的；鎖到之後不一樣（剛有人換過，revision 也一定變了）就當過期，
      // 不在沒拿規則鎖的情況下動集合。只對第一次送達的請求判：同一個請求編號排在規則鎖後面重送時，位置是自己前一筆
      // 換的，上面已經拿回原回執（Review 第 3 輪的反例）。
      if (head && item.placement !== head.placement) return staleRevision()
      if (archivedBlocks(locked.cohortStatus, item.placement, draft.placement)) return cohortArchived()
      if (item.revision !== revision) return staleRevision()
      if (item.status !== 'draft') {
        return err('VALIDATION_FAILED', '這個項目已經發布了；已發布的修改請按「發布更新」。')
      }
      if (draft.cohortId !== item.cohort_id) return err('VALIDATION_FAILED', '項目建立後不能換屆別；請另建一筆。')

      const refs = await this.#checkReferences(tx, draft)
      if (refs) return refs
      const files = await this.#syncFiles(tx, itemId, userId, { attachments: locked.attachmentIds, cover: item.cover_file_id }, draft)
      if (files) return files
      // 「專題需求」以作業載入表單，存回去保留原本的位置（`storedPlacementOf`）。
      await this.#writeHead(tx, itemId, { ...draft, placement: storedPlacementOf(item.placement, draft.placement) }, userId, realAt)
      // 換進規則 → 排到最後；換出規則 → 位置已清掉，其餘的補成連號（只動 `lockRuleSet` 已鎖的列）。
      if (setChanges) await renumberRules(tx, item.cohort_id)
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
    const denied = authorizeAdmin(actor, '發布公告或作業')
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
      if (archivedBlocks(locked.cohortStatus, item.placement)) return cohortArchived()
      if (item.revision !== revision) return staleRevision()
      if (item.status !== 'draft') return err('VALIDATION_FAILED', '這個項目已經發布了，請重新整理頁面。')

      // 發布前檢查：畫面顯示的同一份清單，任何一條沒過就不寫任何東西（PUB-13）。
      // 開放時間：有設就用設定的；沒設＝發布即開放（這一刻）。撤回後再發布（票 16）用第一次的實際開放時間。
      const openAt = item.actual_opened_at ?? businessAt
      const consentForm = isConsentForm({ placement: item.placement, consentMode: item.consent_mode })
      const consentFacts = consentForm
        ? await consentFactsOf(tx, { cohortId: item.cohort_id, audienceKind: item.audience_kind, groupIds, purpose: item.consent_purpose })
        : undefined
      const failed = failedChecks(publishChecks({ ...this.#stateOf(item, groupIds), consentFacts }, openAt))
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
      // 榮譽榜不發通知（第三波 W1：公開的得獎消息，不逐人通知全站）。站內同意書不發「新作業」：
      // 同一批人會收到簽核包的「輪到你同意」，不要再多一則（C 階段規格① §1.2）。
      const notify = consentForm ? false : collects || (options.notify && item.placement !== HONOR_PLACEMENT)
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

      // 站內同意書：同一筆交易裡每個對象組建包＋第 1 版（hook 回錯就整筆回滾，作業仍是草稿）。
      let consent: ConsentPublished | null = null
      if (consentForm) {
        const built = await this.#consent.onPublished(
          tx,
          await this.#consentItem(tx, item, expanded.groups.map((g) => g.groupId).sort()),
          userId,
          requestId,
        )
        if (!built.ok) return built
        consent = { created: built.receipt.created, skipped: built.receipt.skipped }
      }

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
          ...(consent ? { consent: { created: consent.created, skipped: consent.skipped.length } } : {}),
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
        consent,
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
    const denied = authorizeAdmin(actor, '修改公告或作業')
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
      if (archivedBlocks(locked.cohortStatus, item.placement)) return cohortArchived()
      // 榮譽榜不發通知（第三波 W1）。站內同意書不發一般的「作業已更新」：同意書的通知（內容已更新、輪到你同意）
      // 由簽核模組的 hook 發，這裡再發會重複（C 階段規格① §1.2、AC-23）。
      const consentForm = isConsentForm({ placement: item.placement, consentMode: item.consent_mode })
      const notify = options.notify && item.placement !== HONOR_PLACEMENT && !consentForm
      if (item.revision !== revision) return staleRevision()
      if (item.status === 'draft') return err('VALIDATION_FAILED', '這個項目還是草稿；請按「存草稿」或「發布」。')
      if (item.status !== 'published') return err('VALIDATION_FAILED', '已下架的項目要先重新發布才能修改。')
      if (draft.cohortId !== item.cohort_id) return err('VALIDATION_FAILED', '項目建立後不能換屆別；請另建一筆。')
      if (storedPlacementOf(item.placement, draft.placement) !== item.placement) {
        return err('VALIDATION_FAILED', '已發布的項目不能換顯示的區塊；要換區塊請另建一筆。')
      }
      // 同意書的模式與用途發布後鎖定（簽核包的用途與凍結範圍是照它建的，C 階段規格① §1.1）。
      if (draft.consentMode !== item.consent_mode || draft.consentPurpose !== item.consent_purpose) {
        return err('VALIDATION_FAILED', '發布後不能改同意書的形式或用途；要換請另建一份同意書。', { details: { field: 'consentMode' } })
      }
      if (!sameTime(draft.opensAt, item.opens_at)) {
        return err('VALIDATION_FAILED', '已發布的作業不能改開放時間（實際開放時間已經記下）。')
      }

      const contentChanged =
        draft.title !== item.title ||
        draft.summary !== item.summary ||
        draft.body !== item.body_html ||
        draft.category !== item.category ||
        draft.coverFileId !== item.cover_file_id ||
        !sameIds(draft.attachmentFileIds, locked.attachmentIds)
      const schemaChanged = canonicalJson(draft.fields) !== canonicalJson(item.draft_schema.fields ?? [])
      // 有人作答後只鎖「結構」（C 階段規格① AC-5）：key、型別、必填、選項、檔案規則、順序與欄位數。欄名與說明可以改，
      // 照樣切新的欄位版本（學生看到新欄名，交過的版本仍指向當時那一版）。
      const structureChanged = canonicalJson(draft.fields.map(fieldStructure)) !== canonicalJson((item.draft_schema.fields ?? []).map(fieldStructure))
      const unitChanged = draft.receiverUnit !== item.receiver_unit
      const audienceChanged = draft.audienceKind !== item.audience_kind || !sameSet(draft.groupIds, groupIds)
      const stageChanged = draft.stageId !== item.stage_id
      const deadlineChanged = !sameTime(draft.dueAt, item.due_at)
      // 競賽資訊的報名截止／活動日（0011）：發布設定，跟階段一樣記成「設定變更」。
      // 榮譽的得獎日期（0011，第三波 W1）同樣算設定變更。
      const competitionDatesChanged =
        draft.registrationDeadline !== item.registration_deadline ||
        draft.eventDate !== item.event_date ||
        draft.awardedOn !== item.awarded_on
      const settingsChanged = unitChanged || audienceChanged || stageChanged || competitionDatesChanged
      if (!contentChanged && !schemaChanged && !settingsChanged && !deadlineChanged) {
        return err('VALIDATION_FAILED', '沒有任何修改。')
      }

      // 有人作答後：收件單位鎖定，對象與欄位結構也不在這裡改（產品模組 04 §4.5；改結構與受眾變更在後面的票）。
      if ((unitChanged || audienceChanged || structureChanged) && (await this.#responses.hasAnyResponse(tx, itemId))) {
        if (unitChanged) {
          return err('ITEM_HAS_RESPONSES', '已經有人作答，繳交方式（個人一份／整組一份）不能再切換；需要另一種繳交方式請另建一筆。')
        }
        if (audienceChanged) {
          return err('ITEM_HAS_RESPONSES', '已經有人作答，這裡不能直接改誰看得到（名單與完成率要重算，功能在後續版本）。')
        }
        return err('ITEM_HAS_RESPONSES', '已經有人作答，繳交欄位不能原地改；改結構要建立新的表單版本並預覽影響（功能在後續版本）。')
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
      await this.#writeHead(tx, itemId, { ...draft, placement: item.placement as EditablePlacement }, userId, realAt, deadlineVersion)
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
        awarded_on: draft.awardedOn,
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
        await this.#insertPublication(tx, itemId, 'content_change', { contentVersionNo }, null, notify, userId, realAt, businessAt)
      }
      if (schemaChanged) {
        changes.push('schema')
        schemaVersionNo = await this.#insertSchemaVersion(tx, next, userId, realAt)
        await tx.query(
          `update managed_items set current_schema_version_id =
             (select id from form_schema_versions where item_id = $1 and version_no = $2) where id = $1`,
          [itemId, schemaVersionNo],
        )
        await this.#insertPublication(tx, itemId, 'schema_change', { schemaVersionNo }, null, notify, userId, realAt, businessAt)
      }

      // 對象或收件單位變了：名單重算。已不在新對象裡的收件者寫結束時間與理由（不刪列），新進的插新列。
      let rosterAdded: RosterKey[] = []
      let rosterRemoved: RosterKey[] = []
      if (settingsChanged) {
        changes.push('settings')
        await this.#insertPublication(tx, itemId, 'settings_change', {}, null, notify, userId, realAt, businessAt)
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

      // 站內同意書：移出對象的組作廢目前版本；正文或附件有變，進行中的包建新版（只改標題、對象、截止不建新版）。
      if (consentForm) {
        const dropped = rosterRemoved.filter((k) => k.kind === 'group').map((k) => k.id)
        if (dropped.length > 0) {
          const voided = await this.#consent.onGroupsRemoved(tx, itemId, dropped, userId, requestId)
          if (!voided.ok) return voided
        }
      }
      if (consentForm && (draft.body !== item.body_html || !sameIds(draft.attachmentFileIds, locked.attachmentIds))) {
        const groups = await tx.query<{ receiver_id: string }>(
          `select receiver_id from response_rosters
            where item_id = $1 and receiver_kind = 'group' and eligible_to_business_at is null order by receiver_id`,
          [itemId],
        )
        const changed = await this.#consent.onContentChanged(
          tx,
          await this.#consentItem(tx, next, groups.rows.map((r) => r.receiver_id), draft.attachmentFileIds),
          userId,
          requestId,
        )
        if (!changed.ok) return changed
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
        await this.#insertPublication(tx, itemId, 'deadline_change', {}, deadlineVersion, notify, userId, realAt, businessAt)
      }

      // 通知：新加入收件名單的人一定收「新收件」；其他人看管理員有沒有選通知（小幅修改由管理員選）。
      // 站內同意書不發「新作業」（新進的組由系辦在繳交狀況頁按「建立」，建包時才通知）。
      const addedUserIds = consentForm ? [] : await this.#userIdsOf(tx, rosterAdded)
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
      if (notify) {
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
          notify,
          contentVersionNo,
          schemaVersionNo,
          deadlineVersion,
          rosterAdded: rosterAdded.length,
          rosterRemoved: rosterRemoved.length,
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
        rosterRemoved: rosterRemoved.length,
        notify,
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
    const denied = authorizeAdmin(actor, '上傳公告或作業的附件')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(input.cohortId)) return err('VALIDATION_FAILED', '請先選擇屆別。')
    const rules = ITEM_UPLOAD[input.kind]
    if (!rules) return err('VALIDATION_FAILED', '上傳的種類不對。')
    // 封存屆別只有榮譽還能上傳（AC-55）。`placement` 是畫面帶來的：謊報成榮譽最多多一個檔，
    // 存成非榮譽項目時存草稿的封存守門會擋、檔案綁不上去，之後由無引用檔案清理收掉。
    const client = await this.#pool().connect()
    let cohortStatus: string | undefined
    try {
      cohortStatus = (await client.query<{ status: string }>('select status from cohorts where id = $1', [input.cohortId])).rows[0]?.status
    } finally {
      client.release()
    }
    if (cohortStatus && archivedBlocks(cohortStatus, input.placement)) return cohortArchived()
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
    const denied = authorizeAdmin(actor, '檢查公告或作業')
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
          'select actual_opened_at from managed_items where id = $1 and deleted_at is null',
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
      const consentFacts = isConsentForm(draft)
        ? await consentFactsOf(client, {
            cohortId: draft.cohortId,
            audienceKind: draft.audienceKind,
            groupIds: draft.groupIds,
            purpose: draft.consentPurpose,
          })
        : undefined
      const realAt = this.#realClock.now()
      return ok(
        {
          checks: publishChecks({ ...draft, consentFacts }, openAt),
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
    const denied = authorizeAdmin(actor, `${LIFECYCLE_LABEL[action]}公告或作業`)
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
      if (archivedBlocks(locked.cohortStatus, item.placement)) return cohortArchived()
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

      // 撤回、下架同一筆順手取消置頂（第 1 批 V1）；重新發布不恢復，要置頂再按一次。
      await tx.query(
        `update managed_items
            set status = $2, deadline_version = $3, revision = revision + 1, updated_at = $4, updated_by_user_id = $5,
                pinned_at = case when $2 = 'published' then pinned_at end
          where id = $1`,
        [itemId, status, deadlineVersion, realAt, userId],
      )
      const contentVersionNo = await this.#currentVersionNo(tx, 'item_versions', item.current_content_version_id)
      const schemaVersionNo = await this.#currentVersionNo(tx, 'form_schema_versions', item.current_schema_version_id)
      // 重新發布公告／資源時勾了「重要」：依當下對象逐人通知（Roy 2026-09-25 定）。收件項目不適用
      // （收件的新收件通知在第一次發布時已經發過，重新發布不重發）。
      const announce =
        action === 'republish' && options.notify === true && item.receiver_unit === 'none' && item.placement !== HONOR_PLACEMENT
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

  // ── 刪除（第三波 W1） ──────────────────────────────────────────────────────

  /**
   * 刪除：只限草稿與已下架；收件項目有任何回答（存過草稿或正式送出）就擋下，只能下架（Q28）。
   * 交易形狀同 `changeStatus`。不實體刪列（權限矩陣不給刪、子表外鍵全是 restrict）：寫刪除標記與稽核
   * `item.deleted`（payload 留刪除前的狀態、標題、屆別、位置，之後只剩稽核看得到）。
   *
   * 已下架的收件還排著截止快照工作：一起取消（沒有回答才刪得掉，快照沒有意義）。名單列、附件引用照留；
   * 已寄的通知不收回（點開是找不到）。屆別封存時只有榮譽可以刪（同其他寫入）。
   */
  async delete(actor: ResolvedActor, itemId: string, revision: number, requestId: string): Promise<Result<DeleteReceipt>> {
    const denied = authorizeAdmin(actor, '刪除公告或作業')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId)) return itemNotFound()
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      // 刪掉規則會留下缺號：先拿規則鎖、鎖住整屆規則列（鎖序見 `lockRuleSet`），刪完同一筆交易補成連號。
      const head = await headOf(tx, itemId)
      const rulesLocked = head?.placement === 'rules'
      if (rulesLocked) await lockRuleSet(tx, head.cohort_id, itemId)
      const locked = await this.#lock(tx, itemId, { includeDeleted: true })
      if (!locked) return itemNotFound()
      const { item } = locked

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'item.delete',
          requestId,
          fingerprint: sha256(canonicalJson({ itemId, revision, action: 'delete' })),
          scope: 'cohort',
          cohortId: item.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<DeleteReceipt>(begun)
      // 同 `saveDraft`：位置過期只對第一次送達的請求判，重送先拿回原回執。
      if (head && item.placement !== head.placement) return staleRevision()
      if (locked.deleted) return itemNotFound()
      if (archivedBlocks(locked.cohortStatus, item.placement)) return cohortArchived()
      if (item.revision !== revision) return staleRevision()

      const hasResponses = item.status === 'published' ? false : await this.#responses.hasAnyResponse(tx, itemId)
      const allowed = deleteCheck(item.status, hasResponses)
      if (!allowed.ok) return err(allowed.code, allowed.message)

      if (item.due_at) {
        await this.#dueWork.cancel(tx, {
          kind: 'deadline_snapshot',
          subject: { type: SUBJECT_TYPE, id: itemId },
          deadlineVersion: item.deadline_version,
        })
      }
      await tx.query(
        `update managed_items
            set deleted_at = $2, deleted_by_user_id = $3, revision = revision + 1, updated_at = $2, updated_by_user_id = $3,
                rules_position = null
          where id = $1`,
        [itemId, realAt, userId],
      )
      if (rulesLocked) await renumberRules(tx, item.cohort_id)
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'item.deleted',
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId: item.cohort_id,
        realAt,
        businessAt,
        payload: { placement: item.placement, status: item.status, title: item.title, cohortId: item.cohort_id },
      })

      const receipt = {
        itemId,
        cohortId: item.cohort_id,
        title: item.title,
        status: item.status,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId } })
      return { ok: true as const, receipt }
    })
  }

  // ── 置頂（第 1 批 V1；Q48-a） ─────────────────────────────────────────────────

  /**
   * 置頂／取消置頂：交易形狀同 `changeStatus`（鎖、帳本、稽核），但只寫 `pinned_at`——不動 `revision`
   * （編輯器開著的草稿存檔不會變成「別人改過」）、不動 `updated_at`（工作台的順序不因置頂跳動）、
   * 不切版本、不寫發布紀錄、不發事件。置頂時間用真實時間（多則置頂時後置頂的在前，D9；不設上限）。
   * 已經是目標狀態：帳本照記、回 ok，不改資料也不寫稽核（原本的置頂時間不變）。
   */
  async setPinned(actor: ResolvedActor, itemId: string, pinned: boolean, requestId: string): Promise<Result<PinReceipt>> {
    const denied = authorizeAdmin(actor, pinned ? '置頂公告' : '取消置頂公告')
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
      const action = pinned ? 'item.pin' : 'item.unpin'
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: action,
          requestId,
          fingerprint: sha256(canonicalJson({ itemId, pinned })),
          scope: 'cohort',
          cohortId: item.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<PinReceipt>(begun)
      if (archivedBlocks(locked.cohortStatus, item.placement)) return cohortArchived()
      const refusal = pinned ? pinDenial(item) : null
      if (refusal) return err('VALIDATION_FAILED', refusal)

      if ((item.pinned_at !== null) !== pinned) {
        await tx.query('update managed_items set pinned_at = $2 where id = $1', [itemId, pinned ? realAt : null])
        await this.#audit.append(tx, {
          actorKind: 'user',
          actorUserId: userId,
          role: 'admin',
          action,
          targetType: SUBJECT_TYPE,
          targetId: itemId,
          scope: 'cohort',
          cohortId: item.cohort_id,
          realAt,
          businessAt,
          payload: { placement: item.placement, title: item.title, pinnedBefore: item.pinned_at?.toISOString() ?? null },
        })
      }

      const receipt = { itemId, title: item.title, pinned, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId } })
      return { ok: true as const, receipt }
    })
  }

  // ── 規則章節排序（A-14；Q198） ────────────────────────────────────────────────

  /**
   * 規則章節上移／下移：跟同屆、placement rules、未刪除（含草稿、已下架）的項目中排在緊鄰的那一筆交換位置。
   * 排序跟前台 `/rules`、系辦「規則」篩選同一個：`rules_position asc nulls last, actual_opened_at asc, id asc`。
   *
   * 鎖序（見 `lockRuleSet`）：規則鎖（這一屆）→ 屆別（共享）→ 整屆規則列（含自己）。規則鎖下集合不會被別人改，先整屆重編成 1..n
   * （有 NULL、重複或缺號時才會真的改到列），再把自己跟完整序列裡的相鄰那一筆交換——所以一定只跨一章、回報的章次就是
   * 移完的實際位置。跟置頂一樣是展示動作：不動 `revision`、`updated_at`，不切版本、不發事件。
   */
  async moveRule(
    actor: ResolvedActor,
    itemId: string,
    direction: 'up' | 'down',
    requestId: string,
  ): Promise<Result<RuleOrderReceipt>> {
    const denied = authorizeAdmin(actor, '調整規則章節順序')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId)) return itemNotFound()
    if (direction !== 'up' && direction !== 'down') return err('VALIDATION_FAILED', '只能上移或下移。')
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const head = await headOf(tx, itemId)
      if (!head) return itemNotFound()
      const cohortId = head.cohort_id
      await lockRuleSet(tx, cohortId, itemId)
      const cohort = await tx.query<{ status: string }>('select status from cohorts where id = $1 for share', [cohortId])
      const found = await tx.query<{ id: string; title: string; placement: string }>(
        'select id, title, placement from managed_items where id = $1 and deleted_at is null for update',
        [itemId],
      )
      const item = found.rows[0]
      if (!item || !cohort.rows[0]) return itemNotFound()

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'item.rule_moved',
          requestId,
          fingerprint: sha256(canonicalJson({ itemId, direction })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<RuleOrderReceipt>(begun)
      if (archivedBlocks(cohort.rows[0].status, item.placement)) return cohortArchived()
      if (item.placement !== 'rules') return err('VALIDATION_FAILED', '只有專題規則能調整章節順序。')

      await renumberRules(tx, cohortId)
      const siblings = await tx.query<{ id: string }>(
        `select id from managed_items where cohort_id = $1 and placement = 'rules' and deleted_at is null order by rules_position`,
        [cohortId],
      )
      const order = siblings.rows.map((r) => r.id)
      const index = order.indexOf(itemId)
      const target = direction === 'up' ? index - 1 : index + 1
      if (target < 0) return err('VALIDATION_FAILED', '已經在最上面了。')
      if (target >= order.length) return err('VALIDATION_FAILED', '已經在最下面了。')

      // 重編後位置＝序列索引＋1：自己拿 target+1、鄰居拿 index+1。
      const neighborId = order[target]!
      await tx.query(
        `update managed_items m set rules_position = v.pos
           from (values ($1::uuid, $2::int), ($3::uuid, $4::int)) as v(id, pos) where m.id = v.id`,
        [itemId, target + 1, neighborId, index + 1],
      )
      const position = target + 1

      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'item.rule_moved',
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId,
        realAt,
        businessAt,
        payload: { title: item.title, direction, swappedWith: neighborId, positionBefore: index + 1, positionAfter: position },
      })
      const receipt = { itemId, title: item.title, position, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId } })
      return { ok: true as const, receipt }
    })
  }

  /**
   * 規則章節整批排序（C 階段規格① §3.1，拖曳後一次送整串）。鎖序同 `moveRule`（規則鎖 → 屆別共享 → 整屆規則列）：
   * 規則鎖下集合不會被別人換掉，所以「送來的編號＝這一屆全部未刪除規則」在鎖內比對一次就準。照順序寫 1..n，
   * 只更新位置有變的列。展示動作：不動 `revision`、`updated_at`，不切版本、不發事件；稽核沿用 `item.rule_moved`（payload 帶整串順序）。
   */
  async reorderRules(
    actor: ResolvedActor,
    cohortId: string,
    orderedIds: readonly string[],
    requestId: string,
  ): Promise<Result<RulesReorderReceipt>> {
    const denied = authorizeAdmin(actor, '調整規則章節順序')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(cohortId)) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
    if (!Array.isArray(orderedIds) || orderedIds.some((id) => !isUuid(id))) {
      return err('VALIDATION_FAILED', '章節順序的資料不對，請重新整理頁面。')
    }
    const ids = orderedIds.map((id) => id.toLowerCase())
    if (new Set(ids).size !== ids.length) return err('VALIDATION_FAILED', '章節順序裡有重複的章節，請重新整理頁面。')
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const exists = await tx.query('select 1 from cohorts where id = $1', [cohortId])
      if (exists.rowCount === 0) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
      await lockRuleSet(tx, cohortId, null)
      const cohort = await tx.query<{ status: string }>('select status from cohorts where id = $1 for share', [cohortId])

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          // 跟上下移同一個代碼（稽核對照表已登記「調整規則章節順序」）；請求編號不同，帳本不會混。
          operationKind: 'item.rule_moved',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId, orderedIds: ids })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<RulesReorderReceipt>(begun)
      if (archivedBlocks(cohort.rows[0]!.status, 'rules')) return cohortArchived()

      await renumberRules(tx, cohortId)
      const siblings = await tx.query<{ id: string }>(
        `select id from managed_items where cohort_id = $1 and placement = 'rules' and deleted_at is null order by rules_position`,
        [cohortId],
      )
      const before = siblings.rows.map((r) => r.id)
      if (before.length !== ids.length || !sameSet(before, ids)) {
        return err('VALIDATION_FAILED', '章節清單剛剛有變動（有人新增、刪除或移走了章節），請重新整理頁面再排一次。')
      }
      const receipt = { cohortId, count: ids.length, requestId, serverTime: realAt.toISOString() }
      if (!sameIds(before, ids)) {
        await tx.query(
          `update managed_items m set rules_position = v.pos
             from unnest($1::uuid[]) with ordinality as v(id, pos)
            where m.id = v.id and m.rules_position is distinct from v.pos`,
          [ids],
        )
        await this.#audit.append(tx, {
          actorKind: 'user',
          actorUserId: userId,
          role: 'admin',
          action: 'item.rule_moved',
          targetType: 'cohort',
          targetId: cohortId,
          scope: 'cohort',
          cohortId,
          realAt,
          businessAt,
          payload: { kind: 'reorder', before, after: ids },
        })
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { cohortId } })
      return { ok: true as const, receipt }
    })
  }

  /**
   * 資源分類改名（C 階段規格① §11.3 `resource_category`）：所有屆別、`placement='resource'`、未刪除、`category=from` 的列
   * 一次改成 `to`，`revision+1`（開著的編輯器存檔會拿到「剛剛有人改過」）。一筆交易：先用 advisory lock 讓改名彼此排隊，
   * 再依 id 鎖住要改的列，鎖內查新名有沒有撞到別的資源分類。不切內容版本、不寫發布紀錄、不發事件（比照置頂）。
   */
  async renameResourceCategory(
    actor: ResolvedActor,
    input: { readonly from: string; readonly to: string; readonly requestId: string },
  ): Promise<Result<RenameCategoryReceipt>> {
    const denied = authorizeAdmin(actor, '修改資源分類')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    const requestId = input?.requestId
    if (!isUuid(requestId)) return badRequestId()
    const from = cleanCategory(input.from)
    const to = cleanCategory(input.to)
    if (from === '') return err('VALIDATION_FAILED', '找不到這個分類，請重新整理頁面。')
    if (to === '') return err('VALIDATION_FAILED', '請填新的分類名稱。', { details: { field: 'to' } })
    if (to.length > CATEGORY_MAX_LENGTH) return err('VALIDATION_FAILED', `分類最多 ${CATEGORY_MAX_LENGTH} 字。`, { details: { field: 'to' } })
    if (to === from) return err('VALIDATION_FAILED', '新名稱跟原本的一樣。', { details: { field: 'to' } })
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('items.resource_category', 0))`)
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'item.category_renamed',
          requestId,
          fingerprint: sha256(canonicalJson({ from, to })),
          scope: 'global',
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<RenameCategoryReceipt>(begun)

      const clash = await tx.query(
        `select 1 from managed_items where placement = 'resource' and deleted_at is null and category = $1 limit 1`,
        [to],
      )
      if ((clash.rowCount ?? 0) > 0) return err('VALIDATION_FAILED', '已有這個分類，請換一個名稱。', { details: { field: 'to' } })
      const rows = await tx.query<{ id: string }>(
        `select id from managed_items where placement = 'resource' and deleted_at is null and category = $1 order by id for update`,
        [from],
      )
      if (rows.rows.length === 0) return err('VALIDATION_FAILED', '找不到這個分類（可能剛被改名或已經沒有資源），請重新整理頁面。')
      const ids = rows.rows.map((r) => r.id)
      await tx.query(
        `update managed_items set category = $2, revision = revision + 1, updated_at = $3, updated_by_user_id = $4
          where id = any($1::uuid[])`,
        [ids, to, realAt, userId],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'item.category_renamed',
        targetType: SUBJECT_TYPE,
        scope: 'global',
        realAt,
        businessAt,
        payload: { from, to, count: ids.length },
      })
      const receipt = { from, to, count: ids.length, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { from, to, itemIds: ids } })
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
      consentMode: item.consent_mode,
      consentPurpose: item.consent_purpose,
      opensAt: item.opens_at,
      dueAt: item.due_at,
      fields: item.draft_schema.fields ?? [],
    }
  }

  /** 交給同意書 hook 的作業內容：清理後的正文、目前附件（依畫面順序）、用途。 */
  async #consentItem(tx: PoolClient, item: ItemRow, groupIds: readonly string[], attachmentFileIds?: readonly string[]): Promise<ConsentItem> {
    const files =
      attachmentFileIds ??
      (await tx.query<{ file_id: string }>('select file_id from item_attachments where item_id = $1 order by sort, file_id', [item.id])).rows.map(
        (r) => r.file_id,
      )
    return {
      id: item.id,
      cohortId: item.cohort_id,
      groupIds,
      bodyHtml: item.body_html,
      attachmentFileIds: files,
      purpose: item.consent_purpose ?? 'result_confirmation',
      dueAt: item.due_at,
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

  /**
   * 鎖序：屆別（共享）→ 項目（排他）。回傳項目、屆別狀態、目前的指定組別與附件順序。
   * 已刪除的項目當作不存在（回 null＝「找不到」）；只有刪除自己用 `includeDeleted`，讓同一個 requestId 重送時
   * 先過帳本拿回原回執，之後才判已刪除。
   */
  async #lock(tx: PoolClient, itemId: string, options: { includeDeleted?: boolean } = {}): Promise<Locked | null> {
    const live = options.includeDeleted ? '' : ' and deleted_at is null'
    const head = await tx.query<{ cohort_id: string }>(`select cohort_id from managed_items where id = $1${live}`, [itemId])
    const cohortId = head.rows[0]?.cohort_id
    if (!cohortId) return null
    const cohort = await tx.query<{ status: string }>('select status from cohorts where id = $1 for share', [cohortId])
    const found = await tx.query<ItemRow & { deleted: boolean }>(
      `select id, cohort_id, placement, audience_kind, receiver_unit, stage_id, consent_mode, consent_purpose,
              status, opens_at, actual_opened_at, due_at, deadline_version, current_content_version_id, current_schema_version_id, title, summary, body_html,
              cover_file_id, category, to_char(registration_deadline, 'YYYY-MM-DD') as registration_deadline,
              to_char(event_date, 'YYYY-MM-DD') as event_date, to_char(awarded_on, 'YYYY-MM-DD') as awarded_on,
              pinned_at, draft_schema, revision, deleted_at is not null as deleted
         from managed_items where id = $1${live} for update`,
      [itemId],
    )
    const row = found.rows[0]
    if (!row || !cohort.rows[0]) return null
    const { deleted, ...item } = row
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
      deleted,
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

  async #writeHead(
    tx: PoolClient,
    itemId: string,
    draft: Omit<ItemDraft, 'placement'> & { placement: Placement },
    userId: string,
    realAt: Date,
    deadlineVersion?: number,
  ) {
    await tx.query(
      `update managed_items
          set placement = $2, audience_kind = $3, receiver_unit = $4, stage_id = $5, opens_at = $6, due_at = $7,
              title = $8, summary = $9, body_html = $10, cover_file_id = $11, category = $12, draft_schema = $13::jsonb,
              deadline_version = coalesce($14, deadline_version),
              registration_deadline = $17, event_date = $18, awarded_on = $19,
              consent_mode = $20, consent_purpose = $21,
              rules_position = case when $2 = 'rules' then rules_position end,
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
        draft.awardedOn,
        draft.consentMode,
        draft.consentPurpose,
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
    // 檔案列依 id 鎖（鎖序第 4 步，見 `lockRuleSet`）：兩筆同時附上同一組檔案、畫面順序相反也不會互等。
    for (const fileId of after.filter((id) => !before.includes(id)).sort()) {
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
  ): Promise<{ added: RosterKey[]; removed: RosterKey[] }> {
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
    return { added, removed }
  }

  async #userIdsOf(tx: PoolClient, keys: readonly RosterKey[]): Promise<string[]> {
    const users = keys.filter((k) => k.kind === 'user').map((k) => k.id)
    const groups = keys.filter((k) => k.kind === 'group').map((k) => k.id)
    return [...new Set([...users, ...(await memberUserIds(tx, groups))])].sort()
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'items', body, (constraint) =>
      constraint === 'response_rosters_one_current'
        ? err('CONFLICT', '繳交名單剛剛被同時修改，請重新整理頁面再試一次。')
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
  consent_mode: ConsentMode | null
  due_at: Date | null
  actual_opened_at: Date | null
  pinned_at: Date | null
  rules_position: number | null
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
      `select m.id, m.placement, m.title, m.status, m.audience_kind, m.receiver_unit, m.consent_mode, m.due_at, m.actual_opened_at,
              m.pinned_at, m.rules_position, m.updated_at,
              (select array_agg(g.code order by g.code) from item_audience_groups a join groups g on g.id = a.group_id
                where a.item_id = m.id) as group_codes,
              (select count(*) from response_rosters r where r.item_id = m.id and r.eligible_to_business_at is null and not r.exempt)
                as roster_count
         from managed_items m
        where m.cohort_id = $1 and m.deleted_at is null
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
      consentMode: r.consent_mode,
      dueAt: r.due_at,
      actualOpenedAt: r.actual_opened_at,
      pinnedAt: r.pinned_at,
      rulesPosition: r.rules_position,
      updatedAt: r.updated_at,
      rosterCount: Number(r.roster_count),
    }))
  }

  async get(itemId: string): Promise<ItemDetail | null> {
    if (!isUuid(itemId)) return null
    const db = this.#reader()
    const found = await db.query<
      Omit<ItemRow, 'registration_deadline' | 'event_date' | 'awarded_on'> & {
        updated_at: Date
        content_no: number | null
        schema_no: number | null
        roster_count: string
        registration_deadline_day: string | null
        event_date_day: string | null
        awarded_on_day: string | null
      }
    >(
      `select m.*, cv.version_no as content_no, sv.version_no as schema_no,
              to_char(m.registration_deadline, 'YYYY-MM-DD') as registration_deadline_day,
              to_char(m.event_date, 'YYYY-MM-DD') as event_date_day,
              to_char(m.awarded_on, 'YYYY-MM-DD') as awarded_on_day,
              (select count(*) from response_rosters r where r.item_id = m.id and r.eligible_to_business_at is null and not r.exempt)
                as roster_count
         from managed_items m
         left join item_versions cv on cv.id = m.current_content_version_id
         left join form_schema_versions sv on sv.id = m.current_schema_version_id
        where m.id = $1 and m.deleted_at is null`,
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
      db.query<{
        action: string
        notify: boolean
        actor_user_id: string
        actor_name: string
        avatar_preset: number | null
        avatar_file_id: string | null
        real_at: Date
      }>(
        // 操作者頭像（C 階段③§2.3、總表 Y-4）：同一句多選兩欄，查詢數不變。
        `select p.action, p.notify, p.actor_user_id, coalesce(pp.display_name, u.name) as actor_name, ${personAvatar('pp')}, p.real_at
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
      consentMode: item.consent_mode,
      consentPurpose: item.consent_purpose,
      opensAt: item.opens_at,
      actualOpenedAt: item.actual_opened_at,
      dueAt: item.due_at,
      registrationDeadline: item.registration_deadline_day,
      eventDate: item.event_date_day,
      awardedOn: item.awarded_on_day,
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
        actorUserId: p.actor_user_id,
        actorName: p.actor_name,
        actorAvatarPreset: p.avatar_preset,
        actorAvatarFileId: p.avatar_file_id,
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
