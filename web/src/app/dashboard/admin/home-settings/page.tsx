import { redirect } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { legacyAdminRedirect, type SearchParams } from '@/app/dashboard/admin/legacy-redirects'

const PATH = '/dashboard/admin/home-settings'

/**
 * 舊網址：系辦「首頁設定」（第三波 W3 的大圖與兩行標語）。C2-17 起改在前台直接編輯
 * （編輯模式的「首頁橫幅」，`_ui/front-edit/forms/hero-form.tsx`），這裡只轉頁，目標見 `legacy-redirects.ts`。
 *
 * **先**跑系辦角色檢查再轉頁：老師、學生打這個網址仍到 `/403`，沒登入到登入頁，不會先被轉走（AC-C2-04）。
 */
export default async function AdminHomeSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole(PATH, 'admin')
  redirect(legacyAdminRedirect(PATH, await searchParams) ?? '/')
}
