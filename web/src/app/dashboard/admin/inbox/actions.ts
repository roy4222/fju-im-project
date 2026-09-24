'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { TestNotificationState } from '@/app/dashboard/admin/inbox/test-notification-form'
import { getTestNotificationCommand } from '@/composition/inbox'

/**
 * 管理端「發一則測試通知」（票 12；模組實作設計 08 §6）。
 *
 * 正式站連這個 Server Action 都會被用例拒絕（頁面上沒有入口只是第一層）。
 * 通知不是這裡寫的：這裡只發事件，背景工作最多幾秒後把它投影進收件人的通知匣。
 */
export async function sendTestNotificationAction(
  _state: TestNotificationState,
  formData: FormData,
): Promise<TestNotificationState> {
  const values = {
    recipientUserId: String(formData.get('recipientUserId') ?? ''),
    cohortId: String(formData.get('cohortId') ?? ''),
    title: String(formData.get('title') ?? ''),
  }
  const result = await getTestNotificationCommand().send(await currentActor(), values, String(formData.get('requestId') ?? ''))
  if (!result.ok) return { ok: false, message: result.message, values }
  // 重新整理：頁面換一個新的請求編號，下一次按才會是新的一則（同一個編號重送只會回第一次的回執）。
  refresh()
  return {
    ok: true,
    message: `已發給 ${result.receipt.recipientName}。背景工作幾秒內會把它送進對方的通知匣。`,
  }
}
