'use server'
import { randomUUID } from 'node:crypto'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { TimelineActionState } from '@/app/dashboard/admin/timeline/timeline-forms'
import { cohortLabel, getTimelineCommand, STAGE_COUNT } from '@/composition/cohorts'

/**
 * 時間軸頁的動作（票 11；契約 02 §7）：存階段與年度結束日、新增活動、改期、刪除活動。
 * ③ C3-06：活動可以跨日（開始日／結束日）；排定中的直接刪除；`moveActivityAction` 給甘特拖拉只改起訖日。
 * `cancelActivityAction` 保留（用例還在）但畫面不再掛。
 *
 * 這裡只做「表單 → 用例 → 畫面回饋」的翻譯；誰能做、日期怎麼驗、版本有沒有過期，
 * 全部在用例裡判（直接打這個 Server Action 的人一樣會被用例擋下）。
 * 請求編號由頁面在伺服器端產生、放在隱藏欄位：同一張表單按兩次只會做一次。
 */

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '')

function activityInput(formData: FormData) {
  return {
    title: text(formData, 'title'),
    description: text(formData, 'description'),
    startDate: text(formData, 'startDate'),
    endDate: text(formData, 'endDate'),
    allDay: formData.get('allDay') === 'on',
    startTime: text(formData, 'startTime'),
    endTime: text(formData, 'endTime'),
    audience: text(formData, 'audience'),
  }
}

export async function saveScheduleAction(
  _state: TimelineActionState,
  formData: FormData,
): Promise<TimelineActionState> {
  const stages = Array.from({ length: STAGE_COUNT }, (_, i) => ({
    name: text(formData, `stage${i + 1}.name`),
    startDate: text(formData, `stage${i + 1}.startDate`),
    description: text(formData, `stage${i + 1}.description`),
  }))
  const result = await getTimelineCommand().saveSchedule(
    await currentActor(),
    text(formData, 'cohortId'),
    { stages, yearEndDate: text(formData, 'yearEndDate') },
    Number(text(formData, 'revision')),
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }

  refresh()
  const changed = result.receipt.changedStages
  return {
    ok: true,
    message: changed.length
      ? `已儲存${cohortLabel(result.receipt)}的階段與日期（第 ${changed.join('、')} 階段的日期有變）。`
      : `已儲存${cohortLabel(result.receipt)}的階段（日期沒有變）。`,
  }
}

export async function createActivityAction(
  _state: TimelineActionState,
  formData: FormData,
): Promise<TimelineActionState> {
  const result = await getTimelineCommand().createActivity(
    await currentActor(),
    text(formData, 'cohortId'),
    activityInput(formData),
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: `已新增活動「${result.receipt.title}」。` }
}

export async function updateActivityAction(
  _state: TimelineActionState,
  formData: FormData,
): Promise<TimelineActionState> {
  const result = await getTimelineCommand().updateActivity(
    await currentActor(),
    text(formData, 'activityId'),
    activityInput(formData),
    Number(text(formData, 'revision')),
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: `已更新活動「${result.receipt.title}」。` }
}

export async function cancelActivityAction(
  _state: TimelineActionState,
  formData: FormData,
): Promise<TimelineActionState> {
  const result = await getTimelineCommand().cancelActivity(
    await currentActor(),
    text(formData, 'activityId'),
    Number(text(formData, 'revision')),
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: `已取消活動「${result.receipt.title}」；它會留在「已取消」清單。` }
}

export async function deleteActivityAction(
  _state: TimelineActionState,
  formData: FormData,
): Promise<TimelineActionState> {
  const result = await getTimelineCommand().deleteActivity(
    await currentActor(),
    text(formData, 'activityId'),
    Number(text(formData, 'revision')),
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: `已刪除活動「${result.receipt.title}」。` }
}

/**
 * 甘特拖拉放開（③ §9.3）：只改起訖日，其他欄位沿用。請求編號在這裡產生——拖拉沒有表單，
 * 每次放開都是新的一次操作。非全天、沒寫結束時間的拉成跨日由用例擋（「跨日的活動要填結束時間」）。
 */
export async function moveActivityAction(
  activityId: string,
  revision: number,
  startDate: string,
  endDate: string,
): Promise<{ ok: true; message?: string } | { ok: false; message: string }> {
  const result = await getTimelineCommand().moveActivity(
    await currentActor(),
    String(activityId),
    { startDate: String(startDate), endDate: String(endDate) },
    Number(revision),
    randomUUID(),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: `已更新活動「${result.receipt.title}」。` }
}
