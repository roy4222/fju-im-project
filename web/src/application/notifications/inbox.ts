import type { NotificationKind } from '@/application/notifications/events'

/**
 * 通知匣的型別與純規則（模組實作設計 08 §2、§5、§7；產品模組 08 §4「通知匣」「通知內容及操作」）。
 *
 * - 預設顯示本人**所有屆別與全站**的通知，依時間新到舊；可篩某一屆或只看全站。
 * - 已讀是個人的，存在 `notifications.read_at`，跨登入、跨裝置都在。
 * - 只有本人看得到自己的通知；拿別人的通知編號來標已讀，一律回「無法存取」、什麼都不改（契約 03 §4）。
 * - 通知列只存 ID 與標題；顯示時逐筆回來源重驗（失權、撤回、封存各有固定文案）。
 */

export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  due: '截止',
  submission: '繳交',
  signoff: '簽核',
  grading: '評分',
  account: '帳號',
  group: '分組',
  system: '系統',
}

export function notificationKindLabel(kind: string): string {
  return (NOTIFICATION_KIND_LABEL as Record<string, string>)[kind] ?? '系統'
}

/**
 * 顯示時回來源重驗的結果（模組 08 §2「舊通知與失權」）。
 * `href` 是點進去的地方；沒有來源頁（測試通知、維運告警）時是 null。
 */
export type NotificationSourceState =
  | { readonly state: 'ok'; readonly href: string | null }
  | { readonly state: 'forbidden' }
  | { readonly state: 'withdrawn' }
  | { readonly state: 'archived'; readonly href: string | null }

/** 三種不能正常點入的狀態的固定文案（模組 08 §2、§7）。 */
export const SOURCE_STATE_TEXT = {
  forbidden: '此項目目前無法存取',
  withdrawn: '來源已撤回',
  archived: '已封存（唯讀）',
} as const

export type InboxItem = {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly scope: 'cohort' | 'global'
  readonly cohortId: string | null
  readonly cohortCode: string | null
  readonly createdAt: Date
  readonly readAt: Date | null
  readonly source: NotificationSourceState
}

/** 屆別篩選：全部、只看全站、或某一屆。 */
export type InboxFilter =
  | { readonly kind: 'all' }
  | { readonly kind: 'global' }
  | { readonly kind: 'cohort'; readonly cohortId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 網址上的 `?cohort=` → 篩選。看不懂的值當作「全部」，不報錯。 */
export function parseInboxFilter(value: string | null | undefined): InboxFilter {
  if (value === 'global') return { kind: 'global' }
  if (value && UUID.test(value)) return { kind: 'cohort', cohortId: value.toLowerCase() }
  return { kind: 'all' }
}

export function inboxFilterParam(filter: InboxFilter): string | null {
  if (filter.kind === 'global') return 'global'
  if (filter.kind === 'cohort') return filter.cohortId
  return null
}

/** 一頁幾則。更早的用游標往下翻。 */
export const INBOX_PAGE_SIZE = 30

/** 游標＝最後一則的（建立時間、id）；時間相同時用 id 排，翻頁不重複也不漏。 */
export type InboxCursor = { readonly createdAt: Date; readonly id: string }

export function encodeInboxCursor(cursor: InboxCursor): string {
  return `${cursor.createdAt.toISOString()}_${cursor.id}`
}

export function decodeInboxCursor(value: string | null | undefined): InboxCursor | null {
  if (!value) return null
  const at = value.lastIndexOf('_')
  if (at < 0) return null
  const createdAt = new Date(value.slice(0, at))
  const id = value.slice(at + 1)
  if (Number.isNaN(createdAt.getTime()) || !UUID.test(id)) return null
  return { createdAt, id: id.toLowerCase() }
}

export type InboxPage = {
  readonly items: readonly InboxItem[]
  readonly nextCursor: string | null
}

/** 篩選下拉的選項：本人通知裡出現過的屆別（含已封存的舊屆，不能只顯示最新一屆）。 */
export type InboxCohortOption = { readonly cohortId: string; readonly code: string }

export type MarkReadReceipt = { readonly changed: number }

/** 管理端「發一則測試通知」（模組 08 §6；只在測試站）。 */
export type TestNotificationInput = {
  readonly recipientUserId: string
  /** 空字串＝全站通知；否則是某一屆。 */
  readonly cohortId: string
  readonly title: string
}

export type TestNotificationReceipt = { readonly eventId: string; readonly recipientName: string }

export const TEST_NOTIFICATION_TITLE_MAX_LENGTH = 60

export type NormalizedTestNotification = {
  readonly recipientUserId: string
  readonly cohortId: string | null
  readonly title: string
}

/** 檢查測試通知的輸入。回 null＝格式不對（呼叫端回 VALIDATION_FAILED）。 */
export function normalizeTestNotification(
  input: TestNotificationInput,
): { ok: true; value: NormalizedTestNotification } | { ok: false; message: string } {
  const recipient = input.recipientUserId.trim()
  if (!UUID.test(recipient)) return { ok: false, message: '請選一位收件人。' }
  const cohort = input.cohortId.trim()
  if (cohort && !UUID.test(cohort)) return { ok: false, message: '屆別選項不對，請重新整理頁面。' }
  const title = input.title.replaceAll(/\s+/g, ' ').trim()
  if (title.length > TEST_NOTIFICATION_TITLE_MAX_LENGTH) {
    return { ok: false, message: `標題最多 ${TEST_NOTIFICATION_TITLE_MAX_LENGTH} 個字。` }
  }
  return {
    ok: true,
    value: { recipientUserId: recipient.toLowerCase(), cohortId: cohort ? cohort.toLowerCase() : null, title: title || '測試通知' },
  }
}
