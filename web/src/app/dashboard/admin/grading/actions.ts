'use server'
import { refresh } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentActor } from '@/app/_ui/guard'
import type { GradingActionState } from '@/app/dashboard/admin/grading/grading-forms'
import type { ResultsActionState } from '@/app/dashboard/admin/grading/results-forms'
import type { SchemeStageInput } from '@/application/grading'
import type { RemovalChoice } from '@/application/grading'
import {
  describeAssignEvaluatorReceipt,
  describeOverrideReceipt,
  describeRemoveAssignmentReceipt,
  describeRequirementReceipt,
  describeReturnReceipt,
  describeSchemeVersionReceipt,
  getGradingCommand,
  getGradingResultsCommand,
} from '@/composition/grading'

/**
 * 管理員「評分」頁的動作（票 23）：建立方案版本、發布、設定每組每階段要幾份評分、指派評分老師。
 * 票 24：退回、移除／改派三選一、更正最終結果、復核待復核的更正、套用新方案版本。
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

// ── 票 24 ────────────────────────────────────────────────────────────────────


/** 退回、復核成功後，那一份（那一筆更正）就不在原位置了，表單跟著消失：導回明細頁並帶一句回饋。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function returnEvaluationAction(_state: ResultsActionState, formData: FormData): Promise<ResultsActionState> {
  const result = await getGradingResultsCommand().returnEvaluation(
    await currentActor(),
    { evaluationId: text(formData, 'evaluationId'), reason: text(formData, 'reason', 600) },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message, code: result.code }
  const groupId = text(formData, 'groupId')
  if (UUID.test(groupId)) redirect(`/dashboard/admin/grading/${groupId}?returned=${result.receipt.evaluationId}`)
  refresh()
  return { ok: true, message: describeReturnReceipt(result.receipt) }
}

export async function removeAssignmentAction(_state: ResultsActionState, formData: FormData): Promise<ResultsActionState> {
  const newTeacher = text(formData, 'newTeacherUserId')
  const result = await getGradingResultsCommand().removeAssignment(
    await currentActor(),
    {
      assignmentId: text(formData, 'assignmentId'),
      choice: text(formData, 'choice', 10) as RemovalChoice,
      newTeacherUserId: newTeacher === '' ? null : newTeacher,
      reason: text(formData, 'reason', 600),
      basisHash: text(formData, 'basisHash', 80),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message, code: result.code }
  const groupId = text(formData, 'groupId')
  if (UUID.test(groupId)) redirect(`/dashboard/admin/grading/${groupId}?reassigned=${text(formData, 'assignmentId')}`)
  refresh()
  return { ok: true, message: describeRemoveAssignmentReceipt(result.receipt) }
}

export async function overrideAction(_state: ResultsActionState, formData: FormData): Promise<ResultsActionState> {
  const result = await getGradingResultsCommand().override(
    await currentActor(),
    {
      groupId: text(formData, 'groupId'),
      newValue: text(formData, 'newValue', 20),
      reason: text(formData, 'reason', 600),
      basisHash: text(formData, 'basisHash', 80),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message, code: result.code }
  refresh()
  return { ok: true, message: describeOverrideReceipt(result.receipt) }
}

export async function resolveReviewAction(_state: ResultsActionState, formData: FormData): Promise<ResultsActionState> {
  const decision = text(formData, 'decision', 10) === 'new' ? 'new' : 'keep'
  const result = await getGradingResultsCommand().resolveReview(
    await currentActor(),
    {
      overrideId: text(formData, 'overrideId'),
      decision,
      newValue: decision === 'new' ? text(formData, 'newValue', 20) : null,
      reason: text(formData, 'reason', 600),
      basisHash: text(formData, 'basisHash', 80),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message, code: result.code }
  const groupId = text(formData, 'groupId')
  if (UUID.test(groupId)) redirect(`/dashboard/admin/grading/${groupId}?resolved=${result.receipt.overrideId}`)
  refresh()
  return { ok: true, message: `已處理待復核：${describeOverrideReceipt(result.receipt)}` }
}

export async function applySchemeAction(_state: ResultsActionState, formData: FormData): Promise<ResultsActionState> {
  const result = await getGradingResultsCommand().applySchemeVersion(
    await currentActor(),
    { versionId: text(formData, 'versionId'), token: text(formData, 'token', 80) },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message, code: result.code }
  // 套用後這個預覽頁就沒有東西可套了：回評分頁並帶上套用了哪一版（那一頁自己核對是不是目前版本才顯示回饋）。
  const cohortId = text(formData, 'cohortId')
  if (UUID.test(cohortId)) redirect(`/dashboard/admin/grading?cohort=${cohortId}&applied=${result.receipt.versionNo}`)
  refresh()
  return { ok: true, message: `已套用方案 v${result.receipt.versionNo}：各組成績照新版本重算，新版本已鎖定。` }
}
