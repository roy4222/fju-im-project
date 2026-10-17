import 'server-only'
import { toNextJsHandler } from 'better-auth/next-js'
import { getAuth, withMailOutcome } from '@/infrastructure/auth/auth-instance'
import { authPathFromUrl, routeAccess } from '@/infrastructure/auth/route-matrix'
import { runAsInternalCall } from '@/infrastructure/auth/internal-call'
import { EMAIL_UNAVAILABLE_CODE } from '@/infrastructure/auth/login-methods'
import {
  checkSignupResumeTicket,
  findUserIdByEmail,
  isResumableSignup,
  listSignupOtpRowIds,
  normalizeEmail,
  rebindSignupResumeOtp,
  restoreSignupResumeOtp,
  runWithOtpPurpose,
  startSignupResume,
} from '@/infrastructure/auth/signup-resume'
import { getPool } from '@/infrastructure/db/client'

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
    // 寄信結果的盒子（VB-2）：驗證碼信寄不出去時，寄碼端點才回得了 MAIL_FAILED（見 auth-instance 的 withMailOutcome）。
    const response = await withMailOutcome(() => handler(request))
    if (path === '/sign-up/email' && response.status === 422) return unifySignUpStatus(response)
    if (OTP_CHECK_PATHS.has(path) && response.status > 400 && response.status < 500) return unifyOtpStatus(response)
    return response
  }
}

/**
 * 註冊時「Email 已被用過」的 HTTP 狀態碼統一成 400（票 7 遺留）。
 *
 * 內容已經由 `hooks.after` 換成統一訊息，但套件回應時沿用端點原本的 422——
 * 光看狀態碼就分得出「Email 已被用過」與「Email 格式不對」（400）。
 * 只改本來就是統一訊息的那種回應，其他 422 原樣放行。
 */
async function unifySignUpStatus(response: Response): Promise<Response> {
  return withStatus400(response, EMAIL_UNAVAILABLE_CODE)
}

/**
 * 驗碼失敗的狀態碼統一成 400（VB-2 Review 第 1 輪）：`hooks.after` 已把內容換成同一個 `INVALID_OTP`，
 * 但套件沿用端點原本的狀態碼（錯太多次是 403），光看狀態碼就分得出這個 Email 有沒有寄過碼。
 */
const OTP_CHECK_PATHS = new Set(['/email-otp/verify-email', '/email-otp/check-verification-otp'])

async function unifyOtpStatus(response: Response): Promise<Response> {
  return withStatus400(response, 'INVALID_OTP')
}

/** 內容的 `code` 是指定的那一個才改成 400，其他回應原樣放行。 */
async function withStatus400(response: Response, expectedCode: string): Promise<Response> {
  const text = await response.clone().text()
  let code: unknown
  try {
    code = (JSON.parse(text) as { code?: unknown }).code
  } catch {
    return response
  }
  if (code !== expectedCode) return response
  return new Response(text, { status: 400, headers: response.headers })
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

// ── Google 登入與帳號連結（票 10） ────────────────────────────────────────────

/**
 * 三個導回網址：成功、首次建帳號、失敗。**一律是站內相對路徑**，由呼叫端（登入頁的
 * Server Action）以 `safeNextPath` 組好；套件自己的 origin check 也會再擋一次站外網址。
 * 失敗時套件在 `errorCallbackURL` 後面補 `?error=<代碼>`。
 */
export type OAuthRedirects = {
  readonly callbackURL: string
  readonly errorCallbackURL: string
  readonly newUserCallbackURL?: string
}

/**
 * 開始 Google 登入：回傳要把瀏覽器導去的 Google 授權網址。
 *
 * state 與 PKCE 都由套件產生：state 存在 `verifications` 一列＋簽章 cookie（`nextCookies()`
 * 把 cookie 帶進 Server Action 的回應），code_verifier 跟著 state 存，授權網址只帶 S256 challenge。
 * `disableRedirect` 讓套件只回網址，由 Server Action 自己 `redirect()`。
 */
export function startGoogleSignIn(headers: Headers, redirects: OAuthRedirects) {
  return getAuth().api.signInSocial({
    body: { provider: 'google', disableRedirect: true, ...redirects },
    headers,
  })
}

/**
 * 本人把 Google 連到目前這個帳號：回傳 Google 授權網址。
 *
 * `/link-social` 在路由矩陣是 active-only＋fresh，這個伺服器端呼叫一樣經 `hooks.before`
 * （沒有 request 時以路徑查表），所以待審、被要求改密、session 超過 10 分鐘的人都會被擋，
 * 錯誤碼 `FRESH_SESSION_REQUIRED`。
 */
export function startGoogleLink(headers: Headers, redirects: Omit<OAuthRedirects, 'newUserCallbackURL'>) {
  return getAuth().api.linkSocialAccount({
    body: { provider: 'google', disableRedirect: true, ...redirects },
    headers,
  })
}

/**
 * 替只有 Google 的帳號設一組密碼（套件的 `setPassword`，server-only）。
 *
 * 套件的 `/set-password` 對外封鎖，所以要在內部呼叫的 context 裡跑。hook 對內部呼叫**不再做**
 * 帳號狀態與 fresh 的檢查（內部呼叫在封鎖判定那一步就放行了），所以 active、fresh、
 * 長度、「還沒有密碼」由呼叫端（`SelfAccountCommand.setPassword`）先判。
 */
export function setOwnPassword(headers: Headers, input: { newPassword: string }) {
  return runAsInternalCall(() => getAuth().api.setPassword({ body: input, headers }))
}

// ── Email 驗證碼、續辦、重設密碼（B 階段 VB-2；visitor-r3 設計方案 §3.2、§3.4、§3.8） ─────────────

/**
 * 給 Server Action 組傳進 `auth.api.*` 的 headers：來源 IP（限速鍵）＋ Turnstile token。
 *
 * 表單裡 `<Turnstile>` 寫的隱藏欄是 `cf-turnstile-response`；Server Action 讀出來放進 `x-turnstile-token`，
 * `hooks.before` 跟直接打 HTTP 的人帶的同一個標頭在同一段程式驗（沒有第二條驗證路徑）。
 */
export function authCallHeaders(input: { ip: string; turnstileToken?: string | null }): Headers {
  const headers = new Headers({ 'x-real-ip': input.ip })
  const token = input.turnstileToken?.trim()
  if (token) headers.set('x-turnstile-token', token)
  return headers
}

function isEmailUnavailable(error: unknown): boolean {
  return (error as { body?: { code?: unknown } } | null)?.body?.code === EMAIL_UNAVAILABLE_CODE
}

export type SignUpOrResumeOutcome =
  /** 新帳號建好了（已登入受限 session；套件已在伺服器內寄出第一封驗證碼）。 */
  | { readonly kind: 'created'; readonly userId: string }
  /**
   * 這個 Email 有一筆還沒完成的註冊：驗證碼已寄出，新密碼暫存在伺服器。`ticket` 是這一次續辦的票：
   * 呼叫端要存在**發起續辦的那個瀏覽器**（例如 HttpOnly cookie），填碼時原樣交給 `completeSignupResume`。
   * 別人對同一個 Email 開始的續辦拿不到這張票，信箱主人就不會在不知情下套用別人填的密碼。
   */
  | { readonly kind: 'resume'; readonly email: string; readonly ticket: string }

/**
 * 註冊第 1 步（VB-3 的 Server Action 用；設計方案 §3.2「續辦」）。
 *
 * 先照常 `signUpEmail`（`hooks.before` 依序：註冊限速 → 寄碼額度 → 密碼長度 → Turnstile）。
 * 回 `EMAIL_UNAVAILABLE` 而且那個帳號**可以續辦**時，才在同一次呼叫裡：
 * 經內部入口對該 Email 寄一封驗證碼（不要第二個 Turnstile token——走到 `EMAIL_UNAVAILABLE` 代表 hook 已經驗過；
 * 寄碼額度在註冊那一步已扣過、這裡不重扣，冷卻與 IP 上限照查），寄出去之後才在一筆短交易裡把新密碼雜湊、
 * 最新那封信的碼、續辦票綁成一列暫存（寄不出去就不留暫存）。寄碼期間**不持有任何連線**——套件與寄信轉接器
 * 都向同一個池借連線，占著一條再借在 `DB_POOL_MAX=1` 會死等（Review 第 2 輪；為什麼見 `startSignupResume`）。
 * 綁定與續辦完成用同一把交易級資料庫鎖排隊。
 * 不可續辦的照舊丟原本的 `EMAIL_UNAVAILABLE`（不寄信、什麼都不動）。
 *
 * 續辦一定要跟註冊綁在同一個入口：拆成兩支的話，呼叫端可以不經註冊、不過 Turnstile 就直接觸發寄碼。
 */
export async function signUpOrResume(
  input: { email: string; password: string; name: string },
  headers: Headers,
): Promise<SignUpOrResumeOutcome> {
  try {
    const created = await signUpWithPassword(input, headers)
    return { kind: 'created', userId: String(created.user.id) }
  } catch (error) {
    if (!isEmailUnavailable(error)) throw error
    const email = normalizeEmail(input.email)
    const userId = await findUserIdByEmail(getPool(), email)
    if (!userId || !(await isResumableSignup(getPool(), userId))) throw error

    const started = await startSignupResume(getPool(), {
      userId,
      email,
      send: () =>
        withMailOutcome(() =>
          runAsInternalCall(() =>
            runWithOtpPurpose('signup-resume-start', email, () =>
              getAuth().api.sendVerificationOTP({ body: { email, type: 'email-verification' }, headers }),
            ),
          ),
        ),
      passwordHash: async () => (await getAuth().$context).password.hash(input.password),
    })
    // 寄碼之後、綁定之前帳號變得不能續辦（例如信箱主人剛完成另一次續辦）：沒留暫存，照舊丟原本那個錯。
    if (!started.ok) throw error
    return { kind: 'resume', email, ticket: started.ticket }
  }
}

/**
 * 續辦第 2 步：填對驗證碼 → 一筆交易內標已驗證、換成新密碼、刪掉這個人全部舊 session，再發新 session
 * （cookie 由 `nextCookies()` 帶進 Server Action 的回應）。不經公開 `verify-email` 端點的自動登入。
 *
 * 驗碼走 `check-verification-otp`（跟 verify 共用 otpVerify 桶、同一碼錯 5 次作廢）；交易與發 session 在
 * `hooks.after`，只認內部呼叫＋續辦用途，並在交易裡重驗碼、比對暫存列綁的碼與續辦票。
 * 碼錯（含錯太多次、過期）一律丟 `INVALID_OTP`（跟公開端點同一個回應，不透露帳號狀態）；
 * 暫存過期、碼已被新的一封換掉、票不對丟 `SIGNUP_RESUME_EXPIRED`；帳號已經不能續辦丟 `EMAIL_UNAVAILABLE`。
 */
export async function completeSignupResume(
  input: { email: string; otp: string; ticket: string },
  headers: Headers,
): Promise<{ readonly userId: string; readonly headers: Headers }> {
  const email = normalizeEmail(input.email)
  const result = await runAsInternalCall(() =>
    runWithOtpPurpose(
      'signup-resume-finish',
      email,
      () =>
        getAuth().api.checkVerificationOTP({
          body: { email, type: 'email-verification', otp: input.otp },
          headers,
          returnHeaders: true,
        }),
      input.ticket,
    ),
  )
  const userId = (result.response as { userId?: unknown }).userId
  if (typeof userId !== 'string') throw new Error('續辦完成但沒有拿到帳號 id')
  return { userId, headers: result.headers }
}

/**
 * 重寄驗證碼（註冊第 2 步，公開入口）：`headers` 要帶這一次的新 Turnstile token（`authCallHeaders`）。
 * 冷卻 120 秒、10 分鐘 5 封／Email、每小時 20 封／IP 都在 hook。
 */
export function resendVerificationOtp(input: { email: string }, headers: Headers) {
  return withMailOutcome(() =>
    getAuth().api.sendVerificationOTP({ body: { email: input.email, type: 'email-verification' }, headers }),
  )
}

export type SignupResumeResendOutcome =
  /** 已寄出並改綁（票不對、帳號已不能續辦時也回這個：不寄信、不改綁，但對外跟寄出分不出來）。 */
  | 'sent'
  /** 信寄不出去（Brevo 未設定、拒收或逾時）：原 OTP、原綁定、原期限都留著，沒寄出的新碼撤掉；請使用者稍後再試。 */
  | 'mail_failed'
  /** 票對、但已過續辦的絕對截止（票建立起 30 分鐘）：不寄信、不改綁；請使用者重新開始。 */
  | 'timed_out'

function isMailFailed(error: unknown): boolean {
  return (error as { body?: { code?: unknown } } | null)?.body?.code === 'MAIL_FAILED'
}

/**
 * 同一個 Email 的續辦重寄在這個 process 裡**排隊**（VB-3 Review 第 3 輪 Sol P2）：後到的等先到的整段做完（看票、寄碼、
 * 還原或改綁）才開始。
 *
 * 為什麼要：hook 的 120 秒冷卻是「先 `count` 檢查、Turnstile 驗過之後才 `hit`」（auth-instance 的 `enforceOtpSendRate`），
 * 兩筆同時進來會**都**通過檢查，各寄一封、各插一列；一筆寄失敗先還原、另一筆隨後寄成功，還原會誤撤對方的碼。排隊之後
 * 第二筆輪到時冷卻已記過，在 hook 就被擋下（`RATE_LIMITED`），不打 Turnstile、不寄、不插列——第一筆寄失敗也一樣
 * （冷卻在寄信之前就記了，第 2 輪已接受）。hook 本身的競態是既有的（公開重寄也有）、不在這張票改。
 *
 * 只排同一個 Email，不持有資料庫連線（`DB_POOL_MAX=1` 規則不變）；掛在 `globalThis` 跟 `sharedRateLimiter` 同理
 * （不同 chunk、測試重載模組都要是同一條隊）。app 單一 process（限速器也是這個前提）；多 process 時冷卻與這裡都要改成共用。
 * 別條路（`startSignupResume`、公開重寄）不排這條隊：寄碼前後的快照比對會把那種交錯當成「分不出哪列是自己的」保守處理。
 */
function queueSignupResumeResend<T>(email: string, fn: () => Promise<T>): Promise<T> {
  const registry = ((globalThis as { __fjuSignupResumeResendQueue?: Map<string, Promise<void>> }).__fjuSignupResumeResendQueue ??=
    new Map())
  const previous = registry.get(email) ?? Promise.resolve()
  const run = previous.then(fn)
  const tail: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  )
  registry.set(email, tail)
  void tail.then(() => {
    if (registry.get(email) === tail) registry.delete(email)
  })
  return run
}

/**
 * 續辦頁的重寄驗證碼（VB-3 Review 第 1 輪 P3、第 2 輪、第 3 輪）。`ticket` 是續辦開始時發給這個瀏覽器的那張票（HttpOnly cookie）。
 * 同一個 Email 的呼叫在 `queueSignupResumeResend` 裡排隊，整段（看票、寄碼、還原或改綁）一次只跑一筆。
 *
 * 1. 先看票（只讀）：票錯、帳號已不能續辦 → **不寄信**，回 `sent`（跟寄出時一樣，不透露原因；拿不到票的人本來就無從
 *    得知帳號狀態）。票對但已過絕對截止 → 不寄信，回 `timed_out`。票對、截止內、但這封碼的 10 分鐘視窗已過 → **照常寄**
 *    並在第 4 步把視窗重開（主腦裁定：截止內重寄要復活視窗，不再「不寄信卻回 sent」）。
 * 2. 寄碼走**內部呼叫＋用途 `signup-resume-resend`**，而不是公開的 `resendVerificationOtp`：hook 不認得這個用途，
 *    照公開重寄處理——`headers` 要帶這一次的新 Turnstile token；120 秒冷卻、每個 Email 10 分鐘 5 封、每個 IP 每小時
 *    20 封都由 hook 照算，沒有旁路、不重設計數——差別只在寄信回呼會**等寄送結果**並回報失敗。公開路徑刻意不等
 *    （防帳號列舉；Review 第 2 輪反例：Brevo 未設定時 outbox 記 failed、函式照樣成功、改綁新碼，舊碼失效新碼沒到）。
 *    寄信轉接器是同步的（插 outbox → 打 Brevo → 標 sent／failed，沒有 worker 重試），所以結果在同一次呼叫就拿得到，
 *    不必另做「outbox 送成功才改綁」的兩段式（那要改 mail 層）。
 * 3. 寄碼前先拍這個 Email 驗證碼列 id 的快照（`listSignupOtpRowIds`；只讀、不占連線）：套件在呼叫寄信回呼之前就插一列
 *    新碼，自己拿不到那列的 id，寄完拿快照比對才知道哪一列是這一次插的。
 * 4. 寄失敗（`MAIL_FAILED`）→ 在鎖裡只撤掉快照之後插的那**一**列（`restoreSignupResumeOtp`：多於一列＝別條路交錯、分不出
 *    是誰的，一列都不刪），綁定與期限都不動，原本那封的碼仍能完成；回 `mail_failed`。被冷卻／限速／Turnstile 擋下的照舊
 *    丟出去，什麼都不動。
 * 5. 寄出之後才在鎖裡改綁（`rebindSignupResumeOtp`）：要求這一次插的那列還在，綁最新那列、視窗重設成
 *    `min(現在＋10 分鐘, 截止)`，舊碼從此不能完成續辦。
 *
 * 錯誤次數：每一封新碼照套件規則各自有 5 次（`allowedAttempts`）；總嘗試次數仍受 `otpVerify` 桶
 * （每個 Email 10 分鐘 10 次、每個 IP 每小時 60 次）與寄碼上限約束，不會因為重寄變成無限次。
 */
export function resendSignupResumeOtp(
  input: { email: string; ticket: string },
  headers: Headers,
): Promise<SignupResumeResendOutcome> {
  const email = normalizeEmail(input.email)
  return queueSignupResumeResend(email, () => resendSignupResumeOtpQueued(email, input.ticket, headers))
}

async function resendSignupResumeOtpQueued(email: string, ticket: string, headers: Headers): Promise<SignupResumeResendOutcome> {
  const status = await checkSignupResumeTicket(getPool(), { email, ticket })
  if (status === 'invalid') return 'sent'
  if (status === 'timed_out') return 'timed_out'
  const before = await listSignupOtpRowIds(getPool(), email)
  try {
    await withMailOutcome(() =>
      runAsInternalCall(() =>
        runWithOtpPurpose('signup-resume-resend', email, () =>
          getAuth().api.sendVerificationOTP({ body: { email, type: 'email-verification' }, headers }),
        ),
      ),
    )
  } catch (error) {
    if (!isMailFailed(error)) throw error
    await restoreSignupResumeOtp(getPool(), { email, before })
    return 'mail_failed'
  }
  const rebound = await rebindSignupResumeOtp(getPool(), { email, ticket, before })
  // 看票與寄出之間剛好跨過截止：信已寄出，但這張票不能再用，照實說逾時。
  if (!rebound.ok && rebound.reason === 'timed_out') return 'timed_out'
  // 寄出之後帳號才變得不能續辦（例如信箱主人剛好在別處完成）或暫存列剛被別人改綁：信已寄出，對外一樣回正常；完成時會拿到「已失效」。
  return 'sent'
}

/**
 * 「我的帳號」驗證自己的 Email（VB-5，設計方案 §3.7）：內部寄碼入口，不掛 Turnstile。
 * hook 要求本人 fresh session、Email 只能是 session 本人的登入 Email（限速與冷卻照扣）。
 */
export async function sendOwnVerificationOtp(headers: Headers) {
  // 沒登入時 email 是空字串：hook 找不到 session 會丟 401 `UNAUTHENTICATED`，這裡不另外判斷。
  const session = await getAuth().api.getSession({ headers })
  const email = normalizeEmail(session?.user?.email)
  return withMailOutcome(() =>
    runAsInternalCall(() =>
      runWithOtpPurpose('account-verify', email, () =>
        getAuth().api.sendVerificationOTP({ body: { email, type: 'email-verification' }, headers }),
      ),
    ),
  )
}

/** 填驗證碼完成 Email 驗證（註冊第 2 步、「我的帳號」共用）。同一碼錯 5 次作廢；限速在 hook。 */
export function verifyEmailWithOtp(input: { email: string; otp: string }, headers: Headers) {
  return getAuth().api.verifyEmailOTP({ body: { email: input.email, otp: input.otp }, headers })
}

/**
 * 忘記密碼寄重設連結（VB-4 的 Server Action 用）：`headers` 要帶 Turnstile token。
 * 不論 Email 存不存在都回同一個結果；限速（5 封／小時／Email、20 封／小時／IP）在 hook。
 */
export function requestPasswordReset(input: { email: string }, headers: Headers) {
  return getAuth().api.requestPasswordReset({ body: { email: input.email, redirectTo: '/reset-password' }, headers })
}

/** 用重設連結的 token 設新密碼（VB-4 的重設頁用）：成功後這個人全部 session 被撤掉；長度在 hook。 */
export function resetPasswordWithToken(input: { token: string; newPassword: string }, headers?: Headers) {
  return getAuth().api.resetPassword({
    body: { token: input.token, newPassword: input.newPassword },
    ...(headers ? { headers } : {}),
  })
}
