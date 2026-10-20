'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { HomeRemindState } from '@/app/dashboard/admin/remind-forms'
import { describeGradingReminder, describeOverdueReminder, getReminderCommand } from '@/composition/reminders'

/**
 * 系辦首頁待辦卡的「催繳」（C 階段規格① §8、AC-34，C1-15）。規則全在用例（系辦、24 小時冷卻、只催逾期未繳／未送齊的人）；
 * 這裡只翻譯結果。成功與失敗都刷新：按鈕換成伺服器上的最新冷卻狀態，結果句子由按鈕顯示。
 */

/** 逾期未繳卡：每份已截止、還有人逾期的作業各催一次；24 小時內催過的那幾份略過並在句子裡說。 */
export async function remindOverdueAction(cohortId: string, requestId: string): Promise<HomeRemindState> {
  const result = await getReminderCommand().remindOverdue(
    await currentActor(),
    { cohortId: String(cohortId ?? '').slice(0, 100) },
    String(requestId ?? '').slice(0, 100),
  )
  refresh()
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, message: describeOverdueReminder(result.receipt) }
}

/** 評分還差卡：未送齊的老師各一則「您還有 N 份評分未送出」；同一屆 24 小時一次。 */
export async function remindGradingAction(cohortId: string, requestId: string): Promise<HomeRemindState> {
  const result = await getReminderCommand().remindGrading(
    await currentActor(),
    { cohortId: String(cohortId ?? '').slice(0, 100) },
    String(requestId ?? '').slice(0, 100),
  )
  refresh()
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, message: describeGradingReminder(result.receipt) }
}
