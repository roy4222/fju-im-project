'use server'
import { frontEditActor } from '@/app/_ui/front-edit/actor'
import {
  ACTIVITY_AUDIENCE_LABEL,
  ACTIVITY_AUDIENCES,
  ACTIVITY_DESCRIPTION_MAX_LENGTH,
  ACTIVITY_TITLE_MAX_LENGTH,
  activityFormValues,
  cohortLabel,
  getBusinessClockQuery,
  getCohortStatusQuery,
  getTimelineCommand,
  getTimelineQuery,
} from '@/composition/cohorts'
import { taipeiDateOf } from '@/shared/time'

/**
 * 前台直接編輯「活動」的 Server Function（C3-08；規格③ §9.6、§14.4；②§6.3.1 `FeFormModule`）。
 *
 * 延遲表單 `./activity.tsx` 不直接 import 這個檔（會把 Server Function 的客戶端接線拆進共用 chunk，全站變大），
 * 由 `_ui/front-edit/forms.ts` 的登錄行在載入模組時用 `provideActivityFeActions` 交進去。
 *
 * - `activityFeContextAction`：開窗要的脈絡——對象選項與欄位上限、今天（新增的預填日）；新增時落在哪一屆
 *   （區塊有 `data-fe-cohort` 就用它，**沒有就取預設工作屆別**，跟 `admin/timeline/page.tsx` 選屆別同一條；
 *   沒有工作屆別回「還沒有工作屆別」）；編輯時那一筆的欄位與目前 revision（首頁標記只有名稱）。
 * - `saveActivityFeAction`：新增或編輯，走既有用例；**不 `refresh()`**，刷新是框架的事（§14.4）。
 * - `removeActivityFeAction`：刪除用例（排定中的直接刪，§9.1）；標記沒帶 revision 時先讀目前的 revision。
 *
 * 每個 action 先過 `frontEditActor()`（SEC-1：重新解析 session，只放行過得了 business 狀態閘門的系辦——
 * 例如必須改密碼的帳號在讀取前就被拒）；誰能做什麼仍由用例再判一次。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NO_COHORT = '還沒有工作屆別'
const GONE = '這個活動已經不在了（可能剛被刪除），請重新整理頁面。'

type ActivityValues = {
  title: string
  description: string
  startDate: string
  endDate: string
  allDay: boolean
  startTime: string
  endTime: string
  audience: string
}

type ActivityFeContext =
  | {
      ok: true
      limits: { audiences: { value: string; label: string }[]; titleMaxLength: number; descriptionMaxLength: number }
      /** 臺灣的今天（業務鐘）：新增的開始日、結束日預填。 */
      today: string
      /** 新增落在哪一屆；編輯是 null。 */
      cohort: { id: string; label: string } | null
      /** 編輯時那一筆目前的內容；新增是 null。 */
      current: { revision: number; values: ActivityValues } | null
    }
  | { ok: false; message: string }

type ActivityFeSaveResult = { ok: true; id: string; message: string } | { ok: false; message: string }

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

/** 新增要落的屆別：給了就用那一屆（要是還沒封存的），沒給就是預設工作屆別。 */
async function targetCohort(cohortId: string | null) {
  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  return cohortId ? cohorts.find((c) => c.id === cohortId) ?? null : cohorts.find((c) => c.isDefaultWorking) ?? null
}

/** 用 id 找活動：前台標記沒帶屆別，在還沒封存的各屆裡找（已刪除的不列）。 */
async function findActivity(id: string) {
  const cohorts = (await getCohortStatusQuery().list()).filter((c) => c.status !== 'archived')
  const activities = await getTimelineQuery().activitiesFor(cohorts.map((c) => c.id))
  return activities.find((a) => a.id === id) ?? null
}

export async function activityFeContextAction(input: { id: string | null; cohortId: string | null }): Promise<ActivityFeContext> {
  const actor = await frontEditActor()
  if (!actor) return { ok: false, message: '只有系辦可以在前台編輯；請重新登入。' }
  const limits = {
    audiences: ACTIVITY_AUDIENCES.map((value) => ({ value, label: ACTIVITY_AUDIENCE_LABEL[value] })),
    titleMaxLength: ACTIVITY_TITLE_MAX_LENGTH,
    descriptionMaxLength: ACTIVITY_DESCRIPTION_MAX_LENGTH,
  }
  const today = taipeiDateOf((await getBusinessClockQuery().state()).businessNow)
  const id = typeof input?.id === 'string' && input.id !== '' ? input.id : null
  if (id === null) {
    const wanted = typeof input?.cohortId === 'string' && input.cohortId !== '' ? input.cohortId : null
    const cohort = await targetCohort(wanted)
    if (!cohort) return { ok: false, message: wanted ? '找不到這個屆別，請重新整理頁面。' : NO_COHORT }
    return { ok: true, limits, today, cohort: { id: cohort.id, label: cohortLabel(cohort) }, current: null }
  }
  if (!UUID.test(id)) return { ok: false, message: GONE }
  const activity = await findActivity(id)
  if (!activity) return { ok: false, message: GONE }
  return { ok: true, limits, today, cohort: null, current: { revision: activity.revision, values: activityFormValues(activity) } }
}

export async function saveActivityFeAction(formData: FormData): Promise<ActivityFeSaveResult> {
  const actor = await frontEditActor()
  if (!actor) return { ok: false, message: '只有系辦可以在前台編輯；請重新登入。' }
  const command = getTimelineCommand()
  const activityId = text(formData, 'activityId')
  if (activityId) {
    const result = await command.updateActivity(
      actor,
      activityId,
      activityInput(formData),
      Number(text(formData, 'revision')),
      text(formData, 'requestId'),
    )
    if (!result.ok) return { ok: false, message: result.message }
    return { ok: true, id: result.receipt.activityId, message: `已更新活動「${result.receipt.title}」。` }
  }
  // 表單沒帶屆別（區塊沒有 `data-fe-cohort`）：送出時再取一次預設工作屆別，跟開窗時同一條。
  const cohort = await targetCohort(text(formData, 'cohortId') || null)
  if (!cohort) return { ok: false, message: NO_COHORT }
  const result = await command.createActivity(actor, cohort.id, activityInput(formData), text(formData, 'requestId'))
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, id: result.receipt.activityId, message: `已新增活動「${result.receipt.title}」。` }
}

export async function removeActivityFeAction(input: {
  id: string
  revision: number | null
  requestId: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const actor = await frontEditActor()
  if (!actor) return { ok: false, message: '只有系辦可以在前台編輯；請重新登入。' }
  const id = String(input?.id ?? '')
  if (!UUID.test(id)) return { ok: false, message: GONE }
  let revision = input.revision
  if (revision === null || !Number.isInteger(revision)) {
    // 首頁標記沒帶 `data-fe-rev`：以目前的版本刪，被別人同時改到會由用例回 CONFLICT。
    const activity = await findActivity(id)
    if (!activity) return { ok: false, message: GONE }
    revision = activity.revision
  }
  const result = await getTimelineCommand().deleteActivity(actor, id, revision, String(input.requestId ?? ''))
  return result.ok ? { ok: true } : { ok: false, message: result.message }
}
