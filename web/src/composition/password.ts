import 'server-only'

/**
 * 忘記密碼、重設密碼（VB-4）給頁面層用的出口：app 層不能直接 import infrastructure，這裡只做轉出。
 * 限速、Turnstile、密碼長度都在 Better Auth 的 `hooks.before`（VB-2），這裡不另寫規則。
 */
export { authCallHeaders, requestPasswordReset, resetPasswordWithToken } from '@/infrastructure/auth/wrapper'
