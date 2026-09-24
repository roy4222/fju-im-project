import { err, type Err } from '@/shared/result'
import {
  formatTaipeiDate,
  isValidTaipeiDate,
  taipeiDateOf,
  taipeiDayStart,
  taipeiMinuteStart,
  taipeiTimeOf,
} from '@/shared/time'

/**
 * 獨立活動（說明會、成果發表這類）的純規則（產品模組 02 §4、COH-02／03；附錄 A `project_events`）。
 *
 * 作業截止**不在這裡**：那是收件項目衍生到日曆的，避免手工維護兩份日期（產品模組 02 §4）。
 * 取消不刪除，只標「已取消」；改期是同一個活動換日期，不是刪掉重建。
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

/** 表單送來的活動內容（日期、時間都是臺灣時間的字串）。 */
export type ActivityInput = {
  readonly title: string
  readonly description: string
  readonly date: string
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

export function normalizeActivityInput(input: ActivityInput): { ok: true; value: NormalizedActivity } | Err {
  const title = input.title.trim()
  const description = input.description.trim()
  const date = input.date.trim()

  if (!title) return err('VALIDATION_FAILED', '請填活動名稱。', { details: { field: 'title' } })
  if (title.length > ACTIVITY_TITLE_MAX_LENGTH) {
    return err('VALIDATION_FAILED', `活動名稱最多 ${ACTIVITY_TITLE_MAX_LENGTH} 個字。`, { details: { field: 'title' } })
  }
  if (description.length > ACTIVITY_DESCRIPTION_MAX_LENGTH) {
    return err('VALIDATION_FAILED', `說明最多 ${ACTIVITY_DESCRIPTION_MAX_LENGTH} 個字。`, {
      details: { field: 'description' },
    })
  }
  if (!isValidTaipeiDate(date)) return err('VALIDATION_FAILED', '請填活動日期。', { details: { field: 'date' } })
  if (!isAudience(input.audience)) {
    return err('VALIDATION_FAILED', '請選擇誰看得到這個活動。', { details: { field: 'audience' } })
  }

  const base = { title, description: description || null, audienceKind: input.audience }
  if (input.allDay) {
    return { ok: true, value: { ...base, startsAt: taipeiDayStart(date), endsAt: null, allDay: true } }
  }

  const startsAt = parseTime(date, input.startTime.trim())
  if (!startsAt) return err('VALIDATION_FAILED', '請填開始時間，或勾選「全天」。', { details: { field: 'startTime' } })
  let endsAt: Date | null = null
  if (input.endTime.trim()) {
    endsAt = parseTime(date, input.endTime.trim())
    if (!endsAt) return err('VALIDATION_FAILED', '結束時間格式不對。', { details: { field: 'endTime' } })
    if (endsAt.getTime() < startsAt.getTime()) {
      return err('VALIDATION_FAILED', '結束時間不能早於開始時間。', { details: { field: 'endTime' } })
    }
  }
  return { ok: true, value: { ...base, startsAt, endsAt, allDay: false } }
}

/** 畫面用的活動時間，例如 `2026/12/20（全天）`、`2026/12/20 14:00–16:00`。 */
export function formatActivityWhen(activity: Pick<Activity, 'startsAt' | 'endsAt' | 'allDay'>): string {
  const day = formatTaipeiDate(taipeiDateOf(activity.startsAt))
  if (activity.allDay) return `${day}（全天）`
  const start = taipeiTimeOf(activity.startsAt)
  return activity.endsAt ? `${day} ${start}–${taipeiTimeOf(activity.endsAt)}` : `${day} ${start}`
}

/** 改期表單的預填值。 */
export function activityFormValues(activity: Activity): ActivityInput {
  return {
    title: activity.title,
    description: activity.description ?? '',
    date: taipeiDateOf(activity.startsAt),
    allDay: activity.allDay,
    startTime: activity.allDay ? '' : taipeiTimeOf(activity.startsAt),
    endTime: activity.endsAt && !activity.allDay ? taipeiTimeOf(activity.endsAt) : '',
    audience: activity.audienceKind,
  }
}
