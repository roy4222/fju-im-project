import type { NavItem } from '@/app/_ui/site-shell'
import type { Role } from '@/application/accounts'

/**
 * 三種後台的側欄掛載點與**受保護路由清單**（票 #47）。
 *
 * 管理員側欄現在有「帳號管理」「屆別」「時間軸」——名單、分組、繳交、評分、簽核
 * 各自由自己的切片加進來。沒做的功能不要先放上去，不然使用者會點進去撲空。
 */
export const ADMIN_NAV: readonly NavItem[] = [
  { href: '/dashboard/admin', label: '首頁' },
  { href: '/dashboard/admin/accounts', label: '帳號管理' },
  { href: '/dashboard/admin/cohorts', label: '屆別' },
  { href: '/dashboard/admin/timeline', label: '時間軸' },
  { href: '/dashboard/admin/groups', label: '分組總覽' },
  { href: '/dashboard/admin/affairs', label: '專題事務' },
  // 合作案（票 20）：全部合作案與組別連結。
  { href: '/dashboard/admin/industry', label: '產學合作' },
  // 評分（票 23）：方案版本、要求份數、指派評分老師。
  { href: '/dashboard/admin/grading', label: '成績管理' },
  // 簽核（票 25）：建簽核版本、各組目前版本；精選（票 25）：替各組建精選草稿（不發布）。
  { href: '/dashboard/admin/signoff', label: '簽核' },
  { href: '/dashboard/admin/showcase', label: '精選' },
  // 操作紀錄（票 36）：稽核紀錄唯讀清單，只給管理員。
  { href: '/dashboard/admin/audit', label: '操作紀錄' },
]

export const TEACHER_NAV: readonly NavItem[] = [
  { href: '/dashboard/teacher', label: '首頁' },
  // 分組（票 19）：產學組認領與全部組別。
  { href: '/dashboard/teacher/groups', label: '分組' },
  // 各組繳交狀態（票 22）：自己此刻指導的組 × 整組收件的矩陣，點進去看版本。
  { href: '/dashboard/teacher/affairs', label: '各組繳交' },
  // 我的合作案（票 20）：建立、發布、下架自己的產學合作案。
  { href: '/dashboard/teacher/industry', label: '我的合作案' },
  // 評分工作台（票 23）：只有被指派的組別。
  { href: '/dashboard/teacher/grading', label: '評分' },
  // 簽核（票 25）：此刻指導的組的簽核版本（老師同意在票 26）。
  { href: '/dashboard/teacher/signoff', label: '簽核' },
]

/**
 * 學生側欄照原型的順序與字（票 38）：總覽（首頁、專題時間軸、通知）→ 作業區 → 我的組別、產學合作 → 成績、同意書。
 * 原型學生側欄沒有「成績」；正式碼保留這一列（Vault 後台頁面清單：學生 `/grading` 是明確頁面），列在 PR 衝突清單。
 */
export const STUDENT_NAV: readonly NavItem[] = [
  { href: '/dashboard/student', label: '首頁' },
  // 專題時間軸（票 38）：本屆階段與日期，唯讀。
  { href: '/dashboard/student/timeline', label: '專題時間軸' },
  // 通知匣（票 12）：頂列鈴鐺之外，原型學生側欄也有一列。
  { href: '/dashboard/student/inbox', label: '通知' },
  // 作業區（票 17）：自己在收件名單上的個人收件；組別收件在票 21 併進來。
  { href: '/dashboard/student/affairs', label: '作業區' },
  { href: '/dashboard/student/groups', label: '我的組別' },
  // 產學合作（票 38）：已發布的合作案卡片，點進前台詳情。
  { href: '/dashboard/student/industry', label: '產學合作' },
  // 成績（票 23）：只有一句「學生不會看到分數」，不查任何評分資料。
  { href: '/dashboard/student/grading', label: '成績' },
  // 同意書（票 25、26；原型學生側欄叫「同意書」）：自己組別的簽核版本全文與逐人同意。
  { href: '/dashboard/student/signoff', label: '同意書' },
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
  // 評分（票 23）；老師的評閱桌 `/dashboard/teacher/grading/<組別>` 同一個守衛。
  { path: '/dashboard/admin/grading', role: 'admin' },
  { path: '/dashboard/teacher/grading', role: 'teacher' },
  { path: '/dashboard/student/grading', role: 'student' },
  { path: '/dashboard/teacher', role: 'teacher' },
  { path: '/dashboard/teacher/groups', role: 'teacher' },
  // 各組繳交狀態與收件頁（票 22）；`/dashboard/teacher/affairs/<id>` 同一個守衛。
  { path: '/dashboard/teacher/affairs', role: 'teacher' },
  { path: '/dashboard/student', role: 'student' },
  { path: '/dashboard/student/groups', role: 'student' },
  // 作業區與內容頁（票 17）；`/dashboard/student/affairs/<id>` 同一個守衛。
  { path: '/dashboard/student/affairs', role: 'student' },
  // 專題時間軸與產學合作（票 38）。
  { path: '/dashboard/student/timeline', role: 'student' },
  { path: '/dashboard/student/industry', role: 'student' },
  // 通知匣（票 12）：入口是頂列的鈴鐺，不放側欄。
  { path: '/dashboard/admin/inbox', role: 'admin' },
  { path: '/dashboard/teacher/inbox', role: 'teacher' },
  { path: '/dashboard/student/inbox', role: 'student' },
  // 合作案管理（票 20）。前台的 `/industry` 不在這裡：它是「登入後」內容，不分角色（頁面自己顯示登入提示）。
  { path: '/dashboard/teacher/industry', role: 'teacher' },
  { path: '/dashboard/admin/industry', role: 'admin' },
  // 簽核與精選（票 25）；版本頁 `/dashboard/{admin,teacher}/signoff/<版本>` 同一個守衛。
  { path: '/dashboard/admin/signoff', role: 'admin' },
  { path: '/dashboard/admin/showcase', role: 'admin' },
  // 操作紀錄（票 36）：誰、何時、對哪個對象、做了什麼、為什麼；只有管理員讀得到。
  { path: '/dashboard/admin/audit', role: 'admin' },
  { path: '/dashboard/teacher/signoff', role: 'teacher' },
  { path: '/dashboard/student/signoff', role: 'student' },
]
