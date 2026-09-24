import type { NavItem } from '@/app/_ui/site-shell'
import type { Role } from '@/application/accounts'

/**
 * 三種後台的側欄掛載點與**受保護路由清單**（票 #47）。
 *
 * 管理員側欄現在有「帳號」「屆別」「時間軸」——名單、分組、繳交、評分、簽核
 * 各自由自己的切片加進來。沒做的功能不要先放上去，不然使用者會點進去撲空。
 */
export const ADMIN_NAV: readonly NavItem[] = [
  { href: '/dashboard/admin', label: '首頁' },
  { href: '/dashboard/admin/accounts', label: '帳號' },
  { href: '/dashboard/admin/cohorts', label: '屆別' },
  { href: '/dashboard/admin/timeline', label: '時間軸' },
]

export const TEACHER_NAV: readonly NavItem[] = [{ href: '/dashboard/teacher', label: '首頁' }]

export const STUDENT_NAV: readonly NavItem[] = [{ href: '/dashboard/student', label: '首頁' }]

/**
 * 每一條後台路由需要的角色。
 *
 * e2e 直接讀這份清單逐條驗「沒有這個角色就拿不到任何內容」——新增頁面時忘了加守衛，
 * 測試會紅。**新增後台頁面時要在這裡補一列。**
 */
export const PROTECTED_ROUTES: readonly { path: string; role: Role }[] = [
  { path: '/dashboard/admin', role: 'admin' },
  { path: '/dashboard/admin/accounts', role: 'admin' },
  { path: '/dashboard/admin/cohorts', role: 'admin' },
  { path: '/dashboard/admin/timeline', role: 'admin' },
  // 模擬業務鐘：只有測試站有（正式站整頁 404）；有的時候一樣只給管理員。
  { path: '/dashboard/admin/clock', role: 'admin' },
  { path: '/dashboard/teacher', role: 'teacher' },
  { path: '/dashboard/student', role: 'student' },
  // 通知匣（票 12）：入口是頂列的鈴鐺，不放側欄。
  { path: '/dashboard/admin/inbox', role: 'admin' },
  { path: '/dashboard/teacher/inbox', role: 'teacher' },
  { path: '/dashboard/student/inbox', role: 'student' },
]
