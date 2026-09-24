import 'server-only'
import { toNextJsHandler } from 'better-auth/next-js'
import { getAuth } from '@/infrastructure/auth/auth-instance'
import { authPathFromUrl, routeAccess } from '@/infrastructure/auth/route-matrix'
import { runAsInternalCall } from '@/infrastructure/auth/internal-call'

/**
 * Better Auth 的唯一入口（契約 03 §2）。
 *
 * 對外（HTTP）與對內（管理員能力）都只能經這個檔；eslint 的 no-restricted-imports
 * 擋掉其他地方 import `auth-instance` 或 `better-auth/api`。
 *
 * 對外（S01-02）：**路徑白名單先於 `toNextJsHandler`**。
 * 對內（S01-03）：`internalAuth` 的五個管理員能力，跑在 AsyncLocalStorage 的 marker context 裡。
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

// ── 對內：管理員能力的唯一入口（契約 03 §2；S01-03） ──────────────────────────

/**
 * Better Auth 的管理員能力**只有這五個**，而且只能從這裡呼叫（契約 03 §2 v2.2）。
 *
 * 每一個都跑在 `runAsInternalCall` 的 context 裡，`hooks.before` 才認得出這是內部呼叫。
 * 直接 `auth.api.banUser(...)` 不會有 marker，會被 hook 擋成 403——這正是三向測試的第三向。
 *
 * **`headers` 是必要的，不是可有可無**：admin plugin 自己的 middleware
 * （`getAuthoritativeSessionFromCtx`）要求呼叫端帶著一個 role 是 admin 的 session，
 * 沒有就直接 401。所以用例要把「發動這個動作的管理員」的 headers 傳進來。
 * 我們的 marker 管的是「這條路只能從包裝器走」，套件的 middleware 管的是「誰有資格做」，
 * 兩個檢查是疊加的，不互相取代。
 *
 * 清單之外的能力刻意不包：
 * - `impersonateUser` 永不呼叫（契約 03 §2）。
 * - `listUsers` 不用；收斂核對改成對 `users` 的唯讀 SELECT（模組 01 v2.4 D1）。
 */
export const internalAuth = {
  /** 停用：撤掉這個人全部 session（模組 01 §3）。 */
  banUser: (headers: Headers, input: { userId: string; banReason?: string }) =>
    runAsInternalCall(() => getAuth().api.banUser({ body: input, headers })),

  /** 恢復。 */
  unbanUser: (headers: Headers, input: { userId: string }) =>
    runAsInternalCall(() => getAuth().api.unbanUser({ body: input, headers })),

  /** 系辦發臨時密碼；秘密只出現在回應本體，不進帳本、audit、log（母 spec §4.12）。 */
  setUserPassword: (headers: Headers, input: { userId: string; newPassword: string }) =>
    runAsInternalCall(() => getAuth().api.setUserPassword({ body: input, headers })),

  /** 撤掉某個人的全部 session（去識別化與強制登出用）。 */
  revokeUserSessions: (headers: Headers, input: { userId: string }) =>
    runAsInternalCall(() => getAuth().api.revokeUserSessions({ body: input, headers })),

  /**
   * 系辦建立老師帳號（伺服器端建立，不經註冊流程；票 8）。
   *
   * `role` 是 admin plugin 自己的欄（'user' | 'admin'）；本專案的業務角色在
   * `role_assignments`，所以這裡刻意不開放帶 role，一律讓套件給預設值。
   *
   * `password` 可以不帶：預授權的老師先不給密碼，套件就不建 credential 帳號
   * （1.7.5 `admin/routes.mjs` 的 createUser），沒有人能用密碼登入這個帳號。
   * 之後系辦發臨時密碼時，`setUserPassword` 會自己補建 credential 帳號。
   */
  createUser: (headers: Headers, input: { email: string; password?: string; name: string }) =>
    runAsInternalCall(() => getAuth().api.createUser({ body: input, headers })),
} as const

/**
 * 讀目前的 session（給 ActorResolver 用）。
 *
 * `/get-session` 本來就是白名單路由，所以這個呼叫不需要 marker；放在這裡是為了讓
 * 「所有 `auth.api` 的呼叫都在 wrapper」這條規則沒有例外。
 */
export function getSessionFromHeaders(headers: Headers) {
  return getAuth().api.getSession({ headers })
}

// ── 本人自己的能力（不需要 marker；這些路由本來就對外開放） ───────────────────

/**
 * 密碼登入。
 *
 * 走 `auth.api.signInEmail` 而不是讓瀏覽器直接打 `/api/auth/sign-in/email`：
 * 表單是 Server Action（契約 02 §7），cookie 由 `nextCookies()` 外掛帶進回應。
 */
export function signInWithPassword(input: { email: string; password: string }, headers?: Headers) {
  // `headers` 要傳進去：登入限速在 hook 裡，要靠它取來源 IP（契約 03 §6）。
  return getAuth().api.signInEmail({ body: input, ...(headers ? { headers } : {}) })
}

/**
 * 學生用密碼註冊（票 7）。
 *
 * 走 `auth.api.signUpEmail`（`/sign-up/email` 本來就是白名單路由，不需要 marker）：
 * 帳號由套件建（密碼雜湊用套件的，不自己做），`user.create.before` 把狀態壓成 pending，
 * `nextCookies()` 把登入 cookie 帶進 Server Action 的回應——註冊完就是受限 session，
 * 直接到等待審核頁。
 *
 * `headers` 要帶 `x-real-ip`：註冊限速在 hook 裡，要靠它取來源 IP（契約 03 §6）。
 * 申請資料（學號、手機、系級）不經套件——套件只存它自己宣告過的欄位——由
 * `RegistrationCommand` 在同一個請求裡接著寫。
 */
export function signUpWithPassword(input: { email: string; password: string; name: string }, headers: Headers) {
  return getAuth().api.signUpEmail({ body: input, headers })
}

/**
 * 本人改密碼。
 *
 * `revokeOtherSessions: true` 是規格要求（模組 01 §3、契約 03 §2）：改完密碼，
 * 這個人在**其他裝置**的登入全部失效，目前這一台留著。
 */
export function changeOwnPassword(
  headers: Headers,
  input: { currentPassword: string; newPassword: string },
) {
  // `revokeOtherSessions` 仍然在這裡帶一次，但**它不是保證**——保證在 hook 裡
  // （hook 會直接覆寫請求內容），所以直接打 HTTP 的人也撤得掉其他裝置。
  return getAuth().api.changePassword({
    body: { ...input, revokeOtherSessions: true },
    headers,
  })
}

/** 登出目前這一台。 */
export function signOutCurrent(headers: Headers) {
  return getAuth().api.signOut({ headers })
}
