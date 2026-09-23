// 反例 8（S01-03）：Better Auth 實例本身也只能由 infrastructure/auth/wrapper 引用。
// 反例 7 擋的是 `better-auth/api`；這一條擋的是「繞過包裝器直接拿實例」——
// 少了它，任何人都可以 `import { getAuth } from '@/infrastructure/auth/auth-instance'`
// 然後直接 `getAuth().api.banUser(...)`，包裝器的 marker 就形同虛設。
// 預期被擋：no-restricted-imports
import { getAuth } from '@/infrastructure/auth/auth-instance'

export async function banSomeone(userId: string, headers: Headers) {
  return getAuth().api.banUser({ body: { userId }, headers })
}
