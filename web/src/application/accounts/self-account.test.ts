import { describe, expect, it } from 'vitest'
import { MIN_PASSWORD_LENGTH, validateNewPassword } from '@/application/accounts'

/** S01-05：新密碼的規則（模組 01 §3）。 */

describe('新密碼', () => {
  it(`至少 ${MIN_PASSWORD_LENGTH} 個字元`, () => {
    expect(validateNewPassword('x'.repeat(MIN_PASSWORD_LENGTH - 1), 'old-one-time-pw')).toBe('too_short')
    expect(validateNewPassword('x'.repeat(MIN_PASSWORD_LENGTH), 'old-one-time-pw')).toBeNull()
  })

  it('不能跟目前的密碼一樣（不然一次性密碼還是有效的）', () => {
    const same = 'a-very-long-password'
    expect(validateNewPassword(same, same)).toBe('same_as_current')
  })

  it('長度夠又跟舊的不同就通過', () => {
    expect(validateNewPassword('brand-new-password-9', 'old-one-time-pw')).toBeNull()
  })

  it('中文密碼以字元數計（不是位元組數）', () => {
    expect(validateNewPassword('密'.repeat(MIN_PASSWORD_LENGTH), 'old')).toBeNull()
    expect(validateNewPassword('密'.repeat(MIN_PASSWORD_LENGTH - 1), 'old')).toBe('too_short')
  })
})
