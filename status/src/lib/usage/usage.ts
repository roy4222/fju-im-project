/**
 * 使用報表的純計算（DV 設計方案 §7.5、§12；AC-DV-24）：`summarize(report, range, role)`。
 *
 * - 範圍的結尾是 `window.to`（資料最後一天），不是「現在」：跟 SQL 產出 count7d／count30d／countTerm 同一基準。
 * - 「本學期」＝`window.to` 當天或之前最近的 2/1 或 8/1 起算（Q-DV-7 定案）。
 * - 三張「每日活躍人數」卡：範圍內該角色 `daily.activeUsers` 的平均（只除以有資料的天數），四捨五入成整數。
 * - 長條圖與很少用的功能：直接用 `actions[].count<範圍>`，不從 daily 重算；同一個 action 跨角色加總。
 */
import type { UsageReport, UsageRole } from '@/lib/data/types'

import { actionLabel } from './actions'

export const RANGES = ['7d', '30d', 'term'] as const
export type UsageRange = (typeof RANGES)[number]
export const ROLES = ['student', 'teacher', 'admin'] as const satisfies readonly UsageRole[]
export type RoleFilter = UsageRole | 'all'

/** 長條圖最多幾條（§8.2 列表上限）。 */
export const TOP_N = 15
/** 範圍內次數 ≤ 這個數就列進「很少用的功能」。 */
export const RARE_MAX = 2

const COUNT_KEY = { '7d': 'count7d', '30d': 'count30d', term: 'countTerm' } as const satisfies Record<
  UsageRange,
  keyof UsageReport['actions'][number]
>

export const parseRange = (value: unknown): UsageRange =>
  RANGES.includes(value as UsageRange) ? (value as UsageRange) : '7d'
export const parseRole = (value: unknown): RoleFilter =>
  ROLES.includes(value as UsageRole) ? (value as UsageRole) : 'all'

const DAY_MS = 86400e3
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)

/** 最近一個 2/1 或 8/1（含當天）。`day` 是 YYYY-MM-DD。 */
export function termStart(day: string): string {
  const [y, m] = day.split('-').map(Number) as [number, number]
  if (m >= 8) return `${y}-08-01`
  if (m >= 2) return `${y}-02-01`
  return `${y - 1}-08-01`
}

/** 範圍的第一天（含）到 `to`（含）。 */
export function rangeFrom(range: UsageRange, to: string): string {
  if (range === 'term') return termStart(to)
  return toDay(dayMs(to) - ((range === '7d' ? 7 : 30) - 1) * DAY_MS)
}

export type ActionCount = { action: string; label: string; count: number }

export type UsageSummary = {
  range: UsageRange
  role: RoleFilter
  from: string
  to: string
  /** 篩掉的角色、或範圍內沒有資料的角色是 null */
  activeUsers: Record<UsageRole, number | null>
  /** 依次數由多到少，最多 TOP_N 條，不含 0 */
  bars: ActionCount[]
  /** 次數 ≤ RARE_MAX（含 0），由少到多 */
  rare: ActionCount[]
}

export function summarize(report: UsageReport, range: UsageRange, role: RoleFilter): UsageSummary {
  const to = report.window.to
  const from = rangeFrom(range, to)
  const roles = role === 'all' ? ROLES : [role]

  const activeUsers = { student: null, teacher: null, admin: null } as Record<UsageRole, number | null>
  for (const r of roles) {
    const days = report.daily.filter((d) => d.role === r && d.day >= from && d.day <= to)
    if (days.length > 0) activeUsers[r] = Math.round(days.reduce((sum, d) => sum + d.activeUsers, 0) / days.length)
  }

  const key = COUNT_KEY[range]
  const totals = new Map<string, number>()
  for (const a of report.actions) {
    if (!roles.includes(a.role)) continue
    totals.set(a.action, (totals.get(a.action) ?? 0) + a[key])
  }
  const counts = [...totals].map(([action, count]) => ({ action, label: actionLabel(action), count }))
  const byAction = (a: ActionCount, b: ActionCount) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0)

  return {
    range,
    role,
    from,
    to,
    activeUsers,
    bars: counts
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count || byAction(a, b))
      .slice(0, TOP_N),
    rare: counts.filter((c) => c.count <= RARE_MAX).sort((a, b) => a.count - b.count || byAction(a, b)),
  }
}
