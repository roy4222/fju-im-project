import 'server-only'
import type { Pool } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import type { FormField, ItemStatus, ReceiverUnit } from '@/application/items'
import type {
  ItemRoster,
  MyVersionDetail,
  ReceiverDetail,
  RosterEntry,
  RosterItem,
  RosterQuery,
  RosterSpan,
} from '@/application/submissions'
import { authorizeAdmin } from '@/infrastructure/cohorts/shared'
import { getPool } from '@/infrastructure/db/client'
import {
  isUuid,
  receiverFactsJoin,
  toSummary,
  VERSION_COLUMNS,
  VERSION_JOINS,
  versionDetail,
  type VersionRow,
} from '@/infrastructure/submissions/pg-submissions'

/**
 * 收件名單頁的查詢（票 18；產品模組 05 §4「個人填報與收件名單」：目前名單、免填、已移出分開，完成率的分子分母）。
 *
 * - 授權：每個方法先判「系辦管理員」（帳號正常＋管理員角色），不是就回 null——頁面的角色守衛不是唯一的一道。
 *   老師預設看不到個人回答；主指導閱覽在票 21／22 接上。
 * - 名單：同一個收件者可能有多列（移出後又加回）。取「目前那一列」；沒有目前的，取最後一次移出的那一列。
 *   分類與完成率由 application 的 `categoryOf`／`completionOf` 算（畫面呼叫），這裡只給事實。
 * - 草稿、最後一次正式送出用 `receiverFactsJoin`：與學生作業區同一段 SQL。
 * - 已移出的人：回答保留、管理員仍查得到（產品模組 05 Q-SUB03），所以版本不要求目前還在名單上。
 */

type Reader = () => Pick<Pool, 'query'>

type ItemHead = {
  id: string
  cohort_id: string
  cohort_code: string
  title: string
  status: ItemStatus
  receiver_unit: ReceiverUnit
  stage_name: string | null
  opens_at: Date | null
  due_at: Date | null
  schema_version_no: number | null
  schema: { fields?: FormField[] } | null
}

type EntryRow = {
  receiver_kind: 'user' | 'group'
  receiver_id: string
  name: string | null
  student_no: string | null
  group_code: string | null
  eligible_from_business_at: Date
  eligible_to_business_at: Date | null
  source: 'auto' | 'admin'
  exempt: boolean
  exempt_reason: string | null
  removed_reason: string | null
  has_draft: boolean
  latest_version_no: number | null
  latest_received_at: Date | null
  latest_submitted_by_name: string | null
}

/**
 * 每個收件者取一列：目前那一列優先，否則最後一次移出的。`$1`＝項目；`$2`＝只看某一位（null＝全部）。
 * 人的學號看本屆學籍（沒有就看個人資料），組別看本屆目前的組；組別收件的名稱就是組別代號。
 */
const ENTRIES = `
  with picked as (
    select distinct on (r.receiver_kind, r.receiver_id) r.*
      from response_rosters r
     where r.item_id = $1 and ($2::uuid is null or r.receiver_id = $2::uuid)
     order by r.receiver_kind, r.receiver_id, (r.eligible_to_business_at is null) desc,
              r.eligible_to_business_at desc nulls first, r.eligible_from_business_at desc, r.id desc
  )
  select r.receiver_kind, r.receiver_id,
         case when r.receiver_kind = 'group' then gr.code else coalesce(p.display_name, u.name) end as name,
         case when r.receiver_kind = 'user' then coalesce(si.student_no, p.student_no) end as student_no,
         case when r.receiver_kind = 'group' then gr.code else ug.code end as group_code,
         r.eligible_from_business_at, r.eligible_to_business_at, r.source, r.exempt, r.exempt_reason, r.removed_reason,
         facts.has_draft, latest.version_no as latest_version_no, latest.received_business_at as latest_received_at,
         coalesce(sp.display_name, su.name) as latest_submitted_by_name
    from picked r
    left join users u on r.receiver_kind = 'user' and u.id = r.receiver_id
    left join user_profiles p on r.receiver_kind = 'user' and p.user_id = r.receiver_id
    left join student_identities si on r.receiver_kind = 'user' and si.user_id = r.receiver_id and si.cohort_id = r.cohort_id
    left join group_memberships gm
      on r.receiver_kind = 'user' and gm.user_id = r.receiver_id and gm.cohort_id = r.cohort_id and gm.valid_to is null
    left join groups ug on ug.id = gm.group_id
    left join groups gr on r.receiver_kind = 'group' and gr.id = r.receiver_id
    ${receiverFactsJoin('r.item_id', 'r.receiver_kind', 'r.receiver_id')}
    left join users su on su.id = latest.submitted_by_user_id
    left join user_profiles sp on sp.user_id = latest.submitted_by_user_id
   order by (r.eligible_to_business_at is not null), r.exempt, group_code nulls last, student_no nulls last, name`

function toEntry(row: EntryRow): RosterEntry {
  return {
    receiverKind: row.receiver_kind,
    receiverId: row.receiver_id,
    name: row.name ?? '（已刪除的帳號）',
    studentNo: row.student_no,
    groupCode: row.group_code,
    eligibleFrom: row.eligible_from_business_at,
    eligibleTo: row.eligible_to_business_at,
    source: row.source,
    exempt: row.exempt,
    exemptReason: row.exempt_reason,
    removedReason: row.removed_reason,
    hasDraft: row.has_draft,
    latestVersionNo: row.latest_version_no,
    latestReceivedAt: row.latest_received_at,
    latestSubmittedByName: row.latest_submitted_by_name,
  }
}

export class PgRosterQuery implements RosterQuery {
  readonly #reader: Reader

  constructor(reader: Reader = getPool) {
    this.#reader = reader
  }

  async roster(actor: ResolvedActor, itemId: string): Promise<ItemRoster | null> {
    if (authorizeAdmin(actor) || !isUuid(itemId)) return null
    const item = await this.#item(itemId)
    if (!item) return null
    const rows = await this.#reader().query<EntryRow>(ENTRIES, [itemId, null])
    return { item, entries: rows.rows.map(toEntry) }
  }

  async receiver(actor: ResolvedActor, itemId: string, receiverId: string): Promise<ReceiverDetail | null> {
    if (authorizeAdmin(actor) || !isUuid(itemId) || !isUuid(receiverId)) return null
    const item = await this.#item(itemId)
    if (!item) return null
    const db = this.#reader()
    const found = await db.query<EntryRow>(ENTRIES, [itemId, receiverId])
    const row = found.rows[0]
    if (!row) return null
    const kind = row.receiver_kind
    const [spans, draft, versions] = await Promise.all([
      db.query<{
        eligible_from_business_at: Date
        eligible_to_business_at: Date | null
        source: 'auto' | 'admin'
        exempt: boolean
        exempt_reason: string | null
        removed_reason: string | null
      }>(
        `select eligible_from_business_at, eligible_to_business_at, source, exempt, exempt_reason, removed_reason
           from response_rosters where item_id = $1 and receiver_kind = $2 and receiver_id = $3
          order by eligible_from_business_at desc, id desc`,
        [itemId, kind, receiverId],
      ),
      db.query<{ updated_at: Date }>(
        'select updated_at from submission_drafts where item_id = $1 and receiver_kind = $2 and receiver_id = $3',
        [itemId, kind, receiverId],
      ),
      db.query<VersionRow>(
        `select ${VERSION_COLUMNS} from submission_versions v ${VERSION_JOINS}
          where v.item_id = $1 and v.receiver_kind = $2 and v.receiver_id = $3
          order by v.version_no desc`,
        [itemId, kind, receiverId],
      ),
    ])
    return {
      item,
      entry: toEntry(row),
      spans: spans.rows.map(
        (s): RosterSpan => ({
          eligibleFrom: s.eligible_from_business_at,
          eligibleTo: s.eligible_to_business_at,
          source: s.source,
          exempt: s.exempt,
          exemptReason: s.exempt_reason,
          removedReason: s.removed_reason,
        }),
      ),
      draftUpdatedAt: draft.rows[0]?.updated_at ?? null,
      versions: versions.rows.map(toSummary),
    }
  }

  async receiverVersion(actor: ResolvedActor, itemId: string, receiverId: string, versionNo: number): Promise<MyVersionDetail | null> {
    if (authorizeAdmin(actor) || !isUuid(itemId) || !isUuid(receiverId)) return null
    // 收件者要真的在（或曾經在）這份收件的名單上；種類跟著名單列走。
    const found = await this.#reader().query<{ receiver_kind: 'user' | 'group' }>(
      'select receiver_kind from response_rosters where item_id = $1 and receiver_id = $2 limit 1',
      [itemId, receiverId],
    )
    const kind = found.rows[0]?.receiver_kind
    if (!kind) return null
    return versionDetail(this.#reader(), itemId, kind, receiverId, versionNo)
  }

  async #item(itemId: string): Promise<RosterItem | null> {
    const found = await this.#reader().query<ItemHead>(
      `select m.id, m.cohort_id, c.code as cohort_code, m.title, m.status, m.receiver_unit, s.name as stage_name,
              m.opens_at, m.due_at, sv.version_no as schema_version_no, sv.schema
         from managed_items m
         join cohorts c on c.id = m.cohort_id
         left join cohort_stages s on s.id = m.stage_id
         left join form_schema_versions sv on sv.id = m.current_schema_version_id
        where m.id = $1 and m.receiver_unit <> 'none'`,
      [itemId],
    )
    const row = found.rows[0]
    if (!row) return null
    return {
      itemId: row.id,
      cohortId: row.cohort_id,
      cohortCode: row.cohort_code,
      title: row.title,
      status: row.status,
      receiverUnit: row.receiver_unit,
      stageName: row.stage_name,
      opensAt: row.opens_at,
      dueAt: row.due_at,
      schemaVersionNo: row.schema_version_no,
      fields: row.schema?.fields ?? [],
    }
  }
}
