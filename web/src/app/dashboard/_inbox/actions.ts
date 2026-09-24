'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { InboxActionState } from '@/app/dashboard/_inbox/inbox-forms'
import { getInboxCommand, parseInboxFilter } from '@/composition/inbox'

/**
 * 通知匣的兩個動作（票 12；契約 02 §7）：單筆標已讀、全部標已讀。
 *
 * 這裡只做「表單 → 用例 → 畫面回饋」的翻譯。「是不是本人的通知」在用例裡判：
 * 直接打這個 Server Action、帶別人的通知編號，一樣回「無法存取」而且什麼都不改。
 */
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
