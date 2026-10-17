import type { Role } from '@/application/accounts'

/**
 * 側欄圖示的名字（共用 SH-1a）。清單只放字串，圖示元件由 client 端 `_ui/dashboard-frame.tsx` 的
 * `NAV_ICONS` 對照：Server Component 不能把元件函式傳給 client（RSC 序列化會錯）。
 */
export const NAV_ICON_NAMES = [
  'home',
  'timeline',
  'inbox',
  'affairs',
  'editor',
  'files',
  'showcase',
  'home-settings',
  'groups',
  'industry',
  'grading',
  'signoff',
  'accounts',
  'cohorts',
  'clock',
  'audit',
  'tasks',
  'settings',
] as const
export type NavIconName = (typeof NAV_ICON_NAMES)[number]

/**
 * 側欄一項。`activeFor`：這些網址也算在這一項（被收進分頁的頁）；`group`：舊清單的分組標題，
 * 只在過渡期有值（各角色的側欄切換票拿掉）。型別原本在 `site-shell.tsx`，那裡 re-export。
 */
export type NavItem = {
  readonly href: string
  readonly label: string
  readonly icon: NavIconName
  readonly activeFor?: readonly string[]
  readonly group?: string
}

/** 側欄這一項在 `current` 這頁要不要亮。 */
export function isNavActive(item: NavItem, current: string): boolean {
  return item.href === current || (item.activeFor?.includes(current) ?? false)
}

/** 頁首標題：亮著那一項的名字；都沒亮就是角色名。 */
export function navTitle(items: readonly NavItem[], current: string, roleLabel: string): string {
  return items.find((item) => isNavActive(item, current))?.label ?? roleLabel
}

/**
 * 三種後台的側欄掛載點與**受保護路由清單**（票 #47）。
 *
 * 系辦（SH-1-AD）：六項、不分組。被收進分頁的頁寫在 `activeFor`，進那些頁時亮所屬那一項、頁首標題也跟著它；
 * 「通知」只在頂列鈴鐺。只放已經做出來的頁：沒做的功能不要先放上去，不然使用者會點進去撲空。
 */
export const ADMIN_NAV: readonly NavItem[] = [
  { href: '/dashboard/admin', label: '首頁', icon: 'home' },
  // 公告與作業：分頁列另有檔案管理、成果展示（AD-03、AD-04）。
  {
    href: '/dashboard/admin/affairs',
    label: '公告與作業',
    icon: 'affairs',
    activeFor: ['/dashboard/admin/showcase', '/dashboard/admin/files'],
  },
  // 分組：合作案分頁（AD-07）。
  { href: '/dashboard/admin/groups', label: '分組', icon: 'groups', activeFor: ['/dashboard/admin/industry'] },
  // 成績：評分規則子頁（AD-08）、站內同意書分頁（AD-09）。
  {
    href: '/dashboard/admin/grading',
    label: '成績',
    icon: 'grading',
    activeFor: ['/dashboard/admin/signoff', '/dashboard/admin/grading/rules'],
  },
  { href: '/dashboard/admin/accounts', label: '帳號', icon: 'accounts' },
  // 設定總頁（AD-20）：四張卡連到屆別、時間軸（含模擬業務鐘）、首頁設定、操作紀錄（AD-12、AD-15）。
  {
    href: '/dashboard/admin/settings',
    label: '設定',
    icon: 'settings',
    activeFor: [
      '/dashboard/admin/cohorts',
      '/dashboard/admin/timeline',
      '/dashboard/admin/home-settings',
      '/dashboard/admin/audit',
    ],
  },
]

export const TEACHER_NAV: readonly NavItem[] = [
  { href: '/dashboard/teacher', label: '首頁', icon: 'home' },
  // 評分工作台（票 23）；評閱桌 `/grading/<組別>` 傳的 current 就是這個 href。
  { href: '/dashboard/teacher/grading', label: '評分', icon: 'grading' },
  // 作業區（TE-04）：各組繳交與同意書分頁；舊網址 `/signoff` 轉進來，版本頁也亮這一項。
  { href: '/dashboard/teacher/affairs', label: '作業區', icon: 'affairs', activeFor: ['/dashboard/teacher/signoff'] },
  // 分組總覽（TE-05）：我的組別與合作案分頁；舊網址 `/industry` 轉進來。
  { href: '/dashboard/teacher/groups', label: '分組總覽', icon: 'groups', activeFor: ['/dashboard/teacher/industry'] },
]

/**
 * 學生（SH-1-ST）：三項、不分組。「通知」只在頂列鈴鐺；同意書收進交作業（同意書卡），
 * 時程在前台 `/timeline`（首頁橫幅「看完整時程」）。舊網址 `/timeline`、`/industry`、`/grading` 轉頁（ST-7）。
 */
export const STUDENT_NAV: readonly NavItem[] = [
  { href: '/dashboard/student', label: '首頁', icon: 'home' },
  // 交作業（ST-3）：作業與同意書同一份清單；同意書頁、舊時間軸網址也亮這一項。
  {
    href: '/dashboard/student/affairs',
    label: '交作業',
    icon: 'tasks',
    activeFor: ['/dashboard/student/signoff', '/dashboard/student/timeline'],
  },
  { href: '/dashboard/student/groups', label: '組別', icon: 'groups' },
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
  // 評分規則子頁（AD-08）：評分規則、版本紀錄、每組要幾份評分與指派。
  { path: '/dashboard/admin/grading/rules', role: 'admin' },
  // 設定總頁（AD-20）：四張卡連到屆別、時間軸、首頁設定、操作紀錄。
  { path: '/dashboard/admin/settings', role: 'admin' },
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
  // 通知匣（票 12）：頂列鈴鐺之外，三個角色的側欄也有「通知」（票 35／38 照原型）。
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
  // 首頁設定（第三波 W3）：首頁大圖與兩行標語。
  { path: '/dashboard/admin/home-settings', role: 'admin' },
  { path: '/dashboard/teacher/signoff', role: 'teacher' },
  { path: '/dashboard/student/signoff', role: 'student' },
]
