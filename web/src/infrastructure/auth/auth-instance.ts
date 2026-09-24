import 'server-only'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { nextCookies } from 'better-auth/next-js'
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx, getOAuthState } from 'better-auth/api'
import { uuidv7 } from 'uuidv7'
import { getDb } from '@/infrastructure/db/client'
import * as schema from '@/infrastructure/db/schema'
import {
  pathHasAnyAllowedMethod,
  requirementByPath,
  routeAccess,
  sessionRequirement,
} from '@/infrastructure/auth/route-matrix'
import { isInternalCall } from '@/infrastructure/auth/internal-call'
import {
  isFullyActive,
  isUsableSession,
  readAccountState,
} from '@/infrastructure/auth/account-state'
import {
  checkChangePasswordRate,
  MIN_PASSWORD_LENGTH,
  recordPasswordChanged,
  validateNewPassword,
} from '@/infrastructure/auth/change-password-rules'
import {
  checkSignInRate,
  clientIpFrom,
  resetSignInRate,
  signInKey,
} from '@/infrastructure/auth/sign-in-rate-limit'
import { checkSignUpRate } from '@/infrastructure/auth/sign-up-rate-limit'
import { checkSocialSignInRate } from '@/infrastructure/auth/social-sign-in-rate-limit'
import {
  EMAIL_UNAVAILABLE_CODE,
  EMAIL_UNAVAILABLE_MESSAGE,
  bindPreauthorizedTeacher,
  isSignInState,
  FRESH_AGE_SECONDS,
  isFreshSession,
  recordLastLoginMethod,
  recordLoginMethodAdded,
  SIGN_UP_EMAIL_ERROR_CODES,
} from '@/infrastructure/auth/login-methods'

/**
 * Better Auth 實例（S01-02）。
 *
 * **只有 `wrapper.ts` 可以 import 這個檔**（eslint 的 no-restricted-imports 擋住其他路徑）：
 * 對外的 HTTP 入口與對內的管理員能力都要經包裝器，才有單一一處可以檢查。
 *
 * 這裡設定四件事：
 * 1. 路由的第二層攔截（`hooks.before`）——第一層在 `wrapper.ts`，在 `toNextJsHandler` 之前。
 * 2. 任何新建帳號一律 `status='pending'`（契約 03 §2）。
 * 3. 每個 session 記下這次的登入方式（契約 01 §4.1 `sessions.login_method`）。
 * 4. 設定值：uuidv7 主鍵、關掉隱含帳號合併、關掉 cookie 快取、fresh session 10 分鐘。
 */

/** 契約 03 §2：fresh session＝10 分鐘內登入過（數字與判準在 `login-methods.ts`，設密碼的用例共用）。 */
export { FRESH_AGE_SECONDS }

/**
 * 從端點路徑推這次的登入方式。
 *
 * `sessions.login_method` 有 CHECK 白名單（`google`／`password`），所以這裡一定要給值。
 * 判定只看「建立這個 session 的是哪一個端點」，不看使用者帳號上綁了幾種方式
 * ——模組 01 §2 明寫「這次登入方式」來自 session 列本身。
 */
export function loginMethodForPath(path: string | undefined): 'google' | 'password' {
  if (path === undefined) return 'password'
  if (path.startsWith('/callback/') || path === '/sign-in/social') return 'google'
  return 'password'
}

/**
 * 實例是**延後建立**的：`betterAuth()` 會馬上要一條資料庫連線，
 * 而 `next build` 收集路由設定時並沒有 `DATABASE_URL`（憑證由維運在執行期帶進容器）。
 * 模組載入時就建會讓 build 直接失敗，所以第一次真的有人打進來才建。
 */
let instance: ReturnType<typeof createAuth> | undefined

export function getAuth(): ReturnType<typeof createAuth> {
  instance ??= createAuth()
  return instance
}

function createAuth() {
  return betterAuth({
    database: drizzleAdapter(getDb(), { provider: 'pg', schema, usePlural: true }),
    advanced: {
      // 契約 01 §1：主鍵一律由應用產生 uuidv7，包含 Better Auth 的四張表。
      database: { generateId: () => uuidv7() },
      /**
       * 正式環境的 app 在 Caddy 後面，socket 的來源永遠是 proxy。
       *
       * 不設這個的話 Better Auth 解析不到用戶端 IP，它自己的限速會**退回全站共用一個桶**
       * （套件會 warn），而且 `sessions.ip_address` 會全部記成 proxy 的位址。
       * Caddyfile 帶的就是 `X-Real-IP`（本機直連時退回 `X-Forwarded-For`）。
       */
      ipAddress: { ipAddressHeaders: ['x-real-ip', 'x-forwarded-for'] },
    },
    /**
     * 套件自己的限速。
     *
     * 它的預設對本專案是錯的：`/sign-in*`、`/sign-up*`、`/change-password*` 的內建規則是
     * **3 次／10 秒／IP**，而契約 03 §6 要的是「登入 10 次／10 分鐘／IP＋帳號」。
     * 兩者衝突時先撞到的是套件那一條，等於契約的門檻永遠測不到，而且會擋錯人
     * ——全系在同一個對外 IP 後面，10 秒 3 次連正常上課時段的登入都擋。
     *
     * 上一輪的修法是把那兩條「放寬」成 60 次／10 分鐘，但**放寬不能解決問題**：
     * 套件的鍵（`rate-limiter/index.mjs` 的 `createRateLimitKey(ip, path)`）只有 IP＋路徑，
     * 永遠不含帳號，所以它本質上就是一個跨帳號共用的桶。同一個對外 IP 後面，
     * 60 個不同帳號各錯一次就把桶用完，第 61 個人拿正確密碼也會被擋（2026-09-16 複核 Spec 3）。
     *
     * 所以契約管到的兩條直接**關掉**套件的限速（`false` 會讓 `resolveRateLimitConfig` 回 null）：
     * - `/sign-in/email`：契約門檻＝10 次／10 分鐘／**IP＋帳號**，由 `sign-in-rate-limit.ts` 做，
     *   它的鍵含帳號，所以別人的失敗不會算到你頭上。
     * - `/change-password`：契約門檻是**每人**每小時，由 `change-password-rules.ts` 以 userId 為鍵做。
     *   （這一條同樣不能用 IP 桶：系辦發臨時密碼後一整批人在同一個校園出口改密是正常流程。）
     *
     * 契約 03 §6 把粗粒度的那一層明寫成「app 記憶體＋**Caddy**」——跨帳號的 DoS 防護屬於
     * 反向代理那一層，不是這裡。
     *
     * - `/sign-up/email`：契約門檻＝**30 次／小時／IP**（2026-09-23 Roy 定案，取代 5 次）。
     *   套件那一層只看得到 HTTP 請求，註冊頁的 Server Action 在伺服器端呼叫 `auth.api.signUpEmail`
     *   根本不經過它——兩條路會變成各算各的。所以也關掉，改由 `sign-up-rate-limit.ts` 在
     *   `hooks.before` 裡算（hook 對兩條路都會跑），一個桶、一個門檻（票 7）。
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: 300,
      customRules: {
        '/sign-in/email': false,
        '/change-password': false,
        '/sign-up/email': false,
        // Google 登入入口（票 10）：只產生 state 與授權網址，不驗任何帳密。套件預設的
        // 「10 秒 3 次／IP」會讓同一個校園出口後面的第四個同學按 Google 鈕就吃 429。
        // 關掉之後改由 `social-sign-in-rate-limit.ts` 在 hook 裡算每 IP 桶（票 10b），
        // Server Action 與直接打 API 同一個桶。粗粒度的跨帳號防護仍在 Caddy（契約 03 §6）。
        '/sign-in/social': false,
      },
    },
    emailAndPassword: { enabled: true },
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        /**
         * Google 身分剛換到、套件還沒開始找使用者的那一刻。只用來處理「系辦預授權的老師
         * 第一次用 Google 登入」（見 `bindPreauthorizedTeacher` 的條件）；不改任何使用者欄位。
         */
        mapProfileToUser: async (profile) => {
          // 連結流程（已登入的人按「連結 Google」）也會經過這裡；那不是「預授權老師第一次登入」，
          // 不能順手替別人綁。state 在這之前已由套件解析好（callback 的 `parseState`），`link` 有值就是連結。
          //
          // **失敗要關不要開**（票 10b；票 10 審查建議）：讀不到 state（丟例外、或預設值 null——
          // 例如 body 帶 `idToken` 那條沒有 redirect 的路，雖然已在 hook 擋掉）一律不綁。
          // 之前是讀不到就當成「登入」而去綁。
          const state: unknown = await getOAuthState().catch(() => null)
          if (isSignInState(state)) await bindPreauthorizedTeacher(profile)
          return {}
        },
      },
    },
    account: {
      /**
       * 帳號連結（模組 01 §2.3 Q-ACC02；契約 03 §3；票 10）。
       *
       * - `disableImplicitLinking`：未登入時用 Google 登入、Email 跟既有帳號相同，**不自動合併**。
       *   唯一例外是系辦預授權、還沒有任何登入方式的老師帳號（見 Google 設定的 `mapProfileToUser`）。
       *   套件會把人導回 `errorCallbackURL?error=account_not_linked`，登入頁提示「用原方式登入後再連結」。
       *   連結只能走 `/link-social`（本人、active、fresh session，路由矩陣與下面的 hook 管）。
       * - `allowDifferentEmails: false`：連結的 Google 帳號 Email 必須等於登入 Email。
       *   登入 Email 本人不能換（§2.3 Q3），連一個別的 Email 的 Google 進來等於多一個登入身分，先不開。
       * - `updateUserInfoOnLink: false`：連結不改姓名、頭像，更不改 Email。
       *
       * 三個值都是套件預設（除了第一個），寫出來是為了讓「為什麼」留在設定旁邊，也讓測試直接讀來斷言。
       */
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        updateUserInfoOnLink: false,
      },
    },
    session: {
      additionalFields: {
        loginMethod: { type: 'string', required: true, input: false },
      },
      // 契約 03 §3：停用要立刻生效，所以不能讓 session 內容在 cookie 裡放著用。
      cookieCache: { enabled: false },
      freshAge: FRESH_AGE_SECONDS,
    },
    user: {
      additionalFields: {
        status: { type: 'string', required: true, defaultValue: 'pending', input: false },
        mustChangePassword: { type: 'boolean', required: true, defaultValue: false, input: false },
        deidentifiedAt: { type: 'date', required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // 契約 03 §2：不論從哪一條路進來，新帳號一律待審核。
          // `input: false` 已經擋掉從請求體帶 status，這裡是第二層，連內部建立也一樣。
          before: async (user) => ({ data: { ...user, status: 'pending' } }),
        },
      },
      session: {
        create: {
          /**
           * 建 session 的最後一刻擋掉停用帳號（契約 03 §2）。
           *
           * 為什麼擋在這裡而不是登入前先查 Email：先查再拒絕等於送對方一個
           * 「這個帳號存在而且被停用」的探測管道。擋在密碼驗過之後、session 建起來之前，
           * 外面看到的就只是一次普通的登入失敗。
           *
           * 判斷只看 `users.status`，不看 Better Auth 的 `banned`——後者是 commit 後的
           * 外部呼叫，可能還沒收斂（模組 01 v2.4 規則 6）。
           */
          before: async (session, context) => {
            const state = await readAccountState(String(session.userId))
            if (!state || !isUsableSession(state)) return false

            return { data: { ...session, loginMethod: loginMethodForPath(context?.path) } }
          },
          /** 帳號最近一次的登入方式（列表顯示用；不作判定）。 */
          after: async (session) => {
            const method = (session as { loginMethod?: string }).loginMethod
            if (method === 'google' || method === 'password') {
              await recordLastLoginMethod(String(session.userId), method)
            }
          },
        },
      },
      account: {
        create: {
          /**
           * 本人新增了第二種登入方式（連結 Google、替 Google 帳號設密碼）就留一筆稽核
           * （ACC-16／18 的「連結紀錄」）。註冊建的第一列不算。
           */
          after: async (account) => {
            await recordLoginMethodAdded(String(account.userId), String(account.providerId))
          },
        },
      },
    },
    hooks: {
      /**
       * 第二層攔截（S01-02 的路由封鎖 ＋ S01-03 的內部呼叫辨識）。
       *
       * 判定順序：
       * 1. 這條路（對這個方法）是不是封鎖的？
       *    是的話只有「內部呼叫」能過：`ctx.request` 不存在**且**包裝器的 marker 存在
       *    （契約 03 §2）。兩個條件缺一不可，所以外部 HTTP 打不進來，
       *    沒有經過包裝器的伺服器端呼叫也打不進來。
       *    server-only 呼叫沒有 HTTP 方法可看，所以用 `pathHasAnyAllowedMethod` 以路徑判斷；
       *    這樣 `auth.api.getSession` 這種本來就對外開放的端點在伺服器端仍然可用。
       * 2. 路是通的——再看**帳號的業務狀態**（契約 03 §2 的矩陣）。
       *    這一關原本只做在頁面導向與 Server Action 上，所以直接打 `/api/auth/*` 就繞過去了
       *    （2026-09-16 review Spec 2）。放在 hook 裡，白名單路由才真的受狀態矩陣管。
       */
      before: createAuthMiddleware(async (ctx) => {
        const isBlocked = ctx.request
          ? routeAccess(ctx.path, ctx.request.method) === 'blocked'
          : !pathHasAnyAllowedMethod(ctx.path)

        if (isBlocked) {
          const isInternal = !ctx.request && isInternalCall()
          if (isInternal) return
          throw new APIError('FORBIDDEN', { code: 'FORBIDDEN', message: '這個入口不對外開放。' })
        }

        // ── Google：只走 redirect＋state（票 10b；票 10 審查建議） ──────────────
        //
        // `/sign-in/social` 與 `/link-social` 的請求體還接受 `idToken`：瀏覽器自己拿 Google 的
        // id_token 丟進來，套件驗簽後直接登入或連結，**不經 redirect、也沒有 state**。
        // 本產品只用 redirect 流程；state 上的 `link` 判斷（預授權老師綁定只在「登入」時做）與
        // PKCE 在那條路上都不存在，所以整條路直接關掉，Server Action 與直接打 API 都一樣。
        if ((ctx.path === '/sign-in/social' || ctx.path === '/link-social') && hasIdToken(ctx.body)) {
          throw new APIError('BAD_REQUEST', {
            code: 'ID_TOKEN_NOT_SUPPORTED',
            message: '請用「使用 Google 帳號登入」按鈕登入。',
          })
        }

        // Google 登入入口的每 IP 限速（票 10b）：套件那一層對這條路關掉了，不補就完全不限速，
        // 而每按一次都寫一列 `verifications`。門檻見 `RATE_LIMITS.signInSocial`。
        if (ctx.path === '/sign-in/social') {
          const ip = clientIpFrom(ctx.request?.headers ?? ctx.headers)
          if (!checkSocialSignInRate(ip).allowed) {
            throw new APIError('TOO_MANY_REQUESTS', {
              code: 'RATE_LIMITED',
              message: '這個網路一小時內的 Google 登入次數已達上限，請稍後再試。',
            })
          }
        }

        // ── 註冊：限速與密碼長度（契約 03 §6；票 7） ─────────────────────────
        //
        // 跟登入一樣放在 hook：註冊頁的 Server Action（伺服器端呼叫）與直接打
        // `/api/auth/sign-up/email` 走同一段程式、算同一個桶。密碼長度也在這裡擋，
        // 不然直接打 HTTP 就能用套件預設的 8 個字元註冊。
        if (ctx.path === '/sign-up/email') {
          const ip = clientIpFrom(ctx.request?.headers ?? ctx.headers)
          if (!checkSignUpRate(ip).allowed) {
            throw new APIError('TOO_MANY_REQUESTS', {
              code: 'RATE_LIMITED',
              message: '這個網路一小時內的註冊次數已達上限，請稍後再試。',
            })
          }
          const password = String(((ctx.body ?? {}) as { password?: unknown }).password ?? '')
          if (password.length < MIN_PASSWORD_LENGTH) {
            throw new APIError('BAD_REQUEST', {
              code: 'VALIDATION_FAILED',
              message: `密碼至少要 ${MIN_PASSWORD_LENGTH} 個字元。`,
            })
          }
        }

        // ── 登入限速（契約 03 §6） ────────────────────────────────────────
        //
        // 放在這裡而不是只放在 Server Action 門面上：直接打 `/api/auth/sign-in/email`
        // 也要算同一個桶（2026-09-16 review Spec 4）。
        if (ctx.path === '/sign-in/email') {
          const email = String(((ctx.body ?? {}) as { email?: string }).email ?? '')
          if (email) {
            const ip = clientIpFrom(ctx.request?.headers ?? ctx.headers)
            if (!checkSignInRate(signInKey(ip, email)).allowed) {
              // 達到上限之後**連正確的密碼也先擋**——不然「有沒有被擋」就成了
              // 密碼對不對的訊號。
              throw new APIError('TOO_MANY_REQUESTS', {
                code: 'RATE_LIMITED',
                message: '嘗試過多，請稍後再試。',
              })
            }
          }
        }

        // ── 第二關：帳號的業務狀態（契約 03 §2 的矩陣） ────────────────────
        //
        // 這一關原本只做在頁面導向與 Server Action 上，所以直接打 `/api/auth/*` 就繞過去了
        // （2026-09-16 review Spec 2）。放在 hook 裡，白名單路由才真的受狀態矩陣管。
        //
        // **有 request 才用方法查表**；server-only 呼叫沒有方法，就以路徑取最嚴的一條。
        // 之前是「沒有 request 就當 POST」，而 `/list-accounts` 只註冊 GET，
        // 於是查不到、整關被跳過（2026-09-16 複核 Spec 2）。
        const requirement = ctx.request
          ? sessionRequirement(ctx.path, ctx.request.method)
          : requirementByPath(ctx.path)
        if (requirement === undefined || requirement.session === 'none') return

        const session = await getAuthoritativeSessionFromCtx(ctx)
        // 沒有 session 就交給端點自己回 401——這一關只管「有 session 但狀態不對」。
        if (!session?.user?.id) return

        const state = await readAccountState(String(session.user.id))
        if (!state || !isUsableSession(state)) {
          // 停用與去識別化一律當作未登入（契約 03 §2）；不回「你被停用了」，
          // 那會變成一個可以拿來探測帳號狀態的側通道。
          throw new APIError('UNAUTHORIZED', { code: 'UNAUTHENTICATED', message: '請重新登入。' })
        }

        if (requirement.session === 'active-only' && !isFullyActive(state)) {
          throw new APIError('FORBIDDEN', {
            code: state.mustChangePassword ? 'PASSWORD_CHANGE_REQUIRED' : 'ACCOUNT_PENDING',
            message: state.mustChangePassword ? '請先更改密碼。' : '帳號還在等待審核。',
          })
        }

        /**
         * fresh session（契約 03 §2）。
         *
         * `session.freshAge` 設了也沒用：安裝版本 1.7.5 只有 `/list-sessions` 掛
         * `freshSessionMiddleware`，`/link-social` 與 `/list-accounts` 掛的是一般的
         * `sessionMiddleware`（`dist/api/routes/session.mjs`）——設定值對它們不會被讀到
         * （2026-09-16 複核 Spec 1）。所以在這裡自己比，判準與套件那支一致：
         * 現在時間減 `session.createdAt` 要**小於** freshAge。
         */
        if (requirement.fresh && !isFreshSession(session.session.createdAt)) {
          throw new APIError('FORBIDDEN', {
            code: 'FRESH_SESSION_REQUIRED',
            message: '這個操作需要重新登入確認身分。',
          })
        }

        // ── 第三關：改密碼的業務規則（模組 01 §3、契約 03 §2、§6） ─────────
        //
        // 這些規則原本只寫在 SelfAccountCommand 上，直接打 HTTP 就整組繞過去
        // （2026-09-16 review Spec 3）。放在這裡，兩條路走同一段程式。
        if (ctx.path === '/change-password') {
          const body = (ctx.body ?? {}) as { currentPassword?: string; newPassword?: string }
          const currentPassword = String(body.currentPassword ?? '')
          const newPassword = String(body.newPassword ?? '')

          const rate = checkChangePasswordRate(String(session.user.id))
          if (!rate.allowed) {
            throw new APIError('TOO_MANY_REQUESTS', {
              code: 'VALIDATION_FAILED',
              message: '改密碼的次數太多，請稍後再試。',
            })
          }

          const problem = validateNewPassword(newPassword, currentPassword)
          if (problem === 'too_short') {
            throw new APIError('BAD_REQUEST', {
              code: 'VALIDATION_FAILED',
              message: `新密碼至少要 ${MIN_PASSWORD_LENGTH} 個字元。`,
            })
          }
          if (problem === 'same_as_current') {
            throw new APIError('BAD_REQUEST', {
              code: 'VALIDATION_FAILED',
              message: '新密碼不能跟目前的密碼一樣。',
            })
          }

          // 契約 03 §2 要求改密一定撤掉其他裝置的登入。**不接受客戶端不傳或傳 false**，
          // 所以在這裡直接覆寫請求內容，而不是「檢查它有沒有傳」。
          return { context: { body: { ...body, revokeOtherSessions: true } } }
        }
      }),

      /**
       * 成功之後才做的事。
       *
       * - 改密成功：清 must-change 旗標、寫稽核（同一個交易）。
       * - 登入成功：把限速計數清掉。
       *
       * 失敗的請求不會走到這裡（端點丟 APIError 時 `returned` 是那個錯誤）。
       */
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned

        // ── 註冊：Email 已被用過不透露（票 7 遺留；工程模組 01 §3 `USER_EXISTS` 統一訊息） ──
        //
        // 套件對已註冊的 Email 回 422 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`，跟其他錯誤一眼分得出來。
        // 這裡把它和「Email 格式不對」統一成同一個 400＋代碼＋訊息（跟註冊頁那一句一樣），
        // 直接打 HTTP 與 Server Action 走的是同一段。
        // HTTP 狀態碼 hook 改不動（套件沿用端點原本的 422），由 `wrapper.ts` 的外層統一成 400。
        // 限制：註冊**成功**本身（200＋登入 cookie）跟失敗仍然分得出來——要完全分不出來得關掉
        // 「註冊完就登入」或改寄驗證信；大量探測由 30 次／小時／IP 的註冊限速擋。
        // `instanceof` 不可靠：端點丟的 APIError 來自 `@better-auth/core`，跟這裡 import 的不一定是同一個類別。
        if (ctx.path === '/sign-up/email' && looksLikeApiError(returned)) {
          const body = (returned.body ?? {}) as { code?: unknown; message?: unknown }
          const code = String(body.code ?? '')
          // 格式錯誤是套件的 zod 驗證（`VALIDATION_ERROR`，訊息以 `[body.email]` 開頭）。
          const emailFormat = code === 'VALIDATION_ERROR' && String(body.message ?? '').startsWith('[body.email]')
          if (SIGN_UP_EMAIL_ERROR_CODES.has(code) || emailFormat) {
            throw new APIError('BAD_REQUEST', { code: EMAIL_UNAVAILABLE_CODE, message: EMAIL_UNAVAILABLE_MESSAGE })
          }
        }

        if (returned instanceof APIError) return

        if (ctx.path === '/change-password') {
          // **不能**用 `getAuthoritativeSessionFromCtx` 拿使用者：`revokeOtherSessions`
          // 會把這個人**全部**的 session 刪掉再建一個新的（套件的 update-user.mjs），
          // 所以此刻請求裡那張 cookie 指向的列已經不存在了。改密的回應本身帶著 user。
          const userId = (returned as { user?: { id?: string } } | undefined)?.user?.id
          if (userId) await recordPasswordChanged(String(userId))
          return
        }

        if (ctx.path === '/sign-in/email') {
          const email = String(((ctx.body ?? {}) as { email?: string }).email ?? '')
          if (email) resetSignInRate(signInKey(clientIpFrom(ctx.request?.headers ?? ctx.headers), email))
        }
      }),
    },
    plugins: [
      admin(),
      // 一定要放最後（官方要求）：讓 Server Action 裡呼叫 `auth.api.*` 時，
      // 套件設的 cookie 真的會被帶進回應。登入表單走 Server Action（契約 02 §7），
      // 沒有它就會「登入成功但沒有 session」。
      nextCookies(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

/** 請求體有沒有帶 `idToken`（任何非 undefined／null 的值都算，空物件也算）。 */
function hasIdToken(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const value = (body as { idToken?: unknown }).idToken
  return value !== undefined && value !== null
}

/** 套件丟的 APIError（不同套件實體的類別 `instanceof` 會失敗，所以看形狀）。 */
function looksLikeApiError(value: unknown): value is { status: unknown; body?: unknown } {
  return (
    value instanceof APIError ||
    (value instanceof Error && value.name === 'APIError' && 'status' in value)
  )
}
