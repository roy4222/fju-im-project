import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource, CohortStatus } from '@/application/cohorts'
import { renderBodyHtml, sanitizeBody } from '@/application/items'
import type { EventPublisher } from '@/application/notifications'
import { canonicalJson, type AuditWriter, type FileStorage, type OperationLedger } from '@/application/ops'
import {
  buildParticipants,
  causeForNewVersion,
  freezeAuthorizationScope,
  hasVisibleText,
  isTerminal,
  MAX_ATTACHMENTS,
  MAX_CONTENT_CHARS,
  PURPOSE_LABEL,
  readAuthorizationScope,
  readParticipants,
  scopeContent,
  SIGNOFF_PURPOSES,
  type AdminGroupRow,
  type AdminSignoffBoard,
  type AdvisorParticipant,
  type AttachmentVersion,
  type AuthorizationScope,
  type CreateVersionInput,
  type CreateVersionReceipt,
  type DraftSnapshot,
  type SignoffCommand,
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
} from '@/application/signoff'
import { authorizeAdmin, badRequestId, inTransaction, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

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

      const versionNo =
        Number(
          (
            await tx.query<{ n: number }>(
              'select coalesce(max(version_no), 0) + 1 as n from signoff_package_versions where package_id = $1',
              [pkg.id],
            )
          ).rows[0]!.n,
        )
      const supersedeCause = causeForNewVersion(previous)
      await tx.query(
        `insert into signoff_package_versions
           (id, package_id, version_no, content_text, content_checksum, attachment_file_versions, participants, supersede_cause,
            authorization_scope, created_by_user_id, created_real_at, created_business_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, $11, $12)`,
        [
          versionId,
          pkg.id,
          versionNo,
          content,
          contentChecksum,
          JSON.stringify(attachmentVersions),
          JSON.stringify(participants.value),
          supersedeCause,
          scope ? JSON.stringify(scope) : null,
          adminId,
          realAt,
          businessNow,
        ],
      )
      await tx.query(
        `insert into signoff_version_status (version_id, state, created_at, updated_at, updated_by_user_id)
         values ($1, 'collecting', $2, $2, $3)`,
        [versionId, realAt, adminId],
      )

      // 同組同用途原本的目前版本：還沒失效或作廢就讓它失效（舊同意留歷史、不計入新版）。
      let supersededVersionNo: number | null = null
      if (previous && !isTerminal(previous.state)) {
        await markSuperseded(tx, previous.version_id, 'content_change', adminId, realAt)
        supersededVersionNo = previous.version_no
        await this.#events.publish(tx, {
          type: 'signoff.superseded',
          scope: 'cohort',
          cohortId: cohort.id,
          source: { type: 'signoff_version', id: previous.version_id, version: previous.version_no },
          actor: { kind: 'user', userId: adminId },
          recipients: [],
          recipientBasis: { basis: 'pending_decision_D11' },
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
      await this.#events.publish(tx, {
        type: 'signoff.version_created',
        scope: 'cohort',
        cohortId: cohort.id,
        source: { type: 'signoff_version', id: versionId, version: versionNo },
        actor: { kind: 'user', userId: adminId },
        recipients: participants.value.students.map((s) => s.userId),
        recipientBasis: { basis: 'signoff_participants', versionId, groupId: group.id },
        payload: {
          title: `${group.code}「${PURPOSE_LABEL[input.purpose]}」v${versionNo} 輪到你閱讀並同意`,
          groupId: group.id,
          code: group.code,
          purpose: input.purpose,
          versionNo,
        },
        occurredRealAt: realAt,
        occurredBusinessAt: businessNow,
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
    for (const row of rows.rows) {
      if (isTerminal(row.state)) continue
      await markSuperseded(tx, row.version_id, input.cause, input.actorUserId, input.realAt)
      superseded.push(row.version_id)
      await this.#events.publish(tx, {
        type: 'signoff.superseded',
        scope: 'cohort',
        cohortId: row.cohort_id,
        source: { type: 'signoff_version', id: row.version_id, version: row.version_no },
        actor: { kind: 'user', userId: input.actorUserId },
        recipients: [],
        recipientBasis: { basis: 'pending_decision_D11' },
        payload: { groupId: input.groupId, code: row.code, purpose: row.purpose, cause: input.cause },
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

function studentCountOf(raw: unknown): number {
  return readParticipants(raw)?.students.length ?? 0
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
      const packages = await db.query<{
        group_id: string
        purpose: SignoffPurpose
        version_id: string
        version_no: number
        state: SignoffState
        cause: string | null
        participants: unknown
        created_real_at: Date
      }>(
        `select p.group_id, p.purpose, v.id as version_id, v.version_no, s.state, s.cause, v.participants, v.created_real_at
           from signoff_packages p
           join signoff_package_versions v on v.id = p.current_version_id
           join signoff_version_status s on s.version_id = v.id
          where p.group_id = any($1::uuid[])`,
        [ids],
      )

      const rows: AdminGroupRow[] = groups.map((g) => {
        const entry = showcase.rows.find((s) => s.group_id === g.id)
        const current = (purpose: SignoffPurpose): VersionSummary | null => {
          const p = packages.rows.find((r) => r.group_id === g.id && r.purpose === purpose)
          return p
            ? {
                versionId: p.version_id,
                versionNo: p.version_no,
                state: p.state,
                cause: p.cause,
                studentCount: studentCountOf(p.participants),
                createdAt: p.created_real_at,
              }
            : null
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
      const detail = await toDetail(db, row)
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
      for (const row of rows) versions.push(await toDetail(db, row))
      return { groupCode: group.code, versions }
    })
  }

  async teacherView(actor: ResolvedActor): Promise<readonly TeacherSignoffCard[]> {
    if (statusGate(actor, 'business') || actor.kind !== 'authenticated' || !actor.roles.includes('teacher')) return []
    return this.#withClient(async (db) => {
      const rows = await db.query<{
        group_id: string
        group_code: string
        cohort_code: string
        purpose: SignoffPurpose
        version_id: string
        version_no: number
        state: SignoffState
        cause: string | null
        participants: unknown
        created_real_at: Date
      }>(
        `select g.id as group_id, g.code as group_code, c.code as cohort_code, p.purpose, v.id as version_id, v.version_no,
                s.state, s.cause, v.participants, v.created_real_at
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
      return rows.rows.map((r) => ({
        groupId: r.group_id,
        groupCode: r.group_code,
        cohortCode: r.cohort_code,
        purpose: r.purpose,
        current: {
          versionId: r.version_id,
          versionNo: r.version_no,
          state: r.state,
          cause: r.cause,
          studentCount: studentCountOf(r.participants),
          createdAt: r.created_real_at,
        },
      }))
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

async function toDetail(db: Queryable, row: VersionRow): Promise<VersionDetail> {
  const history = await db.query<{ version_id: string; version_no: number; state: SignoffState; created_real_at: Date }>(
    `select v.id as version_id, v.version_no, s.state, v.created_real_at
       from signoff_package_versions v join signoff_version_status s on s.version_id = v.id
      where v.package_id = $1 order by v.version_no desc`,
    [row.package_id],
  )
  const participants = readParticipants(row.participants) ?? {
    students: [],
    advisor: { userId: '', displayName: '（無）', assignmentId: '' },
  }
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
    isCurrent: row.current_version_id === row.version_id,
    createdAt: row.created_real_at,
    createdByName: row.created_by_name,
    history: history.rows.map((h) => ({ versionId: h.version_id, versionNo: h.version_no, state: h.state, createdAt: h.created_real_at })),
  }
}
