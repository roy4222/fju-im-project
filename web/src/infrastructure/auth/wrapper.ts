import 'server-only'
import { toNextJsHandler } from 'better-auth/next-js'
import { getAuth } from '@/infrastructure/auth/auth-instance'
import { authPathFromUrl, routeAccess } from '@/infrastructure/auth/route-matrix'

/**
 * Better Auth 的唯一入口（契約 03 §2）。
 *
 * 對外（HTTP）與對內（管理員能力）都只能經這個檔；eslint 的 no-restricted-imports
 * 擋掉其他地方 import `auth-instance` 或 `better-auth/api`。
 *
 * 本票（S01-02）先做對外那一半：**路徑白名單先於 `toNextJsHandler`**。
 * 對內的包裝器（AsyncLocalStorage marker、`banUser`／`unbanUser`／`setUserPassword`／
 * `revokeUserSessions`／`createUser` 五個呼叫）與 ActorResolver 在 S01-03。
 */

// 傳函式而不是實例：`toNextJsHandler` 在模組載入時就會被呼叫，
// 但 Better Auth 實例要等到真的有請求進來（執行期才有 DATABASE_URL）才建。
const delegate = toNextJsHandler((request: Request) => getAuth().handler(request))

/** 封鎖回應：403，不透露這個端點存不存在以外的任何資訊。 */
function blocked(): Response {
  return Response.json(
    { error: { code: 'FORBIDDEN', message: '這個入口不對外開放。' } },
    { status: 403, headers: { 'cache-control': 'no-store' } },
  )
}

function guard(handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    const path = authPathFromUrl(request.url)
    if (routeAccess(path, request.method) === 'blocked') return blocked()
    return handler(request)
  }
}

/**
 * 掛在 `src/app/api/auth/[...all]/route.ts` 的兩個方法。
 *
 * Better Auth 只用 GET 與 POST；PATCH／PUT／DELETE 不匯出，Next 會自己回 405。
 */
export const authRouteHandlers = {
  GET: guard(delegate.GET),
  POST: guard(delegate.POST),
}
