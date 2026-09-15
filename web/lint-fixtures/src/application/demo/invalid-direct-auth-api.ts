// 反例 7：Better Auth 的原生 API 只能由 infrastructure/auth/wrapper 呼叫。
// 預期被擋：no-restricted-imports
import { getSession } from 'better-auth/api'

export async function whoAmI() {
  return getSession()
}
