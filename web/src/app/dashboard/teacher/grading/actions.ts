'use server'
import { currentActor } from '@/app/_ui/guard'
import type { BenchOutcome, FinalReceiptView } from '@/app/dashboard/teacher/grading/types'
import { getGradingCommand } from '@/composition/grading'
import type { Err } from '@/shared/result'
import { formatTaipeiMinute, formatTaipeiSecond } from '@/shared/time'

/**
 * 老師評分工作台的 Server Action（票 23）：暫存、正式送出。
 *
 * 規則與授權全在用例裡判（本人的有效指派、分數範圍、已送出不能改、帳本冪等）；這裡只把瀏覽器送來的分數收斂成
 * 一層「項目 key → 字串」，把結果翻成畫面要的回饋。請求編號由畫面產生：同一次送出（連點、斷線重試）帶同一個編號。
 * 老師是誰不從畫面帶，由用例依登入者決定。
 */

const str = (value: unknown, max = 100) => (typeof value === 'string' ? value.slice(0, max) : '')

function scoresOf(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 50)) {
    if (typeof value === 'string' && value.trim() !== '') out[key.slice(0, 40)] = value.slice(0, 20)
  }
  return out
}

function fail(result: Err): BenchOutcome<never> {
  const fields = Array.isArray(result.details?.fields)
    ? (result.details.fields as unknown[]).filter((f): f is string => typeof f === 'string')
    : undefined
  return { ok: false, code: result.code, message: result.message, ...(fields ? { fields } : {}) }
}

export async function saveGradingDraftAction(
  assignmentId: string,
  scores: unknown,
  requestId: string,
): Promise<BenchOutcome<{ savedAtText: string }>> {
  const result = await getGradingCommand().saveDraft(
    await currentActor(),
    { assignmentId: str(assignmentId), scores: scoresOf(scores) },
    str(requestId),
  )
  if (!result.ok) return fail(result)
  return { ok: true, data: { savedAtText: formatTaipeiMinute(new Date(result.receipt.savedAt)) } }
}

export async function submitGradingAction(assignmentId: string, scores: unknown, requestId: string): Promise<BenchOutcome<FinalReceiptView>> {
  const result = await getGradingCommand().submitFinal(
    await currentActor(),
    { assignmentId: str(assignmentId), scores: scoresOf(scores) },
    str(requestId),
  )
  if (!result.ok) return fail(result)
  const r = result.receipt
  return {
    ok: true,
    data: {
      groupCode: r.groupCode,
      stageName: r.stageName,
      teacherScore: r.teacherScore,
      gate: r.gate,
      receivedAtText: formatTaipeiSecond(new Date(r.receivedAt)),
      evaluationId: r.evaluationId,
    },
  }
}
