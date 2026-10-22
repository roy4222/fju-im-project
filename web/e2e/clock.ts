/**
 * e2e 共用的時間工具：日期一律以臺灣時區（+08:00，沒有日光節約）換算。
 *
 * 只給新的 spec 用；既有 spec 自己用 `86_400_000` 算日期的不回頭改（⑤-14）。
 * 單元測試在 `src/shared/clock.test.ts`（Playwright 會把 `e2e/` 底下的 `*.test.ts` 當 spec 跑）。
 */

const DAY_MS = 86_400_000
const TAIPEI_OFFSET_MS = 8 * 3_600_000

/** 臺灣時區「今天 00:00」再加 `days` 天，回 `YYYY-MM-DD`（負數往回推）。 */
export function daysFromNow(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + TAIPEI_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10)
}

/** 臺灣牆上時間 `date`（`YYYY-MM-DD`）`time`（`HH:mm`，預設 00:00）對應的那一瞬間。 */
export function atTaiwan(date: string, time = '00:00'): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error(`atTaiwan 格式不對：${date} ${time}`)
  return new Date(`${date}T${time}:00+08:00`)
}
