import { beforeEach, describe, expect, it, vi } from 'vitest'

const resetPasswordWithToken = vi.fn()
vi.mock('@/composition/accounts', () => ({ MIN_PASSWORD_LENGTH: 12 }))
vi.mock('@/composition/password', () => ({
  resetPasswordWithToken: (...args: unknown[]) => resetPasswordWithToken(...args),
}))

const { resetPasswordAction } = await import('./actions')

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [k, v] of Object.entries(fields)) data.set(k, v)
  return data
}
const apiError = (code: string) => Object.assign(new Error(code), { body: { code, message: code } })

describe('resetPasswordAction（AC-VI-60）', () => {
  beforeEach(() => {
    resetPasswordWithToken.mockReset()
  })

  it('11 字被擋「密碼至少 12 字。」，不呼叫重設', async () => {
    const state = await resetPasswordAction(undefined, form({ token: 't', newPassword: 'a'.repeat(11), confirmPassword: 'a'.repeat(11) }))
    expect(state).toEqual({ status: 'error', error: '密碼至少 12 字。', attempt: 1 })
    expect(resetPasswordWithToken).not.toHaveBeenCalled()
  })

  it('兩次不一樣被擋', async () => {
    const state = await resetPasswordAction(undefined, form({ token: 't', newPassword: 'a'.repeat(12), confirmPassword: 'b'.repeat(12) }))
    expect(state).toMatchObject({ status: 'error', error: '兩次輸入的密碼不一樣。' })
  })

  it('12 字成功：帶 token 與新密碼呼叫，回 done', async () => {
    resetPasswordWithToken.mockResolvedValue({ status: true })
    const state = await resetPasswordAction(undefined, form({ token: 'tok', newPassword: 'a'.repeat(12), confirmPassword: 'a'.repeat(12) }))
    expect(state).toEqual({ status: 'done' })
    expect(resetPasswordWithToken).toHaveBeenCalledWith({ token: 'tok', newPassword: 'a'.repeat(12) })
  })

  it('token 用過、過期或不存在：一律 expired', async () => {
    for (const code of ['INVALID_TOKEN', 'USER_NOT_FOUND']) {
      resetPasswordWithToken.mockRejectedValueOnce(apiError(code))
      const state = await resetPasswordAction(undefined, form({ token: 'old', newPassword: 'a'.repeat(12), confirmPassword: 'a'.repeat(12) }))
      expect(state).toEqual({ status: 'expired' })
    }
    expect(await resetPasswordAction(undefined, form({ token: '', newPassword: 'a'.repeat(12), confirmPassword: 'a'.repeat(12) }))).toEqual({
      status: 'expired',
    })
  })
})
