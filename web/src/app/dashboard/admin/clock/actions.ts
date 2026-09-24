'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { ClockActionState } from '@/app/dashboard/admin/clock/clock-form'
import { getBusinessClockCommand } from '@/composition/cohorts'

/**
 * 模擬業務鐘的設定動作（票 11）。
 *
 * 正式站連這個 Server Action 都會被用例拒絕（頁面 404 只是入口，真正的關卡在用例）：
 * Server Action 的編號跟頁面網址無關，直接打得到，所以一定要在用例裡擋。
 */
export async function setBusinessClockAction(_state: ClockActionState, formData: FormData): Promise<ClockActionState> {
  const values = {
    businessAt: String(formData.get('businessAt') ?? ''),
    reason: String(formData.get('reason') ?? ''),
  }
  const result = await getBusinessClockCommand().set(await currentActor(), values, String(formData.get('requestId') ?? ''))
  if (!result.ok) return { ok: false, message: result.message, values }

  refresh()
  return { ok: true, message: '已設定業務時間，紀錄多了一筆。' }
}
