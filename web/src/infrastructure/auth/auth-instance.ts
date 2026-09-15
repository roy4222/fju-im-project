import 'server-only'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { uuidv7 } from 'uuidv7'
import { getDb } from '@/infrastructure/db/client'
import * as schema from '@/infrastructure/db/schema'
import { routeAccess } from '@/infrastructure/auth/route-matrix'

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
          before: async (session, context) => ({
            data: { ...session, loginMethod: loginMethodForPath(context?.path) },
          }),
        },
      },
    },
    hooks: {
      /**
       * 第二層攔截。
       *
       * 只擋「帶著 HTTP request 的呼叫」：`ctx.request` 存在代表這是外部請求。
       * 官方 hooks 文件寫 request「may not exist in server-only endpoints」，所以
       * server-only 呼叫在這一層會通過——**S01-03 會再加上內部包裝器的 marker 條件**，
       * 把「沒有 marker 的伺服器端呼叫」也擋掉（契約 03 §2 的三向測試）。
       */
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.request) return
        if (routeAccess(ctx.path, ctx.request.method) === 'blocked') {
          throw new APIError('FORBIDDEN', { code: 'FORBIDDEN', message: '這個入口不對外開放。' })
        }
      }),
    },
    plugins: [admin()],
  })
}

export type Auth = ReturnType<typeof createAuth>
