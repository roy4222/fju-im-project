import type { SchemeStage } from '@/application/grading/scheme'
import { averageScore, exactScore, formatScore, sameScore, teacherStageScore, weightedFinal, type ScoreDecimal } from '@/shared/score'

/**
 * 成績表的算術與完成判定（票 24；產品模組 06 §4「7.3 計算規則」「7.4 評分要求與採計」；模組實作設計 06 §2、§4）。
 *
 * ```text
 * 單一老師階段成績 = Σ（項目百分成績 × 項目權重）           （@/shared/score 的 teacherStageScore）
 * 階段成績         = 該階段所有「採計中」正式評分的算術平均
 * 最終成績         = Σ（階段成績 × 階段權重）                 （每個階段都完成才算）
 * ```
 *
 * - **分母＝要求份數**（`stage_requirements.required_count`），不是目前指派幾位老師；分子＝採計中的正式評分數。
 *   完成＝`要求份數 > 0 且 採計數 ≥ 要求份數`。沒設定份數（或設 0）的階段**不算完成**（產品「未設定任何評分要求不能顯示 100% 完成」）。
 * - 尚未送出的分數不當零分；部分平均照算但一定標「尚未完成」；任一階段沒完成，最終成績就是「尚未完成」。
 * - 採計中的評分**不一定掛在有效指派上**：改派選「保留」或「新增」後，舊老師的分數留在已結束的指派上繼續採計。
 * - 一律用**目前方案版本**的項目算（`evaluations` 不可變、記的是送出當時的版本；方案鎖定後套用新版本＝用新權重重算舊分數）。
 * - 中間值保留完整精度，只有顯示時 round-half-up 兩位（82.145 → 82.15；85.287 → 85.29）。
 *   計算明細與匯出的「原始精度」顯示到小數四位（和 `grade_overrides.original_value` 的 numeric(10,4) 對齊；
 *   三位老師平均 83.0966… 顯示 83.0967），但最終成績一律從完整精度的平均算，不從這個顯示值算。
 * - 通過／不通過是結果型 Gate，另外顯示，不進數字。
 *
 * 純函式：成績表、計算明細頁、匯出、套用新版本的影響預覽都用這一份，畫面與匯出的數字才會一致。
 */

/** 一份採計中的正式評分（查詢給的事實）。 */
export type CountedEvaluation = {
  readonly evaluationId: string
  readonly assignmentId: string
  readonly stageKey: string
  readonly teacherUserId: string
  readonly teacherName: string
  readonly scores: Readonly<Record<string, string>>
  readonly submittedAt: Date
  /** 指派已結束（改派時選「保留」「新增」，舊分繼續採計、舊老師不能再改）。 */
  readonly assignmentEnded: boolean
}

export type CountedLine = CountedEvaluation & {
  /** 這位老師這一階段的分數（原始精度：最多小數四位）。 */
  readonly exact: string
  /** 兩位小數。 */
  readonly display: string
  readonly gate: 'pass' | 'fail' | null
}

export type StageStatus = 'complete' | 'incomplete' | 'no_requirement'

export type StageResult = {
  readonly key: string
  readonly name: string
  readonly weight: number
  /** 要求份數；沒設定是 null。 */
  readonly required: number | null
  readonly counted: readonly CountedLine[]
  /** 採計中評分的平均（原始精度：最多小數四位）；還沒有任何採計是 null。沒完成時也照算（部分平均），畫面一定標「尚未完成」。 */
  readonly averageExact: string | null
  /** 平均除不盡、原始精度那一欄是收過的（計算明細寫「≈」）。 */
  readonly averageRounded: boolean
  readonly averageDisplay: string | null
  readonly status: StageStatus
  readonly complete: boolean
  /** 通過／不通過：任一份不通過＝不通過；全部通過＝通過；沒有這種項目或還沒有採計是 null。 */
  readonly gate: 'pass' | 'fail' | null
}

export type GroupResult = {
  readonly stages: readonly StageResult[]
  /** 每個階段都完成。 */
  readonly complete: boolean
  /** 最終成績（原始精度：最多小數四位，從完整精度算出來再收）；沒完成是 null。 */
  readonly finalExact: string | null
  /** 最終除不盡、原始精度是收過的，或任一階段平均是收過的（計算明細寫「≈」）。 */
  readonly finalRounded: boolean
  readonly finalDisplay: string | null
}

export const STAGE_STATUS_LABEL: Record<StageStatus, string> = {
  complete: '已完成',
  incomplete: '尚未完成',
  no_requirement: '尚未設定份數',
}

/** 階段的完成字樣（成績表、匯出共用）：「已完成」「尚未完成（1／2）」「尚未設定份數」。 */
export function describeStageStatus(stage: Pick<StageResult, 'status' | 'counted' | 'required'>): string {
  if (stage.status === 'incomplete') return `尚未完成（${stage.counted.length}／${stage.required}）`
  return STAGE_STATUS_LABEL[stage.status]
}

/** 算一個階段；另外回傳完整精度的平均（最終成績從它算，不從顯示值算）。 */
function evaluateStage(
  stage: SchemeStage,
  required: number | null | undefined,
  counted: readonly CountedEvaluation[],
): { result: StageResult; average: ScoreDecimal | null } {
  const scored = counted
    .filter((c) => c.stageKey === stage.key)
    .map((c) => ({ c, score: teacherStageScore(stage.items, stage.letterMap, c.scores) }))
    .sort((a, b) => a.c.submittedAt.getTime() - b.c.submittedAt.getTime() || a.c.evaluationId.localeCompare(b.c.evaluationId))
  const lines: CountedLine[] = scored.map(({ c, score }) => ({
    ...c,
    exact: exactScore(score.score),
    display: formatScore(score.score),
    gate: score.gate === 'incomplete' ? null : score.gate,
  }))
  const average = averageScore(scored.map((x) => x.score.score))
  const req = required === null || required === undefined || required <= 0 ? null : required
  const status: StageStatus = req === null ? 'no_requirement' : lines.length >= req ? 'complete' : 'incomplete'
  const gates = lines.map((l) => l.gate).filter((g): g is 'pass' | 'fail' => g !== null)
  const gate = gates.length === 0 ? null : gates.includes('fail') ? 'fail' : gates.length === lines.length ? 'pass' : null
  const result: StageResult = {
    key: stage.key,
    name: stage.name,
    weight: stage.weight,
    required: required === undefined ? null : required,
    counted: lines,
    averageExact: average ? exactScore(average) : null,
    averageRounded: average ? !sameScore(exactScore(average), average) : false,
    averageDisplay: average ? formatScore(average) : null,
    status,
    complete: status === 'complete',
    gate,
  }
  return { result, average }
}

export function computeStage(
  stage: SchemeStage,
  required: number | null | undefined,
  counted: readonly CountedEvaluation[],
): StageResult {
  return evaluateStage(stage, required, counted).result
}

/** 一組的成績：每個階段＋最終。`requirements` 是「階段 key → 要求份數」。 */
export function computeGroupResult(
  stages: readonly SchemeStage[],
  requirements: ReadonlyMap<string, number>,
  counted: readonly CountedEvaluation[],
): GroupResult {
  const evaluated = stages.map((s) => evaluateStage(s, requirements.get(s.key) ?? null, counted))
  const results = evaluated.map((e) => e.result)
  const complete = results.length > 0 && results.every((r) => r.complete)
  const final = complete ? weightedFinal(evaluated.map((e) => ({ value: e.average!, weight: e.result.weight }))) : null
  return {
    stages: results,
    complete,
    finalExact: final ? exactScore(final) : null,
    finalRounded: final ? !sameScore(exactScore(final), final) || results.some((r) => r.averageRounded) : false,
    finalDisplay: final ? formatScore(final) : null,
  }
}

/** 計算明細的一行：「(80 + 84.29) ÷ 2 = 82.145 → 82.15」（除不盡時原始精度收到小數四位，寫「≈」）。 */
export function describeStageFormula(stage: StageResult): string {
  if (stage.counted.length === 0 || stage.averageExact === null) return '還沒有採計中的正式評分。'
  const values = stage.counted.map((c) => c.exact)
  const body = values.length === 1 ? values[0]! : `(${values.join(' ＋ ')}) ÷ ${values.length}`
  return `${body} ${approx(stage.averageRounded)} ${stage.averageExact} → ${stage.averageDisplay}`
}

const approx = (rounded: boolean) => (rounded ? '≈' : '＝')

/** 計算明細的最終一行：「82.145 × 60% ＋ 90 × 40% ＝ 85.287 → 85.29」；沒完成回 null。 */
export function describeFinalFormula(result: GroupResult): string | null {
  if (!result.complete || result.finalExact === null) return null
  const parts = result.stages.map((s) => `${s.averageExact} × ${s.weight}%`).join(' ＋ ')
  return `${parts} ${approx(result.finalRounded)} ${result.finalExact} → ${result.finalDisplay}`
}

// ── 移除／改派三選一（產品 7.4 Q-GRD01 表格） ─────────────────────────────

export type RemovalChoice = 'keep' | 'replace' | 'add'

export const REMOVAL_CHOICE_LABEL: Record<RemovalChoice, string> = {
  keep: '保留已完成評分',
  replace: '替換評分老師、重新評分',
  add: '明確新增一位評分老師',
}

/**
 * 某個選擇之後的採計事實（預覽與執行共用）：
 *
 * | 選擇 | 舊正式分數 | 要求份數 |
 * |---|---|---|
 * | 保留 | 繼續採計 | 不變（不另外產生補評要求） |
 * | 替換 | 退出採計（改為歷史） | 不變（新老師送出前算缺評） |
 * | 新增 | 繼續採計 | ＋1（評分總人數增加） |
 */
export function applyRemovalChoice(
  choice: RemovalChoice,
  input: {
    readonly stageKey: string
    readonly assignmentId: string
    readonly requirements: ReadonlyMap<string, number>
    readonly counted: readonly CountedEvaluation[]
  },
): { requirements: Map<string, number>; counted: CountedEvaluation[] } {
  const requirements = new Map(input.requirements)
  let counted = [...input.counted]
  if (choice === 'replace') counted = counted.filter((c) => c.assignmentId !== input.assignmentId)
  if (choice === 'add') requirements.set(input.stageKey, (requirements.get(input.stageKey) ?? 0) + 1)
  counted = counted.map((c) => (c.assignmentId === input.assignmentId ? { ...c, assignmentEnded: true } : c))
  return { requirements, counted }
}

// ── 更正 ────────────────────────────────────────────────────────────────────

export type OverrideState = 'effective' | 'pending_review' | 'superseded'

export const OVERRIDE_STATE_LABEL: Record<OverrideState, string> = {
  effective: '生效中',
  pending_review: '待復核',
  superseded: '已被取代',
}

export type OverrideSummary = {
  readonly id: string
  readonly originalValue: string
  readonly newValue: string
  readonly reason: string
  readonly state: OverrideState
}

/**
 * 畫面與匯出「採用」的最終成績（產品 7.5）：
 * - 有生效中的更正：用更正值（原值另外列）。
 * - 更正待復核：**不套用**在新的計算基礎上，照算出來的值（沒完成就是尚未完成），另標「更正待復核」。
 */
export function adoptedFinal(
  result: Pick<GroupResult, 'finalDisplay'>,
  override: OverrideSummary | null,
): { readonly value: string | null; readonly source: 'computed' | 'override'; readonly pendingReview: boolean } {
  if (override?.state === 'effective') return { value: formatScore(override.newValue), source: 'override', pendingReview: false }
  return { value: result.finalDisplay, source: 'computed', pendingReview: override?.state === 'pending_review' }
}

/** 更正註記（成績表與匯出同一句）。 */
export function describeOverride(override: OverrideSummary | null): string {
  if (!override || override.state === 'superseded') return ''
  const change = `原 ${formatScore(override.originalValue)} → ${formatScore(override.newValue)}`
  return override.state === 'effective'
    ? `已更正：${change}（${override.reason}）`
    : `更正待復核：${change}（計算基礎已改變，目前不套用）`
}
