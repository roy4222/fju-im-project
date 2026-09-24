import 'server-only'

/**
 * Better Auth 路由矩陣（契約 03 §2）。
 *
 * **預設拒絕**：只有這份清單裡標成 `allowed` 的路徑會被送進 Better Auth，其餘一律 403。
 * 新版本的套件多長出一個端點時，`route-table.integration.test.ts` 的覆核 gate 會紅
 * （它拿安裝版本的實際 route table 逐條比對本表），不會靜靜地多開一個對外入口。
 *
 * 兩層攔截都讀這份表：
 * 1. `wrapper.ts` 的路徑白名單，在 `toNextJsHandler` **之前**（契約 03 §2）。
 * 2. Better Auth `hooks.before` 的第二層（只針對「帶著 HTTP request」的呼叫）。
 *
 * 路由層只管「這個入口對不對外開」；**帳號狀態的放行條件在用例層**（ActorResolver，S01-03）
 * ——pending 只能看與改自己的申請、must-change 只能改密與登出、disabled 一律當未登入。
 */

export type RouteAccess = 'allowed' | 'blocked'

/**
 * 這條路由對「帳號狀態」的要求（契約 03 §2 的矩陣那幾欄）。
 *
 * - `none`：不需要 session（註冊、登入、回呼）。停用帳號在**建立 session 的那一刻**被擋，
 *   不在這裡擋——先查 Email 再拒絕等於送人一個「這個帳號存在且被停用」的探測管道。
 * - `signed-in`：任何有效 session 都可以（`get-session`、`sign-out`、`change-password`）；
 *   只有 disabled／deidentified 被擋。**must-change 可以**——改密正是他唯一能做的事。
 * - `active-only`：只有 active 且**不在 must-change** 的人可以（`link-social`、`list-accounts`）。
 */
export type SessionRequirement = 'none' | 'signed-in' | 'active-only'

export type AuthRoutePolicy = {
  /** Better Auth 端點自己的 path，`:param` 是路徑參數（例：`/callback/:id`）。 */
  readonly path: string
  readonly methods: readonly ('GET' | 'POST')[]
  readonly access: RouteAccess
  /** 帳號狀態的要求（契約 03 §2）。 */
  readonly session: SessionRequirement
  /**
   * 這條路由要不要 **fresh session**（契約 03 §2 的 freshAge＝10 分鐘）。
   *
   * 不能靠設定 `session.freshAge` 就以為生效：安裝版本 1.7.5 的
   * `dist/api/routes/session.mjs` 只有 `/list-sessions` 掛 `freshSessionMiddleware`，
   * `/link-social` 與 `/list-accounts` 掛的是一般的 `sessionMiddleware`
   * ——`freshAge` 對它們完全沒有作用（2026-09-16 複核 Spec 1）。所以由本表宣告、hook 自己比對。
   */
  readonly fresh: boolean
  readonly note: string
}

/**
 * 契約 03 §2 的白名單。其餘路由不用逐條列——預設就是 blocked，
 * 由覆核 gate 保證「實際 route table 的每一條都被本表分類到」。
 */
export const ALLOWED_ROUTES: readonly AuthRoutePolicy[] = [
  {
    path: '/sign-up/email',
    methods: ['POST'],
    access: 'allowed',
    session: 'none',
    fresh: false,
    note: '密碼註冊；`user.create.before` 注入 status=pending；限速 30 次／小時／IP 與密碼長度在 hook；申請單由 RegistrationCommand 接著建（票 7），直接打 API 的人登入後在等待審核頁補送',
  },
  { path: '/sign-in/email', methods: ['POST'], access: 'allowed', session: 'none', fresh: false, note: '密碼登入；限速與 Turnstile 由 S01-05／S01-15' },
  { path: '/sign-in/social', methods: ['POST'], access: 'allowed', session: 'none', fresh: false, note: 'Google 登入入口（S01-14）' },
  { path: '/callback/:id', methods: ['GET', 'POST'], access: 'allowed', session: 'none', fresh: false, note: 'OAuth 回呼' },
  { path: '/get-session', methods: ['GET', 'POST'], access: 'allowed', session: 'signed-in', fresh: false, note: '讀目前 session' },
  { path: '/sign-out', methods: ['POST'], access: 'allowed', session: 'signed-in', fresh: false, note: '登出' },
  {
    path: '/change-password',
    methods: ['POST'],
    access: 'allowed',
    session: 'signed-in',
    fresh: false,
    note: 'must-change 期間唯一可做的業務動作；撤其他 session 由 S01-05 的用例帶 revokeOtherSessions',
  },
  { path: '/link-social', methods: ['POST'], access: 'allowed', session: 'active-only', fresh: true, note: '連結 Google；只限 active 且 fresh session' },
  { path: '/list-accounts', methods: ['GET'], access: 'allowed', session: 'active-only', fresh: true, note: '本人看自己有哪幾種登入方式' },
  { path: '/error', methods: ['GET'], access: 'allowed', session: 'none', fresh: false, note: 'OAuth 失敗時套件自己導過來的錯誤頁；不吐任何帳號資料' },
] as const

/**
 * 明確寫下「為什麼擋」的封鎖路由。沒列在這裡的照樣被擋（預設拒絕），
 * 列出來是為了讓覆核 gate 的輸出看得懂，也讓 review 一眼看到每個入口的理由。
 */
export const BLOCKED_ROUTE_REASONS: Readonly<Record<string, string>> = {
  '/admin/ban-user': '管理員能力只能由內部包裝器呼叫（契約 03 §2；S01-03）',
  '/admin/unban-user': '同上',
  '/admin/create-user': '同上',
  '/admin/set-user-password': '同上',
  '/admin/revoke-user-sessions': '同上',
  '/admin/list-users': '同上；收斂核對改讀 users.banned，不用這支（模組 01 v2.4 D1）',
  '/admin/get-user': '同上',
  '/admin/list-user-sessions': '同上',
  '/admin/revoke-user-session': '同上',
  '/admin/remove-user': '同上；使用者列永不硬刪，改去識別化',
  '/admin/set-role': '同上；角色由 role_assignments 管',
  '/admin/update-user': '同上',
  '/admin/has-permission': '授權判斷在 application policy，不外露',
  '/admin/impersonate-user': '永不呼叫（契約 03 §2）',
  '/admin/stop-impersonating': '同上',
  '/update-user': '本人可改的欄位只有手機與聯絡 Email，走自己的用例（契約 03 §1）',
  '/change-email': '登入身分本人不可改（模組 01 §2）',
  '/delete-user': '使用者列永不硬刪，改去識別化（契約 01 §1）',
  '/delete-user/callback': '同上',
  '/unlink-account': 'unlink 不在產品範圍，accounts 也沒有 DELETE 權限（契約 03 §2，Codex A4）',
  '/request-password-reset': 'Email 延後；忘記密碼改走系辦臨時密碼（模組 01 §3）',
  '/reset-password': '同上',
  '/reset-password/:token': '同上',
  '/send-verification-email': '同上',
  '/verify-email': '同上',
  '/account-info': '不對外揭露 provider 側的帳號資料（契約 03 §4 最小揭露）',
  '/get-access-token': 'Google access token 不對外；本專案不代表使用者呼叫 Google API',
  '/refresh-token': '同上',
  '/list-sessions': '裝置管理不在 V1 範圍；撤 session 由停用與改密的用例做',
  '/revoke-session': '同上',
  '/revoke-sessions': '同上',
  '/revoke-other-sessions': '同上；改密時由用例帶 revokeOtherSessions（S01-05）',
  '/update-session': '同上',
  '/verify-password': '沒有對外用途；重新驗證密碼的流程不在 V1 範圍',
  '/set-password': '設密碼只由本人用例發起（S01-14 的 SelfAccountCommand.setPassword）',
  '/ok': '套件自己的探活端點；健康檢查一律看 /api/health（契約 05 §3）',
}

/** 把 `/callback/:id` 這種帶參數的 path 轉成比對用的正則。 */
function toPattern(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^${source}$`)
}

const ALLOWED_PATTERNS = ALLOWED_ROUTES.map((route) => ({ route, pattern: toPattern(route.path) }))

/**
 * 這個「Better Auth 路徑 + 方法」對外開不開。
 *
 * `path` 是**去掉 `/api/auth` 前綴之後**的路徑，與 Better Auth 端點的 `path` 同一套寫法。
 */
export function routeAccess(path: string, method: string): RouteAccess {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  const upper = method.toUpperCase()
  for (const { route, pattern } of ALLOWED_PATTERNS) {
    if (pattern.test(normalized) && route.methods.includes(upper as 'GET' | 'POST')) return 'allowed'
  }
  return 'blocked'
}

/**
 * 這個路徑有沒有**任何**方法是對外開放的。
 *
 * server-only 呼叫沒有 HTTP 方法可看（`auth.api.getSession` 不帶 request），
 * 所以第二層攔截對這種呼叫只能以路徑為準：路徑本身完全不對外開放（例如 `/admin/*`）
 * 才算「被封鎖的能力」，需要內部包裝器的 marker。
 */
export function pathHasAnyAllowedMethod(path: string): boolean {
  return ALLOWED_PATTERNS.some(({ pattern }) => pattern.test(normalizePath(path)))
}

/** 這條路由對這個請求的要求；不是白名單路由（或不是白名單的方法）就回 undefined。 */
export type RouteRequirement = {
  readonly session: SessionRequirement
  readonly fresh: boolean
}

/** 由嚴到寬，用來合併同一路徑上多個方法的要求。 */
const STRICTNESS: Readonly<Record<SessionRequirement, number>> = {
  none: 0,
  'signed-in': 1,
  'active-only': 2,
}

function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** 這條路由（對這個方法）的要求；不是白名單路由就回 undefined。 */
export function sessionRequirement(path: string, method: string): RouteRequirement | undefined {
  const normalized = normalizePath(path)
  const upper = method.toUpperCase()
  for (const { route, pattern } of ALLOWED_PATTERNS) {
    if (pattern.test(normalized) && route.methods.includes(upper as 'GET' | 'POST')) {
      return { session: route.session, fresh: route.fresh }
    }
  }
  return undefined
}

/**
 * 以**路徑**（不看方法）判定要求，取所有符合的方法裡最嚴的一條。
 *
 * 給 server-only 呼叫用：`auth.api.listUserAccounts({ headers })` 這種沒有 HTTP request，
 * 也就沒有方法可看。之前的寫法是「沒有 request 就當 POST」，而 `/list-accounts` 只註冊了
 * GET，`sessionRequirement('/list-accounts','POST')` 回 undefined，整個狀態檢查就被跳過
 * ——pending 的人從伺服器端呼叫仍然拿得到資料（2026-09-16 複核 Spec 2）。
 * 「猜一個方法」本來就不對：沒有方法時就不該用方法查表。
 */
export function requirementByPath(path: string): RouteRequirement | undefined {
  const normalized = normalizePath(path)
  let found: RouteRequirement | undefined
  for (const { route, pattern } of ALLOWED_PATTERNS) {
    if (!pattern.test(normalized)) continue
    if (found === undefined || STRICTNESS[route.session] > STRICTNESS[found.session]) {
      found = { session: route.session, fresh: route.fresh || (found?.fresh ?? false) }
    } else if (route.fresh) {
      found = { ...found, fresh: true }
    }
  }
  return found
}

/** 從 Next 的請求 URL 取出 Better Auth 端點的路徑（去掉 `/api/auth` 前綴）。 */
export function authPathFromUrl(url: string, basePath = '/api/auth'): string {
  const { pathname } = new URL(url)
  return pathname.startsWith(basePath) ? pathname.slice(basePath.length) || '/' : pathname
}
