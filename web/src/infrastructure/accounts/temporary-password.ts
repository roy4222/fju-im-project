import 'server-only'
import { randomInt } from 'node:crypto'

/**
 * 臨時密碼產生器（契約 03 §3；票 8）。
 *
 * - 用 `crypto.randomInt`（作業系統的安全亂數），不用 `Math.random`——原型那一版是示意用的。
 * - 字母表拿掉容易看錯的 `0 O o 1 l I i`：系辦多半是唸給對方聽或抄在紙上交給本人。
 * - 16 個字元、每 4 個一組用 `-` 隔開（19 個字元）：log2(55)×16 ≈ 92 bits，
 *   遠超過改密規則的 12 個字元下限，本人改密時「新密碼不能跟目前一樣」也不會誤撞。
 */
export const TEMPORARY_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
export const TEMPORARY_PASSWORD_GROUPS = 4
export const TEMPORARY_PASSWORD_GROUP_LENGTH = 4

export function generateTemporaryPassword(pick: (max: number) => number = randomInt): string {
  const groups: string[] = []
  for (let g = 0; g < TEMPORARY_PASSWORD_GROUPS; g += 1) {
    let group = ''
    for (let i = 0; i < TEMPORARY_PASSWORD_GROUP_LENGTH; i += 1) {
      group += TEMPORARY_PASSWORD_ALPHABET[pick(TEMPORARY_PASSWORD_ALPHABET.length)]
    }
    groups.push(group)
  }
  return groups.join('-')
}
