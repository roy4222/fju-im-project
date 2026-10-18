import { redirect } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { legacyAdminRedirect, type SearchParams } from '@/app/dashboard/admin/legacy-redirects'

const PATH = '/dashboard/admin/settings'

/**
 * 舊網址：系辦「設定」入口頁（AD-20 的四張卡）。側欄「設定」改成直接進「屆別」分頁（C 階段規格② §2.3），
 * 這裡只轉頁，目標見 `legacy-redirects.ts`。
 *
 * **先**跑系辦角色檢查再轉頁：老師、學生打這個網址仍到 `/403`，沒登入到登入頁，不會先被轉走。
 */
export default async function AdminSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole(PATH, 'admin')
  redirect(legacyAdminRedirect(PATH, await searchParams) ?? '/dashboard/admin/cohorts')
}
