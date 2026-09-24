import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import type { FormField } from '@/application/items'
import { canonicalJson, type AuditWriter, type OperationLedger } from '@/application/ops'
import {
  describeIssues,
  normalizeAnswers,
  phaseOf,
  submitIssues,
  type Answers,
  type DraftReceipt,
  type MyItemDetail,
  type MyItemRow,
  type MyVersionDetail,
  type SubmissionCommand,
  type SubmissionQuery,
  type SubmitReceipt,
  type VersionSummary,
} from '@/application/submissions'
import { badRequestId, inTransaction, replayed, type PoolSource } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import { sha256 } from '@/infrastructure/ops/audit-writer'
import { err, type Err, type Result } from '@/shared/result'
import { formatTaipeiMinute, RealClock, type Clock } from '@/shared/time'

/**
 * 個人收件的存草稿與正式送出（票 17；模組實作設計 05 §2、§3、§6；產品模組 05 §4「個人填報與收件名單」「4.6」）。
 *
 * 每個寫入都是同一個形狀（契約 01 §8，照 pg-items）：業務時間在開交易**之前**讀一次（＝後端收到請求的時間）→
 * 開交易 → 鎖（`cohorts FOR SHARE` → `managed_items FOR SHARE` → `submission_drafts FOR UPDATE`，契約 01 §6 的鎖順序）
 * → 帳本 `begin` → 守門 → 寫入 → 稽核 → 帳本 `commit` → COMMIT。回 `Err` 或丟例外整筆回滾。
 *
 * 鎖項目用 `FOR SHARE`：管理員「發布更新」拿的是 `FOR UPDATE`，所以兩邊一定排隊——
 * 管理員先切了收件單位，學生這邊拿到鎖後讀到的就是新的設定；學生先存了草稿，管理員那邊就看得到「已有人作答」。
 *
 * 守門順序（模組實作設計 05 §2，先命中者回傳）：
 * 名單（`NOT_IN_ROSTER`、`EXEMPTED`）→ 屆別（`COHORT_ARCHIVED`）→ 時間（`ITEM_NOT_OPEN`、`DEADLINE_PASSED`）
 * → 欄位版本（`DRAFT_NEEDS_REVIEW`）→ 版本競爭（`CONFLICT`）→ 欄位驗證（`VALIDATION_FAILED`）。
 * 送出時把版本競爭放在欄位驗證**之前**：驗的是資料庫裡那一份草稿，版本對不上就先要求重新載入，
 * 免得拿另一個分頁的內容缺什麼來提示畫面上看不到的欄位。
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
}

type DraftRow = { id: string; revision: number; schema_version_id: string; migration_state: string; answers: Answers }

type Locked = {
  item: ItemRow
  cohortStatus: string
  roster: { exempt: boolean } | null
  schema: { id: string; versionNo: number; fields: FormField[] } | null
}

type Deps = {
  audit: AuditWriter<PoolClient>
  ledger: OperationLedger<PoolClient>
  businessClock: BusinessClockSource
  pool?: PoolSource
  realClock?: Clock
}

function notInRoster(): Err {
  return err('NOT_IN_ROSTER', '你不在這份收件的名單上，請回作業區重新整理。')
}

function staleDraft(): Err {
  return err('CONFLICT', '這份草稿剛剛在別的分頁或裝置上存過了。請重新載入看最新的內容；畫面上的輸入不會自動蓋過去。')
}

function authorizeStudent(actor: ResolvedActor): Err | null {
  const blocked = statusGate(actor, 'business')
  if (blocked) return err(blocked, '請先登入並完成帳號設定。')
  if (actor.kind !== 'authenticated' || !actor.roles.includes('student')) return err('FORBIDDEN', '只有學生可以填寫收件。')
  return null
}

export class PgSubmissionCommand implements SubmissionCommand {
  readonly #audit: AuditWriter<PoolClient>
  readonly #ledger: OperationLedger<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #pool: PoolSource
  readonly #realClock: Clock

  constructor(deps: Deps) {
    this.#audit = deps.audit
    this.#ledger = deps.ledger
    this.#businessClock = deps.businessClock
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
    const denied = authorizeStudent(actor)
    if (denied || actor.kind !== 'authenticated') return denied ?? err('UNAUTHENTICATED', '請先登入。')
    if (!isUuid(requestId)) return badRequestId()
    if (!isUuid(itemId)) return notInRoster()
    if (!Number.isInteger(revision) || revision < 0) return staleDraft()
    const userId = actor.userId
    const businessAt = await this.#businessClock.now()

    return this.#run(async (tx) => {
      const locked = await this.#lock(tx, itemId, userId)
      if (!locked) return notInRoster()

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

      const draft = await this.#lockDraft(tx, itemId, userId)
      if ((draft?.revision ?? 0) !== revision) return staleDraft()
      const normalized = normalizeAnswers(schema.fields, answers)
      if (!normalized.ok) {
        return err('VALIDATION_FAILED', normalized.issue.message, { details: { field: normalized.issue.key } })
      }

      let nextRevision: number
      if (!draft) {
        nextRevision = 1
        await tx.query(
          `insert into submission_drafts
             (id, item_id, receiver_kind, receiver_id, schema_version_id, answers,
              created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
           values ($1, $2, 'user', $3, $4, $5::jsonb, $6, 'user', $3, $6, $3)`,
          [uuidv7(), itemId, userId, schema.id, JSON.stringify(normalized.value), realAt],
        )
      } else {
        nextRevision = draft.revision + 1
        await tx.query(
          `update submission_drafts
              set answers = $2::jsonb, schema_version_id = $3, revision = revision + 1, updated_at = $4, updated_by_user_id = $5
            where id = $1`,
          [draft.id, JSON.stringify(normalized.value), schema.id, realAt, userId],
        )
      }

      const receipt = { itemId, revision: nextRevision, savedAt: realAt.toISOString(), requestId, serverTime: realAt.toISOString() }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId, revision: nextRevision } })
      return { ok: true as const, receipt }
    })
  }

  async submit(actor: ResolvedActor, itemId: string, draftRevision: number, requestId: string): Promise<Result<SubmitReceipt>> {
    const denied = authorizeStudent(actor)
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
      const { item } = locked

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

      const draft = await this.#lockDraft(tx, itemId, userId)
      if (!draft) return staleDraft()
      if (draft.schema_version_id !== schema.id || draft.migration_state === 'needs_review') {
        return err('DRAFT_NEEDS_REVIEW', '收件欄位已經改版，請重新載入確認內容後再送出。')
      }
      if (draft.revision !== draftRevision) return staleDraft()
      const issues = submitIssues(schema.fields, draft.answers)
      if (issues.length > 0) {
        return err('VALIDATION_FAILED', describeIssues(issues), {
          details: { field: issues[0]!.key, fields: issues.map((i) => i.key) },
        })
      }

      // 版本號在草稿列鎖內分配（模組實作設計 05 §2）；唯一鍵再擋一次。
      const versionId = uuidv7()
      const inserted = await tx.query<{ version_no: number }>(
        `insert into submission_versions
           (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
            received_real_at, received_business_at, request_id, deadline_version_at_submit)
         select $1, $2, 'user', $3, coalesce(max(version_no), 0) + 1, $4, $5::jsonb, $3, $6, $7, $8, $9
           from submission_versions where item_id = $2 and receiver_kind = 'user' and receiver_id = $3
         returning version_no`,
        [versionId, itemId, userId, schema.id, JSON.stringify(draft.answers), realAt, businessAt, requestId, item.deadline_version],
      )
      const versionNo = inserted.rows[0]!.version_no
      const who = await tx.query<{ name: string }>(
        `select coalesce(p.display_name, u.name) as name from users u left join user_profiles p on p.user_id = u.id where u.id = $1`,
        [userId],
      )

      await this.#audit.append(tx, {
        actorKind: 'user',
        actorUserId: userId,
        role: 'student',
        action: 'submission.submit',
        targetType: SUBJECT_TYPE,
        targetId: itemId,
        scope: 'cohort',
        cohortId: item.cohort_id,
        realAt,
        businessAt,
        // 不放回答內容（契約 01 §4.3：稽核不含私有正文）。
        payload: { receiverKind: 'user', versionNo, schemaVersionNo: schema.versionNo, draftRevision, submissionVersionId: versionId },
      })

      const receipt = {
        itemId,
        title: item.title,
        versionNo,
        receivedBusinessAt: businessAt.toISOString(),
        receivedRealAt: realAt.toISOString(),
        submittedByName: who.rows[0]?.name ?? '',
        schemaVersionNo: schema.versionNo,
        draftRevision,
        requestId,
        serverTime: realAt.toISOString(),
      }
      await this.#ledger.commit(tx, begun.recordId, { receipt, resultRef: { itemId, submissionVersionId: versionId, versionNo } })
      return { ok: true as const, receipt }
    })
  }

  // ── 內部 ────────────────────────────────────────────────────────────────────

  /** 名單 → 屆別 → 項目狀態 → 時間。回 null＝通過。 */
  #guard(locked: Locked, businessAt: Date): Err | null {
    const { item } = locked
    if (!locked.roster || item.receiver_unit !== 'individual') return notInRoster()
    if (locked.roster.exempt) return err('EXEMPTED', '系辦已將你設為免填這份收件，不需要填寫。')
    if (locked.cohortStatus === 'archived') return err('COHORT_ARCHIVED', '這一屆已經封存，不能再填寫或送出。')
    if (item.status !== 'published' || !locked.schema) return err('ITEM_NOT_OPEN', '這份收件目前沒有開放。')
    const phase = phaseOf({ opensAt: item.opens_at, dueAt: item.due_at }, businessAt)
    if (phase === 'not_open') {
      return err('ITEM_NOT_OPEN', `這份收件還沒開放，${formatTaipeiMinute(item.opens_at!)}（臺灣時間）開放。`)
    }
    if (phase === 'closed') {
      return err('DEADLINE_PASSED', `已經截止（截止：${formatTaipeiMinute(item.due_at!)}，含此分鐘，臺灣時間）；需要補交請聯絡系辦。`)
    }
    return null
  }

  /** 鎖序：屆別（共享）→ 項目（共享）。順便讀本人的名單列與目前的欄位版本。 */
  async #lock(tx: PoolClient, itemId: string, userId: string): Promise<Locked | null> {
    const head = await tx.query<{ cohort_id: string }>('select cohort_id from managed_items where id = $1', [itemId])
    const cohortId = head.rows[0]?.cohort_id
    if (!cohortId) return null
    const cohort = await tx.query<{ status: string }>('select status from cohorts where id = $1 for share', [cohortId])
    const found = await tx.query<ItemRow>(
      `select id, cohort_id, title, status, receiver_unit, opens_at, due_at, deadline_version, current_schema_version_id
         from managed_items where id = $1 for share`,
      [itemId],
    )
    const item = found.rows[0]
    if (!item || !cohort.rows[0]) return null
    const roster = await tx.query<{ exempt: boolean }>(
      `select exempt from response_rosters
        where item_id = $1 and receiver_kind = 'user' and receiver_id = $2 and eligible_to_business_at is null`,
      [itemId, userId],
    )
    const schema = item.current_schema_version_id
      ? await tx.query<{ id: string; version_no: number; schema: { fields?: FormField[] } }>(
          'select id, version_no, schema from form_schema_versions where id = $1',
          [item.current_schema_version_id],
        )
      : null
    const schemaRow = schema?.rows[0]
    return {
      item,
      cohortStatus: cohort.rows[0].status,
      roster: roster.rows[0] ?? null,
      schema: schemaRow ? { id: schemaRow.id, versionNo: schemaRow.version_no, fields: schemaRow.schema.fields ?? [] } : null,
    }
  }

  async #lockDraft(tx: PoolClient, itemId: string, userId: string): Promise<DraftRow | null> {
    const found = await tx.query<DraftRow>(
      `select id, revision, schema_version_id, migration_state, answers from submission_drafts
        where item_id = $1 and receiver_kind = 'user' and receiver_id = $2 for update`,
      [itemId, userId],
    )
    return found.rows[0] ?? null
  }

  #run<R>(body: (tx: PoolClient) => Promise<Result<R>>): Promise<Result<R>> {
    return inTransaction(this.#pool, 'submissions', body, (constraint) =>
      constraint === 'submission_drafts_receiver_unique'
        ? staleDraft()
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
  stage_name: string | null
  opens_at: Date | null
  due_at: Date | null
  attachment_count: string
  exempt: boolean
  has_draft: boolean
  latest_version_no: number | null
  latest_received_at: Date | null
}

export type VersionRow = {
  version_no: number
  received_business_at: Date
  received_real_at: Date
  submitted_by_name: string
  schema_version_no: number
  request_id: string
}

export const VERSION_COLUMNS = `
  v.version_no, v.received_business_at, v.received_real_at, v.request_id,
  coalesce(p.display_name, u.name) as submitted_by_name, sv.version_no as schema_version_no`

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

export function toSummary(row: VersionRow): VersionSummary {
  return {
    versionNo: row.version_no,
    receivedBusinessAt: row.received_business_at,
    receivedRealAt: row.received_real_at,
    submittedByName: row.submitted_by_name,
    schemaVersionNo: row.schema_version_no,
    requestId: row.request_id,
  }
}

export class PgSubmissionQuery implements SubmissionQuery {
  readonly #reader: Reader

  constructor(reader: Reader = getPool) {
    this.#reader = reader
  }

  async myItems(userId: string): Promise<MyItemRow[]> {
    if (!isUuid(userId)) return []
    const rows = await this.#reader().query<ListRow>(
      `select m.id, m.title, s.name as stage_name, m.opens_at, m.due_at, r.exempt,
              (select count(*) from item_attachments a where a.item_id = m.id) as attachment_count,
              facts.has_draft, latest.version_no as latest_version_no, latest.received_business_at as latest_received_at
         from response_rosters r
         join managed_items m on m.id = r.item_id
         left join cohort_stages s on s.id = m.stage_id
         ${receiverFactsJoin('m.id', 'r.receiver_kind', 'r.receiver_id')}
        where r.receiver_kind = 'user' and r.receiver_id = $1 and r.eligible_to_business_at is null
          and m.status = 'published' and m.receiver_unit = 'individual'
        order by m.due_at nulls last, m.title`,
      [userId],
    )
    return rows.rows.map((r) => ({
      itemId: r.id,
      title: r.title,
      stageName: r.stage_name,
      opensAt: r.opens_at,
      dueAt: r.due_at,
      attachmentCount: Number(r.attachment_count),
      exempt: r.exempt,
      hasDraft: r.has_draft,
      latestVersionNo: r.latest_version_no,
      latestReceivedAt: r.latest_received_at,
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
      schema_version_no: number
      schema: { fields?: FormField[] }
    }>(
      `select m.id, cv.title, cv.summary, cv.body_html, s.name as stage_name, m.opens_at, m.due_at, r.exempt,
              sv.version_no as schema_version_no, sv.schema
         from response_rosters r
         join managed_items m on m.id = r.item_id
         join item_versions cv on cv.id = m.current_content_version_id
         join form_schema_versions sv on sv.id = m.current_schema_version_id
         left join cohort_stages s on s.id = m.stage_id
        where r.receiver_kind = 'user' and r.receiver_id = $1 and r.eligible_to_business_at is null
          and m.status = 'published' and m.receiver_unit = 'individual' and m.id = $2`,
      [userId, itemId],
    )
    const item = found.rows[0]
    if (!item) return null
    const [files, draft, versions] = await Promise.all([
      db.query<{ id: string; original_name: string; size_bytes: string | null }>(
        `select f.id, f.original_name, f.size_bytes from item_attachments a join stored_files f on f.id = a.file_id
          where a.item_id = $1 order by a.sort, f.id`,
        [itemId],
      ),
      db.query<{ answers: Answers; revision: number; updated_at: Date }>(
        `select answers, revision, updated_at from submission_drafts
          where item_id = $1 and receiver_kind = 'user' and receiver_id = $2`,
        [itemId, userId],
      ),
      db.query<VersionRow>(
        `select ${VERSION_COLUMNS} from submission_versions v ${VERSION_JOINS}
          where v.item_id = $1 and v.receiver_kind = 'user' and v.receiver_id = $2
          order by v.version_no desc`,
        [itemId, userId],
      ),
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
      fields: item.schema.fields ?? [],
      exempt: item.exempt,
      draft: draftRow ? { answers: draftRow.answers, revision: draftRow.revision, updatedAt: draftRow.updated_at } : null,
      versions: versions.rows.map(toSummary),
    }
  }

  async myVersion(userId: string, itemId: string, versionNo: number): Promise<MyVersionDetail | null> {
    // 只看「自己的」版本：收件者就是本人。不另外要求目前還在名單上——本人唯讀自己的正式版本（產品模組 05 §8）。
    return versionDetail(this.#reader(), itemId, 'user', userId, versionNo)
  }
}

/** 某個收件者某一次正式送出的內容（本人的繳交歷史與管理員名單頁共用）。 */
export async function versionDetail(
  db: Pick<Pool, 'query'>,
  itemId: string,
  receiverKind: 'user' | 'group',
  receiverId: string,
  versionNo: number,
): Promise<MyVersionDetail | null> {
  if (!isUuid(receiverId) || !isUuid(itemId) || !Number.isInteger(versionNo) || versionNo < 1) return null
  const found = await db.query<VersionRow & { answers: Answers; schema: { fields?: FormField[] }; latest: number }>(
    `select ${VERSION_COLUMNS}, v.answers, sv.schema,
            (select max(x.version_no) from submission_versions x
              where x.item_id = v.item_id and x.receiver_kind = v.receiver_kind and x.receiver_id = v.receiver_id) as latest
       from submission_versions v ${VERSION_JOINS}
      where v.item_id = $1 and v.receiver_kind = $2 and v.receiver_id = $3 and v.version_no = $4`,
    [itemId, receiverKind, receiverId, versionNo],
  )
  const row = found.rows[0]
  if (!row) return null
  return { ...toSummary(row), isLatest: row.latest === row.version_no, fields: row.schema.fields ?? [], answers: row.answers }
}
