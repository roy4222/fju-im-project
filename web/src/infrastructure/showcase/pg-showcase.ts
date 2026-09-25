import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource, CohortStatus } from '@/application/cohorts'
import { canonicalJson, type AuditWriter, type FileStorage, type OperationLedger, type UploadTicket } from '@/application/ops'
import {
  normalizeDraftFields,
  normalizeSummary,
  POSTER_UPLOAD,
  type CreateDraftReceipt,
  type PosterUploadInput,
  type ShowcaseBoard,
  type ShowcaseCommand,
  type ShowcaseDraftView,
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
 * 只有管理員（契約 03 §1「精選：admin」）；草稿不公開、不發布（發布、閘門、核閱在 S12）。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

type CohortRow = { id: string; code: string; status: CohortStatus }
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
  return err('VALIDATION_FAILED', '找不到這份精選草稿，請重新整理頁面。')
}

function archived(code: string): Err {
  return err('COHORT_ARCHIVED', `${code} 已封存，精選草稿只能查看。`)
}

function dissolved(code: string): Err {
  return err('GROUP_DISSOLVED', `${code} 已解散，不能再建立或修改精選草稿。`)
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
    const denied = authorizeAdmin(actor, '建立精選草稿')
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
      if (cohort.status === 'archived') return archived(cohort.code)
      if (group.status === 'dissolved') return dissolved(group.code)

      const existing = await tx.query('select 1 from showcase_entries where cohort_id = $1 and group_id = $2', [cohort.id, group.id])
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

  async updateDraft(actor: ResolvedActor, input: UpdateDraftInput, requestId: string): Promise<Result<UpdateDraftReceipt>> {
    const denied = authorizeAdmin(actor, '編輯精選草稿')
    if (denied) return denied
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
      const owner = await tx.query<{ group_id: string | null }>('select group_id from showcase_entries where id = $1', [input.entryId])
      const groupId = owner.rows[0]?.group_id
      if (!groupId) return draftNotFound()
      const locked = await lockGroup(tx, groupId)
      if (!locked) return draftNotFound()
      const { cohort, group } = locked
      await tx.query('select id from showcase_entries where id = $1 for update', [input.entryId])
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
      if (cohort.status === 'archived') return archived(cohort.code)
      if (group.status === 'dissolved') return dissolved(group.code)
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
        groupCode: group.code,
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
    const denied = authorizeAdmin(actor, '上傳精選海報')
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(input.entryId)) return draftNotFound()
    const found = await this.#pool()
      .connect()
      .then(async (client) => {
        try {
          return (
            await client.query<{ cohort_id: string; status: CohortStatus }>(
              `select e.cohort_id, c.status from showcase_entries e join cohorts c on c.id = e.cohort_id where e.id = $1`,
              [input.entryId],
            )
          ).rows[0]
        } finally {
          client.release()
        }
      })
    if (!found) return draftNotFound()
    if (found.status === 'archived') return err('COHORT_ARCHIVED', '這一屆已封存，精選草稿只能查看。')
    const issued = await this.#files.issueUploadTicket(
      actor.userId,
      { fileName: input.fileName, declaredMime: input.declaredMime, declaredSize: input.declaredSize },
      { purpose: 'poster', allowedTypes: POSTER_UPLOAD.allowedTypes, maxBytes: POSTER_UPLOAD.maxBytes, scope: { kind: 'cohort', cohortId: found.cohort_id } },
    )
    if (!issued.ok) return issued
    const { ticket, fileId, maxBytes, expiresAt } = issued.receipt
    return ok({ ticket, fileId, maxBytes, expiresAt }, { requestId: issued.receipt.requestId, serverTime: issued.receipt.serverTime })
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'showcase', body, (constraint) => {
      if (constraint === 'showcase_entries_one_per_group') {
        return err('CONFLICT', '這一組剛剛已經有人建立了精選草稿；一組只能有一份，請重新整理頁面直接編輯它。')
      }
      return err('CONFLICT', '剛剛有人同時修改了同一份精選草稿，請重新整理頁面再試一次。')
    })
  }
}

function alreadyHasDraft(code: string): Err {
  return err('CONFLICT', `${code} 已經有精選草稿了；一組只能有一份，請直接編輯它。`)
}

/** 鎖順序：屆別 FOR SHARE → 組別 FOR SHARE（見檔頭）。 */
async function lockGroup(tx: PoolClient, groupId: string): Promise<{ cohort: CohortRow; group: GroupRow } | null> {
  const owner = await tx.query<{ cohort_id: string }>('select cohort_id from groups where id = $1', [groupId])
  const cohortId = owner.rows[0]?.cohort_id
  if (!cohortId) return null
  const cohort = (await tx.query<CohortRow>('select id, code, status from cohorts where id = $1 for share', [cohortId])).rows[0]
  const group = (
    await tx.query<GroupRow>('select id, cohort_id, code, status from groups where id = $1 for share', [groupId])
  ).rows[0]
  if (!cohort || !group) return null
  return { cohort, group }
}

// ── 查詢 ────────────────────────────────────────────────────────────────────

type BoardDraftRow = {
  entry_id: string
  group_id: string
  group_code: string
  group_status: 'active' | 'dissolved'
  status: 'draft' | 'published' | 'withdrawn'
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

  async adminBoard(actor: ResolvedActor, cohortId: string): Promise<Result<ShowcaseBoard>> {
    const denied = authorizeAdmin(actor, '管理精選')
    if (denied) return denied
    if (!isUuid(cohortId)) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
    const client = await this.#pool().connect()
    try {
      const cohort = (await client.query<CohortRow>('select id, code, status from cohorts where id = $1', [cohortId])).rows[0]
      if (!cohort) return err('VALIDATION_FAILED', '找不到這個屆別，請重新整理頁面。')
      const groups = await client.query<{ id: string; code: string; entry_id: string | null }>(
        `select g.id, g.code, e.id as entry_id
           from groups g left join showcase_entries e on e.group_id = g.id and e.cohort_id = g.cohort_id
          where g.cohort_id = $1 and g.status = 'active'
          order by g.code`,
        [cohortId],
      )
      const drafts = await client.query<BoardDraftRow>(
        `select e.id as entry_id, g.id as group_id, g.code as group_code, g.status as group_status, e.status,
                d.title, d.summary, d.video_url, d.poster_file_id, f.original_name as poster_name, d.poster_checksum,
                d.revision, d.updated_at, coalesce(p.display_name, u.name) as updated_by_name,
                (select count(*)::int from signoff_package_versions v
                  where v.authorization_scope -> 'scopeSource' ->> 'entryId' = e.id::text) as frozen_in_versions
           from showcase_entries e
           join groups g on g.id = e.group_id
           join showcase_drafts d on d.entry_id = e.id
           left join stored_files f on f.id = d.poster_file_id
           left join users u on u.id = d.updated_by_user_id
           left join user_profiles p on p.user_id = d.updated_by_user_id
          where e.cohort_id = $1
          order by g.code`,
        [cohortId],
      )
      const serverTime = new Date().toISOString()
      return ok(
        {
          cohort: { id: cohort.id, code: cohort.code, archived: cohort.status === 'archived' },
          groups: groups.rows.map((g) => ({ id: g.id, code: g.code, entryId: g.entry_id })),
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
    groupId: r.group_id,
    groupCode: r.group_code,
    groupDissolved: r.group_status === 'dissolved',
    status: r.status,
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
