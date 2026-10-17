/**
 * 頭像的純規則（SH-8；Q105、Q109）。沒有資料庫、沒有 Next，前後端都能用。
 *
 * 顯示順序：上傳的檔（`/api/files/<id>`）> 選的預設圖（`/avatars/NNN.webp`）> 依帳號 id hash 固定一張。
 * 沒設定時**不在建立帳號時寫入**，每次用 hash 算，所以同一個人永遠是同一張（Q105）。
 * 上傳、縮圖、重設是 SH-9。
 */

/** 頭像要的最小資料。各來源（Actor、組員、表態列）的 id／姓名欄名不同，呼叫端自己組這個物件。 */
export type AvatarUser = {
  readonly id: string
  readonly name: string
  readonly avatarPreset: number | null
  readonly avatarFileId: string | null
}

/** 預設圖張數（`public/avatars/001～100.webp`；資料庫 CHECK `avatar_preset between 1 and 100`）。 */
export const AVATAR_PRESET_COUNT = 100

/** 上傳頭像的大小上限（縮圖前的原檔）。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/** 依帳號 id 固定挑一張預設圖：FNV-1a 32 位元 hash（fmix32 收尾）mod 100 + 1。只看 id，不看姓名，改名不換圖。 */
export function avatarHashPreset(userId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // FNV 的低位元分布差（直接 mod 100 只會落到 25 張），收尾用 murmur3 fmix32 打散。
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return ((h >>> 0) % AVATAR_PRESET_COUNT) + 1
}

function isPreset(n: number | null): n is number {
  return n !== null && Number.isInteger(n) && n >= 1 && n <= AVATAR_PRESET_COUNT
}

/** 這個人的頭像網址。 */
export function avatarUrl(user: AvatarUser): string {
  if (user.avatarFileId) return `/api/files/${user.avatarFileId}`
  const n = isPreset(user.avatarPreset) ? user.avatarPreset : avatarHashPreset(user.id)
  return `/avatars/${String(n).padStart(3, '0')}.webp`
}
