import 'server-only'
import type { Pool } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import {
  canReadSubmission,
  type AdvisedGroup,
  type AdvisorIndividualItem,
  type AdvisorItemView,
  type AdvisorMatrix,
  type AdvisorMatrixCell,
  type AdvisorMatrixItem,
  type AdvisorReceiverView,
  type AdvisorSubmissionQuery,
  type MyVersionDetail,
  type RosterEntry,
  type RosterItem,
  type SubmissionViewer,
} from '@/application/submissions'
import { getPool } from '@/infrastructure/db/client'
import { rosterItemOf, toEntry, type EntryRow } from '@/infrastructure/submissions/pg-roster'
import { isUuid, toSummary, VERSION_COLUMNS, VERSION_JOINS, versionDetail, type VersionRow } from '@/infrastructure/submissions/pg-submissions'
import { holderOf, VERSION_ACCESS_COLUMNS, viewerOf, type VersionAccessRow } from '@/infrastructure/submissions/version-access'

/**
 * 主指導看繳交（票 22；原型 `/dashboard/teacher/affairs` 的「指導組別 × 收件項目」矩陣與 `/dashboard/teacher/affairs/[id]`）。
 *
 * - **只看此刻的指導關係**：`advisor_assignments.valid_to IS NULL`、組別沒解散、組別屆別＝項目屆別（契約 03 §1）。
 *   換掉的老師下一次打開就是空的；歷史指導關係只用於追溯，不給權限。
 * - **整組一份**：矩陣每格＝那一組在這份收件上的狀態（名單列＋最後一次正式送出）；點進去看每一次正式送出。
 * - **個人一份**：只有管理員開了主指導閱覽的收件才出現，而且只列老師此刻指導的組裡的學生、
 *   只算欄位版本 ≥ 生效版本的正式送出（產品模組 05 §4「誰看得到個人回答」、SUB-24）。
 * - **草稿一律不給**：連「有沒有草稿」都不透露（`hasDraft` 固定 false），矩陣上沒交就是「未繳」。
 * - 版本列表與單一版本都經 `canReadSubmission`（事實用 `VERSION_ACCESS_COLUMNS`，跟附件下載政策同一段 SQL）：
 *   列得出來的版本就是點得開、下載得到的那幾版。
 */

type Reader = () => Pick<Pool, 'query'>

function isTeacher(actor: ResolvedActor): actor is Extract<ResolvedActor, { kind: 'authenticated' }> {
  return statusGate(actor, 'business') === null && actor.kind === 'authenticated' && actor.roles.includes('teacher')
}

/** 老師此刻指導、沒解散的組別（`$1`＝老師）。 */
const MY_GROUPS = `
  select g.id, g.code, g.group_type, g.cohort_id
    from advisor_assignments a join groups g on g.id = a.group_id
   where a.teacher_user_id = $1 and a.valid_to is null and g.status = 'active'`

/** 名單列取一列：目前那一列優先，否則最後一次移出的（跟管理員名單頁同一個排序）。 */
const PICK_ORDER = `(r.eligible_to_business_at is null) desc, r.eligible_to_business_at desc nulls first, r.eligible_from_business_at desc, r.id desc`

/** 最後一次正式送出與送出者（`r`＝名單列；`extra`＝個人一份時只算老師看得到的欄位版本）。 */
function latestJoin(extra: string): string {
  return `
    left join lateral (
      select v.version_no, v.received_business_at, v.submitted_by_user_id from submission_versions v
        join form_schema_versions lsv on lsv.id = v.schema_version_id
       where v.item_id = r.item_id and v.receiver_kind = r.receiver_kind and v.receiver_id = r.receiver_id ${extra}
       order by v.version_no desc limit 1
    ) latest on true
    left join users su on su.id = latest.submitted_by_user_id
    left join user_profiles sp on sp.user_id = latest.submitted_by_user_id`
}

/**
 * 老師看某一份整組收件：自己此刻指導的組的名單列。`$1`＝項目、`$2`＝老師、`$3`＝項目屆別、`$4`＝只看某一組（null＝全部）。
 */
const GROUP_ENTRIES = `
  with mine as (${MY_GROUPS.replace('$1', '$2')} and g.cohort_id = $3),
  picked as (
    select distinct on (r.receiver_id) r.* from response_rosters r
     where r.item_id = $1 and r.receiver_kind = 'group' and r.receiver_id in (select id from mine)
       and ($4::uuid is null or r.receiver_id = $4::uuid)
     order by r.receiver_id, ${PICK_ORDER}
  )
  select r.receiver_kind, r.receiver_id, gr.code as name, null::text as student_no, gr.code as group_code,
         r.eligible_from_business_at, r.eligible_to_business_at, r.source, r.exempt, r.exempt_reason, r.removed_reason,
         false as has_draft, latest.version_no as latest_version_no, latest.received_business_at as latest_received_at,
         coalesce(sp.display_name, su.name) as latest_submitted_by_name
    from picked r join groups gr on gr.id = r.receiver_id
    ${latestJoin('')}
   order by (r.eligible_to_business_at is not null), r.exempt, gr.code`

/**
 * 老師看某一份個人收件（開放主指導閱覽）：自己此刻指導的組裡、此刻還在組裡的學生的名單列。
 * `$1`＝項目、`$2`＝老師、`$3`＝項目屆別、`$4`＝只看某一位（null＝全部）、`$5`＝生效欄位版本。
 */
const STUDENT_ENTRIES = `
  with mine as (
    select gm.user_id, g.code from (${MY_GROUPS.replace('$1', '$2')} and g.cohort_id = $3) g
      join group_memberships gm on gm.group_id = g.id and gm.valid_to is null
  ),
  picked as (
    select distinct on (r.receiver_id) r.* from response_rosters r
     where r.item_id = $1 and r.receiver_kind = 'user' and r.receiver_id in (select user_id from mine)
       and ($4::uuid is null or r.receiver_id = $4::uuid)
     order by r.receiver_id, ${PICK_ORDER}
  )
  select r.receiver_kind, r.receiver_id, coalesce(p.display_name, u.name) as name,
         coalesce(si.student_no, p.student_no) as student_no, mine.code as group_code,
         r.eligible_from_business_at, r.eligible_to_business_at, r.source, r.exempt, r.exempt_reason, r.removed_reason,
         false as has_draft, latest.version_no as latest_version_no, latest.received_business_at as latest_received_at,
         coalesce(sp.display_name, su.name) as latest_submitted_by_name
    from picked r
    join mine on mine.user_id = r.receiver_id
    left join users u on u.id = r.receiver_id
    left join user_profiles p on p.user_id = r.receiver_id
    left join student_identities si on si.user_id = r.receiver_id and si.cohort_id = r.cohort_id
    ${latestJoin('and lsv.version_no >= $5')}
   order by (r.eligible_to_business_at is not null), r.exempt, group_code, student_no nulls last, name`

/** 這份收件最新的主指導閱覽設定（只插不改，最新一列為準）。 */
async function latestVisibility(db: Pick<Pool, 'query'>, itemId: string): Promise<{ enabled: boolean; effective: number } | null> {
  const found = await db.query<{ enabled: boolean; effective_from_version_no: number }>(
    `select enabled, effective_from_version_no from advisor_visibility_settings
      where item_id = $1 order by set_at desc, id desc limit 1`,
    [itemId],
  )
  const row = found.rows[0]
  return row ? { enabled: row.enabled, effective: row.effective_from_version_no } : null
}

export class PgAdvisorSubmissionQuery implements AdvisorSubmissionQuery {
  readonly #reader: Reader

  constructor(reader: Reader = getPool) {
    this.#reader = reader
  }

  async matrix(actor: ResolvedActor): Promise<AdvisorMatrix | null> {
    if (!isTeacher(actor)) return null
    const db = this.#reader()
    const groups = await db.query<{
      id: string
      code: string
      group_type: 'general' | 'industry'
      cohort_id: string
      cohort_code: string
      member_names: string[] | null
    }>(
      `select g.id, g.code, g.group_type, g.cohort_id, c.code as cohort_code,
              (select array_agg(coalesce(p.display_name, u.name) order by coalesce(p.display_name, u.name))
                 from group_memberships gm join users u on u.id = gm.user_id left join user_profiles p on p.user_id = gm.user_id
                where gm.group_id = g.id and gm.valid_to is null) as member_names
         from (${MY_GROUPS}) g join cohorts c on c.id = g.cohort_id
        order by c.code desc, g.code`,
      [actor.userId],
    )
    const advised: AdvisedGroup[] = groups.rows.map((g) => ({
      groupId: g.id,
      code: g.code,
      groupType: g.group_type,
      cohortId: g.cohort_id,
      cohortCode: g.cohort_code,
      memberNames: g.member_names ?? [],
    }))
    if (advised.length === 0) return { groups: [], items: [], cells: [], individualItems: [] }
    const cohortIds = [...new Set(advised.map((g) => g.cohortId))]
    const groupIds = advised.map((g) => g.groupId)

    const [items, cells, individual] = await Promise.all([
      db.query<{ id: string; title: string; cohort_id: string; stage_name: string | null; opens_at: Date | null; due_at: Date | null }>(
        `select m.id, m.title, m.cohort_id, s.name as stage_name, m.opens_at, m.due_at
           from managed_items m left join cohort_stages s on s.id = m.stage_id
          where m.cohort_id = any($1::uuid[]) and m.status = 'published' and m.receiver_unit = 'group'
          order by m.due_at nulls last, m.title`,
        [cohortIds],
      ),
      db.query<{
        item_id: string
        receiver_id: string
        eligible_to_business_at: Date | null
        exempt: boolean
        latest_version_no: number | null
        latest_received_at: Date | null
        latest_submitted_by_name: string | null
      }>(
        `with picked as (
           select distinct on (r.item_id, r.receiver_id) r.* from response_rosters r
             join managed_items m on m.id = r.item_id and m.status = 'published' and m.receiver_unit = 'group'
            where r.receiver_kind = 'group' and r.receiver_id = any($1::uuid[])
            order by r.item_id, r.receiver_id, ${PICK_ORDER}
         )
         select r.item_id, r.receiver_id, r.eligible_to_business_at, r.exempt,
                latest.version_no as latest_version_no, latest.received_business_at as latest_received_at,
                coalesce(sp.display_name, su.name) as latest_submitted_by_name
           from picked r ${latestJoin('')}`,
        [groupIds],
      ),
      db.query<{
        id: string
        title: string
        cohort_id: string
        stage_name: string | null
        opens_at: Date | null
        due_at: Date | null
        effective_from_version_no: number
        required: string
        submitted: string
      }>(
        `with mine as (
           select gm.user_id, g.cohort_id from (${MY_GROUPS}) g join group_memberships gm on gm.group_id = g.id and gm.valid_to is null
         )
         select m.id, m.title, m.cohort_id, s.name as stage_name, m.opens_at, m.due_at, vs.effective_from_version_no,
                (select count(*) from response_rosters r
                  where r.item_id = m.id and r.receiver_kind = 'user' and r.eligible_to_business_at is null and not r.exempt
                    and r.receiver_id in (select user_id from mine where mine.cohort_id = m.cohort_id)) as required,
                (select count(*) from response_rosters r
                  where r.item_id = m.id and r.receiver_kind = 'user' and r.eligible_to_business_at is null and not r.exempt
                    and r.receiver_id in (select user_id from mine where mine.cohort_id = m.cohort_id)
                    and exists (select 1 from submission_versions v join form_schema_versions sv on sv.id = v.schema_version_id
                                 where v.item_id = m.id and v.receiver_kind = 'user' and v.receiver_id = r.receiver_id
                                   and sv.version_no >= vs.effective_from_version_no)) as submitted
           from managed_items m
           left join cohort_stages s on s.id = m.stage_id
           join lateral (select x.enabled, x.effective_from_version_no from advisor_visibility_settings x
                          where x.item_id = m.id order by x.set_at desc, x.id desc limit 1) vs on vs.enabled
          where m.cohort_id = any($2::uuid[]) and m.status = 'published' and m.receiver_unit = 'individual'
          order by m.due_at nulls last, m.title`,
        [actor.userId, cohortIds],
      ),
    ])
    const toItem = (r: { id: string; title: string; cohort_id: string; stage_name: string | null; opens_at: Date | null; due_at: Date | null }): AdvisorMatrixItem => ({
      itemId: r.id,
      title: r.title,
      cohortId: r.cohort_id,
      stageName: r.stage_name,
      opensAt: r.opens_at,
      dueAt: r.due_at,
    })
    return {
      groups: advised,
      items: items.rows.map(toItem),
      cells: cells.rows.map(
        (c): AdvisorMatrixCell => ({
          groupId: c.receiver_id,
          itemId: c.item_id,
          eligibleTo: c.eligible_to_business_at,
          exempt: c.exempt,
          latestVersionNo: c.latest_version_no,
          latestReceivedAt: c.latest_received_at,
          latestSubmittedByName: c.latest_submitted_by_name,
        }),
      ),
      individualItems: individual.rows.map(
        (r): AdvisorIndividualItem => ({
          ...toItem(r),
          effectiveFromVersionNo: r.effective_from_version_no,
          required: Number(r.required),
          submitted: Number(r.submitted),
        }),
      ),
    }
  }

  async item(actor: ResolvedActor, itemId: string): Promise<AdvisorItemView | null> {
    if (!isTeacher(actor) || !isUuid(itemId)) return null
    const scoped = await this.#scope(actor.userId, itemId, null)
    if (!scoped) return null
    return { item: scoped.item, entries: scoped.entries, effectiveFromVersionNo: scoped.effective }
  }

  async receiver(actor: ResolvedActor, itemId: string, receiverId: string): Promise<AdvisorReceiverView | null> {
    if (!isTeacher(actor) || !isUuid(itemId) || !isUuid(receiverId)) return null
    const scoped = await this.#scope(actor.userId, itemId, receiverId)
    const entry = scoped?.entries[0]
    if (!scoped || !entry) return null
    const db = this.#reader()
    const viewer = await viewerOf(db, actor)
    if (!viewer) return null
    const rows = await db.query<VersionRow & VersionAccessRow>(
      `select ${VERSION_COLUMNS}, ${VERSION_ACCESS_COLUMNS}
         from submission_versions v ${VERSION_JOINS}
         join managed_items m on m.id = v.item_id
        where v.item_id = $1 and v.receiver_kind = $2 and v.receiver_id = $3
        order by v.version_no desc`,
      [itemId, entry.receiverKind, receiverId],
    )
    return { item: scoped.item, entry, versions: readable(viewer, rows.rows).map(toSummary) }
  }

  async receiverVersion(actor: ResolvedActor, itemId: string, receiverId: string, versionNo: number): Promise<MyVersionDetail | null> {
    if (!isTeacher(actor) || !isUuid(itemId) || !isUuid(receiverId) || !Number.isInteger(versionNo) || versionNo < 1) return null
    const db = this.#reader()
    const viewer = await viewerOf(db, actor)
    if (!viewer) return null
    // 這一版能不能讀，跟附件下載政策同一段事實、同一個規則。
    const found = await db.query<VersionAccessRow>(
      `select ${VERSION_ACCESS_COLUMNS}
         from submission_versions v
         join managed_items m on m.id = v.item_id
         join form_schema_versions sv on sv.id = v.schema_version_id
        where v.item_id = $1 and v.receiver_id = $2 and v.version_no = $3`,
      [itemId, receiverId, versionNo],
    )
    const row = found.rows[0]
    if (!row || !canReadSubmission(viewer, holderOf(row))) return null
    return versionDetail(db, itemId, row.receiver_kind, receiverId, versionNo)
  }

  /**
   * 老師在這份收件上看得到的名單列：整組一份＝自己指導的組；個人一份＝開了主指導閱覽才有，自己指導的組裡的學生。
   * 其他（沒發布、沒有自己的組在名單上、個人收件沒開閱覽）回 null。
   */
  async #scope(
    teacherId: string,
    itemId: string,
    receiverId: string | null,
  ): Promise<{ item: RosterItem; entries: RosterEntry[]; effective: number | null } | null> {
    const db = this.#reader()
    const item = await rosterItemOf(db, itemId)
    if (!item || item.status !== 'published') return null
    if (item.receiverUnit === 'group') {
      const rows = await db.query<EntryRow>(GROUP_ENTRIES, [itemId, teacherId, item.cohortId, receiverId])
      if (rows.rows.length === 0) return null
      return { item, entries: rows.rows.map(toEntry), effective: null }
    }
    const visibility = await latestVisibility(db, itemId)
    if (!visibility?.enabled) return null
    const rows = await db.query<EntryRow>(STUDENT_ENTRIES, [itemId, teacherId, item.cohortId, receiverId, visibility.effective])
    if (receiverId && rows.rows.length === 0) return null
    return { item, entries: rows.rows.map(toEntry), effective: visibility.effective }
  }
}

/** 只留看的人讀得到的版本（規則在 application 的 `canReadSubmission`）。 */
function readable<R extends VersionAccessRow>(viewer: SubmissionViewer, rows: readonly R[]): R[] {
  return rows.filter((row) => canReadSubmission(viewer, holderOf(row)))
}
