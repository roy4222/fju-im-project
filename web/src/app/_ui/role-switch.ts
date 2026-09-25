import type { Role } from '@/application/accounts'
import type { AccountLink } from '@/app/_ui/account-menu'

/**
 * 兼任角色的後台切換（票 41；模組 01 §2.1「一個帳號可持有多個角色，登入後可切換目前工作角色」、ACC-10）。
 *
 * 同一個帳號有兩個以上的後台角色（例如老師兼系辦），右上角帳號選單就列出「切換到另一個後台」；
 * 只有一個角色的人什麼都不列。
 *
 * **純導覽，不是授權**：這裡只決定選單上出現哪幾個連結；連過去的每一頁照樣由伺服器端
 * `requireRole` 依資料庫裡的有效角色判斷（用例層再判一次）。選單列錯也進不去沒有的後台。
 */

/** 固定順序：系辦、老師、學生（跟 `homeFor` 的預設優先序一致）。 */
const ORDER: readonly Role[] = ['admin', 'teacher', 'student']

const NAME: Record<Role, string> = { admin: '系辦後台', teacher: '老師後台', student: '學生後台' }

/**
 * 除了 `current` 以外、本人持有的其他後台。
 *
 * - `current`：目前所在的後台角色（後台頂列）；在前台就傳預設進入的那個（`homeFor` 的角色），
 *   前台的「回後台」按鈕已經指向它，選單只補其他的。
 * - 持有的後台角色不到兩個：一律回空陣列（單一角色的人不顯示切換）。
 */
export function otherWorkbenches(roles: readonly Role[], current: Role | null): { role: Role; href: string; name: string }[] {
  const held = ORDER.filter((role) => roles.includes(role))
  if (held.length < 2) return []
  return held.filter((role) => role !== current).map((role) => ({ role, href: `/dashboard/${role}`, name: NAME[role] }))
}

/** 後台頂列帳號選單的切換項目：「切換到系辦後台」「切換到老師後台」…… */
export function roleSwitchLinks(roles: readonly Role[], current: Role | null): AccountLink[] {
  return otherWorkbenches(roles, current).map((w) => ({ href: w.href, label: `切換到${w.name}`, icon: 'switch' }))
}
