import { redirect } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'

/**
 * 舊網址「合作案」（票 20、37）：TE-05 起合作案搬進分組總覽；C3-09 起那個分頁叫「產學組」（`?tab=industry`），
 * 這裡只轉頁。舊的 `?scope=all`（全部合作案）丟棄：別人的案看前台 `/industry`。
 *
 * **先**跑老師角色檢查再轉頁：學生打這個網址仍到 `/403`，不會先被轉到分組總覽。
 * 表單元件 `./opportunity-forms` 留在這個資料夾，分頁從這裡 import。
 */
export default async function TeacherIndustryPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole('/dashboard/teacher/industry', 'teacher')
  redirect('/dashboard/teacher/groups?tab=industry')
}
