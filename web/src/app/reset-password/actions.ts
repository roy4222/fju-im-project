'use server'
import { MIN_PASSWORD_LENGTH } from '@/composition/accounts'
import { resetPasswordWithToken } from '@/composition/password'
import type { ResetState } from './reset-state'

const EXPIRED_CODES = new Set(['INVALID_TOKEN', 'USER_NOT_FOUND'])

/**
 * 用重設連結設新密碼（visitor-r3 設計方案 §3.4）。
 *
 * 長度規則跟註冊、改密同一條（hook 也會再擋一次）；token 無效、用過或過期都回 `expired`，
 * 畫面只說「連結已失效」，不分是哪一種。
 */
export async function resetPasswordAction(state: ResetState, formData: FormData): Promise<ResetState> {
  const token = String(formData.get('token') ?? '').trim()
  const newPassword = String(formData.get('newPassword') ?? '')
  const confirmPassword = String(formData.get('confirmPassword') ?? '')
  const failed = (error: string): ResetState => ({
    status: 'error',
    error,
    attempt: (state?.status === 'error' ? state.attempt : 0) + 1,
  })

  if (!token) return { status: 'expired' }
  if (newPassword.length < MIN_PASSWORD_LENGTH) return failed(`密碼至少 ${MIN_PASSWORD_LENGTH} 字。`)
  if (newPassword !== confirmPassword) return failed('兩次輸入的密碼不一樣。')

  try {
    await resetPasswordWithToken({ token, newPassword })
  } catch (error) {
    const body = (error as { body?: { code?: unknown; message?: unknown } } | null)?.body
    const code = typeof body?.code === 'string' ? body.code : ''
    if (EXPIRED_CODES.has(code)) return { status: 'expired' }
    if (code === 'VALIDATION_FAILED' && typeof body?.message === 'string') return failed(body.message)
    console.error('[reset-password] 重設失敗', code || 'unknown')
    return failed('暫時無法重設密碼，請稍後再試。')
  }
  return { status: 'done' }
}
