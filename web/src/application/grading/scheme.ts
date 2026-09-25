import { err, type Err } from '@/shared/result'
import { LETTER_GRADES, type LetterGrade, type LetterMap, type ScoreItemType } from '@/shared/score'

/**
 * 評分方案的型別與純規則（產品模組 06 §4「7.2 評分方案」；模組實作設計 06 §3、附錄 A `stages`）。
 *
 * - 可以有多個計分階段（例如系統驗收、專題發表），每階段占總成績的百分比，**階段合計必須 100%**。
 * - 每階段有多個項目，**項目權重合計必須 100%**（通過／不通過項目是結果型 Gate，不占權重、不算進合計）。
 * - 項目三種：數字（有滿分）、等第 A／B／C／D／F（依本版本的對照表轉成數字）、通過／不通過。
 * - 不合法就不能建立、不能發布，錯誤訊息指出是哪一層、哪一個階段或項目。
 * - 方案版本寫了就不能改（資料庫 trigger 守）；要改結構就建新版本。第一位老師開始填（第一份暫存或正式送出）後，目前版本鎖定（產品 7.5）。
 *
 * **這裡的「階段」是評分方案的計分階段，不是票 11 屆別時間軸的四個階段**（兩件事分開，見 schema/grading.ts）。
 * 這個檔沒有資料庫：權重怎麼驗、key 怎麼補，都在這裡單獨測。
 */

export type SchemeItemType = ScoreItemType

export const ITEM_TYPE_LABEL: Record<SchemeItemType, string> = {
  number: '分數',
  letter: '等第 A–F',
  passfail: '通過／不通過',
}

export type SchemeItem = {
  readonly key: string
  readonly name: string
  readonly type: SchemeItemType
  /** 數字項目的滿分；其他兩種是 null。 */
  readonly max: number | null
  /** 百分比（整數）；通過／不通過是 0。 */
  readonly weight: number
}

export type SchemeStage = {
  readonly key: string
  readonly name: string
  /** 占總成績的百分比（整數）。 */
  readonly weight: number
  /** 等第對照表（本階段有等第項目時才有）。 */
  readonly letterMap: LetterMap | null
  readonly items: readonly SchemeItem[]
}

export type SchemeVersionStatus = 'draft' | 'published' | 'locked'

export const SCHEME_STATUS_LABEL: Record<SchemeVersionStatus, string> = {
  draft: '草稿',
  published: '已發布',
  locked: '已鎖定',
}

/** 預設等第對照（原型 2026-09-11 的數值）；管理員可以在方案裡改，隨版本保存。 */
export const DEFAULT_LETTER_MAP: LetterMap = { A: 95, B: 85, C: 75, D: 65, F: 50 }

export const SCHEME_LIMITS = {
  stages: 6,
  itemsPerStage: 12,
  nameLength: 30,
  maxScore: 1000,
} as const

/** 畫面送來的原始輸入（字串或數字都收，在這裡正規化）。 */
export type SchemeItemInput = {
  readonly key?: string
  readonly name: string
  readonly type: string
  readonly max?: number | string | null
  readonly weight: number | string
}

export type SchemeStageInput = {
  readonly key?: string
  readonly name: string
  readonly weight: number | string
  readonly letterMap?: Partial<Record<string, number | string>> | null
  readonly items: readonly SchemeItemInput[]
}

const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/

function asInt(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d{1,4}$/.test(text)) return null
  return Number(text)
}

function nextKey(prefix: string, used: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const key = `${prefix}${n}`
    if (!used.has(key)) {
      used.add(key)
      return key
    }
  }
}

function fail(message: string, field: string): Err {
  return err('VALIDATION_FAILED', message, { details: { field } })
}

/**
 * 這個方案**歷來所有版本**用過的代號（建立新版本時傳給 `normalizeSchemeStages`）。
 *
 * 新增的階段與項目一律拿「從沒用過」的代號：刪掉 `s1` 再新增一個階段，新的會是 `s3` 而不是又一個 `s1`——
 * 否則要求份數、評分指派、暫存分數會靜悄悄接到一個不相干的新階段或新項目上（票 23 審查 P1）。
 * 項目代號在整個方案裡都不重用（不只同一階段），規則簡單、不會漏。
 */
export type ReservedSchemeKeys = { readonly stageKeys: ReadonlySet<string>; readonly itemKeys: ReadonlySet<string> }

export const NO_RESERVED_KEYS: ReservedSchemeKeys = { stageKeys: new Set(), itemKeys: new Set() }

/** 從歷來版本的 `stages` 收集用過的階段與項目代號。 */
export function collectSchemeKeys(versions: readonly (readonly SchemeStage[])[]): ReservedSchemeKeys {
  const stageKeys = new Set<string>()
  const itemKeys = new Set<string>()
  for (const stages of versions) {
    for (const stage of stages) {
      stageKeys.add(stage.key)
      for (const item of stage.items) itemKeys.add(item.key)
    }
  }
  return { stageKeys, itemKeys }
}

/**
 * 整理並驗證方案內容。合法時回傳要存進 `stages` jsonb 的樣子（沒給 key 的階段與項目補上 `s1`、`i1`…，
 * 跳過 `reserved` 裡歷來用過的代號）。
 * 錯誤訊息指出是哪一層不合：階段合計、第幾階段的項目合計、哪一個項目的滿分或型態。
 */
export function normalizeSchemeStages(
  input: readonly SchemeStageInput[],
  reserved: ReservedSchemeKeys = NO_RESERVED_KEYS,
): { ok: true; value: SchemeStage[] } | Err {
  if (!Array.isArray(input) || input.length === 0) return fail('至少要有一個計分階段。', 'stages')
  if (input.length > SCHEME_LIMITS.stages) return fail(`計分階段最多 ${SCHEME_LIMITS.stages} 個。`, 'stages')

  const stageKeys = new Set<string>()
  for (const raw of input) {
    const key = typeof raw.key === 'string' ? raw.key.trim() : ''
    if (!key) continue
    if (!KEY_PATTERN.test(key) || stageKeys.has(key)) return fail('階段代號重複或格式不對，請重新整理頁面再建立。', 'stages')
    stageKeys.add(key)
  }

  // 新代號要避開：這一版明寫的代號＋歷來版本用過的代號。
  const takenStageKeys = new Set([...stageKeys, ...reserved.stageKeys])
  const takenItemKeys = new Set(reserved.itemKeys)
  for (const raw of input) {
    for (const item of Array.isArray(raw.items) ? raw.items : []) {
      const key = typeof item.key === 'string' ? item.key.trim() : ''
      if (key) takenItemKeys.add(key)
    }
  }

  const stages: SchemeStage[] = []
  for (const [index, raw] of input.entries()) {
    const label = `第 ${index + 1} 個階段`
    const name = String(raw.name ?? '').trim()
    if (!name) return fail(`請填${label}的名稱。`, `stage${index + 1}.name`)
    if (name.length > SCHEME_LIMITS.nameLength) return fail(`${label}的名稱最多 ${SCHEME_LIMITS.nameLength} 個字。`, `stage${index + 1}.name`)
    const weight = asInt(raw.weight)
    if (weight === null || weight < 1 || weight > 100) {
      return fail(`「${name}」占總成績的百分比要是 1–100 的整數。`, `stage${index + 1}.weight`)
    }

    const items = Array.isArray(raw.items) ? raw.items : []
    if (items.length === 0) return fail(`「${name}」至少要有一個評分項目。`, `stage${index + 1}.items`)
    if (items.length > SCHEME_LIMITS.itemsPerStage) {
      return fail(`「${name}」的評分項目最多 ${SCHEME_LIMITS.itemsPerStage} 個。`, `stage${index + 1}.items`)
    }

    const itemKeys = new Set<string>()
    for (const item of items) {
      const key = typeof item.key === 'string' ? item.key.trim() : ''
      if (!key) continue
      if (!KEY_PATTERN.test(key) || itemKeys.has(key)) return fail('項目代號重複或格式不對，請重新整理頁面再建立。', `stage${index + 1}.items`)
      itemKeys.add(key)
    }

    const normalizedItems: SchemeItem[] = []
    for (const [itemIndex, rawItem] of items.entries()) {
      const field = `stage${index + 1}.item${itemIndex + 1}`
      const itemName = String(rawItem.name ?? '').trim()
      if (!itemName) return fail(`請填「${name}」第 ${itemIndex + 1} 個項目的名稱。`, `${field}.name`)
      if (itemName.length > SCHEME_LIMITS.nameLength) {
        return fail(`「${itemName}」的名稱最多 ${SCHEME_LIMITS.nameLength} 個字。`, `${field}.name`)
      }
      const type = rawItem.type
      if (type !== 'number' && type !== 'letter' && type !== 'passfail') {
        return fail(`「${itemName}」的型態要是分數、等第或通過／不通過。`, `${field}.type`)
      }
      let max: number | null = null
      let itemWeight = 0
      if (type === 'number') {
        max = asInt(rawItem.max)
        if (max === null || max < 1 || max > SCHEME_LIMITS.maxScore) {
          return fail(`「${itemName}」的滿分要是 1–${SCHEME_LIMITS.maxScore} 的整數。`, `${field}.max`)
        }
      }
      if (type !== 'passfail') {
        const w = asInt(rawItem.weight)
        if (w === null || w < 1 || w > 100) return fail(`「${itemName}」的權重要是 1–100 的整數。`, `${field}.weight`)
        itemWeight = w
      }
      const key = typeof rawItem.key === 'string' && rawItem.key.trim() ? rawItem.key.trim() : nextKey('i', takenItemKeys)
      normalizedItems.push({ key, name: itemName, type, max, weight: itemWeight })
    }

    const scored = normalizedItems.filter((i) => i.type !== 'passfail')
    if (scored.length === 0) return fail(`「${name}」至少要有一個分數或等第項目（通過／不通過不算分）。`, `stage${index + 1}.items`)
    const itemSum = scored.reduce((sum, i) => sum + i.weight, 0)
    if (itemSum !== 100) {
      return fail(`「${name}」的項目權重合計是 ${itemSum}%，要剛好 100% 才能建立。`, `stage${index + 1}.itemWeights`)
    }

    let letterMap: LetterMap | null = null
    if (normalizedItems.some((i) => i.type === 'letter')) {
      const source = raw.letterMap ?? DEFAULT_LETTER_MAP
      const map: Partial<Record<LetterGrade, number>> = {}
      for (const grade of LETTER_GRADES) {
        const value = asInt(source[grade])
        if (value === null || value > 100) {
          return fail(`「${name}」的等第對照表：${grade} 要對到 0–100 的整數。`, `stage${index + 1}.letterMap`)
        }
        map[grade] = value
      }
      const values = LETTER_GRADES.map((g) => map[g]!)
      if (values.some((v, i) => i > 0 && v > values[i - 1]!)) {
        return fail(`「${name}」的等第對照表要由 A 到 F 遞減（A 不能比 B 低）。`, `stage${index + 1}.letterMap`)
      }
      letterMap = map as LetterMap
    }

    const key = typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : nextKey('s', takenStageKeys)
    stages.push({ key, name, weight, letterMap, items: normalizedItems })
  }

  const names = new Set(stages.map((s) => s.name))
  if (names.size !== stages.length) return fail('計分階段的名稱不能重複。', 'stages')

  const stageSum = stages.reduce((sum, s) => sum + s.weight, 0)
  if (stageSum !== 100) {
    return fail(`各階段占總成績的合計是 ${stageSum}%，要剛好 100% 才能建立。`, 'stageWeights')
  }

  return { ok: true, value: stages }
}

/** 讀回資料庫的 `stages` jsonb（已經驗過；讀不懂就當成空的，不讓頁面炸掉）。 */
export function readSchemeStages(raw: unknown): SchemeStage[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((s): SchemeStage[] => {
    if (typeof s !== 'object' || s === null) return []
    const stage = s as Record<string, unknown>
    const items = Array.isArray(stage.items) ? stage.items : []
    return [
      {
        key: String(stage.key ?? ''),
        name: String(stage.name ?? ''),
        weight: Number(stage.weight ?? 0),
        letterMap: (stage.letterMap as LetterMap | null | undefined) ?? null,
        items: items.map((i) => {
          const item = i as Record<string, unknown>
          return {
            key: String(item.key ?? ''),
            name: String(item.name ?? ''),
            type: (item.type as SchemeItemType) ?? 'number',
            max: item.max === null || item.max === undefined ? null : Number(item.max),
            weight: Number(item.weight ?? 0),
          }
        }),
      },
    ]
  })
}

/** 一行公式說明（管理畫面「即時顯示公式」）。 */
export function describeFormula(stages: readonly SchemeStage[]): string {
  return `最終成績 = ${stages.map((s) => `${s.name} × ${s.weight}%`).join(' ＋ ')}；階段成績＝各位老師正式評分的平均。`
}
