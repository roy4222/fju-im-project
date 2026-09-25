import 'server-only'
import type { Pool } from 'pg'
import { statusGate, type ResolvedActor, type Role } from '@/application/accounts'
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
  /** 來源是專題事務時，顯示當下的項目狀態（左接 `managed_items`；不是項目或項目不在了就是 null）。 */
  item_placement: string | null
  item_status: string | null
  item_receiver_unit: string | null
  /** 本人目前在這份收件的名單上（個人一份：本人；整組一份：本人此刻所在的組，票 21）。 */
  item_on_roster: boolean | null
}

/** 解析來源時能用的「當下」事實（每次顯示都重查，不看通知寫入當時）。 */
type SourceContext = Pick<Row, 'item_placement' | 'item_status' | 'item_receiver_unit' | 'item_on_roster'>

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
type SourceRef = { readonly id: string; readonly roles: readonly Role[] }

/** 組別的通知點進哪一頁：學生看「我的組別」，老師看「分組」，管理員看「分組總覽」（票 19：主指導的通知也發給老師）。 */
function groupPageFor(roles: readonly Role[]): string {
  if (roles.includes('student')) return '/dashboard/student/groups'
  if (roles.includes('teacher')) return '/dashboard/teacher/groups'
  if (roles.includes('admin')) return '/dashboard/admin/groups'
  return '/dashboard/student/groups'
}

const SOURCE_RESOLVERS: Record<string, (ref: SourceRef, context: SourceContext) => NotificationSourceState> = {
  test: () => ({ state: 'ok', href: null }),
  domain_event: () => ({ state: 'ok', href: null }),
  due_work: () => ({ state: 'ok', href: null }),
  user: () => ({ state: 'ok', href: null }),
  // 分組（票 13）：提案的收件人都是學生，點進「我的組別」；那一頁自己再依本人身分查、重驗權限。
  group_proposal: () => ({ state: 'ok', href: '/dashboard/student/groups' }),
  // 組別：學生、主指導老師（票 19）、管理員各自進自己的分組頁。
  group: (ref) => ({ state: 'ok', href: groupPageFor(ref.roles) }),
  item: resolveItem,
  // 合作案（票 20）：換案、解除的通知點進合作案頁；那一頁自己依登入身分與合作案狀態決定看得到什麼。
  industry_opportunity: (ref) => ({ state: 'ok', href: `/industry/${ref.id}` }),
  // 評分指派（票 23）：點進老師的評分工作台；那一頁自己再依本人身分查有效指派（被移除的指派看不到）。
  grading_assignment: (ref) =>
    ref.roles.includes('teacher') ? { state: 'ok', href: '/dashboard/teacher/grading' } : { state: 'forbidden' },
  // 成績更正待復核（票 24）：只有管理員點得進評分頁（那一頁的「待復核」清單就是管理待辦）。
  grade_override: (ref) => (ref.roles.includes('admin') ? { state: 'ok', href: '/dashboard/admin/grading' } : { state: 'forbidden' }),
  // 簽核版本（票 25）：「輪到你同意」點進學生的簽核頁；那一頁自己再依本人此刻所在組別查目前版本（失效的版本會標示原因）。
  signoff_version: (ref) =>
    ref.roles.includes('student') ? { state: 'ok', href: '/dashboard/student/signoff' } : { state: 'forbidden' },
}

/**
 * 專題事務的通知點進哪裡（票 18 補上；票 15 時只顯示標題）。看的是**現在**的項目與本人身分：
 *
 * - 公告 → 前台內容頁 `/news/<id>`（票 16）。已下架、已撤回也照樣連過去：那一頁自己依登入身分與項目狀態
 *   顯示內容或「已下架／已撤回」的下一步（不是 404）。
 * - 資源 → `/files`、專題規則 → `/rules`（票 16 的前台清單頁；資源與規則沒有單篇頁，`/news/<id>` 只收公告）。
 * - 收件：發布中而且本人現在還在名單上（整組一份：本人此刻是名單上那一組的有效組員）→ 作業區的那一份
 *   （`/dashboard/student/affairs/<id>`，那一頁自己再驗名單）。已被移出、沒有在發布中 → 不給連結，只顯示標題。
 * - 項目不在了或其他種類 → 不給連結。
 */
function resolveItem(ref: { id: string }, context: SourceContext): NotificationSourceState {
  switch (context.item_placement) {
    case 'news':
      return { state: 'ok', href: `/news/${ref.id}` }
    case 'resource':
      return { state: 'ok', href: '/files' }
    case 'rules':
      return { state: 'ok', href: '/rules' }
    case 'submission':
      return context.item_status === 'published' &&
        (context.item_receiver_unit === 'individual' || context.item_receiver_unit === 'group') &&
        context.item_on_roster
        ? { state: 'ok', href: `/dashboard/student/affairs/${ref.id}` }
        : { state: 'ok', href: null }
    default:
      return { state: 'ok', href: null }
  }
}

const NO_CONTEXT: SourceContext = { item_placement: null, item_status: null, item_receiver_unit: null, item_on_roster: null }

export function resolveSource(
  row: Pick<Row, 'source_ref' | 'cohort_status'> & Partial<SourceContext>,
  roles: readonly Role[] = [],
): NotificationSourceState {
  const type = row.source_ref?.type
  const id = row.source_ref?.id
  const resolver = type ? SOURCE_RESOLVERS[type] : undefined
  if (!resolver || !id) return { state: 'forbidden' }
  const resolved = resolver({ id, roles }, { ...NO_CONTEXT, ...row })
  if (resolved.state === 'ok' && row.cohort_status === 'archived') return { state: 'archived', href: resolved.href }
  return resolved
}

function toItem(row: Row, roles: readonly Role[]): InboxItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    scope: row.scope,
    cohortId: row.cohort_id,
    cohortCode: row.cohort_code,
    createdAt: row.created_at,
    readAt: row.read_at,
    source: resolveSource(row, roles),
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
              n.source_ref, n.created_at, n.read_at,
              mi.placement as item_placement, mi.status as item_status, mi.receiver_unit as item_receiver_unit,
              exists (select 1 from response_rosters rr
                       where rr.item_id = mi.id and rr.eligible_to_business_at is null
                         and ((rr.receiver_kind = 'user' and rr.receiver_id = $1)
                           or (rr.receiver_kind = 'group' and exists (
                                 select 1 from group_memberships gm join groups g on g.id = gm.group_id
                                  where gm.group_id = rr.receiver_id and gm.user_id = $1 and gm.valid_to is null
                                    and g.status = 'active')))) as item_on_roster
         from notifications n
         left join cohorts c on c.id = n.cohort_id
         left join managed_items mi
           on n.source_ref->>'type' = 'item'
          and mi.id = case when n.source_ref->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                           then (n.source_ref->>'id')::uuid end
        where n.recipient_user_id = $1 ${cursorSql} ${f.sql}
        order by n.created_at desc, n.id desc
        limit $${values.length}`,
      values,
    )
    const roles = actor.kind === 'authenticated' ? actor.roles : []
    const page = rows.rows.slice(0, INBOX_PAGE_SIZE).map((row) => toItem(row, roles))
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
