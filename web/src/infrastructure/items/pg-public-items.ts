import 'server-only'
import type { Pool } from 'pg'
import type { ResolvedActor } from '@/application/accounts'
import {
  canViewItem,
  isUuid,
  publicAccessOf,
  renderBodyHtml,
  type AudienceKind,
  type ItemFileSummary,
  type ItemStatus,
  type MyDeadline,
  type Placement,
  type PublicItemCard,
  type PublicItemPage,
  type PublicItemQuery,
  type PublicListFilter,
  type ReceiverUnit,
  type Viewer,
} from '@/application/items'
import { getPool } from '@/infrastructure/db/client'
import { viewerOf } from '@/infrastructure/items/viewer'

/**
 * 前台內容頁與學生日曆的查詢（票 16；產品模組 09 §9.1、08「站內日曆」）。
 *
 * 前台沒有頁面守門可以依靠，所以**這裡自己依看的人過濾**：
 * - SQL 先用對象條件縮小（訪客只拿得到 `public`），列出來的每一筆再用 `canViewItem` 複核一次，
 *   兩層任何一層寫錯都不會多露資料。
 * - 只回公開欄位：標題、摘要、分類、封面、附件、發布日；正文只在打開單篇時給，而且已經過 `renderBodyHtml`。
 * - 對象細節（哪幾組）、收件名單、欄位、作者都不出現在前台的回應裡。
 */

const DEFAULT_LIMIT = 60
const MAX_LIMIT = 200

type Row = {
  id: string
  placement: Placement
  status: ItemStatus
  title: string
  summary: string
  category: string | null
  audience_kind: AudienceKind
  cohort_id: string
  cover_file_id: string | null
  actual_opened_at: Date | null
  group_ids: string[] | null
}

const COLUMNS = `m.id, m.placement, m.status, m.title, m.summary, m.category, m.audience_kind, m.cohort_id,
       m.cover_file_id, m.actual_opened_at,
       array(select a.group_id from item_audience_groups a where a.item_id = m.id) as group_ids`

/**
 * 對象條件（SQL 這一層）：訪客只有公開；管理員全部；其他人＝公開＋所有登入者＋本屆學生（自己那屆）
 * ＋全部老師（有老師角色）＋指定組別（自己在其中一組）。`$n` 從 `first` 開始編。
 */
function audienceSql(viewer: Viewer, first: number): { sql: string; values: unknown[] } {
  if (viewer.kind === 'anonymous') return { sql: `m.audience_kind = 'public'`, values: [] }
  if (viewer.roles.includes('admin')) return { sql: 'true', values: [] }
  return {
    sql: `(m.audience_kind in ('public', 'signed_in')
           or (m.audience_kind = 'cohort_students' and m.cohort_id = $${first}::uuid)
           or (m.audience_kind = 'teachers' and $${first + 1}::boolean)
           or (m.audience_kind = 'groups' and exists (
                 select 1 from item_audience_groups a where a.item_id = m.id and a.group_id = any($${first + 2}::uuid[]))))`,
    values: [viewer.studentCohortId, viewer.roles.includes('teacher'), viewer.groupIds],
  }
}

function visibilityOf(row: Row) {
  return { status: row.status, audienceKind: row.audience_kind, cohortId: row.cohort_id, groupIds: row.group_ids ?? [] }
}

/** `ilike` 的萬用字元跳脫：搜尋字串裡的 `%`、`_` 當一般字。 */
function likePattern(q: string): string {
  return `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
}

export class PgPublicItemQuery implements PublicItemQuery {
  readonly #reader: () => Pick<Pool, 'query'>

  constructor(reader: () => Pick<Pool, 'query'> = getPool) {
    this.#reader = reader
  }

  async list(actor: ResolvedActor, placement: Placement, filter: PublicListFilter = {}): Promise<PublicItemCard[]> {
    const db = this.#reader()
    const rows = await this.#visibleRows(db, await viewerOf(db, actor), placement, filter)
    return this.#cards(db, rows)
  }

  async fullText(actor: ResolvedActor, placement: Placement): Promise<(PublicItemCard & { readonly bodyHtml: string })[]> {
    const db = this.#reader()
    const rows = await this.#visibleRows(db, await viewerOf(db, actor), placement, { order: 'oldest', limit: MAX_LIMIT })
    const cards = await this.#cards(db, rows)
    return cards.map((card, index) => ({ ...card, bodyHtml: renderBodyHtml(rows[index]!.body_html) }))
  }

  /** 發布中、這個位置、看的人在對象內（SQL 條件＋逐筆 `canViewItem` 複核）。 */
  async #visibleRows(
    db: Pick<Pool, 'query'>,
    viewer: Viewer,
    placement: Placement,
    filter: PublicListFilter,
  ): Promise<(Row & { body_html: string })[]> {
    const values: unknown[] = [placement]
    const where = [`m.placement = $1`, `m.status = 'published'`]
    const category = filter.category?.trim()
    if (category) {
      values.push(category)
      where.push(`m.category = $${values.length}`)
    }
    const q = filter.q?.trim().slice(0, 100)
    if (q) {
      values.push(likePattern(q))
      where.push(`(m.title ilike $${values.length} or m.summary ilike $${values.length})`)
    }
    const audience = audienceSql(viewer, values.length + 1)
    values.push(...audience.values)
    where.push(audience.sql)
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
    values.push(limit)

    const rows = await db.query<Row & { body_html: string }>(
      `select ${COLUMNS}, m.body_html from managed_items m
        where ${where.join(' and ')}
        order by ${filter.order === 'oldest' ? 'm.actual_opened_at asc, m.id asc' : 'm.actual_opened_at desc, m.id desc'}
        limit $${values.length}`,
      values,
    )
    return rows.rows.filter((r) => canViewItem(viewer, visibilityOf(r)))
  }

  async categories(actor: ResolvedActor, placement: Placement): Promise<string[]> {
    const db = this.#reader()
    const viewer = await viewerOf(db, actor)
    const audience = audienceSql(viewer, 2)
    const rows = await db.query<{ category: string }>(
      `select distinct m.category from managed_items m
        where m.placement = $1 and m.status = 'published' and m.category is not null and ${audience.sql}
        order by m.category`,
      [placement, ...audience.values],
    )
    return rows.rows.map((r) => r.category)
  }

  async open(actor: ResolvedActor, itemId: string, placement: Placement): Promise<PublicItemPage> {
    if (!isUuid(itemId)) return { access: 'not_found', placement: null }
    const db = this.#reader()
    const found = await db.query<Row & { body_html: string }>(
      `select ${COLUMNS}, m.body_html from managed_items m where m.id = $1 and m.placement = $2`,
      [itemId, placement],
    )
    const row = found.rows[0]
    if (!row) return { access: 'not_found', placement: null }
    const viewer = await viewerOf(db, actor, { needsGroups: row.audience_kind === 'groups' })
    const access = publicAccessOf(viewer, { ...visibilityOf(row), everPublished: row.actual_opened_at !== null })
    if (access !== 'visible') return { access, placement: access === 'not_found' ? null : row.placement }
    const [card] = await this.#cards(db, [row])
    return { access, item: { ...card!, bodyHtml: renderBodyHtml(row.body_html) } }
  }

  async myDeadlines(actor: ResolvedActor): Promise<MyDeadline[]> {
    const db = this.#reader()
    const viewer = await viewerOf(db, actor)
    if (viewer.kind === 'anonymous' || actor.kind !== 'authenticated') return []
    const rows = await db.query<{ id: string; cohort_id: string; title: string; due_at: Date; receiver_unit: ReceiverUnit }>(
      `select distinct m.id, m.cohort_id, m.title, m.due_at, m.receiver_unit
         from managed_items m
         join response_rosters r on r.item_id = m.id and r.eligible_to_business_at is null
        where m.status = 'published' and m.due_at is not null
          and ((r.receiver_kind = 'user' and r.receiver_id = $1)
            or (r.receiver_kind = 'group' and r.receiver_id = any($2::uuid[])))
        order by m.due_at, m.id`,
      [actor.userId, viewer.groupIds],
    )
    return rows.rows.map((r) => ({
      itemId: r.id,
      cohortId: r.cohort_id,
      title: r.title,
      dueAt: r.due_at,
      receiverUnit: r.receiver_unit,
    }))
  }

  /** 列 → 卡片：一次查齊封面與附件（附件照管理員排的順序；只算已存好的檔案）。 */
  async #cards(db: Pick<Pool, 'query'>, rows: readonly Row[]): Promise<PublicItemCard[]> {
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const coverIds = rows.map((r) => r.cover_file_id).filter((id): id is string => id !== null)
    const [attachments, covers] = await Promise.all([
      db.query<{ item_id: string; id: string; original_name: string; size_bytes: string | null }>(
        `select a.item_id, f.id, f.original_name, f.size_bytes
           from item_attachments a join stored_files f on f.id = a.file_id
          where a.item_id = any($1::uuid[]) and f.status = 'stored'
          order by a.item_id, a.sort`,
        [ids],
      ),
      coverIds.length > 0
        ? db.query<{ id: string; original_name: string; size_bytes: string | null }>(
            `select id, original_name, size_bytes from stored_files where id = any($1::uuid[]) and status = 'stored'`,
            [coverIds],
          )
        : Promise.resolve({ rows: [] as { id: string; original_name: string; size_bytes: string | null }[] }),
    ])
    const summary = (f: { id: string; original_name: string; size_bytes: string | null }): ItemFileSummary => ({
      fileId: f.id,
      name: f.original_name,
      sizeBytes: Number(f.size_bytes ?? 0),
    })
    return rows.map((r) => {
      const cover = covers.rows.find((c) => c.id === r.cover_file_id)
      return {
        id: r.id,
        placement: r.placement,
        title: r.title,
        summary: r.summary,
        category: r.category,
        audienceKind: r.audience_kind,
        cover: cover ? summary(cover) : null,
        attachments: attachments.rows.filter((a) => a.item_id === r.id).map(summary),
        // 發布中與已下架的一定有實際開放時間（DB 的 managed_items_published_check）。
        publishedAt: r.actual_opened_at ?? new Date(0),
      }
    })
  }
}
