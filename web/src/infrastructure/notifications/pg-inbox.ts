import 'server-only'
import type { Pool } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import {
  decodeInboxCursor,
  encodeInboxCursor,
  INBOX_PAGE_SIZE,
  type InboxCohortOption,
  type InboxCommand,
  type InboxFilter,
  type InboxItem,
  type InboxPage,
  type InboxQuery,
  type MarkReadReceipt,
  type NotificationSourceState,
} from '@/application/notifications'
import { getPool } from '@/infrastructure/db/client'
import { err, type Result } from '@/shared/result'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 通知匣的查詢與已讀（模組實作設計 08 §5 `InboxQuery`／`InboxCommand`；附錄 A `notifications`）。
 *
 * 本人是誰只看 actor（session 解出來的 userId）；每一句 SQL 都帶 `recipient_user_id = 本人`，
 * 所以拿別人的通知編號來查或標已讀，結果跟「不存在」一樣——回「無法存取」、什麼都不改（契約 03 §4）。
 */

type Row = {
  id: string
  kind: string
  title: string
  scope: 'cohort' | 'global'
  cohort_id: string | null
  cohort_code: string | null
  cohort_status: string | null
  source_ref: { type?: string; id?: string; version?: number | null } | null
  created_at: Date
  read_at: Date | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 能看自己通知的人：已核准、沒停用、不用先改密碼。 */
function reader(actor: ResolvedActor): string | null {
  if (actor.kind !== 'authenticated') return null
  if (statusGate(actor, 'business')) return null
  return actor.userId
}

function filterSql(filter: InboxFilter, firstParam: number): { sql: string; values: unknown[] } {
  if (filter.kind === 'global') return { sql: `and n.scope = 'global'`, values: [] }
  if (filter.kind === 'cohort') return { sql: `and n.cohort_id = $${firstParam}`, values: [filter.cohortId] }
  return { sql: '', values: [] }
}

/**
 * 顯示時回來源重驗（模組 08 §2「舊通知與失權」）。
 *
 * 通知列只存來源的種類與 ID；能不能點進去、點進去是什麼狀態，每次顯示都重算。
 * 目前只有系統來源（測試通知、維運告警），沒有來源頁可點；後面的票加入業務事件時，
 * 在這裡登記自己的來源種類怎麼重驗。沒登記的種類一律當「此項目目前無法存取」——寧可擋也不露。
 * 屆別已封存的通知顯示「已封存（唯讀）」，仍可標已讀（產品模組 08 §4）。
 */
const SOURCE_RESOLVERS: Record<string, (ref: { id: string }) => NotificationSourceState> = {
  test: () => ({ state: 'ok', href: null }),
  domain_event: () => ({ state: 'ok', href: null }),
  due_work: () => ({ state: 'ok', href: null }),
  user: () => ({ state: 'ok', href: null }),
}

export function resolveSource(row: Pick<Row, 'source_ref' | 'cohort_status'>): NotificationSourceState {
  const type = row.source_ref?.type
  const id = row.source_ref?.id
  const resolver = type ? SOURCE_RESOLVERS[type] : undefined
  if (!resolver || !id) return { state: 'forbidden' }
  const resolved = resolver({ id })
  if (resolved.state === 'ok' && row.cohort_status === 'archived') return { state: 'archived', href: resolved.href }
  return resolved
}

function toItem(row: Row): InboxItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    scope: row.scope,
    cohortId: row.cohort_id,
    cohortCode: row.cohort_code,
    createdAt: row.created_at,
    readAt: row.read_at,
    source: resolveSource(row),
  }
}

export class PgInbox implements InboxQuery, InboxCommand {
  readonly #db: () => Pick<Pool, 'query'>
  readonly #realClock: Clock

  constructor(deps: { db?: () => Pick<Pool, 'query'>; realClock?: Clock } = {}) {
    this.#db = deps.db ?? getPool
    this.#realClock = deps.realClock ?? new RealClock()
  }

  async list(actor: ResolvedActor, filter: InboxFilter, cursor: string | null): Promise<InboxPage> {
    const userId = reader(actor)
    if (!userId) return { items: [], nextCursor: null }

    const after = decodeInboxCursor(cursor)
    const values: unknown[] = [userId]
    let cursorSql = ''
    if (after) {
      values.push(after.createdAt, after.id)
      cursorSql = `and (n.created_at, n.id) < ($2, $3)`
    }
    const f = filterSql(filter, values.length + 1)
    values.push(...f.values)
    values.push(INBOX_PAGE_SIZE + 1)

    const rows = await this.#db().query<Row>(
      `select n.id, n.kind, n.title, n.scope, n.cohort_id, c.code as cohort_code, c.status as cohort_status,
              n.source_ref, n.created_at, n.read_at
         from notifications n
         left join cohorts c on c.id = n.cohort_id
        where n.recipient_user_id = $1 ${cursorSql} ${f.sql}
        order by n.created_at desc, n.id desc
        limit $${values.length}`,
      values,
    )
    const page = rows.rows.slice(0, INBOX_PAGE_SIZE).map(toItem)
    const hasMore = rows.rows.length > INBOX_PAGE_SIZE
    const last = page.at(-1)
    return { items: page, nextCursor: hasMore && last ? encodeInboxCursor({ createdAt: last.createdAt, id: last.id }) : null }
  }

  async unreadCount(actor: ResolvedActor): Promise<number> {
    const userId = reader(actor)
    if (!userId) return 0
    const rows = await this.#db().query<{ n: string }>(
      'select count(*) as n from notifications where recipient_user_id = $1 and read_at is null',
      [userId],
    )
    return Number(rows.rows[0]?.n ?? 0)
  }

  async cohortOptions(actor: ResolvedActor): Promise<readonly InboxCohortOption[]> {
    const userId = reader(actor)
    if (!userId) return []
    const rows = await this.#db().query<{ id: string; code: string }>(
      `select distinct c.id, c.code
         from notifications n join cohorts c on c.id = n.cohort_id
        where n.recipient_user_id = $1
        order by c.code desc`,
      [userId],
    )
    return rows.rows.map((r) => ({ cohortId: r.id, code: r.code }))
  }

  async markRead(actor: ResolvedActor, notificationId: string): Promise<Result<MarkReadReceipt>> {
    const userId = reader(actor)
    if (!userId) return err('UNAUTHENTICATED', '請先登入。')
    if (!UUID.test(notificationId)) return cannotAccess()
    const now = this.#realClock.now()

    // 已讀過的不改時間（第一次讀的時間才有意義），所以先看這則是不是本人的。
    const updated = await this.#db().query<{ id: string; was_unread: boolean }>(
      `with target as (
         select id, read_at is null as was_unread from notifications
          where id = $1 and recipient_user_id = $2
       )
       update notifications n set read_at = coalesce(n.read_at, $3)
         from target where n.id = target.id
       returning n.id, target.was_unread`,
      [notificationId, userId, now],
    )
    const row = updated.rows[0]
    if (!row) return cannotAccess()
    return { ok: true, receipt: { changed: row.was_unread ? 1 : 0, requestId: notificationId, serverTime: now.toISOString() } }
  }

  async markAllRead(actor: ResolvedActor, filter: InboxFilter): Promise<Result<MarkReadReceipt>> {
    const userId = reader(actor)
    if (!userId) return err('UNAUTHENTICATED', '請先登入。')
    const now = this.#realClock.now()
    const f = filterSql(filter, 3)
    const updated = await this.#db().query(
      `update notifications n set read_at = $2
        where n.recipient_user_id = $1 and n.read_at is null ${f.sql}`,
      [userId, now, ...f.values],
    )
    return { ok: true, receipt: { changed: updated.rowCount ?? 0, requestId: 'mark-all', serverTime: now.toISOString() } }
  }
}

function cannotAccess() {
  return err('FORBIDDEN', '無法存取這則通知。')
}
