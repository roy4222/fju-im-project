import { redirect } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { STUDENT_LEGACY_REDIRECTS } from '@/app/dashboard/student/legacy-redirects'

const PATH = '/dashboard/student/timeline'

/**
 * 舊網址：學生後台時間軸頁（ST-7）。頁面已拿掉，這裡只轉頁，目標見 `legacy-redirects.ts`。
 *
 * **先**跑學生角色檢查再轉頁：老師、系辦打這個網址仍到 `/403`，沒登入到登入頁，不會先被轉走。
 */
export default async function StudentTimelinePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole(PATH, 'student')
  redirect(STUDENT_LEGACY_REDIRECTS[PATH])
}
