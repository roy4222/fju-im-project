/**
 * GA4 的「頁面位置」只送固定路由名稱（訪客規格 §3.10、AC-VI-68）。
 *
 * 實際網址會帶作品 ID、`?q=<姓名>`、`?token=…`，一律不送。這裡把 `usePathname()` 對到 App Router 的
 * 路由樣板（`/projects/[id]` → `/projects/:id`）；對不到的路徑送 `/(other)`，寧可少一點統計也不外流。
 *
 * 新頁面要在 GA 看到自己的名字，就在這裡加一行樣板；沒加只會落在 `/(other)`，不會漏個資。
 * 註冊三步、重設密碼、隱私權政策先列進來（VB-3、VB-4、VB-11 會建這些頁）。
 */
export const ROUTE_TEMPLATES = [
  '/',
  '/403',
  '/account',
  '/account/change-password',
  '/account/setup',
  '/competitions',
  '/dashboard/admin',
  '/dashboard/admin/accounts',
  '/dashboard/admin/affairs',
  '/dashboard/admin/affairs/[id]',
  '/dashboard/admin/audit',
  '/dashboard/admin/clock',
  '/dashboard/admin/cohorts',
  '/dashboard/admin/editor/[id]',
  '/dashboard/admin/editor/new',
  '/dashboard/admin/files',
  '/dashboard/admin/grading',
  '/dashboard/admin/grading/[groupId]',
  '/dashboard/admin/grading/apply/[versionId]',
  '/dashboard/admin/grading/reassign/[assignmentId]',
  '/dashboard/admin/grading/rules',
  '/dashboard/admin/groups',
  '/dashboard/admin/home-settings',
  '/dashboard/admin/inbox',
  '/dashboard/admin/industry',
  '/dashboard/admin/settings',
  '/dashboard/admin/showcase',
  '/dashboard/admin/signoff',
  '/dashboard/admin/signoff/[versionId]',
  '/dashboard/admin/timeline',
  '/dashboard/student',
  '/dashboard/student/affairs',
  '/dashboard/student/affairs/[id]',
  '/dashboard/student/grading',
  '/dashboard/student/groups',
  '/dashboard/student/inbox',
  '/dashboard/student/industry',
  '/dashboard/student/signoff',
  '/dashboard/student/timeline',
  '/dashboard/teacher',
  '/dashboard/teacher/affairs',
  '/dashboard/teacher/affairs/[id]',
  '/dashboard/teacher/grading',
  '/dashboard/teacher/grading/[groupId]',
  '/dashboard/teacher/groups',
  '/dashboard/teacher/inbox',
  '/dashboard/teacher/industry',
  '/dashboard/teacher/signoff',
  '/dashboard/teacher/signoff/[versionId]',
  '/files',
  '/forgot-password',
  '/honors',
  '/industry',
  '/industry/[id]',
  '/login',
  '/news',
  '/news/[id]',
  '/privacy',
  '/projects',
  '/projects/[id]',
  '/projects/featured',
  '/register',
  '/register/apply',
  '/register/pending',
  '/register/verify',
  '/reset-password',
  '/rules',
  '/timeline',
] as const

export const OTHER_ROUTE = '/(other)'

type Compiled = { segments: string[]; name: string; dynamicCount: number }

const compiled: Compiled[] = ROUTE_TEMPLATES.map((template) => {
  const segments = template.split('/').filter(Boolean)
  return {
    segments,
    name: '/' + segments.map((s) => (s.startsWith('[') ? `:${s.slice(1, -1)}` : s)).join('/'),
    dynamicCount: segments.filter((s) => s.startsWith('[')).length,
  }
})
  // 靜態段優先：`/projects/featured` 要先於 `/projects/[id]`。
  .sort((a, b) => a.dynamicCount - b.dynamicCount)

/** 把實際路徑換成路由名稱。query、hash 一律丟掉；對不到樣板回 `/(other)`。 */
export function routeName(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? ''
  const parts = path.split('/').filter(Boolean)
  for (const route of compiled) {
    if (route.segments.length !== parts.length) continue
    if (route.segments.every((s, i) => s.startsWith('[') || s === parts[i])) return route.name
  }
  return OTHER_ROUTE
}
