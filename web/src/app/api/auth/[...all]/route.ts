import { authRouteHandlers } from '@/composition/auth'

/**
 * Better Auth 的 HTTP 入口（契約 03 §2；S01-02）。
 *
 * 這個檔刻意只有兩行實質內容：路徑白名單、兩層攔截與所有設定都在
 * `infrastructure/auth/wrapper.ts` 與 `auth-instance.ts`，不在路由檔裡。
 */
export const { GET, POST } = authRouteHandlers
