import { describe, expect, it } from 'vitest'
import { isFreshSession, isSignInState } from '@/infrastructure/auth/login-methods'

/**
 * 票 10b：Google 回呼時「這是登入還是連結」的判斷——**失敗要關不要開**。
 *
 * 只有讀得到 state、而且 `link` 是空的，才可能替預授權老師補綁 Google。
 * 讀不到（null／undefined／不是物件）一律當作不綁；之前是讀不到就當成「登入」。
 */
describe('isSignInState', () => {
  it('讀不到 state → 不綁', () => {
    expect(isSignInState(null)).toBe(false)
    expect(isSignInState(undefined)).toBe(false)
    expect(isSignInState('state')).toBe(false)
    expect(isSignInState(0)).toBe(false)
  })

  it('連結流程（link 有值）→ 不綁', () => {
    expect(isSignInState({ callbackURL: '/account', link: { userId: 'u', email: 'a@example.com' } })).toBe(false)
  })

  it('一般登入的 state（沒有 link）→ 可以進一步判斷要不要綁', () => {
    expect(isSignInState({ callbackURL: '/login', codeVerifier: 'v' })).toBe(true)
    expect(isSignInState({ callbackURL: '/login', link: undefined })).toBe(true)
  })
})

describe('isFreshSession', () => {
  it('讀不到時間一律不 fresh', () => {
    expect(isFreshSession(null)).toBe(false)
    expect(isFreshSession('not-a-date')).toBe(false)
  })
})
