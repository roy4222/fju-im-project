import { err, type Err } from '@/shared/result'
import { charLength } from '@/shared/text'

/**
 * 評分項目的側表（C 階段 C1-04；設計方案① §1.3、§3.4）：對應作業、給老師看的說明、評審組。
 *
 * 三樣都不影響分數，所以不放進不可變的方案版本：改了不建新版、不鎖、不重算。這裡是不碰資料庫的純規則：
 * 輸入整理、評審組展開、評審組一致性檢查與它的錯誤訊息；交易、上鎖與寫入在 `infrastructure/grading/pg-stage-settings.ts`。
 */

/** 說明的上限（資料庫 `grading_stage_settings_description_check` 同一個數，按字元數算）。 */
export const MAX_STAGE_DESCRIPTION_LENGTH = 500
/** 評審組代號的上限（`grading_stage_settings_panel_key_check`）。 */
export const MAX_PANEL_KEY_LENGTH = 40

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type StageSettingFields = {
  readonly itemId: string | null
  readonly description: string | null
  readonly panelKey: string | null
}

/** 沒給或只有空白 → null；其餘去掉頭尾空白。 */
function text(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 整理系辦送來的三欄：空字串當「不設定」；說明 ≤ 500 字、評審組代號 ≤ 40 字、對應作業要是 UUID。
 * 三欄都是 null＝刪掉這一列（呼叫端處理）。
 */
export function normalizeStageSetting(input: {
  readonly itemId?: unknown
  readonly description?: unknown
  readonly panelKey?: unknown
}): { ok: true; value: StageSettingFields } | Err {
  const itemId = text(input.itemId)
  if (itemId === undefined || (itemId !== null && !UUID.test(itemId))) {
    return err('VALIDATION_FAILED', '對應作業格式不對，請重新整理頁面再選。', { details: { field: 'itemId' } })
  }
  const description = text(input.description)
  if (description === undefined) return err('VALIDATION_FAILED', '說明格式不對，請重新整理頁面再試。', { details: { field: 'description' } })
  if (description !== null && [...description].length > MAX_STAGE_DESCRIPTION_LENGTH) {
    return err('VALIDATION_FAILED', `說明最多 ${MAX_STAGE_DESCRIPTION_LENGTH} 字，請刪短一點再存。`, { details: { field: 'description' } })
  }
  const panelKey = text(input.panelKey)
  if (panelKey === undefined || (panelKey !== null && [...panelKey].length > MAX_PANEL_KEY_LENGTH)) {
    return err('VALIDATION_FAILED', '評審組格式不對，請重新整理頁面再選。', { details: { field: 'panelKey' } })
  }
  return { ok: true, value: { itemId, description, panelKey } }
}

/**
 * 評審組展開：`stageKey` 屬於某個評審組（`panelKey` 非 null）時回傳同組全部項目，否則只有它自己。
 * 只認 `currentKeys`（目前已發布版本有的項目），依 `stage_key` 排序（上鎖順序同這個順序）。
 */
export function panelStageKeys(
  settings: readonly { readonly stageKey: string; readonly panelKey: string | null }[],
  stageKey: string,
  currentKeys: readonly string[],
): string[] {
  const live = new Set(currentKeys)
  const panelKey = settings.find((s) => s.stageKey === stageKey)?.panelKey ?? null
  if (panelKey === null) return [stageKey]
  const keys = new Set([stageKey, ...settings.filter((s) => s.panelKey === panelKey && live.has(s.stageKey)).map((s) => s.stageKey)])
  return [...keys].sort()
}

export type PanelGroupFacts = {
  readonly groupId: string
  readonly groupCode: string
  /** 每個項目的「要幾位老師評」；沒設定過當 0。 */
  readonly requiredByStage: ReadonlyMap<string, number>
  /** 每個項目目前的有效評分老師。 */
  readonly teachersByStage: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * 評審組一致性（設計方案① §1.3）：對每一組，評審組裡每個項目的有效指派老師集合與「要幾位老師評」都要相同。
 * 回傳不一致的組別代號（依代號排序）；都一致是空陣列。
 */
export function panelMismatches(stageKeys: readonly string[], groups: readonly PanelGroupFacts[]): string[] {
  if (stageKeys.length < 2) return []
  const signature = (g: PanelGroupFacts, key: string) =>
    `${g.requiredByStage.get(key) ?? 0}|${[...(g.teachersByStage.get(key) ?? [])].sort().join(',')}`
  return groups
    .filter((g) => {
      const first = signature(g, stageKeys[0]!)
      return stageKeys.some((k) => signature(g, k) !== first)
    })
    .map((g) => g.groupCode)
    .sort()
}

/** 「G03、G07 的『系統驗收』與『專題發表』評審不同，請先在評分老師分頁對齊。」 */
export function describePanelMismatch(groupCodes: readonly string[], stageNames: readonly string[]): string {
  return `${groupCodes.join('、')} 的${stageNames.map((n) => `『${n}』`).join('與')}評審不同，請先在評分老師分頁對齊。`
}

/**
 * 選填的理由（X2；設計方案① §1.4）：沒給或只有空白 → null；有填就去掉頭尾空白、驗長度。
 * 只有「退回評分」仍必填（不走這裡）。
 */
export function optionalReason(raw: unknown, what: string, max = 500): { ok: true; value: string | null } | Err {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'string') return err('VALIDATION_FAILED', `${what}格式不對，請重新整理頁面再試。`, { details: { field: 'reason' } })
  const value = raw.trim()
  if (value === '') return { ok: true, value: null }
  if (charLength(value) > max) return err('VALIDATION_FAILED', `${what}最多 ${max} 字。`, { details: { field: 'reason' } })
  return { ok: true, value }
}
