import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import type { FileRules, FormField } from '@/application/items'
import type { EventPublisher } from '@/application/notifications'
import {
  canonicalJson,
  FILE_TYPES,
  formatBytes,
  typeForExtension,
  type AuditWriter,
  type DeclaredUpload,
  type FileStorage,
  type OperationLedger,
  type SubmissionLateFlags,
  type UploadTicket,
} from '@/application/ops'
import {
  advisorMayReadIndividual,
  canReadSubmission,
  describeIssues,
  fileAnswers,
  formTypeOf,
  itemKindOf,
  mayFillAsReceiver,
  MIB,
  normalizeAnswers,
  normalizeOptionalReason,
  phaseOf,
  submitIssues,
  type AnswerFile,
  type Answers,
  type DraftReceipt,
  type ExemptInput,
  type ExemptReceipt,
  type GroupSummary,
  type MyItemDetail,
  type MyItemRow,
  type MyRecordDetail,
  type MyRecordRow,
  type MyVersionDetail,
  type ReopenEntry,
  type ReopenInput,
  type ReopenReceipt,
  type SubmissionCommand,
  type SubmissionQuery,
  type SubmitReceipt,
  type VersionSummary,
  type VisibilityReceipt,
} from '@/application/submissions'
import { authorizeAdmin, badRequestId, inTransaction, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { PgResponsePresence } from '@/infrastructure/submissions/pg-response-presence'
import { holderOf, VERSION_ACCESS_COLUMNS, viewerForUser, type VersionAccessRow } from '@/infrastructure/submissions/version-access'
import { err, ok, type Err, type Result } from '@/shared/result'
import { formatTaipeiMinute, parseTaipeiDateTime, RealClock, type Clock } from '@/shared/time'

/**
 * 收件的存草稿、上傳與正式送出（票 17 個人收件；票 21 組別共用草稿、上傳、代表全組送出；
 * 模組實作設計 05 §2、§3、§6；產品模組 05 §4「個人填報與收件名單」「4.6 組別共用填寫與繳交」）。
 *
 * 收件者由伺服器推：個人一份＝本人；整組一份＝本人**此刻**在這一屆的有效組別（畫面不能指定收件者，
 * 所以猜別組的項目或草稿也只會落在自己的組上）。同組任何一位存的都是同一份草稿（`receiver_kind='group'`）。
 *
 * 每個寫入都是同一個形狀（契約 01 §8，照 pg-items）：業務時間在開交易**之前**讀一次（＝後端收到請求的時間）→
 * 開交易 → 鎖（契約 01 §6 鎖序：`cohorts FOR SHARE` → `groups FOR SHARE` → `managed_items FOR SHARE`
 * → `submission_drafts FOR UPDATE` → `stored_files FOR UPDATE`）→ 帳本 `begin` → 守門 → 寫入 → 稽核／事件 → 帳本 `commit` → COMMIT。
 * 回 `Err` 或丟例外整筆回滾（連同附件引用、通知事件）。
 *
 * 組別列拿 `FOR SHARE`：管理員加入、移出組員拿的是 `FOR UPDATE`，兩邊排隊，所以「送出當下的有效組員」
 * （`membership_snapshot`）不會跟正在進行的成員異動交錯。
 *
 * 守門順序（模組實作設計 05 §2，先命中者回傳）：
 * 授權（`NOT_MEMBER`、`NOT_IN_ROSTER`、`EXEMPTED`）→ 屆別與組別（`COHORT_ARCHIVED`、`GROUP_DISSOLVED`）
 * → 時間（`ITEM_NOT_OPEN`、`DEADLINE_PASSED`）→ 欄位版本（`DRAFT_NEEDS_REVIEW`）→ 版本競爭（`CONFLICT`）
 * → 欄位驗證（`VALIDATION_FAILED`）→ 檔案（`FILE_*`）。
 * 送出時把版本競爭放在欄位驗證**之前**：驗的是資料庫裡那一份草稿，版本對不上就先要求重新載入，
 * 免得拿另一個分頁（或另一位組員）的內容缺什麼來提示畫面上看不到的欄位。
 */

const SUBJECT_TYPE = 'item'

type ItemRow = {
  id: string
  cohort_id: string
  title: string
  status: string
  receiver_unit: string
  opens_at: Date | null
  due_at: Date | null
  deadline_version: number
  current_schema_version_id: string | null
  /** 同意書模式：`form`＝站內同意表單（同意在簽核包裡投，不走一般草稿與送出）；`upload` 與一般作業是 null 以外照舊。 */
  consent_mode: string | null
}

type Receiver = { kind: 'user' | 'group'; id: string; groupCode: string | null; groupStatus: string | null }

type DraftRow = {
  id: string
  revision: number
  schema_version_id: string
  migration_state: string
  answers: Answers
  file_ids: string[]
}

type Locked = {
  item: ItemRow
  cohortStatus: string
  /** 整組一份但本人此刻沒有有效組別時是 null。 */
  receiver: Receiver | null
  roster: { exempt: boolean } | null
  schema: { id: string; versionNo: number; fields: FormField[] } | null
  /** 系辦替這位收件者開的個別補交期限（W10，最晚的那一個）；沒有是 null。 */
  reopenUntil: Date | null
}

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  businessClock: BusinessClockSource
  files: FileStorage<PoolClient>
  events: EventPublisher<PoolClient>
  pool?: PoolSource
  realClock?: Clock
}

function notInRoster(): Err {
  return err('NOT_IN_ROSTER', '你不在這個作業的名單上，請回「我的繳交」重新整理。')
}

function notMember(): Err {
  return err('NOT_MEMBER', '這個作業是整組一份：要先成立組別（而且你此刻是組員）才能填寫與送出。請到「我的組別」確認。')
}

function staleDraft(group: boolean): Err {
  return err(
    'CONFLICT',
    group
      ? '這份共用草稿剛剛被組員存過了。請重新載入看最新的內容；畫面上的輸入不會自動蓋過去。'
      : '這份草稿剛剛在別的分頁或裝置上存過了。請重新載入看最新的內容；畫面上的輸入不會自動蓋過去。',
  )
}

const RECEIVER_ONLY = '只有學生或在這份作業名單上的老師可以填寫。'

/**
 * 第一道：帳號狀態，而且是學生或老師（C 階段規格① §3.2 `authorizeReceiver`）。老師還要在這份作業的名單上，
 * 那一條在鎖到名單列之後判（`#receiverDenied`），不在名單上的老師回 `FORBIDDEN`。
 */
function authorizeReceiver(actor: ResolvedActor): Err | null {
  const blocked = statusGate(actor, 'business')
  if (blocked) return err(blocked, '請先登入並完成帳號設定。')
  if (actor.kind !== 'authenticated' || !(actor.roles.includes('student') || actor.roles.includes('teacher'))) {
    return err('FORBIDDEN', RECEIVER_ONLY)
  }
  return null
}

/** 填寫的人是學生還是名單上的老師（稽核的 `role`）。 */
function receiverRole(actor: Extract<ResolvedActor, { kind: 'authenticated' }>): 'student' | 'teacher' {
  return actor.roles.includes('student') ? 'student' : 'teacher'
}

/**
 * 第二道（鎖到名單列之後）：老師只有本人在這份作業目前的名單上（個人一份）才能填；學生照舊交給 `#guard`。
 * 規則在 application 的 `mayFillAsReceiver`。
 */
function receiverDenied(actor: Extract<ResolvedActor, { kind: 'authenticated' }>, locked: Locked): Err | null {
  const allowed = mayFillAsReceiver({
    isStudent: actor.roles.includes('student'),
    isTeacher: actor.roles.includes('teacher'),
    onRosterAsUser: locked.receiver?.kind === 'user' && locked.roster !== null,
  })
  return allowed ? null : err('FORBIDDEN', RECEIVER_ONLY)
}

const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/

function allowedExtensions(rules: FileRules): string {
  return rules.allowedTypes
    .flatMap((t) => FILE_TYPES[t].extensions)
    .map((e) => `.${e}`)
    .join('、')
}

export class PgSubmissionCommand implements SubmissionCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #files: FileStorage<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#businessClock = deps.businessClock
    this.#files = deps.files
    this.#events = deps.events
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  async saveDraft(
    actor: ResolvedActor,
    itemId: string,
    revision: number,
    answers: unknown,
    requestId: string,
  ): Promise<Result<DraftReceipt>> {
    const denied = authorizeReceiver(actor)
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId)) return notInRoster()
    if (!Number.isInteger(revision) || revision < 0) return staleDraft(false)
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lock(tx, itemId, userId)
      if (!locked) return notInRoster()
      const notReceiver = receiverDenied(actor, locked)
      if (notReceiver) return notReceiver

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'submission.save_draft',
          requestId,
          fingerprint: sha256(canonicalJson({ itemId, revision, answers: answers ?? null })),
          scope: 'cohort',
          cohortId: locked.item.cohort_id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<DraftReceipt>(begun)

      const guard = this.#guard(locked, businessAt)
      if (guard) return guard
      const schema = locked.schema!
      const receiver = locked.receiver!
      const group = receiver.kind === 'group'

      const draft = await this.#lockDraft(tx, itemId, receiver)
      if ((draft?.revision ?? 0) !== revision) return staleDraft(group)
      const normalized = normalizeAnswers(schema.fields, answers)
      if (!normalized.ok) {
        return err('VALIDATION_FAILED', normalized.issue.message, { details: { field: normalized.issue.key } })
      }
      const wanted = fileAnswers(schema.fields, normalized.value)
      if (new Set(wanted.map((f) => f.fileId)).size !== wanted.length) {
        return err('VALIDATION_FAILED', '同一個檔案不能放在兩個欄位，請重新上傳。', { details: { field: wanted.at(-1)!.fieldKey } })
      }

      const draftId = draft?.id ?? uuidv7()
      const fileIds = wanted.map((f) => f.fileId)
      let nextRevision: number
      if (!draft) {
        nextRevision = 1
        await tx.query(
          `insert into submission_drafts
             (id, item_id, receiver_kind, receiver_id, schema_version_id, answers, file_ids,
              created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7::uuid[], $8, 'user', $9, $8, $9)`,
          [draftId, itemId, receiver.kind, receiver.id, schema.id, JSON.stringify(normalized.value), fileIds, realAt, userId],
        )
      } else {
        nextRevision = draft.revision + 1
        await tx.query(
          `update submission_drafts
              set answers = $2::jsonb, schema_version_id = $3, file_ids = $4::uuid[], revision = revision + 1,
                  updated_at = $5, updated_by_user_id = $6
            where id = $1`,
          [draft.id, JSON.stringify(normalized.value), schema.id, fileIds, realAt, userId],
        )
      }

      // 附件：新附上的要是**此刻有效組員**（個人收件：本人）上傳、用途是繳交、已經存好的檔；
      // 拿掉的釋放引用（之後可以再附回來，契約 01 §11）。鎖序：草稿列之後才鎖檔案列。
      const ref = { refType: 'draft' as const, refId: draftId }
      const existing = new Set(draft?.file_ids ?? [])
      const owners = group ? await this.#memberIds(tx, receiver.id) : [userId]
      for (const fileId of [...fileIds].filter((id) => !existing.has(id)).sort()) {
        const attached = await this.#files.attach(tx, fileId, ref, { purpose: 'submission', ownerUserId: owners })
        if (!attached.ok) {
          const field = wanted.find((f) => f.fileId === fileId)!.fieldKey
          return { ...attached, details: { ...attached.details, field } }
        }
      }
      const fileProblem = await this.#checkFileRules(tx, locked, wanted)
      if (fileProblem) return fileProblem
      for (const fileId of [...existing].filter((id) => !fileIds.includes(id)).sort()) {
        await this.#files.release(tx, fileId, ref)
      }

      const receipt = { itemId, revision: nextRevision, savedAt: realAt.toISOString(), requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId, revision: nextRevision, draftId } })
      return { ok: true as const, receipt }
    })
  }

  async submit(actor: ResolvedActor, itemId: string, draftRevision: number, requestId: string): Promise<Result<SubmitReceipt>> {
    const denied = authorizeReceiver(actor)
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId)) return notInRoster()
    if (!Number.isInteger(draftRevision) || draftRevision < 1) {
      return err('VALIDATION_FAILED', '請先填寫並儲存草稿再正式送出。')
    }
    const userId = actor.userId
    // 準時與否看後端收到完整請求的時間（產品模組 05 §4.6）：在開交易、排隊等鎖之前讀一次。
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lock(tx, itemId, userId)
      if (!locked) return notInRoster()
      const notReceiver = receiverDenied(actor, locked)
      if (notReceiver) return notReceiver
      const { item } = locked
      // 屆別封存在重播之前擋（AC-56c）：封存前成功過的同一個 requestId，封存後重播也回 COHORT_ARCHIVED，不回原回執。
      // 走整套守門，名單、免繳這些排在封存前面的拒絕碼順序不變。
      if (locked.cohortStatus === 'archived') {
        const archived = this.#guard(locked, businessAt)
        if (archived) return archived
      }

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'submission.submit',
          requestId,
          fingerprint: sha256(canonicalJson({ itemId, draftRevision })),
          scope: 'cohort',
          cohortId: item.cohort_id,
        },
        realAt,
      )
      // 同一次送出連點或斷線重試：回第一次的回執，不再多一個版本（產品模組 05 SUB-15）。
      if (begun.outcome !== 'fresh') return replayed<SubmitReceipt>(begun)

      const guard = this.#guard(locked, businessAt)
      if (guard) return guard
      const schema = locked.schema!
      const receiver = locked.receiver!
      const group = receiver.kind === 'group'
      // 補交（W10）：守門放行了、但不看補交期限時已截止＝靠補交送進來的。在送出當下判定並記進這一版的稽核，
      // 之後系辦再改全體截止也不會讓標記變來變去（模組 10 的 `SubmissionLateFlags` port 讀這裡）。
      const late = phaseOf({ opensAt: item.opens_at, dueAt: item.due_at }, businessAt) === 'closed'

      const draft = await this.#lockDraft(tx, itemId, receiver)
      if (!draft) return staleDraft(group)
      if (draft.schema_version_id !== schema.id || draft.migration_state === 'needs_review') {
        return err('DRAFT_NEEDS_REVIEW', '繳交欄位已經改版，請重新載入確認內容後再送出。')
      }
      if (draft.revision !== draftRevision) return staleDraft(group)
      const issues = submitIssues(schema.fields, draft.answers)
      if (issues.length > 0) {
        return err('VALIDATION_FAILED', describeIssues(issues), {
          details: { field: issues[0]!.key, fields: issues.map((i) => i.key) },
        })
      }

      // 組別：送出當下的有效組員與主指導（票 19 留下的 `advisor_snapshot`，這裡填上）。
      const members = group ? await this.#members(tx, receiver.id) : []
      const advisor = group
        ? await tx.query<{ id: string; teacher_user_id: string }>(
            'select id, teacher_user_id from advisor_assignments where group_id = $1 and valid_to is null',
            [receiver.id],
          )
        : null
      const membershipSnapshot = group ? members.map((m) => m.user_id) : null
      const advisorSnapshot = group
        ? { assignmentId: advisor!.rows[0]?.id ?? null, teacherUserId: advisor!.rows[0]?.teacher_user_id ?? null }
        : null

      // 版本號在草稿列鎖內分配（模組實作設計 05 §2）；唯一鍵再擋一次。
      const versionId = uuidv7()
      const inserted = await tx.query<{ version_no: number }>(
        `insert into submission_versions
           (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
            received_real_at, received_business_at, request_id, membership_snapshot, advisor_snapshot, deadline_version_at_submit)
         select $1, $2, $3, $4, coalesce(max(version_no), 0) + 1, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13
           from submission_versions where item_id = $2 and receiver_kind = $3 and receiver_id = $4
         returning version_no`,
        [
          versionId,
          itemId,
          receiver.kind,
          receiver.id,
          schema.id,
          JSON.stringify(draft.answers),
          userId,
          realAt,
          businessAt,
          requestId,
          membershipSnapshot ? JSON.stringify(membershipSnapshot) : null,
          advisorSnapshot ? JSON.stringify(advisorSnapshot) : null,
          item.deadline_version,
        ],
      )
      const versionNo = inserted.rows[0]!.version_no

      // 附件：草稿上附著的檔再綁到這個正式版本（證明是「草稿正引用著」，所以上傳者後來被移出也送得出去），
      // checksum 抄進 `submission_files`——之後重送換檔，這一版的內容與 hash 都不動。
      const attachedFiles: { fieldKey: string; fileId: string; checksum: string }[] = []
      const answerFiles = fileAnswers(schema.fields, draft.answers)
      for (const f of [...answerFiles].sort((a, b) => a.fileId.localeCompare(b.fileId))) {
        const attached = await this.#files.attach(
          tx,
          f.fileId,
          { refType: 'submission_version', refId: versionId },
          { purpose: 'submission', heldBy: { refType: 'draft', refId: draft.id } },
        )
        if (!attached.ok) {
          const label = schema.fields.find((x) => x.key === f.fieldKey)?.label ?? f.fieldKey
          return err(attached.code, `「${label}」的檔案已經不在草稿上，請重新載入再上傳。`, { details: { field: f.fieldKey } })
        }
        await tx.query('insert into submission_files (submission_version_id, file_id, field_key, checksum) values ($1, $2, $3, $4)', [
          versionId,
          f.fileId,
          f.fieldKey,
          attached.receipt.checksum,
        ])
        attachedFiles.push({ ...f, checksum: attached.receipt.checksum })
      }
      const names =
        answerFiles.length > 0
          ? await tx.query<{ id: string; original_name: string }>('select id, original_name from stored_files where id = any($1::uuid[])', [
              answerFiles.map((f) => f.fileId),
            ])
          : null
      const files = answerFiles.map((f) => ({
        fieldKey: f.fieldKey,
        name: names?.rows.find((r) => r.id === f.fileId)?.original_name ?? '',
        checksum: attachedFiles.find((a) => a.fileId === f.fileId)?.checksum ?? '',
      }))

      const who = await tx.query<{ name: string }>(
        `select coalesce(p.display_name, u.name) as name from users u left join user_profiles p on p.user_id = u.id where u.id = $1`,
        [userId],
      )
      const submittedByName = who.rows[0]?.name ?? ''

      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: receiverRole(actor),
        action: 'submission.submit',
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId: item.cohort_id,
        realAt,
        businessAt,
        // 不放回答內容與檔名（契約 01 §4.3：稽核不含私有正文）；檔案只留 ID 與 checksum。
        payload: {
          receiverKind: receiver.kind,
          receiverId: receiver.id,
          versionNo,
          schemaVersionNo: schema.versionNo,
          draftRevision,
          submissionVersionId: versionId,
          files: attachedFiles.map((f) => ({ fileId: f.fileId, fieldKey: f.fieldKey, checksum: f.checksum })),
          ...(late ? { late: true, reopenUntil: locked.reopenUntil?.toISOString() ?? null } : {}),
        },
      })

      // 其他有效組員收一則「已正式送出」（產品模組 05 §4.6；送出者本人拿的是回執；老師不收）。同一個交易。
      if (group) {
        const recipients = members.filter((m) => m.active && m.user_id !== userId).map((m) => m.user_id)
        if (recipients.length > 0) {
          await this.#events.publish(tx, {
            type: 'submission.submitted',
            scope: 'cohort',
            cohortId: item.cohort_id,
            source: { type: 'item', id: itemId, version: versionNo },
            actor: { kind: 'user', userId },
            recipients,
            recipientBasis: { groupId: receiver.id, basis: 'membership_snapshot', submissionVersionId: versionId },
            payload: {
              title: `${submittedByName} 代表 ${receiver.groupCode ?? ''} 組正式送出了「${item.title}」（第 ${versionNo} 次）`,
              itemId,
              groupId: receiver.id,
              code: receiver.groupCode,
              versionNo,
            },
            occurredRealAt: realAt,
            occurredBusinessAt: businessAt,
          })
        }
      }

      const receipt = {
        itemId,
        title: item.title,
        versionNo,
        receivedBusinessAt: businessAt.toISOString(),
        receivedRealAt: realAt.toISOString(),
        submittedByName,
        schemaVersionNo: schema.versionNo,
        draftRevision,
        groupCode: group ? receiver.groupCode : null,
        files,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId, submissionVersionId: versionId, versionNo } })
      return { ok: true as const, receipt }
    })
  }

  async requestUpload(actor: ResolvedActor, itemId: string, fieldKey: string, declared: DeclaredUpload): Promise<Result<UploadTicket>> {
    const denied = authorizeReceiver(actor)
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(itemId)) return notInRoster()
    if (typeof fieldKey !== 'string' || !FIELD_KEY.test(fieldKey)) return err('VALIDATION_FAILED', '找不到這個上傳欄位，請重新整理頁面。')
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    // 只讀：確認這個人現在能填這份收件、欄位真的是檔案欄位。檔案列由共用檔案能力自己建（不在業務交易裡，模組 10 §6）。
    const checked = await this.#run<{ cohortId: string; rules: FileRules }>(async (tx) => {
      const locked = await this.#lock(tx, itemId, userId)
      if (!locked) return notInRoster()
      const notReceiver = receiverDenied(actor, locked)
      if (notReceiver) return notReceiver
      const guard = this.#guard(locked, businessAt)
      if (guard) return guard
      const field = locked.schema!.fields.find((f) => f.key === fieldKey && f.type === 'file')
      if (!field) return err('VALIDATION_FAILED', '找不到這個上傳欄位，請重新整理頁面。')
      const rules = field.fileRules ?? { allowedTypes: ['pdf'], maxMiB: 20 }
      const now = this.#realClock.now().toISOString()
      return ok({ cohortId: locked.item.cohort_id, rules }, { requestId: uuidv7(), serverTime: now })
    })
    if (!checked.ok) return checked
    const { cohortId, rules } = checked.receipt
    return this.#files.issueUploadTicket(userId, declared, {
      purpose: 'submission',
      allowedTypes: rules.allowedTypes,
      maxBytes: rules.maxMiB * MIB,
      scope: { kind: 'cohort', cohortId },
    })
  }

  async setAdvisorVisibility(actor: ResolvedActor, itemId: string, enabled: boolean, requestId: string): Promise<Result<VisibilityReceipt>> {
    const denied = authorizeAdmin(actor, '設定指導老師閱覽')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId) || typeof enabled !== 'boolean') return err('VALIDATION_FAILED', '找不到這個作業，請重新整理頁面。')
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      // 鎖序：屆別（共享）→ 項目（獨占）。學生存草稿與送出拿項目的共享鎖，所以「看有沒有人作答」到「插設定」之間
      // 不會有人剛好交進來（否則那個人沒看到告知，回答卻開給老師）。
      const head = await tx.query<{ cohort_id: string }>('select cohort_id from managed_items where id = $1 and deleted_at is null', [itemId])
      const cohortId = head.rows[0]?.cohort_id
      if (!cohortId) return err('VALIDATION_FAILED', '找不到這個作業，請重新整理頁面。')
      const cohort = await tx.query<{ status: string }>('select status from cohorts where id = $1 for share', [cohortId])
      const found = await tx.query<{ receiver_unit: string; schema_version_no: number | null }>(
        `select m.receiver_unit, sv.version_no as schema_version_no
           from managed_items m left join form_schema_versions sv on sv.id = m.current_schema_version_id
          where m.id = $1 and m.deleted_at is null for update of m`,
        [itemId],
      )
      const item = found.rows[0]
      if (!item) return err('VALIDATION_FAILED', '找不到這個作業，請重新整理頁面。')

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'submission.set_advisor_visibility',
          requestId,
          fingerprint: sha256(canonicalJson({ itemId, enabled })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<VisibilityReceipt>(begun)

      if (item.receiver_unit !== 'individual') {
        return err('VALIDATION_FAILED', '指導老師閱覽只用在「個人一份」的作業；整組一份的正式版本本來就給目前的指導老師看。')
      }
      if (cohort.rows[0]?.status === 'archived') return err('COHORT_ARCHIVED', '這一屆已經封存，不能再改設定。')
      const latest = await tx.query<{ enabled: boolean; effective_from_version_no: number }>(
        `select enabled, effective_from_version_no from advisor_visibility_settings
          where item_id = $1 order by set_at desc, id desc limit 1`,
        [itemId],
      )
      const current = latest.rows[0] ?? null
      if ((current?.enabled ?? false) === enabled) {
        return err('VALIDATION_FAILED', enabled ? '這個作業已經開放指導老師閱覽了。' : '這個作業目前沒有開放指導老師閱覽。')
      }
      if (enabled && (await new PgResponsePresence().hasAnyResponse(tx, itemId))) {
        return err(
          'ITEM_HAS_RESPONSES',
          '已經有人作答，不能直接開放指導老師閱覽：那些同學填寫時沒看到「指導老師可查看」的告知，舊回答不能因此給老師看。' +
            '需要老師看的話，請另建一個作業並在發布前開好（改表單版本的功能在後續版本）。',
        )
      }
      // 生效版本＝目前的欄位版本（還沒發布過就是第 1 版）；關閉時沿用上一列的生效版本，只把開關關掉。
      const effectiveFromVersionNo = enabled ? (item.schema_version_no ?? 1) : (current?.effective_from_version_no ?? 1)
      await tx.query(
        `insert into advisor_visibility_settings (id, item_id, enabled, effective_from_version_no, set_by_user_id, set_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [uuidv7(), itemId, enabled, effectiveFromVersionNo, userId, realAt],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: enabled ? 'submission.advisor_visibility.enable' : 'submission.advisor_visibility.disable',
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId,
        realAt,
        businessAt,
        payload: { enabled, effectiveFromVersionNo, previous: current ? { enabled: current.enabled, effectiveFromVersionNo: current.effective_from_version_no } : null },
      })
      const receipt = { itemId, enabled, effectiveFromVersionNo, setAt: realAt.toISOString(), requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId, enabled, effectiveFromVersionNo } })
      return { ok: true as const, receipt }
    })
  }

  async reopen(actor: ResolvedActor, itemId: string, receiverId: string, input: ReopenInput, requestId: string): Promise<Result<ReopenReceipt>> {
    const denied = authorizeAdmin(actor, '開放補交')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId) || !isUuid(receiverId)) return notInRoster()
    // 理由選填（C 階段 X2）：沒填存 null；有填最多 200 字（學生會看到）。
    const reasoned = normalizeOptionalReason(input?.reason, 200)
    if (!reasoned.ok) return err('VALIDATION_FAILED', '補交理由最多 200 字，學生會看到。', { details: { field: 'reason' } })
    const reason = reasoned.reason
    const dueAt = typeof input?.dueAt === 'string' ? parseTaipeiDateTime(input.dueAt) : null
    if (!dueAt) return err('VALIDATION_FAILED', '請選補交期限（日期與時間，臺灣時間）。', { details: { field: 'dueAt' } })
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      // 鎖序跟學生送出一樣：屆別（共享）→ 組別（共享，整組一份才有）→ 項目（共享）。
      // 學生送出也拿這幾把共享鎖，所以補交列一 commit，下一次送出就看得到。
      const head = await tx.query<{ cohort_id: string; receiver_unit: string }>(
        'select cohort_id, receiver_unit from managed_items where id = $1 and deleted_at is null',
        [itemId],
      )
      const cohortId = head.rows[0]?.cohort_id
      if (!cohortId) return err('VALIDATION_FAILED', '找不到這個作業，請重新整理頁面。')
      const group = head.rows[0]!.receiver_unit === 'group'
      const cohort = await tx.query<{ status: string }>('select status from cohorts where id = $1 for share', [cohortId])
      const groupRow = group
        ? (await tx.query<{ code: string; status: string }>('select code, status from groups where id = $1 for share', [receiverId])).rows[0]
        : undefined
      const found = await tx.query<ItemRow>(
        `select id, cohort_id, title, status, receiver_unit, opens_at, due_at, deadline_version, current_schema_version_id, consent_mode
           from managed_items where id = $1 and deleted_at is null for share`,
        [itemId],
      )
      const item = found.rows[0]
      if (!item) return err('VALIDATION_FAILED', '找不到這個作業，請重新整理頁面。')
      const kind: 'user' | 'group' = group ? 'group' : 'user'

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          operationKind: 'submission.reopen',
          requestId,
          fingerprint: sha256(canonicalJson({ itemId, receiverId, dueAt: dueAt.toISOString(), reason })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      // 同一個請求重送（回應遺失後重試）：直接回第一次的結果，不再拿「現在」重驗期限（架構 §4.9 冪等）。
      if (begun.outcome !== 'fresh') return replayed<ReopenReceipt>(begun)

      // 跟時間有關的檢查一律在帳本判定是新請求之後才做。
      if (dueAt.getTime() <= businessAt.getTime()) {
        return err('VALIDATION_FAILED', `補交期限要晚於現在（${formatTaipeiMinute(businessAt)}，臺灣時間）。`, { details: { field: 'dueAt' } })
      }
      if (item.receiver_unit !== 'individual' && item.receiver_unit !== 'group') {
        return err('VALIDATION_FAILED', '這個項目不用繳交，不需要補交。')
      }
      if (cohort.rows[0]?.status === 'archived') return err('COHORT_ARCHIVED', '這一屆已經封存，不能再開放補交。')
      if (item.status !== 'published') return err('ITEM_NOT_OPEN', '這個作業目前沒有發布，不能開放補交。')
      if (phaseOf({ opensAt: item.opens_at, dueAt: item.due_at }, businessAt) !== 'closed') {
        return err('VALIDATION_FAILED', '這個作業還沒截止，學生現在就能交，不需要補交；要讓所有人晚點交，請改它的截止時間。')
      }
      const roster = await tx.query<{ exempt: boolean }>(
        `select exempt from response_rosters
          where item_id = $1 and receiver_kind = $2 and receiver_id = $3 and eligible_to_business_at is null`,
        [itemId, kind, receiverId],
      )
      if (!roster.rows[0]) return err('NOT_IN_ROSTER', group ? '這一組不在這個作業的名單上。' : '這位學生不在這個作業的名單上。')
      if (roster.rows[0].exempt) {
        return err('EXEMPTED', group ? '這一組已設為免繳，不需要補交。' : '這位學生已設為免繳，不需要補交。')
      }
      if (group && groupRow?.status !== 'active') return err('GROUP_DISSOLVED', '這個組別已經解散，不能開放補交。')

      // 有效期限＝這位收件者所有補交列裡最晚的那一個（只插不改）。所以新期限一定要比已開放的晚：
      // 提早的話新列不會生效，通知與回執卻寫著較早的時間，三者就對不上。同一位的兩次開放用交易鎖排隊，
      // 「讀最晚期限 → 插新列」之間不會插進另一筆。
      // 鎖的 key 先把兩個編號轉成正規的 uuid 文字：同一個 UUID 大小寫不同（`isUuid` 兩種都放行、資料庫比對也相等）
      // 才會拿到同一把鎖，不然並發時兩邊各拿各的鎖、都讀到「還沒開放」，較早的期限會在較晚的之後成功並通知。
      await tx.query(
        `select pg_advisory_xact_lock(hashtextextended('submission_reopen:' || $1::uuid::text || ':' || $2::uuid::text, 0))`,
        [itemId, receiverId],
      )
      const current = await tx.query<{ due_at: Date | null }>(
        'select max(due_at) as due_at from submission_reopens where item_id = $1 and receiver_kind = $2 and receiver_id = $3',
        [itemId, kind, receiverId],
      )
      const currentDue = current.rows[0]?.due_at ?? null
      if (currentDue && dueAt.getTime() <= currentDue.getTime()) {
        return err(
          'VALIDATION_FAILED',
          `已經開放補交到 ${formatTaipeiMinute(currentDue)}（臺灣時間），補交期限只能延後、不能提早：${group ? '組員' : '學生'}已經收到這個期限的通知。` +
            '要提早請先跟對方說明，請他在你希望的時間前交；系統會收到原期限為止。',
          { details: { field: 'dueAt' } },
        )
      }

      await tx.query(
        `insert into submission_reopens (id, item_id, receiver_kind, receiver_id, due_at, reason, created_at, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [uuidv7(), itemId, kind, receiverId, dueAt, reason, realAt, userId],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: 'submission.reopen',
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId,
        realAt,
        businessAt,
        payload: { receiverKind: kind, receiverId, dueAt: dueAt.toISOString(), reason },
      })

      // 只通知這一位（整組＝那一組此刻有效、帳號正常的組員）；其他人截止規則沒變，不通知。
      const recipients = group
        ? (await this.#members(tx, receiverId)).filter((m) => m.active).map((m) => m.user_id)
        : (await tx.query<{ id: string }>(`select id from users where id = $1 and status = 'active' and deidentified_at is null`, [receiverId])).rows.map(
            (r) => r.id,
          )
      if (recipients.length > 0) {
        await this.#events.publish(tx, {
          type: 'submission.reopened',
          scope: 'cohort',
          cohortId,
          source: { type: 'item', id: itemId },
          actor: { kind: 'user', userId },
          recipients,
          payload: {
            title: `系辦開放你補交「${item.title}」，期限 ${formatTaipeiMinute(dueAt)}（臺灣時間）`,
            itemId,
            receiverKind: kind,
            receiverId,
            dueAt: dueAt.toISOString(),
            reason,
            code: groupRow?.code ?? null,
          },
          occurredRealAt: realAt,
          occurredBusinessAt: businessAt,
        })
      }

      const receipt = {
        itemId,
        receiverKind: kind,
        receiverId,
        dueAt: dueAt.toISOString(),
        reason,
        notified: recipients.length,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId, receiverKind: kind, receiverId } })
      return { ok: true as const, receipt }
    })
  }

  async setExempt(actor: ResolvedActor, input: ExemptInput, requestId: string): Promise<Result<ExemptReceipt>> {
    const denied = authorizeAdmin(actor, '設定免繳')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    const itemId = typeof input?.itemId === 'string' ? input.itemId : ''
    const receiverId = typeof input?.receiverId === 'string' ? input.receiverId : ''
    if (typeof input?.exempt !== 'boolean') return err('VALIDATION_FAILED', '請重新整理頁面再試一次。')
    const exempt = input.exempt
    if (!isUuid(itemId)) return err('VALIDATION_FAILED', '找不到這個作業，請重新整理頁面。')
    if (!isUuid(receiverId)) return notInRoster()
    // 恢復不用理由（也不存）；設免繳的理由選填（C 階段 X2），有填最多 200 字。
    const reasoned = exempt ? normalizeOptionalReason(input.reason, 200) : { ok: true as const, reason: null }
    if (!reasoned.ok) return err('VALIDATION_FAILED', '理由最多 200 字。', { details: { field: 'reason' } })
    const reason = reasoned.reason
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      // 鎖序：屆別（共享）→ 項目（共享）→ 那一列名單（獨占）。封存屆別拿屆別的獨占鎖，所以封存與設免繳不會交錯。
      const head = await tx.query<{ cohort_id: string }>('select cohort_id from managed_items where id = $1 and deleted_at is null', [itemId])
      const cohortId = head.rows[0]?.cohort_id
      if (!cohortId) return err('VALIDATION_FAILED', '找不到這個作業，請重新整理頁面。')
      const cohort = await tx.query<{ status: string }>('select status from cohorts where id = $1 for share', [cohortId])
      const found = await tx.query<{ receiver_unit: string }>(
        'select receiver_unit from managed_items where id = $1 and deleted_at is null for share',
        [itemId],
      )
      const item = found.rows[0]
      if (!item) return err('VALIDATION_FAILED', '找不到這個作業，請重新整理頁面。')

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: userId,
          // 冪等鍵跟稽核代碼同名（兩個都有中文標籤，不另造一個只給帳本用的代碼）。
          operationKind: exempt ? 'submission.exempt_set' : 'submission.exempt_cleared',
          requestId,
          fingerprint: sha256(canonicalJson({ itemId, receiverId, exempt, reason })),
          scope: 'cohort',
          cohortId,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<ExemptReceipt>(begun)

      if (item.receiver_unit !== 'individual' && item.receiver_unit !== 'group') {
        return err('VALIDATION_FAILED', '找不到這個作業，請重新整理頁面。')
      }
      if (cohort.rows[0]?.status === 'archived') {
        return err('COHORT_ARCHIVED', exempt ? '這一屆已經封存，不能再設免繳。' : '這一屆已經封存，不能再恢復需繳交。')
      }
      const group = item.receiver_unit === 'group'
      const kind: 'user' | 'group' = group ? 'group' : 'user'
      const roster = await tx.query<{ id: string; exempt: boolean; exempt_reason: string | null }>(
        `select id, exempt, exempt_reason from response_rosters
          where item_id = $1 and receiver_kind = $2 and receiver_id = $3 and eligible_to_business_at is null
          for update`,
        [itemId, kind, receiverId],
      )
      const row = roster.rows[0]
      if (!row) return err('NOT_IN_ROSTER', group ? '這一組不在這個作業的名單上。' : '這位學生不在這個作業的名單上。')
      if (row.exempt === exempt) {
        return err('CONFLICT', exempt ? (group ? '這一組已經是免繳。' : '這位已經是免繳。') : group ? '這一組不是免繳。' : '這位不是免繳。')
      }

      // 只改名單列，不碰任何草稿、版本與附件（Q-A3：已繳交的人設免繳，繳交保留；恢復後照原狀態顯示）。
      await tx.query(
        `update response_rosters
            set exempt = $2, exempt_reason = $3, revision = revision + 1, updated_at = $4, updated_by_user_id = $5
          where id = $1`,
        [row.id, exempt, reason, realAt, userId],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'admin',
        action: exempt ? 'submission.exempt_set' : 'submission.exempt_cleared',
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId,
        realAt,
        businessAt,
        payload: exempt
          ? { receiverKind: kind, receiverId, reason }
          : { receiverKind: kind, receiverId, previousReason: row.exempt_reason },
      })
      // 不發事件、不通知：免繳是系辦與學生線下談好的（設計方案 §6）。

      const receipt = { itemId, receiverId, exempt, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId, receiverKind: kind, receiverId, exempt } })
      return { ok: true as const, receipt }
    })
  }

  // ── 內部 ────────────────────────────────────────────────────────────────────

  /** 授權 → 屆別與組別 → 項目狀態 → 時間。回 null＝通過。 */
  #guard(locked: Locked, businessAt: Date): Err | null {
    const { item } = locked
    // 站內同意書（C 階段規格① §1.1、§1.2）：同意在簽核包裡投，不能用一般草稿、送出、上傳交一份空的「已交」。
    if (item.consent_mode === 'form') {
      return err('VALIDATION_FAILED', '這是站內同意書，請在同意書頁按「我同意」或「不同意」，不用另外填寫或上傳。')
    }
    if (item.receiver_unit === 'group') {
      if (!locked.receiver) return notMember()
    } else if (item.receiver_unit !== 'individual') {
      return notInRoster()
    }
    if (!locked.roster) return notInRoster()
    if (locked.roster.exempt) {
      return err('EXEMPTED', item.receiver_unit === 'group' ? '系辦已將你們這一組設為免繳這一項，不需要填寫。' : '系辦已將你設為免繳這一項，不需要填寫。')
    }
    if (locked.cohortStatus === 'archived') return err('COHORT_ARCHIVED', '這一屆已經封存，不能再填寫或送出。')
    if (locked.receiver?.kind === 'group' && locked.receiver.groupStatus !== 'active') {
      return err('GROUP_DISSOLVED', '這個組別已經解散，不能再填寫或送出。')
    }
    if (item.status !== 'published' || !locked.schema) return err('ITEM_NOT_OPEN', '這個作業目前沒有開放。')
    // 個別補交（W10）：已截止但這位收件者有還沒到期的補交期限就放行；沒有補交期限的人規則完全不變。
    const phase = phaseOf({ opensAt: item.opens_at, dueAt: item.due_at }, businessAt, locked.reopenUntil)
    if (phase === 'not_open') {
      return err('ITEM_NOT_OPEN', `這個作業還沒開放，${formatTaipeiMinute(item.opens_at!)}（臺灣時間）開放。`)
    }
    if (phase === 'closed') {
      return err('DEADLINE_PASSED', `已經截止（截止：${formatTaipeiMinute(item.due_at!)}，含此分鐘，臺灣時間）；需要補交請聯絡系辦。`)
    }
    return null
  }

  /**
   * 鎖序：屆別（共享）→ 組別（共享，整組一份才有）→ 項目（共享）。
   * 順便推出收件者、讀收件者的名單列與目前的欄位版本。
   */
  async #lock(tx: PoolClient, itemId: string, userId: string): Promise<Locked | null> {
    const head = await tx.query<{ cohort_id: string; receiver_unit: string }>(
      'select cohort_id, receiver_unit from managed_items where id = $1 and deleted_at is null',
      [itemId],
    )
    const cohortId = head.rows[0]?.cohort_id
    if (!cohortId) return null
    const cohort = await tx.query<{ status: string }>('select status from cohorts where id = $1 for share', [cohortId])

    let groupRow: { id: string; code: string; status: string } | null = null
    if (head.rows[0]!.receiver_unit === 'group') {
      const membership = await tx.query<{ group_id: string }>(
        'select group_id from group_memberships where user_id = $1 and cohort_id = $2 and valid_to is null',
        [userId, cohortId],
      )
      const groupId = membership.rows[0]?.group_id
      if (groupId) {
        const found = await tx.query<{ id: string; code: string; status: string }>(
          'select id, code, status from groups where id = $1 for share',
          [groupId],
        )
        // 組別鎖到手之後再確認一次：鎖之前讀到的組員身分，可能剛好被正在進行的移出結束掉。
        const still = await tx.query('select 1 from group_memberships where group_id = $1 and user_id = $2 and valid_to is null', [
          groupId,
          userId,
        ])
        groupRow = found.rows[0] && (still.rowCount ?? 0) > 0 ? found.rows[0] : null
      }
    }

    const found = await tx.query<ItemRow>(
      `select id, cohort_id, title, status, receiver_unit, opens_at, due_at, deadline_version, current_schema_version_id, consent_mode
         from managed_items where id = $1 and deleted_at is null for share`,
      [itemId],
    )
    const item = found.rows[0]
    if (!item || !cohort.rows[0]) return null

    const receiver: Receiver | null =
      item.receiver_unit === 'group'
        ? groupRow
          ? { kind: 'group', id: groupRow.id, groupCode: groupRow.code, groupStatus: groupRow.status }
          : null
        : { kind: 'user', id: userId, groupCode: null, groupStatus: null }
    const roster = receiver
      ? await tx.query<{ exempt: boolean }>(
          `select exempt from response_rosters
            where item_id = $1 and receiver_kind = $2 and receiver_id = $3 and eligible_to_business_at is null`,
          [itemId, receiver.kind, receiver.id],
        )
      : null
    const schema = item.current_schema_version_id
      ? await tx.query<{ id: string; version_no: number; schema: { fields?: FormField[] } }>(
          'select id, version_no, schema from form_schema_versions where id = $1',
          [item.current_schema_version_id],
        )
      : null
    const reopen = receiver
      ? await tx.query<{ due_at: Date | null }>(
          'select max(due_at) as due_at from submission_reopens where item_id = $1 and receiver_kind = $2 and receiver_id = $3',
          [itemId, receiver.kind, receiver.id],
        )
      : null
    const schemaRow = schema?.rows[0]
    return {
      item,
      cohortStatus: cohort.rows[0].status,
      receiver,
      reopenUntil: reopen?.rows[0]?.due_at ?? null,
      roster: roster?.rows[0] ?? null,
      schema: schemaRow ? { id: schemaRow.id, versionNo: schemaRow.version_no, fields: schemaRow.schema.fields ?? [] } : null,
    }
  }

  async #lockDraft(tx: PoolClient, itemId: string, receiver: Receiver): Promise<DraftRow | null> {
    const found = await tx.query<DraftRow>(
      `select id, revision, schema_version_id, migration_state, answers, file_ids from submission_drafts
        where item_id = $1 and receiver_kind = $2 and receiver_id = $3 for update`,
      [itemId, receiver.kind, receiver.id],
    )
    return found.rows[0] ?? null
  }

  /** 此刻的有效組員（組別列已經 `FOR SHARE` 鎖著，成員異動進不來）。`active`＝帳號正常，可以收通知。 */
  async #members(tx: PoolClient, groupId: string): Promise<{ user_id: string; active: boolean }[]> {
    const found = await tx.query<{ user_id: string; active: boolean }>(
      `select m.user_id, (u.status = 'active' and u.deidentified_at is null) as active
         from group_memberships m join users u on u.id = m.user_id
        where m.group_id = $1 and m.valid_to is null
        order by m.user_id`,
      [groupId],
    )
    return found.rows
  }

  async #memberIds(tx: PoolClient, groupId: string): Promise<string[]> {
    return (await this.#members(tx, groupId)).map((m) => m.user_id)
  }

  /**
   * 附件合不合**這個欄位**的規則（模組 10 §11.2：類型白名單、單檔上限取欄位與環境的較小值；上傳時已經照同一條擋過一次，
   * 這裡是第二道：檔案是替 A 欄位傳的卻放到只收圖片的 B 欄位、或屬於別屆，一律擋）。
   */
  async #checkFileRules(tx: PoolClient, locked: Locked, wanted: readonly { fieldKey: string; fileId: string }[]): Promise<Err | null> {
    if (wanted.length === 0) return null
    const facts = await tx.query<{ id: string; cohort_id: string | null; extension: string; size_bytes: string | number | null; status: string }>(
      'select id, cohort_id, extension, size_bytes, status from stored_files where id = any($1::uuid[])',
      [wanted.map((f) => f.fileId)],
    )
    for (const f of wanted) {
      const field = locked.schema!.fields.find((x) => x.key === f.fieldKey)!
      const rules = field.fileRules ?? { allowedTypes: ['pdf'], maxMiB: 20 }
      const row = facts.rows.find((r) => r.id === f.fileId)
      const details = { details: { field: f.fieldKey } }
      if (!row || row.cohort_id !== locked.item.cohort_id) return err('FILE_NOT_OWNED', `「${field.label}」的檔案找不到，請重新上傳。`, details)
      if (row.status !== 'stored') return err('FILE_NOT_READY', `「${field.label}」的檔案還沒上傳完成，請重新上傳。`, details)
      if (!typeForExtension(row.extension, rules.allowedTypes)) {
        return err('FILE_TYPE_REJECTED', `「${field.label}」只接受 ${allowedExtensions(rules)} 檔。`, details)
      }
      if (Number(row.size_bytes) > rules.maxMiB * MIB) {
        return err('FILE_TOO_LARGE', `「${field.label}」的檔案超過上限 ${formatBytes(rules.maxMiB * MIB)}。`, details)
      }
    }
    return null
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'submissions', body, (constraint) =>
      constraint === 'submission_drafts_receiver_unique'
        ? err('CONFLICT', '這份草稿剛剛在別處（別的分頁、裝置或組員）存過了。請重新載入看最新的內容；畫面上的輸入不會自動蓋過去。')
        : err('CONFLICT', '剛剛同時送出了兩次，請重新載入看繳交歷史確認結果。'),
    )
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

// ── 查詢 ──────────────────────────────────────────────────────────────────────

type Reader = () => Pick<Pool, 'query'>

type ListRow = {
  id: string
  title: string
  consent_mode: string | null
  schema: { fields?: FormField[] } | null
  stage_name: string | null
  cohort_id: string
  stage_seq: number | null
  opens_at: Date | null
  due_at: Date | null
  attachment_count: string
  exempt: boolean
  receiver_unit: 'individual' | 'group'
  group_code: string | null
  has_draft: boolean
  latest_version_no: number | null
  latest_received_at: Date | null
  reopen_until: Date | null
}

/** 這位收件者最晚的個別補交期限（W10）；`r` 是名單列。學生作業區與系辦名單頁用同一段。 */
export const REOPEN_UNTIL = `
  (select max(o.due_at) from submission_reopens o
    where o.item_id = r.item_id and o.receiver_kind = r.receiver_kind and o.receiver_id = r.receiver_id) as reopen_until`

export type VersionRow = {
  version_id: string
  version_no: number
  received_business_at: Date
  received_real_at: Date
  submitted_by_name: string
  submitted_by_user_id: string
  submitted_by_avatar_preset: number | null
  submitted_by_avatar_file_id: string | null
  schema_version_no: number
  request_id: string
}

/**
 * 版本列的欄位。「補交」標記（W10）不在這裡：它是**送出當下**判定、記在那一版 `submission.submit` 稽核裡的，
 * 稽核表屬模組 10，收件模組不直接讀，拿到列之後再經 `summarizeVersions` 用 `SubmissionLateFlags` port 批次問
 * （架構 §4.4）。所以這裡帶出 `v.id`。
 */
export const VERSION_COLUMNS = `
  v.id as version_id, v.version_no, v.received_business_at, v.received_real_at, v.request_id,
  coalesce(p.display_name, u.name) as submitted_by_name, sv.version_no as schema_version_no,
  u.id as submitted_by_user_id, p.avatar_preset as submitted_by_avatar_preset, p.avatar_file_id as submitted_by_avatar_file_id`

export const VERSION_JOINS = `
  join users u on u.id = v.submitted_by_user_id
  left join user_profiles p on p.user_id = v.submitted_by_user_id
  join form_schema_versions sv on sv.id = v.schema_version_id`

/**
 * 某個收件者在某個項目上「有沒有草稿」「最後一次正式送出」（票 18）。
 *
 * 學生作業區（`myItems`，也是學生首頁待繳數的來源）與管理員名單頁用**同一段**，
 * 再經 application 同一個 `receiverStatus` 算狀態——兩邊的「已繳／未繳」不會各算各的。
 * 帶出的欄位：`facts.has_draft`、`latest.version_no`、`latest.received_business_at`、`latest.submitted_by_user_id`。
 */
export function receiverFactsJoin(item: string, kind: string, receiver: string): string {
  return `
  left join lateral (
    select exists (select 1 from submission_drafts d
                    where d.item_id = ${item} and d.receiver_kind = ${kind} and d.receiver_id = ${receiver}) as has_draft
  ) facts on true
  left join lateral (
    select v.version_no, v.received_business_at, v.submitted_by_user_id from submission_versions v
     where v.item_id = ${item} and v.receiver_kind = ${kind} and v.receiver_id = ${receiver}
     order by v.version_no desc limit 1
  ) latest on true`
}

/**
 * 「這一列名單是我的」：個人收件是本人；組別收件是本人**此刻**所在、未解散的組（`$1`＝本人）。
 * 作業區、內容頁、通知連結都用這一段，被移出組別的人立刻看不到那一組的草稿與收件。
 */
export const MY_ROSTER_ROW = `
  r.eligible_to_business_at is null and m.status = 'published' and (
    (r.receiver_kind = 'user' and r.receiver_id = $1 and m.receiver_unit = 'individual')
    or (r.receiver_kind = 'group' and m.receiver_unit = 'group' and g.status = 'active'
        and exists (select 1 from group_memberships gm
                     where gm.group_id = r.receiver_id and gm.user_id = $1 and gm.valid_to is null))
  )`

export function toSummary(row: VersionRow, lateVersionIds: ReadonlySet<string>): VersionSummary {
  return {
    versionNo: row.version_no,
    receivedBusinessAt: row.received_business_at,
    receivedRealAt: row.received_real_at,
    submittedByName: row.submitted_by_name,
    // 繳交人頭像（C1-10 繳交歷史）：跟版本同一句帶出，看得到這一版的人才看得到。
    submittedBy: {
      id: row.submitted_by_user_id,
      name: row.submitted_by_name,
      avatarPreset: row.submitted_by_avatar_preset,
      avatarFileId: row.submitted_by_avatar_file_id,
    },
    schemaVersionNo: row.schema_version_no,
    requestId: row.request_id,
    late: lateVersionIds.has(row.version_id),
  }
}

/**
 * 版本列 → 畫面摘要，「補交」標記一次批次問模組 10 的 port（不逐版本查）。沒被記成補交的（含 W10 之前的舊版本）
 * 一律 `late: false`。列是空的就不問。
 */
export async function summarizeVersions(lateFlags: SubmissionLateFlags, rows: readonly VersionRow[]): Promise<VersionSummary[]> {
  if (rows.length === 0) return []
  const late = await lateFlags.lateByVersionIds(rows.map((r) => r.version_id))
  return rows.map((row) => toSummary(row, late))
}

type FileRow = { id: string; original_name: string; size_bytes: string | number | null; checksum: string | null }

/** 答案裡的檔案 → 畫面要的附件資訊（檔名、大小、checksum）。 */
async function answerFilesOf(db: Pick<Pool, 'query'>, fields: readonly FormField[], answers: Answers): Promise<AnswerFile[]> {
  const wanted = fileAnswers(fields, answers)
  if (wanted.length === 0) return []
  const rows = await db.query<FileRow>(
    'select id, original_name, size_bytes, checksum from stored_files where id = any($1::uuid[])',
    [wanted.map((f) => f.fileId)],
  )
  return wanted.flatMap((f) => {
    const row = rows.rows.find((r) => r.id === f.fileId)
    return row
      ? [{ fieldKey: f.fieldKey, fileId: f.fileId, name: row.original_name, sizeBytes: Number(row.size_bytes ?? 0), checksum: row.checksum ?? '' }]
      : []
  })
}

/** 組別資訊：組員（組長在前）與目前主指導。 */
export async function groupSummary(db: Pick<Pool, 'query'>, groupId: string, code: string): Promise<GroupSummary> {
  const [members, advisor] = await Promise.all([
    db.query<{ user_id: string; name: string; is_leader: boolean }>(
      `select m.user_id, coalesce(p.display_name, u.name) as name,
              exists (select 1 from group_leaders l where l.group_id = m.group_id and l.user_id = m.user_id and l.valid_to is null) as is_leader
         from group_memberships m join users u on u.id = m.user_id left join user_profiles p on p.user_id = m.user_id
        where m.group_id = $1 and m.valid_to is null
        order by is_leader desc, name`,
      [groupId],
    ),
    db.query<{ name: string }>(
      `select coalesce(p.display_name, u.name) as name from advisor_assignments a
         join users u on u.id = a.teacher_user_id left join user_profiles p on p.user_id = a.teacher_user_id
        where a.group_id = $1 and a.valid_to is null`,
      [groupId],
    ),
  ])
  return {
    groupId,
    code,
    members: members.rows.map((m) => ({ userId: m.user_id, name: m.name, isLeader: m.is_leader })),
    advisorName: advisor.rows[0]?.name ?? null,
  }
}

/** 這份收件最新的主指導閱覽設定（只插不改，最新一列為準）。 */
export const LATEST_VISIBILITY = `
  (select row_to_json(x) from (
     select s.enabled, s.effective_from_version_no as "effectiveFromVersionNo" from advisor_visibility_settings s
      where s.item_id = %ITEM% order by s.set_at desc, s.id desc limit 1) x)`

export class PgSubmissionQuery implements SubmissionQuery {
  readonly #reader: Reader
  readonly #lateFlags: SubmissionLateFlags

  /** `lateFlags`：模組 10 的「哪些版本是補交」批次查詢 port，由 composition 注入（架構 §4.4）。 */
  constructor(reader: Reader = getPool, lateFlags: SubmissionLateFlags) {
    this.#reader = reader
    this.#lateFlags = lateFlags
  }

  async myItems(userId: string): Promise<MyItemRow[]> {
    if (!isUuid(userId)) return []
    const [rostered, awaiting] = await Promise.all([this.#rosterItems(userId), this.#awaitingAdvisorConsent(userId)])
    // 沒有等同意的（學生、多數老師）就是名單查詢原本的順序；有才併進來、照截止再標題排。
    if (awaiting.length === 0) return rostered
    return [...rostered, ...awaiting].sort(
      (a, b) =>
        (a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
        a.title.localeCompare(b.title),
    )
  }

  /**
   * 等這位主指導同意的站內同意書（C 階段規格① §3.2）：作業發布中、`consent_mode='form'`，包的**目前版本**狀態是
   * `teacher_pending`、而且那一版參與者快照的主指導就是本人（換老師會建新版，舊老師的快照不再是目前版本）。一組一列。
   */
  async #awaitingAdvisorConsent(userId: string): Promise<MyItemRow[]> {
    const rows = await this.#reader().query<{
      id: string
      title: string
      cohort_id: string
      opens_at: Date | null
      due_at: Date | null
      attachment_count: string
      group_id: string
      group_code: string
      package_id: string
      version_id: string
    }>(
      `select m.id, m.title, m.cohort_id, m.opens_at, m.due_at,
              (select count(*) from item_attachments a where a.item_id = m.id) as attachment_count,
              g.id as group_id, g.code as group_code, p.id as package_id, pv.id as version_id
         from signoff_packages p
         join managed_items m on m.id = p.item_id
         join groups g on g.id = p.group_id
         join signoff_package_versions pv on pv.id = p.current_version_id
         join signoff_version_status st on st.version_id = pv.id
        where m.status = 'published' and m.deleted_at is null and m.consent_mode = 'form'
          and st.state = 'teacher_pending'
          and pv.participants -> 'advisor' ->> 'userId' = $1::text`,
      [userId],
    )
    return rows.rows.map((r) => ({
      itemId: r.id,
      title: r.title,
      kind: 'consent_form' as const,
      formType: 'form' as const,
      stageName: null,
      cohortId: r.cohort_id,
      stageSeq: null,
      opensAt: r.opens_at,
      dueAt: r.due_at,
      attachmentCount: Number(r.attachment_count),
      exempt: false,
      hasDraft: false,
      latestVersionNo: null,
      latestReceivedAt: null,
      receiverUnit: 'group' as const,
      groupCode: r.group_code,
      reopenUntil: null,
      consent: { state: 'teacher_pending' as const, groupId: r.group_id, packageId: r.package_id, versionId: r.version_id },
    }))
  }

  async #rosterItems(userId: string): Promise<MyItemRow[]> {
    const rows = await this.#reader().query<ListRow>(
      `select m.id, m.title, m.consent_mode, sv.schema, s.name as stage_name, m.cohort_id, s.seq as stage_seq, m.opens_at, m.due_at,
              r.exempt, m.receiver_unit, g.code as group_code,
              (select count(*) from item_attachments a where a.item_id = m.id) as attachment_count,
              facts.has_draft, latest.version_no as latest_version_no, latest.received_business_at as latest_received_at,
              ${REOPEN_UNTIL}
         from response_rosters r
         join managed_items m on m.id = r.item_id
         left join groups g on r.receiver_kind = 'group' and g.id = r.receiver_id
         left join cohort_stages s on s.id = m.stage_id
         left join form_schema_versions sv on sv.id = m.current_schema_version_id
         ${receiverFactsJoin('m.id', 'r.receiver_kind', 'r.receiver_id')}
        where ${MY_ROSTER_ROW}
        order by m.due_at nulls last, m.title`,
      [userId],
    )
    return rows.rows.map((r) => ({
      itemId: r.id,
      title: r.title,
      kind: itemKindOf(r.consent_mode),
      formType: formTypeOf(r.schema?.fields ?? []),
      stageName: r.stage_name,
      cohortId: r.cohort_id,
      stageSeq: r.stage_seq,
      opensAt: r.opens_at,
      dueAt: r.due_at,
      attachmentCount: Number(r.attachment_count),
      exempt: r.exempt,
      hasDraft: r.has_draft,
      latestVersionNo: r.latest_version_no,
      latestReceivedAt: r.latest_received_at,
      receiverUnit: r.receiver_unit,
      groupCode: r.group_code,
      reopenUntil: r.reopen_until,
    }))
  }

  async myItem(userId: string, itemId: string): Promise<MyItemDetail | null> {
    if (!isUuid(userId) || !isUuid(itemId)) return null
    const db = this.#reader()
    const found = await db.query<{
      id: string
      title: string
      summary: string
      body_html: string
      stage_name: string | null
      opens_at: Date | null
      due_at: Date | null
      exempt: boolean
      receiver_kind: 'user' | 'group'
      receiver_id: string
      group_code: string | null
      schema_version_no: number
      schema: { fields?: FormField[] }
      visibility: { enabled: boolean; effectiveFromVersionNo: number } | null
      reopen_until: Date | null
    }>(
      `select m.id, cv.title, cv.summary, cv.body_html, s.name as stage_name, m.opens_at, m.due_at, r.exempt,
              r.receiver_kind, r.receiver_id, g.code as group_code, sv.version_no as schema_version_no, sv.schema,
              ${LATEST_VISIBILITY.replace('%ITEM%', 'm.id')} as visibility, ${REOPEN_UNTIL}
         from response_rosters r
         join managed_items m on m.id = r.item_id
         left join groups g on r.receiver_kind = 'group' and g.id = r.receiver_id
         join item_versions cv on cv.id = m.current_content_version_id
         join form_schema_versions sv on sv.id = m.current_schema_version_id
         left join cohort_stages s on s.id = m.stage_id
        where ${MY_ROSTER_ROW} and m.id = $2`,
      [userId, itemId],
    )
    const item = found.rows[0]
    if (!item) return null
    const kind = item.receiver_kind
    const fields = item.schema.fields ?? []
    const [files, draft, versions, group] = await Promise.all([
      db.query<{ id: string; original_name: string; size_bytes: string | null }>(
        `select f.id, f.original_name, f.size_bytes from item_attachments a join stored_files f on f.id = a.file_id
          where a.item_id = $1 order by a.sort, f.id`,
        [itemId],
      ),
      db.query<{ answers: Answers; revision: number; updated_at: Date; updated_by_name: string | null; schema: { fields?: FormField[] } }>(
        `select d.answers, d.revision, d.updated_at, coalesce(p.display_name, u.name) as updated_by_name, sv.schema
           from submission_drafts d
           join form_schema_versions sv on sv.id = d.schema_version_id
           left join users u on u.id = d.updated_by_user_id
           left join user_profiles p on p.user_id = d.updated_by_user_id
          where d.item_id = $1 and d.receiver_kind = $2 and d.receiver_id = $3`,
        [itemId, kind, item.receiver_id],
      ),
      db.query<VersionRow>(
        `select ${VERSION_COLUMNS} from submission_versions v ${VERSION_JOINS}
          where v.item_id = $1 and v.receiver_kind = $2 and v.receiver_id = $3
          order by v.version_no desc`,
        [itemId, kind, item.receiver_id],
      ),
      kind === 'group' ? groupSummary(db, item.receiver_id, item.group_code ?? '') : Promise.resolve(null),
    ])
    const draftRow = draft.rows[0]
    return {
      itemId: item.id,
      title: item.title,
      summary: item.summary,
      bodyHtml: item.body_html,
      attachments: files.rows.map((f) => ({ fileId: f.id, name: f.original_name, sizeBytes: Number(f.size_bytes ?? 0) })),
      stageName: item.stage_name,
      opensAt: item.opens_at,
      dueAt: item.due_at,
      schemaVersionNo: item.schema_version_no,
      fields,
      exempt: item.exempt,
      receiverUnit: kind === 'group' ? 'group' : 'individual',
      group,
      advisorCanView: kind === 'user' && advisorMayReadIndividual(item.visibility, item.schema_version_no),
      draft: draftRow
        ? {
            answers: draftRow.answers,
            revision: draftRow.revision,
            updatedAt: draftRow.updated_at,
            updatedByName: draftRow.updated_by_name,
            files: await answerFilesOf(db, draftRow.schema.fields ?? [], draftRow.answers),
          }
        : null,
      versions: await summarizeVersions(this.#lateFlags, versions.rows),
      reopenUntil: item.reopen_until,
    }
  }

  async myVersion(userId: string, itemId: string, versionNo: number): Promise<MyVersionDetail | null> {
    if (!isUuid(userId) || !isUuid(itemId)) return null
    const db = this.#reader()
    // 個人收件：本人就是收件者，不要求目前還在名單上（本人唯讀自己的正式版本，產品模組 05 §8）。
    // 組別收件：本人此刻所在、未解散的組（被移出的人讀自己還在組裡時的版本在票 22 接）。
    const found = await db.query<{ receiver_unit: string; group_id: string | null }>(
      `select m.receiver_unit,
              (select gm.group_id from group_memberships gm join groups g on g.id = gm.group_id
                where gm.user_id = $1 and gm.cohort_id = m.cohort_id and gm.valid_to is null and g.status = 'active') as group_id
         from managed_items m where m.id = $2 and m.deleted_at is null`,
      [userId, itemId],
    )
    const row = found.rows[0]
    if (!row) return null
    if (row.receiver_unit === 'group') return row.group_id ? versionDetail(db, this.#lateFlags, itemId, 'group', row.group_id, versionNo) : null
    return versionDetail(db, this.#lateFlags, itemId, 'user', userId, versionNo)
  }

  async myRecords(userId: string): Promise<MyRecordRow[]> {
    if (!isUuid(userId)) return []
    const db = this.#reader()
    const [rows, viewer] = await Promise.all([
      db.query<RecordVersionRow>(`${RECORD_VERSIONS} order by v.item_id, v.receiver_id, v.version_no desc`, [userId, null, null]),
      viewerForUser(db, userId, STUDENT),
    ])
    const out = new Map<string, MyRecordRow>()
    for (const row of rows.rows) {
      // 作業區已經列著的（此刻還在那一組、名單上）不重複列；讀不到的版本（移出之後才送的）不算。
      if (row.in_workspace || !canReadSubmission(viewer, holderOf(row))) continue
      const key = `${row.item_id}:${row.receiver_id}`
      const seen = out.get(key)
      if (seen) {
        out.set(key, { ...seen, versionCount: seen.versionCount + 1 })
        continue
      }
      out.set(key, {
        itemId: row.item_id,
        title: row.title,
        receiverKind: row.receiver_kind,
        receiverId: row.receiver_id,
        groupCode: row.group_code,
        versionCount: 1,
        latestVersionNo: row.version_no,
        latestReceivedAt: row.received_business_at,
      })
    }
    return [...out.values()].sort((a, b) => b.latestReceivedAt.getTime() - a.latestReceivedAt.getTime())
  }

  async myRecord(userId: string, itemId: string, receiverId: string): Promise<MyRecordDetail | null> {
    if (!isUuid(userId) || !isUuid(itemId) || !isUuid(receiverId)) return null
    const db = this.#reader()
    const [rows, viewer] = await Promise.all([
      db.query<RecordVersionRow>(`${RECORD_VERSIONS} order by v.version_no desc`, [userId, itemId, receiverId]),
      viewerForUser(db, userId, STUDENT),
    ])
    const visible = rows.rows.filter((row) => canReadSubmission(viewer, holderOf(row)))
    const first = visible[0]
    if (!first) return null
    return {
      itemId,
      title: first.title,
      receiverKind: first.receiver_kind,
      receiverId,
      groupCode: first.group_code,
      versions: await summarizeVersions(this.#lateFlags, visible),
    }
  }

  async myRecordVersion(userId: string, itemId: string, receiverId: string, versionNo: number): Promise<MyVersionDetail | null> {
    if (!isUuid(userId) || !isUuid(itemId) || !isUuid(receiverId) || !Number.isInteger(versionNo) || versionNo < 1) return null
    const db = this.#reader()
    const [rows, viewer] = await Promise.all([
      db.query<RecordVersionRow>(`${RECORD_VERSIONS} order by v.version_no desc`, [userId, itemId, receiverId]),
      viewerForUser(db, userId, STUDENT),
    ])
    // 跟 `myRecord` 同一份清單：讀得到的版本才點得開；「是不是最新」也只跟讀得到的比（移出之後的新版本不透露）。
    const visible = rows.rows.filter((row) => canReadSubmission(viewer, holderOf(row)))
    const row = visible.find((r) => r.version_no === versionNo)
    if (!row) return null
    return versionDetail(db, this.#lateFlags, itemId, row.receiver_kind, receiverId, versionNo, visible[0]!.version_no)
  }

  async reopens(actor: ResolvedActor, itemId: string, receiverId: string): Promise<readonly ReopenEntry[] | null> {
    if (authorizeAdmin(actor, '查看補交紀錄')) return null
    if (!isUuid(itemId) || !isUuid(receiverId)) return null
    const rows = await this.#reader().query<{ due_at: Date; reason: string | null; created_at: Date; created_by_name: string }>(
      `select o.due_at, o.reason, o.created_at, coalesce(p.display_name, u.name) as created_by_name
         from submission_reopens o
         join users u on u.id = o.created_by_user_id
         left join user_profiles p on p.user_id = o.created_by_user_id
        where o.item_id = $1 and o.receiver_id = $2
        order by o.created_at desc, o.id desc`,
      [itemId, receiverId],
    )
    return rows.rows.map((r) => ({ dueAt: r.due_at, reason: r.reason, createdAt: r.created_at, createdByName: r.created_by_name }))
  }
}

const STUDENT = { isAdmin: false, isTeacher: false } as const

type RecordVersionRow = VersionRow &
  VersionAccessRow & { item_id: string; title: string; group_code: string | null; in_workspace: boolean }

/**
 * 我的繳交紀錄的候選版本（票 22）：自己的個人回答，或送出當下自己在組裡的組別版本（`membership_snapshot`）。
 * 能不能讀由呼叫端再經 `canReadSubmission` 判（跟附件下載同一段事實）；`in_workspace`＝作業區已經列著（`MY_ROSTER_ROW`）。
 * `$1`＝本人、`$2`＝只看某一份收件、`$3`＝只看某一位收件者（null＝全部）。
 */
const RECORD_VERSIONS = `
  select v.item_id, m.title, g.code as group_code, ${VERSION_COLUMNS}, ${VERSION_ACCESS_COLUMNS},
         exists (select 1 from response_rosters r
                  where r.item_id = v.item_id and r.receiver_kind = v.receiver_kind and r.receiver_id = v.receiver_id
                    and ${MY_ROSTER_ROW}) as in_workspace
    from submission_versions v ${VERSION_JOINS}
    join managed_items m on m.id = v.item_id
    left join groups g on v.receiver_kind = 'group' and g.id = v.receiver_id
   where ((v.receiver_kind = 'user' and v.receiver_id = $1)
          or (v.receiver_kind = 'group' and v.membership_snapshot ? ($1::uuid)::text))
     and ($2::uuid is null or v.item_id = $2::uuid)
     and ($3::uuid is null or v.receiver_id = $3::uuid)`

/**
 * 某個收件者某一次正式送出的內容（本人的繳交歷史與管理員名單頁共用）。附件照 `submission_files`（送出當下的 checksum）。
 *
 * `latestVisibleVersionNo`：看的人**讀得到的**版本裡最新的一版。只讀得到部分版本的人（被移出的組員只讀得到快照含自己的版本、
 * 老師只讀得到開放閱覽之後的版本）一定要傳，`isLatest` 才只跟他讀得到的比——不然打開 v2 會看到「已被後來的版本取代」，
 * 等於透露之後還有他看不到的版本（PR #267 審查建議）。讀得到全部版本的人（組員、管理員）不傳，就跟全部版本比。
 */
export async function versionDetail(
  db: Pick<Pool, 'query'>,
  lateFlags: SubmissionLateFlags,
  itemId: string,
  receiverKind: 'user' | 'group',
  receiverId: string,
  versionNo: number,
  latestVisibleVersionNo?: number,
): Promise<MyVersionDetail | null> {
  if (!isUuid(receiverId) || !isUuid(itemId) || !Number.isInteger(versionNo) || versionNo < 1) return null
  const found = await db.query<VersionRow & { id: string; answers: Answers; schema: { fields?: FormField[] }; latest: number }>(
    `select v.id, ${VERSION_COLUMNS}, v.answers, sv.schema,
            (select max(x.version_no) from submission_versions x
              where x.item_id = v.item_id and x.receiver_kind = v.receiver_kind and x.receiver_id = v.receiver_id) as latest
       from submission_versions v ${VERSION_JOINS}
      where v.item_id = $1 and v.receiver_kind = $2 and v.receiver_id = $3 and v.version_no = $4`,
    [itemId, receiverKind, receiverId, versionNo],
  )
  const row = found.rows[0]
  if (!row) return null
  const files = await db.query<{ field_key: string; file_id: string; checksum: string; original_name: string; size_bytes: string | number | null }>(
    `select sf.field_key, sf.file_id, sf.checksum, f.original_name, f.size_bytes
       from submission_files sf join stored_files f on f.id = sf.file_id
      where sf.submission_version_id = $1 order by sf.field_key`,
    [row.id],
  )
  const [summary] = await summarizeVersions(lateFlags, [row])
  return {
    ...summary!,
    isLatest: (latestVisibleVersionNo ?? row.latest) === row.version_no,
    fields: row.schema.fields ?? [],
    answers: row.answers,
    files: files.rows.map((f) => ({
      fieldKey: f.field_key,
      fileId: f.file_id,
      name: f.original_name,
      sizeBytes: Number(f.size_bytes ?? 0),
      checksum: f.checksum,
    })),
  }
}
