import 'server-only'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { uuidv7 } from 'uuidv7'
import { getDb } from '@/infrastructure/db/client'
import * as schema from '@/infrastructure/db/schema'

/**
 * Better Auth 的最小設定（S00-02）。
 *
 * 這裡只到「能產出 schema」為止：不掛任何路由、沒有 hooks、沒有白名單。
 * 路由白名單、databaseHooks、內部呼叫辨識與 auth 包裝器都在 S01-02／S01-03。
 *
 * 契約 01 §1：主鍵一律由應用產生 uuidv7，包含 Better Auth 的四張表。
 * 契約 01 §4.1：`users` 業務擴充三欄、`sessions` 一欄；admin plugin 的
 * banned／ban_reason／ban_expires 是套件欄，欄名以安裝後產生的 schema 為準。
 */
export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: 'pg', schema, usePlural: true }),
  advanced: {
    database: { generateId: () => uuidv7() },
  },
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    },
  },
  user: {
    additionalFields: {
      status: { type: 'string', required: true, defaultValue: 'pending', input: false },
      mustChangePassword: { type: 'boolean', required: true, defaultValue: false, input: false },
      deidentifiedAt: { type: 'date', required: false, input: false },
    },
  },
  session: {
    additionalFields: {
      loginMethod: { type: 'string', required: true, input: false },
    },
  },
  plugins: [admin()],
})

export type Auth = typeof auth
