import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource, CohortStatus } from '@/application/cohorts'
import { renderBodyHtml, sanitizeBody } from '@/application/items'
import type { EventPublisher } from '@/application/notifications'
import { canonicalJson, type AuditWriter, type FileStorage, type OperationLedger } from '@/application/ops'
import {
  BUTTON_TEXT,
  buildParticipants,
  buildProgress,
  buildSignoffCsv,
  buildSignoffPrintable,
  CAUSE_LABEL,
  causeForNewVersion,
  causeForRestart,
  checkVoid,
  checkVote,
  freezeAuthorizationScope,
  hasVisibleText,
  isTerminal,
  MAX_ATTACHMENTS,
  MAX_CONTENT_CHARS,
  nextRemindAt,
  nextStateAfterVote,
  normalizeReason,
  PURPOSE_LABEL,
  readAuthorizationScope,
  readParticipants,
  remindable,
  remindRecipients,
  RESTART_LABEL,
  restartKindFor,
  resultFor,
  roleIn,
  scopeContent,
  SIGNOFF_PURPOSES,
  supersedesOnRestart,
  type AdminGroupRow,
  type AdminSignoffBoard,
  type AdvisorParticipant,
  type AttachmentVersion,
  type AuthorizationScope,
  type CreateVersionInput,
  type CreateVersionReceipt,
  type DraftSnapshot,
  type ExportLifecycle,
  type ExportVote,
  type Participants,
  type ReasonedVersionInput,
  type RemindReceipt,
  type RespondInput,
  type RespondReceipt,
  type RestartKind,
  type RestartReceipt,
  type SignoffCommand,
  type SignoffExportData,
  type SignoffExportFile,
  type SignoffExportFormat,
  type SignoffParticipantHook,
  type SignoffPurpose,
  type SignoffQuery,
  type SignoffState,
  type StudentParticipant,
  type StudentSignoffView,
  type SupersedeCause,
  type TeacherSignoffCard,
  type VersionDetail,
  type VersionSummary,
  type VoidReceipt,
  type VoteRecord,
  type VoteResult,
  type VoteRole,
} from '@/application/signoff'
import { authorizeAdmin, badRequestId, inTransaction, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { activeAdminIds } from '@/infrastructure/notifications/worker-alerts'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, ok, type Err, type Result } from '@/shared/result'
import { formatTaipeiMinute, RealClock, type Clock } from '@/shared/time'

/**
 * 簽核建版與參與者變更時的失效（票 25／S11-04；模組實作設計 07 §2、§3「→collecting」「any→superseded」、§5、§6；
 * 產品模組 07 §4「8.1」「8.3」「參與者版本與失效」）。
 *
 * 建版是一筆交易（契約 01 §8）：鎖 → 帳本 `begin` → 參與者快照 → 簽核包 → 舊版失效 → 授權範圍凍結 → 附件綁定 →
 * 版本內容＋狀態列 → 事件（輪到本人同意）→ 稽核 → 帳本 `commit`。業務時間在開交易**之前**讀一次。
 *
 * 鎖順序（契約 01 §6：cohorts → groups → 頭列）：`cohorts FOR SHARE` → `groups FOR SHARE` →
 * `signoff_packages FOR UPDATE` → 舊的目前版本 `signoff_version_status FOR UPDATE` → `showcase_drafts FOR SHARE`。
 * - 管理員調整組員拿的是 `groups FOR UPDATE`（和這裡的 FOR SHARE 互斥）：參與者快照不會拍到成員異動的一半；
 *   異動在建版之後 commit 的話，異動那一筆交易會把剛建的版本標失效（見 `supersedeForParticipantChange`）。
 * - 兩位管理員同時對同組同用途建版：在簽核包列上排隊，版本號不會撞，後建的讓先建的失效。
 * - 凍結授權範圍拿草稿 `FOR SHARE`，和草稿儲存的 `FOR UPDATE` 互斥：凍結的一定是某一次完整儲存的內容。
 *
 * 全文存**清洗後**的受限 HTML（和公告正文同一份白名單）；`content_checksum`＝sha256(清洗後的全文)，資料庫 CHECK 再核一次。
 * 附件只能從這一組**正式送出**的繳交檔案裡選：以 `heldBy: submission_version` 綁到版本上（綁的是那一刻的檔案版本與 checksum）。
 * 最終文件授權的海報也綁到版本上（`signoff_version` 引用），草稿之後換圖，這一版凍結的那張仍保留得住（GC 看有效引用）。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

type CohortRow = { id: string; code: string; status: CohortStatus }
type GroupRow = { id: string; cohort_id: string; code: string; status: 'active' | 'dissolved' }
type PackageRow = { id: string; cohort_id: string; current_version_id: string | null }
type StatusRow = { version_id: string; version_no: number; state: SignoffState; cause: string | null }

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  events: EventPublisher<PoolClient>
  files: FileStorage<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

function groupNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個組別，請重新整理頁面。', { details: { field: 'groupId' } })
}

function denied(): Err {
  return err('FORBIDDEN', '無法存取這個簽核版本。')
}

/** 建版輸入的形狀檢查（不碰資料庫）。 */
function checkInput(input: CreateVersionInput): { ok: true; content: string; attachments: string[] } | Err {
  if (!isUuid(input.groupId)) return groupNotFound()
  if (!SIGNOFF_PURPOSES.includes(input.purpose)) {
    return err('VALIDATION_FAILED', '請選簽核用途（期中結果確認或最終文件授權）。', { details: { field: 'purpose' } })
  }
  const raw = String(input.content ?? '')
  if (raw.length > MAX_CONTENT_CHARS) {
    return err('VALIDATION_FAILED', `全文太長（上限 ${MAX_CONTENT_CHARS.toLocaleString()} 字）；附件請用「選附件」綁上。`, {
      details: { field: 'content' },
    })
  }
  const content = sanitizeBody(raw)
  if (!hasVisibleText(content)) return err('VALIDATION_FAILED', '全文必填：請貼上要大家閱讀並同意的內容。', { details: { field: 'content' } })

  const attachments = [...new Set((input.attachmentFileIds ?? []).map(String))]
  if (attachments.length > MAX_ATTACHMENTS) {
    return err('VALIDATION_FAILED', `附件最多 ${MAX_ATTACHMENTS} 個。`, { details: { field: 'attachments' } })
  }
  if (attachments.some((id) => !isUuid(id))) return err('VALIDATION_FAILED', '附件編號不正確，請重新整理頁面。', { details: { field: 'attachments' } })

  const entryId = input.showcaseEntryId ? String(input.showcaseEntryId) : null
  if (input.purpose === 'final_document' && !entryId) {
    return err('VALIDATION_FAILED', '最終文件授權要選這一組的精選草稿（授權範圍從它凍結）。', { details: { field: 'showcaseEntryId' } })
  }
  if (input.purpose === 'result_confirmation' && entryId) {
    return err('VALIDATION_FAILED', '期中結果確認不帶公開授權範圍，不能選精選草稿。', { details: { field: 'showcaseEntryId' } })
  }
  if (entryId && !isUuid(entryId)) return err('VALIDATION_FAILED', '找不到這份精選草稿，請重新整理頁面。', { details: { field: 'showcaseEntryId' } })
  return { ok: true, content, attachments }
}

export class PgSignoffCommand implements SignoffCommand, SignoffParticipantHook<PoolClient> {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #files: FileStorage<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#events = deps.events
    this.#files = deps.files
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  async createVersion(actor: ResolvedActor, input: CreateVersionInput, requestId: string): Promise<Result<CreateVersionReceipt>> {
    const blocked = authorizeAdmin(actor, '建立簽核版本')
    if (blocked) return blocked
    if (!isUuid(requestId)) return badRequestId()
    const checked = checkInput(input)
    if (!checked.ok) return checked
    const { content, attachments } = checked
    const entryId = input.showcaseEntryId ? String(input.showcaseEntryId) : null
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const contentChecksum = sha256(content)
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await lockGroup(tx, input.groupId)
      if (!locked) return groupNotFound()
      const { cohort, group } = locked
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'signoff.version_create',
          requestId,
          fingerprint: sha256(
            canonicalJson({ groupId: group.id, purpose: input.purpose, contentChecksum, attachments: [...attachments].sort(), entryId }),
          ),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<CreateVersionReceipt>(begun)
      if (cohort.status === 'archived') return err('COHORT_ARCHIVED', `${cohort.code} 已封存，簽核只能查看。`)
      if (group.status === 'dissolved') return err('GROUP_DISSOLVED', `${group.code} 已解散，不能再建立簽核版本。`)

      // 參與者＝此刻實際有效的組員＋主指導（組別列 FOR SHARE 期間不會有人改成員）。
      const participants = buildParticipants(await currentMembers(tx, group.id), await currentAdvisor(tx, group.id), group.code)
      if (!participants.ok) return participants

      // 簽核包：一組一用途一個，沒有就建；鎖住它配版本號、換目前版本。
      await tx.query(
        `insert into signoff_packages (id, group_id, cohort_id, purpose, created_at, created_by_user_id, updated_at, updated_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $5, $6)
         on conflict (group_id, purpose) do nothing`,
        [uuidv7(), group.id, cohort.id, input.purpose, realAt, adminId],
      )
      const pkg = (
        await tx.query<PackageRow>(
          'select id, cohort_id, current_version_id from signoff_packages where group_id = $1 and purpose = $2 for update',
          [group.id, input.purpose],
        )
      ).rows[0]!
      const previous = pkg.current_version_id
        ? (
            await tx.query<StatusRow>(
              `select s.version_id, v.version_no, s.state, s.cause
                 from signoff_version_status s join signoff_package_versions v on v.id = s.version_id
                where s.version_id = $1 for update of s`,
              [pkg.current_version_id],
            )
          ).rows[0]!
        : null

      const versionId = uuidv7()
      const versionRef = { refType: 'signoff_version' as const, refId: versionId }

      // 最終文件授權：從這一組的精選草稿「此刻」的內容凍結授權範圍，海報一起綁到版本上。
      let scope: AuthorizationScope | null = null
      if (entryId) {
        const draft = await lockDraft(tx, entryId, group.id)
        if (!draft) {
          return err('VALIDATION_FAILED', `找不到 ${group.code} 的這份精選草稿；請先到「精選」替這一組建立草稿。`, {
            details: { field: 'showcaseEntryId' },
          })
        }
        const frozen = freezeAuthorizationScope(draft, sha256(canonicalJson(scopeContent(draft))), group.code)
        if (!frozen.ok) return frozen
        scope = frozen.value
        if (draft.poster) {
          const held = await this.#files.attach(tx, draft.poster.fileId, versionRef, {
            purpose: 'poster',
            heldBy: { refType: 'showcase_draft', refId: draft.entryId },
          })
          if (!held.ok) return held
        }
      }

      // 附件：只能是這一組正式送出過的繳交檔案；綁的是那一刻的檔案版本與 checksum。
      const attachmentVersions: AttachmentVersion[] = []
      for (const fileId of attachments) {
        const source = await submittedFileOf(tx, fileId, group.id)
        if (!source) {
          return err('FILE_NOT_OWNED', `有一個附件不是 ${group.code} 正式送出的繳交檔案，請重新整理頁面再選。`, {
            details: { field: 'attachments' },
          })
        }
        const held = await this.#files.attach(tx, fileId, versionRef, {
          purpose: 'submission',
          heldBy: { refType: 'submission_version', refId: source.submissionVersionId },
        })
        if (!held.ok) return held
        attachmentVersions.push({
          fileId,
          checksum: held.receipt.checksum,
          name: source.name,
          source: { itemTitle: source.itemTitle, versionNo: source.versionNo },
        })
      }

      const versionNo = await nextVersionNo(tx, pkg.id)
      const supersedeCause = causeForNewVersion(previous)
      await insertVersion(tx, {
        versionId,
        packageId: pkg.id,
        versionNo,
        content,
        contentChecksum,
        attachments: attachmentVersions,
        participants: participants.value,
        supersedeCause,
        scope,
        adminId,
        realAt,
        businessAt: businessNow,
      })

      // 同組同用途原本的目前版本：還沒失效或作廢就讓它失效（舊同意留歷史、不計入新版）。
      let supersededVersionNo: number | null = null
      if (previous && !isTerminal(previous.state)) {
        await markSuperseded(tx, previous.version_id, 'content_change', adminId, realAt)
        supersededVersionNo = previous.version_no
        // 舊版自己的操作歷程也留一筆（匯出的「操作歷程」依版本 ID 讀稽核，票 26）。
        await this.#audit.append(tx, {
          actorKind: 'user',
          actorUserId: adminId,
          role: 'admin',
          action: 'signoff.version_supersede',
          targetType: 'signoff_version',
          targetId: previous.version_id,
          scope: 'cohort',
          cohortId: cohort.id,
          realAt,
          businessAt: businessNow,
          payload: { groupId: group.id, purpose: input.purpose, versionNo: previous.version_no, from: previous.state, cause: 'content_change', replacedBy: versionId },
        })
        await this.#events.publish(tx, {
          type: 'signoff.superseded',
          scope: 'cohort',
          cohortId: cohort.id,
          source: { type: 'signoff_version', id: previous.version_id, version: previous.version_no },
          actor: { kind: 'user', userId: adminId },
          // 系辦自己建新版造成的失效：留事件、不通知（見事件目錄 `signoff.superseded`）。
          recipients: [],
          recipientBasis: { basis: 'admin_own_action' },
          payload: { groupId: group.id, code: group.code, purpose: input.purpose, cause: 'content_change', replacedBy: versionId },
          occurredRealAt: realAt,
          occurredBusinessAt: businessNow,
        })
      }
      await tx.query(
        `update signoff_packages set current_version_id = $2, revision = revision + 1, updated_at = $3, updated_by_user_id = $4 where id = $1`,
        [pkg.id, versionId, realAt, adminId],
      )

      // 輪到本人同意：只發給參與學生（老師要等全員同意，管理員不收）。
      await this.#publishVersionCreated(tx, {
        cohortId: cohort.id,
        group,
        purpose: input.purpose,
        versionId,
        versionNo,
        participants: participants.value,
        adminId,
        realAt,
        businessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'signoff.version_create',
        targetType: 'signoff_version',
        targetId: versionId,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: {
          groupId: group.id,
          purpose: input.purpose,
          versionNo,
          contentChecksum,
          attachmentFileIds: attachments,
          studentUserIds: participants.value.students.map((s) => s.userId),
          advisorUserId: participants.value.advisor.userId,
          supersedeCause,
          supersededVersionId: supersededVersionNo !== null ? previous!.version_id : null,
          scopeSource: scope?.scopeSource ?? null,
        },
      })

      const receipt = {
        packageId: pkg.id,
        versionId,
        versionNo,
        groupCode: group.code,
        purpose: input.purpose,
        studentCount: participants.value.students.length,
        advisorName: participants.value.advisor.displayName,
        supersededVersionNo,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { packageId: pkg.id, versionId } })
      return { ok: true as const, receipt }
    })
  }

  /**
   * 組員或主指導改變 → 該組每個簽核包目前那一版失效（見 port 說明）。**跑在呼叫端的交易裡**：
   * 呼叫端已經拿著 `groups FOR UPDATE`，這裡再鎖簽核包與狀態列（鎖序 groups → signoff_packages → signoff_version_status，
   * 和建版一致）。不自動建新版。
   */
  async supersedeForParticipantChange(
    tx: PoolClient,
    input: { groupId: string; cause: 'member_change' | 'advisor_change'; actorUserId: string; realAt: Date; businessAt: Date },
  ): Promise<{ supersededVersionIds: string[] }> {
    const rows = await tx.query<StatusRow & { package_id: string; cohort_id: string; purpose: SignoffPurpose; code: string }>(
      `select p.id as package_id, p.cohort_id, p.purpose, g.code, s.version_id, v.version_no, s.state, s.cause
         from signoff_packages p
         join groups g on g.id = p.group_id
         join signoff_version_status s on s.version_id = p.current_version_id
         join signoff_package_versions v on v.id = s.version_id
        where p.group_id = $1
        order by p.purpose
        for update of p, s`,
      [input.groupId],
    )
    const superseded: string[] = []
    const live = rows.rows.filter((row) => !isTerminal(row.state))
    const admins = live.length > 0 ? await activeAdminIds(tx) : []
    for (const row of live) {
      await markSuperseded(tx, row.version_id, input.cause, input.actorUserId, input.realAt)
      superseded.push(row.version_id)
      await this.#events.publish(tx, {
        type: 'signoff.superseded',
        scope: 'cohort',
        cohortId: row.cohort_id,
        source: { type: 'signoff_version', id: row.version_id, version: row.version_no },
        actor: { kind: 'user', userId: input.actorUserId },
        // 只通知系辦（Roy 2026-09-25）：發生當下所有有效的管理員；學生與老師在舊頁看得到失效原因。
        recipients: admins,
        recipientBasis: { basis: 'active_admins', rule: 'signoff_superseded_admin_only' },
        payload: {
          title: `${row.code}「${PURPOSE_LABEL[row.purpose]}」v${row.version_no} 因${CAUSE_LABEL[input.cause]}已失效，請建立新版`,
          groupId: input.groupId,
          code: row.code,
          purpose: row.purpose,
          cause: input.cause,
        },
        occurredRealAt: input.realAt,
        occurredBusinessAt: input.businessAt,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: input.actorUserId,
        role: 'admin',
        action: 'signoff.version_supersede',
        targetType: 'signoff_version',
        targetId: row.version_id,
        scope: 'cohort',
        cohortId: row.cohort_id,
        realAt: input.realAt,
        businessAt: input.businessAt,
        payload: { groupId: input.groupId, purpose: row.purpose, versionNo: row.version_no, from: row.state, cause: input.cause },
      })
    }
    return { supersededVersionIds: superseded }
  }

  // ── 票 26：本人表態 ─────────────────────────────────────────────────────────

  /**
   * 本人表態（S11-05／06；模組 07 §6 approve）。**投的永遠是 actor 本人那一票**：輸入沒有「替誰」，
   * 角色看這一版的參與者快照，登入方式讀 actor 上的 session 事實（resolver 從同一個 session 讀出）。
   *
   * 鎖序和建版一致：`cohorts FOR SHARE` → `groups FOR SHARE` → `signoff_packages FOR UPDATE` → `signoff_version_status FOR UPDATE`。
   * - 組別列 FOR SHARE 和成員異動（FOR UPDATE）、改主指導（FOR NO KEY UPDATE）互斥：表態與參與者變更只會一先一後，
   *   先表態的那一票記在舊版、隨後舊版失效；先變更的，表態看到已失效 → `VERSION_SUPERSEDED`。不會有「失效的版本多一票」。
   * - 狀態列 FOR UPDATE 讓同一版的表態排隊：最後兩位學生同時按，只有後到的那一筆會把版本轉成等老師（只發一次 teacher_turn）。
   */
  async respond(actor: ResolvedActor, input: RespondInput, requestId: string): Promise<Result<RespondReceipt>> {
    const blocked = statusGate(actor, 'business')
    if (blocked) return err(blocked, '請先登入並完成帳號設定。')
    if (actor.kind !== 'authenticated') return err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.versionId)) return denied()
    if (input.decision !== 'agree' && input.decision !== 'reject') {
      return err('VALIDATION_FAILED', '請選「同意」或「不同意」。', { details: { field: 'decision' } })
    }
    const loginMethod = actor.loginMethod
    if (!loginMethod) return err('UNAUTHENTICATED', '讀不到這次登入的方式，請重新登入後再表態。')
    const reason = normalizeReason(input.reason, input.decision === 'reject', input.decision === 'reject' ? '不同意或退回' : '同意')
    if (!reason.ok) return reason
    const checksum = String(input.contentChecksum ?? '')
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await lockVersion(tx, input.versionId)
      if (!locked) return denied()
      const { cohort, group, pkg, version, status } = locked
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: actor.userId,
          operationKind: 'signoff.respond',
          requestId,
          fingerprint: sha256(canonicalJson({ versionId: version.id, checksum, decision: input.decision, reason: reason.reason })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<RespondReceipt>(begun)

      const participants = readParticipants(version.participants)
      const role = participants ? roleIn(participants, actor.userId) : null
      // 管理員不是參與者：明確說「系辦不能代簽」，而不是只說不是參與者（SGN-08）。
      if (role === null && actor.roles.includes('admin')) {
        return err('FORBIDDEN', '系辦不能替任何人表態；每個人只能替自己同意。')
      }
      if (cohort.status === 'archived') return err('COHORT_ARCHIVED', `${cohort.code} 已封存，簽核只能查看。`)
      if (group.status === 'dissolved') return err('GROUP_DISSOLVED', `${group.code} 已解散，不能再表態。`)
      const refused = checkVote({
        isCurrent: pkg.current_version_id === version.id,
        state: status.state,
        cause: status.cause,
        checksumMatches: checksum === version.content_checksum,
        role,
        stillEligible: role !== null && (await stillEligible(tx, group.id, actor.userId, role)),
        alreadyVoted: await hasVoted(tx, version.id, actor.userId),
      })
      if (refused) return refused
      const voter = role!
      const result = resultFor(voter, input.decision)
      const source = { type: 'signoff_version', id: version.id, version: version.version_no }
      const actorRef = { kind: 'user' as const, userId: actor.userId }

      // 每一票一個固定事件 ID（`approvals.event_id`）；表態本身不通知人。
      const { eventId } = await this.#events.publish(tx, {
        type: 'signoff.vote_recorded',
        scope: 'cohort',
        cohortId: cohort.id,
        source,
        actor: actorRef,
        recipients: [],
        recipientBasis: { basis: 'none' },
        payload: { groupId: group.id, code: group.code, purpose: pkg.purpose, versionNo: version.version_no, role: voter, result },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      const identity = await identityAt(tx, actor.userId, cohort.id)
      const approvalId = uuidv7()
      await tx.query(
        `insert into approvals
           (id, version_id, user_id, role, display_name_at, student_no_at, result, reason, login_method, button_text,
            event_id, request_id, real_at, business_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          approvalId,
          version.id,
          actor.userId,
          voter,
          identity.name,
          voter === 'student' ? identity.studentNo : null,
          result,
          reason.reason,
          loginMethod,
          BUTTON_TEXT[voter][input.decision],
          eventId,
          requestId,
          realAt,
          businessNow,
        ],
      )

      const agreed = Number(
        (
          await tx.query<{ n: number }>(
            `select count(*) as n from approvals where version_id = $1 and role = 'student' and result = 'agree'`,
            [version.id],
          )
        ).rows[0]!.n,
      )
      const total = participants!.students.length
      const next = nextStateAfterVote(voter, result, { studentsTotal: total, studentsAgreedIncludingThis: agreed })
      if (next) {
        await tx.query(
          `update signoff_version_status
              set state = $2, cause = $3, completed_real_at = $4, revision = revision + 1, updated_at = $5, updated_by_user_id = $6
            where version_id = $1`,
          [version.id, next, next === 'revision' ? reason.reason : null, next === 'complete' ? realAt : null, realAt, actor.userId],
        )
        const label = `${group.code}「${PURPOSE_LABEL[pkg.purpose]}」v${version.version_no}`
        const common = { scope: 'cohort' as const, cohortId: cohort.id, source, actor: actorRef, occurredRealAt: realAt, occurredBusinessAt: businessNow }
        if (next === 'teacher_pending') {
          await this.#events.publish(tx, {
            ...common,
            type: 'signoff.teacher_turn',
            recipients: [participants!.advisor.userId],
            recipientBasis: { basis: 'signoff_snapshot_advisor', versionId: version.id },
            payload: { title: `${label}：${total} 位學生都已同意，輪到你閱讀並同意`, groupId: group.id, code: group.code, purpose: pkg.purpose },
          })
        } else if (next === 'complete') {
          // 完成當下仍有效的參與成員＋主指導，每人一則（產品 08 §4）。
          const members = await currentMembers(tx, group.id)
          const stillIn = participants!.students.filter((s) => members.some((m) => m.userId === s.userId)).map((s) => s.userId)
          await this.#events.publish(tx, {
            ...common,
            type: 'signoff.completed',
            recipients: [...stillIn, participants!.advisor.userId],
            recipientBasis: { basis: 'signoff_participants_effective_at_completion', versionId: version.id },
            payload: {
              title: `${label} 此版本站內簽核已完成（站內同意紀錄，不代表校方採認）`,
              groupId: group.id,
              code: group.code,
              purpose: pkg.purpose,
              versionNo: version.version_no,
            },
          })
        } else {
          const admins = await activeAdminIds(tx)
          await this.#events.publish(tx, {
            ...common,
            type: 'signoff.returned',
            recipients: voter === 'student' ? [...admins, participants!.advisor.userId] : admins,
            recipientBasis: { basis: voter === 'student' ? 'active_admins+snapshot_advisor' : 'active_admins', versionId: version.id },
            payload: {
              title: `${label} 被${voter === 'student' ? '學生不同意' : '指導老師退回'}，回到修正中`,
              groupId: group.id,
              code: group.code,
              purpose: pkg.purpose,
            },
          })
        }
      }
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: actor.userId,
        role: voter === 'student' ? 'student' : 'teacher',
        action: 'signoff.respond',
        targetType: 'signoff_version',
        targetId: version.id,
        scope: 'cohort',
        cohortId: cohort.id,
        reason: reason.reason,
        realAt,
        businessAt: businessNow,
        payload: { approvalId, eventId, result, loginMethod, from: status.state, to: next ?? status.state, versionNo: version.version_no },
      })

      const receipt = {
        versionId: version.id,
        versionNo: version.version_no,
        groupCode: group.code,
        purpose: pkg.purpose,
        role: voter,
        result,
        state: next ?? status.state,
        agreed,
        total,
        approvalId,
        realAt: realAt.toISOString(),
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { versionId: version.id, approvalId } })
      return { ok: true as const, receipt }
    })
  }

  // ── 票 26：重置、重開、作廢、提醒 ─────────────────────────────────────────

  reset(actor: ResolvedActor, input: ReasonedVersionInput, requestId: string): Promise<Result<RestartReceipt>> {
    return this.#restart('reset', actor, input, requestId)
  }

  reopen(actor: ResolvedActor, input: ReasonedVersionInput, requestId: string): Promise<Result<RestartReceipt>> {
    return this.#restart('reopen', actor, input, requestId)
  }

  /**
   * 重置／重開（S11-07、S11-12；Roy 2026-09-25：重開＝建新版本）：以目前這一版的全文、附件、授權範圍建新版，
   * 參與者依**此刻**的有效組員與主指導重新快照，新版 collecting、目前版本換過去、每位參與學生收到「輪到你同意」。
   * 舊版：收集中、等老師、退回 → 已失效（系辦重置）；已完成的保留為歷史完成紀錄；已失效、已作廢的不動。舊同意全部保留、不計入新版。
   * 附件與凍結的海報由舊版持有的引用轉綁到新版（草稿之後換了圖也一樣，新版綁的是同一個檔案版本）。
   */
  async #restart(kind: RestartKind, actor: ResolvedActor, input: ReasonedVersionInput, requestId: string): Promise<Result<RestartReceipt>> {
    const what = RESTART_LABEL[kind]
    const blocked = authorizeAdmin(actor, `${what}簽核`)
    if (blocked) return blocked
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.versionId)) return versionNotFound()
    const reason = normalizeReason(input.reason, true, what)
    if (!reason.ok) return reason
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await lockVersion(tx, input.versionId)
      if (!locked) return versionNotFound()
      const { cohort, group, pkg, version, status } = locked
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: `signoff.${kind}`,
          requestId,
          fingerprint: sha256(canonicalJson({ versionId: version.id, reason: reason.reason })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<RestartReceipt>(begun)
      if (cohort.status === 'archived') return err('COHORT_ARCHIVED', `${cohort.code} 已封存，簽核只能查看。`)
      if (group.status === 'dissolved') return err('GROUP_DISSOLVED', `${group.code} 已解散，不能再建立簽核版本。`)
      if (pkg.current_version_id !== version.id) return err('CONFLICT', '這一版已經不是目前的版本，請重新整理頁面。')
      if (restartKindFor(status.state) !== kind) {
        return err(
          'CONFLICT',
          kind === 'reset' ? '這一版已退回、失效或作廢，請改按「重開新版」。' : '這一版還在收集同意或已完成，請改按「重置」。',
        )
      }

      const participants = buildParticipants(await currentMembers(tx, group.id), await currentAdvisor(tx, group.id), group.code)
      if (!participants.ok) return participants
      const newVersionId = uuidv7()
      const newRef = { refType: 'signoff_version' as const, refId: newVersionId }
      const heldBy = { refType: 'signoff_version' as const, refId: version.id }
      const attachments = Array.isArray(version.attachment_file_versions) ? (version.attachment_file_versions as AttachmentVersion[]) : []
      for (const a of attachments) {
        const held = await this.#files.attach(tx, a.fileId, newRef, { purpose: 'submission', heldBy })
        if (!held.ok) return held
      }
      const scope = readAuthorizationScope(version.authorization_scope)
      for (const asset of scope?.assets ?? []) {
        const held = await this.#files.attach(tx, asset.fileId, newRef, { purpose: 'poster', heldBy })
        if (!held.ok) return held
      }

      const versionNo = await nextVersionNo(tx, pkg.id)
      const supersedeCause = kind === 'reset' ? 'reset' : causeForRestart(status)
      await insertVersion(tx, {
        versionId: newVersionId,
        packageId: pkg.id,
        versionNo,
        content: version.content_text,
        contentChecksum: version.content_checksum,
        attachments,
        participants: participants.value,
        supersedeCause,
        scope,
        adminId,
        realAt,
        businessAt: businessNow,
      })
      const oldSuperseded = supersedesOnRestart(status.state)
      if (oldSuperseded) await markSuperseded(tx, version.id, 'reset', adminId, realAt)
      await tx.query(
        `update signoff_packages set current_version_id = $2, revision = revision + 1, updated_at = $3, updated_by_user_id = $4 where id = $1`,
        [pkg.id, newVersionId, realAt, adminId],
      )
      const source = { type: 'signoff_version', id: version.id, version: version.version_no }
      const { eventId } = await this.#events.publish(tx, {
        type: 'signoff.restarted',
        scope: 'cohort',
        cohortId: cohort.id,
        source,
        actor: { kind: 'user', userId: adminId },
        recipients: [],
        recipientBasis: { basis: 'none' },
        payload: { kind, groupId: group.id, code: group.code, purpose: pkg.purpose, from: status.state, replacedBy: newVersionId },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      if (oldSuperseded) {
        // 系辦自己的動作造成的失效：留事件、不通知（見事件目錄 `signoff.superseded`）。
        await this.#events.publish(tx, {
          type: 'signoff.superseded',
          scope: 'cohort',
          cohortId: cohort.id,
          source,
          actor: { kind: 'user', userId: adminId },
          recipients: [],
          recipientBasis: { basis: 'admin_own_action' },
          payload: { groupId: group.id, code: group.code, purpose: pkg.purpose, cause: 'reset', replacedBy: newVersionId },
          occurredRealAt: realAt,
          occurredBusinessAt: businessNow,
        })
      }
      await this.#publishVersionCreated(tx, {
        cohortId: cohort.id,
        group,
        purpose: pkg.purpose,
        versionId: newVersionId,
        versionNo,
        participants: participants.value,
        adminId,
        realAt,
        businessAt: businessNow,
      })
      const auditBase = { actorKind: 'user' as const, actorUserId: adminId, role: 'admin' as const, scope: 'cohort' as const, cohortId: cohort.id, realAt, businessAt: businessNow }
      await this.#audit.append(tx, {
        ...auditBase,
        action: kind === 'reset' ? 'signoff.version_reset' : 'signoff.version_reopen',
        targetType: 'signoff_version',
        targetId: version.id,
        reason: reason.reason,
        payload: { eventId, from: status.state, oldSuperseded, newVersionId, newVersionNo: versionNo, groupId: group.id, purpose: pkg.purpose },
      })
      await this.#audit.append(tx, {
        ...auditBase,
        action: 'signoff.version_create',
        targetType: 'signoff_version',
        targetId: newVersionId,
        reason: reason.reason,
        payload: {
          groupId: group.id,
          purpose: pkg.purpose,
          versionNo,
          contentChecksum: version.content_checksum,
          attachmentFileIds: attachments.map((a) => a.fileId),
          studentUserIds: participants.value.students.map((s) => s.userId),
          advisorUserId: participants.value.advisor.userId,
          supersedeCause,
          fromVersionId: version.id,
          restart: kind,
        },
      })

      const receipt = {
        packageId: pkg.id,
        versionId: newVersionId,
        versionNo,
        groupCode: group.code,
        purpose: pkg.purpose,
        studentCount: participants.value.students.length,
        advisorName: participants.value.advisor.displayName,
        supersededVersionNo: oldSuperseded ? version.version_no : null,
        kind,
        fromVersionNo: version.version_no,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { packageId: pkg.id, versionId: newVersionId } })
      return { ok: true as const, receipt }
    })
  }

  /** 作廢目前這一版（S11-07）：理由必填；之後誰都不能再表態。已完成的作廢等於撤回這份授權。 */
  async voidVersion(actor: ResolvedActor, input: ReasonedVersionInput, requestId: string): Promise<Result<VoidReceipt>> {
    const blocked = authorizeAdmin(actor, '作廢簽核')
    if (blocked) return blocked
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.versionId)) return versionNotFound()
    const reason = normalizeReason(input.reason, true, '作廢')
    if (!reason.ok) return reason
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await lockVersion(tx, input.versionId)
      if (!locked) return versionNotFound()
      const { cohort, group, pkg, version, status } = locked
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'signoff.void',
          requestId,
          fingerprint: sha256(canonicalJson({ versionId: version.id, reason: reason.reason })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<VoidReceipt>(begun)
      if (cohort.status === 'archived') return err('COHORT_ARCHIVED', `${cohort.code} 已封存，簽核只能查看。`)
      if (pkg.current_version_id !== version.id) return err('CONFLICT', '這一版已經不是目前的版本，請重新整理頁面。')
      const refused = checkVoid(status.state)
      if (refused) return refused
      await tx.query(
        `update signoff_version_status
            set state = 'void', cause = $2, revision = revision + 1, updated_at = $3, updated_by_user_id = $4
          where version_id = $1`,
        [version.id, reason.reason, realAt, adminId],
      )
      const { eventId } = await this.#events.publish(tx, {
        type: 'signoff.voided',
        scope: 'cohort',
        cohortId: cohort.id,
        source: { type: 'signoff_version', id: version.id, version: version.version_no },
        actor: { kind: 'user', userId: adminId },
        recipients: [],
        recipientBasis: { basis: 'none' },
        payload: { groupId: group.id, code: group.code, purpose: pkg.purpose, from: status.state },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'signoff.version_void',
        targetType: 'signoff_version',
        targetId: version.id,
        scope: 'cohort',
        cohortId: cohort.id,
        reason: reason.reason,
        realAt,
        businessAt: businessNow,
        payload: { eventId, from: status.state, groupId: group.id, purpose: pkg.purpose, versionNo: version.version_no },
      })
      const receipt = {
        versionId: version.id,
        versionNo: version.version_no,
        groupCode: group.code,
        purpose: pkg.purpose,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { versionId: version.id } })
      return { ok: true as const, receipt }
    })
  }

  /**
   * 提醒還沒表態的參與者（S11-11）。同一版 24 小時內只能一次：以這一版最近一則 `signoff.reminded` 事件的真實時間判斷，
   * 在狀態列 FOR UPDATE 底下查，連按兩下也只會送出一次。
   */
  async remind(actor: ResolvedActor, input: { versionId: string }, requestId: string): Promise<Result<RemindReceipt>> {
    const blocked = authorizeAdmin(actor, '提醒未同意者')
    if (blocked) return blocked
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.versionId)) return versionNotFound()
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await lockVersion(tx, input.versionId)
      if (!locked) return versionNotFound()
      const { cohort, group, pkg, version, status } = locked
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'signoff.remind',
          requestId,
          fingerprint: sha256(canonicalJson({ versionId: version.id })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<RemindReceipt>(begun)
      if (cohort.status === 'archived') return err('COHORT_ARCHIVED', `${cohort.code} 已封存，簽核只能查看。`)
      if (pkg.current_version_id !== version.id || !remindable(status.state)) {
        return err('CONFLICT', '這一版不在收集同意中（已完成、退回、失效或作廢），不能提醒。')
      }
      const last = await lastRemindedAt(tx, version.id)
      const next = nextRemindAt(last, realAt)
      if (last && next) {
        return err('CONFLICT', `已於 ${formatTaipeiMinute(last)} 提醒過這一版；24 小時內不能再提醒（${formatTaipeiMinute(next)} 之後可以）。`)
      }
      const participants = readParticipants(version.participants)
      if (!participants) return versionNotFound()
      const progress = buildProgress(participants, await votesOf(tx, [version.id]), status.state)
      const recipients = remindRecipients(progress)
      if (recipients.length === 0) return err('CONFLICT', '這一版的參與者都已表態，不需要提醒。')
      const advisorIncluded = recipients.includes(participants.advisor.userId)
      const { eventId } = await this.#events.publish(tx, {
        type: 'signoff.reminded',
        scope: 'cohort',
        cohortId: cohort.id,
        source: { type: 'signoff_version', id: version.id, version: version.version_no },
        actor: { kind: 'user', userId: adminId },
        recipients,
        recipientBasis: { basis: 'signoff_participants_not_voted', versionId: version.id },
        payload: {
          title: `提醒：${group.code}「${PURPOSE_LABEL[pkg.purpose]}」v${version.version_no} 還等你閱讀並表態`,
          groupId: group.id,
          code: group.code,
          purpose: pkg.purpose,
        },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
      })
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'signoff.remind',
        targetType: 'signoff_version',
        targetId: version.id,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: { eventId, recipientUserIds: recipients, groupId: group.id, purpose: pkg.purpose, versionNo: version.version_no },
      })
      const receipt = {
        versionId: version.id,
        versionNo: version.version_no,
        groupCode: group.code,
        purpose: pkg.purpose,
        studentCount: recipients.length - (advisorIncluded ? 1 : 0),
        advisorIncluded,
        remindedAt: realAt.toISOString(),
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { versionId: version.id, eventId } })
      return { ok: true as const, receipt }
    })
  }

  // ── 票 26：匯出 ─────────────────────────────────────────────────────────────

  /**
   * 匯出某版本（S11-09）：可列印頁或 CSV 明細。每次匯出都把產生的檔存進檔案根目錄（`stored_files` purpose=export、
   * `file_references` ref_type=export）並留一筆不可變的 `signoff_exports`——不冪等，每按一次一列（附錄 A）。
   * 已失效、已作廢的版本也能匯出，狀態欄照實寫。
   */
  async exportVersion(
    actor: ResolvedActor,
    input: { versionId: string; format: SignoffExportFormat },
  ): Promise<Result<SignoffExportFile>> {
    const blocked = authorizeAdmin(actor, '匯出簽核紀錄')
    if (blocked) return blocked
    if (!isUuid(input.versionId)) return versionNotFound()
    if (input.format !== 'csv' && input.format !== 'printable') {
      return err('VALIDATION_FAILED', '匯出格式只有可列印頁與 CSV。', { details: { field: 'format' } })
    }
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const row = (await tx.query<VersionRow>(`${VERSION_SELECT} where v.id = $1`, [input.versionId])).rows[0]
      if (!row) return versionNotFound()
      const realAt = this.#realClock.now()
      const participants = readParticipants(row.participants)
      if (!participants) return versionNotFound()
      const data: SignoffExportData = {
        cohortCode: row.cohort_code,
        groupCode: row.group_code,
        purpose: row.purpose,
        versionId: row.version_id,
        versionNo: row.version_no,
        contentChecksum: row.content_checksum,
        contentHtml: renderBodyHtml(row.content_text),
        attachments: Array.isArray(row.attachment_file_versions) ? (row.attachment_file_versions as AttachmentVersion[]) : [],
        authorizationScope: readAuthorizationScope(row.authorization_scope),
        participants,
        state: row.state,
        cause: row.cause,
        isCurrent: row.current_version_id === row.version_id,
        votes: await exportVotes(tx, row.version_id),
        lifecycle: await exportLifecycle(tx, row.version_id),
        exportedAt: realAt,
        exportedByName: (await identityAt(tx, adminId, null)).name,
      }
      const csv = input.format === 'csv'
      const body = csv ? buildSignoffCsv(data) : buildSignoffPrintable(data)
      const exportId = uuidv7()
      const fileName = `${row.cohort_code}-${row.group_code}-${PURPOSE_LABEL[row.purpose]}-v${row.version_no}-簽核紀錄.${csv ? 'csv' : 'html'}`
      const mime = csv ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8'
      const stored = await this.#files.storeGenerated(tx, {
        ownerUserId: adminId,
        purpose: 'export',
        scope: { kind: 'cohort', cohortId: row.cohort_id },
        fileName,
        mime: csv ? 'text/csv' : 'text/html',
        bytes: new TextEncoder().encode(body),
        ref: { refType: 'export', refId: exportId },
      })
      await tx.query(
        `insert into signoff_exports (id, version_id, format, file_id, exported_by_user_id, real_at) values ($1, $2, $3, $4, $5, $6)`,
        [exportId, row.version_id, input.format, stored.fileId, adminId, realAt],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'signoff.export',
        targetType: 'signoff_version',
        targetId: row.version_id,
        scope: 'cohort',
        cohortId: row.cohort_id,
        realAt,
        businessAt: businessNow,
        payload: { exportId, format: input.format, fileId: stored.fileId, checksum: stored.checksum, votes: data.votes.length },
      })
      return ok({ exportId, fileName, mime, body }, { requestId: uuidv7(), serverTime: realAt.toISOString() })
    })
  }

  /** 輪到本人同意：只發給參與學生（老師要等全員同意，管理員不收）。建版、重置、重開共用。 */
  async #publishVersionCreated(
    tx: PoolClient,
    v: {
      cohortId: string
      group: GroupRow
      purpose: SignoffPurpose
      versionId: string
      versionNo: number
      participants: Participants
      adminId: string
      realAt: Date
      businessAt: Date
    },
  ): Promise<void> {
    await this.#events.publish(tx, {
      type: 'signoff.version_created',
      scope: 'cohort',
      cohortId: v.cohortId,
      source: { type: 'signoff_version', id: v.versionId, version: v.versionNo },
      actor: { kind: 'user', userId: v.adminId },
      recipients: v.participants.students.map((s) => s.userId),
      recipientBasis: { basis: 'signoff_participants', versionId: v.versionId, groupId: v.group.id },
      payload: {
        title: `${v.group.code}「${PURPOSE_LABEL[v.purpose]}」v${v.versionNo} 輪到你閱讀並同意`,
        groupId: v.group.id,
        code: v.group.code,
        purpose: v.purpose,
        versionNo: v.versionNo,
      },
      occurredRealAt: v.realAt,
      occurredBusinessAt: v.businessAt,
    })
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'signoff', body)
  }
}

async function markSuperseded(tx: PoolClient, versionId: string, cause: SupersedeCause, actorUserId: string, realAt: Date) {
  await tx.query(
    `update signoff_version_status
        set state = 'superseded', cause = $2, revision = revision + 1, updated_at = $3, updated_by_user_id = $4
      where version_id = $1`,
    [versionId, cause, realAt, actorUserId],
  )
}

function versionNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個簽核版本，請重新整理頁面。', { details: { field: 'versionId' } })
}

type LockedVersion = {
  cohort: CohortRow
  group: GroupRow
  pkg: { id: string; purpose: SignoffPurpose; current_version_id: string | null }
  version: {
    id: string
    version_no: number
    content_text: string
    content_checksum: string
    attachment_file_versions: unknown
    participants: unknown
    authorization_scope: unknown
  }
  status: { state: SignoffState; cause: string | null }
}

/**
 * 鎖住一個版本要動它時需要的每一列（鎖序和建版一致）：`cohorts FOR SHARE` → `groups FOR SHARE` →
 * `signoff_packages FOR UPDATE` → `signoff_version_status FOR UPDATE`。版本內容列不可變，不用鎖。
 */
async function lockVersion(tx: PoolClient, versionId: string): Promise<LockedVersion | null> {
  const owner = await tx.query<{ group_id: string; package_id: string }>(
    `select p.group_id, p.id as package_id from signoff_package_versions v join signoff_packages p on p.id = v.package_id where v.id = $1`,
    [versionId],
  )
  const found = owner.rows[0]
  if (!found) return null
  const locked = await lockGroup(tx, found.group_id)
  if (!locked) return null
  const pkg = (
    await tx.query<LockedVersion['pkg']>('select id, purpose, current_version_id from signoff_packages where id = $1 for update', [
      found.package_id,
    ])
  ).rows[0]
  const version = (
    await tx.query<LockedVersion['version']>(
      `select id, version_no, content_text, content_checksum, attachment_file_versions, participants, authorization_scope
         from signoff_package_versions where id = $1`,
      [versionId],
    )
  ).rows[0]
  const status = (
    await tx.query<LockedVersion['status']>('select state, cause from signoff_version_status where version_id = $1 for update', [versionId])
  ).rows[0]
  if (!pkg || !version || !status) return null
  return { ...locked, pkg, version, status }
}

/** 此刻還有沒有資格表態：學生要仍是這一組的有效組員，老師要仍是這一組目前的主指導（換掉的老師失權，SGN-09）。 */
async function stillEligible(db: Queryable, groupId: string, userId: string, role: VoteRole): Promise<boolean> {
  const sql =
    role === 'student'
      ? 'select 1 from group_memberships where group_id = $1 and user_id = $2 and valid_to is null'
      : 'select 1 from advisor_assignments where group_id = $1 and teacher_user_id = $2 and valid_to is null'
  return ((await db.query(sql, [groupId, userId])).rowCount ?? 0) > 0
}

async function hasVoted(db: Queryable, versionId: string, userId: string): Promise<boolean> {
  return ((await db.query('select 1 from approvals where version_id = $1 and user_id = $2', [versionId, userId])).rowCount ?? 0) > 0
}

/** 當時的姓名與學號（表態、匯出的「當時姓名學號」；老師沒有學號）。 */
async function identityAt(db: Queryable, userId: string, cohortId: string | null): Promise<{ name: string; studentNo: string | null }> {
  const row = (
    await db.query<{ name: string; student_no: string | null }>(
      `select coalesce(nullif(btrim(p.display_name), ''), u.name) as name,
              (select si.student_no from student_identities si where si.user_id = u.id and si.cohort_id = $2) as student_no
         from users u left join user_profiles p on p.user_id = u.id
        where u.id = $1`,
      [userId, cohortId],
    )
  ).rows[0]
  return { name: row?.name ?? '（未知）', studentNo: row?.student_no ?? null }
}

/** 一批版本的表態（進度用）。 */
async function votesOf(db: Queryable, versionIds: readonly string[]): Promise<(VoteRecord & { versionId: string })[]> {
  if (versionIds.length === 0) return []
  const rows = await db.query<{ version_id: string; user_id: string; role: VoteRole; result: VoteResult; reason: string | null; real_at: Date }>(
    `select version_id, user_id, role, result, reason, real_at from approvals where version_id = any($1::uuid[]) order by real_at`,
    [versionIds],
  )
  return rows.rows.map((r) => ({ versionId: r.version_id, userId: r.user_id, role: r.role, result: r.result, reason: r.reason, realAt: r.real_at }))
}

/** 這一版最近一次提醒的真實時間（`signoff.reminded` 事件）。 */
async function lastRemindedAt(db: Queryable, versionId: string): Promise<Date | null> {
  const row = await db.query<{ at: Date | null }>(
    `select max(occurred_real_at) as at from domain_events where type = 'signoff.reminded' and source_type = 'signoff_version' and source_id = $1`,
    [versionId],
  )
  return row.rows[0]?.at ?? null
}

async function exportVotes(db: Queryable, versionId: string): Promise<ExportVote[]> {
  const rows = await db.query<{
    event_id: string
    user_id: string
    display_name_at: string
    student_no_at: string | null
    role: VoteRole
    login_method: 'google' | 'password'
    button_text: string
    result: VoteResult
    reason: string | null
    real_at: Date
    business_at: Date
  }>(
    `select event_id, user_id, display_name_at, student_no_at, role, login_method, button_text, result, reason, real_at, business_at
       from approvals where version_id = $1 order by real_at`,
    [versionId],
  )
  return rows.rows.map((r) => ({
    eventId: r.event_id,
    userId: r.user_id,
    displayNameAt: r.display_name_at,
    studentNoAt: r.student_no_at,
    role: r.role,
    loginMethod: r.login_method,
    buttonText: r.button_text,
    result: r.result,
    reason: r.reason,
    realAt: r.real_at,
    businessAt: r.business_at,
  }))
}

const LIFECYCLE_ACTIONS: Record<string, ExportLifecycle['action']> = {
  'signoff.version_create': 'created',
  'signoff.version_reset': 'reset',
  'signoff.version_reopen': 'reopened',
  'signoff.version_void': 'voided',
  'signoff.version_supersede': 'superseded',
}

/** 版本本身的操作歷程（建立、重置、重開、作廢、失效；來源是稽核紀錄，理由在那裡）。 */
async function exportLifecycle(db: Queryable, versionId: string): Promise<ExportLifecycle[]> {
  const rows = await db.query<{ action: string; actor_user_id: string | null; actor_name: string | null; reason: string | null; real_at: Date; business_at: Date; payload: { eventId?: string; cause?: string } }>(
    `select a.action, a.actor_user_id, coalesce(nullif(btrim(p.display_name), ''), u.name) as actor_name, a.reason, a.real_at, a.business_at, a.payload
       from audit_events a
       left join users u on u.id = a.actor_user_id
       left join user_profiles p on p.user_id = a.actor_user_id
      where a.target_type = 'signoff_version' and a.target_id = $1 and a.action = any($2::text[])
      order by a.real_at`,
    [versionId, Object.keys(LIFECYCLE_ACTIONS)],
  )
  return rows.rows.map((r) => ({
    eventId: typeof r.payload?.eventId === 'string' ? r.payload.eventId : null,
    action: LIFECYCLE_ACTIONS[r.action]!,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name ?? '系統',
    reason: r.reason ?? (r.payload?.cause ? (CAUSE_LABEL as Record<string, string>)[r.payload.cause] ?? null : null),
    realAt: r.real_at,
    businessAt: r.business_at,
  }))
}

/** 同一個簽核包的下一個版本號（呼叫前已鎖住簽核包列）。 */
async function nextVersionNo(tx: PoolClient, packageId: string): Promise<number> {
  const row = await tx.query<{ n: number }>('select coalesce(max(version_no), 0) + 1 as n from signoff_package_versions where package_id = $1', [
    packageId,
  ])
  return Number(row.rows[0]!.n)
}

/** 寫一版內容（不可變）＋它的狀態頭列（collecting）。 */
async function insertVersion(
  tx: PoolClient,
  v: {
    versionId: string
    packageId: string
    versionNo: number
    content: string
    contentChecksum: string
    attachments: readonly AttachmentVersion[]
    participants: Participants
    supersedeCause: SupersedeCause | null
    scope: AuthorizationScope | null
    adminId: string
    realAt: Date
    businessAt: Date
  },
): Promise<void> {
  await tx.query(
    `insert into signoff_package_versions
       (id, package_id, version_no, content_text, content_checksum, attachment_file_versions, participants, supersede_cause,
        authorization_scope, created_by_user_id, created_real_at, created_business_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, $11, $12)`,
    [
      v.versionId,
      v.packageId,
      v.versionNo,
      v.content,
      v.contentChecksum,
      JSON.stringify(v.attachments),
      JSON.stringify(v.participants),
      v.supersedeCause,
      v.scope ? JSON.stringify(v.scope) : null,
      v.adminId,
      v.realAt,
      v.businessAt,
    ],
  )
  await tx.query(
    `insert into signoff_version_status (version_id, state, created_at, updated_at, updated_by_user_id)
     values ($1, 'collecting', $2, $2, $3)`,
    [v.versionId, v.realAt, v.adminId],
  )
}

/** 鎖順序：屆別 FOR SHARE → 組別 FOR SHARE（見檔頭）。 */
async function lockGroup(tx: PoolClient, groupId: string): Promise<{ cohort: CohortRow; group: GroupRow } | null> {
  const owner = await tx.query<{ cohort_id: string }>('select cohort_id from groups where id = $1', [groupId])
  const cohortId = owner.rows[0]?.cohort_id
  if (!cohortId) return null
  const cohort = (await tx.query<CohortRow>('select id, code, status from cohorts where id = $1 for share', [cohortId])).rows[0]
  const group = (await tx.query<GroupRow>('select id, cohort_id, code, status from groups where id = $1 for share', [groupId])).rows[0]
  if (!cohort || !group) return null
  return { cohort, group }
}

type Queryable = Pick<PoolClient, 'query'>

/** 此刻的有效組員（當時姓名與學號）。 */
async function currentMembers(db: Queryable, groupId: string): Promise<StudentParticipant[]> {
  const rows = await db.query<{ membership_id: string; user_id: string; name: string; student_no: string | null }>(
    `select m.id as membership_id, m.user_id, coalesce(p.display_name, u.name) as name, si.student_no
       from group_memberships m
       join users u on u.id = m.user_id
       left join user_profiles p on p.user_id = m.user_id
       left join student_identities si on si.user_id = m.user_id and si.cohort_id = m.cohort_id
      where m.group_id = $1 and m.valid_to is null`,
    [groupId],
  )
  return rows.rows.map((r) => ({ userId: r.user_id, displayName: r.name, studentNo: r.student_no, membershipId: r.membership_id }))
}

/** 此刻的主指導。 */
async function currentAdvisor(db: Queryable, groupId: string): Promise<AdvisorParticipant | null> {
  const rows = await db.query<{ id: string; teacher_user_id: string; name: string }>(
    `select a.id, a.teacher_user_id, coalesce(p.display_name, u.name) as name
       from advisor_assignments a
       join users u on u.id = a.teacher_user_id
       left join user_profiles p on p.user_id = a.teacher_user_id
      where a.group_id = $1 and a.valid_to is null`,
    [groupId],
  )
  const r = rows.rows[0]
  return r ? { userId: r.teacher_user_id, displayName: r.name, assignmentId: r.id } : null
}

/** 精選草稿此刻的內容（`FOR SHARE`，見檔頭）；不是這一組的條目回 null。 */
async function lockDraft(tx: PoolClient, entryId: string, groupId: string): Promise<DraftSnapshot | null> {
  const rows = await tx.query<{
    entry_id: string
    revision: number
    title: string
    summary: string
    summary_checksum: string
    video_url: string | null
    poster_file_id: string | null
    poster_checksum: string | null
    poster_name: string | null
  }>(
    `select d.entry_id, d.revision, d.title, d.summary, d.summary_checksum, d.video_url, d.poster_file_id, d.poster_checksum,
            f.original_name as poster_name
       from showcase_entries e
       join showcase_drafts d on d.entry_id = e.id
       left join stored_files f on f.id = d.poster_file_id
      where e.id = $1 and e.group_id = $2
      for share of d`,
    [entryId, groupId],
  )
  const r = rows.rows[0]
  if (!r) return null
  return {
    entryId: r.entry_id,
    revision: r.revision,
    title: r.title,
    summary: r.summary,
    summaryChecksum: r.summary_checksum,
    videoUrl: r.video_url,
    poster:
      r.poster_file_id && r.poster_checksum
        ? { fileId: r.poster_file_id, checksum: r.poster_checksum, name: r.poster_name ?? '海報' }
        : null,
  }
}

/** 這個檔是不是這一組某次正式送出帶的檔案（取最新那一次）。 */
async function submittedFileOf(
  db: Queryable,
  fileId: string,
  groupId: string,
): Promise<{ submissionVersionId: string; name: string; itemTitle: string; versionNo: number } | null> {
  const rows = await db.query<{ submission_version_id: string; name: string; item_title: string; version_no: number }>(
    `select sf.submission_version_id, f.original_name as name, m.title as item_title, v.version_no
       from submission_files sf
       join submission_versions v on v.id = sf.submission_version_id
       join managed_items m on m.id = v.item_id
       join stored_files f on f.id = sf.file_id
      where sf.file_id = $1 and v.receiver_kind = 'group' and v.receiver_id = $2
      order by v.received_real_at desc
      limit 1`,
    [fileId, groupId],
  )
  const r = rows.rows[0]
  return r ? { submissionVersionId: r.submission_version_id, name: r.name, itemTitle: r.item_title, versionNo: r.version_no } : null
}

// ── 查詢 ────────────────────────────────────────────────────────────────────

type VersionRow = {
  version_id: string
  cohort_id: string
  status_updated_at: Date
  package_id: string
  version_no: number
  purpose: SignoffPurpose
  group_id: string
  group_code: string
  cohort_code: string
  content_text: string
  content_checksum: string
  attachment_file_versions: unknown
  participants: unknown
  authorization_scope: unknown
  supersede_cause: SupersedeCause | null
  state: SignoffState
  cause: string | null
  current_version_id: string | null
  created_real_at: Date
  created_by_name: string
}

const VERSION_SELECT = `
  select v.id as version_id, v.package_id, v.version_no, p.purpose, g.id as group_id, g.code as group_code, c.code as cohort_code,
         p.cohort_id, s.updated_at as status_updated_at,
         v.content_text, v.content_checksum, v.attachment_file_versions, v.participants, v.authorization_scope, v.supersede_cause,
         s.state, s.cause, p.current_version_id, v.created_real_at,
         coalesce(cp.display_name, cu.name) as created_by_name
    from signoff_package_versions v
    join signoff_packages p on p.id = v.package_id
    join signoff_version_status s on s.version_id = v.id
    join groups g on g.id = p.group_id
    join cohorts c on c.id = p.cohort_id
    join users cu on cu.id = v.created_by_user_id
    left join user_profiles cp on cp.user_id = v.created_by_user_id`

const NO_PARTICIPANTS: Participants = { students: [], advisor: { userId: '', displayName: '（無）', assignmentId: '' } }

type SummaryRow = {
  version_id: string
  version_no: number
  state: SignoffState
  cause: string | null
  participants: unknown
  created_real_at: Date
  status_updated_at: Date
}

/** 目前版本的摘要＋逐人進度（三個角色共用同一段，數字與缺誰一致，SGN-10）。 */
function summaryOf(r: SummaryRow, votes: readonly (VoteRecord & { versionId: string })[]): VersionSummary {
  const participants = readParticipants(r.participants) ?? NO_PARTICIPANTS
  const mine = votes.filter((v) => v.versionId === r.version_id)
  const times = [r.created_real_at, r.status_updated_at, ...mine.map((v) => v.realAt)].map((d) => new Date(d).getTime())
  return {
    versionId: r.version_id,
    versionNo: r.version_no,
    state: r.state,
    cause: r.cause,
    studentCount: participants.students.length,
    createdAt: r.created_real_at,
    progress: buildProgress(participants, mine, r.state),
    lastEventAt: new Date(Math.max(...times)),
  }
}

export class PgSignoffQuery implements SignoffQuery {
  readonly #pool: PoolSource

  constructor(deps: { pool?: PoolSource } = {}) {
    this.#pool = deps.pool ?? getPool
  }

  async #withClient<T>(body: (db: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool().connect()
    try {
      return await body(client)
    } finally {
      client.release()
    }
  }

  async adminBoard(actor: ResolvedActor, cohortId: string): Promise<Result<AdminSignoffBoard>> {
    const blocked = authorizeAdmin(actor, '管理簽核')
    if (blocked) return blocked
    if (!isUuid(cohortId)) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
    return this.#withClient(async (db) => {
      const cohort = (await db.query<CohortRow>('select id, code, status from cohorts where id = $1', [cohortId])).rows[0]
      if (!cohort) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
      const groups = (
        await db.query<{ id: string; code: string }>(`select id, code from groups where cohort_id = $1 and status = 'active' order by code`, [
          cohortId,
        ])
      ).rows
      const ids = groups.map((g) => g.id)
      const members = await db.query<{ group_id: string; name: string; student_no: string | null }>(
        `select m.group_id, coalesce(p.display_name, u.name) as name, si.student_no
           from group_memberships m
           join users u on u.id = m.user_id
           left join user_profiles p on p.user_id = m.user_id
           left join student_identities si on si.user_id = m.user_id and si.cohort_id = m.cohort_id
          where m.group_id = any($1::uuid[]) and m.valid_to is null
          order by si.student_no nulls last, name`,
        [ids],
      )
      const advisors = await db.query<{ group_id: string; name: string }>(
        `select a.group_id, coalesce(p.display_name, u.name) as name
           from advisor_assignments a join users u on u.id = a.teacher_user_id left join user_profiles p on p.user_id = a.teacher_user_id
          where a.group_id = any($1::uuid[]) and a.valid_to is null`,
        [ids],
      )
      const showcase = await db.query<{ group_id: string; entry_id: string; title: string; summary: string; revision: number }>(
        `select e.group_id, e.id as entry_id, d.title, d.summary, d.revision
           from showcase_entries e join showcase_drafts d on d.entry_id = e.id
          where e.group_id = any($1::uuid[])`,
        [ids],
      )
      const files = await db.query<{ group_id: string; file_id: string; name: string; item_title: string; version_no: number }>(
        `select distinct on (v.receiver_id, sf.file_id)
                v.receiver_id as group_id, sf.file_id, f.original_name as name, m.title as item_title, v.version_no
           from submission_files sf
           join submission_versions v on v.id = sf.submission_version_id
           join managed_items m on m.id = v.item_id
           join stored_files f on f.id = sf.file_id
          where v.receiver_kind = 'group' and v.receiver_id = any($1::uuid[]) and f.status = 'stored'
          order by v.receiver_id, sf.file_id, v.received_real_at desc`,
        [ids],
      )
      const packages = await db.query<SummaryRow & { group_id: string; purpose: SignoffPurpose }>(
        `select p.group_id, p.purpose, v.id as version_id, v.version_no, s.state, s.cause, v.participants, v.created_real_at,
                s.updated_at as status_updated_at
           from signoff_packages p
           join signoff_package_versions v on v.id = p.current_version_id
           join signoff_version_status s on s.version_id = v.id
          where p.group_id = any($1::uuid[])`,
        [ids],
      )

      const votes = await votesOf(
        db,
        packages.rows.map((p) => p.version_id),
      )
      const rows: AdminGroupRow[] = groups.map((g) => {
        const entry = showcase.rows.find((s) => s.group_id === g.id)
        const current = (purpose: SignoffPurpose): VersionSummary | null => {
          const p = packages.rows.find((r) => r.group_id === g.id && r.purpose === purpose)
          return p ? summaryOf(p, votes) : null
        }
        return {
          groupId: g.id,
          groupCode: g.code,
          members: members.rows.filter((m) => m.group_id === g.id).map((m) => ({ name: m.name, studentNo: m.student_no })),
          advisorName: advisors.rows.find((a) => a.group_id === g.id)?.name ?? null,
          showcase: entry
            ? {
                entryId: entry.entry_id,
                title: entry.title,
                revision: entry.revision,
                ready: entry.title.trim() !== '' && entry.summary.trim() !== '',
              }
            : null,
          submissionFiles: files.rows
            .filter((f) => f.group_id === g.id)
            .map((f) => ({ fileId: f.file_id, name: f.name, itemTitle: f.item_title, versionNo: f.version_no })),
          packages: { result_confirmation: current('result_confirmation'), final_document: current('final_document') },
        }
      })
      return ok(
        { cohort: { id: cohort.id, code: cohort.code, archived: cohort.status === 'archived' }, groups: rows },
        { requestId: uuidv7(), serverTime: new Date().toISOString() },
      )
    })
  }

  async versionDetail(actor: ResolvedActor, versionId: string): Promise<Result<VersionDetail>> {
    const blocked = statusGate(actor, 'business')
    if (blocked) return err(blocked, '請先登入並完成帳號設定。')
    if (actor.kind !== 'authenticated' || !isUuid(versionId)) return denied()
    return this.#withClient(async (db) => {
      const row = (await db.query<VersionRow>(`${VERSION_SELECT} where v.id = $1`, [versionId])).rows[0]
      if (!row) return denied()
      if (!(await canRead(db, actor, row))) return denied()
      const detail = await toDetail(db, row, actor)
      return ok(detail, { requestId: uuidv7(), serverTime: new Date().toISOString() })
    })
  }

  async studentView(actor: ResolvedActor): Promise<StudentSignoffView> {
    if (statusGate(actor, 'business') || actor.kind !== 'authenticated' || !actor.roles.includes('student')) {
      return { groupCode: null, versions: [] }
    }
    return this.#withClient(async (db) => {
      const group = (
        await db.query<{ id: string; code: string }>(
          `select g.id, g.code from group_memberships m join groups g on g.id = m.group_id
            where m.user_id = $1 and m.valid_to is null and g.status = 'active'
            order by m.valid_from desc limit 1`,
          [actor.userId],
        )
      ).rows[0]
      if (!group) return { groupCode: null, versions: [] }
      const rows = (
        await db.query<VersionRow>(`${VERSION_SELECT} where p.group_id = $1 and v.id = p.current_version_id order by p.purpose desc`, [
          group.id,
        ])
      ).rows
      const versions: VersionDetail[] = []
      for (const row of rows) versions.push(await toDetail(db, row, actor))
      return { groupCode: group.code, versions }
    })
  }

  async teacherView(actor: ResolvedActor): Promise<readonly TeacherSignoffCard[]> {
    if (statusGate(actor, 'business') || actor.kind !== 'authenticated' || !actor.roles.includes('teacher')) return []
    return this.#withClient(async (db) => {
      const rows = await db.query<SummaryRow & { group_id: string; group_code: string; cohort_code: string; purpose: SignoffPurpose }>(
        `select g.id as group_id, g.code as group_code, c.code as cohort_code, p.purpose, v.id as version_id, v.version_no,
                s.state, s.cause, v.participants, v.created_real_at, s.updated_at as status_updated_at
           from advisor_assignments a
           join groups g on g.id = a.group_id and g.status = 'active'
           join cohorts c on c.id = g.cohort_id
           join signoff_packages p on p.group_id = g.id
           join signoff_package_versions v on v.id = p.current_version_id
           join signoff_version_status s on s.version_id = v.id
          where a.teacher_user_id = $1 and a.valid_to is null
          order by c.code desc, g.code, p.purpose desc`,
        [actor.userId],
      )
      const votes = await votesOf(
        db,
        rows.rows.map((r) => r.version_id),
      )
      return rows.rows.map((r) => {
        const current = summaryOf(r, votes)
        const isSnapshotAdvisor = readParticipants(r.participants)?.advisor.userId === actor.userId
        return {
          groupId: r.group_id,
          groupCode: r.group_code,
          cohortCode: r.cohort_code,
          purpose: r.purpose,
          current,
          mine: { isSnapshotAdvisor, voted: isSnapshotAdvisor ? current.progress.advisor.result : null },
        }
      })
    })
  }
}

/**
 * 誰讀得到某個版本（契約 03 §1「簽核：當前版本參與者、管理員」）：
 * 管理員；這一版的參與者（快照裡的學生與主指導，含之後被移出或換掉的人——那是他們參與過的紀錄）；
 * 這一組**此刻**的有效組員與主指導（新加入的人要看得到失效原因與新版）。帳號狀態不對的人在呼叫前就被擋。
 */
async function canRead(db: Queryable, actor: Extract<ResolvedActor, { kind: 'authenticated' }>, row: VersionRow): Promise<boolean> {
  if (actor.roles.includes('admin')) return true
  const participants = readParticipants(row.participants)
  if (participants?.advisor.userId === actor.userId || participants?.students.some((s) => s.userId === actor.userId)) return true
  const now = await db.query(
    `select 1 where exists (select 1 from group_memberships where group_id = $1 and user_id = $2 and valid_to is null)
                 or exists (select 1 from advisor_assignments where group_id = $1 and teacher_user_id = $2 and valid_to is null)`,
    [row.group_id, actor.userId],
  )
  return (now.rowCount ?? 0) > 0
}

async function toDetail(db: Queryable, row: VersionRow, actor: Extract<ResolvedActor, { kind: 'authenticated' }>): Promise<VersionDetail> {
  const history = await db.query<{ version_id: string; version_no: number; state: SignoffState; cause: string | null; created_real_at: Date }>(
    `select v.id as version_id, v.version_no, s.state, s.cause, v.created_real_at
       from signoff_package_versions v join signoff_version_status s on s.version_id = v.id
      where v.package_id = $1 order by v.version_no desc`,
    [row.package_id],
  )
  const participants = readParticipants(row.participants) ?? NO_PARTICIPANTS
  const votes = await votesOf(db, [row.version_id])
  const progress = buildProgress(participants, votes, row.state)
  const isCurrent = row.current_version_id === row.version_id
  const role = roleIn(participants, actor.userId)
  const eligible = role !== null && (await stillEligible(db, row.group_id, actor.userId, role))
  const voted = votes.find((v) => v.userId === actor.userId)?.result ?? null
  // 按得下去＝和用例的 checkVote 同一套規則（用例在鎖內再判一次，這裡只決定畫面上要不要出按鈕）。
  const canRespond =
    role !== null &&
    checkVote({ isCurrent, state: row.state, cause: row.cause, checksumMatches: true, role, stillEligible: eligible, alreadyVoted: voted !== null }) ===
      null
  const isAdmin = actor.roles.includes('admin')
  const exports = isAdmin
    ? (
        await db.query<{ format: SignoffExportFormat; real_at: Date; by_name: string }>(
          `select e.format, e.real_at, coalesce(nullif(btrim(p.display_name), ''), u.name) as by_name
             from signoff_exports e join users u on u.id = e.exported_by_user_id left join user_profiles p on p.user_id = e.exported_by_user_id
            where e.version_id = $1 order by e.real_at desc`,
          [row.version_id],
        )
      ).rows.map((e) => ({ format: e.format, at: e.real_at, byName: e.by_name }))
    : []
  return {
    versionId: row.version_id,
    packageId: row.package_id,
    versionNo: row.version_no,
    purpose: row.purpose,
    groupId: row.group_id,
    groupCode: row.group_code,
    cohortCode: row.cohort_code,
    // 存的時候清洗過；輸出前再清一次（就算資料庫被人直接改過也一樣安全）。
    contentHtml: renderBodyHtml(row.content_text),
    contentChecksum: row.content_checksum,
    attachments: Array.isArray(row.attachment_file_versions) ? (row.attachment_file_versions as AttachmentVersion[]) : [],
    participants,
    authorizationScope: readAuthorizationScope(row.authorization_scope),
    supersedeCause: row.supersede_cause,
    state: row.state,
    cause: row.cause,
    isCurrent,
    createdAt: row.created_real_at,
    createdByName: row.created_by_name,
    history: history.rows.map((h) => ({ versionId: h.version_id, versionNo: h.version_no, state: h.state, cause: h.cause, createdAt: h.created_real_at })),
    progress,
    viewer: { userId: actor.userId, role, eligible, voted, canRespond },
    lastRemindedAt: isAdmin ? await lastRemindedAt(db, row.version_id) : null,
    exports,
  }
}
