'use server'
import { refresh } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentActor, homeFor } from '@/app/_ui/guard'
import type { InboxActionState } from '@/app/dashboard/_inbox/inbox-forms'
import { getInboxCommand, parseInboxFilter } from '@/composition/inbox'

/**
 * 通知匣的動作（票 12；契約 02 §7）：點開一則（C2-15）、單筆標已讀、全部標已讀。
 *
 * 這裡只做「表單 → 用例 → 畫面回饋」的翻譯。「是不是本人的通知」在用例裡判：
 * 直接打這個 Server Action、帶別人的通知編號，一樣回「無法存取」而且什麼都不改。
 */
const INBOXES = new Set(['/dashboard/student/inbox', '/dashboard/teacher/inbox', '/dashboard/admin/inbox'])

/**
 * 點開一則通知（C2-15）：本人的 → 標已讀、導去來源**重新解析**出來的頁面。
 * 別人的、不存在的、或來源沒有頁面 → 回自己的收件匣（別人的、不存在的什麼都沒改）。
 * 用 POST 的表單而不是 GET 連結：預抓取不會把通知誤標成已讀。回去的收件匣只認三個固定路徑，不收任意網址。
 */
export async function openNotificationAction(formData: FormData): Promise<void> {
  const actor = await currentActor()
  const result = await getInboxCommand().open(actor, String(formData.get('notificationId') ?? ''))
  if (result.ok && result.receipt.href) redirect(result.receipt.href)
  const inbox = String(formData.get('inbox') ?? '')
  const home = homeFor(actor)
  redirect(INBOXES.has(inbox) ? inbox : home === '/' ? '/' : `${home}/inbox`)
}

export async function markReadAction(_state: InboxActionState, formData: FormData): Promise<InboxActionState> {
  const result = await getInboxCommand().markRead(await currentActor(), String(formData.get('notificationId') ?? ''))
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: '已標為已讀。' }
}

export async function markAllReadAction(_state: InboxActionState, formData: FormData): Promise<InboxActionState> {
  const filter = parseInboxFilter(String(formData.get('cohort') ?? ''))
  const result = await getInboxCommand().markAllRead(await currentActor(), filter)
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  const changed = result.receipt.changed
  return { ok: true, message: changed > 0 ? `已把 ${changed} 則標為已讀。` : '沒有未讀的通知。' }
}
