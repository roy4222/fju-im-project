/**
 * 系辦後台五個側欄項目底下的分頁列（C 階段規格② 設計方案 §2.2）：左到右的順序、標籤、路由都只在這裡定。
 *
 * 分頁＝路由：每個分頁是自己的 `page.tsx`、自己的 `requireRole`，這裡只放連結清單（元件在 `_tabs.tsx` 的 `AdminTabs`）。
 * 各頁只 import，不得自己再定義一份分頁列（設計方案 §12.1 第 2 條）。規格寫的 `admin/_tabs.ts` 就是這個檔：
 * 跟元件檔 `_tabs.tsx` 同名會讓 TypeScript 與打包器各挑一個，所以叫 `_tabs.consts.ts`。
 *
 * 不在分頁列上、但路由還在的頁：`/signoff`（同意書，之後併進「作業」）、`/home-settings`（之後改前台直接編輯）、
 * `/clock`（測試用時間，只在測試站有）。
 */
export type AdminTab = { readonly href: string; readonly label: string }

export const AFFAIRS_TABS: readonly AdminTab[] = [
  { href: '/dashboard/admin/affairs', label: '公告' },
  { href: '/dashboard/admin/affairs/assignments', label: '作業' },
  { href: '/dashboard/admin/affairs/resources', label: '資源下載' },
  { href: '/dashboard/admin/affairs/rules', label: '專題規則' },
  { href: '/dashboard/admin/showcase', label: '成果展示' },
  { href: '/dashboard/admin/files', label: '檔案' },
]

export const GROUP_TABS: readonly AdminTab[] = [
  { href: '/dashboard/admin/groups', label: '全部組別' },
  { href: '/dashboard/admin/groups/unassigned', label: '未分組學生' },
  { href: '/dashboard/admin/industry', label: '產學合作' },
]

export const GRADING_TABS: readonly AdminTab[] = [
  { href: '/dashboard/admin/grading', label: '成績表' },
  { href: '/dashboard/admin/grading/rules', label: '評分規則' },
  { href: '/dashboard/admin/grading/teachers', label: '評分老師' },
  { href: '/dashboard/admin/grading/settle', label: '結算' },
]

export const ACCOUNT_TABS: readonly AdminTab[] = [
  { href: '/dashboard/admin/accounts', label: '全部帳號' },
  { href: '/dashboard/admin/accounts/pending', label: '待審核' },
  { href: '/dashboard/admin/accounts/disabled', label: '已停用' },
  { href: '/dashboard/admin/accounts/roster', label: '名單匯入' },
]

export const SETTINGS_TABS: readonly AdminTab[] = [
  { href: '/dashboard/admin/cohorts', label: '屆別' },
  { href: '/dashboard/admin/timeline', label: '專題時程' },
  { href: '/dashboard/admin/audit', label: '操作紀錄' },
]
