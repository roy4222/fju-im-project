import { err, type Err } from '@/shared/result'
import {
  addTaipeiDays,
  formatTaipeiDate,
  isValidTaipeiDate,
  taipeiDateOf,
  taipeiDayEndExclusive,
  taipeiDayStart,
  taipeiMinuteStart,
  taipeiTimeOf,
} from '@/shared/time'

/**
 * 獨立活動（說明會、成果發表這類）的純規則（產品模組 02 §4、COH-02／03；附錄 A `project_events`）。
 *
 * 作業截止**不在這裡**：那是收件項目衍生到日曆的，避免手工維護兩份日期（產品模組 02 §4）。
 * 改期是同一個活動換日期，不是刪掉重建。
 * 活動可以跨好幾天（③-2，規格③ §9.1）：全天活動的 `endsAt` 是結束日的次日 00:00（exclusive）；
 * 有時間的活動 `endsAt` 是結束時刻，沒寫結束時間只限單日（`endsAt` NULL）。
 * 刪除（③ §9.1）：排定中的也能直接刪，不必先取消；只打刪除標記、不能恢復，之後所有查詢都看不到。
 * 「取消」只剩舊資料與 `cancelActivity` 用例，畫面不再提供。
 */

export type ActivityAudience = 'public' | 'signed_in' | 'cohort_students' | 'teachers'

export const ACTIVITY_AUDIENCES: readonly ActivityAudience[] = ['cohort_students', 'teachers', 'signed_in', 'public']

export const ACTIVITY_AUDIENCE_LABEL: Record<ActivityAudience, string> = {
  cohort_students: '本屆學生',
  teachers: '只給老師',
  signed_in: '所有登入的人',
  public: '公開（訪客也看得到）',
}

export type ActivityStatus = 'scheduled' | 'cancelled'

export const ACTIVITY_STATUS_LABEL: Record<ActivityStatus, string> = {
  scheduled: '已排定',
  cancelled: '已取消',
}

/** 能不能刪除：排定中、已取消的都可以；只擋已經刪除的（當作不存在）。 */
export function activityDeleteBlocker(activity: { readonly deleted: boolean }): string | null {
  return activity.deleted ? '找不到這個活動，請重新整理頁面。' : null
}

/** 非全天活動跨日卻沒寫結束時間（表單與 `moveActivity` 共用同一句）。 */
export const CROSS_DAY_END_TIME_REQUIRED = '跨日的活動要填結束時間。'

export const ACTIVITY_TITLE_MAX_LENGTH = 40
export const ACTIVITY_DESCRIPTION_MAX_LENGTH = 300

export type Activity = {
  readonly id: string
  readonly cohortId: string
  readonly title: string
  readonly description: string | null
  readonly startsAt: Date
  readonly endsAt: Date | null
  readonly allDay: boolean
  readonly audienceKind: ActivityAudience
  readonly status: ActivityStatus
  readonly revision: number
}

/** 表單送來的活動內容（日期、時間都是臺灣時間的字串）。`endDate` 空＝同 `startDate`。 */
export type ActivityInput = {
  readonly title: string
  readonly description: string
  readonly startDate: string
  readonly endDate: string
  readonly allDay: boolean
  readonly startTime: string
  readonly endTime: string
  readonly audience: string
}

export type NormalizedActivity = {
  readonly title: string
  readonly description: string | null
  readonly startsAt: Date
  readonly endsAt: Date | null
  readonly allDay: boolean
  readonly audienceKind: ActivityAudience
}

const TIME = /^\d{2}:\d{2}$/

function isAudience(value: string): value is ActivityAudience {
  return (ACTIVITY_AUDIENCES as readonly string[]).includes(value)
}

function parseTime(date: string, time: string): Date | null {
  if (!TIME.test(time)) return null
  try {
    return taipeiMinuteStart(date, time)
  } catch {
    return null
  }
}

/** 起訖日：`endDate` 空就是單日；結束日不能早於開始日。 */
function normalizeSpan(startDate: string, endDate: string): { ok: true; startDate: string; endDate: string } | Err {
  if (!isValidTaipeiDate(startDate)) return err('VALIDATION_FAILED', '請填開始日。', { details: { field: 'startDate' } })
  const end = endDate || startDate
  if (!isValidTaipeiDate(end)) return err('VALIDATION_FAILED', '結束日格式不對。', { details: { field: 'endDate' } })
  if (end < startDate) return err('VALIDATION_FAILED', '結束日不能早於開始日。', { details: { field: 'endDate' } })
  return { ok: true, startDate, endDate: end }
}

/** 有時間的活動的結束：跨日一定要有結束時間；同一天可以不填（`null`），填了要晚於開始。 */
function timedEnd(startsAt: Date, endDate: string, endTime: string, crossDay: boolean): { ok: true; endsAt: Date | null } | Err {
  if (!endTime) {
    if (crossDay) return err('VALIDATION_FAILED', CROSS_DAY_END_TIME_REQUIRED, { details: { field: 'endTime' } })
    return { ok: true, endsAt: null }
  }
  const endsAt = parseTime(endDate, endTime)
  if (!endsAt) return err('VALIDATION_FAILED', '結束時間格式不對。', { details: { field: 'endTime' } })
  if (endsAt.getTime() <= startsAt.getTime()) {
    return err('VALIDATION_FAILED', '結束時間要晚於開始時間。', { details: { field: 'endTime' } })
  }
  return { ok: true, endsAt }
}

export function normalizeActivityInput(input: ActivityInput): { ok: true; value: NormalizedActivity } | Err {
  const title = input.title.trim()
  const description = input.description.trim()

  if (!title) return err('VALIDATION_FAILED', '請填活動名稱。', { details: { field: 'title' } })
  if (title.length > ACTIVITY_TITLE_MAX_LENGTH) {
    return err('VALIDATION_FAILED', `活動名稱最多 ${ACTIVITY_TITLE_MAX_LENGTH} 個字。`, { details: { field: 'title' } })
  }
  if (description.length > ACTIVITY_DESCRIPTION_MAX_LENGTH) {
    return err('VALIDATION_FAILED', `說明最多 ${ACTIVITY_DESCRIPTION_MAX_LENGTH} 個字。`, {
      details: { field: 'description' },
    })
  }
  const span = normalizeSpan(input.startDate.trim(), input.endDate.trim())
  if (!span.ok) return span
  if (!isAudience(input.audience)) {
    return err('VALIDATION_FAILED', '請選擇誰看得到這個活動。', { details: { field: 'audience' } })
  }

  const base = { title, description: description || null, audienceKind: input.audience }
  if (input.allDay) {
    return {
      ok: true,
      value: { ...base, startsAt: taipeiDayStart(span.startDate), endsAt: taipeiDayEndExclusive(span.endDate), allDay: true },
    }
  }

  const startsAt = parseTime(span.startDate, input.startTime.trim())
  if (!startsAt) return err('VALIDATION_FAILED', '請填開始時間，或勾選「全天」。', { details: { field: 'startTime' } })
  const end = timedEnd(startsAt, span.endDate, input.endTime.trim(), span.endDate !== span.startDate)
  if (!end.ok) return end
  return { ok: true, value: { ...base, startsAt, endsAt: end.endsAt, allDay: false } }
}

/** 活動佔的臺灣日期（含結束日）；全天的 `endsAt` 是次日 00:00，所以往回一天。 */
export function activitySpan(activity: Pick<Activity, 'startsAt' | 'endsAt' | 'allDay'>): { startDate: string; endDate: string } {
  const startDate = taipeiDateOf(activity.startsAt)
  if (!activity.endsAt) return { startDate, endDate: startDate }
  const endDate = activity.allDay ? addTaipeiDays(taipeiDateOf(activity.endsAt), -1) : taipeiDateOf(activity.endsAt)
  return { startDate, endDate: endDate < startDate ? startDate : endDate }
}

/**
 * 拖拉只改起訖日（`moveActivity`，③ §9.1）：時刻沿用原本的。全天的照新起訖重算；
 * 有時間、沒寫結束時間的只能單日——拉成跨日回「跨日的活動要填結束時間」，不自動補時間。
 */
export function planActivityMove(
  activity: Pick<Activity, 'startsAt' | 'endsAt' | 'allDay'>,
  dates: { readonly startDate: string; readonly endDate: string },
): { ok: true; value: { startsAt: Date; endsAt: Date | null } } | Err {
  const span = normalizeSpan(dates.startDate.trim(), dates.endDate.trim())
  if (!span.ok) return span
  if (activity.allDay) {
    return { ok: true, value: { startsAt: taipeiDayStart(span.startDate), endsAt: taipeiDayEndExclusive(span.endDate) } }
  }
  const startsAt = taipeiMinuteStart(span.startDate, taipeiTimeOf(activity.startsAt))
  const endTime = activity.endsAt ? taipeiTimeOf(activity.endsAt) : ''
  const end = timedEnd(startsAt, span.endDate, endTime, span.endDate !== span.startDate)
  if (!end.ok) return end
  return { ok: true, value: { startsAt, endsAt: end.endsAt } }
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'] as const

/** 跨日顯示用的短日期 `3/5`；帶星期是 `3/5（四）`。 */
function shortDate(date: string, weekday = false): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const text = `${month}/${day}`
  return weekday ? `${text}（${WEEKDAY[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}）` : text
}

/**
 * 畫面用的活動時間。單日：`2026-12-20（全天）`、`2026-12-20 14:00–16:00`；
 * 跨日（③ §9.1）：全天 `3/5–3/7`、有時間 `3/5（四）09:00–3/7（六）17:00`。
 */
export function formatActivityWhen(activity: Pick<Activity, 'startsAt' | 'endsAt' | 'allDay'>): string {
  const { startDate, endDate } = activitySpan(activity)
  if (activity.allDay) {
    return startDate === endDate ? `${formatTaipeiDate(startDate)}（全天）` : `${shortDate(startDate)}–${shortDate(endDate)}`
  }
  const start = taipeiTimeOf(activity.startsAt)
  if (startDate !== endDate && activity.endsAt) {
    return `${shortDate(startDate, true)}${start}–${shortDate(endDate, true)}${taipeiTimeOf(activity.endsAt)}`
  }
  const day = formatTaipeiDate(startDate)
  return activity.endsAt ? `${day} ${start}–${taipeiTimeOf(activity.endsAt)}` : `${day} ${start}`
}

/** 編輯表單的預填值。 */
export function activityFormValues(activity: Activity): ActivityInput {
  const { startDate, endDate } = activitySpan(activity)
  return {
    title: activity.title,
    description: activity.description ?? '',
    startDate,
    endDate,
    allDay: activity.allDay,
    startTime: activity.allDay ? '' : taipeiTimeOf(activity.startsAt),
    endTime: activity.endsAt && !activity.allDay ? taipeiTimeOf(activity.endsAt) : '',
    audience: activity.audienceKind,
  }
}
