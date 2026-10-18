'use server'
import { currentActor } from '@/app/_ui/guard'
import type { BenchOutcome, DraftReceiptView, FinalReceiptView } from '@/app/dashboard/teacher/grading/types'
import { getGradingCommand } from '@/composition/grading'
import type { Err } from '@/shared/result'
import { formatTaipeiMinute, formatTaipeiSecond } from '@/shared/time'

/**
 * 老師評分卡的 Server Action（票 23；TE-06b 改名「儲存草稿」；B 階段 A-02 加評語、正式送出後可重送）：儲存草稿、正式送出。
 *
 * 規則與授權全在用例裡判（本人的有效指派、分數範圍、評語 500 字、已結算不能改、帳本冪等）；這裡只把瀏覽器送來的分數收斂成
 * 一層「項目 key → 字串」，把結果翻成畫面要的回饋。請求編號由畫面產生：同一次送出（連點、斷線重試）帶同一個編號。
 * 老師是誰不從畫面帶，由用例依登入者決定。回執帶這次寫入的版本（`version`＝用例回執的 `serverTime`，就是這一列的 `submitted_real_at`）：
 * 評分卡用它判斷這張收據是不是仍是已知最新的寫入、丟掉比這次寫入更早發出的重抓。
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

/** 評語原樣交給用例判（500 字上限在用例）；這裡只擋非字串與明顯過長的輸入，不截成 500，免得 501 字被默默收下。 */
const commentOf = (value: unknown) => (typeof value === 'string' ? value.slice(0, 2000) : null)

function fail(result: Err): BenchOutcome<never> {
  const fields = Array.isArray(result.details?.fields)
    ? (result.details.fields as unknown[]).filter((f): f is string => typeof f === 'string')
    : undefined
  return { ok: false, code: result.code, message: result.message, ...(fields ? { fields } : {}) }
}

export async function saveGradingDraftAction(
  assignmentId: string,
  scores: unknown,
  comment: unknown,
  requestId: string,
): Promise<BenchOutcome<DraftReceiptView>> {
  const result = await getGradingCommand().saveDraft(
    await currentActor(),
    { assignmentId: str(assignmentId), scores: scoresOf(scores), comment: commentOf(comment) },
    str(requestId),
  )
  if (!result.ok) return fail(result)
  return { ok: true, data: { savedAtText: formatTaipeiMinute(new Date(result.receipt.savedAt)), version: result.receipt.serverTime } }
}

export async function submitGradingAction(
  assignmentId: string,
  scores: unknown,
  comment: unknown,
  requestId: string,
): Promise<BenchOutcome<FinalReceiptView>> {
  const result = await getGradingCommand().submitFinal(
    await currentActor(),
    { assignmentId: str(assignmentId), scores: scoresOf(scores), comment: commentOf(comment) },
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
      version: r.serverTime,
    },
  }
}
