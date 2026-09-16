import 'server-only'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from 'better-auth/api'
import { uuidv7 } from 'uuidv7'
import { getDb } from '@/infrastructure/db/client'
import * as schema from '@/infrastructure/db/schema'
import {
  pathHasAnyAllowedMethod,
  routeAccess,
  sessionRequirement,
} from '@/infrastructure/auth/route-matrix'
import { isInternalCall } from '@/infrastructure/auth/internal-call'
import {
  isFullyActive,
  isUsableSession,
  readAccountState,
} from '@/infrastructure/auth/account-state'

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

        const requirement = sessionRequirement(ctx.path, ctx.request?.method ?? 'POST')
        if (requirement === undefined || requirement === 'none') return

        const session = await getAuthoritativeSessionFromCtx(ctx)
        // 沒有 session 就交給端點自己回 401——這一關只管「有 session 但狀態不對」。
        if (!session?.user?.id) return

        const state = await readAccountState(String(session.user.id))
        if (!state || !isUsableSession(state)) {
          // 停用與去識別化一律當作未登入（契約 03 §2）；不回「你被停用了」，
          // 那會變成一個可以拿來探測帳號狀態的側通道。
          throw new APIError('UNAUTHORIZED', { code: 'UNAUTHENTICATED', message: '請重新登入。' })
        }

        if (requirement === 'active-only' && !isFullyActive(state)) {
          throw new APIError('FORBIDDEN', {
            code: state.mustChangePassword ? 'PASSWORD_CHANGE_REQUIRED' : 'ACCOUNT_PENDING',
            message: state.mustChangePassword ? '請先更改密碼。' : '帳號還在等待審核。',
          })
        }
      }),
    },
    plugins: [admin()],
  })
}

export type Auth = ReturnType<typeof createAuth>
