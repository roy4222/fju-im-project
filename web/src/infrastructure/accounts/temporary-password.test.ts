import { describe, expect, it } from 'vitest'
import { MIN_PASSWORD_LENGTH } from '@/infrastructure/auth/change-password-rules'
import {
  generateTemporaryPassword,
  TEMPORARY_PASSWORD_ALPHABET,
} from '@/infrastructure/accounts/temporary-password'

/** 票 8：臨時密碼產生器（契約 03 §3）。 */

describe('臨時密碼', () => {
  it('四組、每組四個字元，只用不易看錯的字元', () => {
    const password = generateTemporaryPassword()
    expect(password).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/)
    for (const ch of password.replaceAll('-', '')) expect(TEMPORARY_PASSWORD_ALPHABET).toContain(ch)
    expect(password).not.toMatch(/[0O1lIio]/)
    expect(password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH)
  })

  it('每次都不一樣（安全亂數）', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()))
    expect(seen.size).toBe(200)
  })

  it('亂數來源可以注入（每個位置都由它決定）', () => {
    expect(generateTemporaryPassword(() => 0)).toBe('AAAA-AAAA-AAAA-AAAA')
  })
})
