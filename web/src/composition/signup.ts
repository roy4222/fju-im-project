import 'server-only'

/**
 * 註冊三步（VB-3）用到的 Better Auth 入口：只轉出 VB-2 的 wrapper，不寫任何業務邏輯。
 * app 層不能直接 import infrastructure（分層規則），所以經這裡（主腦 2026-10-17 裁定新增本檔）。
 */
export {
  authCallHeaders,
  completeSignupResume,
  resendSignupResumeOtp,
  resendVerificationOtp,
  signUpOrResume,
  verifyEmailWithOtp,
  type SignupResumeResendOutcome,
  type SignUpOrResumeOutcome,
} from '@/infrastructure/auth/wrapper'
