import type { Role } from '@/application/accounts'

/**
 * 後台側欄的數字徽章規則（票 30；照原型 `prototype/src/lib/nav-config.ts` 的 `badgeFor`）。
 *
 * 只算「現在輪到我做」的事：
 * - 三個角色的通知匣：本人未讀數。
 * - 學生：作業區還沒送出的收件、簽核裡輪到我表態的版本。
 * - 老師：還沒正式送出的評分、輪到我同意的組。
 * - 系辦：等審核的註冊申請。
 *
 * 0 不顯示（回 undefined）。數字由伺服器依本人讀好（`nav-badges.ts`），這裡是純規則、可以單獨測。
 */
export type BadgeCounts = {
  readonly unread?: number
  readonly studentPending?: number
  readonly studentSignoff?: number
  readonly teacherToGrade?: number
  readonly teacherSignoff?: number
  readonly adminPendingApplications?: number
}

/** `/dashboard/<角色>/<段>` → 那一段；首頁是 ''。 */
function segmentOf(href: string): string {
  return href.split('/').slice(3, 4)[0] ?? ''
}

export function badgeFor(role: Role, href: string, counts: BadgeCounts): number | undefined {
  const pick = (n: number | undefined) => (n && n > 0 ? n : undefined)
  const segment = segmentOf(href)
  if (segment === 'inbox') return pick(counts.unread)
  if (role === 'student' && segment === 'affairs') return pick(counts.studentPending)
  if (role === 'student' && segment === 'signoff') return pick(counts.studentSignoff)
  if (role === 'teacher' && segment === 'grading') return pick(counts.teacherToGrade)
  if (role === 'teacher' && segment === 'signoff') return pick(counts.teacherSignoff)
  if (role === 'admin' && segment === 'accounts') return pick(counts.adminPendingApplications)
  return undefined
}

/** 整份側欄：href → 數字（沒有數字的項目不在裡面）。 */
export function badgeMap(role: Role, hrefs: readonly string[], counts: BadgeCounts): Record<string, number> {
  const out: Record<string, number> = {}
  for (const href of hrefs) {
    const n = badgeFor(role, href, counts)
    if (n !== undefined) out[href] = n
  }
  return out
}

/** 後台網址前綴 → 角色；不是三種後台就是 null。 */
export function roleOfBase(base: string): Role | null {
  if (base === '/dashboard/admin') return 'admin'
  if (base === '/dashboard/teacher') return 'teacher'
  if (base === '/dashboard/student') return 'student'
  return null
}
