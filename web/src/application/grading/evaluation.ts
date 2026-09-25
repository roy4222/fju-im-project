import { err, type Err } from '@/shared/result'
import { formatScore, parseItemScore, teacherStageScore } from '@/shared/score'
import type { SchemeStage } from '@/application/grading/scheme'

/**
 * 老師評分的輸入規則（產品模組 06 §4「7.4 指派、暫存與送出」；模組實作設計 06 §3 評分 draft／counted）。
 *
 * - 暫存可以只填一部分（但填了的每一項都要合法）；正式送出要每一項都填、都合法。
 * - 數字項目 0–滿分、最多兩位小數；等第只收 A／B／C／D／F；通過／不通過只收 pass／fail。
 * - 不認得的項目（方案裡沒有的 key）一律拒絕，不默默丟掉。
 * - 暫存只有本人與管理員看得到，不進正式計算；正式送出後鎖定，要改需管理員退回（票 24）。
 */

export type EvaluationState = 'empty' | 'draft' | 'counted'

export const EVALUATION_STATE_LABEL: Record<EvaluationState, string> = {
  empty: '未開始',
  draft: '暫存中（未正式）',
  counted: '已正式送出',
}

export type ScoreInput = Readonly<Record<string, string>>

const REASON_TEXT = {
  format: '要填數字，最多兩位小數',
  range: '超出範圍',
  option: '選項不對',
} as const

/**
 * 驗證一份分數。`complete=true`（正式送出）時每一項都要填。
 * 合法時回傳要存的樣子（空白項目拿掉、數字正規化）。
 */
export function normalizeScores(
  stage: SchemeStage,
  input: ScoreInput,
  options: { complete: boolean },
): { ok: true; value: Record<string, string> } | Err {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err('VALIDATION_FAILED', '分數格式不對，請重新整理頁面。')
  }
  const known = new Set(stage.items.map((i) => i.key))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) return err('VALIDATION_FAILED', '方案已經更新，這份分數有目前方案沒有的項目；請重新整理頁面。')
  }

  const value: Record<string, string> = {}
  const missing: string[] = []
  for (const [index, item] of stage.items.entries()) {
    const raw = typeof input[item.key] === 'string' ? input[item.key]!.trim() : ''
    if (raw === '') {
      missing.push(item.key)
      continue
    }
    const parsed = parseItemScore(item, raw)
    if (!parsed.ok) {
      const range = item.type === 'number' ? `0–${item.max}` : item.type === 'letter' ? 'A–F' : '通過或不通過'
      return err('VALIDATION_FAILED', `第 ${index + 1} 項「${item.name}」${REASON_TEXT[parsed.reason]}（要 ${range}）。`, {
        details: { field: item.key, fields: [item.key] },
      })
    }
    value[item.key] = parsed.value
  }

  if (options.complete && missing.length > 0) {
    return err('VALIDATION_FAILED', `還差 ${missing.length} 項沒填，填齊才能正式送出。`, {
      details: { field: missing[0], fields: missing },
    })
  }
  return { ok: true, value }
}

/** 單一老師這一階段的分數（兩位小數字串）與填了幾項。 */
export function summarizeScores(stage: SchemeStage, scores: Readonly<Record<string, string>>) {
  const result = teacherStageScore(stage.items, stage.letterMap, scores)
  return { score: formatScore(result.score), filled: result.filled, total: result.total, gate: result.gate }
}
