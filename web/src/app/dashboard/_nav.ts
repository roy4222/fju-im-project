import type { NavItem } from '@/app/_ui/site-shell'
import type { Role } from '@/application/accounts'

/**
 * 三種後台的側欄掛載點與**受保護路由清單**（票 #47）。
 *
 * 分組、順序、名稱照原型 `prototype/src/lib/nav-config.ts`（票 35 對齊系辦與老師；學生在票 38）。
 * 分組與圖示由 `_ui/dashboard-frame.tsx` 依網址最後一段對應；這裡的順序就是同一組內的順序。
 * 只放已經做出來的頁：沒做的功能不要先放上去，不然使用者會點進去撲空
 * （原型的「內容編輯器」依 Vault 04「單一入口」不放；「操作紀錄」等票 36 做出頁面再加）。
 */
export const ADMIN_NAV: readonly NavItem[] = [
  // 總覽
  { href: '/dashboard/admin', label: '首頁' },
  { href: '/dashboard/admin/timeline', label: '時間軸設定' },
  // 通知（票 12）：頂列鈴鐺之外，原型側欄也有入口。
  { href: '/dashboard/admin/inbox', label: '通知' },
  // 專題事務
  { href: '/dashboard/admin/affairs', label: '專題事務' },
  // 檔案管理（票 35）：全站檔案的檢視（下載、引用位置），不另做一套檔案系統。
  { href: '/dashboard/admin/files', label: '檔案管理' },
  // 精選（票 25）：替各組建精選草稿（不發布）。原型沒有這一項，放在專題事務組。
  { href: '/dashboard/admin/showcase', label: '精選' },
  // 分組與產學
  { href: '/dashboard/admin/groups', label: '分組總覽' },
  // 產學合作（票 20）：全部合作案與組別連結。
  { href: '/dashboard/admin/industry', label: '產學合作' },
  // 評分與簽核：成績管理（票 23／24）＝方案版本、指派、成績表；簽核（票 25／26）。
  { href: '/dashboard/admin/grading', label: '成績管理' },
  { href: '/dashboard/admin/signoff', label: '簽核' },
  // 系統管理
  { href: '/dashboard/admin/accounts', label: '帳號管理' },
  // 屆別（票 5）：原型併在時間軸頁；正式碼另一頁，放系統管理組。
  { href: '/dashboard/admin/cohorts', label: '屆別' },
]

export const TEACHER_NAV: readonly NavItem[] = [
  // 總覽
  { href: '/dashboard/teacher', label: '首頁' },
  { href: '/dashboard/teacher/inbox', label: '通知' },
  // 各組繳交狀態（票 22）：原型側欄沒有這一項（入口在首頁），正式碼保留，放專題事務組。
  { href: '/dashboard/teacher/affairs', label: '各組繳交' },
  // 分組與產學：分組總覽（票 19，產學組認領與全部組別）、產學合作（票 20，自己的合作案）。
  { href: '/dashboard/teacher/groups', label: '分組總覽' },
  { href: '/dashboard/teacher/industry', label: '產學合作' },
  // 評分與簽核：評分工作台（票 23，只有被指派的組別）、簽核（票 25／26）。
  { href: '/dashboard/teacher/grading', label: '評分' },
  { href: '/dashboard/teacher/signoff', label: '簽核' },
]

export const STUDENT_NAV: readonly NavItem[] = [
  { href: '/dashboard/student', label: '首頁' },
  { href: '/dashboard/student/groups', label: '我的組別' },
  // 作業區（票 17）：自己在收件名單上的個人收件；組別收件在票 21 併進來。
  { href: '/dashboard/student/affairs', label: '作業區' },
  // 成績（票 23）：只有一句「學生不會看到分數」，不查任何評分資料。
  { href: '/dashboard/student/grading', label: '成績' },
  // 簽核（票 25）：自己組別的簽核版本全文（逐人同意在票 26）。
  { href: '/dashboard/student/signoff', label: '簽核' },
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
  // 檔案管理（票 35）。
  { path: '/dashboard/admin/files', role: 'admin' },
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
  // 通知匣（票 12）：入口是頂列的鈴鐺；系辦側欄另有「通知」（票 35 照原型）。
  { path: '/dashboard/admin/inbox', role: 'admin' },
  { path: '/dashboard/teacher/inbox', role: 'teacher' },
  { path: '/dashboard/student/inbox', role: 'student' },
  // 合作案管理（票 20）。前台的 `/industry` 不在這裡：它是「登入後」內容，不分角色（頁面自己顯示登入提示）。
  { path: '/dashboard/teacher/industry', role: 'teacher' },
  { path: '/dashboard/admin/industry', role: 'admin' },
  // 簽核與精選（票 25）；版本頁 `/dashboard/{admin,teacher}/signoff/<版本>` 同一個守衛。
  { path: '/dashboard/admin/signoff', role: 'admin' },
  { path: '/dashboard/admin/showcase', role: 'admin' },
  { path: '/dashboard/teacher/signoff', role: 'teacher' },
  { path: '/dashboard/student/signoff', role: 'student' },
]
