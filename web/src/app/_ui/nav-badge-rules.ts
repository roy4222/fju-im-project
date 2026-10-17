import type { Role } from '@/application/accounts'

/**
 * 後台側欄的數字徽章規則（票 30；照原型 `prototype/src/lib/nav-config.ts` 的 `badgeFor`）。
 *
 * 只算「現在輪到我做」的事：
 * - 學生：交作業裡還要處理的（待交作業＋輪到我回覆的同意書）；側欄沒有通知徽章，未讀只在鈴鐺。
 * - 老師：還沒正式送出的評分（評分）、輪到我同意的組（作業區）；側欄沒有通知徽章，未讀只在鈴鐺。
 * - 系辦：等審核的註冊申請（帳號）；側欄沒有通知徽章，未讀只在鈴鐺。
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
  // 老師（SH-1-TE）：同意書搬進作業區，徽章跟著搬；通知只在鈴鐺，側欄不配。
  if (role === 'teacher') {
    if (segment === 'grading') return pick(counts.teacherToGrade)
    if (segment === 'affairs') return pick(counts.teacherSignoff)
    return undefined
  }
  // 系辦（SH-1-AD）：只有帳號（等審核的註冊申請）；通知只在鈴鐺，側欄不配。
  if (role === 'admin') {
    if (segment === 'accounts') return pick(counts.adminPendingApplications)
    return undefined
  }
  // 學生（SH-1-ST）：只有交作業（`studentTodos` 口徑，同意書待回覆也算在裡面）；通知只在鈴鐺，側欄不配。
  if (role === 'student' && segment === 'affairs') return pick(counts.studentPending)
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
