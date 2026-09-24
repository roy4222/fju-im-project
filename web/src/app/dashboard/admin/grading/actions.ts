'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { GradingActionState } from '@/app/dashboard/admin/grading/grading-forms'
import type { SchemeStageInput } from '@/application/grading'
import {
  describeAssignEvaluatorReceipt,
  describeRequirementReceipt,
  describeSchemeVersionReceipt,
  getGradingCommand,
} from '@/composition/grading'

/**
 * 管理員「評分」頁的動作（票 23）：建立方案版本、發布、設定每組每階段要幾份評分、指派評分老師。
 * 規則全在用例裡判（權重合計、鎖定、重複指派、帳本冪等）；這裡只把表單收斂成用例要的形狀、把結果翻成一句話。
 */

const text = (formData: FormData, name: string, max = 200) => String(formData.get(name) ?? '').slice(0, max)
const whole = (formData: FormData, name: string) => {
  const raw = text(formData, name).trim()
  return raw === '' ? Number.NaN : Number(raw)
}

/** 方案內容由畫面組成 JSON 送來；長度先擋，形狀在用例裡逐欄驗。 */
function stagesOf(raw: string): SchemeStageInput[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed.slice(0, 20) as SchemeStageInput[]) : []
  } catch {
    return []
  }
}

export async function createSchemeVersionAction(_state: GradingActionState, formData: FormData): Promise<GradingActionState> {
  const result = await getGradingCommand().createSchemeVersion(
    await currentActor(),
    { cohortId: text(formData, 'cohortId'), stages: stagesOf(text(formData, 'stages', 50_000)) },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeSchemeVersionReceipt(result.receipt) }
}

export async function publishSchemeAction(_state: GradingActionState, formData: FormData): Promise<GradingActionState> {
  const result = await getGradingCommand().publishScheme(
    await currentActor(),
    { versionId: text(formData, 'versionId') },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeSchemeVersionReceipt(result.receipt) }
}

export async function setRequirementAction(_state: GradingActionState, formData: FormData): Promise<GradingActionState> {
  const result = await getGradingCommand().setRequirement(
    await currentActor(),
    {
      groupId: text(formData, 'groupId'),
      stageKey: text(formData, 'stageKey', 40),
      requiredCount: whole(formData, 'requiredCount'),
      revision: whole(formData, 'revision'),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeRequirementReceipt(result.receipt) }
}

export async function assignEvaluatorAction(_state: GradingActionState, formData: FormData): Promise<GradingActionState> {
  const result = await getGradingCommand().assign(
    await currentActor(),
    {
      groupId: text(formData, 'groupId'),
      stageKey: text(formData, 'stageKey', 40),
      teacherUserId: text(formData, 'teacherUserId'),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeAssignEvaluatorReceipt(result.receipt) }
}
