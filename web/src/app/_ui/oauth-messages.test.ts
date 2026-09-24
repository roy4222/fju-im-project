import { describe, expect, it } from 'vitest'
import { googleLinkErrorMessage, googleSignInErrorMessage } from '@/app/_ui/oauth-messages'

describe('Google 失敗代碼的文案（票 10）', () => {
  it('沒有代碼就不顯示', () => {
    expect(googleSignInErrorMessage(undefined)).toBeNull()
    expect(googleSignInErrorMessage('')).toBeNull()
    expect(googleSignInErrorMessage(['a', 'b'])).toBeNull()
    expect(googleLinkErrorMessage(undefined)).toBeNull()
  })

  it('同 Email 已有帳號：提示用原方式登入後再連結（§2.3）', () => {
    expect(googleSignInErrorMessage('account_not_linked')).toContain('先用原本的 Email 與密碼登入')
  })

  it('停用帳號被擋（unable_to_create_session）跟其他失敗是同一句，不透露帳號狀態', () => {
    const generic = googleSignInErrorMessage('unable_to_create_session')
    expect(generic).toBe(googleSignInErrorMessage('state_mismatch'))
    expect(generic).not.toMatch(/停用/)
  })

  it('連結衝突與 Email 不同各有一句', () => {
    expect(googleLinkErrorMessage('account_already_linked_to_different_user')).toContain('已經連結到另一個帳號')
    expect(googleLinkErrorMessage('email_does_not_match')).toContain('必須和你的登入 Email 相同')
    expect(googleLinkErrorMessage('whatever')).toContain('沒有任何改變')
  })
})
