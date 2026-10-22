import { describe, expect, it } from 'vitest'
import {
  AVATAR_MAX_BYTES,
  AVATAR_PRESET_COUNT,
  AVATAR_RESET_REASON_MAX,
  avatarHashPreset,
  avatarUrl,
  normalizeAvatarResetReason,
  type AvatarUser,
} from '@/application/accounts/avatar'

/** SH-8（AC-SH-41）：頭像網址的純規則。上傳與縮圖是 SH-9。 */

const user = (over: Partial<AvatarUser> = {}): AvatarUser => ({
  id: '0192d4c5-7b1e-7a00-8000-000000000001',
  name: '王小明',
  avatarPreset: null,
  avatarFileId: null,
  ...over,
})

/** 固定產生、看起來像 uuidv7 的 id（測試要可重現，不用亂數）。 */
const fakeId = (i: number) => `0192d4c5-7b1e-7${(i % 4096).toString(16).padStart(3, '0')}-8000-${i.toString(16).padStart(12, '0')}`

describe('avatarUrl', () => {
  it('兩欄都 null：同一個 id 永遠同一張（Q105）', () => {
    const first = avatarUrl(user())
    for (let i = 0; i < 100; i++) expect(avatarUrl(user())).toBe(first)
    expect(first).toMatch(/^\/avatars\/(0\d\d|100)\.webp$/)
  })

  it('1000 個不同 id 落在 1～100，每張至少一次', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 1000; i++) {
      const n = avatarHashPreset(fakeId(i))
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(AVATAR_PRESET_COUNT)
      expect(Number.isInteger(n)).toBe(true)
      seen.add(n)
    }
    expect(seen.size).toBe(AVATAR_PRESET_COUNT)
  })

  it('hash 那張就是 avatarUrl 用的那張（三位數補零）', () => {
    const n = avatarHashPreset(user().id)
    expect(avatarUrl(user())).toBe(`/avatars/${String(n).padStart(3, '0')}.webp`)
  })

  it('選了預設圖：avatarPreset=7 → /avatars/007.webp；100 → /avatars/100.webp', () => {
    expect(avatarUrl(user({ avatarPreset: 7 }))).toBe('/avatars/007.webp')
    expect(avatarUrl(user({ avatarPreset: 1 }))).toBe('/avatars/001.webp')
    expect(avatarUrl(user({ avatarPreset: 100 }))).toBe('/avatars/100.webp')
  })

  it('有上傳檔：/api/files/<id>，優先於 preset', () => {
    const fileId = '0192d4c5-7b1e-7a00-8000-00000000abcd'
    expect(avatarUrl(user({ avatarFileId: fileId }))).toBe(`/api/files/${fileId}`)
    expect(avatarUrl(user({ avatarFileId: fileId, avatarPreset: 7 }))).toBe(`/api/files/${fileId}`)
  })

  it('preset 超出範圍或不是整數（資料庫 CHECK 擋得住，這裡不信任）→ 退回 hash 那張', () => {
    const fallback = avatarUrl(user())
    expect(avatarUrl(user({ avatarPreset: 0 }))).toBe(fallback)
    expect(avatarUrl(user({ avatarPreset: 101 }))).toBe(fallback)
    expect(avatarUrl(user({ avatarPreset: 2.5 }))).toBe(fallback)
  })
})

describe('AVATAR_MAX_BYTES', () => {
  it('上傳上限 2 MB', () => {
    expect(AVATAR_MAX_BYTES).toBe(2 * 1024 * 1024)
  })
})

describe('重設頭像的理由', () => {
  it('選填（C2 X2）：留空存 null、去頭尾空白；超過 200 字或不是字串拒絕', () => {
    expect(normalizeAvatarResetReason('   ')).toEqual({ ok: true, value: null })
    expect(normalizeAvatarResetReason(' 不當圖片 ')).toEqual({ ok: true, value: '不當圖片' })
    expect(normalizeAvatarResetReason('字'.repeat(AVATAR_RESET_REASON_MAX))).toMatchObject({ ok: true })
    expect(normalizeAvatarResetReason('字'.repeat(AVATAR_RESET_REASON_MAX + 1))).toEqual({ ok: false })
    expect(normalizeAvatarResetReason(42)).toEqual({ ok: false })
  })
})

describe('重設理由字數以字計（⑤-16、AC-63）', () => {
  it('舊結果＝新結果：emoji 與中文剛好上限過、多一字擋（原本就用 Array.from）', () => {
    const reason = `👍中${'字'.repeat(AVATAR_RESET_REASON_MAX - 2)}`
    expect(normalizeAvatarResetReason(reason)).toEqual({ ok: true, value: reason })
    expect(normalizeAvatarResetReason(`${reason}字`)).toEqual({ ok: false })
    expect(normalizeAvatarResetReason(`a\n b${'x'.repeat(AVATAR_RESET_REASON_MAX - 4)}`)).toMatchObject({ ok: true })
  })
})
