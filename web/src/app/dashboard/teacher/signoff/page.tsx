import { redirect } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'

/**
 * 舊網址「站內同意書」（票 25、26）：TE-04 起同意書搬進作業區；C1-11 拿掉「同意書」分頁、等你同意的併進「我的作業」，這裡轉到作業區。
 *
 * **先**跑老師角色檢查再轉頁：學生打這個網址仍到 `/403`，不會先被轉到作業區。
 * 版本頁 `/dashboard/teacher/signoff/{versionId}` 不動（通知、卡片按鈕都連到那裡）。
 */
export default async function TeacherSignoffPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  await requireRole('/dashboard/teacher/signoff', 'teacher')
  redirect('/dashboard/teacher/affairs')
}
