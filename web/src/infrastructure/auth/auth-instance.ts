import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, emailOTP } from 'better-auth/plugins'
import { nextCookies } from 'better-auth/next-js'
import { setSessionCookie } from 'better-auth/cookies'
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx, getOAuthState } from 'better-auth/api'
import { uuidv7 } from 'uuidv7'
import { getDb, getPool } from '@/infrastructure/db/client'
import * as schema from '@/infrastructure/db/schema'
import {
  pathHasAnyAllowedMethod,
  requirementByPath,
  routeAccess,
  sessionRequirement,
} from '@/infrastructure/auth/route-matrix'
import { isInternalCall, runAsInternalCall } from '@/infrastructure/auth/internal-call'
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
  checkIpFailures,
  checkSignInRate,
  clientIpFrom,
  recordIpFailure,
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
import { isRegistrationOpen, REGISTRATION_CLOSED_MESSAGE } from '@/infrastructure/auth/registration-switch'
import { readTurnstileConfig, verifyTurnstile, type TurnstileAction, type TurnstileConfig } from '@/infrastructure/auth/turnstile-verify'
import { currentOtpPurpose, finishSignupResume, normalizeEmail, runWithOtpPurpose } from '@/infrastructure/auth/signup-resume'
import { emailOtpMail, passwordResetMail, type Mailer } from '@/application/mail'
import { BrevoMailer } from '@/infrastructure/mail/brevo-mailer'
import { CaptureMailer } from '@/infrastructure/mail/capture-mailer'
import { RATE_LIMITS, sharedRateLimiter } from '@/shared/rate-limit'

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

/**
 * 被限速時最晚要等多久（N-21）。限速是固定視窗：被擋之後最晚一個視窗長度就重算，
 * 所以照 `RATE_LIMITS` 的視窗長度說「最晚」，不寫死數字。
 */
function waitAtMost(windowMs: number): string {
  const minutes = Math.ceil(windowMs / 60_000)
  return minutes % 60 === 0 ? `${minutes / 60} 小時` : `${minutes} 分鐘`
}

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

// ── Email 驗證碼與重設密碼（B 階段 VB-2；visitor-r3 設計方案 §3.2、§3.4、§3.8） ─────────────

/**
 * 驗證碼與重設密碼的限速桶（門檻在 `RATE_LIMITS`）。都在 `hooks.before` 裡算：HTTP 與 Server Action→`auth.api`
 * 兩條路都經過那裡，所以共用同一組桶（掛在 `globalThis`，Route Handler 與頁面在不同 chunk 也是同一份）。
 */
const otpLimiters = {
  sendEmail: sharedRateLimiter('otp-send-email', RATE_LIMITS.otpSend.email),
  sendIp: sharedRateLimiter('otp-send-ip', RATE_LIMITS.otpSend.ip),
  cooldown: sharedRateLimiter('otp-resend-cooldown', RATE_LIMITS.otpResendCooldown),
  verifyEmail: sharedRateLimiter('otp-verify-email', RATE_LIMITS.otpVerify.email),
  verifyIp: sharedRateLimiter('otp-verify-ip', RATE_LIMITS.otpVerify.ip),
  resetEmail: sharedRateLimiter('password-reset-email', RATE_LIMITS.passwordReset.email),
  resetIp: sharedRateLimiter('password-reset-ip', RATE_LIMITS.passwordReset.ip),
}

/** 測試用：清掉驗證碼與重設密碼的全部限速計數（含 120 秒冷卻）。 */
export function resetEmailOtpLimiters(): void {
  for (const limiter of Object.values(otpLimiters)) limiter.clear()
}

function tooMany(message: string): APIError {
  return new APIError('TOO_MANY_REQUESTS', { code: 'RATE_LIMITED', message })
}

/**
 * 寄驗證碼前的限速：冷卻 → Email 桶 → IP 桶。冷卻只看不計（真的寄出去才開始計時，見 `sendVerificationOTP`），
 * 冷卻中被擋不扣 10 分鐘的額度。
 */
function enforceOtpSendRate(email: string, ip: string): void {
  if (otpLimiters.cooldown.count(email) > 0) {
    throw tooMany(`驗證碼剛寄出，請等 ${RATE_LIMITS.otpResendCooldown.windowMs / 1000} 秒再重寄。`)
  }
  if (!otpLimiters.sendEmail.hit(email).allowed) {
    throw tooMany(`寄太多次了，請 ${waitAtMost(RATE_LIMITS.otpSend.email.windowMs)}後再試。`)
  }
  if (!otpLimiters.sendIp.hit(ip).allowed) {
    throw tooMany(`這個網路寄驗證碼的次數已達上限，最晚 ${waitAtMost(RATE_LIMITS.otpSend.ip.windowMs)}後可以再試。`)
  }
}

/** 「一小時」比「1 小時」順口；畫面句跟驗收案例一致（AC-VI-59「請一小時後再試」）。 */
function inWords(windowMs: number): string {
  const text = waitAtMost(windowMs)
  return text === '1 小時' ? '一小時' : text
}

/**
 * 寄信轉接器（設計方案 §3.1）。規則跟 `composition/mail.ts` 的 `chooseMailer` 一致：`MAIL_CAPTURE=1` **而且**
 * `BETTER_AUTH_URL` 是本機才擷取，其他一律 Brevo（缺金鑰回 `MAIL_NOT_CONFIGURED`，不降級成擷取）。
 *
 * 為什麼不直接用 composition 那一份：這個檔在 infrastructure，分層不准往上引用 composition；
 * 兩邊判斷一致由 `email-otp.integration.test.ts` 逐組合比對守住。
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function authMailerKind(env: { MAIL_CAPTURE?: string; BETTER_AUTH_URL?: string }): 'brevo' | 'capture' {
  if (env.MAIL_CAPTURE !== '1') return 'brevo'
  try {
    return env.BETTER_AUTH_URL && LOCAL_HOSTS.has(new URL(env.BETTER_AUTH_URL).hostname) ? 'capture' : 'brevo'
  } catch {
    return 'brevo'
  }
}

function createAuthMailer(): Mailer {
  return authMailerKind({ MAIL_CAPTURE: process.env.MAIL_CAPTURE, BETTER_AUTH_URL: process.env.BETTER_AUTH_URL }) ===
    'capture'
    ? new CaptureMailer({ db: getPool })
    : new BrevoMailer({
        db: getPool,
        config: { apiKey: process.env.BREVO_API_KEY, from: process.env.MAIL_FROM, replyTo: process.env.MAIL_REPLY_TO },
      })
}

/**
 * 這一次 `auth.api`／HTTP 呼叫裡，驗證碼信有沒有寄失敗。
 *
 * 套件 1.7.5 會把寄信回呼丟的錯吞掉（`runInBackgroundOrAwait` 只記 log），回呼 throw 傳不回呼叫端。
 * 所以回呼只在這個盒子裡記一筆，寄碼端點的 `hooks.after` 看到就改回 `MAIL_FAILED`。
 * 盒子由 wrapper 在每個入口開（HTTP 的 route handler、各個 Server Action 用的函式），見 `withMailOutcome`。
 */
const mailOutcome = new AsyncLocalStorage<{ failed: boolean }>()

export function withMailOutcome<T>(fn: () => Promise<T>): Promise<T> {
  return mailOutcome.run({ failed: false }, fn)
}

function mailFailedError(): APIError {
  return new APIError('INTERNAL_SERVER_ERROR', { code: 'MAIL_FAILED', message: '驗證信寄不出去，請稍後再試。' })
}

/** 重設連結直接指到站內的 `/reset-password?token=…`（不經套件的 `/api/auth/reset-password/:token` 轉址）。 */
function resetPasswordUrl(token: string): string {
  const origin = (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '')
  return `${origin}/reset-password?token=${encodeURIComponent(token)}`
}

/**
 * Turnstile（設計方案 §3.8）：token 來自標頭 `x-turnstile-token`（HTTP 直接帶；Server Action 把表單隱藏欄
 * `cf-turnstile-response` 的值放進傳給 `auth.api.*` 的同名標頭）。兩條路走同一段。
 * 金鑰都沒設＝功能關閉（`verifyTurnstile` 直接放行）。
 */
async function requireTurnstile(
  config: TurnstileConfig,
  headers: Headers | undefined,
  action: TurnstileAction,
): Promise<void> {
  const ip = clientIpFrom(headers)
  const verdict = await verifyTurnstile(headers?.get('x-turnstile-token'), ip === 'unknown' ? null : ip, action, { config })
  if (verdict.ok) return
  if (verdict.reason === 'unavailable') {
    throw new APIError('SERVICE_UNAVAILABLE', {
      code: 'TURNSTILE_UNAVAILABLE',
      message: '人機驗證暫時無法使用，請稍後再試。',
    })
  }
  throw new APIError('BAD_REQUEST', { code: 'TURNSTILE_REQUIRED', message: '請完成人機驗證。' })
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
  // 註冊開關（設計方案 §5）：建實例時讀一次，三處（密碼註冊、Google 新帳號、hook）用同一個值。
  // 切換要重建容器，見 `registration-switch.ts`。
  const registrationOpen = isRegistrationOpen()
  // Turnstile 金鑰也在這裡讀一次：只設一個鍵的話，第一次建實例就丟錯（AC-VI-67），不會半套上線。
  const turnstileConfig = readTurnstileConfig()
  const mailer = createAuthMailer()
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
        // Server Action 與直接打 API 同一個桶。Caddy 沒有設限速；密碼登入的跨帳號防護
        // 由 app 的每 IP 失敗桶負責（`sign-in-rate-limit.ts`，票 T3）。
        '/sign-in/social': false,
        // Email 驗證碼三條（VB-2）：email-otp 外掛自帶 3 次／60 秒，鍵只有 IP＋路徑（跨帳號共用一桶），
        // 而且只在 HTTP 跑、Server Action 不經過。關掉，改由 hooks.before 的 otpSend／otpVerify 桶負責。
        '/email-otp/send-verification-otp': false,
        '/email-otp/check-verification-otp': false,
        '/email-otp/verify-email': false,
        // 忘記密碼（VB-2）：套件預設 3 次／60 秒／IP，同一個校園出口後面第 4 個人就被擋。改由 passwordReset 桶負責。
        '/request-password-reset': false,
      },
    },
    // 關閉註冊時套件自己也擋（400 `EMAIL_PASSWORD_SIGN_UP_DISABLED`）；對外的那一句中文由 hook 先回。
    emailAndPassword: {
      enabled: true,
      disableSignUp: !registrationOpen,
      /**
       * 忘記密碼寄重設連結（VB-2；設計方案 §3.4）。連結 30 分鐘有效、只能用一次（套件 consume）。
       *
       * **不等寄信結果**：對外不論 Email 存不存在、寄得出去與否都回同一句（不洩漏帳號存在），
       * 要是在這裡等 Brevo，「有帳號」的請求會明顯比較慢。寄失敗只留 `mail_outbox.status='failed'` 與一行 log
       * （log 不含連結與 token）。
       */
      sendResetPassword: async ({ user, token }) => {
        void mailer
          .send({ to: user.email, ...passwordResetMail(resetPasswordUrl(token)) })
          .then((result) => {
            if (!result.ok) console.error('[auth] 重設密碼信寄不出去', { outboxId: result.outboxId, code: result.code })
          })
          .catch((error: unknown) => {
            console.error('[auth] 重設密碼信寄送例外', error instanceof Error ? error.name : 'unknown')
          })
      },
      resetPasswordTokenExpiresIn: 30 * 60,
      // 重設成功＝撤掉這個人全部 session（不設的話套件不撤；AC-VI-60）。
      revokeSessionsOnPasswordReset: true,
    },
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        /**
         * 關閉註冊時，Google 回來發現是新帳號就不建，導回 `errorCallbackURL?error=signup_disabled`
         * （登入頁翻成「目前沒有開放註冊」）。系辦預授權的老師不受影響：`mapProfileToUser` 先把
         * Google 身分綁到既有帳號，套件走的是「既有帳號登入」。
         */
        disableSignUp: !registrationOpen,
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
              message: `這個網路 ${waitAtMost(RATE_LIMITS.signInSocial.windowMs)}內的 Google 登入次數已達上限，最晚 ${waitAtMost(RATE_LIMITS.signInSocial.windowMs)}後可以再試；仍無法登入請聯絡系辦。`,
            })
          }
        }

        // ── 註冊：限速與密碼長度（契約 03 §6；票 7） ─────────────────────────
        //
        // 跟登入一樣放在 hook：註冊頁的 Server Action（伺服器端呼叫）與直接打
        // `/api/auth/sign-up/email` 走同一段程式、算同一個桶。密碼長度也在這裡擋，
        // 不然直接打 HTTP 就能用套件預設的 8 個字元註冊。
        if (ctx.path === '/sign-up/email') {
          // 註冊關閉（設計方案 §5）放最前面：不算進註冊限速桶，Server Action 與直接打 API 同一句。
          if (!registrationOpen) {
            throw new APIError('FORBIDDEN', { code: 'REGISTRATION_CLOSED', message: REGISTRATION_CLOSED_MESSAGE })
          }
          const ip = clientIpFrom(ctx.request?.headers ?? ctx.headers)
          if (!checkSignUpRate(ip).allowed) {
            throw new APIError('TOO_MANY_REQUESTS', {
              code: 'RATE_LIMITED',
              message: `這個網路 ${waitAtMost(RATE_LIMITS.register.windowMs)}內的註冊次數已達上限，最晚 ${waitAtMost(RATE_LIMITS.register.windowMs)}後可以再試；仍無法註冊請聯絡系辦。`,
            })
          }
          // 註冊成功後伺服器會寄第一封驗證碼（`sendVerificationOnSignUp`），所以同一個 Email 的寄碼額度在這裡扣一次：
          // 重送註冊不能繞過「10 分鐘 5 封」（VB-2）。不論這個 Email 已不已存在都扣，看不出差別。
          const signUpEmail = normalizeEmail(((ctx.body ?? {}) as { email?: unknown }).email)
          if (signUpEmail && !otpLimiters.sendEmail.hit(signUpEmail).allowed) {
            throw tooMany(`寄太多次了，請 ${waitAtMost(RATE_LIMITS.otpSend.email.windowMs)}後再試。`)
          }
          const password = String(((ctx.body ?? {}) as { password?: unknown }).password ?? '')
          if (password.length < MIN_PASSWORD_LENGTH) {
            throw new APIError('BAD_REQUEST', {
              code: 'VALIDATION_FAILED',
              message: `密碼至少要 ${MIN_PASSWORD_LENGTH} 個字元。`,
            })
          }
          // 順序固定：限速 → Turnstile → 重複 Email（`hooks.after` 的 EMAIL_UNAVAILABLE）。被限速的不消耗 siteverify；
          // Turnstile 在重複 Email 之前，續辦才能說「這一次註冊的 token 已經驗過」（設計方案 §3.8）。
          await requireTurnstile(turnstileConfig, ctx.request?.headers ?? ctx.headers, 'signup')
        }

        // ── Email 驗證碼：寄碼（VB-2；設計方案 §3.2、§3.7、§3.8） ─────────────────────
        //
        // 公開入口（HTTP、Server Action 重寄）一律要 Turnstile（resend）。兩種內部入口不掛 widget：
        // 續辦的寄碼（同一次註冊已驗過 token）與「我的帳號」驗證 Email（本人＋fresh session＋只能寄給自己的登入 Email）。
        // 其他內部呼叫不豁免。限速三種入口都扣。
        if (ctx.path === '/email-otp/send-verification-otp') {
          const body = (ctx.body ?? {}) as { email?: unknown; type?: unknown }
          if (body.type !== 'email-verification') {
            throw new APIError('BAD_REQUEST', { code: 'VALIDATION_FAILED', message: '只能寄 Email 驗證碼。' })
          }
          const email = normalizeEmail(body.email)
          const headers = ctx.request?.headers ?? ctx.headers
          const purpose = !ctx.request && isInternalCall() ? currentOtpPurpose() : undefined
          // 註冊成功後的第一封：同一次註冊已過 Turnstile、也已在 sign-up 分支扣過額度，這裡不再扣。
          if (purpose?.purpose === 'signup-first' && purpose.email === email) return
          let exempt = false
          if (purpose?.purpose === 'signup-resume-start' && purpose.email === email) {
            exempt = true
          } else if (purpose?.purpose === 'account-verify' && purpose.email === email) {
            const session = await getAuthoritativeSessionFromCtx(ctx)
            if (!session?.user?.id) throw new APIError('UNAUTHORIZED', { code: 'UNAUTHENTICATED', message: '請重新登入。' })
            if (normalizeEmail(session.user.email) !== email) {
              throw new APIError('FORBIDDEN', { code: 'FORBIDDEN', message: '只能驗證自己的登入 Email。' })
            }
            if (!isFreshSession(session.session.createdAt)) {
              throw new APIError('FORBIDDEN', { code: 'FRESH_SESSION_REQUIRED', message: '這個操作需要重新登入確認身分。' })
            }
            exempt = true
          }
          enforceOtpSendRate(email, clientIpFrom(headers))
          if (!exempt) await requireTurnstile(turnstileConfig, headers, 'resend')
        }

        // ── Email 驗證碼：送碼。verify 與 check 共用一組桶（check 不能拿來繞過 verify 的上限） ──
        if (ctx.path === '/email-otp/verify-email' || ctx.path === '/email-otp/check-verification-otp') {
          const body = (ctx.body ?? {}) as { email?: unknown; type?: unknown }
          if (ctx.path === '/email-otp/check-verification-otp' && body.type !== 'email-verification') {
            throw new APIError('BAD_REQUEST', { code: 'VALIDATION_FAILED', message: '只能檢查 Email 驗證碼。' })
          }
          const email = normalizeEmail(body.email)
          if (!otpLimiters.verifyEmail.hit(email).allowed) {
            throw tooMany(`驗證碼試太多次了，請 ${waitAtMost(RATE_LIMITS.otpVerify.email.windowMs)}後再試。`)
          }
          if (!otpLimiters.verifyIp.hit(clientIpFrom(ctx.request?.headers ?? ctx.headers)).allowed) {
            throw tooMany(`這個網路送驗證碼的次數已達上限，最晚 ${waitAtMost(RATE_LIMITS.otpVerify.ip.windowMs)}後可以再試。`)
          }
        }

        // ── 忘記密碼：寄重設連結（設計方案 §3.4）。限速 → Turnstile（reset） ───────────────
        if (ctx.path === '/request-password-reset') {
          const headers = ctx.request?.headers ?? ctx.headers
          const email = normalizeEmail(((ctx.body ?? {}) as { email?: unknown }).email)
          if (!otpLimiters.resetEmail.hit(email).allowed) {
            throw tooMany(`寄太多次了，請${inWords(RATE_LIMITS.passwordReset.email.windowMs)}後再試。`)
          }
          if (!otpLimiters.resetIp.hit(clientIpFrom(headers)).allowed) {
            throw tooMany(`這個網路寄重設連結的次數已達上限，請${inWords(RATE_LIMITS.passwordReset.ip.windowMs)}後再試。`)
          }
          await requireTurnstile(turnstileConfig, headers, 'reset')
        }

        // ── 重設密碼：新密碼長度跟註冊、改密同一條（套件預設只要 8 字） ─────────────────
        if (ctx.path === '/reset-password') {
          const newPassword = String(((ctx.body ?? {}) as { newPassword?: unknown }).newPassword ?? '')
          if (newPassword.length < MIN_PASSWORD_LENGTH) {
            throw new APIError('BAD_REQUEST', {
              code: 'VALIDATION_FAILED',
              message: `密碼至少 ${MIN_PASSWORD_LENGTH} 字。`,
            })
          }
        }

        // ── 登入限速（契約 03 §6） ────────────────────────────────────────
        //
        // 放在這裡而不是只放在 Server Action 門面上：直接打 `/api/auth/sign-in/email`
        // 也要算同一個桶（2026-09-16 review Spec 4）。
        if (ctx.path === '/sign-in/email') {
          // 每 IP 跨帳號的失敗桶（票 T3）先看：同一個網路換帳號亂試密碼也要擋。
          // 只看不計——失敗由 `hooks.after` 記。訊息不提帳號，不透露帳號存不存在。
          if (!checkIpFailures(clientIpFrom(ctx.request?.headers ?? ctx.headers)).allowed) {
            throw new APIError('TOO_MANY_REQUESTS', {
              code: 'RATE_LIMITED',
              message: `這個網路的登入失敗次數過多，最晚 ${waitAtMost(RATE_LIMITS.signInFailuresPerIp.windowMs)}後可以再試；仍無法登入請聯絡系辦。`,
            })
          }
          const email = String(((ctx.body ?? {}) as { email?: string }).email ?? '')
          if (email) {
            const ip = clientIpFrom(ctx.request?.headers ?? ctx.headers)
            if (!checkSignInRate(signInKey(ip, email)).allowed) {
              // 達到上限之後**連正確的密碼也先擋**——不然「有沒有被擋」就成了
              // 密碼對不對的訊號。
              throw new APIError('TOO_MANY_REQUESTS', {
                code: 'RATE_LIMITED',
                message: `嘗試過多，最晚 ${waitAtMost(RATE_LIMITS.signIn.windowMs)}後可以再試；仍無法登入請聯絡系辦。`,
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
       * - 登入成功：把 IP＋帳號的限速計數清掉（每 IP 失敗桶不清）。
       * - 登入失敗（401 帳密錯）：記一次每 IP 失敗（票 T3）。
       *
       * 端點丟 APIError 時一樣會走到這裡，`returned` 是那個錯誤；`hooks.before` 丟的錯
       * （例如限速的 429）則不會——套件在 before 丟錯時整條就中斷（`api/dispatch.mjs`）。
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

        // ── 註冊成功 → 寄第一封驗證碼（VB-2；設計方案 §3.2） ─────────────────────────
        //
        // 以內部呼叫打寄碼端點（用途 `signup-first`，hook 不再要 token、不再扣額度），寄不出去就讓註冊回 MAIL_FAILED。
        // 帳號已經建好：之後同一個 Email 再註冊會進續辦。
        if (ctx.path === '/sign-up/email' && !looksLikeApiError(returned)) {
          const created = (await endpointJson(returned)) as { user?: { email?: unknown } } | null
          const email = normalizeEmail(created?.user?.email)
          if (email) {
            const headers = ctx.request?.headers ?? ctx.headers
            await withMailOutcome(() =>
              runAsInternalCall(() =>
                runWithOtpPurpose('signup-first', email, () =>
                  getAuth().api.sendVerificationOTP({
                    body: { email, type: 'email-verification' },
                    ...(headers ? { headers } : {}),
                  }),
                ),
              ),
            )
          }
        }

        // 寄碼端點：回呼寄失敗（被套件吞掉的那種）在這裡改回錯誤。
        if (ctx.path === '/email-otp/send-verification-otp' && !looksLikeApiError(returned) && mailOutcome.getStore()?.failed) {
          throw mailFailedError()
        }

        // ── 每 IP 跨帳號登入失敗（票 T3） ─────────────────────────────────
        //
        // 只算 401：帳號不存在、沒有密碼、密碼錯都是同一個 401（`INVALID_EMAIL_OR_PASSWORD`），
        // 停用帳號被 session hook 擋下也是 401，外面看起來都一樣。400（格式錯）不算。
        // 要放在下面 `instanceof` 提早 return 之前，而且看形狀：理由同上。
        if (ctx.path === '/sign-in/email' && looksLikeApiError(returned)) {
          if ((returned as { statusCode?: unknown }).statusCode === 401) {
            recordIpFailure(clientIpFrom(ctx.request?.headers ?? ctx.headers))
          }
          return
        }

        // ── 續辦完成（VB-2；設計方案 §3.2）：驗證碼剛由 check 端點確認是對的 ─────────────
        //
        // 只認「內部呼叫＋續辦用途＋同一個 Email」：公開的 check 端點永遠走不到這裡。
        // `finishSignupResume` 一筆交易做完（消耗驗證碼、標已驗證、換密碼、刪舊 session），之後才發新 session。
        if (ctx.path === '/email-otp/check-verification-otp' && !ctx.request && isInternalCall()) {
          const purpose = currentOtpPurpose()
          const email = normalizeEmail(((ctx.body ?? {}) as { email?: unknown }).email)
          if (purpose?.purpose === 'signup-resume-finish' && purpose.email === email && !looksLikeApiError(returned)) {
            const finished = await finishSignupResume(getPool(), email)
            if (!finished.ok) {
              throw new APIError('BAD_REQUEST', {
                code: finished.reason === 'expired' ? 'SIGNUP_RESUME_EXPIRED' : EMAIL_UNAVAILABLE_CODE,
                message:
                  finished.reason === 'expired'
                    ? '這次續辦已經逾時，請回第 1 步重新填一次。'
                    : EMAIL_UNAVAILABLE_MESSAGE,
              })
            }
            const session = await ctx.context.internalAdapter.createSession(finished.userId)
            const user = await ctx.context.internalAdapter.findUserById(finished.userId)
            if (!session || !user) {
              throw new APIError('INTERNAL_SERVER_ERROR', { code: 'INTERNAL', message: '登入失敗，請改用 Email 與新密碼登入。' })
            }
            await setSessionCookie(ctx, { session, user })
            return ctx.json({ success: true, resumed: true, userId: finished.userId })
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
      /**
       * Email 驗證碼（VB-2；設計方案 §3.2）。只用 `email-verification` 一種：OTP 登入、OTP 重設密碼、
       * 換 Email 的端點在路由矩陣擋掉，寄信回呼也拒絕其他型別。
       *
       * - `storeOTP: 'hashed'`：`verifications` 只存雜湊（套件預設是明文，一定要寫）。
       * - 第一封驗證碼在註冊成功後由伺服器自己寄（`hooks.after` 的 sign-up 分支以內部呼叫打寄碼端點），
       *   不再由前端用同一個 Turnstile token 打第二次（token 只能驗一次）。**不用**套件的
       *   `sendVerificationOnSignUp`：它的寄信排在我們的 `hooks.after` 之後、錯誤又被吞掉，
       *   寄不出去時註冊照樣回成功，畫面就說不出「驗證信寄不出去」（AC-VI-76）。
       * - `allowedAttempts: 5`：同一個碼錯 5 次作廢（跟限速桶無關）。
       * - `disableSignUp`：不讓驗證碼端點順手建帳號。
       * - 套件自己的限速在上面 `rateLimit.customRules` 關掉。
       */
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        sendVerificationOnSignUp: false,
        overrideDefaultEmailVerification: false,
        disableSignUp: true,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== 'email-verification') {
            throw new APIError('FORBIDDEN', { code: 'FORBIDDEN', message: '這個入口不對外開放。' })
          }
          const result = await mailer.send({ to: email, ...emailOtpMail(otp) })
          if (!result.ok) {
            const outcome = mailOutcome.getStore()
            if (outcome) outcome.failed = true
            else console.error('[auth] 驗證碼信寄不出去（不在 wrapper 入口內，無法回報呼叫端）', { outboxId: result.outboxId })
            throw mailFailedError()
          }
          // 真的寄出去才開始 120 秒冷卻（註冊的第一封也算，AC-VI-47(b)）。
          otpLimiters.cooldown.hit(normalizeEmail(email))
        },
      }),
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

/** 端點成功時的回傳內容（HTTP 那條是 `Response`，`auth.api` 那條是物件）；失敗回 null。 */
async function endpointJson(returned: unknown): Promise<unknown> {
  if (returned instanceof Response) return returned.status === 200 ? returned.clone().json() : null
  return looksLikeApiError(returned) ? null : (returned ?? null)
}

/** 套件丟的 APIError（不同套件實體的類別 `instanceof` 會失敗，所以看形狀）。 */
function looksLikeApiError(value: unknown): value is { status: unknown; body?: unknown } {
  return (
    value instanceof APIError ||
    (value instanceof Error && value.name === 'APIError' && 'status' in value)
  )
}
