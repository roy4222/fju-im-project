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
  { href: '/dashboard/admin/groups', label: '分組' },
  { href: '/dashboard/admin/affairs', label: '專題事務' },
  // 合作案（票 20）：全部合作案與組別連結。
  { href: '/dashboard/admin/industry', label: '合作案' },
]

export const TEACHER_NAV: readonly NavItem[] = [
  { href: '/dashboard/teacher', label: '首頁' },
  // 分組（票 19）：產學組認領與全部組別。
  { href: '/dashboard/teacher/groups', label: '分組' },
  // 各組繳交狀態（票 22）：自己此刻指導的組 × 整組收件的矩陣，點進去看版本。
  { href: '/dashboard/teacher/affairs', label: '各組繳交' },
  // 我的合作案（票 20）：建立、發布、下架自己的產學合作案。
  { href: '/dashboard/teacher/industry', label: '我的合作案' },
]

export const STUDENT_NAV: readonly NavItem[] = [
  { href: '/dashboard/student', label: '首頁' },
  { href: '/dashboard/student/groups', label: '我的組別' },
  // 作業區（票 17）：自己在收件名單上的個人收件；組別收件在票 21 併進來。
  { href: '/dashboard/student/affairs', label: '作業區' },
]

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
  { path: '/dashboard/admin/groups', role: 'admin' },
  // 專題事務工作台與完整編輯器（票 15）；既有項目的 `/dashboard/admin/editor/<id>` 與收件名單頁
  // `/dashboard/admin/affairs/<id>`（票 18，roster.spec 驗學生與老師被擋）同一個守衛。
  { path: '/dashboard/admin/affairs', role: 'admin' },
  { path: '/dashboard/admin/editor/new', role: 'admin' },
  // 模擬業務鐘：只有測試站有（正式站整頁 404）；有的時候一樣只給管理員。
  { path: '/dashboard/admin/clock', role: 'admin' },
  { path: '/dashboard/teacher', role: 'teacher' },
  { path: '/dashboard/teacher/groups', role: 'teacher' },
  // 各組繳交狀態與收件頁（票 22）；`/dashboard/teacher/affairs/<id>` 同一個守衛。
  { path: '/dashboard/teacher/affairs', role: 'teacher' },
  { path: '/dashboard/student', role: 'student' },
  { path: '/dashboard/student/groups', role: 'student' },
  // 作業區與內容頁（票 17）；`/dashboard/student/affairs/<id>` 同一個守衛。
  { path: '/dashboard/student/affairs', role: 'student' },
  // 通知匣（票 12）：入口是頂列的鈴鐺，不放側欄。
  { path: '/dashboard/admin/inbox', role: 'admin' },
  { path: '/dashboard/teacher/inbox', role: 'teacher' },
  { path: '/dashboard/student/inbox', role: 'student' },
  // 合作案管理（票 20）。前台的 `/industry` 不在這裡：它是「登入後」內容，不分角色（頁面自己顯示登入提示）。
  { path: '/dashboard/teacher/industry', role: 'teacher' },
  { path: '/dashboard/admin/industry', role: 'admin' },
]
