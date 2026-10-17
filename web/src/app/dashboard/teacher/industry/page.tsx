import { redirect } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'

/**
 * 舊網址「合作案」（票 20、37）：TE-05 起合作案搬進分組總覽的「合作案」分頁，這裡只轉頁（`?scope=all` 跟著帶過去）。
 *
 * **先**跑老師角色檢查再轉頁：學生打這個網址仍到 `/403`，不會先被轉到分組總覽。
 * 表單元件 `./opportunity-forms` 留在這個資料夾，分頁從這裡 import。
 */
export default async function TeacherIndustryPage({ searchParams }: { searchParams: Promise<{ scope?: string | string[] }> }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole('/dashboard/teacher/industry', 'teacher')
  const all = (await searchParams).scope === 'all'
  redirect(`/dashboard/teacher/groups?tab=cases${all ? '&scope=all' : ''}`)
}
