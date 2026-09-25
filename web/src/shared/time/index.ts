/**
 * 母 spec §4.11：時間與接收。
 *
 * 兩個時鐘分開：`RealClock` 給登入、稽核、備份、GC；`BusinessClock` 給階段、開放、
 * 截止、到期，只有 staging 會把它推開（契約 05）。存進 DB 的一律是 UTC 的
 * `timestamptz`；日界與分鐘界固定用 +08:00 換算，臺灣沒有日光節約時間，所以是定值
 * 而不是查時區資料庫。
 */

/** 臺灣時間相對 UTC 的固定偏移（分鐘）。 */
export const TAIPEI_UTC_OFFSET_MINUTES = 480

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const OFFSET_MS = TAIPEI_UTC_OFFSET_MINUTES * MINUTE_MS

/** 臺灣日曆日，格式 `YYYY-MM-DD`。 */
export type TaipeiDate = string
/** 臺灣時鐘上的時分，格式 `HH:mm`。 */
export type TaipeiTimeOfDay = string

export interface Clock {
  now(): Date
}

/** 牆上時間。稽核、登入、備份、GC 用這個。 */
export class RealClock implements Clock {
  now(): Date {
    return new Date()
  }
}

/**
 * 業務鐘。正式環境等於真實時鐘；staging 可以帶一個位移來模擬業務日期。
 * 位移只影響階段、開放、截止、到期的判定，不影響稽核時間。
 */
export class BusinessClock implements Clock {
  readonly #base: Clock
  #offsetMs: number

  constructor(base: Clock = new RealClock(), offsetMs = 0) {
    this.#base = base
    this.#offsetMs = offsetMs
  }

  now(): Date {
    return new Date(this.#base.now().getTime() + this.#offsetMs)
  }

  get offsetMs(): number {
    return this.#offsetMs
  }

  /** 把業務鐘往前推。只有 staging 的模擬日期功能會呼叫。 */
  advance(ms: number): void {
    this.#offsetMs += ms
  }

  /** 把業務鐘設到某個瞬間（以目前的真實時鐘為基準換算位移）。 */
  setTo(instant: Date): void {
    this.#offsetMs = instant.getTime() - this.#base.now().getTime()
  }
}

/** 固定時間的時鐘，測試用。 */
export class FixedClock implements Clock {
  #instant: Date

  constructor(instant: Date) {
    this.#instant = instant
  }

  now(): Date {
    return new Date(this.#instant.getTime())
  }

  set(instant: Date): void {
    this.#instant = instant
  }
}

export type TaipeiParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** 把 UTC 瞬間拆成臺灣時間的年月日時分秒。 */
export function taipeiParts(instant: Date): TaipeiParts {
  const shifted = new Date(instant.getTime() + OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  }
}

/** 這個瞬間落在臺灣的哪一個日曆日。 */
export function taipeiDateOf(instant: Date): TaipeiDate {
  const p = taipeiParts(instant)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PATTERN = /^(\d{2}):(\d{2})$/

function parseDate(date: TaipeiDate): { year: number; month: number; day: number } {
  const m = DATE_PATTERN.exec(date)
  if (!m) throw new RangeError(`臺灣日期格式必須是 YYYY-MM-DD，收到 ${JSON.stringify(date)}`)
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

function parseTime(time: TaipeiTimeOfDay): { hour: number; minute: number } {
  const m = TIME_PATTERN.exec(time)
  if (!m) throw new RangeError(`臺灣時分格式必須是 HH:mm，收到 ${JSON.stringify(time)}`)
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) throw new RangeError(`不存在的時分：${time}`)
  return { hour, minute }
}

/** 臺灣某一天 00:00 對應的 UTC 瞬間。 */
export function taipeiDayStart(date: TaipeiDate): Date {
  const { year, month, day } = parseDate(date)
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - OFFSET_MS)
}

/** 臺灣某一天結束後的第一個瞬間（＝隔天 00:00）。判定用半開區間，不用 23:59:59.999。 */
export function taipeiDayEndExclusive(date: TaipeiDate): Date {
  return new Date(taipeiDayStart(date).getTime() + DAY_MS)
}

/** 臺灣某一天某一分鐘的起點對應的 UTC 瞬間，例如 `2026-11-15` `23:59`。 */
export function taipeiMinuteStart(date: TaipeiDate, time: TaipeiTimeOfDay): Date {
  const { hour, minute } = parseTime(time)
  return new Date(taipeiDayStart(date).getTime() + hour * 60 * MINUTE_MS + minute * MINUTE_MS)
}

/**
 * 截止判定（母 spec §4.11）：`receivedBusinessAt < deadline_minute_start + 1 分鐘`。
 * 也就是截止分鐘「含這一分鐘」——23:59:59.999 還算準時，00:00:00.000 就遲了。
 */
export function isOnTime(receivedBusinessAt: Date, deadlineMinuteStart: Date): boolean {
  return receivedBusinessAt.getTime() < deadlineMinuteStart.getTime() + MINUTE_MS
}

/** 截止已過，是 `isOnTime` 的反面；拒絕路徑回 `DEADLINE_PASSED`。 */
export function isDeadlinePassed(receivedBusinessAt: Date, deadlineMinuteStart: Date): boolean {
  return !isOnTime(receivedBusinessAt, deadlineMinuteStart)
}

/**
 * 階段／年度以日期判定，結束日含當天（母 spec §4.11）。
 * `endDate` 省略代表沒有結束日。
 */
export function isWithinDateRange(
  receivedBusinessAt: Date,
  range: { startDate: TaipeiDate; endDate?: TaipeiDate },
): boolean {
  const t = receivedBusinessAt.getTime()
  if (t < taipeiDayStart(range.startDate).getTime()) return false
  if (range.endDate === undefined) return true
  return t < taipeiDayEndExclusive(range.endDate).getTime()
}

/** 存進 `timestamptz` 用的 UTC 字串；DB 一律存 UTC。 */
export function toUtcIsoString(instant: Date): string {
  return instant.toISOString()
}

/** 畫面用的臺灣時間字串，例如 `2026/11/15 23:59`（契約 02 §3）。 */
export function formatTaipeiMinute(instant: Date): string {
  const p = taipeiParts(instant)
  return `${pad(p.year, 4)}/${pad(p.month)}/${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

/** 精確到秒的臺灣時間字串，例如 `2026/11/15 23:59:59`（模擬業務鐘要能看到秒）。 */
export function formatTaipeiSecond(instant: Date): string {
  const p = taipeiParts(instant)
  return `${formatTaipeiMinute(instant)}:${pad(p.second)}`
}

/**
 * 臺灣日期換成畫面用的 `2026-11-15`（跟原型一樣用 `YYYY-MM-DD`；前台競賽、榮譽本來就直接顯示這個格式）。
 * 精確到分、秒的時間（`formatTaipeiMinute`／`formatTaipeiSecond`）仍照契約 02 §3 的 `2026/11/15 23:59`。
 */
export function formatTaipeiDate(date: TaipeiDate): string {
  const { year, month, day } = parseDate(date)
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

/** `YYYY-MM-DD` 是不是一個真的存在的日期（擋掉 2026-02-30 這種）。 */
export function isValidTaipeiDate(value: string): value is TaipeiDate {
  const m = DATE_PATTERN.exec(value)
  if (!m) return false
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/** 臺灣日期加減天數（負數往前）。 */
export function addTaipeiDays(date: TaipeiDate, days: number): TaipeiDate {
  return taipeiDateOf(new Date(taipeiDayStart(date).getTime() + days * DAY_MS))
}

const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * 把 `<input type="datetime-local">` 送來的值（`YYYY-MM-DDTHH:mm` 或帶秒）當成**臺灣時間**，
 * 換成 UTC 瞬間。格式或日期不對回 `null`。
 */
export function parseTaipeiDateTime(value: string): Date | null {
  const m = LOCAL_DATE_TIME.exec(value.trim())
  if (!m) return null
  const [, date, hh, mm, ss] = m
  if (!isValidTaipeiDate(date!)) return null
  const hour = Number(hh)
  const minute = Number(mm)
  const second = ss === undefined ? 0 : Number(ss)
  if (hour > 23 || minute > 59 || second > 59) return null
  return new Date(taipeiDayStart(date!).getTime() + ((hour * 60 + minute) * 60 + second) * 1000)
}

/** `parseTaipeiDateTime` 的反向：給 `datetime-local` 預填用，帶秒。 */
export function toTaipeiDateTimeInput(instant: Date): string {
  const p = taipeiParts(instant)
  return `${taipeiDateOf(instant)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
}

/** 瞬間在臺灣時鐘上的 `HH:mm`。 */
export function taipeiTimeOf(instant: Date): TaipeiTimeOfDay {
  const p = taipeiParts(instant)
  return `${pad(p.hour)}:${pad(p.minute)}`
}
