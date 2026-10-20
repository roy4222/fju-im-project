/**
 * logo 彩蛋的規則（規格④ 設計方案 §10）：純函式，`easter-egg.tsx` 用。
 * 首頁 5 秒內連點 logo 10 次：第 3 下起晃（並預載 FlyingButton）、第 10 下起飛。
 * 首頁以外第 1 下照常回首頁；鍵盤 Enter 不算（`click` 的 `detail` 是 0）。
 */

export const EGG_WINDOW_MS = 5000
export const EGG_SHAKE_AT = 3
export const EGG_FIRE_AT = 10

export type EggState = { readonly count: number; readonly since: number }

export const EGG_START: EggState = { count: 0, since: 0 }

/** 這一下要不要算（算的話要 `preventDefault()`：首頁不重新導向、不閃換頁骨架）。 */
export function shouldCountClick(pathname: string | null, event: { readonly detail: number }): boolean {
  return pathname === '/' && event.detail > 0
}

/** 記一下點擊。距第一下超過 5 秒、或上一輪已經到 10 下，就從這一下重新算。 */
export function eggClick(state: EggState, now: number): EggState {
  if (state.count === 0 || state.count >= EGG_FIRE_AT || now - state.since > EGG_WINDOW_MS) return { count: 1, since: now }
  return { count: state.count + 1, since: state.since }
}

export function eggStage(count: number): 'idle' | 'shake' | 'fire' {
  if (count >= EGG_FIRE_AT) return 'fire'
  return count >= EGG_SHAKE_AT ? 'shake' : 'idle'
}
