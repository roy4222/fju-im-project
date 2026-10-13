import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import { cohortLabel, type BusinessClockSource, type CohortStatus } from '@/application/cohorts'
import { canonicalJson, type AuditWriter, type FileStorage, type OperationLedger, type UploadTicket } from '@/application/ops'
import {
  checkShowcaseLifecycle,
  normalizeAward,
  normalizeDraftFields,
  normalizeHomePosition,
  normalizeSummary,
  normalizeTitle,
  POSTER_UPLOAD,
  SHOWCASE_LIMITS,
  type CreateBackfillInput,
  type CreateBackfillReceipt,
  type CreateDraftReceipt,
  type PosterUploadInput,
  type PublishInput,
  type PublishReceipt,
  type SetAwardInput,
  type SetAwardReceipt,
  type SetHomePositionInput,
  type SetHomePositionReceipt,
  type ShowcaseAward,
  type ShowcaseBoard,
  type ShowcaseBoardFilter,
  type ShowcaseCommand,
  type ShowcaseDraftView,
  type ShowcaseEntryRef,
  type ShowcaseLifecycleAction,
  type ShowcaseLifecycleReceipt,
  type ShowcaseQuery,
  type UpdateDraftInput,
  type UpdateDraftReceipt,
} from '@/application/showcase'
import {
  authorizeAdmin,
  badRequestId,
  inTransaction,
  replayed,
  staleRevision,
  type PoolSource,
} from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, ok, type Err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 精選草稿：建立、編輯、海報上傳（票 25／S11-03；模組實作設計 09 §3「→draft」「draft（編輯）」、§5、§6「草稿儲存不檢查授權」）。
 *
 * 每個寫入都是同一個形狀（契約 01 §8）：開交易 → 依序上鎖 → 帳本 `begin` → 業務檢查與寫入 → 稽核 → 帳本 `commit`。
 * 業務時間在開交易**之前**讀一次。
 *
 * 鎖順序（契約 01 §6：cohorts → groups → 頭列）：`cohorts FOR SHARE` → `groups FOR SHARE` →
 * `showcase_entries`／`showcase_drafts FOR UPDATE`。簽核建版凍結授權範圍時拿 `showcase_drafts FOR SHARE`，
 * 和這裡的 `FOR UPDATE` 互斥：凍結的一定是某一次完整儲存後的內容，不會半新半舊。
 *
 * 海報（模組 10 §5 `FileStorage`、附錄 A E-05）：只收 PNG／JPG（上傳憑證與內容檢查兩道），以
 * `ref_type='showcase_draft'`、`ref_id=entry_id` 附掛；換圖或拿掉時 release 舊引用（GC 看有效引用）。
 * 檔案的 checksum 由 `attach` 從 `stored_files` 讀出來寫進 `poster_checksum`（綁素材版本）。
 *
 * 只有管理員（契約 03 §1「精選：admin」）；草稿不公開。
 *
 * **發布、下架、重新發布、獎項、刪除**（第三波 W2，設計方案 §4）：只鎖條目頭列（`showcase_entries FOR UPDATE`，
 * 發布再加 `showcase_drafts FOR SHARE`，與存草稿同一個順序），用條目版本（`showcase_entries.revision`）做樂觀鎖。
 * 這五個不改內容，所以**不受屆別封存與組別解散限制**（歷屆作品也能下架、設獎項）。發布的授權是 Q31 定案的
 * 「系辦勾已取得這組同學同意公開」：`authorization_kind='external'`、`authorization_ref`＝這次的請求編號（UUID）、
 * `pii_check` 記 `admin_attested` 與勾的人（伺服器端的登入者），稽核 `showcase.published` 另記 `consentBy`。
 * 刪除只設刪除標記（`deleted_at／deleted_by_user_id`，DB CHECK 限草稿或已下架），被刪的條目所有指令都當作找不到；
 * 海報引用照留（§2「附件檔案不刪」），由下載政策先排除已刪條目。
 *
 * **W15（設計方案 §4「編輯已發布與歷屆作品」）**：存草稿與換海報對**管理員**不受屆別封存限制（優秀專題是跨屆的
 * 公開紀錄）；不是管理員仍擋（封存屆別回 `COHORT_ARCHIVED`）。沒有組別的歷屆補登（`group_id` NULL）
 * 改內容時鎖 `cohorts FOR SHARE` → 條目本身。`publishUpdate` 把目前草稿凍結成新一筆版本並切成目前版本
 * （寫法同 `publish`，同樣要勾同意、記勾的人），舊版本原封不動；`setHomePosition` 只改首頁輪播順序。刪除後同一組可以再建草稿
 * （0013：一組一屆一個「未刪除」的條目）。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

type CohortRow = { id: string; code: string; name: string; status: CohortStatus }
type GroupRow = { id: string; cohort_id: string; code: string; status: 'active' | 'dissolved' }
type DraftRow = {
  entry_id: string
  title: string
  summary: string
  summary_checksum: string
  video_url: string | null
  poster_file_id: string | null
  poster_checksum: string | null
  revision: number
}

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  files: FileStorage<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

function groupNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這個組別，請重新整理頁面。')
}

function draftNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這份成果展示，請重新整理頁面。')
}

function archived(cohort: { readonly name: string; readonly code: string }): Err {
  return err('COHORT_ARCHIVED', `${cohortLabel(cohort)}已封存，成果展示只能查看。`)
}

function entryNotFound(): Err {
  return err('VALIDATION_FAILED', '找不到這件作品（可能已被刪除），請重新整理頁面。')
}

function dissolved(code: string): Err {
  return err('GROUP_DISSOLVED', `${code} 已解散，不能再建立或修改成果展示草稿。`)
}

/** 摘要 checksum：sha256(正規化後的摘要)（附錄 A `showcase_drafts.summary_checksum`）。 */
export function summaryChecksum(summary: string): string {
  return sha256(normalizeSummary(summary))
}

export class PgShowcaseCommand implements ShowcaseCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #files: FileStorage<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#files = deps.files
    this.#businessClock = deps.businessClock
    this.#pool = deps.pool ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  async createDraft(actor: ResolvedActor, input: { groupId: string }, requestId: string): Promise<Result<CreateDraftReceipt>> {
    const denied = authorizeAdmin(actor, '建立成果展示草稿')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.groupId)) return err('VALIDATION_FAILED', '請先選組別。', { details: { field: 'groupId' } })
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
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
          operationKind: 'showcase.draft_create',
          requestId,
          fingerprint: sha256(canonicalJson({ groupId: group.id })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<CreateDraftReceipt>(begun)
      if (cohort.status === 'archived') return archived(cohort)
      if (group.status === 'dissolved') return dissolved(group.code)

      const existing = await tx.query('select 1 from showcase_entries where cohort_id = $1 and group_id = $2 and deleted_at is null', [
        cohort.id,
        group.id,
      ])
      if ((existing.rowCount ?? 0) > 0) return alreadyHasDraft(group.code)

      const entryId = uuidv7()
      await tx.query(
        `insert into showcase_entries (id, cohort_id, group_id, status, created_at, created_by_user_id, updated_at, updated_by_user_id)
         values ($1, $2, $3, 'draft', $4, $5, $4, $5)`,
        [entryId, cohort.id, group.id, realAt, adminId],
      )
      await tx.query(
        `insert into showcase_drafts (entry_id, summary_checksum, created_at, updated_at, updated_by_user_id)
         values ($1, $2, $3, $3, $4)`,
        [entryId, summaryChecksum(''), realAt, adminId],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'showcase.draft_create',
        targetType: 'showcase_entry',
        targetId: entryId,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: { groupId: group.id },
      })
      const receipt = { entryId, groupCode: group.code, revision: 1, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { entryId } })
      return { ok: true as const, receipt }
    })
  }

  async createBackfill(actor: ResolvedActor, input: CreateBackfillInput, requestId: string): Promise<Result<CreateBackfillReceipt>> {
    const denied = authorizeAdmin(actor, '補登歷屆作品')
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.cohortId)) return err('VALIDATION_FAILED', '請先選屆別。', { details: { field: 'cohortId' } })
    const title = normalizeTitle(String(input.title ?? ''))
    if (title === '') return err('VALIDATION_FAILED', '請填作品題目。', { details: { field: 'title' } })
    if (title.length > SHOWCASE_LIMITS.title) {
      return err('VALIDATION_FAILED', `題目最多 ${SHOWCASE_LIMITS.title} 個字。`, { details: { field: 'title' } })
    }
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const cohort = (await tx.query<CohortRow>('select id, code, name, status from cohorts where id = $1 for share', [input.cohortId])).rows[0]
      if (!cohort) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。', { details: { field: 'cohortId' } })
      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'showcase.backfill_create',
          requestId,
          fingerprint: sha256(canonicalJson({ cohortId: cohort.id, title })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<CreateBackfillReceipt>(begun)

      // 歷屆補登：沒有組別、可以是封存的屆別（優秀專題是跨屆的公開紀錄）；草稿先帶題目，其他之後在看板補。
      const entryId = uuidv7()
      await tx.query(
        `insert into showcase_entries (id, cohort_id, group_id, status, created_at, created_by_user_id, updated_at, updated_by_user_id)
         values ($1, $2, null, 'draft', $3, $4, $3, $4)`,
        [entryId, cohort.id, realAt, adminId],
      )
      await tx.query(
        `insert into showcase_drafts (entry_id, title, summary_checksum, created_at, updated_at, updated_by_user_id)
         values ($1, $2, $3, $4, $4, $5)`,
        [entryId, title, summaryChecksum(''), realAt, adminId],
      )
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'showcase.backfill_create',
        targetType: 'showcase_entry',
        targetId: entryId,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        payload: { title, cohortCode: cohort.code },
      })
      const receipt = { entryId, cohortCode: cohort.code, cohortName: cohort.name, title, revision: 1, requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { entryId } })
      return { ok: true as const, receipt }
    })
  }

  async updateDraft(actor: ResolvedActor, input: UpdateDraftInput, requestId: string): Promise<Result<UpdateDraftReceipt>> {
    const denied = authorizeAdmin(actor, '編輯成果展示')
    if (denied) {
      // 不是管理員一律不能改；封存屆別的作品照實說「已封存」（設計方案 §4：封存仍擋非管理員）。不寫任何列。
      if (denied.code === 'FORBIDDEN' && isUuid(input.entryId)) {
        const cohort = await this.#entryCohort(input.entryId)
        if (cohort?.status === 'archived') return archived(cohort)
      }
      return denied
    }
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.entryId)) return draftNotFound()
    const revision = Number(input.revision)
    if (!Number.isInteger(revision) || revision < 1) return staleRevision()
    const posterFileId = input.posterFileId === null || input.posterFileId === '' ? null : String(input.posterFileId)
    if (posterFileId !== null && !isUuid(posterFileId)) {
      return err('VALIDATION_FAILED', '海報檔案編號不正確，請重新上傳。', { details: { field: 'poster' } })
    }
    const normalized = normalizeDraftFields(input)
    if (!normalized.ok) return normalized
    const fields = normalized.value
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const owner = (
        await tx.query<{ cohort_id: string; group_id: string | null }>('select cohort_id, group_id from showcase_entries where id = $1 and deleted_at is null', [
          input.entryId,
        ])
      ).rows[0]
      if (!owner) return draftNotFound()
      // 有組別：屆別 → 組別；歷屆補登沒有組別：只鎖屆別，再鎖條目本身（下面的 FOR UPDATE）。
      const locked = owner.group_id ? await lockGroup(tx, owner.group_id) : await lockCohort(tx, owner.cohort_id)
      if (!locked) return draftNotFound()
      const { cohort, group } = locked
      const head = await tx.query('select id from showcase_entries where id = $1 and deleted_at is null for update', [input.entryId])
      if ((head.rowCount ?? 0) === 0) return draftNotFound()
      const draft = (
        await tx.query<DraftRow>(
          `select entry_id, title, summary, summary_checksum, video_url, poster_file_id, poster_checksum, revision
             from showcase_drafts where entry_id = $1 for update`,
          [input.entryId],
        )
      ).rows[0]
      if (!draft) return draftNotFound()

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: 'showcase.draft_update',
          requestId,
          fingerprint: sha256(canonicalJson({ entryId: input.entryId, revision, ...fields, posterFileId })),
          scope: 'cohort',
          cohortId: cohort.id,
        },
        realAt,
      )
      if (begun.outcome !== 'fresh') return replayed<UpdateDraftReceipt>(begun)
      // 管理員不受屆別封存限制（W15）；解散的組仍不能改。
      if (group?.status === 'dissolved') return dissolved(group.code)
      if (draft.revision !== revision) {
        return err('CONFLICT', '這份草稿剛剛已經被別人更新了，請重新載入頁面看最新內容再改。')
      }

      // 海報：換成新的 → 綁新檔（只能是本人剛上傳的圖片；attach 讀出 checksum）＋ release 舊引用；拿掉 → 只 release。
      const ref = { refType: 'showcase_draft' as const, refId: input.entryId }
      let posterChecksum = draft.poster_checksum
      const posterChanged = posterFileId !== draft.poster_file_id
      if (posterChanged) {
        if (posterFileId !== null) {
          const attached = await this.#files.attach(tx, posterFileId, ref, { purpose: 'poster', ownerUserId: adminId })
          if (!attached.ok) {
            return err(attached.code, attached.code === 'FILE_NOT_OWNED' ? '找不到你剛上傳的海報圖檔，請重新上傳 PNG 或 JPG。' : attached.message, {
              details: { field: 'poster' },
            })
          }
          posterChecksum = attached.receipt.checksum
        } else {
          posterChecksum = null
        }
        if (draft.poster_file_id) await this.#files.release(tx, draft.poster_file_id, ref)
      }

      const updated = await tx.query<{ revision: number }>(
        `update showcase_drafts
            set title = $2, summary = $3, summary_checksum = $4, video_url = $5, poster_file_id = $6, poster_checksum = $7,
                revision = revision + 1, updated_at = $8, updated_by_user_id = $9
          where entry_id = $1
          returning revision`,
        [input.entryId, fields.title, fields.summary, summaryChecksum(fields.summary), fields.videoUrl, posterFileId, posterChecksum, realAt, adminId],
      )
      await tx.query('update showcase_entries set revision = revision + 1, updated_at = $2, updated_by_user_id = $3 where id = $1', [
        input.entryId,
        realAt,
        adminId,
      ])
      const newRevision = updated.rows[0]!.revision
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: 'showcase.draft_update',
        targetType: 'showcase_entry',
        targetId: input.entryId,
        scope: 'cohort',
        cohortId: cohort.id,
        realAt,
        businessAt: businessNow,
        // 只記哪些欄位變了與新的 checksum，不把摘要全文抄進稽核。
        payload: {
          revision: newRevision,
          titleChanged: fields.title !== draft.title,
          summaryChanged: fields.summary !== draft.summary,
          videoUrlChanged: fields.videoUrl !== draft.video_url,
          posterFileId,
          previousPosterFileId: posterChanged ? draft.poster_file_id : undefined,
        },
      })
      const receipt = {
        entryId: input.entryId,
        groupCode: group?.code ?? null,
        revision: newRevision,
        posterChanged,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { entryId: input.entryId, revision: newRevision } })
      return { ok: true as const, receipt }
    })
  }

  async requestPosterUpload(actor: ResolvedActor, input: PosterUploadInput): Promise<Result<UploadTicket>> {
    const denied = authorizeAdmin(actor, '上傳成果展示海報')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(input.entryId)) return draftNotFound()
    // 管理員可以替封存屆別的作品換海報（W15）；到這裡的一定是管理員。
    const found = await this.#entryCohort(input.entryId)
    if (!found) return draftNotFound()
    const issued = await this.#files.issueUploadTicket(
      actor.userId,
      { fileName: input.fileName, declaredMime: input.declaredMime, declaredSize: input.declaredSize },
      { purpose: 'poster', allowedTypes: POSTER_UPLOAD.allowedTypes, maxBytes: POSTER_UPLOAD.maxBytes, scope: { kind: 'cohort', cohortId: found.id } },
    )
    if (!issued.ok) return issued
    const { ticket, fileId, maxBytes, expiresAt } = issued.receipt
    return ok({ ticket, fileId, maxBytes, expiresAt }, { requestId: issued.receipt.requestId, serverTime: issued.receipt.serverTime })
  }

  async publish(actor: ResolvedActor, input: PublishInput, requestId: string): Promise<Result<PublishReceipt>> {
    const missing = missingConsent(actor, input, '發布優秀專題', '發布')
    if (missing) return missing
    return this.#change<PublishReceipt>(actor, input, requestId, {
      what: '發布優秀專題',
      kind: 'showcase.publish',
      lifecycle: 'publish',
      write: (tx, head, ctx) => this.#freezeDraft(tx, head, ctx),
    })
  }

  async publishUpdate(actor: ResolvedActor, input: PublishInput, requestId: string): Promise<Result<PublishReceipt>> {
    // 發布更新也是一次公開授權（Q31）：同樣要勾同意，記下勾的人＝這次的登入者。
    const missing = missingConsent(actor, input, '發布優秀專題的更新', '發布更新')
    if (missing) return missing
    return this.#change<PublishReceipt>(actor, input, requestId, {
      what: '發布優秀專題的更新',
      kind: 'showcase.publish_update',
      lifecycle: 'publish_update',
      write: (tx, head, ctx) => this.#freezeDraft(tx, head, ctx),
    })
  }

  /**
   * 發布與發布更新共用：目前草稿（`FOR SHARE`）凍結成新一筆版本，海報一起綁到版本上，條目切到它（狀態＝公開中）。
   * 舊版本不動。發布更新時草稿和目前那一版一樣就擋下（不產生內容相同的新版本）。
   */
  async #freezeDraft(
    tx: PoolClient,
    head: HeadRow,
    ctx: { adminId: string; realAt: Date; requestId: string },
  ): Promise<Err | { ok: true; title: string; extra: { versionNo: number }; audit: Record<string, unknown> }> {
    const draft = (
      await tx.query<DraftRow>(
        `select entry_id, title, summary, summary_checksum, video_url, poster_file_id, poster_checksum, revision
           from showcase_drafts where entry_id = $1 for share`,
        [head.id],
      )
    ).rows[0]
    if (!draft) return draftNotFound()
    if (draft.title.trim() === '') {
      return err('VALIDATION_FAILED', '題目還是空白；請先在草稿填好題目並儲存，再發布。', { details: { field: 'title' } })
    }
    const previous = head.current_version_id
      ? (
          await tx.query<{ title: string; summary_checksum: string; video_url: string | null; poster_file_id: string | null }>(
            'select title, summary_checksum, video_url, poster_file_id from showcase_versions where id = $1',
            [head.current_version_id],
          )
        ).rows[0]
      : undefined
    if (
      head.status === 'published' &&
      previous &&
      previous.title === draft.title &&
      previous.summary_checksum === draft.summary_checksum &&
      previous.video_url === draft.video_url &&
      previous.poster_file_id === draft.poster_file_id
    ) {
      return err('VALIDATION_FAILED', '草稿和前台目前那一版一樣，沒有要發布的更新；先改草稿並儲存，再按「發布更新」。')
    }
    const versionId = uuidv7()
    const versionNo =
      (await tx.query<{ n: number }>('select coalesce(max(version_no), 0)::int + 1 as n from showcase_versions where entry_id = $1', [head.id]))
        .rows[0]!.n
    await tx.query(
      `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, video_url, poster_file_id, poster_checksum,
                                      authorization_kind, authorization_ref, pii_check, created_by_user_id, created_real_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'external', $10, $11::jsonb, $12, $13)`,
      [
        versionId,
        head.id,
        versionNo,
        draft.title,
        draft.summary,
        draft.summary_checksum,
        draft.video_url,
        draft.poster_file_id,
        draft.poster_checksum,
        ctx.requestId,
        JSON.stringify({ status: 'admin_attested', by: ctx.adminId, at: ctx.realAt.toISOString() }),
        ctx.adminId,
        ctx.realAt,
      ],
    )
    // 海報從草稿複製到版本：前台下載政策只認發布版本上的那張。
    if (draft.poster_file_id) {
      const held = await this.#files.attach(
        tx,
        draft.poster_file_id,
        { refType: 'showcase_version', refId: versionId },
        { purpose: 'poster', heldBy: { refType: 'showcase_draft', refId: head.id } },
      )
      if (!held.ok) return held
    }
    await tx.query(`update showcase_entries set status = 'published', current_version_id = $2 where id = $1`, [head.id, versionId])
    return {
      ok: true as const,
      title: draft.title,
      extra: { versionNo },
      audit: {
        versionId,
        versionNo,
        consentBy: ctx.adminId,
        title: draft.title,
        cohortCode: head.cohort_code,
        ...(head.current_version_id ? { previousVersionId: head.current_version_id } : {}),
      },
    }
  }

  async setHomePosition(actor: ResolvedActor, input: SetHomePositionInput, requestId: string): Promise<Result<SetHomePositionReceipt>> {
    const position = normalizeHomePosition(input.position)
    if (!position.ok && !authorizeAdmin(actor, '設定首頁順序')) return position
    const value = position.ok ? position.value : null
    return this.#change<SetHomePositionReceipt>(actor, input, requestId, {
      what: '設定首頁順序',
      kind: 'showcase.home_position_set',
      fingerprint: { homePosition: value },
      write: async (tx, head) => {
        await tx.query('update showcase_entries set home_position = $2 where id = $1', [head.id, value])
        return {
          ok: true as const,
          extra: { homePosition: value },
          audit: { homePosition: value, previousHomePosition: head.home_position, title: head.title, cohortCode: head.cohort_code },
        }
      },
    })
  }

  async withdraw(actor: ResolvedActor, input: ShowcaseEntryRef, requestId: string): Promise<Result<ShowcaseLifecycleReceipt>> {
    return this.#change(actor, input, requestId, {
      what: '下架優秀專題',
      kind: 'showcase.withdraw',
      lifecycle: 'withdraw',
      write: async (tx, head) => {
        await tx.query(`update showcase_entries set status = 'withdrawn' where id = $1`, [head.id])
        return { ok: true as const, extra: {}, audit: { previousStatus: head.status, title: head.title, cohortCode: head.cohort_code } }
      },
    })
  }

  async republish(actor: ResolvedActor, input: ShowcaseEntryRef, requestId: string): Promise<Result<ShowcaseLifecycleReceipt>> {
    return this.#change(actor, input, requestId, {
      what: '重新發布優秀專題',
      kind: 'showcase.republish',
      lifecycle: 'republish',
      write: async (tx, head) => {
        if (!head.current_version_id) return err('VALIDATION_FAILED', '這件作品沒有發布過的版本；請勾同意後按「發布」。')
        await tx.query(`update showcase_entries set status = 'published' where id = $1`, [head.id])
        return { ok: true as const, extra: {}, audit: { versionId: head.current_version_id, title: head.title, cohortCode: head.cohort_code } }
      },
    })
  }

  async setAward(actor: ResolvedActor, input: SetAwardInput, requestId: string): Promise<Result<SetAwardReceipt>> {
    const award = normalizeAward(input)
    if (!award.ok && !authorizeAdmin(actor, '設定獎項')) return award
    const value = award.ok ? award.value : { level: null, label: null }
    return this.#change<SetAwardReceipt>(actor, input, requestId, {
      what: '設定獎項',
      kind: 'showcase.award_set',
      fingerprint: value,
      write: async (tx, head) => {
        await tx.query('update showcase_entries set award_level = $2, award_label = $3 where id = $1', [head.id, value.level, value.label])
        return {
          ok: true as const,
          extra: { award: value.level, awardLabel: value.label },
          audit: {
            award: value.level,
            awardLabel: value.label,
            previousAward: head.award_level,
            previousAwardLabel: head.award_label,
            title: head.title,
            cohortCode: head.cohort_code,
          },
        }
      },
    })
  }

  async delete(actor: ResolvedActor, input: ShowcaseEntryRef, requestId: string): Promise<Result<ShowcaseLifecycleReceipt>> {
    return this.#change(actor, input, requestId, {
      what: '刪除優秀專題',
      kind: 'showcase.delete',
      lifecycle: 'delete',
      write: async (tx, head, ctx) => {
        await tx.query('update showcase_entries set deleted_at = $2, deleted_by_user_id = $3 where id = $1', [head.id, ctx.realAt, ctx.adminId])
        // 刪除前的狀態、題目、屆別：之後只剩稽核看得到（§2）。
        return {
          ok: true as const,
          extra: {},
          audit: { previousStatus: head.status, title: head.title, cohortCode: head.cohort_code, groupCode: head.group_code },
        }
      },
    })
  }

  /**
   * 五個條目指令共用的形狀：鎖頭列 → 帳本 → 版本與狀態檢查 → 寫入 → 條目版本＋1 → 稽核 → 帳本。
   * 已刪除的條目：同一個請求編號重送照帳本重播，新的請求一律「找不到」。
   */
  async #change<R extends ShowcaseLifecycleReceipt>(
    actor: ResolvedActor,
    input: ShowcaseEntryRef,
    requestId: string,
    op: {
      what: string
      kind: string
      lifecycle?: ShowcaseLifecycleAction
      fingerprint?: unknown
      write: (
        tx: PoolClient,
        head: HeadRow,
        ctx: { adminId: string; realAt: Date; requestId: string },
      ) => Promise<Err | { ok: true; title?: string; extra: Omit<R, keyof ShowcaseLifecycleReceipt>; audit: Record<string, unknown> }>
    },
  ): Promise<Result<R>> {
    const denied = authorizeAdmin(actor, op.what)
    if (denied) return denied
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(input.entryId)) return entryNotFound()
    const revision = Number(input.revision)
    if (!Number.isInteger(revision) || revision < 1) return staleRevision()
    const adminId = actor.kind === 'authenticated' ? actor.userId : ''
    const businessNow = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const head = (
        await tx.query<HeadRow>(
          `select e.id, e.cohort_id, c.code as cohort_code, g.code as group_code, e.status, e.revision, e.current_version_id,
                  e.award_level, e.award_label, e.home_position, e.deleted_at, coalesce(nullif(d.title, ''), v.title, '') as title
             from showcase_entries e
             join cohorts c on c.id = e.cohort_id
             left join groups g on g.id = e.group_id
             left join showcase_drafts d on d.entry_id = e.id
             left join showcase_versions v on v.id = e.current_version_id
            where e.id = $1
              for update of e`,
          [input.entryId],
        )
      ).rows[0]
      if (!head) return entryNotFound()

      const realAt = this.#realClock.now()
      const begun = await this.#ledger.begin(
        tx,
        {
          actorUserId: adminId,
          operationKind: op.kind,
          requestId,
          fingerprint: sha256(canonicalJson({ entryId: input.entryId, revision, ...(op.fingerprint ? { value: op.fingerprint } : {}) })),
          scope: 'cohort',
          cohortId: head.cohort_id,
        },
        realAt,
      )
      // 先讓帳本重播（刪除成功後同一個請求編號重送要拿回原回執），新的請求才把已刪除的當作找不到。
      if (begun.outcome !== 'fresh') return replayed<R>(begun)
      if (head.deleted_at !== null) return entryNotFound()
      if (head.revision !== revision) {
        return err('CONFLICT', '這件作品剛剛已經被別人改過了，請重新整理頁面看最新狀態再操作。')
      }
      if (op.lifecycle) {
        const blocked = checkShowcaseLifecycle(op.lifecycle, head.status)
        if (blocked) return err('VALIDATION_FAILED', blocked)
      }

      const written = await op.write(tx, head, { adminId, realAt, requestId })
      if (!written.ok) return written
      const newRevision = (
        await tx.query<{ revision: number }>(
          'update showcase_entries set revision = revision + 1, updated_at = $2, updated_by_user_id = $3 where id = $1 returning revision',
          [head.id, realAt, adminId],
        )
      ).rows[0]!.revision
      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: adminId,
        role: 'admin',
        action: AUDIT_ACTION[op.kind]!,
        targetType: 'showcase_entry',
        targetId: head.id,
        scope: 'cohort',
        cohortId: head.cohort_id,
        realAt,
        businessAt: businessNow,
        payload: { revision: newRevision, ...written.audit },
      })
      const receipt = {
        entryId: head.id,
        groupCode: head.group_code,
        title: written.title ?? head.title,
        revision: newRevision,
        ...written.extra,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { entryId: head.id, revision: newRevision } })
      return { ok: true as const, receipt: receipt as unknown as R & { requestId: string; serverTime: string } }
    })
  }

  /** 條目所屬的屆別（已刪除的當作沒有）；只讀，不上鎖。 */
  async #entryCohort(entryId: string): Promise<CohortRow | undefined> {
    const client = await this.#pool().connect()
    try {
      return (
        await client.query<CohortRow>(
          'select c.id, c.code, c.name, c.status from showcase_entries e join cohorts c on c.id = e.cohort_id where e.id = $1 and e.deleted_at is null',
          [entryId],
        )
      ).rows[0]
    } finally {
      client.release()
    }
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'showcase', body, (constraint) => {
      if (constraint === 'showcase_entries_one_per_group') {
        return err('CONFLICT', '這一組剛剛已經有人建立了成果展示草稿；一組只能有一份，請重新整理頁面直接編輯它。')
      }
      return err('CONFLICT', '剛剛有人同時修改了同一份成果展示，請重新整理頁面再試一次。')
    })
  }
}

/** 帳本的動作種類 → 稽核代碼（照既有命名用過去式：`item.archived`、`item.republished`）。 */
const AUDIT_ACTION: Readonly<Record<string, string>> = {
  'showcase.publish': 'showcase.published',
  'showcase.publish_update': 'showcase.update_published',
  'showcase.home_position_set': 'showcase.home_position_set',
  'showcase.withdraw': 'showcase.withdrawn',
  'showcase.republish': 'showcase.republished',
  'showcase.award_set': 'showcase.award_set',
  'showcase.delete': 'showcase.deleted',
}

type HeadRow = {
  id: string
  cohort_id: string
  cohort_code: string
  group_code: string | null
  status: 'draft' | 'published' | 'withdrawn'
  revision: number
  current_version_id: string | null
  award_level: ShowcaseAward | null
  award_label: string | null
  home_position: number | null
  deleted_at: Date | null
  title: string
}

/**
 * 同意要在畫面上勾（Q31）；沒勾就不進交易，也不吃掉請求編號。只認 `true`（表單字串、undefined 都不算）。
 * 不是管理員的先讓 `#change` 回 `FORBIDDEN`，不提示同意。
 */
function missingConsent(actor: ResolvedActor, input: PublishInput, what: string, button: string): Err | null {
  if (input.consent === true || authorizeAdmin(actor, what)) return null
  return err('VALIDATION_FAILED', `請先勾選「已取得這組同學同意公開」再按「${button}」。`, { details: { field: 'consent' } })
}

function alreadyHasDraft(code: string): Err {
  return err('CONFLICT', `${code} 已經有成果展示草稿了；一組只能有一份，請直接編輯它。`)
}

/** 鎖順序：屆別 FOR SHARE → 組別 FOR SHARE（見檔頭）。 */
async function lockGroup(tx: PoolClient, groupId: string): Promise<{ cohort: CohortRow; group: GroupRow } | null> {
  const owner = await tx.query<{ cohort_id: string }>('select cohort_id from groups where id = $1', [groupId])
  const cohortId = owner.rows[0]?.cohort_id
  if (!cohortId) return null
  const cohort = (await tx.query<CohortRow>('select id, code, name, status from cohorts where id = $1 for share', [cohortId])).rows[0]
  const group = (
    await tx.query<GroupRow>('select id, cohort_id, code, status from groups where id = $1 for share', [groupId])
  ).rows[0]
  if (!cohort || !group) return null
  return { cohort, group }
}

/** 歷屆補登（沒有組別）：只鎖屆別 FOR SHARE，條目本身由呼叫端 FOR UPDATE。 */
async function lockCohort(tx: PoolClient, cohortId: string): Promise<{ cohort: CohortRow; group: null } | null> {
  const cohort = (await tx.query<CohortRow>('select id, code, name, status from cohorts where id = $1 for share', [cohortId])).rows[0]
  return cohort ? { cohort, group: null } : null
}

// ── 查詢 ────────────────────────────────────────────────────────────────────

type BoardDraftRow = {
  entry_id: string
  cohort_id: string
  cohort_code: string
  cohort_name: string
  cohort_status: CohortStatus
  group_id: string | null
  group_code: string | null
  group_status: 'active' | 'dissolved' | null
  status: 'draft' | 'published' | 'withdrawn'
  entry_revision: number
  award_level: ShowcaseAward | null
  award_label: string | null
  home_position: number | null
  has_draft: boolean
  has_unpublished_changes: boolean
  published_title: string | null
  title: string
  summary: string
  video_url: string | null
  poster_file_id: string | null
  poster_name: string | null
  poster_checksum: string | null
  revision: number
  updated_at: Date
  updated_by_name: string | null
  frozen_in_versions: number
}

export class PgShowcaseQuery implements ShowcaseQuery {
  readonly #pool: PoolSource

  constructor(deps: { pool?: PoolSource } = {}) {
    this.#pool = deps.pool ?? getPool
  }

  /**
   * 看板：篩選的屆別或全部（含封存的歷屆）；左連組別（歷屆補登沒有組別）、左連草稿（有草稿列就照草稿、含 NULL；
   * 只有發布版本的才用版本內容）。
   * 已刪除的條目不列。建立草稿的組別清單另外依 `createCohortId` 查（有未刪除條目的組不能再建；刪掉後可以）。
   */
  async adminBoard(actor: ResolvedActor, filter: ShowcaseBoardFilter): Promise<Result<ShowcaseBoard>> {
    const denied = authorizeAdmin(actor, '管理成果展示')
    if (denied) return denied
    if ((filter.cohortId !== null && !isUuid(filter.cohortId)) || (filter.createCohortId !== null && !isUuid(filter.createCohortId))) {
      return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
    }
    const client = await this.#pool().connect()
    try {
      let cohort: CohortRow | null = null
      let groups: { id: string; code: string; entry_id: string | null }[] = []
      if (filter.createCohortId !== null) {
        cohort = (await client.query<CohortRow>('select id, code, name, status from cohorts where id = $1', [filter.createCohortId])).rows[0] ?? null
        if (!cohort) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
        groups = (
          await client.query<{ id: string; code: string; entry_id: string | null }>(
            `select g.id, g.code, e.id as entry_id
               from groups g left join showcase_entries e on e.group_id = g.id and e.cohort_id = g.cohort_id and e.deleted_at is null
              where g.cohort_id = $1 and g.status = 'active'
              order by g.code`,
            [filter.createCohortId],
          )
        ).rows
      }
      const drafts = await client.query<BoardDraftRow>(
        `select e.id as entry_id, c.id as cohort_id, c.code as cohort_code, c.name as cohort_name, c.status as cohort_status,
                g.id as group_id, g.code as group_code, g.status as group_status,
                e.status, e.revision as entry_revision, e.award_level, e.award_label, e.home_position,
                (d.entry_id is not null) as has_draft, v.title as published_title,
                -- 發布過、草稿又和前台那一版不一樣：可以「發布更新」。
                (d.entry_id is not null and v.id is not null
                  and (d.title is distinct from v.title or d.summary_checksum is distinct from v.summary_checksum
                       or d.video_url is distinct from v.video_url or d.poster_file_id is distinct from v.poster_file_id)) as has_unpublished_changes,
                -- 有草稿列就照草稿（含拿掉的海報與影片＝NULL），只有發布版本的才用版本內容。
                case when d.entry_id is not null then d.title else coalesce(v.title, '') end as title,
                case when d.entry_id is not null then d.summary else coalesce(v.summary, '') end as summary,
                case when d.entry_id is not null then d.video_url else v.video_url end as video_url,
                case when d.entry_id is not null then d.poster_file_id else v.poster_file_id end as poster_file_id,
                f.original_name as poster_name,
                case when d.entry_id is not null then d.poster_checksum else v.poster_checksum end as poster_checksum,
                coalesce(d.revision, 1) as revision, coalesce(d.updated_at, e.updated_at) as updated_at,
                coalesce(p.display_name, u.name) as updated_by_name,
                (select count(*)::int from signoff_package_versions sv
                  where sv.authorization_scope -> 'scopeSource' ->> 'entryId' = e.id::text) as frozen_in_versions
           from showcase_entries e
           join cohorts c on c.id = e.cohort_id
           left join groups g on g.id = e.group_id
           left join showcase_drafts d on d.entry_id = e.id
           left join showcase_versions v on v.id = e.current_version_id
           left join stored_files f on f.id = case when d.entry_id is not null then d.poster_file_id else v.poster_file_id end
           left join users u on u.id = coalesce(d.updated_by_user_id, e.updated_by_user_id)
           left join user_profiles p on p.user_id = u.id
          where e.deleted_at is null and ($1::uuid is null or e.cohort_id = $1)
          order by c.code desc, g.code asc nulls last, coalesce(d.title, v.title) asc, e.id asc`,
        [filter.cohortId],
      )
      const serverTime = new Date().toISOString()
      return ok(
        {
          cohort: cohort ? { id: cohort.id, code: cohort.code, name: cohort.name, archived: cohort.status === 'archived' } : null,
          groups: groups.map((g) => ({ id: g.id, code: g.code, entryId: g.entry_id })),
          drafts: drafts.rows.map(toDraftView),
        },
        { requestId: uuidv7(), serverTime },
      )
    } finally {
      client.release()
    }
  }
}

function toDraftView(r: BoardDraftRow): ShowcaseDraftView {
  return {
    entryId: r.entry_id,
    cohortId: r.cohort_id,
    cohortCode: r.cohort_code,
    cohortName: r.cohort_name,
    cohortArchived: r.cohort_status === 'archived',
    groupId: r.group_id,
    groupCode: r.group_code,
    groupDissolved: r.group_status === 'dissolved',
    status: r.status,
    entryRevision: r.entry_revision,
    award: r.award_level,
    awardLabel: r.award_label,
    homePosition: r.home_position,
    hasDraft: r.has_draft,
    hasUnpublishedChanges: r.has_unpublished_changes,
    publishedTitle: r.published_title,
    title: r.title,
    summary: r.summary,
    videoUrl: r.video_url,
    poster:
      r.poster_file_id && r.poster_checksum
        ? { fileId: r.poster_file_id, name: r.poster_name ?? '海報', checksum: r.poster_checksum }
        : null,
    revision: r.revision,
    updatedAt: r.updated_at,
    updatedByName: r.updated_by_name,
    frozenInVersions: r.frozen_in_versions,
  }
}
