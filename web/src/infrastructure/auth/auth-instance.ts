import 'server-only'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { nextCookies } from 'better-auth/next-js'
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from 'better-auth/api'
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

/** 契約 03 §2：fresh session＝10 分鐘內登入過。 */
export const FRESH_AGE_SECONDS = 10 * 60

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
     * `/sign-up/email` 維持套件的 IP 桶：契約 §6 對註冊本來就寫「5 次／小時／**IP**」（不含帳號），
     * 鍵的形狀對得上。**門檻仍是 30 而不是 5**——註冊流程是 S01-09 的票，這一批沒有做，
     * 現在收緊會擋到還沒實作的流程。已記在契約 03 §6 的待決。
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: 300,
      customRules: {
        '/sign-in/email': false,
        '/change-password': false,
        '/sign-up/email': { window: 3600, max: 30 },
      },
    },
    emailAndPassword: { enabled: true },
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      },
    },
    account: {
      accountLinking: {
        // 契約 03 §3：同 Email 不自動合併；連結只能由本人在 fresh session 主動發起。
        disableImplicitLinking: true,
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
        if (requirement.fresh && FRESH_AGE_SECONDS !== 0) {
          const createdAt = new Date(session.session.createdAt).getTime()
          if (!Number.isFinite(createdAt) || Date.now() - createdAt >= FRESH_AGE_SECONDS * 1000) {
            throw new APIError('FORBIDDEN', {
              code: 'FRESH_SESSION_REQUIRED',
              message: '這個操作需要重新登入確認身分。',
            })
          }
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
