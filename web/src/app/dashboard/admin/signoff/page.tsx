import { redirect } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { legacyAdminRedirect, type SearchParams } from '@/app/dashboard/admin/legacy-redirects'

const PATH = '/dashboard/admin/signoff'

/**
 * 舊網址：系辦「成績」側欄項的「同意書」頁（AD-09；票 25、26）。①（C1-11）把同意書做進作業——
 * 作業分頁「新增 › 同意書（站內表單）」建、繳交狀況的同意書看板管——C2-22 起這裡只轉頁，目標見 `legacy-redirects.ts`。
 * 版本頁 `signoff/[versionId]` 不在這裡，照 C1-11 轉到該作業的繳交狀況（舊包留唯讀）。
 *
 * **先**跑系辦角色檢查再轉頁：老師、學生打這個網址仍到 `/403`，沒登入到登入頁，不會先被轉走（AC-C2-07）。
 */
export default async function AdminSignoffPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole(PATH, 'admin')
  redirect(legacyAdminRedirect(PATH, await searchParams) ?? '/dashboard/admin/affairs/assignments')
}
