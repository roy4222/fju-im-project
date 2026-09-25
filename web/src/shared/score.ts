import Decimal from 'decimal.js'

/**
 * 評分的算術（產品模組 06 §4「7.3 計算規則」；模組實作設計 06 §4）。
 *
 * ```text
 * 項目百分成績   = 實得分數 / 項目滿分 × 100（等第項目＝方案版本的對照表數值）
 * 單一老師階段成績 = Σ（項目百分成績 × 項目權重 / 100）
 * ```
 *
 * - 一律用 decimal，不用浮點當權威；中間值保留完整精度，只有顯示時 round-half-up 到兩位小數。
 * - 通過／不通過項目是結果型 Gate，**不**進數字總分，另外顯示。
 *
 * 放在 shared：伺服器算正式回執與老師工作台的即時預覽（Client Component）要用**同一份**算式，
 * 而 app 的 Client Component 不能在執行期引用 application（母 spec §4.3）。這裡只有純運算，沒有任何規則判斷之外的東西。
 */

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })
export type ScoreDecimal = InstanceType<typeof D>

export const LETTER_GRADES = ['A', 'B', 'C', 'D', 'F'] as const
export type LetterGrade = (typeof LETTER_GRADES)[number]
export type LetterMap = Readonly<Record<LetterGrade, number>>

export type ScoreItemType = 'number' | 'letter' | 'passfail'

export type ScoreItemSpec = {
  readonly key: string
  readonly type: ScoreItemType
  /** 數字項目的滿分；等第、通過／不通過是 null。 */
  readonly max: number | null
  /** 百分比；通過／不通過是 0。 */
  readonly weight: number
}

/** 分數最多兩位小數（例：84.29）。 */
const NUMBER_PATTERN = /^\d{1,4}(\.\d{1,2})?$/

export type ScoreParse = { ok: true; value: string } | { ok: false; reason: 'format' | 'range' | 'option' }

/** 單一項目的輸入是否合法；合法時回傳正規化後要存的字串（數字去掉多餘的 0，例如 "80.50" → "80.5"）。 */
export function parseItemScore(item: ScoreItemSpec, raw: string): ScoreParse {
  const text = raw.trim()
  if (item.type === 'letter') {
    const upper = text.toUpperCase()
    return (LETTER_GRADES as readonly string[]).includes(upper) ? { ok: true, value: upper } : { ok: false, reason: 'option' }
  }
  if (item.type === 'passfail') {
    return text === 'pass' || text === 'fail' ? { ok: true, value: text } : { ok: false, reason: 'option' }
  }
  if (!NUMBER_PATTERN.test(text)) return { ok: false, reason: 'format' }
  const value = new D(text)
  if (value.lessThan(0) || value.greaterThan(item.max ?? 0)) return { ok: false, reason: 'range' }
  return { ok: true, value: value.toString() }
}

/** 這一項的百分成績（0–100）；通過／不通過或沒填、不合法回 null。 */
function itemPercent(item: ScoreItemSpec, value: string, letterMap: LetterMap | null): ScoreDecimal | null {
  if (item.type === 'number') return new D(value).dividedBy(item.max!).times(100)
  if (item.type === 'letter') {
    const mapped = letterMap?.[value as LetterGrade]
    return mapped === undefined ? null : new D(mapped)
  }
  return null
}

export type StageScoreResult = {
  /** 已填且合法的計分項目加權總和（完整精度）。 */
  readonly score: ScoreDecimal
  /** 已填且合法的項目數（含通過／不通過）。 */
  readonly filled: number
  /** 項目總數（含通過／不通過）。 */
  readonly total: number
  /** 不合法的項目 key。 */
  readonly invalid: readonly string[]
  /** 通過／不通過項目的結果：沒有這種項目是 null；有任一項沒填是 'incomplete'。 */
  readonly gate: 'pass' | 'fail' | 'incomplete' | null
}

/** 單一老師的階段成績（只算已填的項目；填齊才是正式分數）。 */
export function teacherStageScore(
  items: readonly ScoreItemSpec[],
  letterMap: LetterMap | null,
  scores: Readonly<Record<string, string | undefined>>,
): StageScoreResult {
  let score = new D(0)
  let filled = 0
  const invalid: string[] = []
  const gates: ('pass' | 'fail' | null)[] = []

  for (const item of items) {
    const raw = scores[item.key]
    const parsed = raw === undefined || raw.trim() === '' ? null : parseItemScore(item, raw)
    if (parsed && !parsed.ok) invalid.push(item.key)
    const value = parsed?.ok ? parsed.value : null
    if (item.type === 'passfail') {
      gates.push(value === 'pass' || value === 'fail' ? value : null)
      if (value) filled += 1
      continue
    }
    if (!value) continue
    filled += 1
    const percent = itemPercent(item, value, letterMap)
    if (percent) score = score.plus(percent.times(item.weight).dividedBy(100))
  }

  const gate: StageScoreResult['gate'] =
    gates.length === 0 ? null : gates.includes('fail') ? 'fail' : gates.includes(null) ? 'incomplete' : 'pass'
  return { score, filled, total: items.length, invalid, gate }
}

/** 顯示用：round-half-up 兩位小數（82.145 → "82.15"）。 */
export function formatScore(value: ScoreDecimal | string | number): string {
  return new D(value).toFixed(2, Decimal.ROUND_HALF_UP)
}

/** 多位老師的算術平均（完整精度；票 24 的成績表用）。 */
export function averageScore(values: readonly (ScoreDecimal | string)[]): ScoreDecimal | null {
  if (values.length === 0) return null
  return values.reduce<ScoreDecimal>((sum, v) => sum.plus(new D(v)), new D(0)).dividedBy(values.length)
}

/** 最終成績＝Σ（階段成績 × 階段權重 / 100）（完整精度；票 24）。 */
export function weightedFinal(parts: readonly { readonly value: ScoreDecimal | string; readonly weight: number }[]): ScoreDecimal {
  return parts.reduce<ScoreDecimal>((sum, p) => sum.plus(new D(p.value).times(p.weight).dividedBy(100)), new D(0))
}

/**
 * 「原始精度」的字串：最多小數四位（round-half-up、去掉尾巴的 0；例：82.145、85.287、83.0966… → 83.0967）。
 * 計算明細與匯出用，和 `grade_overrides.original_value` 的 numeric(10,4) 對齊；**計算一律用完整精度的 decimal**，不用這個字串。
 */
export function exactScore(value: ScoreDecimal | string | number): string {
  return new D(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString()
}

/** 兩個分數是否相等（decimal 比較）。 */
export function sameScore(a: ScoreDecimal | string, b: ScoreDecimal | string): boolean {
  return new D(a).equals(new D(b))
}

/**
 * 管理員更正的最終成績：0–100、最多兩位小數；合法回傳正規化字串，不合法回 null。
 * 更正的是「最終結果」（產品 7.5），跟單一項目的滿分無關。
 */
export function parseFinalScore(raw: string): string | null {
  const text = raw.trim()
  if (!NUMBER_PATTERN.test(text)) return null
  const value = new D(text)
  if (value.lessThan(0) || value.greaterThan(100)) return null
  return value.toString()
}
