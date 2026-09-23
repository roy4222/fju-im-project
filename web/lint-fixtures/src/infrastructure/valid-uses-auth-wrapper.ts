import 'server-only'
// 合法例（S01-03）：經包裝器呼叫管理員能力，這是唯一允許的寫法。
import { internalAuth } from '@/infrastructure/auth/wrapper'

export async function disable(adminHeaders: Headers, userId: string) {
  return internalAuth.banUser(adminHeaders, { userId })
}
